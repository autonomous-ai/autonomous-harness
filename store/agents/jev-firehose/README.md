# Jev Firehose

**Thousands of made-up inbox messages stream in. Jev triages every one in a single call.**

Jev is TypeSafe AI's System One model. It does not write text. You send it a state and a set of
typed questions, and it answers all of them in one pass, each with probabilities. Jev Firehose
shows what that is good for: sorting a lot of small things, fast and cheap.

A seeded generator writes synthetic messages for a support inbox. Each message has a known true
team, so the pane can measure accuracy as it goes. For every message Jev answers five questions in
one call:

| question | type | what it asks |
|---|---|---|
| `team` | choice | which team should own this message |
| `urgency` | score, 5 levels | how fast the sender wants an answer |
| `spam` | noul | is this spam |
| `needs_human` | noul | should a person take over |
| `mood` | score, 3 levels | calm, annoyed or furious |

If Jev's `team` confidence is under the `threshold`, the message is not auto-routed. It drops into
an amber "escalate to a big model" lane. The pane shows how many were auto-routed, how many of those
were right, and how many were escalated.

This is a harness for OpenHarness. The agent on the right edits `firehose.json`. The viewer on the
left watches that file and reacts live.

**All data here is made up.** The shop, the teams and every message are synthetic. This is a demo of
speed, cost and calibration, not a real support system.

## The pane

- **Main scene.** Messages spray from the nozzle as small tiles, coloured by their true team. They
  cross the Jev gate at the height of Jev's confidence, then arc into team bins that fill up. A red
  ring marks a wrong bin. Tiles under the threshold drop into the amber lane.
- **Top bar.** Messages done, messages per second, cost so far, accuracy of auto-routed messages,
  share escalated, elapsed time.
- **The race.** Jev's progress bar, and under it a ghost bar: "a model taking 2s per message would
  be on message N". The 2 seconds is an assumption you can change (`llmSecondsPerItem`).
- **Rail.** Jev's live mind (questions and probability bars), an inspector, a short "how it works",
  and a confusion matrix (true team by routed bin).

Things to try in the pane:

1. Drag the **threshold** slider, or drag the amber line on the gate. Messages that were already
   routed move between the bins and the escalate lane at once.
2. Drag the **noise** slider. New messages get more phrases from a wrong team mixed in.
3. Click a **bin** or a **tile**. The inspector shows the message text, every answer with its
   probabilities, the true team, and right or wrong.
4. Press **Burst +500**.
5. **Pause**, **Step**, **Reset**.

Slider changes are runtime overrides. An edit to `firehose.json` resets them.

When a batch is done the pane shows a summary card for about three seconds, for example
`2,000 messages · 50.0s · $0.0445 · 97.3% right · 10.1% escalated`, then starts the next batch with a
new seed. It never stops.

## The honest dial

`noise` (0 to 1) sets how many phrases from one wrong team are mixed into each message. It is capped
so a message never has more wrong-team phrases than true ones. At low noise the true team is clear.
At high noise every message is an even split, so any reader, model or person, has to guess.

Measured on the starter desk with the offline stand-in, threshold 0.55, 400 messages each:

| noise | auto-routed right | escalated |
|---|---|---|
| 0.05 | 99.5% | 2.5% |
| 0.85 | 58.4% | 24.3% |

Nothing random is injected into Jev's answers. The messages themselves get harder.

## Anatomy

```
jev-firehose/
  harness.json                  manifest (engine: claude)
  AGENTS.md                     instructions for the chat agent
  skills/firehose/SKILL.md      how to design a desk and pick a threshold
  template/firehose.json        the starter desk (a made-up lamp shop, 8 teams)
  toolchain/
    jev.mjs                     Jev client: real API with a key, offline stand-in without
    check.mjs                   validates firehose.json
    measure.mjs                 scores a desk from the command line, threshold by threshold
    viewer.sh setup.sh doctor.sh init-workspace.sh
  viewer/                       loopback server (viewer.mjs, kit.mjs) and the pane
  test/viewer.test.mjs
```

## Jev, honestly

With `TYPESAFE_API_KEY` set, every message is one real call to `POST /v1/systemone`. Without a key
the harness runs on a deterministic offline stand-in that scores shared words between the message
and each option's description. The stand-in is there so the plumbing, the pane and the tests work
offline. It is **not** Jev's judgement, and the pane badges it `MOCK`. The cost shown is what live
Jev would charge for the same tokens ($0.042 per million input tokens, output free).

The "2s per message" comparison is an assumption drawn as a ghost bar, not a measurement of any
model.

## Credit and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness only calls the public API. It
  contains no TypeSafe code.
- **OpenHarness** (Autonomous) is MIT-licensed. This wrapper is MIT too (see `LICENSE`).
- **Autonomous** built and maintains this harness for the OpenHarness store.
