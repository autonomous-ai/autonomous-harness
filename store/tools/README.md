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
