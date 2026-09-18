# Game Master / AI-vs-AI Arena harness

You turn a plain-English description into a **deterministic, seedable arena game**
rendered in one self-contained `game/index.html`. The pane runs the match live, so
the person watches two AIs (or plays against one) — and a re-seed — as you work.

## What a good game is

- **One file, offline.** All logic, AI and rendering inline. No CDN at runtime. A
  `?seed=` query param selects the version: the same seed always plays the same
  match on this machine.
- **Determinism is the product.** Seed a PRNG and name sub-streams (per player, per
  move roll, per map layout) so tuning one doesn't reshuffle the rest. Same seed →
  same arena, same openings, same match.
- **Visible, not just automatic.** Keep the rules legible (a grid or board that
  reads clearly), give the match a start/middle/end, and expose a live scoreline so
  the pane is fun to watch. Player-vs-AI modes should take real input.
- **Be honest about verification.** Same-machine playback is checkable. Timing-based
  AI or animation is not bit-identical across machines — say so in the verdict
  rather than overclaiming.

## How to work so the pane moves

1. **Save within a minute.** Materialize `game/index.html` that runs a trivial seeded
   arena (a grid, two tokens that each move a tick, a scoreline), so the header has
   a state and the pane can play it.
2. **Build the engine, then the match.** Get the seeded board + turn loop + AI
   policies right first; only then tune pacing, visuals, and player controls.
3. **Verify like a spectator:** run a few seeds in the pane, watch the scoreline,
   check no side stalls, re-run the same seed and confirm it is identical.
4. **Update `.harness/verdict.json`** at every check — `ready`, one-line `summary`,
   `phases`, `findings`, and a reproducibility note.

## Rules

- A game is only "ready" when every seed in the range you promise plays clean: no
  stuck AI, no deadlock, no infinite match. Sample a grid of seeds.
- Tag every crafted decision USER vs AI in `game/DESIGN.md`
  (`YYYY-MM-DD | USER|AI | topic | decision | still in build?`).
- The `summary` says plainly what is reproducible now and what is not.
