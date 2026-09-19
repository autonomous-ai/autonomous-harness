# Jev Arena

**A small living grid world where Jev decides every move.** Jev is TypeSafe's System One decision
model. It never writes text. It answers typed questions with probabilities, fast. Here it walks a
little robot through a maze of walls, picks up coins, and heads for a star.

This is a harness for OpenHarness. The agent on the right designs `arena.json`. The viewer on the
left runs the world and asks Jev for each move. The world is made up. The decision loop is the demo.

## The pane

- **The board.** Walls have depth and rise in a ripple when a layout starts. Coins spin and pop.
  The goal is a star under a beam of light. The robot thinks, then hops, and leaves footsteps.
- **Jev's mind is on the board.** Around the tile Jev stood on there is one arrow for each move.
  The size of each arrow is the probability Jev gave that move, and the chosen one glows. A ring
  around the robot is tight and green when Jev is sure, wide and amber when it is torn.
- **Fog.** Jev only knows the walls it has seen. Dark floor is floor it has not seen yet. The dotted
  line is the way the step counts point. Over dark floor the dots turn amber, because that part is a
  guess. When the guess runs into a wall, you see Jev back out of the dead end.
- **The top bar** shows decisions per second, decisions made, and cost so far, next to the run,
  goals, coins, moves against the shortest way, and the score.
- **What Jev reads.** The rail shows the exact text Jev gets each move, with the grid and the step
  counts. The shared "Jev live mind" panel above it shows all four answers with their probabilities.
- **It never stops.** When a run ends there is a short banner for about three seconds. Then a fresh
  layout is built from the seed and the robot walks on from where it stands. Set `"remix": false`
  in `arena.json` to replay your own layout instead.

## Things you can do in the pane

| Do this | What happens |
|---|---|
| Click a tile (tool: wall) | Builds a wall, or breaks one. Jev replans on its next move. |
| Click a tile (tool: coin) | Drops a coin, or takes one away. Jev goes for the nearest coin first. |
| Drag the star | Moves the goal. |
| **Sight** slider | How many cells Jev can see. "all" means the whole board. |
| **Pace** slider | Time between decisions, 60 to 1000 ms. |
| **Walls** slider | Share of the board that is wall. Builds a fresh layout right away. |
| **New layout** | Builds a fresh layout from the seed right away. |
| Pause, Step, Reset | Stop the clock, take one decision, or start over from `arena.json`. |

The sliders are overrides for this session. An edit to `arena.json` resets them. If you wall the
goal in, Jev works that out, the banner says so, and a fresh layout follows.

## The honest dial: sight

Each move the viewer writes the board as text. It also writes how many steps each move would leave
to the nearest coin and to the goal, **counting floor Jev has not seen as open**. Jev picks the move.
With the whole board in sight the step counts are true and Jev walks the shortest way. With a short
sight the counts point through walls Jev has not met yet, so it walks into dead ends and has to come
back. Nothing random is added. The only thing that changes is how much Jev knows.

Measured with the offline stand-in, 2500 decisions each, 36% walls on an 18 by 12 board:

| sight | goals reached | score (shortest way / moves taken) | wasted steps per run |
|---|---|---|---|
| whole board | 39 | 1.000 | 0.0 |
| 1 cell | 31 | 0.801 | 15.4 |

## arena.json

```jsonc
{
  "title": "Jev Arena",
  "description": "A small living grid world. Jev decides every move.",
  "width": 18, "height": 12,        // 2 to 32 each. "size": 12 still works for a square board.
  "hero": { "x": 1, "y": 1 },
  "goal": { "x": 16, "y": 10 },
  "walls": [ { "x": 3, "y": 2 } ],
  "coins": [ { "x": 5, "y": 3 } ],
  "rules": "Collect the coins, then reach the star.",
  "speed": 300,                     // ms per decision, 60 to 2000
  "sight": 2,                       // cells Jev can see, 1 to 99. 99 means the whole board.
  "remix": true,                    // true: a fresh layout after each run. false: replay this one.
  "seed": 7                         // fresh layouts are built from this, so runs can be repeated
}
```

A bad edit never stops the demo. The viewer keeps the last good world and shows the error in the pane.

## Anatomy

```
jev-arena/
  harness.json            the manifest (engine: claude)
  AGENTS.md               tells the chat agent how to shape arenas worth watching
  skills/arena/SKILL.md   the design and checking craft
  template/arena.json     the starter world
  toolchain/
    jev.mjs               the Jev client (real TypeSafe API, or the offline stand-in)
    check.mjs             checks arena.json
    viewer.sh, setup.sh, doctor.sh, init-workspace.sh
  viewer/
    viewer.mjs            the loopback server and the decision loop
    sim.mjs               the world: layouts from a seed, what Jev has seen, the text Jev reads
    mock.mjs              the offline stand-in's reader. It reads only the text Jev gets.
    index.html, studio.css, studio.js, jev-hud.js   the pane
  test/viewer.test.mjs
```

The viewer calls `POST /v1/systemone` at TypeSafe when `TYPESAFE_API_KEY` is set. Without a key it
uses the offline stand-in, so everything runs offline and in tests, and the pane shows a `MOCK`
badge. It writes `.harness/verdict.json` itself.

Each call asks four questions at once: `move` (one of up, down, left, right, wait), `heading` (coin
or goal), `sure` (yes or no) and `boxed_in` (yes or no).

## Jev, honestly

Jev is new and in early access. Its headline claims (speed, calibration) mostly come from the
vendor. The offline stand-in here is for the plumbing, not for judgement: it reads the step counts
in the text and spreads probability over the moves. The viewer does the path counting and Jev
picks the move, so this demo shows a fast decision loop, not path planning. Try the real model on
your own data before you trust it for anything that matters.

## Credit and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness only calls the public API. It
  contains no TypeSafe code.
- **OpenHarness** (Autonomous) is MIT-licensed. This harness is MIT too (see `LICENSE`).
- **Autonomous** built this harness for the OpenHarness store.
