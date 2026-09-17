"""The few lines every simulation here needs: load a model (a Menagerie robot or your own MJCF), step
it with a controller, and record the rollout so the MuJoCo Viewer pane can run it LIVE — the same
physics, in the browser, where the user can push the robot, drive its actuators and replay the run.

    from harness_mujoco import load_menagerie, load_xml, record
    model, data = load_menagerie("unitree_go2")          # $MENAGERIE/unitree_go2/scene.xml
    def hold(model, data, t):                             # PD toward the "home" keyframe
        data.ctrl[:] = model.key_ctrl[0]
    record(model, data, hold, seconds=4)

`record` writes, under `out/`:

- `rollout.qpos.json` — what the pane opens: the model's path, and per frame the time, `qpos`,
  `qvel`, `ctrl` (and `act`). Written while the rollout runs (`"status": "recording"`), so the pane
  shows the run in progress, then `"status": "done"`. With `ctrl` recorded the pane re-simulates the
  run live instead of only replaying it.
- `rollout.model.xml` — the compiled model as MJCF, when it was built or edited with `MjSpec`, so
  the pane simulates the model you simulated and not the file it started from. Runtime edits to the
  compiled model (`model.opt.timestep = …`, `model.actuator_gainprm[…] = …`) go into the rollout as
  `model_patch`.
- `rollout.json` — the report the verdict reads.
- `rollout.mp4` — a video of it, for sharing. Optional (`video=False` skips it while iterating).

`record` also refreshes `.harness/verdict.json` when it starts and when it ends, so the pane header
moves while the rollout runs.
"""
from __future__ import annotations
import contextlib, io, json, os, sys, time, weakref
from pathlib import Path
from typing import Callable

import mujoco
import numpy as np

Controller = Callable[[mujoco.MjModel, mujoco.MjData, float], None]

MENAGERIE = Path(os.environ.get("MENAGERIE", "")).expanduser()
WORKSPACE = Path(os.environ.get("HARNESS_WORKSPACE") or Path.cwd()).expanduser().resolve()
TRAJECTORY_VERSION = 2

# Where each compiled model came from, so `record` can tell the pane what to load. Weak keys: a
# script that compiles a thousand models in a sweep keeps none of them alive.
_SOURCES: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()
_SPEC_FILES: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()
# The spec a model was compiled from, held as long as the model lives: a spec built inside a helper
# function is gone by the time `record` runs, and its MJCF is what the pane needs.
_MODEL_SPECS: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()


def viewer_path(path: str | Path) -> str | None:
    """An MJCF path as the pane names it: `menagerie/<robot>/scene.xml` for a Menagerie robot,
    workspace-relative for your own. None when it is neither, and the pane cannot fetch it."""
    full = Path(path).expanduser().resolve()
    for root, prefix in ((MENAGERIE, "menagerie/"), (WORKSPACE, "")):
        if not str(root) or str(root) == ".":
            continue
        try:
            return prefix + full.relative_to(root.resolve()).as_posix()
        except (ValueError, OSError):
            continue
    return None


def remember_model(model: mujoco.MjModel, path: str | Path) -> None:
    """Tie a compiled model to the MJCF it came from. `load_xml`, `load_menagerie` and any direct
    `MjModel.from_xml_path` / `MjSpec.compile` do this for you; call it yourself only if you built a
    model some other way and still want the pane to show it."""
    rel = viewer_path(path)
    if not rel:
        return
    try:
        _SOURCES[model] = rel
    except TypeError:
        pass


def model_source(model: mujoco.MjModel) -> str | None:
    """The pane's path for this model, if we know it."""
    try:
        return _SOURCES.get(model)
    except TypeError:
        return None


