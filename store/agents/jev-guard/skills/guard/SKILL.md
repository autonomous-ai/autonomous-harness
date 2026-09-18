---
name: jev-guard
description: Fix a broken module under the live eye of Jev Guard, where Jev (TypeSafe's System One model) scores your own edits for progress, risk and trust.
---

# Jev Guard fix-under-watch

Jev Guard runs the test suite in `project/` on every edit and asks Jev (TypeSafe's System One model)
to judge each change: how much closer to the goal, how risky, how confident. The pane draws those as
meters, a history chart and a run log. The goal is to make the tests pass and the verdict go green
with a fix Jev trusts.

## The loop

1. Edit `project/score.js` (that's the work). Jev Guard auto-judges on each edit, or step it with
   "Judge now" / `node "$JEV_DSH/toolchain/check.mjs"`.
2. Watch the meters: `toward` (progress), `trust` (Jev's confidence in the exact change), `risk`
   (a red flag on a shaky edit). The run log shows PASS/FAIL per test run with what changed.
3. Iterate until `node project/test.js` prints `ALL TESTS PASS` and the viewer verdict reads as
   a passing/green judgment.

## Reading Jev

Jev's scores are layered on *real test results*: the suite is the ground truth, Jev is the overlay.
A focused, honest fix — correct logic, nothing special-cased, nothing extra — is what reads as high
`trust` / low `risk`. A hack that greps the test names or returns constants will pass the tests but
Jev's `risk` meter will go red.

## Verifying

- `node "$JEV_DSH/toolchain/check.mjs"` validates the workspace (goal.json + project/test.js
  present and runnable).
- `node project/test.js` is the real check: exit 0 + `ALL TESTS PASS` is done.
- Watch the viewer verdict flip to a green/god-met judgment, not just the tests passing.

## Driving Jev yourself

`toolchain/jev.mjs` exports a small client. Example (from the workspace) — ask Jev's opinion on an
implementation choice:

```bash
node --input-type=module -e '
import { evaluate, jev } from "$JEV_DSH/toolchain/jev.mjs";
const res = await evaluate({
  state: "Implement sumTo(5) by looping, vs a closed-form n*(n+1)/2. Which is more likely a correct, maintainable fix for a tiny module?",
  questions: {
    risky: jev.score({0:"safe",1:"risky",2:"reckless"}, "How risky is switching to the closed-form?"),
  },
});
console.log(JSON.stringify(res.answers, null, 2));
'
```

Without `TYPESAFE_API_KEY` this uses the deterministic mock; set the key to hit live Jev.
