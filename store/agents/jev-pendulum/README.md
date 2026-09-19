# Jev Pendulum

**Jev — TypeSafe's System One model — is a live balancing act.** A stiff rod stands upright on a
pivot; every tick Jev reads the lean and the swing and picks a corrective torque to keep it from
toppling. You tune the rig — gravity, gust strength, torque authority — and watch how much Jev can
hold. Turn the gravity up and it starts to lose it.

This is a harness for OpenHarness. The agent on the right edits `pendulum.json`; the viewer on the
left simulates the rod and asks Jev for each tick's torque, live. The balance is the show.

## Anatomy

```
jev-pendulum/
  harness.json              # DSH manifest (engine: claude)
  AGENTS.md                 # tells the agent to build rigs with real tension
  skills/pendulum/SKILL.md  # the rig-tuning + verification craft
  template/pendulum.json    # a starter rig
  toolchain/
    jev.mjs                 # the Jev client (real TypeSafe API + deterministic mock), pendulum-aware
    viewer.sh               # launches the viewer
    check.mjs               # validates pendulum.json
    setup.sh / doctor.sh / init-workspace.sh
  viewer/                   # the loopback viewer server + pane (the live rod)
```

## The viewer

`viewer/viewer.mjs` simulates the inverted pendulum over a loopback HTTP server. Each tick it meters
the rod's angle and angular velocity, asks Jev to pick a torque, integrates one step, and streams
the live rod, tilt chart and decision log to the pane. It calls `POST /v1/systemone` when
`TYPESAFE_API_KEY` is set; without it a deterministic mock reads the same angle, velocity and
hardness and biases toward the balancing torque, so the demo runs offline. `.harness/verdict.json`
tracks falls, the best run and the current tilt.

The physics is a uniform rod: `θ'' = (3g/2L)·sin(θ) + (3/L²)·τ − c·θ'`, with discrete torque
actions. `gravity` maps to a hardness dial (`0..1`); higher gravity both pulls the rod over harder
and makes the mock's rare overcorrections matter more — that's the difficulty curve you watch.

## Jev, honestly

Jev's headline claim is speed — decide in a loop faster than a large model can. The pendulum
celebrates that: a decision every ~80ms that has to actually keep the rod up. But the rod is a
canvas drawing and the physics is a toy — this is a demo of decision-rate and calibration, not a
signal for real control systems, and the mock is a stand-in for *plumbing*, not judgement. Treat any
balancing act as a fun experiment, not an engineering result.

## Credit and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness is an OpenHarness wrapper that
  only calls the public API; it contains no TypeSafe code.
- **OpenHarness** (Autonomous) is MIT-licensed; this wrapper is MIT too (see `LICENSE`).
- **You** (Autonomous) built this harness for OpenHarness's store.

_Show, don't tell: this harness makes a fast decision model a live balancer — a rod you can watch
swing, recover and, at high gravity, drop._