def _instrument() -> None:
    """Remember the source of every model, however it was loaded — `from_xml_path` for a plain load,
    `MjSpec.from_file` + `compile` for a model edited before compiling (swapping torque actuators for
    position ones, say). Pure bookkeeping: every wrapper returns exactly what MuJoCo returned."""
    try:
        from_xml_path = mujoco.MjModel.from_xml_path
        from_file = mujoco.MjSpec.from_file
        compile_spec = mujoco.MjSpec.compile
    except AttributeError:
        return

    def wrapped_from_xml_path(filename, *args, **kwargs):
        model = from_xml_path(filename, *args, **kwargs)
        remember_model(model, filename)
        return model

    def wrapped_from_file(filename, *args, **kwargs):
        spec = from_file(filename, *args, **kwargs)
        try:
            _SPEC_FILES[spec] = str(filename)
        except TypeError:
            pass
        return spec

    def wrapped_compile(self, *args, **kwargs):
        model = compile_spec(self, *args, **kwargs)
        source = _SPEC_FILES.get(self)
        if source:
            remember_model(model, source)
        try:
            _MODEL_SPECS[model] = self
        except TypeError:
            pass
        return model

    wrapped_from_xml_path.__wrapped_original__ = from_xml_path
    wrapped_from_file.__wrapped_original__ = from_file
    wrapped_compile.__wrapped_original__ = compile_spec
    try:
        mujoco.MjModel.from_xml_path = staticmethod(wrapped_from_xml_path)
        mujoco.MjSpec.from_file = staticmethod(wrapped_from_file)
        mujoco.MjSpec.compile = wrapped_compile
    except (AttributeError, TypeError):   # a bindings change; the explicit paths still work
        pass


_instrument()


def load_xml(path: str | Path) -> tuple[mujoco.MjModel, mujoco.MjData]:
    model = mujoco.MjModel.from_xml_path(str(path))
    data = mujoco.MjData(model)
    remember_model(model, path)
    if model.nkey:
        mujoco.mj_resetDataKeyframe(model, data, 0)
    mujoco.mj_forward(model, data)
    return model, data


def load_menagerie(robot: str, scene: str = "scene.xml", *, servos: tuple[float, float] | None = None) -> tuple[mujoco.MjModel, mujoco.MjData]:
    """A Menagerie robot in its scene: unitree_go2, unitree_g1, unitree_h1, berkeley_humanoid, booster_t1…

    `servos=(kp, kv)` turns every torque `<motor>` on a joint into a position servo — PD with those
    gains, force-limited to the motor's torque rating, ctrl a joint angle within the joint's range —
    the way a real quadruped's low-level position mode works. The Go2 and A1 ship torque motors; the
    G1 already has position actuators. With servos the controller lives in the model, so `ctrl` is a
    pose, and the pane can re-simulate the rollout and let the user push the robot around."""
    path = MENAGERIE / robot / scene
    if not path.exists():
        raise FileNotFoundError(f"{path} — robots available: {', '.join(sorted(p.name for p in MENAGERIE.iterdir() if (p / 'scene.xml').exists()))}")
    if servos is None:
        return load_xml(path)
    kp, kv = servos
    spec = mujoco.MjSpec.from_file(str(path))
    joint_range = {j.name: j.range.copy() for j in spec.joints}
    for act in spec.actuators:
        if act.trntype != mujoco.mjtTrn.mjTRN_JOINT or act.target not in joint_range:
            continue
        if act.gaintype != mujoco.mjtGain.mjGAIN_FIXED or act.biastype != mujoco.mjtBias.mjBIAS_NONE:
            continue                                   # already a servo (or something custom): leave it
        torque = act.ctrlrange.copy()
        act.set_to_position(kp=kp, kv=kv)
        lo, hi = joint_range[act.target]
        if hi > lo:
            act.ctrlrange = [lo, hi]
        if torque[1] > torque[0]:
            act.forcerange = torque
    model = spec.compile()
    data = mujoco.MjData(model)
    if model.nkey:
        mujoco.mj_resetDataKeyframe(model, data, 0)
    mujoco.mj_forward(model, data)
    return model, data


# ─── What the pane needs to rebuild the model ────────────────────────────────────────────────────

# Model fields a script commonly changes after compiling, which no MJCF on disk carries. Compared
# against a fresh compile of what the pane will load; the ones that differ ride in the rollout.
_PATCH_OPTION = ("timestep", "gravity", "wind", "magnetic", "density", "viscosity", "impratio", "tolerance",
                 "ls_tolerance", "iterations", "ls_iterations", "noslip_iterations", "integrator", "cone",
                 "jacobian", "solver", "disableflags", "enableflags", "o_margin", "o_solref", "o_solimp", "o_friction")
