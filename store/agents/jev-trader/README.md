# Jev Trader

**Jev, TypeSafe's System One model, runs a paper trading desk on a made-up market.** One candle is
one trading day. Each day the last 20 closing prices and the account are written out as text, and
Jev answers five typed questions in one call: buy, hold or sell, how strong the signal is, whether it
is a clear call, what the trend is, and whether a crash is under way. The desk turns the answers into
a paper trade.

**The market is synthetic. The money is paper. Nothing here is financial advice**, and nothing here
says anything about how Jev or any model would do on a real market. The pane says so at all times.

This is a harness for OpenHarness. The agent on the right edits `market.json`. The viewer on the left
runs the market and the account, and asks Jev for each decision in real time.

## The pane

- **The chart.** Candles scroll left at a steady pace at 60 frames a second, and the newest candle
  forms in place. Green arrows under a candle are Jev's buys, red arrows over a candle are its sells.
  A trade throws sparks and a small label.
- **Jev's mind, on the newest candle.** Three rays leave the last close, one each for buy, hold and
  sell. Their brightness and the three bars at their ends are Jev's probabilities. The chosen one
  glows, and the soft wedge around it is wide when Jev is unsure and narrow when it is sure.
- **The hidden trend ribbon.** The price is driven by hidden up, down and sideways stretches that
  last a few weeks each, plus daily noise. The ribbon under the chart shows them. Jev cannot see it.
  You can, so you can judge whether Jev is on the right side.
- **Equity against buy-and-hold.** Jev's line and the buy-and-hold line, with the gap shaded green
  when Jev is ahead and red when it is behind.
- **Gauges.** Position, cash, drawdown (with the worst so far marked) and the share of trend days on
  which Jev was on the right side.
- **The top bar.** Decisions per second, trading days done and cost so far, large. Also equity, Jev's
  return, buy-and-hold's return and how many paper years Jev has won.
- **The rail.** The shared "Jev live mind" panel with every question and its probabilities, the exact
  text Jev reads, a blotter of trades, and the list of closed years.

A paper year is 250 days. When it ends the result stays up for about three seconds, then a new year
opens with a new seed. The desk never stops.

## Things to try in the pane

- **Crash** and **Rally** inject a made-up four-day shock. Watch Jev sell into the crash.
- **Go to cash** sells everything now, fee included. Jev starts again from cash.
- **Noise** is the daily volatility. This is the honest difficulty dial. See below.
- **Fee** is what every trade costs. At 1% the churn eats the gains.
- **Speed** is trading days per second, from 1 to 16.
- **Pause**, **Step** and **Reset**.

The sliders override `market.json` while you play. The next edit to `market.json`, or Reset, puts the
file back in charge.

## The difficulty dial, measured

`volatility` is daily noise. The hidden trend is the same strength at every setting. With little
noise the trend can be read off the tape. With a lot of noise it is buried, and a trend follower is
right about as often as a coin. Nothing random is added to Jev's decision. Measured on the offline
stand-in, ten paper years each:

| volatility | right side of the trend | years Jev beat buy-and-hold | edge a year |
|---|---|---|---|
| 0.004 | 87% | 10 of 10 | +14.0 points |
| 0.012 | 71% | 4 of 10 | -1.7 points |
| 0.03 | 53% | 3 of 10 | -23.9 points |
| 0.05 | 52% | 4 of 10 | -37.3 points |

Over 30 years the template's 0.008 gives 79% and 25 of 30. A 1% fee turns a small edge into a loss
(at volatility 0.012: +2.1 points a year with no fee, -4.7 with a 1% fee). The test suite proves the dial and the fee.

## Anatomy

```
jev-trader/
  harness.json              # manifest (engine: claude)
  AGENTS.md                 # tells the agent how to shape market.json
  skills/trader/SKILL.md    # market design and how to check it
  template/market.json      # a starter desk
  toolchain/
    jev.mjs                 # the Jev client (real TypeSafe API, or a deterministic offline stand-in)
    check.mjs               # validates market.json
    viewer.sh setup.sh doctor.sh init-workspace.sh
  viewer/
    viewer.mjs              # loopback server, the trading loop, the controls, the verdict
    sim.mjs                 # the made-up market and the paper account (seeded, no I/O)
    mock.mjs                # the offline stand-in's reader for this desk
    index.html studio.js studio.css base.css jev-hud.js
  test/viewer.test.mjs
```

## `market.json`

| key | range | meaning |
|---|---|---|
| `title`, `description` | text | shown in the pane |
| `instrument` | text | a made-up ticker |
| `startPrice` | 0.01 to 1,000,000 | price where the tape starts |
| `volatility` | 0 to 0.2 | daily noise. The difficulty dial |
| `drift` | -0.02 to 0.02 | a constant daily bias |
| `trend` | 0 to 0.02 | strength of the hidden trend. 0 is a pure random walk |
| `fee` | 0 to 0.05 | cost of a trade, as a share of its value |
| `stepMs` | 60 to 20000 | milliseconds per trading day |
| `capital` | 100 and up | starting paper cash |
| `episodeDays` | 60 to 2000 | length of a paper year |
| `seed` | 0 and up | makes the market repeatable |
| `style` | text | Jev's brief. It is part of the text Jev reads |

A bad JSON edit never stops the desk. It keeps trading on the last good file and shows the error.

## Jev, honestly

The viewer calls `POST /v1/systemone` when `TYPESAFE_API_KEY` is set. Without a key it uses a
deterministic offline stand-in, and the pane shows a MOCK badge. The stand-in in `viewer/mock.mjs`
reads only the text Jev would read: the closing prices and the account line. It is a plain trend
follower (a fast average against a slow one, measured against the noise on the tape). It never sees
the hidden trend or a future price. It is there to prove the plumbing, not to stand for Jev's
judgement. Cost in the pane is what live Jev would charge for the same tokens.

The controls: `POST /control` with `pause`, `start`, `reset`, `tick` (`{"n": 500}` runs 500 days at
once, tests use it so they never wait), `shock` (`kind`: `crash` or `rally`), `flatten`, and `set`
(`key`: `volatility`, `fee` or `stepMs`). The server only answers on loopback.

## Credit and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness is an OpenHarness wrapper that
  only calls the public API. It contains no TypeSafe code.
- **OpenHarness** (Autonomous) is MIT-licensed. This wrapper is MIT too (see `LICENSE`).
- Built by Autonomous for the OpenHarness store.
