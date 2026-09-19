# autoresearch-mlx · Research notebook

Follow a small idea through a real experiment. Train, compare, and see what the evidence says.

![Research notebook running the local starter](screenshots/studio.png)

```sh
harness dsh install autonomous/autoresearch-mlx
```

Open a workspace in Harness. Setup fetches upstream sources at the commit in `upstream.lock.json`,
installs a package-local Python 3.11 environment, and verifies the local tools. The starter runs
without credentials or a cloud account. Studio Viewer provides controls, history, downloads,
live agent updates, and failure recovery. Setup never edits an application's preferences.

## What runs here

The local starter trains a small character transition model with NumPy on a bundled, original text corpus. It uses real training and held-out cross-entropy, not generated metrics. It is a CPU baseline, distinct from upstream MLX transformer training, which requires Apple Silicon and its prepared dataset.

Edit `studio.json`, then run:

```sh
"$STUDIO_TOOLCHAIN/run.sh" train  # Try an experiment
"$STUDIO_TOOLCHAIN/run.sh" mlx  # Run MLX experiment
```

The native command is optional and fails with a useful message when its external runtime is
unavailable. It never silently substitutes sample output. Use the upstream README in `upstream/`
for full native application setup. See `INTEGRATION.md` for the exact bridge and local test scope.

Every successful run owns a new folder under `out/runs/`, a `result.json` with parameters, engine,
source commit, timestamps, measured values, and downloadable artifacts. `.harness/verdict.json`
means the named artifact was produced, not that an engineering or aesthetic claim was certified.
The starter can be regenerated with no network after install.

## Development and testing

Install the shared viewer and this package with `harness dsh install <path> --link`.
`toolchain/doctor.sh` checks the local runtime. The repository's Studio Viewer browser suite
materializes temporary workspaces and exercises each shipped local workflow. Run it from
`store/viewers/studio-viewer` with `npm run test:browser`; exact results live in its `TESTING.md`.

## Credit and stewardship

[autoresearch-mlx](https://github.com/trevin-creator/autoresearch-mlx) is maintained by Trevin creator; Andrej Karpathy. Its sources are
fetched unchanged at `766a25ff22afa799efd8d0aa450a4348e4749df2`. Upstream licensing: MIT.
The original license is preserved in `LICENSE-upstream`; dependency terms still apply.

OpenHarness contributors wrote the MIT wrapper, local starter, and viewer integration. This is
an independent integration, not an upstream endorsement. Upstream bugs belong with the upstream
project; wrapper bugs belong in OpenHarness. Maintainers are welcome to take over this package.
