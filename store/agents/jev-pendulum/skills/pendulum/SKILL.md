---
name: jev-pendulum
description: Design and verify Jev's balancing rigs in OpenHarness's viewer, where Jev keeps an inverted pendulum upright and loses it at high gravity.
---

# Jev Pendulum rig design

Jev Pendulum simulates a rod hinged on a cart: Jev (TypeSafe's System One model) reads the rod's
angle and swing every tick and picks a push on the cart to keep it up. The agent shapes
`pendulum.json` — the rig (gravity, rod length, push authority, gusts) and the style line Jev
balances by.

## The loop

1. Update `pendulum.json` (title, gravity, maxTorque, gustEvery/gustStrength, and a `style` line that
   tells Jev a strategy). The viewer watches it and Jev adapts live — no restart, no second server.
2. `node "$JEV_DSH/toolchain/check.mjs"` verifies the workspace's `pendulum.json` is valid. Run it
   before you call a rig done.
3. Watch the rod. Does it stand, wobble, and *sometimes* drop on a hard rig — or always stand like a
   statue (too easy) or always fall (too hard)? That observation is the finding.

## Reading the rig

The viewer shows the cart and rod, five force arrows on the cart sized by the probability of each
push, the "no return" lines where gravity beats the hardest shove, a lean budget meter, a run timer
against the best run, and a tilt trace with every gust marked. Good rigs produce drama: a gust
throws the rod toward the no return line, Jev's "under control?" answer dips, it recovers — and at
high gravity it drops. `gravity` is the difficulty dial: `4–5` never falls, `7` is tense, `10+`
topples every few seconds. A shorter `length` is harder too. `gustStrength`
and `gustEvery` push it toward the edge without tipping it by themselves.

## Verifying a rig

`node "$JEV_DSH/toolchain/check.mjs"` returns non-zero when `pendulum.json` is invalid (no title,
or a value outside its range, for example `gravity` 0.5..30, `length` 0.2..3, `stepMs` 30..2000).
It also prints the lean past which the rod cannot be saved. It does not replace watching the motion:
confirm Jev holds a mid gravity steady, that raising gravity or gusts makes it visibly struggle and
fall, and that the style line shifts how decisively it recovers.

## Driving Jev yourself

`toolchain/jev.mjs` exports a small client. Example (from the workspace) — ask Jev's read on a state
before you commit to a rig:

```bash
node --input-type=module -e '
import { evaluate, jev } from "$JEV_DSH/toolchain/jev.mjs";
const res = await evaluate({
  state: "Keep the rod upright.\nA stiff rod of length 1.00 stands hinged on a cart. You push the cart left or right along a rail.\nangle: +8.0°  velocity: +0.30 rad/s   (positive = leaning right, it falls at ±60°)\ncart: velocity +0.00 m/s   rail drag 0.2 per s\ngravity: 7.0   damping: 0.50\npush: LEFT_HARD -1.60, LEFT -0.80, CENTER +0.00, RIGHT +0.80, RIGHT_HARD +1.60 m/s²",
  questions: {
    action: jev.choice(["LEFT_HARD", "LEFT", "CENTER", "RIGHT", "RIGHT_HARD"], "Which push steadies the rod right now?"),
  },
});
console.log(JSON.stringify(res.answers, null, 2));
'
```

Without `TYPESAFE_API_KEY` this uses the deterministic mock; set the key to hit live Jev.
