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

`viewer/viewer.mjs` runs the field over a loopback HTTP server. Each tick it drops a ball one step,
asks Jev for the slide, and streams the session — the glove sliding along the grass, the ball arcing
down to its landing spot (lighting up amber as an out), and a session log — to the pane. It calls
`POST /v1/systemone` when `TYPESAFE_API_KEY` is set; without it a deterministic mock reads the same
field and lines up on the landing spot, so the demo runs offline. `.harness/verdict.json` tracks
caught, dropped, and whether the session was clean.

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