_PATCH_FIELDS = ("actuator_gainprm", "actuator_biasprm", "actuator_dynprm", "actuator_gear", "actuator_ctrlrange",
                 "actuator_forcerange", "actuator_gaintype", "actuator_biastype", "actuator_dyntype",
                 "dof_damping", "dof_armature", "dof_frictionloss", "jnt_stiffness", "jnt_range", "qpos_spring", "qpos0",
                 "body_mass", "body_inertia", "body_pos", "body_quat", "body_ipos", "body_iquat", "body_gravcomp",
                 "geom_friction", "geom_solref", "geom_solimp", "geom_size", "geom_pos", "geom_quat", "geom_rgba",
                 "geom_margin", "geom_gap", "geom_condim", "geom_contype", "geom_conaffinity", "mat_rgba",
                 "key_qpos", "key_qvel", "key_ctrl", "key_act", "key_time", "eq_data", "eq_solref", "eq_solimp",
                 "tendon_stiffness", "tendon_damping", "tendon_range", "light_pos", "light_dir", "cam_pos", "cam_quat", "cam_fovy")


def _flat(value) -> list | float | int:
    arr = np.asarray(value)
    if arr.ndim == 0:
        return arr.item()
    return [round(float(x), 9) if arr.dtype.kind == "f" else int(x) for x in arr.ravel()]


def _model_patch(model: mujoco.MjModel, reference: mujoco.MjModel) -> dict:
    patch: dict = {}
    for name in _PATCH_OPTION:
        try:
            ours, theirs = np.asarray(getattr(model.opt, name)), np.asarray(getattr(reference.opt, name))
        except AttributeError:
            continue
        if ours.shape == theirs.shape and not np.allclose(ours, theirs, rtol=0, atol=1e-12):
            patch[f"opt.{name}"] = _flat(ours)
    for name in _PATCH_FIELDS:
        try:
            ours, theirs = np.asarray(getattr(model, name)), np.asarray(getattr(reference, name))
        except AttributeError:
            continue
        if ours.size and ours.shape == theirs.shape and not np.allclose(ours, theirs, rtol=0, atol=1e-9):
            patch[name] = _flat(ours)
    return patch


def _compile_snapshot(xml: str, source_dir: Path | None) -> mujoco.MjModel:
    spec = mujoco.MjSpec.from_string(xml)
    if source_dir is not None:
        for attr in ("meshdir", "texturedir"):
            current = getattr(spec, attr, "") or ""
            if not os.path.isabs(current):
                setattr(spec, attr, str(source_dir / current))
    return _plain_compile(spec)


def _plain_compile(spec) -> mujoco.MjModel:
    # The instrumented compile would tie the throwaway reference model to this spec; skip it.
    compile_spec = getattr(mujoco.MjSpec.compile, "__wrapped_original__", None)
    return compile_spec(spec) if compile_spec else spec.compile()


def _abs_source(source: str | None) -> Path | None:
    if not source:
        return None
    if source.startswith("menagerie/"):
        return MENAGERIE / source[len("menagerie/"):]
    return WORKSPACE / source


def _describe_model(model: mujoco.MjModel, source: str | None, out_dir: Path) -> dict:
    """`model`, `model_xml` and `model_patch` for the rollout: enough for the pane to compile the
    model this script is simulating, not merely the file it started from."""
    info: dict = {"model": source, "model_xml": None, "model_patch": {}}
    snapshot = out_dir / "rollout.model.xml"
    spec = None
    try:
        spec = _MODEL_SPECS.get(model)
    except TypeError:
        spec = None
    source_file = _abs_source(source)
    reference = None
    if spec is not None:
        try:
            xml = spec.to_xml()
            # Unchanged model, unchanged file: the pane reloads a model only when its snapshot changes.
            if not snapshot.exists() or snapshot.read_text() != xml:
                snapshot.write_text(xml)
            info["model_xml"] = viewer_path(snapshot)
            if info["model"] is None:            # a model built from scratch: the snapshot is the model
                info["model"] = info["model_xml"]
            reference = _compile_snapshot(xml, source_file.parent if source_file else snapshot.parent)
        except Exception as error:               # noqa: BLE001 — a spec MuJoCo cannot write back is still simulatable
            print(f"note: could not save the compiled model for the pane ({error}); it will load {source}", file=sys.stderr)
            snapshot.unlink(missing_ok=True)
            info["model_xml"] = None
    else:
        snapshot.unlink(missing_ok=True)
    if reference is None and source_file is not None and source_file.exists():
        try:
            load = getattr(mujoco.MjModel.from_xml_path, "__wrapped_original__", mujoco.MjModel.from_xml_path)
            reference = load(str(source_file))
        except Exception:                        # noqa: BLE001
            reference = None
    if reference is not None:
        try:
            info["model_patch"] = _model_patch(model, reference)
        except Exception:                        # noqa: BLE001
            info["model_patch"] = {}
    return info


