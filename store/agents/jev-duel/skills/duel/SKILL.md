---
name: jev-duel
description: Stage and verify Jev-on-Jev Reversi duels in OpenHarness's viewer, where Jev plays both sides and a third Jev referees.
---

# Jev Duel matchmaking

Jev Duel shows a live Reversi board: Jev (TypeSafe's System One model) plays both sides, one move
each turn, and a third Jev referees every move. The agent stages `battle.json` — the two rivals'
personalities, the referee's focus, the show.

## The loop

1. Update `battle.json` (two rivals with clashing personalities). The viewer watches it and reframes
   both Jevs live — no restart, no second server.
2. `node "$JEV_DSH/toolchain/check.mjs"` verifies the workspace's `battle.json` is valid and
   reports the verdict. Run it before you call a duel done.
3. Watch the board. Do the personalities actually fight? Greed grabs center flips; patience takes
   corners. If their play looks identical, sharpen the personalities.

## Reading Jev

The viewer shows each side "thinking" (blinking), the move it makes, and the referee's per-move
call (`strong · aggressive/quiet · decided`). The drama is the *contrast*: two distinct Jevs on one
board. A corner-taker and a flip-grabber will visibly differ; two identical prompts will not.

## Verifying a duel

`node "$JEV_DSH/toolchain/check.mjs"` returns non-zero when `battle.json` is invalid (bad size,
missing rivals). It doesn't replace watching the game: confirm the board fills, turns alternate, and
a winner or draw eventually appears.

## Driving Jev yourself

`toolchain/jev.mjs` exports a small client. Example (from the workspace) — audition personalities
with the referee before you stage the duel:

```bash
node --input-type=module -e '
import { evaluate, jev } from "$JEV_DSH/toolchain/jev.mjs";
const res = await evaluate({
  state: "A greedy Reversi player who grabs center flips vs a patient corner-taker.",
  questions: {
    clash: jev.score({0:"boring",1:"fun",2:"electric"}, "How much would these two personalities clash on a board?"),
    fair: jev.noul("Is this a fair, winnable matchup for either side?"),
  },
});
console.log(JSON.stringify(res.answers, null, 2));
'
```

Without `TYPESAFE_API_KEY` this uses the deterministic mock; set the key to hit live Jev.
