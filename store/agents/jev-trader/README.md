# Jev Trader

**Jev — TypeSafe's System One model — runs a paper-trading desk.** A synthetic market ticks every
`stepMs`; Jev reads the recent price tape and its own P&L, then decides **buy / hold / sell**, with a
confidence and conviction. The viewer draws the live equity curve and price as Jev trades. No fake
money is ever at risk — the P&L is honest, but simulated: a sandbox where you watch a decision model
trade.

This is a harness for OpenHarness. The agent on the right edits `market.json`; the viewer on the
left runs the market + portfolio engine and asks Jev for each decision in real time.

## Anatomy

```
jev-trader/
  harness.json              # DSH manifest (engine: claude)
  AGENTS.md                 # tells the agent to design markets that stress-test Jev
  skills/trader/SKILL.md    # the market-design + verification craft
  template/market.json      # a starter desk
  toolchain/
    jev.mjs                 # the Jev client (real TypeSafe API + deterministic mock), momentum-aware
    viewer.sh               # launches the viewer
    check.mjs               # validates market.json
    setup.sh / doctor.sh / init-workspace.sh
  viewer/                   # the loopback viewer server + pane (equity curve)
```

## The viewer

`viewer/viewer.mjs` runs a deterministic random-walk market and a portfolio engine (cash, holdings,
equity). Each tick it advances the price, asks Jev to choose BUY/HOLD/SELL (with confidence +
conviction), executes the trade, and streams the tape + equity to the pane. It calls
`POST /v1/systemone` when `TYPESAFE_API_KEY` is set; without it a deterministic mock reads the same
price tape and biases buy/hold/sell by momentum. `.harness/verdict.json` tracks P&L and phases.

## Jev, honestly

Jev is new and early-access; its headline claims are mostly vendor-reported, and the mock is a
stand-in for *plumbing*, not judgement. This is paper trading on a synthetic market — deliberately
**not** investment advice and not a signal for real money. The value is watching a decision model
form policy (buy the trend / cut losses) and react to a moving tape. Treat any P&L as a demo, not a
strategy.

## Credits and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness is an OpenHarness wrapper that
  only calls the public API; it contains no TypeSafe code.
- **OpenHarness** (Autonomous) is MIT-licensed; this wrapper is MIT too (see `LICENSE`).
- **You** (Autonomous) built this harness for OpenHarness's store.

_Show, don't tell: this harness makes a decision model a live trader — a paper desk you can watch
think and react._
