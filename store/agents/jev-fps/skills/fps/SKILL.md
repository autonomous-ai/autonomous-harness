---
name: fps
description: Design an arena level for Jev FPS (the ASCII map, the demons, the pace), then measure where Jev's decision rate stops being enough.
---

# Craft: Jev FPS levels

Jev FPS is a first-person arena shooter that Jev plays by itself, one typed decision at a time. You
shape the arena in `level.json`. The craft is a map that reads well in 3D and a pace that shows the
real limit: about nine decisions a second.

## What Jev is asked, every tick

One call, four questions, all answered in parallel from the same state text:

```
turn    choice  LEFT_HARD  LEFT  LEFT_FINE  AHEAD  RIGHT_FINE  RIGHT  RIGHT_HARD
move    choice  FORWARD  BACK  STRAFE_LEFT  STRAFE_RIGHT  HOLD
fire    noul    "Fire now? Yes only when a demon is in your crosshair and you have ammo."
threat  score   calm < watchful < pressed < critical
```

The state text is what a player could know: health, ammo, wall distances, each demon in sight with
its bearing and distance, the nearest demon it can hear but not see, the automap route, and whether
the crosshair is on a demon. The pane shows this text live under "What Jev reads".

## Drawing a good map

- Tiles: `#` stone, `%` tech panel, `=` hell brick, `.` floor, `P` start, `D` demon spawn,
  `M` medkit, `A` ammo. The border must be wall. Every row is the same width.
- Give sight lines of 5 to 9 tiles. Very long halls make it a shooting gallery. Tight mazes hide
  demons until they are biting.
- Put spawns on at least two sides of the start so Jev must turn to deal with them.
- Pillars (single wall tiles in a room) make demons split and flank, which is fun to watch.
- A level of about 24 by 16 fills the minimap nicely. Bigger maps mean long quiet walks.

## Setting the pace

`demonSpeed` is the dial. Demons weave as they charge, so speed is also how fast they cross the
crosshair. Each wave adds one demon and 12% speed, so every run ends when the pace passes what nine
decisions a second can handle.

| feel | demonSpeed | demons |
|---|---|---|
| a stroll, long runs | 0.8 | 3 |
| the default | 1.2 | 4 |
| tense from wave 1 | 2.4 | 5 |
| brutal | 4.0 | 8 |

`tickMs` changes the decision rate itself. Raising it to 250 shows what a slower decision loop
costs: the same demons now win much earlier.

## Verifying

```bash
node "$JEV_DSH/toolchain/check.mjs"
```

Then watch the pane and read `.harness/verdict.json`: wave, kills, deaths, best wave, shots on
target. Report the pace you chose, how far Jev gets, and the speed where it stops clearing waves.
The pane's MOCK badge means the offline stand-in is playing, not the real model. Say so when you
report.
