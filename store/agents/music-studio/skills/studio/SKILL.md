---
name: studio
description: Build a deterministic, seedable piece of music in one HTML file from a plain-English description. Use whenever the user asks for a track, a beat, a generative song, a seedable sound series, or prompt-to-music.
---

# studio

Take the user's description and produce a **single self-contained `piece/index.html`**
that plays a **deterministic, seedable** track, loading the seed from a `?seed=`
query param so the web-viewer can preview the current seed and re-seed live.

## The floor (in order)

1. **Seeded PRNG.** A small seeded PRNG derived from the hash of the seed string.
   Nothing may call a non-seeded random — the piece must be reproducible.
2. **Score + synthesis.** A seeded score (chord progression, rhythm grid, melody)
   driving Web Audio synthesis (oscillators + envelopes, a clock-based scheduler).
3. **`?seed=` plumbing.** Reading the param, plus a tiny UI (input + "re-seed"
   button, play/stop) so the person can browse seeds in the pane.
4. **Named sub-streams.** One PRNG sub-stream per concern (harmony, rhythm, melody)
   so tuning one doesn't reshuffle the other.

## The gold checklist

- **Trait tables that survive an edition**: seed → traits (key, tempo, arrangement),
  and a census that shows no silent/clipping/degenerate seed in the range you claim.
- **Level discipline**: a ceiling (soft clipper or gain architecture) so nothing
  blows out; a visible meter or waveform.
- **Style range**: generative techno, lo-fi chords, arpeggiated ambient, drum-grid
  patterns — matched to the brief, not all at once.
- **Export route**: `?seed=X&size=…` style render is audio, so offer a "render
  once, loop forever" mode and a visible step grid.

## Verify like a listener, not a compiler

Play a grid of seeds — actually play them — and listen.
Two hard checks before "ready":
- **Re-play same-seed** — it must be identical on this machine.
- **Census the seed range you promise** (e.g. 0–99); reject any silent, clipped,
  or stuck-forever frame.

Be explicit in the verdict about the reproducibility guarantee: same-machine yes;
cross-machine audio you cannot prove bit-identical — say so.

## Verdict feed

Write `.harness/verdict.json` at every change:

```json
{ "spec": 1, "ready": false, "summary": "seeded lo-fi loop · re-seed live · census 0–99 clean",
  "findings": [{ "severity": "info", "kind": "reproducibility", "message": "same-machine verified; cross-machine audio not provable bit-identical" }],
  "artifact": "piece/index.html",
  "phases": [{ "id": "seed", "name": "Seeded core", "state": "done" },
             { "id": "piece", "name": "The piece", "state": "active" },
             { "id": "edition", "name": "Edition", "state": "pending" }],
  "updatedAt": "2026-09-18T00:00:00Z" }
```
