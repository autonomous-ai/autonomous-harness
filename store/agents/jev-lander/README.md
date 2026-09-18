# Jev Lander

**Jev — TypeSafe's System One model — is the flight computer.** A booster drops out of the sky under
gravity; every tick Jev reads altitude, vertical speed and fuel, sets a throttle — CUT / COAST /
HOVER / BURN — and flies it down to the pad. Touch down slow and it's a clean landing; hit hard and
the booster is scrap. Crank the gravity up and Jev's burns go twitchy and landings start to crash.

This is a harness for OpenHarness. The agent on the right edits `lander.json`; the viewer on the
left runs the landing and asks Jev for each tick's throttle, live. The decision loop is the show.

## Anatomy

```
jev-lander/
  harness.json              # DSH manifest (engine: claude)
  AGENTS.md                 # tells the agent to build missions with real decision loops
  skills/lander/SKILL.md    # the landing-design + verification craft
  template/lander.json      # a starter mission profile
  toolchain/
    jev.mjs                 # the Jev client (real TypeSafe API + deterministic mock), lander-aware
    viewer.sh               # launches the viewer
    check.mjs               # validates lander.json
    setup.sh / doctor.sh / init-workspace.sh
  viewer/                   # the loopback viewer server + pane (the landing pad)
```

## The viewer

`viewer/viewer.mjs` runs the landing over a loopback HTTP server. Each tick it integrates the
booster (throttle − gravity, plus a touch of drag), asks Jev for the throttle, and streams the
descent — the rocket on its trajectory, a flame plume that scales with the throttle, live
altitude / speed / fuel readouts, and a decision log — to the pane. It calls `POST /v1/systemone`
when `TYPESAFE_API_KEY` is set; without it a deterministic mock reads the same telemetry and picks a
sensible throttle, so the demo runs offline. `.harness/verdict.json` tracks ticks flown, the throttle
choices, and the landing outcome.

The physics is synthetic: the booster falls under a set `gravity` (per-tick acceleration), and the
throttles add upward acceleration. Jev's "throttle" is a moment-to-moment control call — burn to
arrest the fall, ease off to land soft — which is why high gravity makes Jev look twitchy and crash.

## Jev, honestly

Jev's headline claim is speed — decide in a loop faster than a large model can. Lander celebrates
that: a control decision on every tick. But the rocket, the physics and the telemetry are entirely
made up, and Jev flies nothing real — this is a demo of decision-rate and calibration on a synthetic
control problem, not a signal for real rocketry, and the mock is a stand-in for *plumbing*, not
judgement. Treat any "landing" as a fun experiment, not engineering advice.

## Credit and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness is an OpenHarness wrapper that
  only calls the public API; it contains no TypeSafe code.
- **OpenHarness** (Autonomous) is MIT-licensed; this wrapper is MIT too (see `LICENSE`).
- **You** (Autonomous) built this harness for OpenHarness's store.

_Show, don't tell: this harness makes a fast decision model a live flight computer — a landing pad
you can watch Jev fly, judge, and bring down soft with every tick._
