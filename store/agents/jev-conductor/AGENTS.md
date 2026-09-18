# Jev Conductor in OpenHarness

You are curating a live improvisation. On the left, the Jev Conductor viewer runs a bar clock and
asks **Jev — TypeSafe's System One model — to compose the next bar**: a chord, a bass note, a lead
phrase, a mood and an energy level. The viewer scrolls the score and performs it with the Web Audio
API. **You design the "mood language"; Jev improvises in it live.**

On the right, you edit `piece.json`. This is the ONLY file you edit. The viewer watches it and
reshapes Jev's playing live — edit the tempo, moods or scales while it's on and the music changes.

## The workspace

- `piece.json` — the musical constraints Jev improvises within.

```jsonc
{
  "title": "A Cool-Name for the Piece",
  "description": "A subtitle felt in the viewer.",
  "tempo": 96,                  // bpm (30..240). Lower = slower, more spacious.
  "beatsPerBar": 4,             // time signature count (2..8)
  "swing": 0.2,                 // 0..0.9; swing eighth-notes for a jazz lift
  "scale": ["C4","D4","E4","G4","A4"],   // the notes Jev's lead melody uses (3..19, here C pentatonic)
  "bassScale": ["C2","G2","A2","F2"],    // the notes Jev may pick for the bass (2..4)
  "chords": ["Cmaj7","Am7","Fmaj7","G7"],// the harmonic palette Jev chooses between (2..8)
  "moods": ["brooding","hopeful"],       // the emotional labels you want to hear (2..4)
  "leadNotes": 8,               // melody notes per bar
  "volume": 0.6
}
```

Valid scale notes run C4..B5; valid bass notes run C2..C3. `toolchain/check.mjs` validates all of it.

## Your job

Make Jev worth listening to. Real improvisation emerges from the constraints you set:

- **A memorable scale sets the flavor.** A pentatonic major scale (`C4 D4 E4 G4 A4`) sounds
  consonant no matter how Jev strings it; a chromatic scale is deliberate chaos. Pick notes that
  make any order sound like the mood you named.
- **Chords drive the arc.** Give Jev a small harmonic palette with a clear home (start and end on
  the tonic, e.g. `Cmaj7`) so its random walks toward the tonic feel like resolution. Add one
  borrowed or tense chord for color.
- **Moods are the show.** Name 2..4 vivid moods (brooding / hopeful / driving / wistful / electric...).
  The viewer colors each bar by mood; a piece that cycles moods is a story.
- **Tempo and swing set the feel.** Slow + swing = nocturnal; fast = driving.

Do NOT just ship the template unchanged. Every `piece.json` you publish should be a distinct,
worthwhile piece — give it a real title and description, and craft its scales/chords/moods.

You can validate with `node "$JEV_DSH/toolchain/check.mjs"` (parses + range-checks `piece.json`).
The real test is the ear: listen in the viewer. But you don't hear audio — so tune the *design*:
a narrower scale + small consonant chord palette is what produces harmonically coherent improv.

## Keep current

- Keep `piece.json` valid JSON always. A bad edit means Jev freezes on the last good piece until it
  parses again.
- Keep `title` and `description` truthful — no claims the piece isn't.
- When you change mood / scale / tempo, that's the "pause and hear Jev re-invent itself" moment. Say
  so in chat after you save.

## Rules

- Never propose opening a browser, changing ports, or running a second server. The viewer is already
  running on the left; it auto-improves on a clock. The left pane's Play button only unlocks the
  browser's audio (a user gesture is required before Web Audio starts) — the composition itself
  flows regardless.
- Jev is reached through `toolchain/jev.mjs`. You can call it directly to preview your idea before
  committing — for example, to ask Jev which of two chord palettes it thinks is more "electric", or
  to have it sketch a mood arc. Use the `jev` helpers: `noul`, `choice`, `score`. See
  `toolchain/README.md`.
- Without a `TYPESAFE_API_KEY`, Jev runs on a deterministic local mock so everything works offline.
  With one set, the viewer calls the real TypeSafe API automatically.
- The Jev Conductor viewer writes `.harness/verdict.json` itself. Do not edit it.

## Definition of done

- A valid `piece.json` that parses and passes `toolchain/check.mjs`.
- The piece is genuinely worth listening to: a real title + description, a well-chosen scale and
  chord palette, and 2..4 vivid moods.
- The piece has a distinct character (tonal flavor + arc), not the template's default.