def _write_json_atomic(path: Path, value: dict) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(value, separators=(",", ":")) + "\n")
    os.replace(tmp, path)


def _refresh_verdict() -> None:
    """The pane header follows the verdict; keep it current without the script having to."""
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import verdict  # noqa: PLC0415
        with contextlib.redirect_stdout(io.StringIO()):
            verdict.main([])
    except Exception:                            # noqa: BLE001 — the verdict is a courtesy here, never a failure
        pass
    finally:
        with contextlib.suppress(ValueError):
            sys.path.remove(str(Path(__file__).resolve().parent))


def record(model: mujoco.MjModel, data: mujoco.MjData, controller: Controller | None = None, *, seconds: float = 4.0,
           fps: int = 30, width: int = 854, height: int = 480, camera: str | int = -1, out: str | Path = "out/rollout.mp4",
           track: str | None = None, model_path: str | Path | None = None, video: bool = True) -> dict:
    """Step the simulation for `seconds`, calling `controller(model, data, t)` before each step.

    Writes `rollout.qpos.json` beside `out` as it goes — the trajectory the pane opens and
    re-simulates — then `rollout.json` (the report), and, with `video=True`, the video at `out`
    (mp4). `camera` is a named camera or -1 (free, framed on the scene); `track` names a body the
    video's free camera follows, and the pane's camera too. Pass `model_path` if this model was
    built in a way the toolchain could not trace back to an MJCF file."""
    out = Path(out)
    out_dir = out.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    traj_path = out_dir / "rollout.qpos.json"
    source = viewer_path(model_path) if model_path is not None else model_source(model)
    described = _describe_model(model, source, out_dir)

    steps_per_frame = max(1, int(round(1.0 / (fps * model.opt.timestep))))
    frame_dt = steps_per_frame * float(model.opt.timestep)
    frames = int(round(seconds * fps))

    renderer = writer = cam = None
    video_path: Path | None = None
    if video:
        try:
            import imageio.v2 as imageio
            # The offscreen framebuffer is 640×480 unless the model says otherwise; a video wants more.
            model.vis.global_.offwidth = max(int(model.vis.global_.offwidth), width)
            model.vis.global_.offheight = max(int(model.vis.global_.offheight), height)
            renderer = mujoco.Renderer(model, height, width)
            cam = mujoco.MjvCamera()
            if isinstance(camera, str):
                cam.type = mujoco.mjtCamera.mjCAMERA_FIXED
                cam.fixedcamid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_CAMERA, camera)
            else:
                mujoco.mjv_defaultFreeCamera(model, cam)
                cam.distance = max(1.5, float(model.stat.extent) * 1.6)
                cam.elevation = -18
                cam.azimuth = 135
                if track:
                    cam.type = mujoco.mjtCamera.mjCAMERA_TRACKING
                    cam.trackbodyid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, track)
            writer = imageio.get_writer(str(out), fps=fps, codec="libx264", quality=8, macro_block_size=None)
            video_path = out
        except Exception as error:               # noqa: BLE001 — no GL on this machine: the trajectory still works
            print(f"note: no video ({error}); the pane runs the rollout without one", file=sys.stderr)
            if renderer is not None:
                renderer.close()
            renderer = writer = None

    rollout: dict = {
        "version": TRAJECTORY_VERSION, "status": "recording", "mujoco": mujoco.__version__,
        **described,
        "dt": round(frame_dt, 9), "fps": fps, "seconds": seconds, "frames_expected": frames + 1,
        "timestep": float(model.opt.timestep), "nq": int(model.nq), "nv": int(model.nv), "nu": int(model.nu), "na": int(model.na),
        "track": track, "camera": camera if isinstance(camera, str) else None,
        "video": viewer_path(video_path) if video_path else None,
        "time": [], "qpos": [], "qvel": [], "ctrl": [], "act": [],
    }
    replayable = described["model"] is not None

    def snapshot_state(ctrl_row: list[float]) -> None:
        rollout["time"].append(round(float(data.time), 6))
        rollout["qpos"].append([round(float(q), 6) for q in data.qpos])
        rollout["qvel"].append([round(float(v), 5) for v in data.qvel])
        rollout["ctrl"].append(ctrl_row)
        if model.na:
            rollout["act"].append([round(float(a), 5) for a in data.act])

    def publish(status: str) -> None:
        if not replayable:
            return
        rollout["status"] = status
        rollout["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        _write_json_atomic(traj_path, rollout)

    nan = False
    max_qvel = 0.0
    t0 = time.time()
    last_publish = 0.0
    if replayable:
        publish("recording")
        _refresh_verdict()
    try:
        for frame in range(frames + 1):
            ctrl_row: list[float] | None = None
            if frame == frames:                  # the final state has no step after it; its ctrl is the last one applied
                snapshot_state([round(float(c), 6) for c in data.ctrl])
                break
            for step in range(steps_per_frame):
                if controller is not None:
                    controller(model, data, data.time)
                if step == 0:
                    ctrl_row = [round(float(c), 6) for c in data.ctrl]
                    snapshot_state(ctrl_row)
                mujoco.mj_step(model, data)
            if not np.all(np.isfinite(data.qpos)):
                nan = True
                break
            max_qvel = max(max_qvel, float(np.max(np.abs(data.qvel))) if model.nv else 0.0)
            if writer is not None:
                renderer.update_scene(data, cam)
                writer.append_data(renderer.render())
            now = time.time()
            if replayable and now - last_publish > 0.5:
                publish("recording")
                last_publish = now
    finally:
        if writer is not None:
            writer.close()
        if renderer is not None:
            renderer.close()

    if not model.na:
        rollout.pop("act")
    if replayable:
        publish("diverged" if nan else "done")
    else:
        traj_path.unlink(missing_ok=True)
        print('note: the pane cannot simulate this rollout — pass record(..., model_path="scenes/yours.xml") '
              'so it knows which MJCF to load')
    recorded = len(rollout["qpos"])
    report = {
        "model": {"nbody": int(model.nbody), "nq": int(model.nq), "nv": int(model.nv), "nu": int(model.nu), "timestep": float(model.opt.timestep)},
        "model_path": described["model"], "model_xml": described["model_xml"], "model_patch": sorted(described["model_patch"]),
        "seconds": seconds, "fps": fps, "frames": recorded,
        "video": str(video_path) if video_path else None, "nan": nan, "max_qvel": max_qvel,
        "trajectory": traj_path.as_posix() if replayable else None, "ctrl_recorded": bool(model.nu),
        "sim_time": float(data.time), "wall_seconds": round(time.time() - t0, 2),
    }
    (out_dir / "rollout.json").write_text(json.dumps(report, indent=2) + "\n")
    _refresh_verdict()
    print(f"{traj_path if replayable else out_dir / 'rollout.json'} · {seconds:.1f} s · {recorded} frames · {'NaN — diverged' if nan else 'stable'} · {report['wall_seconds']} s wall"
          + (f" · model {described['model']}" if replayable else "")
          + (f" (compiled model saved as {described['model_xml']})" if described["model_xml"] else "")
          + (f" · video {video_path}" if video_path else ""))
    return report


def pd_hold(kp: float = 60.0, kd: float = 2.0) -> Controller:
    """Hold the first keyframe's pose. Position actuators (servos) get the keyframe's joint angles as
    ctrl; torque motors on joints get PD torque, kp·(q* − q) − kd·q̇, clipped to their ctrlrange.

    Prefer servos (`load_menagerie(..., servos=(kp, kv))`): torques computed in Python are recorded
    per frame, and replaying recorded torques open-loop cannot hold a robot up for long, while a
    servo's target can — so the pane's live simulation stays faithful after the recording ends."""
    def control(model: mujoco.MjModel, data: mujoco.MjData, t: float) -> None:
        if not model.nkey or not model.nu:
            return
        target_ctrl = model.key_ctrl[0]
        target_qpos = model.key_qpos[0]
        for a in range(model.nu):
            joint = int(model.actuator_trnid[a, 0])
            is_joint = model.actuator_trntype[a] == mujoco.mjtTrn.mjTRN_JOINT and joint >= 0
            servo = model.actuator_biastype[a] == mujoco.mjtBias.mjBIAS_AFFINE
            if servo or not is_joint:
                data.ctrl[a] = target_ctrl[a]
                continue
            qadr, dadr = model.jnt_qposadr[joint], model.jnt_dofadr[joint]
            tau = kp * (target_qpos[qadr] - data.qpos[qadr]) - kd * data.qvel[dadr]
            gear = model.actuator_gear[a, 0] or 1.0
            lo, hi = model.actuator_ctrlrange[a]
            data.ctrl[a] = float(np.clip(tau / gear, lo, hi)) if hi > lo else tau / gear
    return control
