---
name: grid-operations
description: "Operate a Grid fleet from this harness workspace: discover capacity, deploy and undeploy open-weight models, compare placement and performance, and use Grid routing, usage, media and training commands."
---

# Grid operations

`$GRID_FLEET` and `$GRID_CLI` are executable paths, not directories. Quote them. Start with
`"$GRID_FLEET" config` and `"$GRID_FLEET" status`. `status` reads the viewer's published snapshot
without opening a socket or launching Grid. Check `fresh`, `status` and `observedAt`; use fresh live
observations to answer ordinary inventory questions. A downloaded weight file or a catalog entry
is not a serving model. The viewer reads actual CLI data, and the
runner records operation start/completion without recording prompts, credentials or full argv.

In a restricted agent sandbox, `refresh`, `connect`, `discover` and network-using `run` commands
require the engine's normal scoped network approval. Request it before calling them rather than
repeating commands that fail with EPERM. This also applies to the loopback Harness bridge. Do not
disable the sandbox or broaden global permissions. A denied network call does not prove a host is
offline; use fresh viewer observations or an approved live check.

## Targets and access

`grid-fleet.json` holds the mode (`local` or `remote`), grid selector, controller machine, managed
machines and user preferences. A null grid means the workspace is not connected; the viewer must not
fall through to an old CLI default. Fresh workspaces reuse the remembered fleet, then a reachable
active Grid selection; ambiguous choices remain explicit. Connect with
`"$GRID_FLEET" connect --mode remote --grid NAME --remember` to select a verified grid and reuse it
in future workspaces. `--remember` writes this controller's `~/.harness/grid-fleet/default.json`;
existing workspace selections remain independent. Changing this workspace's mode never requires
changing Grid's global mode.

The default machine is this computer. Use `"$GRID_FLEET" discover` to list the user's Harness machines,
and `discover --add` to add them when fleet management is requested. Paired Harness links need no SSH
setup; the runner checks the target's Grid fleet protocol before any command. An older Harness must
be updated before this transport works. An offline or unlinked machine stays unavailable.
Alternatively, add a known SSH target using an established SSH config alias
or `user@host`; do not infer SSH access from a display name in Grid. Grid lists serving engines,
which are not necessarily distinct physical machines. See [fleet configuration](references/fleet.md).
An engine can be observed through the relay without having permission or a transport to administer its host.

```sh
"$GRID_FLEET" run -- ls --json
"$GRID_FLEET" run -- engines GRID --json
"$GRID_FLEET" run --machine MACHINE -- device-info --json
"$GRID_FLEET" run --machine MACHINE -- catalog --json
```

`run` passes every argument after `--` to the real Grid CLI and applies the workspace's mode.
It supports Grid's entire CLI, including nested commands. Local and SSH execution accept interactive
input; Harness transport is noninteractive, so sign-in prompts belong in that machine's terminal. The controller is
the default execution machine. Model files and `join`/`leave` operations belong on the machine
that runs the engine; listing, routing and requests can run on the controller.

## Deploy and verify

1. Inspect capacity and current workloads on the intended host. Use **per-machine available memory**,
   Grid's usable model budget, disk space, model size/quantization, context/KV cache, and the user's
   `keepFreeMemoryGb`. Do not add multiple machines' memory to claim a model fits. Prefer a smaller
   model or supported quantization when headroom is tight.
2. Use the installed CLI's `--help` for current flags. Discover weights through `catalog --json`, or
   verify an exact Hugging Face repository/file. Check the model card's license and capabilities when
   selecting a new model. Describe downloads and intended placement within the user's stated scope.
3. Install an engine if needed, pull an explicit file, then join the intended grid. Give each served
   instance a unique, recognizable `--name` and `--advertise-as`. Use explicit ports when several
   instances share a host. Local hosts join using the controller's reachable grid URL.

Choose a reasoning budget deliberately. Grid's GPU default can spend more tokens thinking than a
small output limit permits, yielding no final answer. For an everyday low-latency assistant, start
with `fleet run --thinking off -- join ... --reasoning-budget 0`. `--thinking off` sets llama.cpp's
`enable_thinking:false` template parameter for the newly started engine; it is needed on builds
where a zero token budget alone still produces reasoning. Use `--thinking on` to enable a supported
model's thinking explicitly. These switches configure startup, not an already running instance.
For a reasoning model, reserve an explicit budget smaller than
`--n-predict`, leaving room for the answer. Verify `message.content` contains the requested result;
reasoning text alone, a length-limited completion, or a successful HTTP status is not acceptance.

