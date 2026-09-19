# Jev Compactor in OpenHarness

On the left is a live pane. A made-up coding agent works in a made-up repo, and its context window
fills with messages and tool results (Read, Grep, Bash, Edit, WebFetch). When the window passes its
budget, **Jev, TypeSafe's System One model, judges every tool result in one pass**: `keep`, `trim`
or `drop`. The pane applies the verdicts and measures them against a hidden ground truth.

On the right is you. You edit `session.json`. This is the ONLY file you edit. The viewer watches it
and reacts at once.

Everything here is synthetic. It is a demo of an idea, not a real compaction plugin. Never present
the numbers as results for a real agent, a real repo or a real product.

## The session file

```jsonc
{
  "title": "Jev Compactor",
  "description": "One line about this session.",
  "repo": "harbor-pay",          // a made-up repo name
  "seed": 7,                     // same seed, same session
  "budget": 200000,              // tokens. Compaction fires above this. 20000..2000000
  "target": 0.4,                 // after compaction the window must be under target x budget. 0.2..0.9
  "trimTo": 400,                 // a trimmed block keeps this many tokens. 50..5000
  "distraction": 0.12,           // how much junk borrows the current task's words. 0..1
  "recallTarget": 0.9,           // the recall you want to hold. 0.5..1
  "eventsPerSec": 4,             // stream speed. 1..60
  "noise": 0.45,                 // share of tool results that are pure junk. 0..0.9
  "focus": 0.5,                  // share of real results that belong to the current task. 0.1..1
  "taskEvery": 200,              // the made-up user moves to the next task after this many events. 0 = never
  "summaryTokens": 1500,         // size of the baseline's summary block. 200..20000
  "mix": { "user": 1, "assistant": 2, "Read": 7, "Grep": 3, "Bash": 6, "Edit": 3, "WebFetch": 2 },
  "currentTask": "refunds",      // the task the session starts on
  "tasks": [
    { "id": "refunds", "title": "Fix refund rounding in the ledger",
      "vocabulary": ["refund", "ledger", "rounding", "cents", "reversal", "chargeback"] }
  ]
}
```

- **`tasks`** (2 to 12). Each task has an `id`, a `title` and a `vocabulary` of at least 6 single
  words. Tool results and messages for a task are written with its words. Jev only sees text, so
  the vocabulary is how it can tell tasks apart.
- **`distraction`** is the difficulty dial. Low: junk uses junk words, Jev drops it, recall stays
  near 100% and the cut is large. High: junk talks like the current task, Jev keeps it, the window
  stays too big, the pressure pass squeezes harder and needles get lost.
- **`target`** is how hard the compactor must squeeze. If Jev's verdicts leave the window above
  `target` x `budget`, the keeps Jev was least sure about are trimmed, then the weakest trims are
  dropped. A low target means big cuts and more lost needles.
- **`trimTo`** is what a trimmed block keeps. For "gist" results (Grep, Bash, WebFetch) only about
  the first 300 tokens matter, so a `trimTo` under 300 loses needle tokens.
- **`mix`**, **`noise`** and **`focus`** shape the stream: which events arrive, how much is junk,
  and how much of the real work is about the current task.

## Your job

Design the session, then tune it.

1. **Write tasks with sharp vocabularies** for a made-up repo. Words should belong to one task
   only. If two tasks share words, Jev keeps blocks from the wrong task. Try it on purpose once,
   and say what happened.
2. **Set the budget, target, trimTo, distraction and event mix.**
3. **Find good settings**: needle recall stays above `recallTarget` while the reduction is large.
   Read the numbers in `.harness/verdict.json` (the viewer writes it) or ask the person what the
   pane shows. Report the numbers you saw, with the settings that gave them.
4. **Find the edge.** Raise `distraction` until recall falls under the target. Say where it broke.

Do NOT just ship the template. Each session should be its own repo story with a clear finding.

Validate with `node "$JEV_DSH/toolchain/check.mjs"`.

## The person's own transcript

The pane has a second mode. If `session.json` sets `"source"` to a transcript file inside the
workspace, the viewer loads that real session instead of the made-up one. Jev judges every tool
result in it, and the viewer writes what Jev would cut to `compaction-plan.json`.

