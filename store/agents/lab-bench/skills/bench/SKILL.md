---
name: bench
description: Build a deterministic, seedable data bench page in one HTML file from a plain-English description. Use whenever the user asks for an experiment log, a dataset explorer, seeded synthetic data, a trend chart, or prompt-to-bench.
---

# bench

Take the user's description and produce a **single self-contained `bench/index.html`**
that renders a **deterministic, seedable** experiment — seeded synthetic data with
interactive charts — loading the seed from a `?seed=` query param so the web-viewer
can preview the current seed and re-seed live.

## The floor (in order)

1. **Seeded PRNG.** A small seeded PRNG derived from the hash of the seed string.
   Nothing may call a non-seeded random — the dataset must be reproducible.
2. **Data generator + chart renderer.** A seeded generator (variables, groups, a
   trend with noise) driving a canvas scatter/trend renderer with real axes.
3. **`?seed=` plumbing.** Reading the param, plus a tiny UI (input + "re-seed"
   button, and filter toggles) so the person can probe datasets in the pane.
4. **Named sub-streams.** One PRNG sub-stream per concern (variable, noise group,
   group assignment) so tuning one doesn't reshuffle the other.

## The gold checklist

- **Trait tables that survive an edition**: seed → dataset (dimensions, group
  sizes, trend strength), and a census that shows no empty/degenerate render in the
  range you claim.
- **Axis discipline**: legible scales, labelled axes, a trendline that tracks the
  points; filters that actually change the view.
- **Style range**: a scatter with a trendline, a grouped bar/probe, a run chart,
  a distribution — matched to the brief, not all at once.
- **Export route**: expose a "live run" mode that animates points being added and a
  hover/readout that shows point values.

## Verify like a researcher, not a compiler

Probe a grid of seeds — actually render them — and read the charts.
Two hard checks before "ready":
- **Re-render same-seed** — it must be identical on this machine.
- **Census the seed range you promise** (e.g. 0–99); reject any empty chart,
  overlapping garbage, or broken axis.

Be explicit in the verdict about the reproducibility guarantee: same-machine yes;
animated-run frame timing you cannot prove bit-identical — say so.

## Verdict feed

Write `.harness/verdict.json` at every change:

```json
{ "spec": 1, "ready": false, "summary": "seeded scatter · trend + filters · census 0–99 clean",
  "findings": [{ "severity": "info", "kind": "reproducibility", "message": "same-machine verification pending; animated-run timing not provable bit-identical" }],
  "artifact": "bench/index.html",
  "phases": [{ "id": "seed", "name": "Seeded core", "state": "done" },
             { "id": "bench", "name": "The bench", "state": "active" },
             { "id": "edition", "name": "Edition", "state": "pending" }],
  "updatedAt": "2026-09-18T00:00:00Z" }
```

## Starting from Signal

The template is functional: Seeded synthetic experiment, adjustable effect/noise/sample size, group filters, regression, difference-of-means interval, point probe, collection replay, CSV.

Keep its useful controls and exports when making a user's creation. Test the behavioral core
(experiment, stats, regression, treatmentEffect, csvRows) as well as the visible result. A self-contained HTML file can still have well-separated
model, rendering, input and export functions. Do not turn a finished starter into a waiting screen.

Presence-only helpers do not prove correctness or reproducibility. Record actual evidence before
marking the result ready. Export and reopen the result as part of the handoff to the user.

## Check your actual edited model

Run `node tools/check.mjs --seeds 100` in the workspace. It reads the pure model from
`<script id="harness-model">` in the artifact, checks domain invariants, repeats each seed, and
writes `.harness/model-check.json`. Preserve that script boundary when editing. Model checks are
followed by browser interaction, exported-output inspection, and visual or listening review.
