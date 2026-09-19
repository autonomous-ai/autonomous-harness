---
name: jev-lander
description: Design and verify Jev's landing missions in OpenHarness's viewer, where Jev is the flight computer throttling a booster down to a soft touchdown.
---

# Jev Lander landing design

Jev Lander runs a live landing: a booster falls out of the sky under gravity and Jev (TypeSafe's
System One model) reads the telemetry each tick and sets a throttle — CUT, COAST, HOVER or BURN —
to bring it down soft. The agent shapes `lander.json`: the gravity, the fuel budget, and the launch
height.

## The loop

1. Update `lander.json` (title, gravity, fuel, altitude, a `style` line that tells Jev a landing
   strategy). The viewer watches it and Jev adapts live — no restart, no second server.
2. `node "$JEV_DSH/toolchain/check.mjs"` verifies the workspace's `lander.json` is valid. Run it
   before you call a mission done.
3. Watch the descent. Does Jev burn early and hard enough to keep descent in check, flare low, and
   touch down soft — or hover forever (dull) or slam in even at easy gravity (bad)? That observation
   is the finding.

## Reading the landing

The viewer shows a booster descending against a starry sky, a flame plume that scales with the
throttle Jev set, live altitude / vertical speed / fuel readouts, and a LANDED SOFT or CRASHED
banner plus a flight log. Good missions produce a readable loop: Jev burns to arrest the fall, eases
off low, and lands soft; `gravity` is the difficulty dial — crank it up and the burns get twitchy
and touchdowns start to crash.

## Verifying a mission

`node "$JEV_DSH/toolchain/check.mjs"` returns non-zero when `lander.json` is invalid (no title, a
non-positive gravity/fuel/altitude/safeSpeed, out-of-range tickMs). It doesn't replace watching the
descent: confirm Jev reads the telemetry and touches down soft at the gravity you set, and that
cranking `gravity` up makes it visibly crash.

## Driving Jev yourself

`toolchain/jev.mjs` exports a small client. Example (from the workspace) — ask Jev's read on a
mission profile before you commit to it:

```bash
node --input-type=module -e '
import { evaluate, jev } from "$JEV_DSH/toolchain/jev.mjs";
const res = await evaluate({
  state: "The booster is falling under gravity. Bring it down to the pad gently: burn early and hard enough to keep descent in check, and ease off so you touch down soft. Telemetry: ALT 34.2 VY -2.4 G 2.5 FUEL 62%. Which throttle do you set for this tick? CUT / COAST / HOVER / BURN",
  questions: {
    thrust: jev.choice(["CUT", "COAST", "HOVER", "BURN"], "Which throttle do you set for this tick?"),
  },
});
console.log(JSON.stringify(res.answers, null, 2));
'
```

Without `TYPESAFE_API_KEY` this uses the deterministic mock; set the key to hit live Jev.
