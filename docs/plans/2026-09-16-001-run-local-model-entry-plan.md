# Talk to Model manager: one button, one dialog, one agent that starts it

> **Superseded (2026-09-18).** The door opens the **Grid** Store harness (`autonomous/autonomous-grid`)
> on the chosen machine — the same path as the Store's Open button — and the Store's page for Grid when
> it is not installed there. The dialog, the opencode `harness-compute` agent, its skill and the CLI
> installer for them are gone; the skill's verified facts moved into `store/agents/autonomous-grid`.
> The picker and `agent_retarget` (Changes 4/5 below) stay as built.


Status: proposed · 2026-09-16
Builds on: `2026-09-14-004-harness-grid-plan.md` (the private grid), `docs/skills/harness-compute.md`
(the skill an agent follows), commits `9dc4232`/`2d0cdf7` (the two model pickers) and `6bf3569`
(an opencode pane actually switching model).

## Context

A person can already end up with a model running on their own machine — but only by knowing to open
opencode and *ask* for it. The skill triggers on the ask; nothing in the app makes the ask. The
owner's brief: a visible entry — in the Models menu and in every pane's model picker — that opens
a short, honest dialog and then starts an agent which does the whole thing, so the user never has
to know what to type.

### What already works, and must not be rebuilt

- **The skill.** `docs/skills/harness-compute.md`, installed by `harness start` into
  `~/.config/opencode/skills/harness-compute/SKILL.md`. Triggered by "start a local model", it asks
  two questions through the agent's own question tool (what for, how much context), reads
  `grid catalog --json` for what fits this machine, pulls, joins, proves the model answers with
  `grid chat`, then tells the user to pick it from the model picker. It never says "grid".
- **Switching a pane to a Local model — the launch half.** `agent_retarget` writes a per-agent
  `opencode.json` under `~/.harness/cli/data/grid-engine-config/<key>/` (one provider, one model)
  and respawns the pane with `OPENCODE_CONFIG=<file> -m <provider>/<model> --session <id>`. The
  global `~/.config/opencode/opencode.json` is never opened. **Kept.** What changes is the second
  half — how the resumed session is made to *use* that model (Change 5).
- **Two pickers.** The pane header's (`grid_model_picker.dart`, opens on the daemon's 15s memo, refreshes
  behind itself) and the native Models menu's Local section (`SwarmTitlebar.swift`, data pushed from
  `swarm_screen.dart`). Both already say "Nothing is being served yet." when Local is empty — the
  sentence the new entry is the answer to.
- **Creating an agent with a launch shape.** `agent_create` (`backendSocket.ts`) takes `engine, cwd,
  codexHome, grid, dsh, creationId`; `engineLaunch.ts` turns that into argv/env. A DSH (main's
  domain-specific harnesses) already contributes `agent.args`/`agent.env` from its manifest and is
  drawn as its own identity in the header (`isHarnessId`), with a tile in New Agent.

### What is missing

1. An entry point. The native menu's "Add Model" was a placeholder and is gone; the pickers list what
   is served and stop there.
2. A first prompt. Nothing can open an agent *already asked* to start a local model — `agent_create`
   carries no prompt, and opencode's `--prompt <text>` (a TUI flag: starts the interactive TUI with
   that message submitted) is not used anywhere.
3. A moment of explanation. Opening an opencode pane with no framing reads as "why is a terminal
   here?". The owner wants a dialog that says what is about to happen, in the product's voice.

## Design principles

1. **Never the plumbing's name.** No "grid", no CLI, no model id the user did not pick, anywhere in
   the dialog, the menu items or the pane's name.
2. **Device-agnostic.** The product runs on macOS and Linux. "This computer" or the machine's own
   display name — never "this Mac".
3. **The agent does the work; the app only opens the door.** The dialog explains and starts. Every
   decision after that (what for, which model, go ahead on the slow steps) is the skill's, through the
   agent's question tool, in the pane.
4. **Same words in both doors.** Menu item and picker row read identically; both open the same dialog;
   the dialog is the only place the flow is explained.
5. **Say it once.** A "Don't show this again" tick: a person who has done this before goes straight
   to the pane. Stored in the app's config store, per user, not per machine.

