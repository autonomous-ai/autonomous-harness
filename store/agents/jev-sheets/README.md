# Jev Sheets

**A spreadsheet where a column header is a question.** Type `Urgent?` at the top of a column and
Jev, TypeSafe's System One model, answers it for every row. Each answer comes with a probability,
so every cell is shaded by how sure Jev is, and the unsure ones are flagged for a person to review.

This is a harness for OpenHarness. The agent on the right edits `sheet.json`. The viewer on the left
is the sheet. It asks Jev one call per row, with every Jev column as a parallel question in that
call, so a new column fills the sheet in a wave, top to bottom, in about a second.

All the data is made up. The template is 60 inbound sales and support messages for Fernhill Cloud,
a file sync company that does not exist. The names, the messages and the truth labels are synthetic.

## Bring your own file

The starter rows are made up. Put your own `leads.csv` (or `.tsv`, `.jsonl`, `.json`) in the workspace
and set `"source": "leads.csv"` in `sheet.json`. Up to 2,000 rows load, one column becomes the row's
text and the others ride along as fields Jev also reads. Then type any question as a column header.
With a live key that is a few seconds and a fraction of a cent for a question over every row.

## The header grammar

| You type | It becomes |
|---|---|
| `Urgent?` | a yes or no question (`noul`). Ends with a question mark. |
| `Team: billing \| tech \| sales` | a `choice` of 2 to 255 options |
| `Team: billing = payment or invoice problems \| tech = bugs and outages` | the same, with a meaning for each option. This makes Jev sharper. |
| `Anger: calm < annoyed < furious` | a `score` on 2 to 10 ordered levels |
| `Urgency` | a bare word becomes a score: `low < medium < high` |

One parser (`viewer/grammar.mjs`) is used by the viewer, by the pane while you type, and by
`toolchain/check.mjs`.

## What you can do in the pane

- Type a header in the add box and press Enter. The column appears and fills in a wave.
- Click a header to sort by it. Click again to reverse, again to clear. Rows slide to their places.
- Click the small x on a header to remove the column.
- Click a cell to inspect it: the row, the question Jev was asked, the full probability bars, and
  the truth label if there is one.
- Double-click a message to edit it. That row is judged again at once, across all columns.
- Turn on "needs review only", and drag the review line. A small histogram shows where the
  confidence of all cells sits.
- Reset drops everything done in the pane and judges the sheet again from `sheet.json`.

While nobody is playing, a "ghost typist" types a suggested header every 20 seconds or so, lets it
fill, and retires the older demo column. It is tagged "demo". Anything you do rests it for a minute,
and the demo button turns it off.

## The honest dial

The dial is ambiguity. The template has 44 clear rows and 16 rows written with mixed signals on
purpose ("No rush at all, but our production backups have been failing since Monday"). Nothing is
randomised. On the offline mock the tests measure:

- clear rows: average confidence 0.86, 99% right
- mixed rows: average confidence 0.72, 73% right
- cells under the 0.65 review line: 1.5% of clear cells, 44% of mixed cells

So the review line catches the rows a person should look at. Move the line and the count moves.

## Anatomy

```
jev-sheets/
  harness.json               DSH manifest (engine: claude)
  AGENTS.md                  what the chat agent does: build sheets, sharpen questions
  skills/sheets/SKILL.md     the craft of writing rows and questions
  template/sheet.json        the starter sheet (60 made-up messages, 3 Jev columns, truth labels)
  toolchain/
    jev.mjs                  the Jev client (real TypeSafe API, or a deterministic mock)
    check.mjs                validates sheet.json
    viewer.sh setup.sh doctor.sh init-workspace.sh
  viewer/
    viewer.mjs               the server: owns the sheet, the call pool, the cache, the verdict
    grammar.mjs              the header parser, shared with the pane and check.mjs
    mock.mjs                 the offline stand-in reader (reads only the row text and the question)
    kit.mjs                  loopback server, SSE, config watcher, verdict writer
    index.html studio.css studio.js base.css jev-hud.js     the pane
  test/viewer.test.mjs
```

## How it runs

`viewer/viewer.mjs` serves the pane on a loopback port and watches `sheet.json`. For each row with a
missing cell it sends one `evaluate()` call: the row is the state, and every missing Jev column is a
question. Eight calls run at a time. Answers are cached by row text plus column definition, so
adding a column asks only for that column, editing a row asks only for that row, and adding rows
asks only for the new rows. A bad JSON edit keeps the last good sheet on screen and shows the error.

The viewer writes `.harness/verdict.json` itself: cells filled, cells under the review line, the
accuracy of each column against the truth labels, and the weakest rows of each column. The chat
agent reads it to decide which question to sharpen.

With `TYPESAFE_API_KEY` set, the calls go to the real API (`POST /v1/systemone`). Without it, the
harness runs on a deterministic local mock. The mock reads word cues in the row text, so it is a
stand-in for the plumbing and not for Jev's judgement. It paces each call at about 90 ms so the
wave looks like the live one. The pane always shows a MOCK or LIVE badge.

## Jev, honestly

The public claims about Jev are speed and price: about 100 ms per call, and $0.042 per million input
tokens with free output. This harness shows both numbers live, and the cost of filling the whole
template is well under a cent. But the inbox is made up, the truth labels are one person's opinion
about made-up messages, and the accuracy you see offline is the mock's, not Jev's. Treat it as a
demo of a pattern (typed questions over rows, with calibrated confidence and a review line), not as
a measurement of any real support queue.

## Credit and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness is an OpenHarness wrapper that
  only calls the public API. It contains no TypeSafe code.
- **OpenHarness** (Autonomous) is MIT-licensed. This wrapper is MIT too (see `LICENSE`).
- **You** (Autonomous) built this harness for OpenHarness's store.
