# Jev Trader in OpenHarness

On the left, Jev Trader runs a paper-trading desk. **Jev — TypeSafe's System One model — is the
trader.** A synthetic market ticks; Jev reads the tape and its own P&L and decides buy / hold / sell,
tick by tick. You design the market Jev trades; Jev does the trading. The equity never leaves paper.

On the right, you edit `market.json`. This is the ONLY file you edit. The viewer watches it and
reframes Jev live — edit volatility, drift or style while the desk is running and Jev adapts.

## The workspace

- `market.json` — the market and the trader's brief.

```jsonc
{
  "title": "A Desk Name",
  "description": "A subtitle shown in the viewer.",
  "instrument": "SYNTH",       // a made-up ticker, shown on the chart
  "startPrice": 100,           // where the tape starts
  "volatility": 0.008,         // daily noise (0..0.2). THE difficulty dial: more noise buries the trend
  "drift": 0.0003,             // a constant daily bias (-0.02..0.02)
  "trend": 0.0035,             // strength of the hidden up and down stretches (0..0.02). 0 = pure random walk
  "fee": 0.001,                // cost of a trade as a share of its value (0..0.05). 0.001 = 0.10%
  "stepMs": 200,               // ms per trading day, one Jev decision per day (60..20000)
  "capital": 10000,            // starting paper cash
  "episodeDays": 250,          // length of a paper year (60..2000). A new year starts on its own
  "seed": 1337,                // makes the market repeatable
  "style": "Buy the trend, cut losses, keep some cash. You are a fast, disciplined trader."
}
```

Only `instrument`, `startPrice`, `volatility`, `stepMs` and `capital` are required. The person can
also move noise, fee and speed with sliders in the pane, and inject a crash or a rally. Your next
edit to `market.json` puts the file back in charge.

`check.mjs` validates the shape.

## Your job

Design markets that test Jev, and give it a coherent brief. Good desks:

- **Make the trade signal real.** The price has hidden up and down stretches of strength `trend`,
  buried in daily noise of size `volatility`. A strong `trend` with low `volatility` is easy to read.
  A high `volatility` buries it and Jev becomes a coin flip. `trend: 0` is a pure random walk and
  gives Jev nothing to read. The pane shows the hidden trend as a ribbon and scores how often Jev is
  on the right side of it.
- **Match style to market.** A momentum style on a trending market, a mean-reversion-ish cautious
  style on a choppy one. The `style` line is Jev's brief — write one that's decisive.
- **Tell a story.** The title + description make the desk an event ("The Iceberg Desk", "The Lottery
  Fund").

Do NOT just ship the template. Every `market.json` you publish should be a distinct, stressworthy
market with a deliberate brief.

Validate with `node "$JEV_DSH/toolchain/check.mjs"`. The real test is the curve: does Jev make
coherent policy on your market (or just churn)? If it overtrades a flat market, that's a finding to
report — not a bug to mask.

## Keep current

- Keep `market.json` valid JSON always. A bad edit does not stop the desk: it keeps trading on the
  last good file and shows the parse error in the pane until you fix it.
- Keep `title`, `description` and `style` truthful — and never pass this off as real trading.

## Rules

- Never propose opening a browser, changing ports, or running a second server. The viewer is already
  running on the left; it auto-trades on a clock.
- Jev is reached through `toolchain/jev.mjs`. You can call it directly to ask Jev's read on a market
  before you commit to it (e.g. "will a momentum Jev make money on this volatility?"). Use the
  `jev` helpers: `noul`, `choice`, `score`.
- Without a `TYPESAFE_API_KEY`, Jev runs on a deterministic local mock that still reads the price
  tape and trades by momentum, so the desk works offline. With a key, the viewer calls the real API.
- The Jev Trader viewer writes `.harness/verdict.json` itself. Do not edit it.
- This is paper trading. Never present it as real investment guidance.

## Definition of done

- A valid `market.json` that parses and passes `toolchain/check.mjs`.
- A market with a real signal (trend and/or meaningful volatility) and a decisive `style` brief.
- The desk runs and Jev forms coherent policy on it (report if it overtrades or just holds).

Happy trading — on paper.
