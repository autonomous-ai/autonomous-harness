# Craft: Jev Sheets

Jev Sheets is a spreadsheet where a column header is a typed question and Jev answers it for every
row. The craft has two halves: writing rows that feel real, and wording questions so the answers
are right and the confidence is honest. All rows are made up. Say so in `description`.

## How one row is judged

For each row the viewer makes ONE call. The state is the row (its `text` plus plain fields like
`from` or `plan`). The questions are all the Jev columns, asked in parallel. Questions cannot see
each other, and nobody sees `truth` or `group`.

```
state      { "text": "You charged my card twice. Refund it today.", "plan": "pro" }
questions  urgent  noul    "Urgent?"
           team    choice  billing = payment or invoice problems | tech = bugs and outages | sales = ...
           anger   score   calm < annoyed < furious
answers    urgent  0.86    team  billing (0.84)    anger  annoyed (0.79)
```

Answers are cached by row text plus column definition. So after an edit to `sheet.json`, only the
cells that changed are asked again. Rewording one header refills one column.

## The header grammar

```
Urgent?                                          yes or no   (ends with ?)
Team: billing | tech | sales                     choice      (2 to 255 options)
Team: billing = invoices, refunds | tech = bugs  choice with meanings  (always prefer this)
Anger: calm < annoyed < furious                  score       (2 to 10 levels, lowest first)
Urgency                                          score       (bare word: low < medium < high)
```

In `sheet.json` a column is a header string or `{ "id": "team", "header": "Team: ..." }`. Use an
`id` whenever rows carry `truth`, so rewording the header does not orphan the labels.

## Building a sheet on a new topic

1. Pick the unit of a row (a message, a review, an application, a bug report) and write `context`
   in one sentence.
2. Write 40 to 200 rows of made-up text, one to three sentences each. Vary length, tone and who is
   writing. Add one or two plain fields if they help (`from`, `plan`, `channel`, `stars`).
3. Write three to five columns. Mix the types: one yes or no, one choice, one score.
4. Label `truth` for the starter columns on every row. It is what lets the pane show accuracy.
5. Write a block of mixed-signal rows, about a quarter of the sheet, and mark them
   `"group": "mixed"`. Mark the rest `"group": "clear"`. Good mixed rows pull two ways at once:
   polite words with an angry point, "no rush" with an outage, a billing question inside a sales
   request.
6. Add six to ten `suggestions`: more headers a person could try on the same rows.
7. Run `node "$JEV_DSH/toolchain/check.mjs"`.

## Working on the person's own file

Set `"source": "<file in the workspace>"` (csv, tsv, jsonl or json) and optionally `"textColumn"`.
Read the file's header and a few rows first. Write columns about what is really there. The other
columns are part of what Jev reads for each row, so questions can lean on them ("Worth a call
today?" can use a `seats` column). There are no truth labels, so judge the questions by the review
count and by reading the flagged rows in the verdict.

## Reading the verdict

The viewer writes `.harness/verdict.json`. Read `sheet.columns[]`:

```jsonc
{ "id": "team", "accuracy": 0.93, "labelled": 60, "underReviewLine": 11, "avgConfidence": 0.78,
  "weakest": [ { "row": "x56", "text": "Before we sign for 200 seats, legal needs...",
                 "answered": "tech", "confidence": 0.47, "truth": "sales" } ] }
```

and `sheet.groups` for the average confidence of clear rows against mixed rows.

- **Low accuracy on clear rows** means the question is unclear. Look at the weakest rows. Usually
  two options overlap, or an option has no meaning written down. Reword and save.
- **Many cells under the review line on clear rows** means the options are too close together, or a
  score has too many levels. Merge or rename them.
- **Mixed rows as confident as clear rows** means the mixed rows are not really mixed. Rewrite them
  so the two signals are about equally strong.
- **A confident wrong answer** is the most useful row in the sheet. Tell the person about it.

Change one column at a time, save, and read the verdict again. Report what moved.

## The offline mock

Without `TYPESAFE_API_KEY`, a local mock answers. It counts word cues: the words of the header, the
option names and their meanings, plus a small built-in list for common ideas (urgency, anger,
billing, bugs, sales, refunds, churn, sentiment, spam, security). It knows nothing else. On the
mock, a column only works if the rows use words that the option meanings also use. So write
meanings with the words a row would really contain. The pane badges the mock as MOCK, and its
accuracy says nothing about live Jev.

## Definition of done

- `sheet.json` passes `check.mjs`.
- Made-up rows on the asked topic, with a mixed-signal block and truth labels.
- Every choice option has a meaning. Scores have clear, ordered levels.
- You read the verdict and reported: accuracy per column, cells under the review line, the average
  confidence of clear against mixed rows, and the next question you would sharpen.
