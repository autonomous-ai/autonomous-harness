# Craft — Jev Firehose

Jev Firehose is a triage demo on made-up data. Thousands of synthetic inbox messages stream in. Jev
answers five typed questions about each one in a single call. Messages with low `team` confidence
are escalated instead of auto-routed. Your craft is the desk: the teams, their words, the noise and
the threshold.

## The decision, per message

One `evaluate()` call. The state is the message text. The questions:

```
team         choice   one option per team, each with its description
urgency      score    5 levels, "no rush" to "emergency"
spam         noul
needs_human  noul
mood         score    3 levels, calm to furious
```

Routing rule, in this order:

1. `spam` is 0.5 or more: the message goes to the spam bin.
2. `team` confidence is under `threshold`: it goes to the escalate lane.
3. Otherwise it goes to the bin of the chosen team.

A routed message is right when its bin matches its true team (or it is spam in the spam bin).
Accuracy counts auto-routed messages only. Escalated ones are counted apart.

## The honest dial: `noise`

`noise` adds `floor(noise * 3 + random)` phrases from ONE wrong team to each message, never more
than the number of true phrases (1 to 3).

- `0.05`: almost every message is clean. Expect 99% right and 2 to 4% escalated on the starter desk.
- `0.2`: the starter setting. About 97% right, 10% escalated at threshold 0.55.
- `0.5`: many messages are half about another team. About 80% right, 19% escalated.
- `0.85`: nearly every message is an even split. About 60% right, 25% escalated.

Nothing random is added to Jev's answers. The messages get more mixed, so the right answer gets
less clear. A person would struggle too.

## The threshold trade-off

Raising `threshold` sends more messages to the big model and makes the rest more accurate. The pane
draws this curve above the threshold slider (green is accuracy, amber is the escalated share).
`measure.mjs` prints the same thing as a table:

```
threshold   right   escalated
   0.40      93.5%     0.7%
   0.55      97.6%    10.3%   <- threshold in the file
   0.70      99.4%    19.0%
lowest threshold with at least 95.0% right: 0.46 (95.5% right, 4.2% escalated)
```

Pick the lowest threshold that meets `targetAccuracy`. If escalations at that point are too high,
the fix is the desk (sharper descriptions, less overlap), not the threshold.

At high noise no threshold may reach the target without escalating most of the stream. That is a
finding. Report it.

## Writing a desk that routes

Jev gets each team's `id` and `description`, never the phrases. So write them as a pair:

```jsonc
{
  "id": "brakes",
  "description": "Brakes: pads, rotor, lever, squeal, hydraulic bleed.",
  "phrases": [
    "my brake lever is soft after the bleed",
    "the rotor rubs the pads and there is a squeal",
    "new pads but the lever still pulls to the bar",
    "hydraulic bleed needed, the brakes feel spongy"
  ]
}
```

- 6 to 10 plain nouns in the description. No filler words.
- Every phrase uses two or three of those nouns, in the same form (the offline stand-in does not
  match "invoice" with "invoices").
- No noun shared between two descriptions, unless you want that pair to be confused.
- 8 to 12 phrases per team gives varied messages. 4 is the minimum.
- Use `weight` to make some teams busier than others. Bins then fill at different speeds.
- Keep ids short. They are the labels on the bins.

`check.mjs` warns when a phrase shares fewer than 2 words with its own description, when a phrase
leans toward another team, and when two descriptions share 3 or more words.

## A good session

1. Write the desk. Run `check.mjs`. Fix errors, read warnings.
2. Run `measure.mjs` at your noise. Look at the most confused pairs. Sharpen those descriptions.
3. Set `threshold` to the lowest value that meets the target. Run `measure.mjs` again.
4. Try `--noise 0.6`. Say how the desk degrades.
5. Tell the person what you found and what to poke in the pane.

## Verifying

```bash
node "$JEV_DSH/toolchain/check.mjs"
node "$JEV_DSH/toolchain/measure.mjs" --n 800
```

Then watch the pane: bins fill, the accuracy number settles near what `measure.mjs` printed, and the
confusion matrix lights up on the pairs you expected.

## Definition of done

- `firehose.json` passes `check.mjs`.
- The desk is your own and says it is made up.
- You can state accuracy and escalations at your threshold, and the lowest threshold that meets the
  target, from a measurement and not from a guess.
