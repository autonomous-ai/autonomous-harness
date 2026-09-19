# Jev Shopper in OpenHarness

On the left, Jev Shopper is a live shop window: a few products stream price ticks, and **Jev —
TypeSafe's System One model — is the buyer.** Every tick Jev reads the whole window and calls the
best buy right now, says how sure it is, and when the signal is strong it spends (on paper). The
shop is synthetic; the decision loop is the show.

On the right, you edit `shopper.json`. This is the ONLY file you edit. It holds the products (name,
list price, slow drift), the price noise and the budget; the viewer watches it and Jev adapts immediately.

## The shopper file

```jsonc
{
  "title": "Jev Shopper",
  "description": "Jev watches made-up prices stream in and calls the best buy on every tick.",
  "instrument": "SHOPPER",
  "tickMs": 250,        // ms per tick, one Jev call per tick (60..5000)
  "vol": 0.03,          // price noise per tick (0..0.5). THE difficulty dial
  "cash": 600,          // the paper budget for a round
  "minDeal": 0.08,      // how far under its usual price a product must be before Jev may buy (0.01..0.4)
  "seed": 616,          // makes the shop repeatable
  "products": [
    { "name": "Espresso Machine", "price": 240, "drift": 0.0005 },
    { "name": "Hiking Boots", "price": 120, "drift": -0.0015 },
    { "name": "Noise Cancellers", "price": 180, "drift": 0 },
    { "name": "Desk Lamp", "price": 45, "drift": -0.0005 }
  ],
  "style": "Pick the product that is the best deal right now: the one furthest below its own usual price. Say spend now only when the deal looks real and not a one-tick wobble."
}
```

- **`products[]`** — 2 to 8 made-up products. Each has a `name`, a list `price`, and an optional
  `drift`: a slow trend per tick, from `-0.05` to `0.05`. Keep it small (`0.001` is already a clear
  trend). Every product also runs real sales on its own, a dip of 10% to 32% that lasts a while.
- **`vol`** — price noise: a fresh random wobble on every tick. Low (`0.01`) and Jev tells real
  sales from wobbles almost every time. High (`0.15` and up) and wobbles pass for deals, so its calls
  are right about half the time and its buys save little. This is the difficulty dial.
- **`tickMs`** — how often prices update and Jev decides.
- **`cash`** — the paper budget for a round. A round ends when it cannot buy anything more, or after
  240 ticks. Then a new round starts on its own.
- **`minDeal`** — the deal bar. Jev's pick must be at least this far under its usual price, and Jev
  must say "spend now", before an order goes in. The order lands one tick later.
- **`style`** — the instruction to Jev. It is part of the text Jev reads.

The person can also play in the pane: click a product to start a flash sale, move the budget, the
noise and the speed, and add or remove products. Your next edit to `shopper.json` puts the file back
in charge.

## Your job

Design `shopper.json` so the shop is an event:

- **Curate a coherent window.** Give it a theme — a coffee lover's cart, a weekend-camp haul, a
  studio upgrade — with prices that make sense for it and a budget that can buy a few of them.
- **Pick a noise level with tension.** `0.03` gives clean, readable calls. Around `0.08` Jev starts
  to be fooled. At `0.15` and up it is close to a coin flip. That slide is the point of the demo.
- **Write a distinct style line.** "Buy the deepest real discount" plays differently from "wait for
  a very clear signal".

Do NOT just ship the template. Every `shopper.json` you publish should be its own shop with a
deliberate, testable market.

Validate with `node "$JEV_DSH/toolchain/check.mjs"`. The real test is the call: the pane shows the
share of deal calls Jev got right and what its buys saved against the usual price. If Jev buys
wobbles (little saved) or never buys (dull), that is a finding to report, not a bug to mask.

## Rules

- Keep `shopper.json` valid JSON always. A bad edit freezes the shop on the last good state. You
  can change `products` live — the viewer rebuilds the window for the new list.
- Keep `title`, `description` and `style` truthful — and never present this as real trading, real
  prices, or real financial advice.
- Jev is reached through `toolchain/jev.mjs`. You can call it directly to ask Jev's read on a
  window before you commit to it (e.g. "what does Jev call for this shop?"). Use the `jev`
  helpers: `noul`, `choice`, `score`.
- Without a `TYPESAFE_API_KEY`, Jev runs on a deterministic local mock that still reads the price
  stream and calls the product furthest under its own usual price — so the demo runs offline. With a key, the viewer calls the
  real API.
- The Jev Shopper viewer writes `.harness/verdict.json` itself (ticks watched, best pick, any
  commit). Do not edit it.
- This is a demo. The shop is made up, the prices are synthetic, and Jev spends on paper — never
  present this as a real store or real trading.

## Definition of done

- A valid `shopper.json` that parses and passes `toolchain/check.mjs`.
- A shop with a real decision loop: Jev reads the board, calls the product furthest under its usual
  price, shows confidence, and on a strong signal spends from the paper budget.
- The style and volatility actually shape the calls — report it if Jev picks the same product no
  matter what, or never commits.
