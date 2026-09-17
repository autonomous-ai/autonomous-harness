# MuJoCo, as a Harness agent

[Harness](https://github.com/autonomous-ai/autonomous-harness) agent package for
[MuJoCo](https://mujoco.org): describe a robot, a scene, a controller, a policy in the chat pane;
watch the rollout in the MuJoCo Viewer pane — the scene itself, in 3D, MuJoCo's WebAssembly build
running in the browser: orbit it, scrub it, or let it keep simulating. Menagerie robots (Unitree
Go2, G1, H1, Berkeley Humanoid, Booster T1) come with it; MJX and MuJoCo Playground are one script
away for training. Runs on Claude Code.

- `harness.json` — engine, template, skill, toolchain, `viewer.use: autonomous/mujoco-viewer`.
- `toolchain/setup.sh` — one venv with the pinned MuJoCo (`VERSIONS`) and a sparse checkout of the
  Menagerie robots at a pinned commit; `install-training.sh` adds JAX, MJX and Playground;
  `harness_mujoco.py` loads, records (mp4 + `rollout.qpos.json`, the trajectory the pane replays, +
  report) and holds poses; `verdict.py` judges the rollout and names the trajectory as the artifact.
- `skills/mujoco/` — the MuJoCo skill (ours). `template/` — a Go2 standing, and a pendulum MJCF.

**On a Mac, training runs JAX on the CPU** — enough for a smoke test, hours for a policy. A GPU machine
in Harness's Machines menu is where a real run belongs; the same workspace works there.

## Credit and stewardship

MuJoCo is Google DeepMind's — [google-deepmind/mujoco](https://github.com/google-deepmind/mujoco),
Apache-2.0 (`LICENSE-mujoco`) — and so is the [MuJoCo Menagerie](https://github.com/google-deepmind/mujoco_menagerie)
(Apache-2.0, with each robot's own licence in its folder — the Unitree models are BSD-3-Clause, Unitree
Robotics). Nothing of either is changed here; MuJoCo is installed from PyPI as released and the
Menagerie is fetched at a pinned commit. This repository is the Harness wrapper — the manifest, a
skill, the helper, the template, the verdict — written by Autonomous to bring MuJoCo into Harness,
on the project's behalf, to bootstrap the catalogue.

If you maintain MuJoCo or the Menagerie and want to own this package, it is yours: open an issue on
[autonomous-harness](https://github.com/autonomous-ai/autonomous-harness/issues) and we transfer this
repository and point the registry entry at it. Until then: bugs in MuJoCo belong upstream, bugs in the
wrapper belong here, and a newer MuJoCo or Menagerie is a bump of `VERSIONS`.

```sh
harness dsh check .                                # conformance
harness dsh install . --link                       # this checkout as the installed agent
python3 -m unittest toolchain/test_verdict.py      # the verdict, without mujoco
```
