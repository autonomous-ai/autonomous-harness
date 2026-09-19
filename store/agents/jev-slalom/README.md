# Jev Slalom

**Jev — TypeSafe's System One model — is the racer.** A line of gates sweeps down a valley; every
tick Jev reads its position and the next gate and steers — LEFT / RIGHT, or a FAST commit — to
thread each gap as it arrives. Clip a gate or hit the wall and the run is over. Crank the descent
speed up and Jev's aim starts to wobble and it falls.

This is a harness for OpenHarness. The agent on the right edits `slalom.json`; the viewer on the
left runs the course and asks Jev for each tick's steer, live. The decision loop is the show.

## Anatomy

```
jev-slalom/
  harness.json               # DSH manifest (engine: claude)
  AGENTS.md                  # tells the agent to build courses with real decision loops
  skills/slalom/SKILL.md     # the course-design + verification craft
  template/slalom.json       # a starter run profile
  toolchain/
    jev.mjs                  # the Jev client (real TypeSafe API + deterministic mock), slalom-aware
    viewer.sh                # launches the viewer
    check.mjs                # validates slalom.json
    setup.sh / doctor.sh / init-workspace.sh
  viewer/                    # the loopback viewer server + pane (the course)
```

## The viewer

`viewer/viewer.mjs` runs the course over a loopback HTTP server. Each tick it advances the skier
down the valley, asks Jev for the steer, and streams the run — the skier's x and snow trail, the
gates sweeping toward it (lighting up as they're threaded), a dashed line to the target gate, and a
run log — to the pane. It calls `POST /v1/systemone` when `TYPESAFE_API_KEY` is set; without it a
deterministic mock reads the same course and lines up on the next gate, so the demo runs offline.
`.harness/verdict.json` tracks ticks carved, gates threaded, and any fall.

The course is synthetic: gates alternate sides of a valley, and the skier descends at a fixed
`speed`. Jev's "steer" is a moment-to-moment line call — line up on the gate, commit as it arrives —
which is why high speed makes Jev look wobbly and fall.

## Jev, honestly

Jev's headline claim is speed — decide in a loop faster than a large model can. Slalom celebrates
that: a steering decision on every tick. But the skier, the course and the timing are entirely made
up, and Jev races nothing real — this is a demo of decision-rate and calibration on a synthetic
line-following problem, not a signal for real racing, and the mock is a stand-in for *plumbing*, not
judgement. Treat any "run" as a fun experiment, not coaching advice.

## Credit and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness is an OpenHarness wrapper that
  only calls the public API; it contains no TypeSafe code.
- **OpenHarness** (Autonomous) is MIT-licensed; this wrapper is MIT too (see `LICENSE`).
- **You** (Autonomous) built this harness for OpenHarness's store.

_Show, don't tell: this harness makes a fast decision model a live slalom racer — a course you can
watch Jev carve, judge, and thread with every tick._
