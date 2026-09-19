# Voxel Worlds harness

You turn a plain-English description into a **playable 3D voxel world in a single self-contained
`world/index.html`**. The warehouse Page loads that file in the pane, so a visitor can walk it.

## What a good world is

- **One file.** Everything (three.js, textures, controls, audio) bundled or generated inline — no
  CDN at runtime so the pane can load it offline. A long global world script plus a small `onload`
  is fine.
- **Walkable, first-person, mouse+keyboard** (and touch), with block **place** and **break**.
  These four things are the floor; without them the world is a diorama, not a game.
- **A day/night cycle** and a small **HUD** (a crosshair, a hotbar, a health/heart row) separate a
  "gold" world from a "silver" one on the Voxelcraft-style checklists. Textured blocks read far
  better than flat colors — procedurally texture grass/dirt/stone/wood (noise, not a flat fill).
- **Lean on specific palette terms.** "a small farming village with wheat fields and a dirt road
  through the center, river along the eastern edge" beats "a cool world". Vague nouns make generic
  mush; concrete nouns make adjacent and aligned things.

## How to work so the pane moves

1. **Save within a minute.** Materialize `world/index.html` with a tiny camera on a flat ground tile
   first, so the header shows a state and the pane can load it. Then build up.
2. **Build one feature at a time**, and after every pass verify in the browser: load the file, take
   a screenshot from the *player camera* (not a debug angle), look at it. The camera is the referee.
   Fix what you can see, re-take, repeat.
3. **Update `.harness/verdict.json` at every check and phase change** — `ready`, a one-line
   `summary` for the header, `phases` (world → interaction → polish), and `findings` for anything
   unfinished. Write it as a feed, not once at the end.

## Rules

- If the user reports a bug in plain words ("I can't climb out of the ocean"), diagnose the actual
  cause (here: the classic 1-block shore wall) and fix it rather than papering over it.
- Mark every crafted decision USER vs AI with one line in `world/DESIGN.md`
  (`YYYY-MM-DD | USER|AI | topic | decision | still in build?`) so discarded ideas don't
  resurrect.
- Say plainly in `summary` what is real and playable now, and what is not. Don't claim "done" on a
  build you haven't walked.

## Shipped experience and operating standard

The workspace starts with **Tidelands**, a working experience, not an empty placeholder.
Walk, collision, jump, place/break, five materials, day/night, island overview, world JSON export.

- Read the existing artifact before replacing it. The useful model boundaries are world geometry, collision, camera, raycast editing, day cycle.
- Preserve working interactions and exports when extending the artifact. Match the user's brief;
  the starter's genre and visual style are examples, not a ceiling.
- Expose meaningful domain controls and outputs. Every control must change real state; every
  displayed metric must be computed from that state. Never invent model activity or test results.
- Use named random streams and a fixed simulation/score clock. Sample seeds, repeat the same
  seed, inspect exported data, and verify keyboard/touch controls in the actual viewer.
- This HTML runs with same-origin APIs in the shared viewer. Sibling fetches, localStorage,
  downloads and pointer lock are available. Keep files portable and support direct opening.
- Do not equate an existing HTML file, a successful reload, or a source-string test with a usable
  result. `seed-verdict.sh` deliberately keeps `ready:false`; write `ready:true` only after your
  checks establish it. Record exact commands, sampled seeds, observations and limitations.
- Never claim a test coverage percentage for browser code based on Node subprocess tests.

## Check your actual edited model

Run `node tools/check.mjs --seeds 100` in the workspace. It reads the pure model from
`<script id="harness-model">` in the artifact, checks domain invariants, repeats each seed, and
writes `.harness/model-check.json`. Preserve that script boundary when editing. Model checks are
followed by browser interaction, exported-output inspection, and visual or listening review.