## The dialog

Built on `showAppDialog` (`lib/shared/widgets/app_dialog.dart`), the app's one dialog recipe. Copy is
final unless the owner edits it; it is written the way the README is written — short, declarative,
second person, no exclamation marks, and no dashes of any kind:

```
A model that lives on your machine

Say what you'll use it for. Harness picks one that fits this computer,
brings it down, and starts it. Once it's running, switch to it in any
agent you want, right from that agent's model picker.

[ ] Don't show this again

                                        [ Not now ]   [ Start ]
```

- **Nothing about the machine.** An earlier draft carried a machine line (name, chip, usable
  memory) and a hint ("Type anything in the pane to begin"); the owner cut both — the body is the
  whole message, and the agent's first question in the pane is the instruction.
- **Prerequisites appear only when one is missing**, as one sentence under the body, with Start
  disabled: *"Needs opencode on this machine first."* (the same engine probe New Agent uses) or
  *"Sign in to Harness again to set this up."* (the machine's grid name is absent). Satisfied,
  nothing is said.
- **Buttons.** *Not now* dismisses. *Start* closes the dialog and creates the agent. No spinner: the
  pane appearing is the confirmation.
- **"Don't show this again"** — when ticked and Start pressed, `runLocalModel.skipDialog = true` in the
  config store. Every later entry goes straight to creating the agent. It is a checkbox in the
  dialog, not a menu setting, because the moment a person decides "I know this" is the moment they
  are looking at it.

## The pane

`Start` calls `AppNotifier.createAgent` on the local machine with `engine: 'opencode'`, `cwd` = the
user's home (a local model is not about a project), `agent: 'harness-compute'`, and the name
**"Local model"**. The daemon launches `opencode --agent harness-compute`: the pane opens *as* that
agent — its own name in the footer, its own system prompt — not as a general opencode session.
The user types anything ("go", "hi", a question) and the agent's first visible act is the skill's
first question, through its question tool.

**The agent definition** ships with Harness, beside the skill: `docs/skills/harness-compute.agent.md`,
installed by `harness start` into `~/.config/opencode/agents/harness-compute.md` the way the skill is
(idempotent, best-effort). It is short on purpose — everything it knows is the `harness-compute`
skill, which it loads first and follows; it declares `mode: primary` (so `--agent` and the TUI's
agent cycle can reach it) and `permission: question: allow` — measured: opencode denies the
`question` tool to custom agents by default, and without it the agent falls back to asking in prose,
which the skill forbids. It refuses unrelated coding asks in one line.

Why `--agent` and not a first prompt: a prompt would make the agent speak first, but the owner
wants the person to open the conversation; and the agent identity is what makes the pane read as
"the thing that starts a local model" rather than "a terminal that happens to be running opencode."
`agent_create`'s `prompt` (Change 1) stays as a generic capability; this flow does not send one.

## Changes

### Change 1 — CLI: `agent_create` carries `prompt`, `name` and `agent`

`cli/src/backendSocket.ts` (`agent_create`), `cli/src/lib/engineLaunch.ts`, `cli/src/lib/registry.ts`.

- `prompt?: string` — optional, trimmed, at most 2000 chars (a first message, not a document).
  `engineLaunch` appends the engine's own first-prompt argument: opencode `--prompt <text>`; Claude
  Code and Codex take it positionally; an engine with no documented mechanism gets
  `PROMPT_UNSUPPORTED` back **before** any pane is created, naming the engine. Only opencode is
  exercised by this plan; the others are wired because the flag is generic and the contract is
  documented per engine, the way `gridLaunch.ts` does it.
- `name?: string` — the row's `defaultName` (main added the field), so the pane is titled before the
  engine reports a session title, and stays titled if it never does.
- `agent?: string` — the engine's named agent to open as: opencode `--agent <name>` (verified:
  `opencode --help`); validated `^[A-Za-z0-9_-]{1,64}$`; any other engine with `agent` set →
  `AGENT_UNSUPPORTED` before a pane exists, naming the engine. Unlike `prompt`, the agent IS part of
  the relaunch record: a pane that was opened as `harness-compute` comes back as `harness-compute`.
