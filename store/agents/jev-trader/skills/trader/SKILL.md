---
name: jev-trader
description: Design and verify Jev's paper-trading desks in OpenHarness's viewer, where Jev trades a synthetic market live.
---

# Jev Trader market design

Jev Trader shows a live paper-trading desk: Jev (TypeSafe's System One model) reads a synthetic
price tape + its own P&L and decides buy / hold / sell each tick. The agent designs `market.json` —
the market Jev trades and the `style` brief it follows.

## The loop

1. Update `market.json` (instrument, volatility, drift, style). The viewer watches it and reframes
   Jev live — no restart, no second server.
2. `node "$JEV_DSH/toolchain/check.mjs"` verifies the workspace's `market.json` is valid and
   reports the verdict. Run it before you call a desk done.
3. Watch the equity curve. Does Jev make coherent policy on your market — buy the trend, cut the
   losses — or just churn? That observation is the finding.

## Reading Jev

The viewer shows Jev's last action (BUY/HOLD/SELL), shares, equity and confidence. A good desk
produces *policy*: Jev should react to the tape you gave it, not move the same way regardless of
your market. A decisive `style` brief + a real trend yields readable behavior; a flat, driftless
market makes any movement look like noise.

## Verifying a desk

`node "$JEV_DSH/toolchain/check.mjs"` returns non-zero when `market.json` is invalid (bad price, ms,
capital). It doesn't replace watching the curve: confirm the market ticks, Jev's equity moves, and
its actions vary with the market rather than blindly holding.

## Driving Jev yourself

`toolchain/jev.mjs` exports a small client. Example (from the workspace) — ask Jev's read on a
market before you commit:

```bash
node --input-type=module -e '
import { evaluate, jev } from "$JEV_DSH/toolchain/jev.mjs";
const res = await evaluate({
  state: "Market: SYNTH, per-step volatility 0.05 with a strong upward drift. Would a momentum Jev be profitable with a buy-the-trend style?",
  questions: {
    edge: jev.noul("Is there a tradable edge here for a momentum trader?"),
    churn: jev.score({0:"no",1:"some",2:"a lot"}, "How much would this market cause needless overtrading?"),
  },
});
console.log(JSON.stringify(res.answers, null, 2));
'
```

Without `TYPESAFE_API_KEY` this uses the deterministic mock; set the key to hit live Jev.
