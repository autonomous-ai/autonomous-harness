# Jev Archer

**Jev — TypeSafe's System One model — is the archer.** A target slides back and forth across the
line; every tick Jev reads the target's position and the aim point and nudges the aim — LEFT /
RIGHT — to track it, releasing an arrow each window. Land the arrow where the target is and it's a
bullseye; let the target run past the aim and the arrow flies by, counting a miss. Speed the target
up faster than Jev's aim can correct and the misses pile up.

This is a harness for OpenHarness. The agent on the right edits `archer.json`; the viewer on the
left runs the range and asks Jev for each tick's aim, live. The decision loop is the show.

## Anatomy

```
jev-archer/
  harness.json               # DSH manifest (engine: claude)
  AGENTS.md                  # tells the agent to build sessions with real decision loops
  skills/archer/SKILL.md     # the aiming + verification craft
  template/archer.json       # a starter session profile
  toolchain/
    jev.mjs                  # the Jev client (real TypeSafe API + deterministic mock), archer-aware
    viewer.sh                # launches the viewer
    check.mjs                # validates archer.json
    setup.sh / doctor.sh / init-workspace.sh
  viewer/                    # the loopback viewer server + pane (the range)
```

## The viewer

`viewer/viewer.mjs` runs the range over a loopback HTTP server. Each tick it slides the target one
step, asks Jev for the aim, and streams the session — the target sliding on its wire, Jev's crosshair
aim tracking it, arrows releasing to the aim line (lighting the bullseye on a hit, flying past on a
miss), and a session log — to the pane. It calls `POST /v1/systemone` when `TYPESAFE_API_KEY` is
set; without it a deterministic mock reads the same range and lines up on the target, so the demo
runs offline. `.harness/verdict.json` tracks bullseyes, misses, and whether the session was a clean
day.

The range is synthetic: the target slides at a set speed and Jev's "aim" is a moment-to-moment line
call — read the target, track it, release — which is why a faster target (more drift than the aim can
correct in one tick) makes Jev trail and miss.

## Jev, honestly

Jev's headline claim is speed — decide in a loop faster than a large model can. Archer celebrates
that: an aiming decision on every tick. But the range, the target and the timing are entirely made
up, and Jev plants no real arrow — this is a demo of decision-rate and calibration on a synthetic
1-D tracking problem, not a signal for real archery, and the mock is a stand-in for *plumbing*, not
judgement. Treat any "session" as a fun experiment, not marksmanship.

## Credit and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness is an OpenHarness wrapper that
  only calls the public API; it contains no TypeSafe code.
- **OpenHarness** (Autonomous) is MIT-licensed; this wrapper is MIT too (see `LICENSE`).
- **You** (Autonomous) built this harness for OpenHarness's store.

_Show, don't tell: this harness makes a fast decision model a live archer — a sliding target you can
watch Jev read, track, and plant (or miss) with every tick._
