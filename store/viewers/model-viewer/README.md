# 3D Viewer, a Harness viewer package

The pane for 3D models in [Harness](https://github.com/autonomous-ai/autonomous-harness): the glTF
or GLB a harness exports, in Google's [`<model-viewer>`](https://modelviewer.dev) — orbit, zoom,
auto-rotate — reloaded on every export. A harness points at it with

```json
"viewer": { "use": "autonomous/model-viewer" }
```

and names the file in its verdict's `artifact`. Blender uses it; anything that ends in a glTF can.
(CAD parts as STEP go to the CAD Viewer instead.)

One Node file, one dependency: `viewer.mjs` serves the workspace on the loopback port Harness hands
it and the `@google/model-viewer` bundle from this package's `node_modules` (installed by `setup.sh`,
never a CDN), and pushes a reload over server-sent events when a file changes.

## Credit

`<model-viewer>` is Google's — [google/model-viewer](https://github.com/google/model-viewer),
Apache-2.0 (`LICENSE-model-viewer`), installed from npm as released. The wrapper is MIT, Autonomous.
