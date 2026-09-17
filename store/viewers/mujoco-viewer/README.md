# MuJoCo Viewer, a Harness viewer package

The pane for robots in motion in [Harness](https://github.com/autonomous-ai/autonomous-harness):
MuJoCo's `simulate`, in the browser. The model the agent simulated is compiled and **run live** by
MuJoCo's own WebAssembly build and drawn with three.js the way `simulate` draws it — the model's
skybox, its checker floor with reflections and shadows, its lights. It opens on the live simulation,
always: from the rollout's first frame with the controls the agent's controller produced, so the robot
does what it did — and keeps going, and reacts when you push it. The recording is one click away as a
frame-exact replay, and the video, when there is one, is a tab, never the default.

A harness points at it with

```json
"viewer": { "use": "autonomous/mujoco-viewer" }
```

## What it does

| | |
|---|---|
| **Simulate** (`S`) | live `mj_step`, real-time with a budget per frame (a heavy model runs in slow motion and says so); play/pause `Space`, single step `→`, reset `⌫`, speed `−`/`=` (4× … 1/16×), keyframes from the model, real-time factor and sim time in the HUD |
| **Push it** | double-click a body to select it (highlighted, name and mass in a chip); `⌘`/`Ctrl`-drag pulls it with simulate's own spring (`mjv_applyPerturbForce`), `⇧` twists it; paused, the drag moves free bodies directly |
| **Controls** (`Tab`) | every actuator as a slider over its ctrlrange, writing `data.ctrl` live; "Take over" from the recording, Zero, controls from a keyframe; every joint's position, editable while paused |
| **Show** | contact points `C`, contact forces `F`, joint axes `J`, actuators `U`, tendons, centre of mass `M`, inertia boxes `I`, body/site/world frames `B`, sites, transparent `T`, wireframe `W`, shadows `H`, reflections `E`, skybox `K`, geom groups 0–5 — MuJoCo's own decorations from `mjv_updateScene`, sized and coloured by the model's `<visual>` |
| **Camera** | free orbit (drag, scroll, right-drag pan, `⌥`-double-click to look at a point), track the selected body, every `<camera>` in the model (`[` `]`), reset `0` |
| **Model / Sensors** | bodies as a tree with joints and masses, cameras, keyframes; sensors with live values; selecting a row selects the body |
| **Plot** | a live chart of the selected joint's position and velocity, an actuator's control and force, a body's height, energy, contacts, real-time factor or any sensor; in Replay, the whole recording with a cursor |
| **Replay** (`R`) | the recorded trajectory exactly, scrubbable on the same timeline; `←`/`→` frames; **Simulate from here** (`Enter`) hands that frame, velocities and controls to the physics |
| **Video** (`V`) | the rollout's mp4 on the same transport, when there is one |
| **Live** | a new rollout, an edited scene or a recompiled model reloads in place — camera, selection, panel kept; while the agent is recording, the header says so and the timeline fills in; a scene that does not compile yet keeps the last good model running and says why |
| **Model picker** | click the title: the agent's rollout, every MJCF in the workspace, every Menagerie robot |

Light and dark follow the system; the panel docks beside the stage in a wide pane and floats over it
in a narrow one, with the picture shifted so the robot stays in view.

## What the pane opens

The artifact Harness passes (`?file=`) is a hint, not the only way in. The server resolves
(`GET /api/resolve`), in order: a trajectory the artifact names or sits beside (a verdict that still
names `out/rollout.mp4` finds `out/rollout.qpos.json`), `out/rollout.qpos.json`, the report's
`model_path`, the model a script in `sim/` loads (`load_menagerie("unitree_go2")`, or a Menagerie
path spelled out in the script), the newest MJCF in `scenes/`. With nothing at all, a picker of the
Menagerie robots. `?model=menagerie/unitree_g1/scene.xml` opens a model by name.

## The rollout format

The [MuJoCo harness](../../agents/mujoco)'s `record()` writes it; anything that can write JSON can.

```jsonc
{
  "version": 2, "status": "done",               // "recording" while it is being written
  "model": "menagerie/unitree_go2/scene.xml",   // menagerie/… is the harness's; anything else is workspace-relative
  "model_xml": "out/rollout.model.xml",         // optional: the compiled model (MjSpec edits), loaded in place of
                                                //   `model` from `model`'s directory so its assets resolve
  "model_patch": { "opt.timestep": 0.001 },     // optional: runtime edits applied after compiling
  "dt": 0.034, "seconds": 5, "frames_expected": 151, "track": "base", "video": "out/rollout.mp4",
  "time": [0, 0.034, …],
  "qpos": [[…], …],                             // one row per frame — the only required field besides `model`
  "qvel": [[…], …],                             // optional: exact velocities for Simulate from here
  "ctrl": [[…], …],                             // optional: what the live simulation replays, interpolated per step
  "act":  [[…], …]                              // optional: actuator activations
}
```

Without `ctrl` (an older rollout) the pane replays exactly and simulates from the model's keyframe
controls.

## How it works

`viewer.mjs` is a dependency-free Node server on the loopback port Harness hands it. It serves the
page (`public/`), MuJoCo's `mujoco.wasm` and three.js from this package's `node_modules` (never a
CDN — the pane works offline), the workspace as `/ws/…` and the harness's Menagerie as
`/menagerie/…`, both with Range support (WebKit will not play a video without it). `GET /api/files`
reads a model's MJCF — `<include>`, `meshdir`/`texturedir`, every `file=` — and lists exactly the
files it needs; `GET /api/events` streams the workspace paths that change.

In the page, MuJoCo gets an in-memory filesystem and those files at their own relative paths, then
`mj_loadXML`. `engine.js` wraps the model and data: names from the names buffer (the bindings'
`mj_id2name` returns junk for unnamed objects), perturbation through `MjvPerturb`, picking through
`mj_ray`. `scene.js` builds three.js geometry from the compiled model (`mesh_vert`/`mesh_face`,
`geom_size`, `tex_data`), takes lights and per-geom texture flags from one `mjv_updateScene` pass,
decorations from `mjv_updateScene` every frame they are on, and colours with no sRGB transform and
Phong shading, as MuJoCo's renderer does; the skybox's face mapping was measured against MuJoCo's
own renderer. `main.js` runs the loop: physics on the main thread with a 9 ms budget per frame (the
Menagerie robots step 20–70× faster than real time in WASM), replay, the chrome. MuJoCo is Z-up and
so is the scene.

```bash
npm test          # the WASM API the pane depends on, and the server against scratch workspaces
./doctor.sh       # what is installed
HARNESS_VIEWER_PORT=18997 HARNESS_WORKSPACE=/path/to/workspace \
  HARNESS_DSH_DIR=/path/to/autonomous-mujoco ./viewer.sh
```

`window.__mujocoViewer` exposes the engine, stage and state for tests.

### What it does not draw

Height fields are drawn; flex bodies, skins and SDF geoms are not. Labels (`mjGEOM_LABEL`) are not
drawn. Collision geometry (group 3+) is hidden by default, as in `simulate`, and one toggle away.

## Credit and stewardship

MuJoCo is Google DeepMind's — [google-deepmind/mujoco](https://github.com/google-deepmind/mujoco),
Apache-2.0 (`LICENSE-mujoco`), installed from npm as released (`@mujoco/mujoco`, the official
single-threaded WebAssembly build, pinned). three.js is the three.js authors' — MIT
(`LICENSE-three`), also from npm, including its `OrbitControls` and `Reflector` addons. Reading
geometry out of a compiled model follows MuJoCo's own `wasm/demo_app` (Apache-2.0) and
[zalo/mujoco_wasm](https://github.com/zalo/mujoco_wasm) (MIT, `LICENSE-mujoco-wasm`). See
`THIRD_PARTY_NOTICES.md`. The wrapper — the server, the pane, the rollout format — is MIT,
Autonomous.

Autonomous wrote this wrapper to bootstrap the Harness catalogue; bugs in MuJoCo go upstream, bugs
in the pane come here.
