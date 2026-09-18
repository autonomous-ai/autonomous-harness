# Solder, as a Harness agent

[Harness](https://github.com/autonomous-ai/openharness) agent package for the **KiCad-native**
pipeline of [Autonomous Circuit](https://github.com/autonomous-ai/autonomous-circuit): describe a board
in the chat pane and get a real KiCad project — a wired schematic, copper KiCad's own ERC/DRC has
checked, a prototype packet a fab can quote — with the project's own live board view in the pane beside
the agent. Runs on Claude Code.

Solder is the sibling of [Autonomous Circuit](../autonomous-circuit/) (the v1 pipeline, tscircuit
sources, the same repository's `main`), not its replacement: the two wrap different branches of one
repository, and a user who wants a KiCad project picks Solder.

This folder is a **wrapper**. It holds no Circuit code: `toolchain/setup.sh` fetches the project from
its own public repository at the commit `VERSIONS` pins (everything but its product library and
examples) into `upstream/`, then runs the Solder package's own setup there
(`upstream/harness/kicad/`). The manifest points the agent at that package's `AGENTS.md`, skill and
template; the doctor, workspace init and viewer are that package's own scripts, run against the copy.

- `harness.json` — name, category, engine, and paths into `upstream/harness/kicad/`.
- `VERSIONS` — the repository, the pinned commit (on its `feat/v2-kicad-native` branch), the sparse patterns.
- `toolchain/runtimes.sh` — the store's copy: a Node and a venv Python of the package's own.
- `toolchain/fetch-upstream.sh` — the read-only, sparse, blob-less fetch; `setup.sh`, `doctor.sh`,
  `init-workspace.sh`, `viewer.sh`, `python` hand off to the package's scripts of the same names.

What the machine must have: **KiCad** (`brew install --cask kicad` — kicad-cli and its bundled Python with
`pcbnew`; the doctor fails without them), the engine CLI, git. Node and Python come with the package;
Freerouting and the viewer are vendored by setup.

## Credit and stewardship

Autonomous Circuit is its own project, [autonomous-ai/autonomous-circuit](https://github.com/autonomous-ai/autonomous-circuit),
under its repository's licence (MIT). Nothing of it is changed or copied here. Bugs in board generation
belong in that repository, bugs in the wrapper belong here, and a newer Solder is a bump of
`UPSTREAM_COMMIT` in `VERSIONS`.

```sh
harness dsh check "$PWD"                           # conformance (warns: the project arrives with setup)
harness dsh install "$PWD" --link                  # this checkout as the installed agent
python3 -m unittest discover -s toolchain          # the wrapper's own tests
```
