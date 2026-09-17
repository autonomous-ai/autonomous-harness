# Domain-specific harnesses (DSH): MVP

Status: built · 2026-09-14 (visual check of the desktop web pane pending — see Verification)

## Context

Four Autonomous products — Workshop (3D CAD, the successor of Vibe), Circuit (PCB), TV (short
drama) and Battle (robot training) — are each "a coding agent plus a domain": ~1k lines of SKILL.md
prose that steers Claude Code or Codex, a deterministic pipeline and verifier the skills call, a
local web viewer, and a hand-copied shell (a Node driver that spawns the agent, a chat UI, a
catalog watcher, SSE). The shell is identical in every product and is what Harness already is.

A **domain-specific harness** is that product minus its shell: a git repo with a manifest, an
`AGENTS.md`, a skills folder, a workspace template, setup/doctor scripts, and an optional viewer.
Harness reads the manifest, materializes the workspace, launches the base engine in a tmux pane,
starts the viewer next to it, and watches one JSON file for the verdict.

Decisions already made (see the conversation of 2026-09-14):

- To the user a DSH is just another **engine tile** in Create Harness. Internally it is a
  **decoration on the session** (`dsh` field), never a new `AgentEngine` — the CLI switches on the
  engine in ~30 exhaustive sites and discovery cannot tell two engines that share one binary apart.
- One fixed base per DSH: **Circuit runs on `claude`, Workshop Make runs on `codex`**.
- Registry and spec live in this monorepo under `dsh/`. DSH repos stay separate.
- MVP scope: Circuit + Workshop, install by git URL or local path, macOS webview pane, verdict
  chip. Out of scope: registry UI, `progress.json`, remote-machine viewer tunneling, Linux webview.

## Contract

### `harness.json` (spec 1) — at the root of a DSH repo

```jsonc
{
  "spec": 1,
  "id": "autonomous/circuit",             // owner/name; the install dir and the wire id
  "name": "Circuit",                      // the picker tile
  "description": "Chat with AI → a board you can order",
  "engine": "claude",                     // base engine, one of ENGINES
  "workspace": {
    "template": "template",               // copied into an EMPTY workspace (no marker present)
    "marker": "product.json",             // relative path; present = already materialized
    "init": "toolchain/init-workspace.sh" // optional; run after the template copy, cwd = workspace
  },
  "agent": {
    "instructions": "AGENTS.md",          // copied to <workspace>/AGENTS.md, see below
    "skills": ["skills"],                 // dirs whose SKILL.md-bearing subdirs are linked in
    "env": { "CIRCUIT_TOOLCHAIN": "${dsh}/toolchain" },  // ${dsh} ${workspace} ${home} expand
    "args": []                            // appended to the base engine's argv
  },
  "toolchain": {
    "setup": "toolchain/setup.sh",        // run once at install, cwd = install dir
    "doctor": "toolchain/doctor.sh"       // exit 0 = ready; stdout lines are shown to the user
  },
  "viewer": {                             // optional (tier 2)
    "command": "toolchain/viewer.sh",     // long-running; env HARNESS_VIEWER_PORT, HARNESS_WORKSPACE
    "url": "http://127.0.0.1:${port}/?file=${artifact}",  // ${port} ${artifact} (url-encoded)
    "artifactExtensions": [".step", ".stl"]               // newest such file under the workspace
  },
  "verdict": ".harness/verdict.json"      // relative to the workspace; optional (tier 1+)
}
```

Materialization, in order, at every create (idempotent):

1. If `workspace.marker` is absent: copy `workspace.template/*` into the workspace, then run
   `workspace.init` if declared.
2. `AGENTS.md`: copy if absent; else append the DSH file under a marker line
   `<!-- harness:dsh <id> -->` if that marker is not already present. For a `claude` base also
   ensure `CLAUDE.md` contains `@AGENTS.md` (Claude Code reads `CLAUDE.md`, imports the rest).
3. Skills: symlink each skill dir into `<workspace>/.claude/skills/<name>` (claude) or
   `<workspace>/.agents/skills/<name>` (codex). Symlinks, so a DSH update is live.
4. Create `<workspace>/.harness/`.

Launch env, always: `HARNESS_DSH=<id>`, `HARNESS_DSH_DIR=<install dir>`,
`HARNESS_WORKSPACE=<workspace>`, plus `agent.env` expanded. Set through tmux `-e`, the same channel
grids and Codex profiles use, on create AND on every relaunch (`buildLaunchOverrides`).

### `.harness/verdict.json` (spec 1) — written by the DSH's own scripts

```jsonc
{
  "spec": 1,
  "ready": false,                         // the one machine fact: fab.ready, gates passed, exam passed
  "summary": "3 errors, 2 warnings",      // one line for the pane header
  "findings": [
    { "severity": "error", "kind": "source_trace_not_connected", "message": "…", "ref": "U3.pin7" }
  ],                                      // severity ∈ error | warning | info; kind is open
  "artifact": "boards/main.board.json",   // optional; primary thing to view, workspace-relative
  "updatedAt": "2026-09-14T20:00:00Z"
}
```

