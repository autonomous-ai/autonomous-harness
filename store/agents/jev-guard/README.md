# Jev Guard

**Jev — TypeSafe's System One model — is your code reviewer, live.** You fix a tiny broken module
in `project/`; on every edit, Jev Guard runs the test suite and asks Jev to judge the change: how
close to the goal, how risky, how much it trusts it. The pane is a dashboard of a decision model
refereeing your own coding as you work — a live second pair of eyes that never blinks.

This is a harness for OpenHarness. The agent on the right fixes `project/score.js` toward the goal
in `goal.json`; the viewer on the left watches those edits, runs the tests, and streams Jev's
running judgment over SSE.

## Anatomy

```
jev-guard/
  harness.json              # DSH manifest (engine: claude)
  AGENTS.md                 # tells the agent to fix the module while Jev referees it
  skills/guard/SKILL.md     # the fix-under-watch craft
  template/
    goal.json               # the goal Jev judges against
    project/score.js        # the broken module to fix
    project/test.js         # the suite (plain node)
  toolchain/
    jev.mjs                 # the Jev client (real TypeSafe API + deterministic mock)
    viewer.sh               # launches the viewer
    check.mjs               # validates the workspace
    setup.sh / doctor.sh / init-workspace.sh
  viewer/                   # the loopback viewer server + pane (dashboard)
```

## The viewer

`viewer/viewer.mjs` watches `project/`, reruns the test suite on every edit (debounced), and asks
Jev three things about each change: how much closer to the goal, how confident it is in the exact
change, and how risky it is. It streams **toward / trust / risk** plus a green/done signal over SSE,
drawn as meters, a history chart and a run log. `.harness/verdict.json` carries the progressive
verdict (failing → passing → goal met). `Post /v1/systemone` is called when `TYPESAFE_API_KEY` is
set; without it, a deterministic local mock judges.

## Jev, honestly

Jev is new and early-access; its headline claims are mostly vendor-reported, and the mock is a
stand-in for *plumbing*, not judgement. Here the *test suite* is the ground truth — Jev's judgment is
an overlay on real, runnable test results. Treat its risk/trust read as a fast, cheap signal layered
on top of what the tests actually say.

## Credit and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness is an OpenHarness wrapper that
  only calls the public API; it contains no TypeSafe code.
- **OpenHarness** (Autonomous) is MIT-licensed; this wrapper is MIT too (see `LICENSE`).
- **You** (Autonomous) built this harness for OpenHarness's store.

_Show, don't tell: this harness makes a decision model a real teammate — reviewing your work as you
do it._
