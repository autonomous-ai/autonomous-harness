---
name: gen-art
description: Build a deterministic, seedable generative artwork in one HTML file from a plain-English description. Use whenever the user asks for a generative piece, an edition, a flow field, a shader, a seedable series, or prompt-to-art.
---

# gen-art

Take the user's description and produce a **single self-contained `sketch/index.html`** that renders
a **deterministic, seedable** generative artwork, loading the seed from a `?seed=` query param so
the web-viewer can preview the current seed and re-seed live.

## The floor (in order)

1. **Seeded PRNG.** A small seeded PRNG (mulberry32 / sfc32) derived from the hash of the seed
   string. Nothing may call a non-seeded random — the sketch must be reproducible.
2. **Render-at-any-size.** The composition is defined in logical units and scaled; the same seed
   renders at 400px preview and 4000px print. High-DPI (devicePixelRatio) aware.
3. **`?seed=` plumbing.** Reading the param, plus a tiny UI (input + "re-seed" button) so the user
   can browse seeds in the pane.
4. **Named sub-streams.** One PRNG sub-stream per concern (composition, palette, detail) so tuning
   one doesn't reshuffle the other.

## The gold checklist

- **Trait + rarity tables that survive an edition**: a deterministic mapping from seed → traits
  (palette, layout, density), and a census that proves no hidden degenerate seed.
- **Palette discipline**: OKLCH/OKLab ramps or a seeded palette-from-image; grain/dither as taste.
- **Style range**: flow fields, packing, reaction-diffusion, attractors, raymarched shaders,
  Islamic/polar patterns — matched to the brief, not all at once.
- **Export routes**: a `?seed=X&size=4000` render for print, a video-loop-friendly static repaint.
- Motion (if the brief wants it) should be seed-stable and respect `prefers-reduced-motion`.

## Verify like a visitor, not a compiler

Render a grid of seeds, screenshot the actual output, and look. Two hard checks before "ready":
- **Re-render same-seed** and diff — it must be byte-perceptually stable on this machine.
- **Census the seed range you promise** (e.g. 0–99); reject any blank/blown-out/duplicate frame.

Be explicit in the verdict about the reproducibility guarantee: same-machine yes; *cross*-machine
for WebGL you cannot prove — say so.

## Verdict feed

Write `.harness/verdict.json` at every change:

```json
{ "spec": 1, "ready": false, "summary": "seeded flow field · re-seed live · census 0–99 clean",
  "findings": [{ "severity": "info", "kind": "reproducibility", "message": "same-machine verification pending; cross-machine WebGL not provable" }],
  "artifact": "sketch/index.html",
  "phases": [{ "id": "seed", "name": "Seeded core", "state": "done" },
             { "id": "piece", "name": "The piece", "state": "active" },
             { "id": "edition", "name": "Edition", "state": "pending" }],
  "updatedAt": "2026-09-18T00:00:00Z" }
```

## Starting from Fieldwork

The template is functional: Three techniques, named random streams, palette selection, density/tension controls, nearby seed previews, high-resolution PNG export.

Keep its useful controls and exports when making a user's creation. Test the behavioral core
(artModel, artPaths, drawArt, logical print coordinates) as well as the visible result. A self-contained HTML file can still have well-separated
model, rendering, input and export functions. Do not turn a finished starter into a waiting screen.

Presence-only helpers do not prove correctness or reproducibility. Record actual evidence before
marking the result ready. Export and reopen the result as part of the handoff to the user.

## Check your actual edited model

Run `node tools/check.mjs --seeds 100` in the workspace. It reads the pure model from
`<script id="harness-model">` in the artifact, checks domain invariants, repeats each seed, and
writes `.harness/model-check.json`. Preserve that script boundary when editing. Model checks are
followed by browser interaction, exported-output inspection, and visual or listening review.
