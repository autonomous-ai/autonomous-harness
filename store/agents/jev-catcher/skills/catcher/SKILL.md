---
name: catcher
description: Shape a Jev Catcher session (fall time, glove reach, field width), then verify Jev catches the slow pop flies and drops the fast ones.
---

# Catching the field

The skill for building `catcher.json` pieces. On the left, Jev is the fielder guarding the outfield:
balls pop up at random spots and fall, and every tick Jev reads the glove's position and the next
ball's landing spot and slides the glove to catch it. A catch needs the glove under the ball when it
lands **within reach** of the landing spot; otherwise the ball drops.

The difficulty **falls** to two dials:

- **`fallTicks`** — how many ticks a ball takes to come down. This is the main dial. Fewer ticks
  means the ball drops faster, leaving Jev less time to cross the field — so at low `fallTicks` Jev
  physically can't get there in time and the drops pile up.
- **`gloveReach`** — how close the glove must be to the landing spot to make the catch (the reach
  radius). Tighter reach means Jev has to be precise, not just near.

Crank `fallTicks` down (or shrink `gloveReach`) and Jev's glove can't keep up and it leaks balls;
the honest physical slew limit is the difficulty, not random noise. This is the general recipe for
this harness: **make the ball fall too fast to chase, and Jev's misses read as Jev's limit.**

## Craft

- **Curate a catching mood.** Default `fallTicks` ~`10` (reach `1.6`) is crisp and frequently clean.
  Drop `fallTicks` to `7` and Jev leaks; to `5` or below it's a rain of drops. Raise `fallTicks` to
  `13+` for a leisurely, near-perfect session.
- **Tension by reach.** A tight `gloveReach` (`0.5`, say) makes Jev read the landing spot *exactly*
  — it starts to miss when the ball comes in hot. A wide one is forgiving.
- **Write a distinct style line.** "Read the sound off the bat and burst to the spot" plays very
  differently from "glide, don't sprint — always keep some glide in reserve." Jev will visibly
  field differently.

Do NOT just ship the template. Every `catcher.json` you publish should be its own session with a
deliberate, testable difficulty.

Validate with `node "$JEV_DSH/toolchain/check.mjs"`. The real test is the fielding: does Jev catch
the full session at a calm fall, and leak when you speed the falls up — or does it never leak (dull)
or leak even on a slow pop (bad)? Either extreme is a finding to report, not a bug to mask.

## Rules

- Keep `catcher.json` valid JSON always. A bad edit freezes the session on the last good state. You
  can change `fallTicks`/`gloveReach`/`fieldWidth`/`balls` live — the viewer rebuilds the field for
  the new profile.
- Keep `title`, `description` and `style` truthful — and never present this as real baseball, real
  stats, or real coaching.
- The catcher viewer writes `.harness/verdict.json` itself (caught, dropped, whether the session was
  clean). Do not edit it.
- This is a demo. The field, the pop flies and the timing are made up — never present this as a real
  game or real fielding advice.

## Definition of done

- A valid `catcher.json` that parses and passes `toolchain/check.mjs`.
- A real fielding loop: Jev reads the landing spot, slides to it, catches the slow ones, and leaks
  them once the falls are too fast.
- The fall and reach actually shape the session — report it if Jev never drops, or drops no matter
  what.
