# Jev Arena

**A live grid world powered by Jev — TypeSafe's System One decision model.** You shape the arena;
Jev plays it. The viewer shows the board and a live "Jev's brain" panel: every move Jev makes,
streamed as a probability distribution over `up / down / left / right / wait`, with its confidence —
because watching a decision model think is the point.

This is a harness for OpenHarness. The agent on the right designs `arena.json`; the viewer on the
left runs the game loop and asks Jev for each move in real time. No text generation — just fast,
calibrated decisions you can watch.

## Anatomy

```
jev-arena/
  harness.json          # DSH manifest (engine: claude)
  AGENTS.md             # tells the agent to shape arenas worth watching
  skills/arena/SKILL.md # the design + verification craft
  template/arena.json   # a starter world
  toolchain/
    jev.mjs             # the Jev client (real TypeSafe API + deterministic mock)
    viewer.sh           # launches the viewer
    viewer/             # the loopback viewer server + pane
    check.mjs           # validates arena.json
    setup.sh / doctor.sh / init-workspace.sh
```

## The viewer

`viewer/viewer.mjs` runs the world loop and calls Jev for each move at `arena.speed` ms. It
`POST /v1/systemone` to TypeSafe when `TYPESAFE_API_KEY` is set; without a key it uses a
deterministic local mock (so the harness runs fully offline and in tests). It streams every frame —
board, hero, decisions log, probabilities — to the pane over SSE, and writes
`.harness/verdict.json` (the header's "ready / phases / summary").

## Jev, honestly

Jev is new and early-access. Its headline claims (speed, calibration, "can't hallucinate") are
mostly vendor-reported, and the mock in this harness is a stand-in for *plumbing*, not judgement.
Treat Jev's decisions as a fast, cheap signal to branch on — and verify on your own data before you
trust it for anything consequential. With a `TYPESAFE_API_KEY` this harness exercises the real model.

## Credits and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness is an OpenHarness wrapper that
  only calls the public API; it contains no TypeSafe code.
- **OpenHarness** (Autonomous) is MIT-licensed; this wrapper is MIT too (see `LICENSE`).
- **You** (Autonomous) built this harness for OpenHarness's store.

_Show, don't tell: this harness surfaces Jev's "System One" model in a live, visual way people can
try without writing API code._
