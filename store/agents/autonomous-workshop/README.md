# Autonomous Workshop, as a Harness agent

[Harness](https://github.com/autonomous-ai/autonomous-harness) agent package for
[Autonomous Workshop](https://github.com/autonomous-ai/autonomous-workshop): describe a part in the chat
pane and get a validated, printable STEP, with a live 3D view in the pane beside the agent. Runs on Codex.

This folder is a **wrapper**. It holds no Workshop code: `toolchain/setup.sh` fetches the project from
its own public repository at the commit `VERSIONS` pins (its Python package and harness folder; the toy
library stays behind), into `upstream/`, and runs the project's own setup there (`uv sync` from its
lockfile). The manifest points the agent at the project's own `AGENTS.md`, CAD skills and template, and
the pane is the store's shared [CAD Viewer](../../viewers/cad-viewer).

- `harness.json` — name, category, engine, paths into `upstream/`, `viewer.use: autonomous/cad-viewer`.
  `formerly` keeps agents created under the ids this harness had before (`autonomous/toymaker`,
  `autonomous/solid`, `autonomous/workshop`).
- `VERSIONS` — the repository, the pinned commit on its main, and the sparse folders.
- `toolchain/fetch-upstream.sh` — the read-only, sparse, blob-less fetch; `setup.sh`, `doctor.sh` and
  `init-workspace.sh` hand off to the project's scripts of the same names.

## Credit and stewardship

Autonomous Workshop is its own project, [autonomous-ai/autonomous-workshop](https://github.com/autonomous-ai/autonomous-workshop),
under its repository's licence (Apache-2.0). Nothing of it is changed or copied here. Harness treats it
like any other project in the store: bugs in CAD generation belong in that repository, bugs in the wrapper
belong here, and a newer Workshop is a bump of `UPSTREAM_COMMIT` in `VERSIONS`. If the Workshop team
wants to own the store entry, the wrapper moves into their repository and the registry points there.

```sh
harness dsh check "$PWD"                           # conformance (warns: the project arrives with setup)
harness dsh install "$PWD" --link                  # this checkout as the installed agent
```
