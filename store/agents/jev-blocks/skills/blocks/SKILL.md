---
name: jev-blocks
description: Design a falling-blocks challenge for Jev in blocks.json (gravity, speedup, garbage, a custom board, the piece mix, the style line), then read the verdict and report where Jev starts to break.
---

# Craft: a Jev Blocks challenge

Jev places every piece of a falling-blocks puzzle with one call. The craft is to set up a game that
shows a real decision loop under a real limit, then to find the point where the limit wins.

## The decision loop

For each new piece the viewer builds one state text:

- the `style` line,
- the well as 20 ASCII rows (`#` filled, `.` empty),
- column heights, holes, bumpiness and the deepest well,
- the current piece and the next three,
- level, lines, gravity, and what a decision and a move cost,
- a table of every legal placement. The id is `r<rotation>c<leftmost column>`, for example `r1c4`.

Then it asks three questions in the same call:

| id | type | what it asks |
|---|---|---|
| `place` | choice | one option per placement. Each option's description is a short fact line: lines cleared, holes, column heights, max height, bumpiness, wells, moves needed |
| `danger` | score, 4 levels | how close the stack is to topping out |
| `go_for_four` | noul | is it worth keeping a column open for an I piece |

Questions cannot see each other. Shared facts live in the state text.

## The honest limit

Time. The piece falls at `gravity x (1 + speedup x (level - 1))` rows per second. A decision costs
`decisionMs`. Each rotate or shift costs `moveMs`. The piece falls the whole time. When it lands, it
locks, even if it has not reached the chosen column. The pane marks that as `TOO SLOW` and counts it
under `MISSED`.

A rough rule: a placement needs `decisionMs + (moves + 1) x moveMs`. The fall gives
`free rows / gravity` seconds. With 110 ms and 35 ms, a wall placement (about 6 moves) needs about
355 ms. On an empty well that fits up to about 46 rows per second. On a stack 8 rows high it only
fits up to about 28. So height and gravity work together, and garbage makes speed bite sooner.

## Knobs and what they do

```jsonc
{
  "gravity": 2,        // 0.2 to 40. The starting speed.
  "speedup": 0.5,      // 0 to 2. 0 keeps gravity fixed, which is best for a clean comparison.
  "decisionMs": 110,   // 30 to 1000. Raise it to play a slower model.
  "moveMs": 35,        // 5 to 500.
  "garbageRows": 0,    // 0 to 12.
  "weights": { "I": 1, "O": 1, "T": 1, "S": 1, "Z": 1, "J": 1, "L": 1 },
  "board": [],         // up to 20 rows of 10 characters, '.' or '#', top row first
  "style": "Keep the stack low and flat. Go for four when it is safe."
}
```

Ideas that make a good challenge:

- **Speed test.** `speedup: 0`, then try gravity 10, 25, 40. Add `garbageRows: 8` so 40 really bites.
- **Slow thinker.** Keep gravity at 12 and set `decisionMs` to 300, then 700. Watch the misses start.
- **Dig-out.** `garbageRows: 10`, low gravity, a style line that says dig first.
- **Cruel mix.** `"weights": { "S": 1, "Z": 1 }`, or drop the I piece and see what `go_for_four` says.
- **Set piece.** Draw a board that is one I piece from four lines and see if Jev takes it.

## How to find the breaking point

1. Fix the seed and set `speedup` to 0.
2. Change one knob, save, let the game run for a minute or so.
3. Read `.harness/verdict.json`. Look at the summary line and the `timing` finding
   (`N of the last 50 pieces landed short of their target at G rows/s`) and the `topout` finding.
4. Move the knob and repeat. Report the last setting that played clean and the first that did not.

## Checking

```bash
node "$JEV_DSH/toolchain/check.mjs"
```

It prints `ok` or one `error` line per problem: a number out of range, weights that are all zero, a
board row that is not 10 characters of `.` and `#`.

## Honesty

- The game is synthetic. The score means nothing outside this pane.
- Without an API key the pane says `MOCK`. The offline reader is a fixed heuristic. It shows that the
  plumbing works. It does not show how well live Jev plays. Say which one you measured.
- Never edit `.harness/verdict.json`, and never tell the person to open a browser or start a server.
