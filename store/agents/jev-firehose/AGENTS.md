# Jev Firehose in OpenHarness

On the left is a live pane. A seeded generator writes **made-up** messages for a support inbox and
sprays them through a gate. **Jev, TypeSafe's System One model, triages every message in one call**
with five parallel questions: `team` (choice), `urgency` (score), `spam` (noul), `needs_human`
(noul), `mood` (score). If Jev's `team` confidence is under the threshold, the message drops into
an amber "escalate to a big model" lane instead of a team bin. Every message has a known true team,
so the pane measures accuracy live.

On the right is you. **You edit one file: `firehose.json`.** The viewer watches it and restarts the
batch with your settings within a second. All data is synthetic. Say so when you describe it.

## Your job: design the taxonomy

You are the desk designer. A good session looks like this:

1. **Invent a desk.** A game studio's player support, a bike shop, a city help line, a vet clinic, a
   library. Pick one and give it a made-up name in `desk`. Say it is made up.
2. **Write the teams.** 2 to 24 of them. Each team needs a sharp `description` and at least 4
   `phrases` (8 to 12 is better). See "Writing teams" below.
3. **Tune `noise` and `threshold`.** Noise makes messages harder. The threshold trades accuracy for
   escalations.
4. **Find the threshold** where auto-routing stays above `targetAccuracy` while escalations stay
   low. Report the number and what it costs in escalations.

Do not ship the starter desk with a new title. Build a desk with its own teams.

## The file

```jsonc
{
  "title": "Jev Firehose",
  "desk": "Lumen Lane, a made-up online lamp shop. Every message is synthetic.",
  "noise": 0.2,              // 0..1   wrong-team phrases mixed into each message (the difficulty dial)
  "threshold": 0.55,         // 0..1   team confidence under this goes to the escalate lane
  "targetAccuracy": 0.95,    // 0.5..1 the accuracy you want for auto-routed messages
  "ratePerSec": 40,          // 1..400 messages started per second
  "concurrency": 8,          // 1..64  calls in flight at once
  "batch": 2000,             // 50..100000 messages per batch, then a summary card, then a new seed
  "llmSecondsPerItem": 2,    // 0.1..120 the assumed speed of a slow model, drawn as a ghost bar
  "spamRate": 0.07,          // 0..0.5 share of messages that are spam
  "seed": 7,                 // whole number; the same seed gives the same stream
  "teams": [
    {
      "id": "billing",       // short, unique, shown on the bin
      "description": "Payment: card charged, invoice, refund, receipt, price, tax, discount voucher.",
      "weight": 1.5,         // optional 0.1..10, how common this team is
      "phrases": ["my card was charged twice for the same payment", "..."]
    }
  ]
}
```

How a message is made: an opener (carries the mood), 1 to 3 phrases from the TRUE team, then
`floor(noise * 3 + random)` phrases from ONE wrong team (never more than the true ones), then a
closer (carries the urgency). Some messages are spam.

## Writing teams

Jev sees only the message and, for each team, its `id` and `description`. It does not see the
phrases list. So:

- **Descriptions are the contract.** Name the things the team handles with plain nouns:
  "Delivery: parcel, courier, tracking, late, lost, package, shipping address, customs."
- **Phrases must sound like that description.** Each phrase should use two or three of the
  description's words. "the courier lost the package during delivery" is good. "where is my stuff"
  is not.
- **Keep teams apart.** If two descriptions share words, they will be confused. Sometimes that is
  what you want to show. Do it on purpose, and say so.
- Write phrases the way a customer would, lower case, no full stop. The generator adds those.
- Avoid words the other questions use: urgent, today, emergency, manager, lawyer, complaint, angry,
  furious, prize, winner, free gift.

Without a `TYPESAFE_API_KEY` the harness runs on an offline stand-in that matches shared words. It
is strict about exact words ("invoice" and "invoices" do not match). `check.mjs` warns about phrases
that will not route. With a key, live Jev reads meaning, and sharp descriptions still help.

## The person's own messages

The person can drop a file of their own messages into the workspace and have Jev triage all of it.
Then the pane says "your data", the generator is off, and the viewer hands back `triage.csv`.

```jsonc
{
  "title": "Support inbox, March",
  "desk": "The person's own support inbox.",
  "source": "inbox.jsonl",        // .csv, .tsv, .jsonl or .json, INSIDE the workspace, up to 8 MB and 20,000 messages
  "textColumn": "body",           // optional. Left out, the viewer picks text, message, body, ... or the longest column
  "threshold": 0.55,
  "ratePerSec": 40, "concurrency": 8,
  "teams": [ { "id": "billing", "description": "Payment: card charged, invoice, refund, receipt." } ]
}
```

