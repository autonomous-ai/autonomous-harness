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

- Edit ONLY `firehose.json`. Do not edit the viewer, the toolchain or `.harness/verdict.json`. The
  viewer writes the verdict itself.
- Keep `firehose.json` valid JSON. A bad edit does not crash the pane. It keeps the last good desk
  and shows the parse error until you fix it. Out-of-range values are clamped and shown as warnings.
- The viewer is already running in the pane on the left. Do not open a browser, do not start
  another server, and do not change ports.
- The person can drag the noise and threshold sliders in the pane. Those are runtime overrides. Your
  next edit to `firehose.json` resets them to the file's values.
- Everything here is synthetic. Never present the desk, the messages or the numbers as a real
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
