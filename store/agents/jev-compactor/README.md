# Jev Compactor

**A live demo of one idea: context compaction does not have to be a summarization prompt.**
A made-up coding agent works in a made-up repo. Its context window fills with messages and tool
results. When the window passes its budget, Jev (TypeSafe's System One model) judges **every tool
result in one pass**: `keep`, `trim` or `drop`. The tower collapses, and the result is measured
against a hidden ground truth.

This is a demo on synthetic data. It is not a real compaction plugin, and it says nothing about
any real product. The session, the repo, the tool output and the token counts are all generated.

This is a harness for OpenHarness. The agent on the right edits `session.json`. The viewer on the
left runs the session and asks Jev to compact it, live.

## What you see

- **The context tower.** One block per event, newest on top, coloured by kind (user, assistant,
  Read, Grep, Bash, Edit, WebFetch). The height axis is curved so a small window is still easy to
  see, but the budget line is exact. A thin strip beside the tower shows the ground truth: green
  means "needed for the current task".
- **Compaction.** A scan line sweeps the tower. Each block flashes its verdict and probability.
  Dropped blocks dissolve, trimmed blocks shrink, the tower collapses and the big token counter
  rolls down.
- **The numbers.** Tokens now, budget, reduction, needle recall, compaction time, questions per
  call, results judged and cost so far.
- **The baseline lane.** A slim second tower runs "summarize instead": when over budget it folds
  the oldest half of its window into one short summary block. It is a simple baseline for
  contrast, scored with the same ground truth. It is not a measurement of any real product.

## How Jev is asked

- `state` = the current task (title and keywords) plus the last few messages.
- One `choice` question per tool result, with the tool name, size and a short preview:
  `keep` (still needed, keep it word for word), `trim` (only the gist matters, keep the head),
  `drop` (irrelevant now). Each option has a description.
- Questions are sent 100 per call, all calls at once. About 100 questions in one call is nearly
  free, which is the point of the demo.
- User and assistant messages are never judged and never touched.
- If the window is still above `target` x `budget` after Jev's verdicts, a pressure pass trims the
  keeps Jev was least sure about, then drops the weakest trims. Pinned blocks are never touched.

## The honest dial

`distraction` (0 to 1) is how much the junk output borrows the current task's words. At 0.12 the
mock run keeps about 98% of needle tokens and cuts about 81% of the window. At 0.5 recall is about
90%. At 0.9 junk looks like the task, Jev keeps much of it, the pressure pass has to squeeze
harder, and recall falls to about 78% with a cut of about 70%. On the same session the "summarize
instead" baseline keeps about 49%. No randomness is injected into the judge.
`test/viewer.test.mjs` proves the gap.

## Play with it

- Task buttons change the current task. The next compaction keeps different blocks.
- Click a block to inspect it: kind, size, preview, Jev's verdict with probability bars and the
  true label. Pin it and it is never dropped.
- Budget and distraction sliders, "Compact now", "Flood +40", pause, step and reset.
- Pane changes are runtime overrides. Any edit to `session.json` puts the file back in charge.

## Anatomy

```
jev-compactor/
  harness.json                 # manifest (engine: claude)
  AGENTS.md                    # instructions for the chat agent
  skills/compactor/SKILL.md    # the craft of designing a session
  template/session.json        # the starter session
  toolchain/
    jev.mjs                    # Jev client (real TypeSafe API, or a deterministic mock)
    check.mjs                  # validates session.json
    viewer.sh setup.sh doctor.sh init-workspace.sh
  viewer/                      # loopback viewer server and the pane
  test/viewer.test.mjs
```

## Jev, honestly

With `TYPESAFE_API_KEY` set, the viewer calls the real API (`POST /v1/systemone`). Without it, a
deterministic local mock answers. The mock reads only what live Jev would get: the state text and
the question text. It counts shared words and looks at the shape of the preview. It is a stand-in
for the plumbing, not for Jev's judgement, and the pane badges it `MOCK`. Times shown on the mock
are the mock's times, not Jev's. Cost is what live Jev would charge for the same input tokens
($0.042 per million input tokens).

## Credit and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness is an OpenHarness wrapper that
  only calls the public API. It contains no TypeSafe code.
- **OpenHarness** (Autonomous) is MIT-licensed. This wrapper is MIT too (see `LICENSE`).
- **You** (Autonomous) built this harness for the OpenHarness store.
