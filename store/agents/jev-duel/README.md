# Jev Duel

**A live Reversi battle where Jev — TypeSafe's System One model — plays BOTH sides, and a third Jev
referees.** Two rivals with distinct personalities collide on the board, move by move; the referee
calls each move (how strong, how aggressive, how decided the game is turning). You shape the
personalities and editorial focus; Jev does the actual fighting and judging.

This is a harness for OpenHarness. The agent on the right edits `battle.json`; the viewer on the
left runs the Reversi game loop, asks each side to choose a move, applies the flips, asks the referee
to judge every move, and streams the whole battle over SSE. One decision model is both players and
the referee.

## Anatomy

```
jev-duel/
  harness.json              # DSH manifest (engine: claude)
  AGENTS.md                 # tells the agent to craft rival personalities worth watching
  skills/duel/SKILL.md      # the matchmaking + verification craft
  template/battle.json      # a starter duel ("The Quiet War": patience vs greed)
  toolchain/
    jev.mjs                 # the Jev client (real TypeSafe API + deterministic mock), Reversi-aware
    viewer.sh               # launches the viewer
    check.mjs               # validates battle.json
    setup.sh / doctor.sh / init-workspace.sh
  viewer/                   # the loopback viewer server + pane
```

## The viewer

`viewer/viewer.mjs` runs a full Reversi engine (legal moves, flips, passing, game-over detection,
corners) and asks Jev — once per side — to choose a move as a `"x,y"` coordinate, then asks a third
Jev to referee the move. It calls `POST /v1/systemone` to TypeSafe when `TYPESAFE_API_KEY` is set;
without a key it uses a deterministic local mock whose choice logic reads the same board text and
picks strong legal moves (so the mock *plays Reversi*, the plumbing exercised exactly as live Jev is).
The pane renders the board flipping live, highlights each move, and shows the referee's running log.
`.harness/verdict.json` tracks the running score and phases.

## Jev, honestly

Jev is new and early-access; its headline claims are mostly vendor-reported, and the mock is a
stand-in for *plumbing*, not judgement. In this harness Jev reads the board as text and replies with
a coordinate — the game-engine keeps the rules honest, so Jev can only ever play legal moves, but
its *strategy* is exactly as good as the model (or mock). Treat its play as a fast, cheap signal,
not a solved player.

## Credits and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness is an OpenHarness wrapper that
  only calls the public API; it contains no TypeSafe code.
- **OpenHarness** (Autonomous) is MIT-licensed; this wrapper is MIT too (see `LICENSE`).
- **You** (Autonomous) built this harness for OpenHarness's store.

_Show, don't tell: this harness pits a decision model against itself and lets a third one judge —
three Jevs, one battle._
