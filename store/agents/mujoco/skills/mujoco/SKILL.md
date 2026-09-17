---
name: mujoco
description: Simulate robots and scenes with MuJoCo — Menagerie robots (Unitree Go2, G1, H1, Berkeley Humanoid, Booster T1), your own MJCF, controllers and policies — record rollouts the pane runs as a live simulation, and train with MJX and MuJoCo Playground. Use for any request that ends in a simulation, a rollout or a policy.
---

# mujoco

MuJoCo is a physics engine for robotics: a model (MJCF XML → `MjModel`), a state (`MjData`), a step
(`mj_step`). Tools: `$MUJOCO_PYTHON` (the pinned venv), `$MENAGERIE` (the robots), `harness_mujoco`
on `PYTHONPATH` (load, servos, record, PD hold). Never install another MuJoCo.

## Simulate, record — the pane runs it live

```bash
"$MUJOCO_PYTHON" sim/hello.py                  # → out/rollout.qpos.json (+ .model.xml, rollout.json, rollout.mp4)
"$MUJOCO_PYTHON" "$MUJOCO_TOOLCHAIN/verdict.py"         # record() already refreshes it; run it after anything else
```

```python
from harness_mujoco import load_menagerie, load_xml, pd_hold, record
model, data = load_menagerie("unitree_go2", servos=(60, 2))   # torque motors → position servos (PD in the model)
def ctrl(model, data, t):                              # called before every step
    data.ctrl[:] = model.key_ctrl[0]                   # joint-angle targets: hold the "home" pose
record(model, data, ctrl, seconds=4, track="base")     # track: the body the cameras follow
```

**The pane is MuJoCo's `simulate`, not a video player.** It opens `out/rollout.qpos.json` and runs
the model *live* in the browser (MuJoCo's WebAssembly build): from the rollout's first frame, with
the controls your controller produced, so the robot does what it did — and then the user can shove
it, drive any actuator from a slider, pose joints, load keyframes, look at contacts and forces, or
replay the exact recording frame by frame. What `record` writes is what makes that work:

- `rollout.qpos.json` — per frame: `time`, `qpos`, `qvel`, `ctrl` (and `act`). It is written while the
  rollout runs (`"status": "recording"`), so the pane shows the run in progress.
- `rollout.model.xml` — when you built or edited the model with `MjSpec` (servos, added bodies,
  swapped actuators), the compiled model as MJCF, so the pane simulates *your* model and not the file
  you started from. Runtime edits (`model.opt.timestep = …`, `model.dof_damping[:] = …`) ride in the
  rollout as `model_patch`. All automatic.
- `rollout.json` — the report the verdict reads. `rollout.mp4` — a video to share; `video=False`
  skips it while you iterate (faster). The pane never opens on the video.

**Put the low-level controller in the model.** The pane re-simulates with the recorded `ctrl`. A
position servo's target is a pose, and replaying poses keeps the robot standing and reacting to
pushes after the recording ends. Torques computed in Python (`pd_hold` on a motor, an MPC, a raw
torque policy) replay open-loop and drift. So for legged robots: `servos=(kp, kv)` (Go2/A1: 60, 2
to start) and command joint angles; the G1 already has position actuators. Keep keyframes in the
MJCF (`<key name qpos ctrl>`) for poses worth loading in the pane.

The rollout must know which MJCF it came from. `load_xml`, `load_menagerie` and a plain
`MjModel.from_xml_path` or `MjSpec.from_file(...).compile()` are traced automatically; a model built
from a string needs `record(..., model_path="scenes/mine.xml")` — save it under `scenes/` first — or
the pane has nothing to run and the verdict says so. Keep rollouts short while iterating (2–4 s).

## The robots (Menagerie, pinned)

`unitree_go2` (quadruped, 12 torque motors → use `servos`, keyframe "home"), `unitree_go1`,
`unitree_a1`, `unitree_g1` (humanoid, 29 DoF, position actuators, keyframe "stand"), `unitree_h1`
(humanoid), `berkeley_humanoid`, `booster_t1`. Each has `scene.xml` (robot + floor + light) and
`<robot>.xml`; the MJX variants (`scene_mjx.xml`) are the ones to train with. Body and joint names:
`[model.body(i).name for i in range(model.nbody)]`.

## MJCF, the parts that matter

- `<worldbody>` → nested `<body pos quat>` with `<joint type="hinge|slide|ball|free" axis range damping>`
  and `<geom type="box|sphere|capsule|cylinder|mesh|plane" size mass rgba>`; `<light>`, `<camera name>`
  (every named camera is a view in the pane).
- `<actuator>`: `<motor joint gear ctrlrange>` (torque), `<position joint kp kv ctrlrange>` (servo), `<velocity>`.
  Give actuators names — the pane labels its sliders with them.
- `<sensor>`: `jointpos`, `framepos`, `accelerometer`, `touch`… — the pane lists and plots them live.
- `<option timestep="0.002" gravity>`; `<keyframe><key name qpos ctrl/>` for start poses.
- `<default class>` and `<include file>` keep a robot's XML short; `<asset><mesh file>` for STL/OBJ.
- Contacts: `<geom condim friction>`; `<contact><exclude>` for self-collisions that should not happen.

## Controllers and policies

- Servos: `data.ctrl[:] = q_target` (joint angles). Torque motors: `data.ctrl[:] = tau`, or `pd_hold(kp, kd)`.
- Gaits by hand: a phase `t * 2π * f` per leg, targets from the home pose plus sinusoids; keep it slow.
- A trained policy: load weights (`.npz`, `.pt`), map `data.qpos/qvel/sensordata` → observation → action → `data.ctrl`
  (position targets, so the pane can re-simulate it).
- **Training**: `toolchain/install-training.sh` adds JAX, MJX and MuJoCo Playground
  (`from mujoco_playground import registry; env = registry.load("Go2JoystickFlatTerrain")`; PPO via
  Brax in `mujoco_playground` examples). On a Mac JAX runs on the CPU — a smoke run, not a policy; say
  so, and point at a GPU machine in Harness's Machines menu for the real run. Save checkpoints under
  `out/`, and record the policy's rollout with `record` so the pane shows what it learned.

## Rules

- `sim/` holds scripts, `scenes/` your MJCF, `out/` rollouts; never write inside `$MENAGERIE`.
- Always let `record` write the rollout; never hand-roll `rollout.qpos.json` or point anything at the mp4.
- Divergence (NaN) means the timestep is too large for the gains, or a joint has no range/damping.
- Every request that says "make it walk / stand / reach" is a controller first and a policy second.
