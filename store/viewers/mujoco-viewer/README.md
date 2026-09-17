# MuJoCo Viewer, a Harness viewer package

The pane for robots in motion in [Harness](https://github.com/autonomous-ai/autonomous-harness).
It is not a video player: the MJCF the harness simulated is compiled and run **in the browser** by
MuJoCo's own WebAssembly build, drawn with three.js. Orbit and zoom the scene, scrub the rollout the
harness recorded, or flip to **Live** and watch the physics keep going from the pose on screen.

A harness points at it with

```json
"viewer": { "use": "autonomous/mujoco-viewer" }
```

and writes `out/rollout.qpos.json` beside its video. The [MuJoCo harness](https://github.com/autonomous-ai/autonomous-harness/tree/main/store/agents/mujoco)'s
`record()` writes it; anything that can write a qpos per frame can use this pane.

## The artifact

```jsonc
{
  "model": "menagerie/unitree_go2/scene.xml",  // menagerie/… is the harness's robot; anything else
  "dt": 0.0333333,                             //   is workspace-relative, e.g. scenes/arm.xml
  "nq": 19,                                    // qpos width
  "qpos": [[0, 0, 0.27, 1, 0, 0, 0, …], …]     // one row per frame
}
```

Nothing else is needed — the model is the source of truth for what a frame looks like, so a rollout
of a hundred frames is a hundred short rows, not a video, and it stays scrubbable and orbitable.
With no trajectory the pane still shows a model: `?model=menagerie/unitree_g1/scene.xml` loads it
and runs it live.

## Controls

| | |
|---|---|
| drag / scroll | orbit, zoom (three.js `OrbitControls`) |
| **space** | play / pause |
| the scrubber | any frame of the rollout, paused |
| 0.25× … 4× | playback and live speed |
| **Live** (`L`) | stop replaying, start stepping `mj_step` from the pose on screen |
| **Reset** (`R`) | back to the model's first keyframe |

The header says simulated time, bodies, actuators and which mode you are in.

## How it works

`viewer.mjs` is a dependency-free Node server on the loopback port Harness hands it. It serves the
page, MuJoCo's `mujoco.wasm` and three.js from this package's `node_modules` (installed by
`setup.sh` — never a CDN, so the pane works offline), and two file roots: the workspace as `/ws/…`
and the harness's Menagerie checkout as `/menagerie/…`. `GET /list?dir=…` is a directory listing of
model files under either root.

In the page (`app.js`), MuJoCo gets an in-memory filesystem — `MEMFS` mounted at `/working` — and
every file of the model's directory is fetched and written into it at the same relative path, so
`<include>`, `meshdir` and every `.obj` resolve exactly as they do on disk. Then `mj_loadXML`, and
the scene is built out of the *compiled* model: `mesh_vert` / `mesh_normal` / `mesh_face` addressed
through `geom_dataid` for meshes, `geom_size` for boxes, spheres, capsules, cylinders and
ellipsoids, `mat_rgba` and `geom_rgba` for colour, group 3 and up left out the way `simulate`
leaves it out. Every frame is `data.xpos` / `data.xquat` copied into the three.js body groups —
replay writes a row into `data.qpos` and calls `mj_forward`; live calls `mj_step` until it has
caught up, capped at 35 ms of simulated time per frame so a heavy model runs slow rather than
freezing the page.

The scene stays in MuJoCo's frame: Z is up, the camera's up is `(0, 0, 1)`, and no axis is
swizzled. That is MuJoCo's own web demo's convention.

```bash
npm test          # the WASM API this pane depends on, in ~40 assertions
./doctor.sh       # what is installed
HARNESS_VIEWER_PORT=18997 HARNESS_WORKSPACE=/path/to/workspace \
  HARNESS_DSH_DIR=/path/to/autonomous-mujoco ./viewer.sh
```

### What it does not draw

Textures (the checker floor is a grid instead), height fields, SDF geoms, skins, tendons, contact
forces, and MuJoCo's own lights and cameras — the pane lights the scene itself. Collision geometry
(group 3+) is hidden, as in `simulate`.

## Credit

MuJoCo is Google DeepMind's — [google-deepmind/mujoco](https://github.com/google-deepmind/mujoco),
Apache-2.0 (`LICENSE-mujoco`), installed from npm as released (`@mujoco/mujoco`, the official
single-threaded WebAssembly build, pinned). three.js is the three.js authors' — MIT
(`LICENSE-three`), also from npm. Reading geometry out of a compiled model follows two open
examples: MuJoCo's own `wasm/demo_app` (Apache-2.0, in the MuJoCo repository) and
[zalo/mujoco_wasm](https://github.com/zalo/mujoco_wasm), MIT (`LICENSE-mujoco-wasm`). The wrapper —
the server, the pane, the replay format — is MIT, Autonomous.

Autonomous wrote this wrapper to bootstrap the Harness catalogue; bugs in MuJoCo go upstream, bugs
in the pane come here.
