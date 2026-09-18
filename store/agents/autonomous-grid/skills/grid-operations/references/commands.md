# Command routes

Always check the selected CLI's help before unfamiliar operations. All commands use
`"$GRID_FLEET" run [--machine ID] -- ...`. Grid's current reference is
https://github.com/autonomous-ai/autonomous-grid/blob/main/docs/cli.md.

| Need | Grid commands |
|---|---|
| Lifecycle and selection | `start`, `stop`, `delete`, `ls`, `info`, `mode`, `use` — `use` is the one source of truth for which grid; the viewer follows it, and `connect` sets it (SKILL.md, "Targets and access"). Change grids through `connect`, which verifies first |
| Host inventory | `device-info --json` |
| Model discovery and weights | `~/.grid/models/*.gguf` on disk first, then `catalog --json`, then Hugging Face; `pull REPO:FILE`, `ctx FILE --json`, `rm FILE` |
| Engine provisioning | `engine install llama.cpp [--from-source]`; the install check is `~/.grid/bin/llama-server --version` — `engine status`/`start`/`stop` are the media engine (ComfyUI) |
| Serving and removal | `join`, `leave --engine SELECTOR`, `engines --json`, `models --json` |
| Inference checks | a bounded relay call with `max_tokens` (SKILL.md step 6), never `chat` for verification (no output limit); `image`, `edit`, `video`, `stt` for media |
| Remote telemetry | `stats --verbose --json`, `usage --by model|member|engine --json` |
| Remote request routing | `router --help` (inspect before changing policies or advisors) |
| Training and evaluation | `train --help`, `train doctor`, `train packs`, `train eval`, `train deploy` |
| Apps and coding agents | `agent --help`, `launch --help` |
| Projects and tasks | `project --help`, `task --help` |
| Remote account administration | `login`, `sync`, `members`, `price`, `credential`, `logout` |

The wrapper never limits Grid to this table; new subcommands pass through unchanged. A command's
availability depends on the installed Grid version and current mode. `stats`/`usage` need remote
mode and a reachable grid; media and training need their own engines, models and hardware. A test
of help text proves forwarding, not that those workloads or remote services were exercised.
