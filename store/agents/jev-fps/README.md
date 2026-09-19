# Jev FPS

**Jev plays a first-person arena shooter, live.** Jev is TypeSafe's System One model. It never sees
a pixel and never writes a word. About nine times a second the marine's situation is written out as
a few lines of text: health and ammo, which demons are in sight and at what bearing, what it can
hear behind it, how far the walls are, and the automap route. Jev answers four typed questions in
**one call**:

| question | type | what it drives |
|---|---|---|
| `turn` | choice of 7 | snap, turn or nudge left or right, or keep facing ahead |
| `move` | choice of 5 | forward, back, strafe left, strafe right, hold |
| `fire` | noul (yes/no) | pull the trigger this instant |
| `threat` | score, 4 levels | how dangerous this instant is (shown on the HUD) |

The pane renders the fight as a textured 3D view at 60 fps, with a minimap, Jev's answers shown as
lit keys filled by their probability, the exact text Jev reads, and a live panel with decisions per
second, latency, tokens and cost.

This is a harness for OpenHarness. The agent on the right edits `level.json`. The viewer on the left
runs the arena and asks Jev for every decision.

## Play with it

- **Click the minimap** to spawn a demon, drop a medkit or drop ammo where you clicked.
- **Swarm +5** throws five demons at Jev at once.
- **Demon speed** slider changes the pace live.
- **Grab the controls**: hold `W A S D` to move, `←` `→` to turn (`Shift` for a hard turn), `Space`
  to fire. While you hold a key you drive. Jev keeps answering, so the lit keys show what it would
  have done. Let go and Jev takes over again.
- Pause, Step (one decision at a time) and Reset.

## The honest dial

Each cleared wave adds one demon and makes them 12% faster. Demons weave as they charge, so the
faster they are, the faster they cross the crosshair. A marine that decides about nine times a
second can only turn so far per decision, so at some speed it starts to miss, gets surrounded and
dies. Then the run restarts at wave 1. Nothing is random on purpose: the limit is the decision rate.

Measured with the offline stand-in over 6,000 decisions:

| `demonSpeed` | deaths | best wave reached |
|---|---|---|
| 1.2 (default) | 2 | 10 |
| 2.4 | 4 | 6 |
| 4.0 | 8 | 4 |

## Anatomy

```
jev-fps/
  harness.json               # DSH manifest (engine: claude)
  AGENTS.md                  # tells the agent how to design a level and what to report
  skills/fps/SKILL.md        # the level-design and verification craft
  template/level.json        # the starter level (ASCII map + pace)
  toolchain/
    jev.mjs                  # the Jev client (real TypeSafe API, or an offline stand-in)
    check.mjs                # validates level.json
    viewer.sh setup.sh doctor.sh init-workspace.sh
  viewer/
    viewer.mjs               # loopback server + the decision loop
    sim.mjs                  # the arena: map, demons, shots, pickups, waves
    mock.mjs                 # the offline stand-in's reflexes (reads only the state text)
    kit.mjs                  # loopback-only HTTP/SSE server helpers
    studio.js                # the software raycaster and HUD
    jev-hud.js               # the "Jev live mind" panel
  test/viewer.test.mjs
```

## Jev, honestly

With `TYPESAFE_API_KEY` set, every decision is a real call to `POST /v1/systemone`. Without a key
the harness runs on a deterministic local stand-in that reads the same state text and answers the
same questions, so the demo works offline. The pane badges that mode `MOCK`. The stand-in exercises
the plumbing. It is not Jev's judgement.

The arena, the demons and the numbers are made up. This shows decision rate and calibration on a
synthetic game. It is not a benchmark of any real game or product.

## Credit and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness is an OpenHarness wrapper that
  only calls the public API. It contains no TypeSafe code.
- The idea of a System One model playing a shooter from structured game state comes from TypeSafe's
  own launch demo and the community projects that followed. This harness is an independent,
  from-scratch arena. It uses no code or assets from any commercial game.
- **OpenHarness** (Autonomous) is MIT-licensed. This wrapper is MIT too (see `LICENSE`).
- Built by Autonomous for the OpenHarness store.
