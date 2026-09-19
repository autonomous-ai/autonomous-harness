---
name: jev-conductor
description: Curate a live Jev improvisation in OpenHarness's viewer, where Jev composes chords, bass and melody bar by bar in real time.
---

# Jev Conductor composition

Jev Conductor shows a live scrolling score: Jev (TypeSafe's System One model) picks the next bar's
chord, bass note, lead phrase, mood and energy on a bar clock, and the pane performs it with Web
Audio. The agent curates `piece.json` — the musical constraints Jev improvises within.

## The loop

1. Update `piece.json`. The viewer watches it and reshapes Jev's playing live — no restart, no
   second server.
2. `node "$JEV_DSH/toolchain/check.mjs"` verifies the workspace's `piece.json` is valid and
   range-checked, and reports the current verdict. Run it before you call a piece done.
3. Listen (or reason about the design): a narrow consonant scale + small harmonic palette yields
   coherent improv; a wide or chromatic scale yields chaos. Name the moods you want to hear.

## Reading Jev

The viewer colors each bar by mood and shows Jev's choices (chord, bass, lead, mood, energy).
Because Jev's *choice* questions return a probability distribution, `jev.mjs`'s mock and the real
model both pick a `choice` — but what matters musically is the *constraint design*: a strong tonic,
a small consonant scale, vivid mood labels. Design those well and any path Jev walks sounds like
music.

## Verifying a piece

`node "$JEV_DSH/toolchain/check.mjs"` returns non-zero when `piece.json` is invalid (bad notes, out
of range, empty palettes). It does not replace judging the *music*. The real test is coherence: with
a tonic-centered chord list and a consonant scale, Jev's random walks resolve; with a giant
chromatic scale they won't.

## Driving Jev yourself

`toolchain/jev.mjs` exports a small client. Example (from the workspace) — audition a chord palette
before you commit to it:

```bash
node --input-type=module -e '
import { evaluate, jev } from "$JEV_DSH/toolchain/jev.mjs";
const res = await evaluate({
  state: "You are scoring mood music. Palette A resolves to the tonic; palette B is all tension.",
  questions: {
    electric: jev.score({0:"flat",1:"alive",2:"electric"}, "How electric is this palette to improvise in?"),
    cohesive: jev.noul("Will random walks through this palette sound cohesive?"),
  },
});
console.log(JSON.stringify(res.answers, null, 2));
'
```

Without `TYPESAFE_API_KEY` this uses the deterministic mock; set the key to hit live Jev.
