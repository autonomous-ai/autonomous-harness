# Fleet configuration

The viewer polls the controller's selected grid and collects `device-info` on each managed host.
Remote telemetry can include engines on machines absent from this inventory. Those engines
are observable, but the agent needs a configured route before administering their host.

```json
{
  "spec": 1,
  "mode": "remote",
  "grid": "my-grid-id",
  "controller": "local",
  "machines": [
    { "id": "local", "name": "My laptop", "transport": "local" },
    { "id": "linked-rig", "name": "Linked GPU rig", "transport": "harness", "machineId": "MACHINE_ID_FROM_DISCOVER" },
    { "id": "studio", "name": "Mac Studio", "transport": "ssh", "host": "studio" },
    { "id": "gpu", "name": "GPU workstation", "transport": "ssh", "host": "me@gpu-box", "port": 22 }
  ],
  "preferences": {
    "goal": "Fast coding on the workstation, quiet chat on the Studio",
    "keepFreeMemoryGb": 8,
    "allowAutomaticChanges": false
  }
}
```

Harness targets use the exact machine ID returned by `fleet discover`, the local Harness daemon,
and the existing encrypted machine pairing. `fleet discover --add` preserves configured targets and
adds the rest. Both daemons must support Grid fleet protocol 1. It never copies credentials or
changes trust. Target runtime and Grid home belong to the target daemon, with no path overrides.

SSH uses the user's existing config, keys, agent and known_hosts, with strict host-key checking and
noninteractive authentication. Establish new host trust through the user's normal SSH workflow;
do not disable host verification or embed passwords in this file. Both local and SSH machines may
set absolute `gridBinary` and `gridHome` paths when deliberately selecting an alternate runtime or
isolated environment. Otherwise, the managed Harness Grid runtime takes precedence over PATH.

`fleet connect --mode local|remote --grid NAME` verifies the selected grid before writing its mode
and selector. Add `--remember` to save this fleet for newly created workspaces on the controller;
it does not change Grid's global selection or overwrite existing workspace choices. A null selector
is an unconfigured workspace, not an instruction to connect to a stale default.

Run `"$GRID_FLEET" config` after editing to validate it, then an approved `refresh`. `fleet status`
reads the viewer's already-published telemetry without a network request and marks old observations
as stale. A dropped machine reports
unreachable without blanking the others. Node identity is separate from its display name. The
viewer calls them engines because multiple instances can share one physical host.

Snapshots live in `.harness/grid/snapshot.json`, with at most 90 recent samples per engine and
40 displayed fleet events. `.harness/grid/operations/` contains one small record per command;
the viewer displays the latest 40. Records intentionally omit full arguments and command output.
These are observations, not a source of desired deployment state.
