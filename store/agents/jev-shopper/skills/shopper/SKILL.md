---
name: jev-shopper
description: Design and verify Jev's shop windows in OpenHarness's viewer, where Jev calls the best buy as prices stream in and spends on paper.
---

# Jev Shopper shop design

Jev Shopper runs a live shop window: a few products stream price ticks and Jev (TypeSafe's System
One model) reads the window each tick and calls the best buy — the product furthest below its own
usual price — showing confidence and spending on paper when the signal is strong. The agent
shapes `shopper.json` — the products, the price noise, the budget and the deal bar. The shop and
its prices are made up.

## The loop

1. Update `shopper.json` (title, products with price/drift, vol, tickMs, and a `style` line that
   tells Jev a buying strategy). The viewer watches it and Jev adapts live — no restart, no second
   server.
2. `node "$JEV_DSH/toolchain/check.mjs"` verifies the workspace's `shopper.json` is valid. Run it
   before you call a shop done.
3. Watch the board. The top bar shows the share of deal calls Jev got right and what its buys saved
   against the usual price. Does Jev buy real sales, or wobbles (little saved), or nothing (dull)?
   That observation is the finding.

## Reading the shop

The viewer shows each product as a price card with a live chart, a spotlight on Jev's "best buy",
a probability bar per product, purchase stamps, the budget left and receipts. Every product has a
hidden fair price (list price, slow drift, now and then a real sale). Jev reads that price plus
noise. `vol` is the noise and the difficulty dial: at `0.01` Jev's deal calls are right almost every
time and buys save about 16%; at `0.15` wobbles pass for deals, calls are right about half the time
and buys save about 3%.

## Verifying a shop

`node "$JEV_DSH/toolchain/check.mjs"` returns non-zero when `shopper.json` is invalid (no title,
fewer than two products, a non-positive price, duplicate names, out-of-range vol, tickMs, cash, minDeal or drift, more than 8 products). It
doesn't replace watching the calls: confirm Jev buys during real sales (tick "show the hidden
fair price" in the pane to see them), and that turning `vol` up makes it buy wobbles instead.

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
