# Jev Blocks

**Jev, TypeSafe's System One model, plays a falling-blocks puzzle, live.** For every new piece the
viewer lists every legal placement (each rotation in each column, 9 to 34 of them) and asks Jev
**one call**. Jev answers three questions at once: which placement to take, with a probability for
every option; how close the stack is to the top; and whether it is worth keeping a column open to
clear four lines at once. The pane draws those probabilities on the board as ghosts, so you can see
the whole decision, not just the move.

This is a harness for OpenHarness. The agent on the right edits `blocks.json`. The viewer on the
left runs the game and reacts to every edit.

It is a demo. The game, the pieces and the scores are made up. Nothing here is a benchmark.

## The honest dial is time

The piece really falls, at `gravity` rows per second. Gravity rises with the level. A decision costs
`decisionMs` (110 ms by default, about what a live Jev call takes). After that the piece still has
to be moved, and each rotate or shift costs `moveMs` (35 ms). If the piece lands before it reaches
the chosen column, it locks where it is.

So at low gravity Jev plays clean for a long time. As gravity climbs, far placements stop fitting
into the fall, pieces land short, holes appear and the stack tops out. There is no injected
randomness. With the default costs the break comes near 46 rows per second on a low stack, and
sooner when the stack is high. Raise `decisionMs` to see what a slower model would do.

Measured with the offline stand-in, 300 pieces, 8 starting garbage rows, no speedup:

| gravity | lines | missed placements | top-outs |
|---|---|---|---|
| 1 row/s | about 125 | 0 | 0 |
| 40 rows/s | about 49 | about 125 | about 28 |

## The pane

- A 10 by 20 well with a next queue of three, score, level, lines, lines per minute and pieces.
- **Jev's mind on the board**: every placement Jev weighed is a ghost, brighter when more likely.
  The chosen one is outlined. The top three carry their probability.
- A danger meter (the `danger` score), a "going for four" light (the `go_for_four` yes/no) and a
  time budget that shows the time a move needs next to the time the fall allows.
- The top bar shows lines, lines per minute, decisions per second, cost so far, pieces and best.

You can play with it:

- Drag **Gravity** to pin the falling speed. Drag **Think time** to make each decision cost more.
- **Drop garbage** pushes a garbage row up from the floor.
- Click a **column** to drop a junk block there. Click a **next piece** to change it.
- **Mind** shows or hides the ghosts. **Slow-mo** runs the clock at quarter speed.
- **Pause**, **Step** (one decision at a time) and **Reset**.

Changes made in the pane last until `blocks.json` is edited.

## Anatomy

```
jev-blocks/
  harness.json               manifest (engine: claude)
  AGENTS.md                  what the chat agent does
  skills/blocks/SKILL.md     how to design a challenge and read the result
  template/blocks.json       the starter challenge
  toolchain/
    jev.mjs                  Jev client: real TypeSafe API, or a deterministic mock without a key
    check.mjs                validates blocks.json
    viewer.sh setup.sh doctor.sh init-workspace.sh
  viewer/
    viewer.mjs               the game loop and the loopback server
    game.mjs                 rules, placements, the state text, the offline reader
    kit.mjs                  loopback server, config watcher, verdict writer
    studio.js studio.css index.html base.css jev-hud.js
  test/viewer.test.mjs
```

## Jev, honestly

With `TYPESAFE_API_KEY` set, the viewer calls `POST /v1/systemone` and charges the real latency
against the fall. Without a key it uses a deterministic offline reader. That reader gets only the
state text and the option descriptions, the same words live Jev gets, and scores each placement with
a well-known stack heuristic. It is a stand-in for the plumbing, not for Jev's judgement, and the
pane badges it `MOCK`. The cost shown is what live Jev would charge for the same tokens.

## Credit and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness only calls the public API. It
  contains no TypeSafe code.
- **OpenHarness** (Autonomous) is MIT-licensed. This harness is MIT too (see `LICENSE`).
- The falling-blocks rules here are a plain, generic version written for this demo. The harness is
  not linked to any game publisher.
- Built by Autonomous for the OpenHarness store.
