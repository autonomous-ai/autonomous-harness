---
name: jev-pong
description: Design and verify Jev's paddle-defense courts in OpenHarness's viewer, where Jev keeps a rally alive and loses it as the ball accelerates.
---

# Jev Pong court design

Jev Pong simulates a paddle-defense rally: Jev (TypeSafe's System One model) reads the ball's
position and velocity every tick and moves the paddle to meet the return. Each hit speeds the ball
up, so a long rally outruns the paddle. The agent shapes `pong.json` — the court, the paddle's
authority, and the starting ball speed.

## The loop

1. Update `pong.json` (title, courtW/courtH, speed, maxSpeed, accel, and a `style` line that tells
   Jev a strategy). The viewer watches it and Jev adapts live — no restart, no second server.
2. `node "$JEV_DSH/toolchain/check.mjs"` verifies the workspace's `pong.json` is valid. Run it
   before you call a court done.
3. Watch the rally. Does Jev return a few balls, speed the ball up, and *sometimes* drop it — or
   never miss (too easy) / always drop (too hard)? That observation is the finding.

## Reading the court

The viewer shows the court, five ghost paddles lit by the probability of each move, a ring where
the ball will cross Jev's wall, the paddle's remaining reach, a pace meter with the pace where the
paddle is outrun, the text Jev reads, and a bar for every finished rally. Good courts produce a natural arc:
Jev holds a few returns, the ball accelerates, Jev scrambles harder, and it finally slips past.
`speed` sets the serve pace; `accel` controls how fast each rally runs away; `maxSpeed` is how far
a plain paddle move goes per decision (a FAST move goes twice as far).

## Verifying a court

`node "$JEV_DSH/toolchain/check.mjs"` returns non-zero when `pong.json` is invalid (no title, or
a value outside its range, for example `speed` 1..60 or `stepMs` 30..2000). It also prints the pace
past which a far ball is out of the paddle's reach. It doesn't replace watching the motion:
confirm Jev holds a low speed comfortably, that raising `speed` or `accel` shortens rallies and
raises the miss count, and that the style line shifts how decisively it moves.

## Driving Jev yourself

`toolchain/jev.mjs` exports a small client. Example (from the workspace) — ask Jev's read on a
state before you commit to a court:

```bash
node --input-type=module -e '
import { evaluate, jev } from "$JEV_DSH/toolchain/jev.mjs";
const res = await evaluate({
  state: "Keep the rally alive.\nYou are the paddle on the left wall of a 200x120 court. y 0 is the top, y grows downward.\npaddle: centre y 50.0, half-height 13.0, face at x 8\npaddle speed: a plain move shifts it 2.0 per decision, a FAST move 4.0 per decision\nball: x 40.0  y 70.0  vx -6.0  vy 2.0  radius 3  (toward you)\nspeed: 6.0 per decision   rally: 0",
  questions: {
    move: jev.choice(["MOVE_UP_FAST", "MOVE_UP", "HOLD", "MOVE_DOWN", "MOVE_DOWN_FAST"], "Which paddle move keeps the rally alive?"),
  },
});
console.log(JSON.stringify(res.answers, null, 2));
'
```

Without `TYPESAFE_API_KEY` this uses the deterministic mock; set the key to hit live Jev.
