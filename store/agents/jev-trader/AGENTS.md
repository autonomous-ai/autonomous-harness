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
  "description": "A subtitle felt in the viewer.",
  "instrument": "SYNTH",       // ticker, shown on the tape
  "startPrice": 100,           // starting price
  "volatility": 0.012,         // per-step stdev of returns (0..0.2)
  "drift": 0.0003,             // per-step bias; positive = gently rising, negative = falling, 0 = flat
  "stepMs": 900,               // ms per tick (min 200)
  "capital": 10000,            // starting cash
  "style": "Buy the trend, cut losses, keep some cash. You are a fast, disciplined trader."
}
```

`check.mjs` validates the shape.

## Your job

Design markets that test Jev, and give it a coherent brief. Good desks:

- **Make the trade signal real.** Give Jev a trend (positive or negative `drift`) it can read off
  the tape, or a violent enough `volatility` that cutting losses matters. A flat, driftless, low-vol
  tape gives Jev nothing to react to.
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

- Keep `market.json` valid JSON always. A bad edit freezes the desk on the last good state.
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
