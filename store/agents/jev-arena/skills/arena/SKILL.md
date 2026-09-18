---
name: jev-arena
description: Design and verify Jev Arenas in OpenHarness's live viewer, where Jev plays the world you build.
---

# Jev Arena design

Jev Arena shows a live grid and a "Jev's brain" panel: Jev (TypeSafe's System One model) chooses a
move every `arena.speed` ms, and the viewer streams the probability distribution and confidence for
`up / down / left / right / wait`.

## The loop

1. Update `arena.json`. The viewer watches it and adapts live — no restart, no second server.
2. `node "$JEV_DSH/toolchain/check.mjs"` verifies the workspace's `arena.json` is a valid, playable
   world, and reports the current verdict / status. Run it before you call a world done.
3. Watch Jev play. When the layout changes, that's the moment to look: does Jev's confidence dip and
   recover? Is the route interesting?

## Reading Jev

The viewer shows, per action, a probability bar and the chosen action highlighted. `confidence` is
a 0..1 concentration of the distribution. A confident Jev puts most mass on one move; a confused Jev
spreads it. Good arenas produce both states.

## Verifying a world

`node "$JEV_DSH/toolchain/check.mjs"` returns non-zero when `arena.json` is invalid (missing fields,
out-of-bounds, goal covered by a wall). It does not replace watching Jev actually play. Always
confirm Jev can reach the goal by stepping or running it.

## Driving Jev yourself

`toolchain/jev.mjs` exports a small client. Example (from the workspace):

```bash
node --input-type=module -e '
import { evaluate, jev } from "$JEV_DSH/toolchain/jev.mjs";
import { readFileSync } from "node:fs";
const world = JSON.parse(readFileSync("arena.json"));
const res = await evaluate({
  state: JSON.stringify(world),
  questions: {
    hard: jev.noul("Is this arena hard for a reactive agent?"),
    vibe: jev.score({0:"empty",1:"ok",2:"brilliant"}, "How good is this arena to watch?"),
  },
});
console.log(JSON.stringify(res.answers, null, 2));
'
```

Without `TYPESAFE_API_KEY` this uses the deterministic mock; set the key to hit live Jev.
