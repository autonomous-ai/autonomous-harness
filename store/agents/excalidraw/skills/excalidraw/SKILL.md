---
name: excalidraw
description: Draw diagrams as .excalidraw files — architectures, flows, sequences, whiteboard sketches — with the scene helper or by editing the JSON, judged by the verdict and shown hand-drawn in the pane. Use for any request that ends in a diagram.
---

# excalidraw

An `.excalidraw` file is JSON: `{ type: "excalidraw", version: 2, elements: [...], appState, files }`.
Elements are rectangles, ellipses, diamonds, text, arrows, lines, frames. The pane is Excalidraw's own
editor in view mode; the same file opens in excalidraw.com and the VS Code extension.

## Write with the helper, not by hand

`scene.py` is on `PYTHONPATH` (`$EXCALIDRAW_TOOLCHAIN/scene.py`). One script per diagram:

```python
from scene import Scene
s = Scene()                                   # a whiteboard: light canvas, Excalidraw's palette
s.title("Order service", 0, -110)
api = s.box(0, 0, "API", color="blue")        # rectangle; shape="ellipse" | "diamond"
db  = s.box(320, 0, "Postgres", color="green", shape="ellipse")
q   = s.box(0, 180, "Queue", color="yellow", shape="diamond")
s.arrow(api, db, "SQL")                       # bound at both ends; dashed=True, both=True
s.arrow(api, q, "job", dashed=True)
s.note(660, 0, "Retries: 3, backoff 2s", color="yellow")
s.frame([api, db, q], "Backend")              # a named frame around members
s.save("diagram.excalidraw")
```

Then the verdict: `python3 "$EXCALIDRAW_TOOLCHAIN/verdict.py"` (or `… verdict.py flows/x.excalidraw`).

Colours: blue, green, yellow, red, purple, pink, orange, teal, gray, none — Excalidraw's palette.
Fonts: `font=1` hand-drawn (default), `2` sans, `3` mono (code, paths, hostnames).

## Layout that reads

- A grid of 300 px columns and 180 px rows; boxes 160×72 unless a label needs more. Left to right for
  flow, top to bottom for hierarchy, never diagonal chains.
- One idea per box, two or three words. The verb goes on the arrow ("SQL", "publishes", "HTTPS").
- Frames for boundaries (a service, a network, a team); notes for the one fact that matters
  (a limit, a retry, a port). At most ~12 boxes per diagram — split otherwise.
- Name every frame: the pane's Present mode steps through frames in reading order (top to bottom,
  left to right) with the frame name as the step title, so frames double as the walkthrough.
- `exports/` is where the pane saves PNG/SVG exports when the user asks for them; do not write
  diagrams there.
- Sequence diagrams: actors as boxes in a row at y=0, lifelines as `s.arrow(a, b, "…")` rows
  stepping down 100 px; sketches: the hand font, few colours.

## Editing the JSON directly

For a tweak (move a box, rename a label) edit the file: change `x`/`y`, or the `text` AND
`originalText` of a text element. Keep `id`s and `boundElements` as they are; the verdict flags a
binding that points at nothing. Regenerate from the script for anything larger.