```sh
"$GRID_FLEET" run --machine MACHINE -- engine install llama.cpp
"$GRID_FLEET" run --machine MACHINE -- pull OWNER/REPO:EXACT_FILE.gguf
"$GRID_FLEET" run --machine MACHINE -- join GRID_URL_OR_ID --serve EXACT_FILE.gguf --name MACHINE-MODEL --advertise-as MODEL_ALIAS --endpoint-port PORT
"$GRID_FLEET" run -- models GRID --json
"$GRID_FLEET" run -- chat --grid GRID -m MODEL_ALIAS "A short representative test" --json
"$GRID_FLEET" refresh
```

An existing Ollama, vLLM, MLX or LM Studio engine can join with `--at URL -m MODEL --name NAME`.
Use `join --help` to choose the appropriate engine flags. Do not install a second engine needlessly.
A successful `join` may mean **starting**, not ready: poll `models` and send a real request before
reporting that the model works. For a bounded retry, wait up to the loading deadline warranted by
the model's size, inspect Grid's named logs on failure, and report the concrete blocker.

For remote Grid, `--parallel N` reserves llama.cpp slots, while `--max-concurrency N` separately
controls how many requests Grid dispatches. Set both deliberately for concurrent service, and verify
the advertised concurrency. `--ctx-size` is per request, so reserved context memory grows with the
slot count. Raising concurrency needs a new serving process and a representative concurrent test.

## Undeploy and move

`leave GRID --engine SELECTOR` on the serving machine stops/unregisters that instance. Match an
exact unique engine identity from `engines` first. `leave --all` affects other workloads; use it only
for a user-requested whole-grid teardown. `rm MODEL --yes` deletes downloaded weights and is a
different action from undeploying; retain files unless deletion is requested.

Verify the engine disappears from discovery after `leave`, with bounded polling. Local Grid can retain
a stopped engine until its 60-second heartbeat TTL expires; remote grids have their own convergence
delay. A successful exit alone is not proof of removal. If it persists beyond the deadline, inspect
the named process/logs and report a failed or incomplete undeployment, not a successful one.

For a move: verify the destination can answer the same model alias, check whether the source has
active work when that telemetry exists, then remove the source instance and verify routing again.
Do not promise seamless draining or conversation migration: the CLI does not guarantee either.
If the destination fails, keep the source serving. Keep a rollback command in the plan.

## Placement and model discovery

Use user needs (latency, coding quality, vision, privacy, power, quiet hours, concurrency) to compare
placements. `stats GRID --verbose --json` and `usage GRID --by model --json` are remote-grid reads.
Local grids expose a smaller surface; `device-info` gives hardware inventory, not a complete live
GPU sensor feed. Missing sensor values cannot justify moving a workload.

`throughput_tok_s` is the last measured decode estimate for one engine. Do not sum engines' rates
or present it as a simultaneous fleet benchmark. Compare candidates using the same representative
task and context; preserve the observed timings, output and model/quantization in `plans/`.

The shipped catalog is curated, not a live feed of every new release. For newly released models,
check primary model cards/release sources and offer a measured trial. Automatic replacement needs
the user's explicit standing policy (`allowAutomaticChanges` plus a concrete scope); a suggestion
does not authorize an unrequested fleet-wide upgrade. Existing authorization for a deployment or
move is enough to carry it through without asking again.

## The rest of Grid

Use `"$GRID_FLEET" run -- --help`, then a command's `--help`, to discover the installed surface.
See [command routes](references/commands.md) for the main families. Routing, training, media,
projects and agents are available through the same runner. Do not change credentials, memberships,
pricing, external API billing or training jobs as a side effect of an ordinary local deployment.

Keep failures visible. A timeout or dropped SSH session leaves the remote result uncertain; inspect
the engine before retrying a mutation. Exit zero and the operation record alone do not prove service
health: verify through `engines`, `models` and an actual request.
