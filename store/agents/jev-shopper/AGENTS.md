# Jev Shopper in OpenHarness

On the left, Jev Shopper is a live shop window: a few products stream price ticks, and **Jev —
TypeSafe's System One model — is the buyer.** Every tick Jev reads the whole window and calls the
best buy right now, says how sure it is, and when the signal is strong it spends (on paper). The
shop is synthetic; the decision loop is the show.

On the right, you edit `shopper.json`. This is the ONLY file you edit. It holds the products (name,
start price, drift) and the market's volatility; the viewer watches it and Jev adapts immediately.

## The shopper file

```jsonc
{
  "title": "Jev Shopper",
  "description": "Jev watches prices stream in and calls the best buy, live.",
  "instrument": "SHOPPER",
  "tickMs": 500,
  "vol": 0.08,
  "cash": 100,
  "products": [
    { "name": "Espresso Machine", "price": 240, "drift": 0.02 },
    { "name": "Hiking Boots", "price": 120, "drift": -0.05 },
    { "name": "Noise Cancellers", "price": 180, "drift": 0.01 },
    { "name": "Desk Lamp", "price": 45, "drift": -0.03 }
  ],
  "style": "Watch the recent price stream and pick the product whose price is most likely still falling — the best value right now. Be decisive."
}
```

- **`products[]`** — what's in the window. Each has a `name`, a starting `price`, and an optional
  `drift` (the persistent daily direction, e.g. `-0.05` = falling ~5% per tick). Products with
  different drifts give Jev a real spread to read.
- **`vol`** — price volatility per tick. Low (`0.05`) is calm and Jev reads clean momentum; high
  (`0.3+`) makes prices jitter so hard Jev's calls start to flip. This is the difficulty dial.
- **`tickMs`** — how often the prices update (and Jev decides). Fast ticks = a frantic decision
  rate; slow ticks = a contemplative shop.
- **`cash`** — the paper budget Jev spends when it acts. Set it to your shop's vibe.
- **`style`** — the instruction to Jev. It should name a buying strategy (momentum, value, wait)
  so Jev *decides* rather than guesses.

## Your job

Design `shopper.json` so the shop is an event:

- **Curate a coherent window.** Give it a theme — a coffee lover's cart, a weekend-camp haul, a
  studio upgrade — with products whose drifts create genuine divergence (some falling, some rising).
- **Pick a volatility with tension.** `8–12%` vol on mildly-drifted products gives clean, readable
  calls. Crank `vol` to `0.3+` and watch Jev second-guess itself as prices jitter — that flip is
  the fun.
- **Write a distinct style line.** "Buy the steepest faller" plays very differently from "wait for a
  clear signal" — and Jev will visibly act less.

Do NOT just ship the template. Every `shopper.json` you publish should be its own shop with a
deliberate, testable market.

Validate with `node "$JEV_DSH/toolchain/check.mjs"`. The real test is the call: does Jev pick the
product whose price is actually falling, and commit when the signal is decisive — or does it buy a
riser (bad) or never commit (dull)? Either extreme is a finding to report, not a bug to mask.

## Rules

- Keep `shopper.json` valid JSON always. A bad edit freezes the shop on the last good state. You
  can change `products` live — the viewer rebuilds the window for the new list.
- Keep `title`, `description` and `style` truthful — and never present this as real trading, real
  prices, or real financial advice.
- Jev is reached through `toolchain/jev.mjs`. You can call it directly to ask Jev's read on a
  window before you commit to it (e.g. "what does Jev call for this shop?"). Use the `jev`
  helpers: `noul`, `choice`, `score`.
- Without a `TYPESAFE_API_KEY`, Jev runs on a deterministic local mock that still reads the price
  stream and calls the steepest faller — so the demo runs offline. With a key, the viewer calls the
  real API.
- The Jev Shopper viewer writes `.harness/verdict.json` itself (ticks watched, best pick, any
  commit). Do not edit it.
- This is a demo. The shop is made up, the prices are synthetic, and Jev spends on paper — never
  present this as a real store or real trading.

## Definition of done

- A valid `shopper.json` that parses and passes `toolchain/check.mjs`.
- A shop with a real decision loop: Jev reads the window, calls the falling product, shows
  confidence, and on a strong signal commits the paper budget.
- The style and volatility actually shape the calls — report it if Jev picks the same product no
  matter what, or never commits.
