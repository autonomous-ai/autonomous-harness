# Jev Blocks in OpenHarness

On the left is a live falling-blocks puzzle. **Jev, TypeSafe's System One model, plays it.** For each
new piece the viewer lists every legal placement and asks Jev one call with three questions:
`place` (a choice over the placements, with a probability for each), `danger` (how close the stack is
to the top) and `go_for_four` (is it worth keeping a column open for an I piece). The pane draws the
probabilities on the board.

On the right is you. **Your job is to design the challenge.** You edit `blocks.json`. It is the ONLY
file you edit. The viewer watches it and starts a new game on every valid edit.

The game is made up. It is a demo of a fast decision loop, not a benchmark and not a real contest.

## The challenge file

```jsonc
{
  "title": "Jev Blocks",
  "description": "One line about this challenge.",
  "seed": 7,               // same seed, same piece order
  "gravity": 2,            // rows per second at level 1. 0.2 to 40
  "speedup": 0.5,          // extra gravity per level, as a share of the start. 0 to 2
  "decisionMs": 110,       // what one decision costs. 30 to 1000
  "moveMs": 35,            // what one rotate or shift costs. 5 to 500
  "garbageRows": 0,        // garbage rows at the start, one gap each. 0 to 12
  "weights": { "I": 1, "O": 1, "T": 1, "S": 1, "Z": 1, "J": 1, "L": 1 },   // piece mix, whole numbers 0 to 9
  "board": [],             // optional start board, top row first, 10 characters per row, '.' or '#'
  "style": "How Jev should play, in plain words."
}
```

- **`gravity` and `speedup`** set how fast the piece falls: `gravity x (1 + speedup x (level - 1))`
  rows per second. The level goes up every 10 lines.
- **`decisionMs` and `moveMs`** are the cost of thinking and of moving. The piece keeps falling while
  they pass. This is the honest limit. If the piece lands before it reaches the chosen column, it
  locks where it is. With the defaults the break comes near 46 rows per second on a low stack, and
  earlier on a high stack. A slower thinker (`decisionMs` 300 to 1000) breaks much sooner.
- **`garbageRows`** and **`board`** set the start. A board is drawn as rows of `.` and `#`, top row
  first, and sits on the floor. Example, one I piece away from four lines:

  ```json
  "board": ["#########.", "#########.", "#########.", "#########."]
  ```
- **`weights`** is the piece mix. Each piece gets that many copies in every shuffled bag.
  `{ "S": 1, "Z": 1 }` is an S and Z only nightmare. Missing pieces count as 0.
- **`style`** is the instruction Jev reads at the top of every call. Say how to play: keep it flat,
  dig out the garbage first, go for four lines, play safe and clear single lines.

## What to do

1. Ask what kind of challenge the person wants, or pick one: a speed test, a dig-out, a cruel piece
   mix, a hand-drawn board.
2. Edit `blocks.json`. Keep it valid JSON. Run `node "$JEV_DSH/toolchain/check.mjs"` in the
   workspace. Fix every `error` line.
3. Read `.harness/verdict.json` after the game has run for a while. It has the lines, the level,
   the gravity, how many of the last 50 pieces landed short of their target, and the top-outs.
4. **Report where Jev starts to break.** Give the numbers: at what gravity placements start to
   miss, how many lines a game lasts, and what you changed. If Jev never breaks, say so and make it
   harder. If it breaks at once, say so and ease off. Both are findings, not bugs to hide.

Change one thing at a time when you hunt for the breaking point. The same seed gives the same piece
order, so two runs can be compared.

## Rules

- Edit only `blocks.json`. Do not edit `.harness/verdict.json`. The viewer writes it.
- The pane on the left is already running. Never suggest opening a browser, changing a port, or
  starting another server. The person already sees the pane.
- A bad JSON edit does not stop the game. The viewer keeps the last good file and shows the error in
  the pane. Fix the file.
- The person can also change things in the pane (gravity, think time, garbage, junk blocks, the next
  pieces). Those changes are cleared when you edit `blocks.json`.
- Without `TYPESAFE_API_KEY` the viewer uses a deterministic offline reader and the pane says
  `MOCK`. It reads the same state text and option descriptions as live Jev, and only picks up a few
  words from `style` (such as "four"). Live Jev reads the whole line. Say which one produced the
  numbers you report.
- You may call Jev yourself through `toolchain/jev.mjs` (`evaluate`, with `jev.choice`, `jev.noul`,
  `jev.score`) to try a question before you rely on it.
- Keep `title`, `description` and `style` truthful. Never present this as a real game title, a real
  tournament, or a measure of anything beyond this demo.

## Definition of done

- `blocks.json` is valid and passes `toolchain/check.mjs`.
- The challenge has a clear idea behind it, and the numbers in the file match that idea.
- You have told the person where Jev starts to break, with numbers from the verdict.
