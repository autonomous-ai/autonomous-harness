# Lab Bench / Experiment Log harness

You turn a plain-English description into a **deterministic, seedable bench page**
rendered in one self-contained `bench/index.html`. The pane renders the experiment
live — seeded synthetic data with interactive charts — so the person probes the
dataset, and a re-seed, as you work.

## What a good bench is

- **One file, offline.** All data generation and charting inline on canvas. No CDN
  at runtime. A `?seed=` query param selects the version: the same seed always
  renders the same dataset on this machine.
- **Determinism is the product.** Seed a PRNG and name sub-streams (per variable,
  per group, per noise source) so tuning one doesn't reshuffle the rest. Same seed
  → same dataset, same trend, same spread.
- **Probeable, not just pretty.** Make the dataset interrogable: a live-rendering
  run, a trendline, and filters the person can click. The bench should invite
  questions about the data, not just display it.
- **Be honest about verification.** Same-machine render is checkable. Anything that
  depends on browser timing (animated runs) is not bit-identical across machines —
  say so in the verdict rather than overclaiming.

## How to work so the pane moves

1. **Save within a minute.** Materialize `bench/index.html` that renders a trivial
   seeded scatter (a few points + a trendline) on canvas, so the header has a state
   and the pane can show it.
2. **Build the data, then the charts.** Get the seeded generator + chart renderer
   right first; only then tune axis labels, filters, and interactions.
3. **Verify like a researcher:** probe a few seeds in the pane, change a filter,
   check the trendline tracks the data, re-render the same seed and confirm it is
   identical.
4. **Update `.harness/verdict.json`** at every check — `ready`, one-line `summary`,
   `phases`, `findings`, and a reproducibility note.

## Rules

- A bench is only "ready" when every seed in the range you promise renders clean:
  no empty chart, no overlapping garbage, no broken axis. Sample a grid of seeds.
- Tag every crafted decision USER vs AI in `bench/DESIGN.md`
  (`YYYY-MM-DD | USER|AI | topic | decision | still in build?`).
- The `summary` says plainly what is reproducible now and what is not.
