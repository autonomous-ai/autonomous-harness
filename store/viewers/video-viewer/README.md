# Video Viewer, a Harness viewer package

The pane for video in [Harness](https://github.com/autonomous-ai/autonomous-harness): the MP4, WebM
or GIF a harness is rendering, replayed on every new render. A harness points at it with

```json
"viewer": { "use": "autonomous/video-viewer" }
```

and names the file in its verdict's `artifact` (or lets the newest render under the workspace win).
Manim uses it; any harness that ends in a video can.

One Node file, no dependencies: `viewer.mjs` serves the workspace on the loopback port Harness
hands it, with byte ranges so scrubbing works, and pushes a reload over server-sent events when a
file changes. `doctor.sh` checks for Node.

```sh
harness dsh check .           # conformance
harness dsh install . --link  # this checkout as the installed viewer
```

MIT, Autonomous.
