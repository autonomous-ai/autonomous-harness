---
name: pilot
description: Build a deterministic, seedable first-person drone flight in one HTML file from a plain-English description. Use whenever the user asks for a drone flight, an FPV line, an obstacle course, a stunt run, or prompt-to-flight.
---

# pilot

Take the user's description and produce a **single self-contained `flight/index.html`**
that flies a **deterministic, seedable** first-person drone, loading the seed from a
`?seed=` query param so the web-viewer can preview the current seed and re-seed live.

## The floor (in order)

1. **Seeded PRNG.** A small seeded PRNG derived from the hash of the seed string.
   Nothing may call a non-seeded random — the flight must be reproducible.
2. **Seeded course + physics.** A seeded course (gates, rings, obstacles, spawn)
   driven by a small, stable fixed-timestep physics loop (position, velocity,
   yaw/pitch, throttle).
3. **`?seed=` plumbing.** Reading the param, plus a tiny UI (input + "re-seed"
   button, and throttle/steer controls) so the person can browse seeds in the pane.
4. **Named sub-streams.** One PRNG sub-stream per concern (course layout, obstacle
   placement, decor) so tuning one doesn't reshuffle the other.

## The gold checklist

- **Trait tables that survive an edition**: seed → flight (course length, obstacle
  count, difficulty), and a census that shows no impossible/duplicated course in
  the range you claim.
- **Level discipline**: a stable step so nothing explodes at high throttle; a HUD
  (throttle, speed, gate count) that reads clearly.
- **Style range**: a racing line, a slalom through gates, a canyon weave, an
  obstacle run — matched to the brief, not all at once.
- **Export route**: expose a "watch" mode that flies the seeded course on its own
  and a visible minimap or gate list.

## Verify like a pilot, not a compiler

Fly a grid of seeds — actually fly them — and watch.
Two hard checks before "ready":
- **Re-fly same-seed** — it must be identical on this machine.
- **Census the seed range you promise** (e.g. 0–99); reject any stuck camera,
  impossible course, or infinite loop.

Be explicit in the verdict about the reproducibility guarantee: same-machine yes;
frame-timing physics you cannot prove bit-identical — say so.

## Verdict feed

Write `.harness/verdict.json` at every change:

```json
{ "spec": 1, "ready": false, "summary": "seeded slalom run · re-seed live · census 0–99 clean",
  "findings": [{ "severity": "info", "kind": "reproducibility", "message": "same-machine verification pending; frame-timing physics not provable bit-identical" }],
  "artifact": "flight/index.html",
  "phases": [{ "id": "seed", "name": "Seeded core", "state": "done" },
             { "id": "flight", "name": "The flight", "state": "active" },
             { "id": "edition", "name": "Edition", "state": "pending" }],
  "updatedAt": "2026-09-18T00:00:00Z" }
```

## Starting from Vector

The template is functional: Twelve gates, fixed-step dynamics, first-person projection, autopilot/manual handoff, brake/boost, minimap, finite flight and telemetry export.

Keep its useful controls and exports when making a user's creation. Test the behavioral core
(flightCourse, flightStep, fixed 1/60 simulation ticks) as well as the visible result. A self-contained HTML file can still have well-separated
model, rendering, input and export functions. Do not turn a finished starter into a waiting screen.

Presence-only helpers do not prove correctness or reproducibility. Record actual evidence before
marking the result ready. Export and reopen the result as part of the handoff to the user.

## Check your actual edited model

Run `node tools/check.mjs --seeds 100` in the workspace. It reads the pure model from
`<script id="harness-model">` in the artifact, checks domain invariants, repeats each seed, and
writes `.harness/model-check.json`. Preserve that script boundary when editing. Model checks are
followed by browser interaction, exported-output inspection, and visual or listening review.
