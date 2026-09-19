# Jev Sheets in OpenHarness

On the left is a live spreadsheet. Every Jev column header is a question, and **Jev, TypeSafe's
System One model, answers it for every row**. One call per row, all columns at once, each answer
with a probability. Cells are shaded by confidence. Cells under the review line get a "?" flag.
When a row has a truth label, the column header shows how often Jev was right.

On the right, you edit `sheet.json`. This is the ONLY file you edit. The viewer watches it and
reloads the sheet on every save. The viewer is already running in the pane. Never propose opening
a browser, changing ports, or running a second server.

All data in a sheet is made up. Say so in `description`. Never present a sheet as a real inbox,
real customers, real candidates or real advice.

## Your job

1. **Build a sheet on any topic the person asks for.** Write the rows yourself (made-up data), and
   write sharp column questions with a meaning for every option.
2. **Read the results.** The viewer writes `.harness/verdict.json` with the accuracy of each column,
   how many cells sit under the review line, and the weakest rows. Read it. Do not edit it.
3. **Sharpen the wording.** Reword the weakest question, save, and read the verdict again. Only the
   changed column is asked again, so this loop is fast.

## The sheet file

```jsonc
{
  "title": "Fernhill Cloud inbox",
  "description": "Made-up inbound messages for a company that does not exist. All data is synthetic.",
  "context": "Each row is one inbound message to the shared inbox of a made-up file sync service.",
  "textLabel": "Message",          // the heading of the text column
  "reviewBelow": 0.65,             // cells with confidence under this get a ? flag (0 to 1)
  "concurrency": 8,                // calls in flight at once (1 to 32)
  "demo": true,                    // the ghost typist demo loop
  "columns": [
    { "id": "urgent", "header": "Urgent?" },
    { "id": "team", "header": "Team: billing = payment or invoice problems | tech = bugs and outages | sales = pricing and quotes" },
    { "id": "anger", "header": "Anger: calm < annoyed < furious" }
  ],
  "suggestions": ["Wants a refund?", "Churn risk: low < medium < high"],
  "rows": [
    { "id": "m01", "from": "Dana Whitfield", "plan": "pro", "group": "clear",
      "text": "Hi, could you send me a copy of the invoice for March?",
      "truth": { "urgent": false, "team": "billing", "anger": "calm" } }
  ]
}
```

- **`rows`**: 1 to 2000. Each needs a non-empty `text`. Give each a short unique `id`. Any other
  plain field (`from`, `plan`, `channel`) is shown with the row and sent to Jev with the text.
  `group` is a label for you and the pane (`"clear"` or `"mixed"`). It is not sent to Jev.
  `truth` maps a column id to the right answer: `true` or `false` for a yes or no column, the option
  name for a choice, the level name for a score. Truth is optional. It is never sent to Jev.
- **`columns`**: 0 to 12. A column is a header string, or `{ "id", "header" }`. Give columns an `id`
  when rows have truth labels, so you can reword the header and keep the labels lined up.
- **`context`**: one sentence about what a row is. It is put in front of every question.
- **`suggestions`**: headers shown as chips in the pane. The demo loop types them one at a time.

## The header grammar

| Header | Type |
|---|---|
| `Urgent?` | ends with `?`, so it is a yes or no question (`noul`) |
| `Team: billing \| tech \| sales` | `choice`, 2 to 255 options |
| `Team: billing = payment or invoice problems \| tech = bugs and outages` | `choice` with a meaning for each option. Always do this. |
| `Anger: calm < annoyed < furious` | `score`, 2 to 10 ordered levels, lowest first |
| `Urgency` | a bare word is a score with `low < medium < high` |

## Writing sharp questions

- Ask about one thing. "Urgent and angry?" is two questions. Make two columns.
- Give every choice option a meaning in plain words that would appear in a row. Options cannot see
  each other, and Jev cannot see your other columns.
- Name score levels so that each one is easy to tell from the next. Three to five levels work best.
- A yes or no header should read as a full question when the topic is not obvious:
  `Asks for a refund?` beats `Refund?`.
- Put shared facts in `context`, not in every header.

## Making the sheet honest

Write most rows with one clear signal. Then add a block of rows with mixed signals on purpose and
mark them `"group": "mixed"` ("No rush, but production is down"). Jev should be less sure on those,
and the review line should catch them. If confidence is just as high on the mixed rows, or the clear
rows are often wrong, report it. Do not hide it by deleting rows.

## Rules

- Keep `sheet.json` valid JSON. A bad edit does not crash the pane: it keeps the last good sheet and
  shows the error. Fix the file when you see that.
- Validate with `node "$JEV_DSH/toolchain/check.mjs"` before you say you are done.
- Do not edit `.harness/verdict.json`. The viewer writes it. You may read it.
- What a person does in the pane (typed columns, row edits, sort, the review line) is not saved to
  `sheet.json`. If they like a column they typed, add it to `columns` for them.
- Without a `TYPESAFE_API_KEY` the harness runs on a deterministic local mock that reads word cues.
  It is a stand-in for the plumbing, not for Jev's judgement. On the mock, rows must use the same
  words as the option meanings to be read well. With a key, the viewer calls the real API.
- You can ask Jev directly through `toolchain/jev.mjs` (`evaluate`, `jev.noul`, `jev.choice`,
  `jev.score`) to try a question on a few rows before you put it in the sheet.
- This is a demo on made-up data. Keep `title` and `description` truthful.

## Definition of done

- `sheet.json` passes `toolchain/check.mjs`.
- The sheet is on the topic the person asked for, with made-up rows and a mixed-signal block.
- Every choice option has a meaning. Every score has clear levels.
- You have read `.harness/verdict.json` and told the person, in plain words: how right each column
  is, how many cells need review, and which question you would sharpen next.
