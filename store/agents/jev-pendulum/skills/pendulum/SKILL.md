---
name: jev-pendulum
description: Design and verify Jev's balancing rigs in OpenHarness's viewer, where Jev keeps an inverted pendulum upright and loses it at high gravity.
---

# Jev Pendulum rig design

Jev Pendulum simulates an inverted pendulum: Jev (TypeSafe's System One model) reads the rod's
angle and angular velocity every tick and picks a corrective torque to keep it up. The agent shapes
`pendulum.json` — the rig (gravity, torque authority, gusts) and the style line Jev balances by.

## The loop

1. Update `pendulum.json` (title, gravity, maxTorque, gustEvery/gustStrength, and a `style` line that
   tells Jev a strategy). The viewer watches it and Jev adapts live — no restart, no second server.
2. `node "$JEV_DSH/toolchain/check.mjs"` verifies the workspace's `pendulum.json` is valid. Run it
   before you call a rig done.
3. Watch the rod. Does it stand, wobble, and *sometimes* drop on a hard rig — or always stand like a
   statue (too easy) or always fall (too hard)? That observation is the finding.

## Reading the rig

The viewer shows the rod, the current action and confidence, a tilt-vs-time chart and a decision
log, plus a falling tally. Good rigs produce drama: the rod leans hard near the fall line (the chart's
red band at `±60°`), Jev's confidence dips, it recovers — and at high gravity it eventually drops.
`gravity` is the difficulty dial: `5–6` calm, `7–8` tense, `9+` falls start compounding. `gustStrength`
and `gustEvery` push it toward the edge without tipping it by themselves.

## Verifying a rig

`node "$JEV_DSH/toolchain/check.mjs"` returns non-zero when `pendulum.json` is invalid (no title,
non-positive gravity/maxTorque/length, out-of-range stepMs). It doesn't replace watching the motion:
confirm Jev holds a mid gravity steady, that raising gravity or gusts makes it visibly struggle and
fall, and that the style line shifts how decisively it recovers.

## Driving Jev yourself

`toolchain/jev.mjs` exports a small client. Example (from the workspace) — ask Jev's read on a state
before you commit to a rig:

```bash
node --input-type=module -e '
import { evaluate, jev } from "$JEV_DSH/toolchain/jev.mjs";
const res = await evaluate({
  state: "Keep the rod upright. angle: 8.0°  velocity: 0.30 rad/s  hardness: 0.67  Choose the torque that corrects the lean.",
  questions: {
    action: jev.choice(["LEFT_HARD", "LEFT", "CENTER", "RIGHT", "RIGHT_HARD"], "Which torque steadies the rod right now?"),
  },
});
console.log(JSON.stringify(res.answers, null, 2));
'
```

Without `TYPESAFE_API_KEY` this uses the deterministic mock; set the key to hit live Jev.
