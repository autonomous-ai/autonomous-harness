# Jev Archer in OpenHarness

On the left, Jev Archer is a range: a target slides back and forth across a line, and **Jev —
TypeSafe's System One model — is the archer.** Every tick Jev reads the target's position and the
aim point, and nudges the aim left or right to track it. Every window the arrow releases along the
aim line. If the aim is on the target it is a bullseye; if the target ran past the aim, the arrow
flies by and the miss counts. The range is synthetic; the decision loop is the show.

On the right, you edit `archer.json`. This is the ONLY file you edit. It holds the session profile
— how fast the target slides, how precise the bullseye has to be, how many shots — and the viewer
watches it and Jev adapts immediately.

## The archer file

```jsonc
{
  "title": "Jev Archer",
  "description": "Jev is the archer — track the sliding target and plant every arrow in the bullseye.",
  "instrument": "ARCHER",
  "tickMs": 150,
  "speed": 0.6,
  "bullHalf": 1.0,
  "targetWidth": 24,
  "shots": 16,
  "style": "You are the archer. A target slides across the line — read its position and nudge your aim to track it, then release. Land the arrow in the bullseye to score; miss and it flies by. Keep your aim glued to the moving target."
}
```

- **`speed`** — how far the target slides (in slots) per tick. This is the difficulty dial. Calm
  (`0.4–0.6`) moves less than the aim can correct, so Jev stays on target and it is nearly a clean
  day; `1.2+` and the target runs away from the aim, the aim trails, and the arrows release
  off-center, so the misses pile up.
- **`bullHalf`** — half the bullseye width in slots: how close the aim must be to the target when
  the arrow releases to score. Tight (`0.4`) demands an exact read; wide (`1.5+`) is forgiving.
- **`targetWidth`** — the width of the range in slots (6–60). Wider = more travel for the target to
  build up speed off the rails.
- **`shots`** — how many arrows in the session (1–100). More = longer, more chances to miss.
- **`tickMs`** — how often the world updates (and Jev decides). Fast ticks = frantic aim; slow ticks
  = a relaxed range.
- **`style`** — the instruction to Jev. It should name an aiming strategy (track the target, read
  the direction early, lead the motion) so Jev *decides* rather than guesses.

## Your job

Design `archer.json` so the range is an event:

- **Curate the target speed with tension.** Default `speed` around `0.6` gives clean, readable
  bullseyes. Crank it to `1.2` and the target starts to run; that flip is the fun.
- **Precision by the bullseye.** A tight `bullHalf` makes Jev commit exactly on the read and miss
  when the target comes in hot; a wide one lets it recover and string clean days together.
- **Write a distinct style line.** "Hug the target, correct instantly" plays very differently from
  "read its direction early and lead the motion." Jev will visibly aim differently.

Do NOT just ship the template. Every `archer.json` you publish should be its own range with a
deliberate, testable difficulty.

Validate with `node "$JEV_DSH/toolchain/check.mjs"`. The real test is the aiming: does Jev plant the
full session on a slow target, and leak when you speed it up — or does it never leak (dull) or leak
even on a slow target (bad)? Either extreme is a finding to report, not a bug to mask.

## Rules

- Keep `archer.json` valid JSON always. A bad edit freezes the session on the last good state. You
  can change `speed`/`bullHalf`/`targetWidth`/`shots` live — the viewer rebuilds the range for the
  new profile.
- Keep `title`, `description` and `style` truthful — and never present this as a real contest, real
  scores, or real marksmanship.
- Jev is reached through `toolchain/jev.mjs`. You can call it directly to ask Jev's read before you
  commit to it (e.g. "which way does Jev aim with the target at 18 and the aim at 14?"). Use the
  `jev` helpers: `noul`, `choice`, `score`.
- Without a `TYPESAFE_API_KEY`, Jev runs on a deterministic local mock that still reads the range and
  lines up on the target — so the demo runs offline. With a key, the viewer calls the real API.
- The Jev Archer viewer writes `.harness/verdict.json` itself (bullseyes, misses, whether the session
  was a clean day). Do not edit it.
- This is a demo. The range, the target and the timing are made up — never present this as a real
  contest or real marksmanship.

## Definition of done

- A valid `archer.json` that parses and passes `toolchain/check.mjs`.
- A session with a real decision loop: Jev reads the target, tracks it with the aim, plants the slow
  ones, and leaks them once the target is too fast.
- The speed and bullseye actually shape the session — report it if Jev never misses, or misses no
  matter what.
