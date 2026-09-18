# The daemon and CLI

One thing to know from the start: **the daemon only knows about panes it created.** Sessions you
start from the app are tmux sessions named `harness-*`, owned by the daemon. A `claude` you launch
by hand in your own tmux is not picked up. Another machine needs Node ≥ 20 and tmux; `sqlite3` only
for the engines that keep their conversations in SQLite (OpenCode, Kilo, Hermes, Devin). There is no
token to copy between machines: a durable computer id under `~/.harness` keeps later starts attached
to the same machine record.

`harness` is one pure-JS bundle run by the managed Node under `~/.harness/cli`. Everything below
works the same on a headless Linux server; the app is not required on a machine, only the daemon.

| Command | What it does |
|---|---|
| `harness login [--force] [--json]` | Browser SSO; save this computer's session. `--force` signs in as a different account. `--json` emits NDJSON for GUI clients. |
| `harness start [-f] [--repair]` | Start the daemon from the saved session. `-f` runs in the foreground for a supervisor. `--repair` re-verifies the managed Node runtime. |
| `harness stop` · `harness logout` · `harness reset` | Stop the daemon · stop and clear the SSO session · stop and clear all local state. |
| `harness status` · `harness version` · `harness update [--force]` | Running, pid, machine id, session count · version · update now. |
| `harness dsh list` · `harness dsh update <owner/name>` | Installed harness package versions and available updates · update one package while preserving its workspaces. |
| `harness machines [list] [--json]` · `harness machines delete <id>` | This account's machines · remove another machine (never this one). |
| `harness pair <code>` · `harness pairings` · `harness unpair <#\|fp\|--all>` | Pair a browser with the code the web client shows; list; unpair. |
| `harness browser-link` | Print a reusable seven-day setup link for browsers. |
| `harness remote-password set\|status\|clear` | This machine's persistent password for machine-to-machine links. |
| `harness link connect <id> [--name=<label>]` · `harness link list` · `harness link unlink <id>` | Let this machine reach another of yours, terminating E2EE here; list; unlink. |
| `harness remote` | From a Harness terminal tile: choose another of your machines (linking it on the spot if needed), open a terminal there and move this tile to it. |
| `harness grid login [--force] [--json]` · `harness grid logout` | Sign the `grid` CLI in with this computer's account, no second browser. |
| `harness flash [flags]` | Re-flash a plugged-in Harness device over USB. Flags pass straight to the flasher. |
| `harness autonomous-device discover\|status\|list\|pair\|revoke` | Pair Autonomous OS devices found on the LAN, directly, with no relay. |

Interactive prompts read one line from stdin with `--stdin`; `--json` switches any of them to NDJSON.

The daemon also serves a loopback dashboard at `http://127.0.0.1:18473`: health, this machine's
fingerprint, paired clients, stop. It never renders a transcript. Configuration is environment
variables (`BACKEND_WS_URL`, `WEB_URL`, `ADAPTER_DATA_DIR`, `ADAPTER_COMPUTER_ID`, `PORT`, and the
per-engine home directories); [`cli/README.md`](cli/README.md) has the full table and the
`.env.example`.

## Automation

The app is one client of the daemon. Anything on the same computer can be another: the loopback
WebSocket at `ws://127.0.0.1:18473/api/local-ws` takes a `machine_select` frame first
(`{ machineId, localProtocolVersion: 1 }`, no `Origin` header), then request frames with a `requestId`
and answers them with `<type>_result`. Selecting one of your other machines proxies the request
through this daemon's link to it.

What it answers: `agents_list`, `agent_create`, `agent_restart`, `agent_retarget`, `agent_delete`,
`agent_update`, `agent_recent`, `agent_files`, `agent_read_file` (text, or media in 128 KiB chunks),
`fs_list_dir`, `engines_probe`, `codex_profiles_list`, `codex_profile_link`, `models_list`,
`usage_read`, `question_response`, `voice_route`, `message`, `cancel`, and `terminal_open` for a
binary terminal channel with scroll, resync and paste. The same frames travel from the web client
over the relay.

Engines report in over HTTP on the same port: `POST /api/hook/session-start`, `session-end`,
`turn-start`, `turn-stop`, `tool-start`, authenticated by a per-install token the daemon writes into
the hook it installs.

There is no `harness new` or `harness split` today. Sessions are created and arranged through the app,
the web client, or this socket.
