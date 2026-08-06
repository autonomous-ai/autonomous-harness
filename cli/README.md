# harness

**Run the coding-agent CLIs you already use, and drive them from anywhere.**

`harness` watches the agent sessions you start in **tmux** on your own machine — Claude Code, Codex,
Cursor, OpenCode, Pi, Hermes, Command Code, Devin — and bridges them to a web UI and, optionally, to a
paired hardware device. The agents keep running as your processes, in your terminal, with your
credentials; this is a bridge, not a wrapper.

- Every agent you open in a tmux pane shows up as an agent you can talk to from the browser.
- Turns, tool calls, todo lists and sub-agents stream out as they happen.
- The browser channel is end-to-end encrypted (see `src/lib/e2ee/`).
- One self-contained bundle, no native dependencies: Node ≥ 20 and `tmux` are all you need.

## Install & run (`harness`)

Prerequisite: **Node ≥ 20**. Create or open a remote machine in the web UI first, then copy its connect
token into the installer:

```bash
curl -fsSL https://harness.autonomous.ai/install.sh | bash -s -- <token>
```

(The installer is a first-party hosted script; it downloads the published bundle and writes a
`~/.local/bin/harness` launcher.)

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
`WEB_URL/machine/<agentId>`) then detaches; raw logs go to `${ADAPTER_DATA_DIR}/machine.log`. The
credential is persisted to `${ADAPTER_DATA_DIR}/token`, so later runs are just `harness join`.

The log is **capped at 10 MB**: the daemon checks the size every minute and, over the cap, rewrites the
file with the newest half (the oldest lines are dropped, marked by a `[log] trimmed` line at the top).
It's one file, not a rotation — 10 MB is the total on disk. A pre-rename `adapter.log` is adopted by
rename on the first daemon start, so existing history carries over.

The daemon **auto-updates itself** — it polls the release manifest (default every 60 s) and, on a newer
build, downloads + verifies + swaps its own bundle and restarts when idle (with rollback on a bad
build). See [`RELEASE.md`](RELEASE.md) for publishing and the update internals. Disable with
`ADAPTER_UPDATE_DISABLE=true`.

**From source (dev):** `cd this package && npm install && npm run build && node dist/cli.js join <token>`
(or `npm run dev -- join` via tsx — always foreground; self-update is off in dev). `npm run bundle`
produces the single-file release artifact.

