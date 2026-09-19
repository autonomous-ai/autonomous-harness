# Jev Launcher

**Jev — TypeSafe's System One model — is a live predictive command palette.** You type into the
palette; on every keystroke Jev reads your query and re-ranks the launch targets, showing which one
it would fire and how confident it is. Curate a palette of targets (name, category, aliases); Jev
does the ranking — the fastest, cheapest way to see a decision model decide in real time.

This is a harness for OpenHarness. The agent on the right edits `launcher.json`; the viewer on the
left runs the palette and asks Jev for each keystroke's ranking, live. Firing a target is always the
agent's choice and happens on paper only.

## Anatomy

```
jev-launcher/
  harness.json              # DSH manifest (engine: claude)
  AGENTS.md                 # tells the agent to curate palettes that rank well
  skills/launcher/SKILL.md  # the palette-craft + verification craft
  template/launcher.json    # a starter palette
  toolchain/
    jev.mjs                 # the Jev client (real TypeSafe API + deterministic mock), fuzzy-match aware
    viewer.sh               # launches the viewer
    check.mjs               # validates launcher.json
    setup.sh / doctor.sh / init-workspace.sh
  viewer/                   # the loopback viewer server + pane (the live palette)
```

## The viewer

`viewer/viewer.mjs` serves the palette over a loopback HTTP server. Each keystroke POSTs a query;
the viewer asks Jev to pick which target best matches, then streams the running ranking (with
confidence bars) to the pane. It calls `POST /v1/systemone` when `TYPESAFE_API_KEY` is set; without
it a deterministic mock reads the same palette + query and ranks by fuzzy match, so the demo runs
offline. `.harness/verdict.json` tracks the queries and picks so far.

## Jev, honestly

Jev's headline claim is speed: fast enough to make a decision on every keystroke. This harness makes
that visible. But a ranking of launch targets is exactly the sort of thing that only matters as a
demo — the palette is made-up, aliases are yours, and nothing actually launches. Jev is early-access
and the mock is a stand-in for *plumbing*, not judgement. Treat any ranking as a fun demo, not a
signal for what an operating system should do.

## Credit and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness is an OpenHarness wrapper that
  only calls the public API; it contains no TypeSafe code.
- **OpenHarness** (Autonomous) is MIT-licensed; this wrapper is MIT too (see `LICENSE`).
- **You** (Autonomous) built this harness for OpenHarness's store.

_Show, don't tell: this harness makes a fast decision model a live launch oracle — a ranking you can
watch re-decide with every keystroke._
