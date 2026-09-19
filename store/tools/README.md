# DSH tools

Daemon-level checks over the same loopback WebSocket the desktop uses (`ws://127.0.0.1:18473/api/local-ws`).
They need a running daemon with the harness installed on this machine, and `cli/node_modules` (for `ws`).

```sh
node store/tools/dsh-e2e.mjs <machineId> <dshId> <engine> <workspace> [--keep] [--restart] [--bypass] [--no-verdict]
    # create → materialize → viewer up → HARNESS_DSH on the pane → (verdict) → delete
node store/tools/dsh-discover.mjs ...   # a pane started by hand with HARNESS_DSH is discovered as its harness
node store/tools/dsh-delete.mjs <agentId> <machineId>
```

`<machineId>` is this machine's id from `harness status` / `~/.harness/cli/data/machines.json`.

## runtimes.sh — what a package runs on

A new machine has Apple's Python 3.9, no Homebrew and usually no Node on PATH, so a package's setup
never asks the person to install an interpreter: it sources `runtimes.sh` and gets one. `harness_node`
falls back to the Node Harness itself runs on, `harness_venv` makes a venv on a pinned CPython that
uv downloads (uv itself is fetched, pinned and checksummed, when absent), and `harness_conda_env`
covers native libraries PyPI has no wheel for. Everything lands in the package directory or
`~/.harness/runtime`.

A package installs alone, so each one carries a copy (`toolchain/runtimes.sh` in an agent,
`runtimes.sh` in a viewer). Edit only `store/tools/runtimes.sh`, then:

```sh
node store/tools/sync-runtimes.mjs           # rewrite every copy
node store/tools/sync-runtimes.mjs --check   # exit 1 on a copy that drifted or a package missing one
```

## Specialist studio runtime copies

`studio_runtime.py` validates project controls, runs one named action, verifies its artifacts,
and writes immutable results plus the Harness verdict. `studio_fetch.py` fetches reviewed
commit pins without overwriting local source changes. Every specialist package carries its
own copy for sparse installs. After editing the canonical files, run:

```sh
node store/tools/sync-studios.mjs
node store/tools/sync-studios.mjs --check
```

The shared [Studio Viewer test guide](../viewers/studio-viewer/TESTING.md) covers the runtime,
pin fetching, domain workflows, browser controls, and actual Harness lifecycle.