Lifted from Circuit's `.board.json` and TV's `.episode.json` sidecars (same severity gate). Circuit
writes it beside the sidecar in `circuitpy.generation`; Workshop writes it from `verify_project`.

### Wire (daemon ↔ desktop)

- `agent_create` payload gains `dsh?: string`. Refused with `INVALID_DSH` when not installed on
  this machine or when `engine` is not the DSH's base.
- `AgentFrame` gains `dsh: string | null`, `dshName: string | null`, `viewerUrl: string | null`,
  `verdict: { ready, summary, errors, warnings, artifact, updatedAt } | null`. Null is a real answer
  (see `agentFrame.ts`'s doc on erased fields).
- `dsh_list` → `{ dsh: [{ id, name, description, engine, installed, viewer, tier }] }`: installed
  DSHs on this machine merged with the bundled registry (`dsh/registry/**/*.json`).
- `dsh_install { id?, url?, ref? }` → runs clone → setup → doctor; pushes
  `dsh_install_status { id, phase: clone|setup|doctor|done|failed, detail? }`; replies `{ ok }` at
  the end (the desktop uses a 10-minute timeout for this one request).
- Discovery reads `HARNESS_DSH` off the live process (`probeDsh`, same cached env read as
  `probeCodexHome`) so a pane the daemon did not create, or re-minted after a restart, is labelled.

### On disk

```
~/.harness/dsh/
  installed.json                # [{ id, dir, source, ref, commit, installedAt }]
  autonomous/circuit/           # clone, or a symlink when installed with --link (dev loop)
  autonomous/workshop/
```

CLI: `harness dsh install <git-url|path> [--link] [--ref <ref>]`, `harness dsh list`,
`harness dsh doctor <id>`, `harness dsh remove <id>`.

### In the monorepo

```
dsh/
  README.md            what a DSH is, the tiers, how to publish
  spec/README.md       this contract, frozen; CHANGES.md is append-only
  spec/schema/         harness.schema.json, verdict.schema.json
  registry/autonomous/ circuit.json, workshop.json   (bundled into the CLI at build time)
  starter-dsh/         tier 0: manifest + AGENTS.md + one skill; the CLI's test fixture
cli/src/dsh/           manifest, install, materialize, viewer, verdict, probe
desktop/lib/dsh/       catalog, web pane, verdict chip
```

## Changes

### 1. CLI (`cli/src/dsh/`)

- `manifest.ts`: zod schema for `harness.json`; `loadInstalledDsh()` reads `installed.json` and
  each manifest; `expandDshEnv()`.
- `install.ts`: `installDsh({ url|path, ref, link })` → clone or symlink → `toolchain.setup` →
  `toolchain.doctor` → write `installed.json`. `removeDsh`, `dshDoctor`.
- `materialize.ts`: steps 1–4 above; pure over an injected fs for the spec.
- `registry.ts`: `RegisteredSession.dsh?: string | null` + validators; `openPendingAgent` accepts it.
- `agentFrame.ts`: the four new fields; `AgentFrameContext` gains `viewerUrl`, `verdict`.
- `backendSocket.ts`: `agent_create` validation, `dsh_list`, `dsh_install`.
- `cli.ts` `onCreateAgent`: materialize before `createAndRegisterPane`, env through
  `createAndRegisterPane({ env })`; `launchOverrides.ts` adds the same env for restart/restore.
- `probe.ts`: `probeDsh(identity)`; `terminalAgentDiscovery.ts` attaches `dsh`; the reconciler's
  `onDiscovered`/`onObserved` carry it into the registry.
- `viewer.ts`: `DshViewerManager` — one child process per DSH agent with a viewer: free port,
  spawn, wait for the port, publish `viewerUrl`; re-publish when the newest artifact changes;
  bounded restart on exit; torn down in `cancelAgent`/delete.
- `verdict.ts`: `DshVerdictWatcher` — chokidar on the verdict file; parse; publish.
- `cli.ts` subcommands: `dsh install|list|doctor|remove`.
- Registry JSON files imported into the bundle (`dsh/registry/autonomous/*.json`).

### 2. Desktop

- `core/models.dart`: `Agent.dsh`, `dshName`, `viewerUrl`, `verdict`.
- `widgets/engine_identity.dart`: identities for `autonomous/circuit` and `autonomous/workshop`
  with PNG marks in `assets/engine-icons/`; `agentIdentity(agent)` = `dsh ?? engine`.
- `state/app_state.dart`: per-machine DSH catalog (`dsh_list`), `dsh_install` with status panel,
  create sends `{engine: base, dsh: id}`; `_handleEvent` opens/updates/closes the viewer pane.
- `widgets/agent_picker.dart` + `new_agent_dialog.dart`: quick row = Codex, Claude Code, Circuit,
  Workshop; overflow lists everything; "Harness will install Circuit on <machine>" note.
- `state/terminal_pane.dart`: `PaneKind { terminal, web }`, `url`, `ownerAgentId`. Web panes are
  derived from agents and not persisted.
- `widgets/web_pane_panel.dart`: `webview_flutter` (macOS via `webview_flutter_wkwebview`), the
  one native plugin this work adds; `_PaneContent` dispatches on kind.
- `widgets/terminal_panel.dart`: verdict chip in the status slot; add to `_headerPresentation`.

### 3. Circuit (`autonomous-circuit`, branch `harness-dsh`)

- `harness.json`, `AGENTS.md` (the driver's PLAN/IMPLEMENT/REVIEW prompts as a file),
  `template/` (the project skeleton), `toolchain/{setup,doctor,viewer}.sh`.
- Viewer-only mode: `CIRCUIT_WORKSPACE=<dir>` serves that one workspace; client hides chat and
  onboarding when the server says `viewerOnly`.
- `circuitpy.generation` writes `.harness/verdict.json` beside the sidecar.
- SKILL.md paths `~/.claude/skills/<x>` → `${CIRCUIT_SKILLS_DIR:-~/.claude/skills}/<x>`.

### 4. Workshop (`autonomous-workshop`, branch `harness-dsh`)

- `harness.json` (engine `codex`), `AGENTS.md` (Make only), `template/`, `toolchain/{setup,doctor,viewer}.sh`.
- `viewer/`: Vibe's prebuilt CAD viewer runtime (`skills/cad-viewer/scripts/viewer/{backend,dist}`)
  vendored; `viewer.sh` runs it with `VIEWER_LOCAL_WORKSPACE_ROOT=$HARNESS_WORKSPACE`.
- `verify_project` writes `.harness/verdict.json`.

## Verification

Done on 2026-09-14, on this Mac:

- `make cli-test`: 2,228 tests green (37 new under `cli/src/dsh/`). `flutter test`: 1,406 green, the
  two pre-existing failures unchanged. `harness dsh check` passes for the starter, Circuit and Workshop.
- Daemon-level, over the same loopback WebSocket the desktop uses (`agent_create` with `dsh`): the
  workspace is materialized (template, AGENTS.md under its marker, CLAUDE.md import, six skill links,
  `.harness/`), the viewer is up on a free port within a second, the engine's environment carries
  `HARNESS_DSH`, a real Circuit build's `.harness/verdict.json` reaches the client as a `verdict`
  frame in the same second, and `agent_delete` takes the viewer with it. `agent_restart` keeps the
  DSH; a pane started by hand with `-e HARNESS_DSH=autonomous/circuit` is discovered as Circuit.
- Circuit and Workshop each proven standalone by their packaging: setup, doctor, a real build writing
  the verdict, the viewer-only page serving the board / the STEP.

Still to see with eyes: the desktop's Create Harness → Circuit → prompt → board-in-pane loop, and
the WKWebView pane on both the Skia and Impeller builds. The app was built and launched from the
worktree, but the screen was locked for the session that would have clicked through it.

## What the first full run found (2026-09-15, overnight)

All three harnesses ran end to end in the app on this Mac, driven by computer use: Circuit to a
fab-ready board, Marp to a ten-slide deck, Workshop to a printable phone stand, each in a tab of its
own with the viewer left, the terminal right, the chip and the phase strip moving in the viewer's
header. Fixed on the way: WKWebView's missing background-colour call on macOS (a red pane), the
harness tab's target when the dialog passes the current tab, the strip gated on a non-compact
header, the search preview drawing the base engine. Left for a decision:

- **Remote machines.** The viewer is a loopback server where the agent runs; the webview loads
  `127.0.0.1`. A remote harness needs the daemon to forward that port through the relay — an HTTP
  (plus SSE/WebSocket) tunnel over the machine WS, terminated by a local proxy in the app. Not
  started; the MVP is local-only by construction.
- **Daemon restart with the app open.** Once, the previous app instance dropped the three harness
  agents' panes when the daemon restarted (the user's own agents survived); a second restart kept
  them but added the last-selected harness agent to the active tab as a second pane. Both look like
  main's offline auto-reattach (`pendingOfflineAgentId`) meeting multi-tab; not touched here.
- **Circuit's vendored runtime.** `skills/circuitcode/scripts/packages/circuitpy` is an untracked
  copy refreshed by `scripts/build/build-skill-runtimes.sh`; a linked checkout goes stale after a
  rebase until it is rerun (the agent hit missing `repair.checkpoint`). `setup.sh` runs it, so a
  git-URL install is fine; `harness dsh install --link` could run setup on every daemon start.
- **Clickable phases.** A done phase with an artifact could swap the viewer to it; the URL
  template lives in the daemon, so it is a `dsh_view { agentId, artifact }` request, not a desktop
  change alone.
- **Marp's repo** is local only at the time (its own checkout, branch `harness-dsh`); the
  registry entry names `github.com/autonomous-ai/autonomous-marp`, which must exist before a
  git-URL install can work.