- `prompt` is not persisted for relaunch: a relaunch resumes a session that already has its first turn.
  ⚠️ The prompt is user-visible text, but it still goes through argv only — never a log line — and it
  is not a secret; the rule is "don't log what the user typed", same as any prompt.

### Change 1b — CLI: install the `harness-compute` agent definition beside the skill

`cli/src/lib/harnessComputeSkill.ts`, `cli/build-bundle.mjs`, `cli/src/config/env.ts`
(`OPENCODE_AGENT_DIR`, default `$XDG_CONFIG_HOME/opencode/agents`), new `docs/skills/harness-compute.agent.md`.
Same installer, same idempotent write, same "never fails `harness start`" posture; the bundle ships
the file next to the skill. The source file carries the exact frontmatter opencode reads
(`name`, `description`, `mode: primary`, `color`, `permission: { question: allow }`).

### Change 2 — (dropped) hardware RPC

A `local_model_hardware` RPC fed the dialog's machine line; with that line cut, the RPC went too
rather than stay as unused plumbing. The skill reads `grid device-info` itself when it matters.

### Change 3 — Desktop: the dialog and the action

New `lib/widgets/run_local_model_dialog.dart`; `lib/state/app_state.dart` gains `runLocalModel()`
and `localModelHardware(machineId)`; config store gains `runLocalModel.skipDialog`.

`runLocalModel()` is the one action both doors call: if `skipDialog`, create the agent; else show the
dialog and create on Start. It picks the local machine (`isLocalMachine`) — a local model runs on the
computer the app is on; with no local machine it falls back to the focused one, and the machine line
says which.

### Change 4 — Desktop: the two doors

- **Pane picker** (`lib/widgets/grid_model_picker.dart`): a last row under Local, always present,
  after the models or after the empty-state sentence: **Talk to Model manager** — drawn as a row, not a
  header, and not tickable. Calls `onRunLocalModel`, a new callback `terminal_panel.dart` wires to
  `notifier.runLocalModel()`.
- **Native Models menu** (`desktop/macos/Runner/SwarmTitlebar.swift`, `lib/screens/swarm_screen.dart`):
  after the Local section, a separator and an enabled item **Talk to Model manager** dispatching
  `menuAction` `runLocalModel`; Dart maps it to `notifier.runLocalModel()` beside `newAgent`. The
  macOS check script (`desktop/tool/swarm_titlebar_checks.swift`) asserts the item exists, is enabled,
  and carries that action.

### Change 5 — opencode: a resumed session takes the model it was moved to

`cli/src/engines/opencode/sessionModel.ts` (new), `cli/src/cli.ts` (the retarget path around
`selectOpencodeModel`), `cli/src/lib/runtimeProfileController.ts` (the `/models` drive, removed).

**What opencode does, measured on 1.18.30 in a real TUI.** A resumed session ignores `-m`, ignores
`--fork -m`, ignores a top-level `model` in the config it is launched with, and ignores
`~/.local/state/opencode/model.json`. Its current model is the session's own: the last
`session.model.selected` event or, failing that, the last assistant message — both rows in
`~/.local/share/opencode/opencode.db`. Editing `session.model` alone changes nothing; rewriting the
session's last user message (`data.model`) and last assistant message (`data.modelID`/`providerID`)
plus `session.model` makes the resumed TUI open on the new model (footer confirmed). There is no
flag, config key or HTTP route (`/session/{id}/*`, `/api/model/*`, `/tui/*`) that sets a session's
model — the picker is the only writer opencode ships, which is why `6bf3569` drove it.

**The change.** Before the respawn, write what the picker writes — in the session, through SQL, one
transaction — then respawn with `--session <id>` as today. The TUI opens already on the model, no
typing into it, no dependence on its picker's layout. The `/models` drive and its
`MODEL_SELECT_FAILED` path go, along with their measurements; the launch record still carries the
model so `gridAssignment` reads the truth back off the process as before.

- **Access:** the `sqlite3` CLI, exactly as `engines/opencode/reader.ts` already reads this DB —
  same binary, same `OpencodeSqliteMissing` when absent, no new dependency. A missing `sqlite3`
  refuses the retarget *before* the pane is touched (`OPENCODE_SQLITE_MISSING`), since a respawn
  that then lands on the old model is the failure `6bf3569` was written against.
