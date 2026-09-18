# Jev Shopper

**Jev — TypeSafe's System One model — is the buyer.** A small shop window streams live prices; every
tick Jev reads the whole window and calls the best buy right now — the product whose price is still
falling hardest — shows how sure it is, and spends on paper when the signal is strong. Nudge the
volatility up and Jev's calls start to flip.

This is a harness for OpenHarness. The agent on the right edits `shopper.json`; the viewer on the
left runs the shop window and asks Jev for each tick's best-buy call, live. The decision loop is the
show.

## Anatomy

```
jev-shopper/
  harness.json              # DSH manifest (engine: claude)
  AGENTS.md                 # tells the agent to build shops with real decision loops
  skills/shopper/SKILL.md   # the shop-crafting + verification craft
  template/shopper.json     # a starter shop window
  toolchain/
    jev.mjs                 # the Jev client (real TypeSafe API + deterministic mock), shop-aware
    viewer.sh               # launches the viewer
    check.mjs               # validates shopper.json
    setup.sh / doctor.sh / init-workspace.sh
  viewer/                   # the loopback viewer server + pane (the live shop window)
```

## The viewer

`viewer/viewer.mjs` runs the shop over a loopback HTTP server. Each tick it nudges every product's
price (drift + volatility), asks Jev to pick the best buy and how urgent it is, and streams the live
price cards (with sparklines), Jev's highlighted pick and confidence, and a decision log to the
pane. It calls `POST /v1/systemone` when `TYPESAFE_API_KEY` is set; without it a deterministic mock
reads the same price stream and calls the steepest faller, so the demo runs offline.
`.harness/verdict.json` tracks ticks watched, the best pick, and any paper commit.

The market is synthetic: each product is a random walk around a persistent `drift`, and `vol` sets
how jittery the ticks are. Jev's "best buy" is a moment-to-moment momentum call — the product whose
price is still falling hardest — which is why high volatility makes Jev look indecisive.

## Jev, honestly

Jev's headline claim is speed — decide in a loop faster than a large model can. Shopper celebrates
that: a decision on every price tick. But the shop and the prices are entirely made up, and Jev
spends nothing real — this is a demo of decision-rate and calibration on a synthetic signal, not a
signal for how to shop or trade, and the mock is a stand-in for *plumbing*, not judgement. Treat
any "buy" call as a fun experiment, not advice.

## Credit and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness is an OpenHarness wrapper that
  only calls the public API; it contains no TypeSafe code.
- **OpenHarness** (Autonomous) is MIT-licensed; this wrapper is MIT too (see `LICENSE`).
- **You** (Autonomous) built this harness for OpenHarness's store.

_Show, don't tell: this harness makes a fast decision model a live shopper — a shop window you can
watch Jev read, judge, and act on with every tick._
