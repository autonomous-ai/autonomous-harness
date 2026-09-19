# autoresearch-mlx workspace

This harness turns a request into a real, inspectable science artifact. Start with
the `autoresearch-mlx` skill. The editable project is `studio.json` plus files in this workspace.
The viewer follows `out/latest.json` and the run history; save small useful changes as you work.

Run `"$STUDIO_TOOLCHAIN/run.sh" train` after a change. The runner validates controls,
records provenance, writes artifacts, and updates `.harness/verdict.json`. Do not hand-edit the
verdict to claim a run succeeded. Inspect the produced artifact before describing the result.

The local starter trains a small character transition model with NumPy on a bundled, original text corpus. It uses real training and held-out cross-entropy, not generated metrics. It is a CPU baseline, distinct from upstream MLX transformer training, which requires Apple Silicon and its prepared dataset.

The installed sources are at `$STUDIO_UPSTREAM`. Preserve upstream credit and use the pinned
instructions when extending the domain workflow. Local simulations are the default. Ask before
using a paid generation service or operating physical hardware unless the user already authorized it.

When developing this package itself, keep it independently installable from its folder; shared
runtime copies are synchronized by `store/tools/sync-studios.mjs` and `sync-runtimes.mjs`.
