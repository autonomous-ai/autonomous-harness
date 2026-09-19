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
down the valley, asks Jev for the steer, and streams one frame to the pane. It calls
`POST /v1/systemone` when `TYPESAFE_API_KEY` is set. Without a key, a deterministic stand-in reads
the same lines of text, so the demo runs offline, and the pane shows a `MOCK` badge.
`.harness/verdict.json` tracks ticks carved, gates threaded, and any fall. A finished run stays up
about three seconds, then a new one starts with a new seed.

**The pane** draws a snowy slope from above at 60 fps and eases between Jev's decisions. The camera
follows the skier down past two layers of pines that slide by at different speeds. The skis carve
two lines that stay on the snow, turns throw spray, and snow drifts across the view. Each gate
flashes green when it is threaded and red, with a bent pole, when it is clipped. A clean run coasts
under a finish banner into confetti; a fall throws the skis off in a cloud of snow. Jev's mind is in
the scene: a fan of five predicted paths, one per option, as bold as their probability, with the
chosen one glowing. The top bar shows decisions per second, decisions, and cost so far.

**You can play with it:**

- **Speed** and **Gate gap** sliders override `speed` and `gateGap` at once. The gap slider re-cuts
  every gate still ahead. The next edit to `slalom.json` clears them.
- **Click the snow ahead** of the skier to plant an extra gate there. It must be at least 5 rows
  ahead and 5 rows from another gate.
- **Gust of wind** shoves the skier sideways for a few ticks. Jev has to steer back.
- **Slow motion** stretches every tick three times.
- **Pause**, **Step** (one decision) and **Reset**.

Measured with the offline stand-in over 1,500 ticks on the 18-gate template: `speed` 1.2 to 2.6,
every run clean; 3.0 and 3.6, every run falls at the second gate; 4.4, every run falls at the
first. It is a cliff, not a slope: the skier moves at most 1.9 slots sideways a tick, and past
about 2.8 rows a tick there are not enough ticks between gates to cross the valley. No randomness
is added.

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
