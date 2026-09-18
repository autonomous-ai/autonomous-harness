---
name: world-builder
description: Build a playable 3D voxel world in one HTML file from a plain-English description. Use whenever the user asks for a world, a voxel scene, a Minecraft-style sandbox, a place to walk around, or a prompt-to-world build.
---

# world-builder

Take the user's description and produce a **single self-contained `world/index.html`** that is
walkable first-person, lets the player place and break blocks, has a day/night cycle, and runs
entirely offline (all three.js/audio inline — no CDN at runtime). Everything ships in that one
file so the web-viewer pane can load it directly.

## The floor (do these first, in order)

1. **Camera + controls.** First-person pointer-lock mouse-look, WASD movement, canvas click to
   grab. Touch: a virtual stick / drag-to-look so it works on a phone too.
2. **Terrain.** Generate from a seeded noise function so the same description + seed gives the same
   world every time. Keep it small enough to walk easily (a few dozen blocks per axis).
3. **Place & break.** A crosshair; left click breaks the targeted block, right click places a block
   from a small hotbar. Visible block selection outline.
4. **Day/night** — a slowly-moving sun/moon and sky color ramp (or at minimum a timed light shift).
   A clock or sky clearly shows it.

## The gold checklist (what separates a good world from a demo)

- **Textured, not flat**: procedurally texture grass/dirt/stone/wood (noise + a few tones), so the
  world reads as voxels from a real game, not colored boxes.
- **HUD**: crosshair, a health/heart row, and a 5-slot hotbar (even if hotbar is read-only at
  first).
- **Specific palette terms win.** Concrete nouns ("dirt road through the center, river along the
  eastern edge, wheat fields") produce adjacency-aware aligned things (roads join into junctions,
  shorelines blend into sand). Vague nouns make generic mush. Ask one round of clarifying
  questions only — then default aggressively.
- **Audio**: at least a place/break click; a simple background tone is a bonus.

## Verify like a visitor, not a compiler

Load `world/index.html`, screenshot from the **player camera**, and look. Walk the world: can you
actually get in and out of the water, up a slope, through a doorway? The camera is the referee —
a world you cannot move through is not done no matter how the code reads. Render, look, fix,
re-render.

## Verdict feed

Write `.harness/verdict.json` (in the workspace) at every change:

```json
{ "spec": 1, "ready": false, "summary": "walkable village: road, river, houses · day/night · no audio yet",
  "findings": [{ "severity": "warning", "kind": "audio", "message": "no place/break sound yet" }],
  "artifact": "world/index.html",
  "phases": [{ "id": "world", "name": "World", "state": "done" },
             { "id": "interaction", "name": "Interaction", "state": "active" },
             { "id": "polish", "name": "Polish", "state": "pending" }],
  "updatedAt": "2026-09-18T00:00:00Z" }
```
