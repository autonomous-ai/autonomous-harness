# Jev Guard in OpenHarness

On the left, Jev Guard watches the `project/` folder. **Jev — TypeSafe's System One model — judges
your own work, edit by edit.** It runs the test suite on every change and scores how close to the
goal you are, how risky the change is, and how much it trusts it.

On the right, you fix the code. You own `project/` entirely; Jev only watches and judges.

## The workspace

- `goal.json` — the goal Jev judges against (the template sets a sensible one; you may sharpen it).
- `project/score.js` — the broken module **you** fix.
- `project/test.js` — the suite (plain Node, zero dependencies, runnable as `node project/test.js`).
  Jev Guard reruns it on every edit.

```jsonc
{
  "goal": "Make every test in project/test.js pass without breaking the others.",
  "name": "Jev Guard",
  "description": "Jev judges your own edits live as you fix the broken module."
}
```

## Your job

Fix the module so every test passes — and use Jev Guard as a live code reviewer while you do.
Good work under Jev Guard:

- **Fix the real thing, not the symptom.** The template's `sumTo` and `factorial` are broken in
  honest ways. Implement them correctly rather than special-casing the test's inputs — Jev Guard
  reads the *change* and its risk signal will reward a real fix.
- **Don't over-engineer.** A correct, minimal fix is what the goal asks for. Add nothing that
  changes the test contract.
- **Watch the meters.** `toward` climbs as you converge, `trust` reflects Jev's confidence in the
  exact change, `risk` warns on a shaky edit (hitting a retry/commentary `/control judge` re-runs
  the current state).

Let it run in Auto (judges on every edit) or step it with "Judge now".

## Keep current

- Keep the project able to run (`node project/test.js`) at all times; Jev Guard debounces edits but
  it will judge whatever state it finds.
- Keep `goal.json` truthful about what the tests require.

## Rules

- Never propose opening a browser, changing ports, or running a second server. The viewer is already
  running on the left.
- Jev is reached through `toolchain/jev.mjs`. You can call it directly to ask Jev's opinion on a
  design choice (e.g. "which of these two implementations is riskier?") using the `jev` helpers,
  but the ground truth is the test suite Jev Guard runs.
- Without a `TYPESAFE_API_KEY`, Jev runs on a deterministic local mock.

## Definition of done

- Every test in `project/test.js` passes (`node project/test.js` exits 0 and prints `ALL TESTS
  PASS`).
- The verdict in the viewer reads as a passing/green judgment.
- The fix is honest — the functions are implemented correctly, not special-cased to the tests.
