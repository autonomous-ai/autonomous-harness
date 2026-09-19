# Ableton AI · Loop room

A small pattern can become a whole mood. Make a loop, play with its pulse, and keep the happy accidents.

![Loop room running the local starter](screenshots/studio.png)

```sh
harness dsh install autonomous/ableton-ai
```

Open a workspace in Harness. Setup fetches upstream sources at the commit in `upstream.lock.json`,
installs a package-local Python 3.11 environment, and verifies the local tools. The starter runs
without credentials or a cloud account. Studio Viewer provides controls, history, downloads,
live agent updates, and failure recovery. Setup never edits an application's preferences.

## What runs here

The starter is a local synthesized MIDI sequencer. It writes a standard MIDI file and WAV preview without Ableton. The optional Live action reads a running Ableton AI bridge; it does not overwrite tracks or start transport.

Edit `studio.json`, then run:

```sh
"$STUDIO_TOOLCHAIN/run.sh" render  # Keep this loop
"$STUDIO_TOOLCHAIN/run.sh" live  # Read Live session
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

[Ableton AI](https://github.com/freekmurze/ableton-ai) is maintained by Freek Van der Herten and contributors. Its sources are
fetched unchanged at `2baa8b79c00f48d925b080f3719a7b892f64d86c`. Upstream licensing: MIT; Ableton Live licensed separately.
The original license is preserved in `LICENSE-upstream`; dependency terms still apply.

OpenHarness contributors wrote the MIT wrapper, local starter, and viewer integration. This is
an independent integration, not an upstream endorsement. Upstream bugs belong with the upstream
project; wrapper bugs belong in OpenHarness. Maintainers are welcome to take over this package.
