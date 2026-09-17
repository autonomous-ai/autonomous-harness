"""The few lines every simulation here needs: load a model (a Menagerie robot or your own MJCF), step
it with a controller, record the rollout as a video AND as a trajectory the pane replays in 3D, and
leave a report for the verdict.

    from harness_mujoco import load_menagerie, load_xml, record
    model, data = load_menagerie("unitree_go2")          # $MENAGERIE/unitree_go2/scene.xml
    def hold(model, data, t):                             # PD toward the "home" keyframe
        data.ctrl[:] = model.key_ctrl[0]
    record(model, data, hold, seconds=4, out="out/rollout.mp4")

`record` writes three files: `out/rollout.mp4` (the video), `out/rollout.qpos.json` (the trajectory
the MuJoCo Viewer pane loads — the model's path plus one qpos row per frame, so the pane can orbit
it, scrub it, and keep simulating from it) and `out/rollout.json` (the report the verdict reads).
"""
from __future__ import annotations
import json, os, time, weakref
from pathlib import Path
from typing import Callable

import mujoco
import numpy as np

Controller = Callable[[mujoco.MjModel, mujoco.MjData, float], None]

MENAGERIE = Path(os.environ.get("MENAGERIE", "")).expanduser()
WORKSPACE = Path(os.environ.get("HARNESS_WORKSPACE") or Path.cwd()).expanduser().resolve()

# Where each compiled model came from, so `record` can tell the pane what to load. Weak keys: a
# script that compiles a thousand models in a sweep keeps none of them alive.
_SOURCES: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()
_SPEC_FILES: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()


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
    position ones, say). Pure bookkeeping: both wrappers return exactly what MuJoCo returned."""
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
        return model

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


def load_menagerie(robot: str, scene: str = "scene.xml") -> tuple[mujoco.MjModel, mujoco.MjData]:
    """A Menagerie robot in its scene: unitree_go2, unitree_g1, unitree_h1, berkeley_humanoid, booster_t1…"""
    path = MENAGERIE / robot / scene
    if not path.exists():
        raise FileNotFoundError(f"{path} — robots available: {', '.join(sorted(p.name for p in MENAGERIE.iterdir() if (p / 'scene.xml').exists()))}")
    return load_xml(path)


def record(model: mujoco.MjModel, data: mujoco.MjData, controller: Controller | None = None, *, seconds: float = 4.0,
           fps: int = 30, width: int = 854, height: int = 480, camera: str | int = -1, out: str | Path = "out/rollout.mp4",
           track: str | None = None, model_path: str | Path | None = None) -> dict:
    """Step the simulation for `seconds`, calling `controller(model, data, t)` before each step, and
    write the frames to `out` (mp4). `camera` is a named camera or -1 (free, framed on the scene);
    `track` names a body the free camera follows. Returns the report the verdict reads, also written
    beside the video as rollout.json.

    Every frame's `qpos` also goes to `rollout.qpos.json` beside the video — that is what the pane
    replays in 3D. Pass `model_path` if this model was built in a way the toolchain could not trace
    back to an MJCF file (workspace-relative, or `menagerie/<robot>/scene.xml`)."""
    import imageio.v2 as imageio

    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
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
    steps_per_frame = max(1, int(round(1.0 / (fps * model.opt.timestep))))
    frames = int(seconds * fps)
    writer = imageio.get_writer(str(out), fps=fps, codec="libx264", quality=8, macro_block_size=None)
    nan = False
    max_qvel = 0.0
    trajectory: list[list[float]] = []
    t0 = time.time()
    try:
        for _ in range(frames):
            for _ in range(steps_per_frame):
                if controller is not None:
                    controller(model, data, data.time)
                mujoco.mj_step(model, data)
            if not np.all(np.isfinite(data.qpos)):
                nan = True
                break
            max_qvel = max(max_qvel, float(np.max(np.abs(data.qvel))) if model.nv else 0.0)
            trajectory.append([round(float(q), 5) for q in data.qpos])
            renderer.update_scene(data, cam)
            writer.append_data(renderer.render())
    finally:
        writer.close()
        renderer.close()
    source = viewer_path(model_path) if model_path is not None else model_source(model)
    qpos_path = out.parent / "rollout.qpos.json"
    replayable = bool(trajectory and source)
    if replayable:
        qpos_path.write_text(json.dumps({"model": source, "dt": round(1.0 / fps, 6), "nq": int(model.nq), "qpos": trajectory}) + "\n")
    else:
        qpos_path.unlink(missing_ok=True)
        if trajectory:
            print('note: the pane cannot replay this rollout — pass record(..., model_path="scenes/yours.xml") '
                  'so it knows which MJCF to load')
    report = {
        "model": {"nbody": int(model.nbody), "nq": int(model.nq), "nv": int(model.nv), "nu": int(model.nu), "timestep": float(model.opt.timestep)},
        "model_path": source,
        "seconds": seconds, "fps": fps, "frames": frames, "video": str(out), "nan": nan, "max_qvel": max_qvel,
        "trajectory": qpos_path.as_posix() if replayable else None,
        "sim_time": float(data.time), "wall_seconds": round(time.time() - t0, 2),
    }
    (out.parent / "rollout.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"{out} · {seconds:.1f} s · {frames} frames · {'NaN — diverged' if nan else 'stable'} · {report['wall_seconds']} s wall"
          + (f" · {qpos_path} · {len(trajectory)} frames of {source}" if replayable else ""))
    return report


def pd_hold(kp: float = 60.0, kd: float = 2.0) -> Controller:
    """A controller that holds the first keyframe's joint targets with PD on position actuators."""
    def control(model: mujoco.MjModel, data: mujoco.MjData, t: float) -> None:
        if model.nkey and model.nu == len(model.key_ctrl[0]):
            data.ctrl[:] = model.key_ctrl[0]
    return control
