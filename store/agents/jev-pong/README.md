# Jev Pong

**Jev — TypeSafe's System One model — is the paddle.** A ball ricochets around a slim court; every
tick Jev reads its position and velocity and moves the paddle to meet the return. Each hit makes
the ball a little faster, so a long rally is a losing battle — watch Jev chase, wobble, and finally
drop it.

This is a harness for OpenHarness. The agent on the right edits `pong.json`; the viewer on the left
simulates the rally and asks Jev for each tick's paddle move, live. The chase is the show.

## Anatomy

```
jev-pong/
  harness.json              # DSH manifest (engine: claude)
  AGENTS.md                 # tells the agent to build rallies with real pace
  skills/pong/SKILL.md      # the court-tuning + verification craft
  template/pong.json        # a starter court
  toolchain/
    jev.mjs                 # the Jev client (real TypeSafe API + deterministic mock), rally-aware
    viewer.sh               # launches the viewer
    check.mjs               # validates pong.json
    setup.sh / doctor.sh / init-workspace.sh
  viewer/                   # the loopback viewer server + pane (the live court)
```

## The viewer

`viewer/viewer.mjs` simulates the court over a loopback HTTP server. Each tick it meters the ball,
asks Jev to pick a paddle move (`MOVE_UP_FAST`…`MOVE_DOWN_FAST`), integrates one step, and streams
the live court, a predicted-intercept ghost, and a decision log to the pane. It calls
`POST /v1/systemone` when `TYPESAFE_API_KEY` is set; without it a deterministic mock reads the same
ball and paddle and steers toward the predicted intercept, so the demo runs offline.
`.harness/verdict.json` tracks misses, the best rally and the current rally.

The physics is honest but toy: the ball reflects off floor, ceiling and the far wall; Jev's paddle
moves at a fixed `maxSpeed`; and **every successful return adds `accel` to the ball's speed**, so
long rallies genuinely outrun the paddle. `speed` sets the starting pace (the difficulty dial);
`maxSpeed` and `accel` set how hard Jev has to work and how fast the ball runs away.

## Jev, honestly

Jev's headline claim is speed — decide in a loop faster than a large model can. Pong celebrates
that: a decision every ~40ms that has to actually meet a moving ball. But the ball and paddle are
canvas shapes and the physics is a toy — this is a demo of decision-rate and tracking, not a signal
for real game AI, and the mock is a stand-in for *plumbing*, not judgement. Treat any rally as a
fun experiment, not an engineering result.

## Credit and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness is an OpenHarness wrapper that
  only calls the public API; it contains no TypeSafe code.
- **OpenHarness** (Autonomous) is MIT-licensed; this wrapper is MIT too (see `LICENSE`).
- **You** (Autonomous) built this harness for OpenHarness's store.

_Show, don't tell: this harness makes a fast decision model a live paddle — a rally you can watch
accelerate, scramble and finally drop._
