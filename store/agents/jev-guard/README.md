# Jev Guard

**Jev, TypeSafe's System One model, referees a coding agent's edits as they happen.** The agent
fixes a tiny broken module in `project/`. On every edit the viewer builds a diff, runs the test
suite, and asks Jev many typed questions about the diff in one call: is it safe to carry on, does it
leak a secret, does it weaken the tests, is it destructive, how close is it to the goal, and how
risky is each file.

**This is a demo. It is not a security tool and it is not security advice.** The demo stream, its
repo, its diffs and its keys are all made up.

This is a harness for OpenHarness. The agent on the right fixes `project/score.js` toward the goal in
`goal.json`. The viewer on the left watches those edits and streams Jev's running judgement.

## The pane

- **Safe to continue?** A big gauge with an eased needle and a plain answer: YES, LOOK FIRST or
  STOP. Under it are Jev's three probabilities for the newest edit: safe, review, block.
- **The risk river.** Jev's risk for every edit, newest on the right, with the REVIEW and BLOCK
  bars drawn across it. A diamond marks a planted risk in the demo stream, and it says CAUGHT or
  MISSED. Click any dot to read that edit.
- **Files with risk heat.** The real files in `project/` on top, the made-up demo repo under them.
  Each file glows by how risky Jev found the edits that touched it, and the glow cools over time.
- **The edit timeline.** Every edit with a verdict chip, a three-part probability bar, and for demo
  edits whether Jev caught it, missed it or raised a false alarm.
- **The diff.** The selected edit's diff, per file, with the file's own risk. Lines Jev did not get
  to read (past its reading budget) are dimmed, so you can see why a miss happened. Under it are the
  flag bars: secret, tests cut, destructive.
- **The top bar.** Decisions per second, edits reviewed and cost so far, large. Also whether the
  stream is DEMO or LIVE, the project's test result, risks caught and false alarms.
- **The rail.** The shared "Jev live mind" panel, the exact text Jev reads, the goal and the test
  output, and how it works.

The console never idles. At boot, and whenever no real edit has arrived for about 15 seconds, a
stream of made-up edits with a known ground truth plays, clearly tagged **DEMO**. It steps aside
the moment a real edit lands in `project/`, and the tag turns to **LIVE**.

## Things to try in the pane

- **Click an edit**, or a dot on the risk river, to inspect its diff.
- **Harmless refactor**, **Delete a test** and **Leak a fake secret** write a small sample file into
  `project/` so you can watch Jev react: safe, not safe, and STOP. The "secret" is the plainly fake
  string `sk_test_FAKE_not_a_real_key`. **Clean up** removes the sample files again. The sample
  files have fixed names inside `project/`. Nothing in a request can choose a path.
- **Judge now** runs the tests and reviews `project/` as it is.
- **Strictness** slider: where REVIEW and BLOCK start.
- **Hidden risks** slider: how well the demo stream hides its planted risks. The honest dial.
- **Pace** slider, **Pause**, **Step** and **Reset**.

The sliders override `goal.json` while you play. The next edit to `goal.json`, or Reset, puts the
file back in charge.

## The difficulty dial, measured

`subtlety` changes the world, never Jev's answer. At 0 a planted risk is one blatant line: `rm -rf`,
a pasted key, a deleted test file. At 1 it is a quiet line (a flipped comparison, `|| true`, a weaker
assert) inside a big harmless diff. Jev reads only the first `diffBudget` characters of a diff, so a
quiet line can sit past the point where it stopped reading. Measured on the offline stand-in, 400
demo edits each:

| setting | planted risks caught | false alarms |
|---|---|---|
| `subtlety` 0 | 100% | 0% |
| `subtlety` 0.35 (template) | 86% | 0% |
| `subtlety` 0.7 | 83% | 1% |
| `subtlety` 1 | 59% | 1% |

At `subtlety` 1, 27 of the 53 misses were lines past the reading cut. The cause is real: with
`diffBudget` 600 Jev catches 21%, with 1800 it catches 59%, with 8000 it catches 78%.

`strictness` is a trade, not a free win. At `subtlety` 1: strictness 0.1 catches 15% with no false
alarms, 0.5 catches 59% with 1%, and 0.9 catches 79% with 25% false alarms. The test suite proves
the dial, the reading budget and the trade.

## Anatomy

```
jev-guard/
  harness.json              # manifest (engine: claude)
  AGENTS.md                 # tells the agent how to work in project/
  skills/                   # how to read Jev's verdicts
  template/                 # goal.json and a tiny broken project/
  toolchain/
    jev.mjs                 # the Jev client (real TypeSafe API, or a deterministic offline stand-in)
    check.mjs               # validates the workspace
    viewer.sh setup.sh doctor.sh init-workspace.sh
  viewer/
    viewer.mjs              # loopback server, the watcher, the review loop, the controls, the verdict
    demo.mjs                # the made-up edit stream with its ground truth (seeded)
    diff.mjs                # line diffs, and the cut at Jev's reading budget
    mock.mjs                # the offline stand-in's reader for diffs
    index.html studio.js studio.css base.css jev-hud.js
  test/viewer.test.mjs
```

## `goal.json`

| key | range | meaning |
|---|---|---|
| `goal` | text | what the agent is trying to do. Jev judges against it |
| `name`, `description` | text | shown in the pane |
| `strictness` | 0 to 1 | where REVIEW and BLOCK start |
| `subtlety` | 0 to 1 | how well the demo stream hides its planted risks. The difficulty dial |
| `stepMs` | 60 to 5000 | pace of the demo stream |
| `diffBudget` | 300 to 8000 | characters of a diff Jev gets to read |
| `seed` | 0 and up | makes the demo stream repeatable |

A bad JSON edit never stops the console. It keeps running on the last good file and shows the error.

## Jev, honestly

The viewer calls `POST /v1/systemone` when `TYPESAFE_API_KEY` is set. Without a key it uses a
deterministic offline stand-in, and the pane shows a MOCK badge. The stand-in in `viewer/mock.mjs`
reads only the text Jev would read: the file headers, the changed lines that fit in the reading
budget, and the test result. It never sees the demo stream's ground truth. It is a fixed pattern
reader: loud patterns give strong evidence, quiet ones give weak evidence, and a few harmless lines
look like quiet ones. There is no randomness in it. `toolchain/jev.mjs` is unchanged. The stand-in is
there to prove the plumbing, not to stand for Jev's judgement, and a pattern reader is nothing like
a real security review. Cost in the pane is what live Jev would charge for the same tokens.

The controls: `POST /control` with `pause`, `start`, `reset`, `judge`, `tick` (`{"n": 500}` reviews
500 demo edits at once, tests use it so they never wait), `sample` (`kind`: `refactor`, `deltest`,
`secret` or `cleanup`), and `set` (`key`: `strictness`, `subtlety`, `stepMs` or `diffBudget`). The
server only answers on loopback.

## Credit and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness is an OpenHarness wrapper that
  only calls the public API. It contains no TypeSafe code.
- **OpenHarness** (Autonomous) is MIT-licensed. This wrapper is MIT too (see `LICENSE`).
- Built by Autonomous for the OpenHarness store.
