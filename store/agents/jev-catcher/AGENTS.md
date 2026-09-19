# Jev Catcher in OpenHarness

On the left, Jev Catcher is an outfield: a ball pops up overhead and falls to a spot on the line,
and **Jev — TypeSafe's System One model — is the fielder.** Every tick Jev reads the glove's
position and the next ball's landing spot, and slides the glove left or right to be under it when it
lands. Get there in time and it is an out; miss and it drops. The field is synthetic; the decision
loop is the show.

On the right, you edit `catcher.json`. This is the ONLY file you edit. It holds the session profile
— how fast the balls fall, how precise the catch has to be, how long the session — and the viewer
watches it and Jev adapts immediately.

## The catcher file

```jsonc
{
  "title": "Jev Catcher",
  "description": "Jev is the fielder — slide the glove and catch every pop fly.",
  "instrument": "CATCHER",
  "tickMs": 140,
  "fallTicks": 10,
  "gloveReach": 1.6,
  "fieldWidth": 24,
  "balls": 14,
  "style": "You are the fielder. A ball pops up and falls to a spot on the line — slide the glove to be right under it when it lands. Get there in time and it is an out; miss and it drops. Be decisive, read the landing spot early."
}
```

- **`fallTicks`** — how many ticks a ball takes to come down. This is the difficulty dial. Calm
  (`12–14`) gives Jev time to cross the field and it catches everything; `7` and below the ball
  drops faster than Jev can get there, and the drops pile up.
- **`gloveReach`** — how close the glove must be to the landing spot to make the catch. Tight
  (`0.5`) demands an exact read; wide (`2.5+`) is forgiving.
- **`fieldWidth`** — the width of the field in slots (6–60). Wider = more ground to cover.
- **`balls`** — how many pop flies in the session (1–100). More = longer, more chances to drop.
- **`tickMs`** — how often the world updates (and Jev decides). Fast ticks = frantic fielding; slow
  ticks = a relaxed session.
- **`style`** — the instruction to Jev. It should name a fielding strategy (read the spot early,
  glide, commit at the catch) so Jev *decides* rather than guesses.

## Your job

Design `catcher.json` so the session is an event:

- **Curate the fall with tension.** Default `fallTicks` around `10` gives clean, readable catches.
  Crank it to `7` and Jev starts to leak; that flip is the fun.
- **Precision by reach.** A tight `gloveReach` makes Jev commit exactly on the read and miss when
  the ball comes in hot; a wide one lets it recover.
- **Write a distinct style line.** "Read the sound off the bat and burst to the spot" plays very
  differently from "glide — never sprint, always keep some glide in reserve." Jev will visibly field
  differently.

Do NOT just ship the template. Every `catcher.json` you publish should be its own session with a
deliberate, testable difficulty.

Validate with `node "$JEV_DSH/toolchain/check.mjs"`. The real test is the fielding: does Jev catch
the full session at a calm fall, and leak when you speed the falls up — or does it never leak (dull)
or leak even on a slow pop (bad)? Either extreme is a finding to report, not a bug to mask.

## Rules

- Keep `catcher.json` valid JSON always. A bad edit freezes the session on the last good state. You
  can change `fallTicks`/`gloveReach`/`fieldWidth`/`balls` live — the viewer rebuilds the field for
  the new profile.
- Keep `title`, `description` and `style` truthful — and never present this as a real ballgame,
  real stats, or real coaching.
- Jev is reached through `toolchain/jev.mjs`. You can call it directly to ask Jev's read before you
  commit to it (e.g. "which way does Jev slide with 2 ticks to the catch?"). Use the `jev` helpers:
  `noul`, `choice`, `score`.
- Without a `TYPESAFE_API_KEY`, Jev runs on a deterministic local mock that still reads the field
  and lines up on the landing spot — so the demo runs offline. With a key, the viewer calls the real
  API.
- The Jev Catcher viewer writes `.harness/verdict.json` itself (caught, dropped, whether the session
  was clean). Do not edit it.
- This is a demo. The field, the pop flies and the timing are made up — never present this as a real
  game or real coaching.

## Definition of done

- A valid `catcher.json` that parses and passes `toolchain/check.mjs`.
- A session with a real decision loop: Jev reads the landing spot, slides to it, catches the slow
  ones, and leaks them once the falls are too fast.
- The fall and reach actually shape the session — report it if Jev never drops, or drops no matter
  what.
