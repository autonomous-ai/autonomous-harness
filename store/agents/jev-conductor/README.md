# Jev Conductor

**Jev is the composer.** Jev is TypeSafe's System One decision model. It never writes text. It
answers typed questions with probabilities, fast. Here it improvises a tune one bar at a time, and
the pane plays it.

This is a harness for OpenHarness. The agent on the right edits `piece.json`. The viewer on the
left runs the bar clock and asks Jev for every bar. The tune is made up. The decision loop is the demo.

## The pane

- **A scrolling piano roll.** Notes slide under a fixed playhead. A note turns white and throws
  sparks as it sounds. The bass has its own lane below. The note names on the left light up.
- **Jev's mind is on the roll.** Around every note Jev picked you see the other notes it weighed,
  as faint blocks. The stronger the block, the higher the probability. Each picked note carries its
  own probability as a small number.
- **Chord blocks** run along the top, coloured by the mood of the bar, with the chord name, the bar
  number and how sure Jev was. The whole stage takes the colour of the mood.
- **Energy meter** on the right follows the energy Jev chose for the bar and jumps on the beat.
- **Spectrum.** With the sound off it is drawn from the notes that are sounding. With the sound on
  it is live from the speakers, with the waveform on top. The pane says which one you are seeing.
- **The top bar** shows decisions per second, answers so far, and cost so far, next to the bar
  number, the notes written, the harmony flow and the mood flicker.
- **Sound stays off until you click "Sound on".** Browsers require that. Everything on the stage
  runs without sound.
- **It never stops.** Jev writes a bar on every bar of the clock, for as long as the pane is open.

## Things you can do in the pane

| Do this | What happens |
|---|---|
| A mood button | The mood is written into the text Jev reads as "The audience asked for: …". Jev writes two new bars at once and the pane cuts over to them on the next beat. |
| **no request** | Takes the request away. Jev picks the moods itself again. |
| **Tempo** slider | 40 to 220 bpm. |
| **Memory** slider | How many of its own last bars Jev can read, 0 to 8. Jev writes two new bars at once. |
| **Instrument** Keys, Pluck, Pad | Changes the lead sound. Notes that have not sounded yet are re-voiced, so you hear it at once. |
| **One more bar** | Jev writes a bar right now. It works while paused too. |
| Sound on, Pause, Reset | Turn the sound on or off, stop the clock, or start the piece again from `piece.json`. |

The sliders and the request are for this session. An edit to `piece.json` resets the sliders.

## How Jev writes a bar

Two calls a bar. The first asks three questions: the `chord`, the `mood` and the `energy`. The
second has the chosen chord written into its text and asks for the `bass` note and **every lead
note**, one typed question per note (`lead1` to `lead8`), all in one call. Each lead question can
also answer `rest`. That is 12 typed answers a bar at the starter settings.

## The honest dial: memory

`memory` is how many of its own last bars the text shows Jev. With a few bars in view Jev can
follow each chord with one that leads on from it, hold a mood through a phrase, and start each lead
phrase near where the last one ended. At 0 the text says "You do not remember the bars you wrote
before", so it cannot. Nothing random is added. The only thing that changes is what Jev is told.

Measured with the offline stand-in over 600 bars each:

| memory | harmony flow | repeated chords | mood changes nobody asked for | chord confidence |
|---|---|---|---|---|
| 4 bars | 1.00 | 0% | 25% | 0.62 |
| 0 bars | 0.70 | 17% | 67% | 0.47 |

Harmony flow is the share of chord changes where the root moves up a fourth or fifth, down a third,
or up a step. A short stretch can look tidy by luck even at memory 0, because the starter piece has
only four chords in one key. Judge it over a minute, or watch the mood flicker, which shows at once.

## piece.json

```jsonc
{
  "title": "Jev in Blue",
  "description": "A tune Jev composes live.",
  "tempo": 96,                          // bpm, 30 to 240
  "beatsPerBar": 4,                     // 2 to 8
  "swing": 0.2,                         // 0 to 0.9
  "scale": ["C4", "D4", "E4", "G4", "A4"],       // lead notes, C4 to B5
  "bassScale": ["C2", "G2", "A2", "F2"],         // bass notes, C2 to C3
  "chords": ["Cmaj7", "Am7", "Fmaj7", "G7"],     // the first one is the home chord
  "moods": ["brooding", "hopeful", "driving"],
  "leadNotes": 8,                       // lead slots per bar, 2 to 16. Jev picks every one.
  "volume": 0.6,
  "memory": 4                           // bars of its own music Jev can read, 0 to 8
}
```

A bad edit never stops the music. The viewer keeps the last good piece and shows the error in the pane.

## Anatomy

```
jev-conductor/
  harness.json                 the manifest (engine: claude)
  AGENTS.md                    tells the chat agent how to shape a piece worth hearing
  skills/conductor/SKILL.md    the composing and checking craft
  template/piece.json          the starter piece
  toolchain/
    jev.mjs                    the Jev client (real TypeSafe API, or the offline stand-in)
    check.mjs                  checks piece.json
    viewer.sh, setup.sh, doctor.sh, init-workspace.sh
  viewer/
    viewer.mjs                 the loopback server and the bar clock
    music.mjs                  the piece, the text Jev reads, and how the tune is measured
    mock.mjs                   the offline stand-in's reader. It reads only the text Jev gets.
    index.html, studio.css, studio.js, jev-hud.js   the pane
  test/viewer.test.mjs
```

The viewer calls `POST /v1/systemone` at TypeSafe when `TYPESAFE_API_KEY` is set. Without a key it
uses the offline stand-in, so everything runs offline and in tests, and the pane shows a `MOCK`
badge. It writes `.harness/verdict.json` itself.

## Jev, honestly

Jev is new and in early access. Its headline claims mostly come from the vendor. The offline
stand-in is for the plumbing, not for taste: it prefers chords that follow the last one in a common
progression, keeps a mood for a phrase, puts chord tones on strong beats and shapes the phrase by
the mood, all from what the text tells it. It is a simple rule reader, not a musician. How musical
the real model is, is for you to hear with a key set.

## Credit and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness only calls the public API. It
  contains no TypeSafe code.
- **OpenHarness** (Autonomous) is MIT-licensed. This harness is MIT too (see `LICENSE`).
- **Autonomous** built this harness for the OpenHarness store.
