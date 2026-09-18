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
