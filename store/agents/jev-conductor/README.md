# Jev Conductor

**Jev — TypeSafe's System One model — is the composer.** It improvises a live piece bar by bar:
choosing chords, bass notes, lead melodies, mood and energy in real time. The viewer rolls out the
score as a scrolling marquee and performs it with the Web Audio API, so you watch a decision model
write music and hear it play. You design the "mood language" (scales, tempo, chords, moods); Jev does
the actual improvising — and nothing it plays is pre-scripted.

This is a harness for OpenHarness. The agent on the right edits `piece.json`; the viewer on the left
runs a bar clock and asks Jev for the next bar's music. No text generation — just fast, calibrated
decisions rendered as sound.

## Anatomy

```
jev-conductor/
  harness.json             # DSH manifest (engine: claude)
  AGENTS.md                # tells the agent to curate a mood language Jev can improvise in
  skills/conductor/SKILL.md# the composition + verification craft
  template/piece.json      # a starter piece ("Jev in Blue")
  toolchain/
    jev.mjs                # the Jev client (real TypeSafe API + deterministic mock)
    viewer.sh              # launches the viewer
    check.mjs              # validates piece.json
    setup.sh / doctor.sh / init-workspace.sh
  viewer/                  # the loopback viewer server + pane (Web Audio)
```

## The viewer

`viewer/viewer.mjs` runs a bar clock and asks Jev, for each bar, to pick a chord, a bass note, a
lead phrase, a mood and an energy level. It calls `POST /v1/systemone` to TypeSafe when
`TYPESAFE_API_KEY` is set; without a key it uses a deterministic local mock (offline + testable). It
streams each bar over SSE to the pane, which renders the scrolling score and performs it with Web
Audio. `.harness/verdict.json` tracks progress (bars written, current mood).

## Jev, honestly

Jev is new and early-access. Its headline claims (speed, calibration, "can't hallucinate") are mostly
vendor-reported, and the mock in this harness is a stand-in for *plumbing*, not judgement. The music
Jev writes is genuinely improvised in real time, but it is as good as its design constraints — a
narrower scale and chord pool produce more coherent (if predictable) phrasing. Treat Jev's decisions
as a fast, cheap creative signal and design the constraints well.

## Credit and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness is an OpenHarness wrapper that
  only calls the public API; it contains no TypeSafe code.
- **OpenHarness** (Autonomous) is MIT-licensed; this wrapper is MIT too (see `LICENSE`).
- **You** (Autonomous) built this harness for OpenHarness's store.

_Show, don't tell: this harness makes Jev's "System One" model audible — a decision model you can
listen to, improvising in real time._