**Install your build as `harness` (no release):** `bash scripts/install-cli.sh` bundles this
working tree into `~/.harness/cli` — the same layout the public installer produces — and restarts the
daemon on it, so `harness` on this computer means your code without publishing a version. Self-update is
turned **off** in the launcher it writes (otherwise the published release overwrites your build within
the minute). See [`RELEASE.md`](RELEASE.md#local-install-no-upload).

## How it works

```
claude in tmux pane %3 ──writes──▶ ~/.claude/projects/**.jsonl
        ▲                                   │ chokidar + byte-offset tail (only new lines)
        │ sendToTmux (tmux send-keys)       ▼ normalize → ServerEvents (+ derived turn lifecycle)
   adapter CLI ◀────── down:{agentId} ── backend /api/adapter-ws ── up:{agentId} ──▶ web chat
```

- **The adapter emulates a node** for its agentId on the backend hub: it answers the hosted runtime RPCs
  (`projects_list` = the registered tmux sessions, `sessions_list`, `session_get` = full JSONL
  replay, `project_files`/`project_read_file` = the session's cwd file tree + file view,
  `models_list`, `claude_login_status`) and consumes web chat frames.
- **Files panel** (`project_files`/`project_read_file`): rooted at the tmux session's working dir,
  it lists the tree (ignoring `node_modules`/`.git`/`dist`/… like the hosted runtime) and views a file only
  if it's **≤ 5 MB and text** (binary → rejected). The same guard was added to the hosted runtime so
  both behave identically.
- **Hooks** (auto-installed into `~/.claude/settings.json`, tmux-only via `$TMUX_PANE`):
  `SessionStart` registers, `SessionEnd` unregisters, and **`UserPromptSubmit`** is a *catch* hook
  that re-registers on every prompt so a session whose SessionStart was missed still appears. A
  **pane reaper** drops sessions whose pane was hard-killed.
- **Live session sync** to web + device: on register → `agent_synced` (web tab) + `agent_renamed`
  (device tile add); on removal → `agent_deleted` (both). One session **per tmux pane**.
- **SessionEnd removes the session** — the list reflects *running* claude sessions. Exiting claude
  (Ctrl+D / Ctrl+C×2) ends the session and drops it from the list **even though the tmux pane is
  still alive** (the user is back at the shell; claude isn't running). A later `claude --resume`
  fires SessionStart and **adds it back**. The one exception is `/clear`, which rotates in place: a
  fresh SessionStart for the same pane follows immediately and replaces the old session via
  pane-dedup, so it's kept to avoid a flicker.
- **Reaper backstop:** when SessionEnd never fires (hard kill, pane closed) the tmux reaper polls
  `tmux list-panes` and drops sessions whose pane is gone.
- **Mirror-all**: every JSONL line streams up — prompts typed directly in the terminal render in
  the web identically to web-sent ones (`turn_started`/`turn_ended` are derived from the file).
- **Compaction (`/compact` or auto-compact):** claude does an **in-file** compact — the JSONL keeps
  the **same sessionId** and stays **append-only** (pre-compact history is preserved on disk), so the
  byte-offset tail streams straight through with no dead file and no truncation re-read. The injected
  `system`/`compact_boundary` line becomes a single `context_compact` UI hint; the big
  `isCompactSummary` summary line and any `isMeta` bookkeeping line are **suppressed via those
  authoritative flags** (`compactEventFromRaw` in `lib/normalize.ts`) so the summary is never rendered
  as a fake user turn — an auto-compact firing mid-turn keeps the open turn open.
- A web chat message arrives as a `message` frame → injected into the session's pane via
  `tmux send-keys -l <text>` + `Enter`.

## Config (`.env`, see `.env.example`)

| var | default | meaning |
|-----|---------|---------|
| `BACKEND_WS_URL` | `wss://harness-api.autonomous.ai` | backend to dial (`/api/adapter-ws`) |
| `ADAPTER_TOKEN` | *(unset)* | pair token override (else CLI arg / saved file) |
| `PORT` | `18473` | localhost port for the hook callbacks (FIXED — if taken, the adapter reports it rather than picking a random port) |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | where Claude writes session JSONL |
| `ADAPTER_DATA_DIR` | `~/.harness/cli/data` | registry + token persistence |
| `DISABLE_HOOK_INSTALL` | `false` | skip auto-installing the claude hooks |
| `TMUX_REAP_INTERVAL_MS` | `5000` | how often the reaper drops dead-pane sessions |
| `ADAPTER_UPDATE_URL` | `…/adapter/metadata.json` | GCS release manifest the daemon polls for a newer build |
| `ADAPTER_UPDATE_KEY` | `cli` | manifest key for this CLI |
| `ADAPTER_UPDATE_CHECK_MS` | `60000` | how often (ms) to poll for a newer build (check also runs on start) |
| `ADAPTER_UPDATE_DISABLE` | `false` | set `true` to turn self-update off |
| `ADAPTER_CLI_DIR` | `~/.harness/cli` | install dir holding the `cli.js`/`notify.mjs` the updater swaps |

## Device (hardware commander)

A paired device mirrors the same agent. The adapter emits a curated **commander stream** from the
same watched JSONL (via `sendCommander`, `commanderEligible`): `commander_event` cards —
`processing` (busy), `tool` (name + arg + color), `todos` checklist, `summary`, `done` (clear busy).
It answers the device's `projects_list` (tiles) and `project_recent` (last summary) RPCs; voice
turns arrive as an injected `message` → `sendToTmux`. A device that joins **mid-turn** converges via
a client-count signal (`__clients`) — the adapter re-emits the open turn's live state on join (no
periodic heartbeat).

The per-turn **summary/recap** matches the hosted runtime: on turn end, *only while a device is
connected*, the adapter runs a disposable one-shot from the session's own CLI engine
(`SUMMARY_MODEL`, `CODEX_SUMMARY_MODEL`, or `CURSOR_SUMMARY_MODEL`) → `recap ≤15 words\n\n
body ≤200`, shows a `Summarizing…` indicator while it runs, persists it per session
(`${ADAPTER_DATA_DIR}/summaries.json`), and returns it on `project_recent` at device boot. A newer
turn aborts a stale recap.

## v1 limitations

- Permission / question prompts are answered **in your terminal** (claude runs interactively);
  neither the web nor the device shows those modals for remote agents.
- `new_chat` / `/compact` from the web are no-ops; `cancel` best-effort sends `C-c` to the pane.
- **One computer per machine.** The first computer to connect claims the machine; a *different* computer that
  tries to join the same machine is rejected (HTTP 409) and prints an info message ("already connected
  from another computer") then stops — it keeps its token but does not take over. Enforced by a stable
  per-computer id (`${ADAPTER_DATA_DIR}/computer-id`) sent as `?computer=` and a server-side ownership claim, so
  the *same* machine reconnecting after a blip/restart always reclaims. Stop the adapter on the first
  machine (or wait for its presence to expire, ~30s) to move the machine to another computer.
- Projects are tmux sessions — **create / rename / delete are disabled** (web hides them; the
  adapter rejects the RPCs with `UNSUPPORTED_ON_REMOTE`).
- Device recap uses the same Claude, Codex, or Cursor CLI engine as the session
  (device-gated, like the hosted runtime); no sub-agent rows.
