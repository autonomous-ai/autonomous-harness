# 3D Viewer, a Harness viewer package

The pane for 3D models in [Harness](https://github.com/autonomous-ai/autonomous-harness): the glTF a
harness exports, in a viewport that reads like Blender's — without Blender. It is where you *look*;
changes happen by asking the agent, and every export lands here live, in place, without losing your
view. A harness points at it with

```json
"viewer": { "use": "autonomous/model-viewer" }
```

and names the `.glb`/`.gltf` in its verdict's `artifact`. Blender uses it; anything that ends in a
glTF can. (CAD parts as STEP go to the CAD Viewer instead.)

## What it does

- **Outliner** — the scene's hierarchy under the names it was built with: collections, objects,
  children, cameras, lights. Eye toggles (a hidden collection hides what is in it), click to select,
  Shift-click to add, double-click to frame, hover to highlight, filter by name, isolate one thing.
- **Properties** — for the selection: dimensions in mm, location / rotation / scale in Blender's axes,
  vertex, face and triangle counts, modifiers, materials (colour, metal, roughness, texture maps),
  collection and parent, custom properties. With nothing selected, the scene: size, counts,
  materials, cameras, lights, animation, the Blender version. In a narrow pane a compact card shows
  the selection and the panel slides over the viewport (`N`).
- **Shading**, as in Blender's header — Wireframe, Solid (studio, matcap or flat lighting; material,
  per-object or single colour), Material preview (image-based lighting: studio, soft box, sunset,
  night rim) and Rendered (a sun with soft shadows, a contact shadow on the ground, ambient
  occlusion, AgX tone mapping) — plus X-ray. Backgrounds: light, Blender grey, white, black, or the
  environment itself.
- **Navigation** — orbit (drag, or two-finger swipe), pan (Shift or right drag), zoom to the cursor
  (scroll or pinch); the axis gizmo and numpad views (`1` `3` `7`, Ctrl for the opposite, `9`, `2`
  `4` `6` `8`, `5` perspective/orthographic, auto-perspective as in Blender), `Home` frame all, `.`
  frame selected, `/` local view, smooth transitions, a turntable spin (`T`). The HUD says the view
  ("Front Orthographic"), where the active object lives, objects, triangles, size and the grid step.
- **Inspection** — measure between two clicked points, snapping to corners, with ΔX ΔY ΔZ (`M`); a
  section plane along X, Y or Z with a slider, flip, and hatched caps where it cuts (`C`); an
  exploded view that pulls parts apart from the centre (`E`). A floor grid in real units with the X
  and Y axes, fading like Blender's.
- **Scene cameras and lights** — look through the exported camera with its frame and passepartout
  (`0`); turn the exported lights on in Material or Rendered shading.
- **Animation** — a timeline when the glTF has any: play, scrub, frame numbers at the scene's fps,
  speed. Arrow keys step frames.
- **Live** — the workspace is watched; a new export reloads in place keeping camera, selection,
  hidden objects, local view and explode, and says what changed ("Updated · Shade changed", the
  changed parts flash blue). While the harness's script runs the header says "Rebuilding · Rendering
  turntable 34/120" over the last good model. With no verdict yet it opens on the newest glTF; with
  nothing at all it says what it is waiting for.
- **Secondary views** — the rendered turntable (Turntable tab, `V`) and still (Render tab), when the
  workspace has them. A verdict that names a video still opens on the 3D scene.
- **Screenshot** (`P`) — the view at 2×, copied to the clipboard (or saved). **`?`** lists every key.

## Conventions it reads (all optional)

- **glTF `extras.harness`** as the Blender harness writes them: on the scene `metres_per_unit`,
  `fps`, `camera`, `materials.<name>.viewport_color`; on each node `type` (`COLLECTION`, `MESH`,
  `CAMERA`, `LIGHT`…), `dimensions_mm`, `location_mm`, `rotation_deg`, `scale`, `vertices`, `faces`,
  `triangles`, `modifiers`, `collections`, `parent`. Other `extras` show as custom properties.
  Without them everything is derived from the glTF itself.
- **`report.json`** beside the export with `size_mm`: used to read the units when the export does
  not say. Otherwise a model larger than 20 units is taken to be in millimetres (Blender scenes in
  mm export "metres" that are millimetres), smaller ones in metres; the Shading menu can override.
- **`.harness/build.json`** — the build feed: `{ "state": "building" | "done" | "failed", "step",
  "progress": 0..1, "pid", "error", "updatedAt" }`. A `building` feed whose pid is gone reads as
  stopped. Without a feed, a render writing `*-frames/` counts as building.

## How it works

`viewer.mjs` is a dependency-free Node server on the loopback port Harness hands it. It serves the
page (`web/`), three.js from this package's `node_modules` (installed by `setup.sh` — never a CDN, so
the pane works offline), workspace files under `/ws/` with byte ranges, `GET /api/state` (models,
videos and stills newest first, the verdict, the build feed) and `GET /events`, server-sent events
that carry the same state whenever the workspace changes. A model is announced only once its size
has stopped changing.

The page is plain ES modules: `viewport.js` (three.js: loading, shading, the outline and section
shaders, contact shadow, explode, cameras, animation, render-on-demand), `nav.js` (Blender-style
navigation and the gizmo), `outliner.js`, `measure.js`, `grid.js`, `env.js` (environments built
from small scenes into PMREM — no HDR files) and `app.js` (live state, header, menus, keys).
Nothing renders while nothing moves.

```sh
./setup.sh      # npm ci + the smoke test
./doctor.sh
npm test        # the server end to end: shell, three, state, ranges, sandbox, live events
```

## Credit and stewardship

three.js is its authors' — [mrdoob/three.js](https://github.com/mrdoob/three.js), MIT
(`LICENSE-three`, `THIRD_PARTY_NOTICES.md`), installed from npm as released. The viewer is MIT,
Autonomous.
