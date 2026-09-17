# Autonomous Circuit, as a Harness agent

[Harness](https://github.com/autonomous-ai/autonomous-harness) agent package for
[Autonomous Circuit](https://github.com/autonomous-ai/autonomous-circuit): describe a board in the chat
pane and get a fab-ready PCB, with the project's own live board view in the pane beside the agent.
Runs on Claude Code.

This folder is a **wrapper**. It holds no Circuit code: `toolchain/setup.sh` fetches the project from its
own public repository at the commit `VERSIONS` pins (everything but its product library and examples),
into `upstream/`, and runs the project's own setup there. The manifest points the agent at the project's
own `AGENTS.md`, skills and template; the doctor, workspace init and viewer are the project's own scripts,
run against that copy.

- `harness.json` — name, category, engine, and paths into `upstream/`. `formerly` keeps agents created
  under the ids this harness had before (`autonomous/copper`, `autonomous/circuit`).
- `VERSIONS` — the repository, the pinned commit on its main, and the sparse patterns.
- `toolchain/fetch-upstream.sh` — the read-only, sparse, blob-less fetch; `setup.sh`, `doctor.sh`,
  `init-workspace.sh`, `viewer.sh` hand off to the project's scripts of the same names.

## Credit and stewardship

Autonomous Circuit is its own project, [autonomous-ai/autonomous-circuit](https://github.com/autonomous-ai/autonomous-circuit),
under its repository's licence (MIT). Nothing of it is changed or copied here. Harness treats it like any
other project in the store: bugs in board generation belong in that repository, bugs in the wrapper
belong here, and a newer Circuit is a bump of `UPSTREAM_COMMIT` in `VERSIONS`. If the Circuit team wants
to own the store entry, the wrapper moves into their repository and the registry points there.

```sh
harness dsh check "$PWD"                           # conformance (warns: the project arrives with setup)
harness dsh install "$PWD" --link                  # this checkout as the installed agent
```
