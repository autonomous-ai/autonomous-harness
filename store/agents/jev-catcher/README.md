# Jev Catcher

**Jev — TypeSafe's System One model — is the fielder.** Pop flies drop from the sky to random spots
on the outfield line; every tick Jev reads the glove's position and the next ball's landing spot and
slides the glove — LEFT / RIGHT, or a fast burst — to be under it when it lands. Be there and it's
an out; miss and the ball drops. Crank the falls faster than Jev can chase and the drops pile up.

This is a harness for OpenHarness. The agent on the right edits `catcher.json`; the viewer on the
left runs the field and asks Jev for each tick's slide, live. The decision loop is the show.

## Anatomy

```
jev-catcher/
  harness.json               # DSH manifest (engine: claude)
  AGENTS.md                  # tells the agent to build sessions with real decision loops
  skills/catcher/SKILL.md    # the fielding + verification craft
  template/catcher.json      # a starter session profile
  toolchain/
    jev.mjs                  # the Jev client (real TypeSafe API + deterministic mock), catcher-aware
    viewer.sh                # launches the viewer
    check.mjs                # validates catcher.json
    setup.sh / doctor.sh / init-workspace.sh
  viewer/                    # the loopback viewer server + pane (the outfield)
```

## The viewer

`viewer/viewer.mjs` runs the field over a loopback HTTP server. Each tick it drops every ball one
step, asks Jev for the slide, and streams one frame to the pane. It calls `POST /v1/systemone` when
`TYPESAFE_API_KEY` is set. Without a key, a deterministic stand-in reads the same line of text, so
the demo runs offline, and the pane shows a `MOCK` badge. `.harness/verdict.json` tracks caught,
dropped, and whether the session was clean. A finished session stays up about three seconds, then
a new one starts with a new seed.

**The pane** draws a ballpark at dusk at 60 fps and eases between Jev's decisions. Each fly leaves
the infield, climbs into the lights and comes down on a real arc. Its shadow shrinks on the grass
as it falls, and a dashed ring, as wide as the glove's reach, marks where it will land. The fielder
runs, raises the glove, and dives when the catch is a stretch. A dropped ball bounces and kicks up
dust. The scoreboard on the wall counts caught, drops and the streak. Jev's mind is in the scene:
five ghost gloves, one per option, as bright as their probability, and a small bar chart that rides
under the fielder. The top bar shows decisions per second, decisions, and cost so far.

**You can play with it:**

- **Fall time** and **Glove reach** sliders override `fallTicks` and `gloveReach` at once. The next
  edit to `catcher.json` clears them.
- **Click the grass** to pop an extra fly to that spot. With two balls up, Jev is told about both
  and goes for the one landing first.
- **Gust of wind** carries every ball in the air sideways for a few ticks, so the landing rings move.
- **Slow motion** stretches every tick three times.
- **Pause**, **Step** (one decision) and **Reset**.

Measured with the offline stand-in over 1,500 ticks: `fallTicks` 8 and up, every ball caught; 6,
94%; 5, 87%; 4, 77%; 3, 63%. The glove covers at most 1.2 slots a tick, so a short fall leaves a
far ball out of range. No randomness is added.

The field is synthetic: balls land at random spots near the glove, and Jev's "slide" is a
moment-to-moment line call — read the spot early, glide over, commit as it lands — which is why a
faster fall (more ground to cover in fewer ticks) makes Jev look stretched and drop.

## Jev, honestly

Jev's headline claim is speed — decide in a loop faster than a large model can. Catcher celebrates
that: a fielding decision on every tick. But the field, the pop flies and the timing are entirely
made up, and Jev catches nothing real — this is a demo of decision-rate and calibration on a
synthetic 1-D intercept problem, not a signal for real baseball, and the mock is a stand-in for
*plumbing*, not judgement. Treat any "session" as a fun experiment, not coaching advice.

## Credit and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness is an OpenHarness wrapper that
  only calls the public API; it contains no TypeSafe code.
- **OpenHarness** (Autonomous) is MIT-licensed; this wrapper is MIT too (see `LICENSE`).
- **You** (Autonomous) built this harness for OpenHarness's store.

_Show, don't tell: this harness makes a fast decision model a live outfielder — pop flies you can
watch Jev read, chase, and catch (or drop) with every tick._
