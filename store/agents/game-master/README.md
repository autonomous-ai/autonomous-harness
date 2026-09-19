# Game Master — Relay

Design and compare strategies in a seeded arena. Watch two squads compete for relays, inspect decisions, step and rewind matches, and run a 32-map tournament.

## Try it

> Create a capture arena where patient defenders face aggressive hunters. Show every decision and compare their win rates over 32 maps.

The starter already works before the first prompt. Change it with the agent, interact with the
result in the pane, and keep the output. Everything needed at runtime is in `game/index.html`.
It works offline and can be opened outside Harness.

## What you can do

Finite 72-turn matches, two policies, pathfinding, relay control, combat/respawn, replay timeline, 32-match tournament, full replay JSON.

## Build on the starter

The model functions `arenaMap`, `arenaPath`, `arenaMatch` and `arenaTournament` are the starting points for substantive changes. Preserve seed
reproducibility and user controls while changing the domain behavior. A different brief can replace
this starter's entire visual language. Keep the artifact self-contained and test the actual result.

The source checkout builds these starters with `node store/tools/build-experiences.mjs`. Installed
workspaces are editable HTML; no build tool, network dependency or paid service is required.

## Verification

Model census: `node --test store/tools/experience-tests/models.test.mjs` from the source checkout.
Browser interactions, exports, same-origin APIs and manifest routing: see
[`store/tools/experience-tests`](../../tools/experience-tests/README.md).

`seed-verdict.sh` establishes only artifact presence and keeps `ready:false`. The agent must run
and record real domain and browser checks before writing a ready verdict. No cross-device pixel or
audio equality is promised. The research is inspiration; this is original code, not a wrapper of
any cited third-party engine.

## Check your actual edited model

Run `node tools/check.mjs --seeds 100` in the workspace. It reads the pure model from
`<script id="harness-model">` in the artifact, checks domain invariants, repeats each seed, and
writes `.harness/model-check.json`. Preserve that script boundary when editing. Model checks are
followed by browser interaction, exported-output inspection, and visual or listening review.