With `source` set, `teams[].phrases` are optional, and `noise`, `batch`, `spamRate` and `seed` are
ignored. The file is processed once. There is no answer key, so there is **no accuracy** in this
mode: the pane shows the confidence histogram, the share escalated and the count per team.

How to work:

1. **Read the header first.** `head -n 3 inbox.csv` (or the first 3 lines of a jsonl). Find the
   text column and the id column. Do not read the whole file into the chat.
2. **Look at a small sample**, about 20 to 30 messages, to learn what is really in it. Design the
   teams from that. Do not reuse the starter desk.
3. Write the teams: `id` and a sharp `description` each. Set `source`, and `textColumn` if the
   viewer would guess wrong.
4. `node "$JEV_DSH/toolchain/check.mjs"` loads the file the way the viewer will and tells you the
   text column, the id column and the message count.
5. `node "$JEV_DSH/toolchain/measure.mjs"` samples the file and prints the split at each threshold,
   plus the ids of the least confident messages and the two teams each one sits between. Look those
   ids up, then sharpen those two descriptions. It prints ids, never the text.
6. Tell the person where the file is. `.harness/verdict.json` has a `triage` block: `path`, `file`
   (absolute), `complete`, `messages`, `done`, `autoRouted`, `spam`, `escalated`, `threshold`, and
   the count per team.

`triage.csv` has one line per message, in the order of the person's file: `id` (their id column, or
the row number), `team`, `team_confidence`, `urgency` (no_rush, this_week, today, urgent,
emergency), `spam`, `needs_human`, `mood` (calm, annoyed, furious), `escalated`, then their own
columns exactly as they were. A column of theirs called `team` comes back as `source_team`. The
viewer rewrites the file about once a second while it works, once at the end, and again whenever
the threshold moves.

**Never copy the person's data around.**

- Do not paste their messages into `firehose.json`. Teams are described in your words, not theirs.
- Do not write copies, samples or extracts of their file anywhere. The viewer is the only thing
  that writes, and it writes `triage.csv` next to their file.
- Quote as little of their text in the chat as you can. Use ids.
- Do not send their file anywhere. With a Jev key, the viewer sends **only the text column** to the
  Jev API, one message per call. Every other column stays on this machine. Without a key nothing
  leaves the machine. Say this to the person before a run with a key.
- Without a key the offline stand-in only matches words, so its triage of real messages is rough.
  Say so. Never call any number in this mode accuracy.

## Measure, do not guess

```bash
node "$JEV_DSH/toolchain/check.mjs"            # ranges, team shape, vocabulary warnings
node "$JEV_DSH/toolchain/measure.mjs"          # accuracy and escalations at each threshold
node "$JEV_DSH/toolchain/measure.mjs" --noise 0.6 --n 1000
```

`measure.mjs` uses the same generator and the same five questions as the pane. It prints a table,
the lowest threshold that meets `targetAccuracy`, and the most confused team pairs. With a key it
makes real calls (600 messages cost about one cent). You can also read `.harness/verdict.json` for
the numbers of the batch now running in the pane.

Report what you find, including bad news. If no threshold reaches the target at your noise, say so.
If two teams are always confused, fix the descriptions or say why you kept them.

## Rules

- Edit ONLY `firehose.json`. Do not edit the viewer, the toolchain, `.harness/verdict.json` or
  `triage.csv`. The viewer writes the verdict and the results file itself.
- Keep `firehose.json` valid JSON. A bad edit does not crash the pane. It keeps the last good desk
  and shows the parse error until you fix it. Out-of-range values are clamped and shown as warnings.
- The viewer is already running in the pane on the left. Do not open a browser, do not start
  another server, and do not change ports.
- The person can drag the noise and threshold sliders in the pane. Those are runtime overrides. Your
  next edit to `firehose.json` resets them to the file's values.
- Unless `source` is set, everything here is synthetic. Never present the desk, the messages or the numbers as a real
  company, real customers or a real benchmark. The "2s per message" ghost bar is an assumption, not
  a measurement of any model.
- The `MOCK` badge means the offline stand-in is answering. Do not describe its numbers as Jev's
  accuracy.

## Definition of done

- `firehose.json` passes `check.mjs` with no errors, and you have read the warnings.
- The desk is your own: a made-up name, teams with sharp descriptions, at least 4 phrases each.
- You ran `measure.mjs` and can state: accuracy and escalations at your threshold, and the lowest
  threshold that meets the target.
- You told the person what to try in the pane: drag the threshold, raise the noise, click a bin.