```jsonc
{ "source": "my-session.jsonl", "trimTo": 400 }   // keep the other keys as they are
```

How to set it up when the person asks for it:

1. **Find the transcript.** Claude Code keeps one `.jsonl` file per session under
   `~/.claude/projects/<project folder>/`. The folder name is the project path with `/` turned into
   `-`. `ls -t ~/.claude/projects/*/*.jsonl | head` lists the newest ones. Ask the person which
   session they mean. Do not guess.
2. **Copy it into the workspace**, for example `cp "<that file>" ./my-session.jsonl`. This copy is
   the one exception to "edit only `session.json`". Copy, never edit, and never touch the original.
   The file must be inside the workspace, not under `.harness`, and at most 64 MB.
3. **Set `"source": "my-session.jsonl"`** in `session.json`. The pane switches to "your transcript",
   shows the whole session as a tower and judges it once on its own.
4. **Read the result** from `compaction-plan.json` (per tool result: index, line, tool, input
   summary, tokens, verdict, probabilities, plus totals) and from `.harness/verdict.json` (the
   totals and the plan's path). Report tokens before and after, the reduction, the counts of keep,
   trim and drop, and the biggest cuts.

Privacy rules. They matter more than anything else in this file:

- **Never paste the transcript's contents into chat.** Do not `cat`, `head`, `grep` or quote it.
  You do not need to read it at all. Work from `compaction-plan.json` and the verdict.
- The plan holds tool names and short input summaries (a file path, a command), never the content
  of a message or a tool result. It is fine to quote the plan.
- Tell the person this before a live run: with a Jev key set, the task message, the last few
  messages, and for each tool result the tool name, its input summary and about the first 300
  characters are sent to the Jev API. With no Jev key on the machine (environment or credentials file)
  nothing leaves it, and the offline mock judges (the pane says `MOCK`). Say which one ran.
- A generic format works too, one JSON object per line:
  `{ "role": "user" | "assistant" | "tool", "name": "Read", "input": "...", "content": "..." }`.

What is different in this mode:

- There is no ground truth. Needle recall, the truth strip and the baseline lane are hidden. Do
  not invent a recall number. Jev's verdict is a suggestion, not a measurement.
- The task is the last user message. The task buttons list the last few user messages. The person
  can pick another one and press "Compact now". Every run starts again from the whole transcript.
- A pinned block is never dropped. A pin on a dropped block brings it back at once.
- `tasks`, `distraction`, `noise`, `focus`, `mix`, `taskEvery` and `target` are not used.
  `trimTo` is. Token counts are estimates: characters / 4.
- It is an analysis of what Jev would cut. It does not change any live session, and it is not a
  compaction plugin. Say so when you report.

## What the person can do in the pane

Task buttons, a budget slider, a distraction slider, "Compact now", "Flood +40", pause, step,
reset, and click-to-inspect with a pin toggle. These are runtime overrides. Any edit you make to
`session.json` resets them, so tell the person when you change the file.

## Rules

- Edit ONLY `session.json` (the one exception: copying the person's transcript into the workspace when they ask, see above). Keep it valid JSON. A bad edit does not crash the demo: the pane keeps
  the last good session and shows the error.
- Never edit `.harness/verdict.json`. The viewer writes it.
- Never propose opening a browser, changing ports or running a second server. The pane is already
  on the left.
- Keep `title`, `description` and task titles truthful. The repo, the tool output and the token
  counts are made up. Say so when you report.
- The "summarize instead" lane is a simple baseline for contrast. Do not describe it as a
  measurement of any real product.
- Without `TYPESAFE_API_KEY`, Jev runs on a deterministic local mock that reads the same text live
  Jev would get. The pane badges it `MOCK`. Its timings are not Jev's timings. Say which one ran.
- You can call Jev yourself through `toolchain/jev.mjs` (`evaluate`, `jev.choice`, `jev.noul`,
  `jev.score`) to try a question before you rely on it.

## Definition of done

- `session.json` parses and passes `toolchain/check.mjs`.
- The tasks are your own, with sharp vocabularies, for a made-up repo.
- You report one settings line that holds recall above the target with a large reduction, and one
  that breaks it, with the measured numbers for both.
