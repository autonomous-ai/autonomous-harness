# harness

**Run the coding-agent CLIs you already use, and drive them from anywhere.**

`harness` watches the agent sessions you start in **tmux, Herdr, or both** on your own machine and bridges them to a
web UI and, optionally, to a paired hardware device. The agents keep running as your processes, in
your terminal, with your credentials; this is a bridge, not a wrapper.

It works with the popular coding agents — [`src/engines/`](src/engines/) is the current list, one
folder per agent, and yours can join them.

- Every supported agent process under a configured terminal backend shows up as one agent you can talk to from the browser.
- Turns, tool calls, todo lists and sub-agents stream out as they happen.
- The browser channel is end-to-end encrypted (see `src/lib/e2ee/`).
- One self-contained bundle with no Node native dependencies. Node ≥ 20 plus tmux and/or Herdr 0.8.x is required.

## Supported platforms

**macOS** and **Linux** (Ubuntu 22.04+ verified, bare metal and containers alike). The published
artifact is one pure-JS bundle run by your own Node, so there is no per-OS build to pick and no
native module to compile — the same `cli.js` runs everywhere.

| Requirement | Notes |
|---|---|
| **Node ≥ 20** | On Ubuntu the distro `nodejs` package is too old (24.04 ships 18.19, 22.04 ships 12.22). Install from [NodeSource](https://github.com/nodesource/distributions) or `nvm install 20`. |
| **tmux and/or Herdr 0.8.x** | How agents are discovered. Neither is preinstalled on Ubuntu Server: `sudo apt install tmux`. |
| **`sqlite3` CLI** | Only for the store-backed engines (`opencode`, `kilo`, `hermes`, `devin`), which keep conversations in SQLite instead of a transcript file. Present by default on macOS, **not** on Ubuntu: `sudo apt install sqlite3`. Every other engine works without it, and the daemon says so at startup if it is missing. |

Windows is not supported.

## Install & run (`harness`)

Prerequisite: **Node ≥ 20**. Create or open a remote machine in the web UI first, then copy its connect
token into the installer:

```bash
curl -fsSL https://harness.autonomous.ai/install.sh | bash -s -- <token>
```

(The installer is a first-party hosted script; it downloads the published bundle and writes the
`~/.local/bin/harness` command.)

```bash
harness join <token>  # connect this computer to an existing machine
harness join          # reconnects with the saved credential
harness status     # is it running? shows pid + the chat link
harness stop       # stop the background adapter
harness version    # print the installed version
harness unjoin     # leave the machine (also removes it on the web) + clear the saved credential
harness join -f    # reconnect in the FOREGROUND (for a supervisor: pm2/systemd), logs to stdout
```

`join` prints a uniform info block (status, backend, pid, logs, and the **web chat link**
`WEB_URL/machine/<agentId>`) then detaches; raw logs go to `${ADAPTER_DATA_DIR}/harness.log`. The
credential is persisted to `${ADAPTER_DATA_DIR}/token`, so later runs are just `harness join`.

The log is **capped at 10 MB**: the daemon checks the size every minute and, over the cap, rewrites the
file with the newest half (the oldest lines are dropped, marked by a `[log] trimmed` line at the top).
It's one file, not a rotation — 10 MB is the total on disk. A log left under a pre-rename name
(`machine.log`, or the older `adapter.log`) is adopted by rename on the first start, so existing history
carries over.

The daemon **auto-updates itself** — it polls the release manifest (default every 60 s) and, on a newer
build, downloads + verifies + swaps its own bundle and restarts when idle (with rollback on a bad
build). See [`RELEASE.md`](RELEASE.md) for publishing and the update internals. Disable with
`ADAPTER_UPDATE_DISABLE=true`.

Custom Herdr-capable builds must keep self-update disabled or use a fork-owned signed
`ADAPTER_UPDATE_URL` until that build is available in the configured upstream manifest. Otherwise the
updater can legitimately replace the custom bundle with a release that lacks its terminal support.

**From source (dev):** `cd this package && npm install && npm run build && node dist/cli.js join <token>`
(or `npm run dev -- join` via tsx — always foreground; self-update is off in dev). `npm run bundle`
produces the single-file release artifact.

**Install your build as `harness` (no release):** `bash scripts/install-cli.sh` bundles this
working tree into `~/.harness/cli` — the same layout the public installer produces — and restarts the
daemon on it, so `harness` on this computer means your code without publishing a version. Self-update is
turned **off** in the command shim it writes (otherwise the published release overwrites your build within
the minute). See [`RELEASE.md`](RELEASE.md#local-install-no-upload).

After joining, start each agent yourself in tmux or Herdr with its normal vendor command. Harness
observes the process; it does not launch the CLI or choose its permission/trust flags:

```bash
tmux new
claude                    # or: codex, agent, opencode, pi, hermes, cmd, devin, muse, amp, kilo, grok

# Or the same engines under Herdr — nothing to configure, and both at once is fine:
herdr
claude
```

Both multiplexers are watched by default, and a Herdr session started after the daemon is adopted on
the next scan. There is no env var to set for either one.

Each supported top-level CLI process appears automatically. Exiting or deleting the agent stops only
the validated engine process; Harness never closes the user-owned tmux or Herdr pane.

## How it works

```
claude under a terminal backend ──writes──▶ ~/.claude/projects/**.jsonl
        ▲                                   │ chokidar + byte-offset tail (only new lines)
        │ backend input contract            ▼ normalize → ServerEvents (+ derived turn lifecycle)
   adapter CLI ◀────── down:{agentId} ── backend /api/adapter-ws ── up:{agentId} ──▶ web chat
```

- **The adapter emulates a node** on the backend hub: it answers the hosted runtime RPCs
  (`agents_list` = discovered engine processes, `sessions_list`, `session_get` = full JSONL
  replay, `project_files`/`project_read_file` = the session's cwd file tree + file view,
  `models_list`, `claude_login_status`) and consumes web chat frames.
- **Files panel** (`project_files`/`project_read_file`): rooted at the tmux session's working dir,
  it lists the tree (ignoring `node_modules`/`.git`/`dist`/… like the hosted runtime) and views a file only
  if it's **≤ 5 MB and text** (binary → rejected). The same guard was added to the hosted runtime so
  both behave identically.
- **Process discovery is lifetime authority.** On startup and every five seconds the daemon reads each
  configured terminal inventory and one shared process table. A supported top-level engine creates an agent immediately,
  before an engine session exists. A changed process in the same pane replaces it immediately; an absent
  process is removed after two successful scans. Probe failures do not remove anything.
- **Hooks bind mutable engine sessions** to the process agent using authenticated tmux and/or Herdr
  runtime hints plus verified caller ancestry. Hook socket paths are lookup hints only. They do not
  require `MACHINE_ID`. `SessionStart` and catch hooks attach transcript/store metadata; `SessionEnd` only
  requests an immediate process reconciliation. `/clear`, `/new`, and resume move or rotate the binding
  without changing the live process agent's UUID.
- **Live agent sync** to web + device: discovery emits `agent_synced` immediately, even with no session;
  binding later emits session sync, and confirmed process exit emits one `agent_deleted`. A sessionless
  agent returns an empty `sessions_list`, accepts input by `agentId`, and binds after the first turn.
- **Mirror-all**: every JSONL line streams up — prompts typed directly in the terminal render in
  the web identically to web-sent ones (`turn_started`/`turn_ended` are derived from the file).
- **Compaction (`/compact` or auto-compact):** claude does an **in-file** compact — the JSONL keeps
  the **same sessionId** and stays **append-only** (pre-compact history is preserved on disk), so the
  byte-offset tail streams straight through with no dead file and no truncation re-read. The injected
  `system`/`compact_boundary` line becomes a single `context_compact` UI hint; the big
  `isCompactSummary` summary line and any `isMeta` bookkeeping line are **suppressed via those
  authoritative flags** (`compactEventFromRaw` in `lib/normalize.ts`) so the summary is never rendered
  as a fake user turn — an auto-compact firing mid-turn keeps the open turn open.
- A web chat message arrives as a `message` frame and is submitted through one validated primary runtime.
  Herdr prompt bytes use its bounded local socket API and never command-line arguments or environment.

### Terminal backend behavior

- **Unset means auto.** Every backend usable on the machine is watched: tmux always, Herdr whenever its
  binary is on `PATH`. A machine without Herdr pays a few `PATH` lookups and never spawns anything.
- `TERMINAL_BACKENDS` overrides that with a strict ordered list — `tmux`, `herdr`, or `tmux,herdr`.
  `TERMINAL_BACKENDS=tmux` is how you turn Herdr off.
- `HERDR_SESSIONS` unset means every session Herdr reports as **running** is adopted, so a session
  started later needs no restart. Setting it makes a strict allowlist that discovery never widens.
- Harness never auto-starts a session, and never connects to a socket supplied only by a hook. A hook's
  socket path only ever SELECTS among endpoints already validated at discovery — it can never introduce
  one. (It has to be accepted at all because herdr 0.8.0 exports `HERDR_PANE_ID` and
  `HERDR_SOCKET_PATH` but **no session name**; matching endpoints by name rejected every real hook, so
  nothing bound and resumed conversations opened blank.) Herdr support is pinned to compatible 0.8.x,
  protocol 19.
- `harness status` answers "is my pane being watched?" — `terminalSelection` says `auto` or `configured`,
  and `terminalTargets` lists what is live right now, not what was configured at boot.
- The shared backend contract can create and close a tmux session or Herdr workspace when explicitly
  invoked. This is lifecycle capability, not automatic startup behavior; normal discovery observes
  user-owned sessions, and agent deletion still terminates only the validated engine process.
- One process visible through nested/coexisting backends remains one Harness agent with multiple runtime
  locators. A Herdr workspace move preserves its stable terminal identity; an engine process replacement does not.
- Backend and endpoint failures are independent. A failed probe is `unknown`, not proof of death. An
  agent with no verified runtime becomes dormant and is republished with the same id after recovery.
- Existing `tmuxPane` registry rows migrate in place. tmux rows retain their legacy projection during
  the compatibility window; Herdr-only rows never claim a tmux pane. For code rollback, stop the daemon,
  archive the mixed registry, and give the old binary a copied tmux-only projection.

For reproducible multiplexer verification, install dependencies and run both opt-in real suites from
`cli/` under a normal umask:

```bash
umask 022
npm ci
npm run test:tmux-real
npm run test:herdr-real
```

The Herdr suite requires Herdr 0.8.x protocol 19. Both suites use isolated, test-owned lifecycle
fixtures. Their engine matrix explicitly skips commands that are not installed; authentication or
first-run onboarding that prevents a proprietary CLI from running is unavailable evidence and must be
reported as such, not described as exercised.

## Config (`.env`, see `.env.example`)

| var | default | meaning |
|-----|---------|---------|
| `BACKEND_WS_URL` | `wss://harness-api.autonomous.ai` | backend to dial (`/api/adapter-ws`) |
| `ADAPTER_TOKEN` | *(unset)* | pair token override (else CLI arg / saved file) |
| `PORT` | `18473` | localhost port for the hook callbacks (FIXED — if taken, the adapter reports it rather than picking a random port) |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | where Claude writes session JSONL |
| `ADAPTER_DATA_DIR` | `~/.harness/cli/data` | registry + token persistence |
| `DISABLE_HOOK_INSTALL` | `false` | skip auto-installing the claude hooks |
| `TERMINAL_BACKENDS` | *(auto)* | pin the set: `tmux`, `herdr`, or `tmux,herdr`. Unset = every usable backend |
| `HERDR_SESSIONS` | *(auto)* | pin an allowlist. Unset = every running Herdr session is adopted |
| `HERDR_BIN` | `herdr` | Herdr executable used only for session discovery/diagnostics |
| `TERMINAL_RECONCILE_INTERVAL_MS` | `5000` | backend-neutral discovery interval; minimum 5000 ms |
| `TMUX_REAP_INTERVAL_MS` | `5000` | process discovery interval (removal requires two confirmed misses) |
| `ADAPTER_UPDATE_URL` | `…/adapter/metadata.json` | GCS release manifest the daemon polls for a newer build |
| `ADAPTER_UPDATE_KEY` | `cli` | manifest key for this CLI |
| `ADAPTER_UPDATE_CHECK_MS` | `60000` | how often (ms) to poll for a newer build (check also runs on start) |
| `ADAPTER_UPDATE_DISABLE` | `false` | set `true` to turn self-update off |
| `ADAPTER_CLI_DIR` | `~/.harness/cli` | install dir holding the `cli.js`/`notify.mjs` the updater swaps |
| `LOG_FRAMES` | `false` | one log line per backend frame — type, audience and opaque ids, never a payload body. Every content-bearing frame is encrypted before it reaches the socket, so this is the only way to see what the daemon actually sent |
| `HARNESS_HOOK_DEADLINE_MS` | `4500` | wall-clock budget a hook gives itself before abandoning optional work. Raise it on a slow or heavily loaded machine, where the budget is spent on load rather than on the hook and the offline registry fallback silently does nothing. Clamped, never below the default |
| `ORI_SUMMARY_MODEL` | `deepseek/deepseek-v4-flash` | recap model for agents routed through an OpenRouter gateway (`ori claude`), which have no vendor credential to spend |
| `ORI_VOICE_ROUTE_MODEL` | `deepseek/deepseek-v4-flash` | same, for the voice router's classification |
| `ORI_CREDENTIALS_PATH` | `~/.ori/credentials.json` | where `ori login` stores its key; read only when neither the daemon env nor the agent's own process supplies one |

## Device (hardware commander)

A paired device mirrors the same agent. The adapter emits a curated **commander stream** from the
same watched JSONL (via `sendCommander`, `commanderEligible`): `commander_event` cards —
`processing` (busy), `tool` (name + arg + color), `todos` checklist, `summary`, `done` (clear busy).
It answers the device's `agents_list` (tiles) and `agent_recent` (last summary) RPCs; voice
turns arrive as an injected `message` → `sendToTmux`. A device that joins **mid-turn** converges via
a client-count signal (`__clients`) — the adapter re-emits the open turn's live state on join (no
periodic heartbeat).

The per-turn **summary/recap** matches the hosted runtime: on turn end, *only while a device is
connected*, the adapter runs a disposable one-shot from the session's own CLI engine
(`SUMMARY_MODEL`, `CODEX_SUMMARY_MODEL`, or `CURSOR_SUMMARY_MODEL`) → `recap ≤15 words\n\n
body ≤200`, shows a `Summarizing…` indicator while it runs, persists it per session
(`${ADAPTER_DATA_DIR}/summaries.json`), and returns it on `project_recent` at device boot. A newer
turn aborts a stale recap.
