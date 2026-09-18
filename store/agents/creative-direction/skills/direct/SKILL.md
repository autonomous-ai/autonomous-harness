---
name: direct
description: Build a deterministic, seedable creative direction / moodboard in one HTML file from a look-and-feel brief. Use whenever the user asks for a moodboard, a brand look, a palette, a film grade, a style direction, or prompt-to-design.
---

# direct

Take the brief and produce a **single self-contained `board/index.html`** that renders
a **deterministic, seedable** living moodboard, loading the seed from a `?seed=`
query param so the web-viewer can preview the current seed and re-seed live.

## The floor (in order)

1. **Seeded PRNG.** A small seeded PRNG derived from the hash of the seed string.
   Nothing may call a non-seeded random — the board must be reproducible.
2. **Moodboard anatomy.** A palette ramp, a type pairing, a layout grid, and a
   one-line rationale per direction, all derived deterministically from the seed.
3. **`?seed=` plumbing.** Reading the param, plus a tiny UI (input + "re-seed"
   button) so the person can browse directions in the pane.
4. **Named sub-streams.** One PRNG sub-stream per concern (palette, type, layout).

## The gold checklist

- **Trait + rarity tables that survive an edition**: seed → traits (palette, type,
  mood), and a census proving no hidden degenerate seed.
- **Palette discipline**: OKLCH/OKLab ramps or a seeded palette-from-image; note
  contrast on every pairing.
- **Style range**: editorial, brutalist, soft-brand, film-noir, kitschy — matched
  to the brief, not all at once.
- **Export route**: `?seed=X&size=...` render for print, plus a board summary block.

## Verify like a designer, not a compiler

Render a grid of seeds, screenshot the actual output, and look.
Two hard checks before "ready":
- **Re-render same-seed** and diff — it must be perceptually stable on this machine.
- **Census the seed range you promise** (e.g. 0-99); reject any blank, low-contrast,
  or clipped frame.

Be explicit in the verdict about the reproducibility guarantee: same-machine yes;
cross-machine color you cannot prove — say so.

## Verdict feed

Write `.harness/verdict.json` at every change:

```json
{ "spec": 1, "ready": false, "summary": "editorial moodboard · re-seed live · census 0-99 clean",
  "findings": [{ "severity": "info", "kind": "reproducibility", "message": "same-machine verified; cross-machine color not provable" }],
  "artifact": "board/index.html",
  "phases": [{ "id": "seed", "name": "Seeded core", "state": "done" },
             { "id": "board", "name": "The board", "state": "active" },
             { "id": "edition", "name": "Edition", "state": "pending" }],
  "updatedAt": "2026-09-18T00:00:00Z" }
```
