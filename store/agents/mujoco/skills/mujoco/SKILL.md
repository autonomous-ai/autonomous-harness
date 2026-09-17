---
name: mujoco
description: Simulate robots and scenes with MuJoCo — Menagerie robots (Unitree Go2, G1, H1, Berkeley Humanoid, Booster T1), your own MJCF, controllers and policies — record rollouts the pane plays, and train with MJX and MuJoCo Playground. Use for any request that ends in a simulation, a rollout or a policy.
---

# mujoco

MuJoCo is a physics engine for robotics: a model (MJCF XML → `MjModel`), a state (`MjData`), a step
(`mj_step`). Tools: `$MUJOCO_PYTHON` (the pinned venv), `$MENAGERIE` (the robots), `harness_mujoco`
on `PYTHONPATH` (load, record, PD hold). Never install another MuJoCo.

## Simulate, record, verdict

```bash
"$MUJOCO_PYTHON" sim/hello.py                  # → out/rollout.mp4 + rollout.qpos.json + rollout.json
"$MUJOCO_PYTHON" "$MUJOCO_TOOLCHAIN/verdict.py"         # judges the newest rollout → pane header
```

```python
from harness_mujoco import load_menagerie, load_xml, pd_hold, record
model, data = load_menagerie("unitree_go2")            # or load_xml("scenes/mine.xml")
def ctrl(model, data, t):                              # called before every step
    data.ctrl[:] = model.key_ctrl[0]                   # hold the home pose (position actuators)
record(model, data, ctrl, seconds=4, out="out/rollout.mp4", track="base")   # free camera follows body "base"
```

`record` writes two rollouts and one report. `out/rollout.mp4` is the video; `out/rollout.qpos.json`
is the trajectory — the model's path plus one `qpos` row per frame — and **that is what the pane
shows**: the scene rendered live in the browser by MuJoCo's WebAssembly build, which the user can
orbit, scrub, and switch to live physics. `rollout.json` reports NaN (divergence) and peak joint
velocity to the verdict. Keep rollouts short while iterating (2–4 s at 30 fps ≈ seconds of wall time).

The trajectory needs to know which MJCF to load. `load_xml`, `load_menagerie` and a plain
`MjModel.from_xml_path` or `MjSpec.compile` are all traced back to their file automatically; if you
build a model some other way, say so — `record(..., model_path="scenes/mine.xml")` — or the pane has
nothing to replay and the verdict says as much.

## The robots (Menagerie, pinned)

`unitree_go2` (quadruped, 12 actuators, keyframe "home"), `unitree_go1`, `unitree_a1`, `unitree_g1`
(humanoid, 29 DoF), `unitree_h1` (humanoid), `berkeley_humanoid`, `booster_t1`. Each has
`scene.xml` (robot + floor + light) and `<robot>.xml`; the MJX variants (`scene_mjx.xml`) are the ones
to train with. Body and joint names: `[model.body(i).name for i in range(model.nbody)]`.

## MJCF, the parts that matter

- `<worldbody>` → nested `<body pos quat>` with `<joint type="hinge|slide|ball|free" axis range damping>`
  and `<geom type="box|sphere|capsule|cylinder|mesh|plane" size mass rgba>`; `<light>`, `<camera name>`.
- `<actuator>`: `<motor joint gear ctrlrange>` (torque), `<position joint kp>` (PD), `<velocity>`.
- `<option timestep="0.002" gravity>`; `<keyframe><key qpos ctrl/>` for a start pose.
- `<default class>` and `<include file>` keep a robot's XML short; `<asset><mesh file>` for STL/OBJ.
- Contacts: `<geom condim friction>`; `<contact><exclude>` for self-collisions that should not happen.

## Controllers and policies

- PD on positions: `data.ctrl[:] = q_target` with `<position kp>` actuators; torque: `data.ctrl[:] = tau`.
- Gaits by hand: a phase `t * 2π * f` per leg, targets from the home pose plus sinusoids; keep it slow.
- A trained policy: load weights (`.npz`, `.pt`), map `data.qpos/qvel/sensordata` → observation → action → `data.ctrl`.
- **Training**: `toolchain/install-training.sh` adds JAX, MJX and MuJoCo Playground
  (`from mujoco_playground import registry; env = registry.load("Go2JoystickFlatTerrain")`; PPO via
  Brax in `mujoco_playground` examples). On a Mac JAX runs on the CPU — a smoke run, not a policy; say
  so, and point at a GPU machine in Harness's Machines menu for the real run. Save checkpoints under
  `out/`, and record the policy's rollout with `record` so the pane shows what it learned.

## Rules

- `sim/` holds scripts, `scenes/` your MJCF, `out/` rollouts; never write inside `$MENAGERIE`.
- Divergence (NaN) means the timestep is too large for the gains, or a joint has no range/damping.
- Every request that says "make it walk / stand / reach" is a controller first and a policy second.
