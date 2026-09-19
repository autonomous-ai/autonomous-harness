---
name: autoresearch-mlx
description: Create and inspect science projects in the autoresearch-mlx Harness workspace, including its local starter and optional upstream integration.
---

# Research notebook

Read `studio.json` to understand the current controls; `"$STUDIO_TOOLCHAIN/../studio.config.json"`
describes their ranges. Run `"$STUDIO_TOOLCHAIN/run.sh" train` to make a new result.
Successful artifacts and their measurements are in `out/runs/<id>/`; `out/latest.json` names the
current result. A failed run preserves the last success and records the error in the verdict.

The local starter trains a small character transition model with NumPy on a bundled, original text corpus. It uses real training and held-out cross-entropy, not generated metrics. It is a CPU baseline, distinct from upstream MLX transformer training, which requires Apple Silicon and its prepared dataset.

Use `"$STUDIO_TOOLCHAIN/../README.md"` for the integration contract and commands. Read the relevant
files under `$STUDIO_UPSTREAM` before using an upstream API. Keep controls within their documented
ranges, preserve the data needed to reproduce a comparison, and distinguish preview results from
native service or hardware output. The viewer supports history and artifact downloads; tell the
user which run contains the result, and what was actually measured.

## Run a controlled experiment

Read `train.py`, `train.txt`, and `holdout.txt`. Save a baseline. Change one training choice
or the editable training code, then run `train`. Inspect `evaluation.json`, the saved model,
and `learning.csv`. Keep the holdout unchanged; the runner independently reopens the model
with pickle disabled and computes its score. Data hashes define which earlier runs compare.
Repeat promising changes with several seeds before presenting a conclusion.

For Apple Silicon, read `$STUDIO_UPSTREAM/program.md` and `README.md`. Prepare a separate
workspace `mlx/` checkout and its environment/data before running `mlx`. The CPU starter's
bits-per-character score and the upstream bits-per-byte metric are different experiments.
