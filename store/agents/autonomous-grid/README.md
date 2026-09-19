# Grid, as a Harness agent

Manage open-weight models across your machines by talking to Grid. The agent uses the existing
[Grid CLI](https://github.com/autonomous-ai/autonomous-grid), with a live fleet viewer beside it:
gold connections, machine and engine details, model placement, memory, GPU temperature, power,
utilization, decode estimates, recent telemetry, and operation progress. Topology and rack views
share the same real observations. No hosted dashboard or second inference service is required.

## Install and open

Choose **Grid** in the Harness Store, or install this checkout:

```sh
harness dsh install "$PWD/store/agents/autonomous-grid" --link
harness dsh doctor autonomous/autonomous-grid
```

Open Grid in a new workspace and ask: “Find the best way to run a coding model and a fast chat
model on my machines.” It runs on the Codex engine already supported by Harness. Setup uses
Harness's managed Grid runtime when present; otherwise it installs the upstream revision in
`VERSIONS` into a package-local Python environment. Setup does not download models or start engines.

New workspaces follow the grid you have selected (`grid use`), and the viewer keeps following it
as you switch; with nothing selected yet they reuse your remembered fleet, or your own private grid
(the one Harness minted at sign-in, recognised from your account) and select it. They import your
Harness machine inventory. They never assume an old local grid named `home`. Use
`fleet connect --mode remote --grid NAME --remember` to make a verified fleet the default for future
Grid workspaces; `--remember` stores only fleet configuration in `~/.harness/grid-fleet/default.json`.
Existing workspaces keep their own explicit selection. Without a clear selection, the viewer asks
you to choose a grid instead of reporting an unrelated old endpoint as your fleet.

`fleet status` reads the viewer's published observations without network access. The agent uses
fresh observations for routine model and machine questions. Explicit live refreshes and operations
use the agent's normal network-approval flow when its sandbox requires it; no global permission
changes are needed. See [Codex's documented network boundary](https://learn.chatgpt.com/docs/agent-approvals-security#network-access).

`fleet discover --add` imports additional Harness machines;
commands travel over their existing paired, encrypted Harness links, without SSH setup. Both the
controller and target need the Harness CLI's Grid fleet protocol (capabilities are checked before
running commands). Older targets show an update requirement. Known SSH hosts remain supported;
keys and host trust stay with SSH. Grid can also observe a remote grid through its existing sign-in.
Remote telemetry does not by itself grant administrative access to each serving machine.

## How it works

- `toolchain/grid.sh` selects the same managed Grid runtime as Harness, with an explicit developer
  override (`HARNESS_GRID_BIN`) and a pinned package fallback.
- `toolchain/fleet run --machine ID -- …` forwards the complete Grid CLI, preserving arguments and
  exit codes over local, paired Harness, or SSH execution. Each operation updates a small workspace record.
  Harness connections use Node 22's WebSocket and bounded, noninteractive commands; use the machine's
  terminal for interactive sign-in. No remote command is automatically retried after a lost connection.
- `viewer.mjs` polls `info`, `engines`, `models`, remote `stats`, and managed hosts' `device-info`.
  It serves a read-only loopback viewer and SSE updates. No credential files, full CLI output,
  arbitrary workspace files, or mutation endpoints are exposed to the browser.
- The viewer uses only reported metrics. Local Grid currently exposes less live telemetry than
  remote Grid. Missing temperature or speed reads `—`; a failed refresh preserves a visibly stale
  observation. Speeds are per-engine last decode estimates, never summed into a fictional fleet rate.
- Model deployment and removal happen through the agent. The skill distinguishes undeploying an
  instance from deleting weights and verifies service with a real request after `join`.
- `fleet run --machine ID --thinking off -- join ...` starts a supported model with thinking disabled
  through llama.cpp's template setting. This explicit control complements Grid's token budget and is
  checked against the remote daemon's capabilities before startup. Omit it to retain the model default.

## Develop and verify

```sh
npm test --prefix store/agents/autonomous-grid
harness dsh check "$PWD/store/agents/autonomous-grid"
node store/tools/catalog.mjs

# Viewer against a workspace; the selected port is printed.
HARNESS_WORKSPACE=/path/to/workspace store/agents/autonomous-grid/viewer.sh
```

The opt-in live test takes `GRID_TEST_MODEL` (a real GGUF file) and `GRID_TEST_ENGINE_DIR`
(a directory containing llama-server and its libraries), creates an isolated `GRID_HOME`, then
starts a private loopback Grid, deploys, chats, undeploys, verifies removal, and cleans up.
`npm run test:live` does not touch the user's existing grids. See `test/live.mjs` for inputs.
The automated fixture tests cover full command forwarding and telemetry failure cases; they do not
claim to exercise every remote, media, or training workload.

## Credit and stewardship

Grid is Autonomous's [autonomous-grid](https://github.com/autonomous-ai/autonomous-grid) project,
licensed MIT. This package wraps its unmodified CLI. Grid's own README video inspired the fleet
visualization; the viewer and Harness integration are new code. Upstream CLI and engine issues
belong in the Grid repository; package, agent and viewer issues belong in OpenHarness. A future
move of this wrapper into Grid's repository can retain its Store identity.