- **Write:** `UPDATE` only, never file operations. WAL mode is opencode's own; other opencode
  instances holding the DB keep working through a concurrent writer, and `PRAGMA busy_timeout` covers
  a write that lands during their checkpoint. ⚠️ Never copy, replace or delete the DB or its `-wal`
  / `-shm` — that is how this DB was damaged during research on 2026-09-16, and the recovery for that
  is a separate, owner-approved step.
- **Rows:** the session's `session.model` (`{"id","providerID","variant":"default"}`), and the model
  fields of its latest user and assistant messages — the exact set measured to take effect. If the
  source review (in flight) shows a `session.model.selected` event row is what the picker writes and
  is sufficient on its own, write that instead of touching message history; the plan's contract is
  "what the picker writes", not "these three rows".
- **Scope:** opencode only; the other engines' retarget contracts (`gridLaunch.ts`) are untouched.
- **Verify:** on a real served model, retarget an opencode pane from the picker; the footer shows the
  model, the conversation is still there, `gridAssignment` reports the new endpoint.

Upstream: file an issue with opencode asking that `-m` override a resumed session's model (or a
`--session-model` flag). When that ships, this change shrinks to passing `-m`.

## Testing

1. `engineLaunch.spec.ts`: opencode gets `--prompt <text>`; claude/codex get it positionally; an
   engine without a mechanism refuses with `PROMPT_UNSUPPORTED`; no prompt → argv unchanged; the
   prompt never appears in the launch record written to disk.
2. `backendSocket.spec.ts`: `agent_create` with `prompt`+`name` passes both through; `name` lands as
   `defaultName`; over-long prompt refused.
3. (dropped with Change 2)
4. `run_local_model_dialog_test.dart`: the copy (no dashes), nothing said when nothing is missing,
   the missing-opencode sentence disabling Start, the tick writing `skipDialog`, Not now creating nothing,
   Start creating an opencode agent as `harness-compute` with the name "Local model" and no prompt.
5. `grid_model_picker_test.dart`: the last row is present with models and with none, is not ticked,
   and fires `onRunLocalModel`; `models_menu_test.dart`: the native payload / `runLocalModel` command
   round-trips to `runLocalModel()`.
7. `sessionModel.spec.ts` (fixture `opencode.db` built in a temp dir with `sqlite3`): rewrites
   the session's model and the latest user/assistant messages only, leaves older messages and other
   sessions alone, is one transaction, and reports `OPENCODE_SQLITE_MISSING` when the CLI is absent.
   `cli.ts` retarget spec: no `/models` text is ever sent to the pane.
6. `swarm_titlebar_checks.swift` (`--window-layout`): the menu item exists after Local, enabled, action
   `runLocalModel`.

## Sequencing

| Phase | Contents | Parallel? |
|---|---|---|
| 1a | Change 1 (CLI `prompt`/`name`) | yes — its own files |
| 1c | Change 3 (dialog + action) | yes — new widget; touches `app_state.dart` for two methods |
| 1d | Change 4 (two doors) | after 1c's `runLocalModel()` signature exists; picker row and Swift item are independent of each other |
| 1e | Change 5 (opencode session model) | yes — its own files; the `/models` removal touches `cli.ts`/`runtimeProfileController.ts` |
| 1f | e2e on a served model, then build and hand to the owner | last |
| 2 | **Local model as a harness.** Promote to a DSH `autonomous/harness-compute` (`dsh/registry/…json`, a repo carrying the manifest with `engine: opencode`, `agent.args: ["--prompt", …]`): it then appears as a tile in New Agent and is drawn as its own identity in the header, with no opencode chip — an agent that *is* the thing, which is what the owner is asking to see. Phase 1's dialog and doors stay and simply create that harness. Needs a repo and the install step; recorded, not started. | follow-up |

## Open questions

None blocking. Recorded: whether "Local model" should be created in the user's home or in the focused
pane's project — home for now (the model is not project-scoped); revisit if people expect the agent
in their repo.
