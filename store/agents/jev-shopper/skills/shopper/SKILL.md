---
name: jev-shopper
description: Design and verify Jev's shop windows in OpenHarness's viewer, where Jev calls the best buy as prices stream in and spends on paper.
---

# Jev Shopper shop design

Jev Shopper runs a live shop window: a few products stream price ticks and Jev (TypeSafe's System
One model) reads the window each tick and calls the best buy — the product whose price is still
falling hardest — showing confidence and spending on paper when the signal is strong. The agent
shapes `shopper.json` — the products, their drifts, and the market's volatility.

## The loop

1. Update `shopper.json` (title, products with price/drift, vol, tickMs, and a `style` line that
   tells Jev a buying strategy). The viewer watches it and Jev adapts live — no restart, no second
   server.
2. `node "$JEV_DSH/toolchain/check.mjs"` verifies the workspace's `shopper.json` is valid. Run it
   before you call a shop done.
3. Watch the window. Does Jev call the falling product, show real confidence, and commit on a clear
   signal — or buy a riser (bad) or never commit (dull)? That observation is the finding.

## Reading the shop

The viewer shows each product as a price card with a sparkline, Jev's highlighted "best buy" pick
and confidence, the remaining cash, and a decision log. Good shops produce a readable loop: Jev
calls the steepest faller, the spread drives its confidence, and when one product clearly out-falls
the field it commits the budget. `vol` is the difficulty dial — jitter it up and Jev's calls start
to flip.

## Verifying a shop

`node "$JEV_DSH/toolchain/check.mjs"` returns non-zero when `shopper.json` is invalid (no title,
fewer than two products, a non-positive price, duplicate names, out-of-range vol/tickMs). It
doesn't replace watching the calls: confirm Jev picks the product whose price is actually falling
and commits on a decisive spread, and that cranking `vol` up makes it visibly second-guess.

## Driving Jev yourself

`toolchain/jev.mjs` exports a small client. Example (from the workspace) — ask Jev's read on a
window before you commit to it:

```bash
node --input-type=module -e '
import { evaluate, jev } from "$JEV_DSH/toolchain/jev.mjs";
const res = await evaluate({
  state: "Pick the best value. Prices tick live: Espresso Machine: 240.62 (+2.1% over 6 ticks) vol 8% — Hiking Boots: 119.50 (-4.2% over 6 ticks) vol 8% — Desk Lamp: 45.00 (-3.1% over 6 ticks) vol 8%. Which is the best buy to act on now?",
  questions: {
    buy: jev.choice(["Espresso Machine", "Hiking Boots", "Desk Lamp"], "Which product is the best buy to act on right now?"),
  },
});
console.log(JSON.stringify(res.answers, null, 2));
'
```

Without `TYPESAFE_API_KEY` this uses the deterministic mock; set the key to hit live Jev.
