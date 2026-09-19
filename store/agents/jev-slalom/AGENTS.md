# Jev Slalom in OpenHarness

On the left, Jev Slalom is a course: a line of gates sweeps down a valley, and **Jev — TypeSafe's
System One model — is the racer.** Every tick Jev reads its position and the next gate, and steers
left or right to thread each gap. Clip a gate or hit the wall and the run is over. The course is
synthetic; the decision loop is the show.

On the right, you edit `slalom.json`. This is the ONLY file you edit. It holds the run profile — the
descent speed, the valley width, how many gates — and the viewer watches it and Jev adapts
immediately.

## The slalom file

```jsonc
{
  "title": "Jev Slalom",
  "description": "Jev is the racer — carve a slalom line and thread every gate.",
  "instrument": "SLALOM",
  "tickMs": 160,
  "speed": 2.2,
  "gates": 18,
  "valleyWidth": 18,
  "style": "You are skiing the slalom. A line of gates sweeps toward you as you descend — steer left and right to thread each gap, lining up early and committing as each gate arrives. Clip a gate or hit the wall and you fall. Clean, decisive turns win the run."
}
```

- **`speed`** — how many course-rows the skier descends per tick. This is the difficulty dial.
  Calm (`1.6`) gives Jev time to line up and it threads everything; high (`3.0+`) makes the gates
  arrive so fast Jev's aim wobbles and it clips a gate and falls.
- **`gates`** — how many gates in the run (2–60). More gates = a longer run with more chances to
  fall and a bigger payoff for a clean line.
- **`valleyWidth`** — the width of the course in slots (6–60). Wider = more room to swing; narrower
  = the skier rides closer to the walls.
- **`gateGap`** — optional. The space between the two poles of a gate, in slots (2–10). Leave it
  out and the course cuts its usual gap (about a third of the valley, at most 6). Smaller = Jev has
  to be more exact.
- **`tickMs`** — how often the world updates (and Jev decides). Fast ticks = frantic carving; slow
  ticks = a contemplative descent.
- **`style`** — the instruction to Jev. It should name a line strategy (line up early, commit, hug
  the apex) so Jev *decides* rather than guesses.

## Your job

Design `slalom.json` so the run is an event:

- **Curate a course with tension.** Default `speed` around `2.0–2.4` gives clean, readable carving.
  Crank it to `3+` and Jev starts to wobble and fall — that flip is the fun.
- **Pick a run length.** Short runs (10 gates) are over almost instantly; longer ones (24+) give Jev
  time to build a rhythm and more chances to fall.
- **Write a distinct style line.** "Line up early and commit" plays very differently from "sweep
  wide and drift through" — and Jev will visibly carve differently.

Do NOT just ship the template. Every `slalom.json` you publish should be its own run with a
deliberate, testable course.

Validate with `node "$JEV_DSH/toolchain/check.mjs"`. The real test is the run: does Jev thread every
gate at the speed you set, and fall when you crank it up — or does it never fall (dull) or fall even
at calm speed (bad)? Either extreme is a finding to report, not a bug to mask.

## Rules

- Keep `slalom.json` valid JSON always. A bad edit freezes the run on the last good state. You can
  change `speed`/`gates`/`valleyWidth`/`gateGap` live — the viewer rebuilds the course for the new profile.
- Keep `title`, `description` and `style` truthful — and never present this as a real ski event,
  real race timing, or real coaching.
- Jev is reached through `toolchain/jev.mjs`. You can call it directly to ask Jev's read before you
  commit to it (e.g. "which way does Jev steer with 2 ticks to the gate?"). Use the `jev` helpers:
  `noul`, `choice`, `score`.
- Without a `TYPESAFE_API_KEY`, Jev runs on a deterministic local mock that still reads the course
  and lines up on the next gate — so the demo runs offline. With a key, the viewer calls the real
  API.
- The Jev Slalom viewer writes `.harness/verdict.json` itself (ticks carved, gates threaded, any
  fall). Do not edit it.
- This is a demo. The skier, the course and the timing are made up — never present this as a real
  race or real coaching.

## Definition of done

- A valid `slalom.json` that parses and passes `toolchain/check.mjs`.
- A course with a real decision loop: Jev reads the next gate, steers to thread it, and on a calm
  run carves a clean line — and falls when speed is cranked up.
- The speed and style actually shape the line — report it if Jev never falls, or falls no matter
  what.
