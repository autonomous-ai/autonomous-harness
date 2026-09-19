---
name: jev-compactor
description: Design and tune a Jev Compactor session. Use when editing session.json, writing task vocabularies, or looking for settings where needle recall holds while the reduction is large.
---

# Craft: Jev Compactor

Jev Compactor runs a made-up coding-agent session and lets Jev compact its context window. Your
craft is the session design: tasks Jev can tell apart, and settings with a clear, honest finding.
Everything is synthetic. It is a demo of the idea, not a real compaction plugin.

## The decision

When the window passes `budget`, the viewer sends Jev:

- `state`: the current task (title and keywords) and the last few messages.
- one `choice` question per tool result, 100 per call:

```
[Read] src/refund/ledger_cents.ts · 4,210 tokens. Preview: «export function apply_refund(...) { ... }»
Is this tool result still needed for the current task?
  keep  still needed, keep it word for word
  trim  only the gist matters now, keep the head
  drop  irrelevant now
```

Questions cannot see each other. Jev judges each block from its own text and the shared state.
Messages are never judged.

## Ground truth

Every tool result secretly belongs to one task, or is junk. For the current task:

- Read and Edit results are **detail** needles. Every token counts. Ideal verdict: keep.
- Grep, Bash and WebFetch results are **gist** needles. About the first 300 tokens count. Ideal
  verdict: trim.
- Everything else (other tasks, junk) is not needed. Ideal verdict: drop.

**Needle recall** = needed tokens that survived / needed tokens before. **Junk removed** = the same
for tokens that were not needed. About 4% of real results have a preview that only shows
boilerplate, so even an easy session is not perfect. That is a real limit, not noise.

## The knobs

| knob | what it does | try |
|---|---|---|
| `tasks[].vocabulary` | the words Jev can tell tasks apart by | 8 to 12 single words, no word in two tasks |
| `distraction` | how much junk borrows the current task's words | 0.1 easy, 0.5 hard, 0.9 very hard |
| `target` | the window must end under target x budget | 0.4 default, 0.3 squeezes hard, 0.6 is gentle |
| `trimTo` | tokens a trimmed block keeps | 400 default, under 300 starts to lose gist needles |
| `budget` | when compaction fires | 200000 default, 1000000 for a long session |
| `noise`, `focus`, `mix` | how much junk, how much on-task work, which events | more junk means bigger cuts |
| `taskEvery` | events before the made-up user moves on | 0 keeps one task forever, which fills the window with needles |

## What to expect (mock, default tasks, 1500 events)

| distraction | needle recall | junk removed | reduction |
|---|---|---|---|
| 0.12 | about 98% | about 97% | about 81% |
| 0.3 | about 96% | about 86% | about 72% |
| 0.5 | about 90% | about 82% | about 70% |
| 0.9 | about 78% | about 78% | about 70% |

The "summarize instead" baseline keeps about 49% of needle tokens on the same session.

Why recall falls: junk that talks like the task gets kept. The window stays above the target, so
the pressure pass trims the keeps Jev was least sure about. Some of those are real needles.

## A good tuning loop

1. Write the tasks. Run `node "$JEV_DSH/toolchain/check.mjs"`.
2. Start easy (`distraction` 0.1). Let a few compactions run. Read `.harness/verdict.json`:
   the summary has recall and reduction, the findings have cost, calls and the baseline.
3. Raise `distraction` in steps of 0.2. Note where recall crosses `recallTarget`.
4. At that edge, try one fix at a time: a higher `target`, a bigger `budget`, a bigger `trimTo`,
   sharper vocabularies. Say which one helped and what it cost in reduction.
5. Try one bad idea on purpose: give two tasks the same words. Watch Jev keep the wrong task's
   blocks. Report it.

## Reporting

Give the settings and the measured numbers together, for example:
"distraction 0.3, target 0.4, trimTo 400: recall 96%, reduction 76% over 12 compactions, mock."
Always say it is a synthetic session, and whether the mock or live Jev ran. Never describe the
"summarize instead" lane as a real product. It is a simple baseline for contrast.

## Definition of done

- `session.json` passes `check.mjs`.
- Your own tasks and repo name, not the template's.
- One settings line that holds the recall target with a large reduction, and one that breaks it,
  both with numbers.
