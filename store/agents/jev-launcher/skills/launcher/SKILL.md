---
name: jev-launcher
description: Design and verify Jev's command palettes in OpenHarness's viewer, where Jev ranks launch targets live per keystroke.
---

# Jev Launcher palette design

Jev Launcher shows a live predictive command palette: Jev (TypeSafe's System One model) reads a
query and ranks which launch target to surface first, on every keystroke. The agent designs
`launcher.json` — the palette of targets and the aliases Jev fuzzy-matches against.

## The loop

1. Update `launcher.json` (title, prompt, and the target list with categories + aliases). The viewer
   watches it and Jev adapts live — no restart, no second server.
2. `node "$JEV_DSH/toolchain/check.mjs"` verifies the workspace's `launcher.json` is valid. Run it
   before you call a palette done.
3. Watch the ranking. Does Jev's top pick track the query you typed — or does it pick the same
   target regardless? That observation is the finding.

## Reading Jev

The viewer shows the full ranking with confidence bars for the current query. A good palette
produces *movement*: Jev should re-rank as the query narrows. Distinct aliases and overlapping ones
("ship", "release", "deploy") give Jev real signals; a query with no alias coverage makes Jev guess
no matter what. An idle palette (nothing typed) should lead with `featured` targets.

## Verifying a palette

`node "$JEV_DSH/toolchain/check.mjs"` returns non-zero when `launcher.json` is invalid (no title,
fewer than two targets, duplicate names). It doesn't replace watching the ranking: type partial
queries and confirm Jev's pick moves toward the target whose aliases match, and that a confident
short query snaps to a clear winner.

## Driving Jev yourself

`toolchain/jev.mjs` exports a small client. Example (from the workspace) — ask Jev's read on a
query before you commit to it:

```bash
node --input-type=module -e '
import { evaluate, jev } from "$JEV_DSH/toolchain/jev.mjs";
const res = await evaluate({
  state: "A palette: 1. Open Editor [Apps] aliases: code, vscode, ide — launch. 2. Deploy [Ops] aliases: ship, release, deploy — launch. Current query: \"de\". Pick the ONE target that best matches.",
  questions: {
    pick: jev.choice(["Open Editor", "Deploy"], "Which launch target is the best match?"),
  },
});
console.log(JSON.stringify(res.answers, null, 2));
'
```

Without `TYPESAFE_API_KEY` this uses the deterministic mock; set the key to hit live Jev.
