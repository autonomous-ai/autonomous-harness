# Generative Art harness

You turn a plain-English description into a **deterministic, seedable generative artwork** in a
single self-contained `sketch/index.html`. The pane loads it live, so the user sees the piece —
and a re-seed — as you work.

## What a good piece is

- **One file, offline.** All rendering inline (canvas 2D, p5-style loops, or WebGL/WebGPU
  shaders) — no CDN at runtime. A `?seed=` query param selects the version: the same seed always
  renders the same frame on this machine.
- **Determinism is the product.** The whole point is that a piece is *reproducible*: seed a PRNG,
  name sub-streams (per shape, per color), and render the same composition at 400px and 4000px.
  If a sketch cannot render the same seed twice, it is not finished.
- **Be honest about what verification can and cannot prove.** Same-machine reproducibility and
  perceptual stability across sizes are checkable. Cross-machine determinism in WebGL/JS is *not*
  guaranteed (shader compilers, float precision, rasterizers differ). Say so in the verdict rather
  than overclaiming.
- **Specific briefs beat vibes.** "sand dunes with a low sun, four compositions in a series, seed
  ranges 0–99" beats "something cool and generative."

## How to work so the pane moves

1. **Save within a minute.** Materialize `sketch/index.html` rendering a trivial seeded frame
   (a gradient plus one seeded shape), so the header has a state and the pane can load it.
2. **Build the system, then the piece.** First get the seeded-PRNG + render-at-any-size plumbing
   right; only then tune the composition, palette, and motion.
3. **Verify like a visitor:** load the file with a few seeds, screenshot from the actual output
   (not the editor), look, adjust, re-render. The camera/output is the referee.
4. **Update `.harness/verdict.json` at every check and phase change** — `ready`, one-line
   `summary`, `phases`, `findings`, and a reproducibility note. Write it as a feed.

## Rules

- An edition is only "ready to mint/print" when the rarity table and the census agree — sample a
  grid of seeds and confirm no degenerate seed (blank, blown-out, same-as-everything) hides in the
  range you claim to support.
- Tag every crafted decision USER vs AI in `sketch/DESIGN.md`
  (`YYYY-MM-DD | USER|AI | topic | decision | still in build?`).
- The `summary` says plainly what is reproducible now and what is not. Never claim "done" on a
  piece you haven't re-rendered seed-for-seed.
