---
name: game
description: Build a deterministic, seedable arena game in one HTML file from a plain-English description. Use whenever the user asks for an AI-vs-AI duel, a player-vs-AI game, a board bout, a race, a chase, or prompt-to-game.
---

# game

Take the user's description and produce a **single self-contained `game/index.html`**
that runs a **deterministic, seedable** arena game — two AIs competing, or the
player plus an AI — loading the seed from a `?seed=` query param so the web-viewer
can preview the current seed and re-seed live.

## The floor (in order)

1. **Seeded PRNG.** A small seeded PRNG derived from the hash of the seed string.
   Nothing may call a non-seeded random — the match must be reproducible.
2. **Arena + turn loop.** A seeded board/layout and a turn loop where each side
   picks a legal move; player-vs-AI reads real input.
3. **`?seed=` plumbing.** Reading the param, plus a tiny UI (input + "re-seed"
   button, and play/step controls) so the person can browse seeds in the pane.
4. **Named sub-streams.** One PRNG sub-stream per concern (map layout, move rolls,
   AI policy) so tuning one doesn't reshuffle the other.

## The gold checklist

- **Trait tables that survive an edition**: seed → match (map, matchup, outcome),
  and a census that shows no stuck or degenerate match in the range you claim.
- **Rules discipline**: every move is legal and state is consistent; a visible
  scoreline and turn indicator that read clearly.
- **Style range**: a capture duel, a race to a goal, a chase-and-tag, a turn-based
  knock-out — matched to the brief, not all at once.
- **Export route**: expose a "watch" mode that plays the seeded match end-to-end
  and a rewind/step control.

## Verify like a spectator, not a compiler

Run a grid of seeds — actually watch the matches — and read the scorelines.
Two hard checks before "ready":
- **Re-run same-seed** — it must be identical on this machine.
- **Census the seed range you promise** (e.g. 0–99); reject any stuck AI,
  deadlock, or infinite match.

Be explicit in the verdict about the reproducibility guarantee: same-machine yes;
timing-based AI or animation you cannot prove bit-identical — say so.

## Verdict feed

Write `.harness/verdict.json` at every change:

```json
{ "spec": 1, "ready": false, "summary": "seeded capture duel · re-seed live · census 0–99 clean",
  "findings": [{ "severity": "info", "kind": "reproducibility", "message": "same-machine verification pending; timing-based animation not provable bit-identical" }],
  "artifact": "game/index.html",
  "phases": [{ "id": "seed", "name": "Seeded core", "state": "done" },
             { "id": "game", "name": "The game", "state": "active" },
             { "id": "edition", "name": "Edition", "state": "pending" }],
  "updatedAt": "2026-09-18T00:00:00Z" }
```

## Starting from Relay

The template is functional: Finite 72-turn matches, two policies, pathfinding, relay control, combat/respawn, replay timeline, 32-match tournament, full replay JSON.

Keep its useful controls and exports when making a user's creation. Test the behavioral core
(arenaMap, arenaPath, arenaMatch, arenaTournament) as well as the visible result. A self-contained HTML file can still have well-separated
model, rendering, input and export functions. Do not turn a finished starter into a waiting screen.

Presence-only helpers do not prove correctness or reproducibility. Record actual evidence before
marking the result ready. Export and reopen the result as part of the handoff to the user.

## Check your actual edited model

Run `node tools/check.mjs --seeds 100` in the workspace. It reads the pure model from
`<script id="harness-model">` in the artifact, checks domain invariants, repeats each seed, and
writes `.harness/model-check.json`. Preserve that script boundary when editing. Model checks are
followed by browser interaction, exported-output inspection, and visual or listening review.
