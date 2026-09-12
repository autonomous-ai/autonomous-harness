# Harness App V2 — development handoff

Updated 2026-09-12. This is a working preview, not a release or a finished implementation.

## Resume here

- Repository: https://github.com/autonomous-ai/autonomous-harness
- Branch: `app-v2`, tracking `origin/app-v2` in that repository.
- Resume folder: `/Users/ab/code/autonomous-harness`.
- Desktop: `desktop/`. CLI: `cli/`. Backend: `backend/`.
- The user reviewed the running native app, liked the direction, and requested that all work move into this monorepo branch. After branch creation and documentation, stop so the user can resume in that folder/branch.
- Continue implementation there. Do not create another repository or fork for V2.

```bash
cd /Users/ab/code/autonomous-harness
git status --short -b
git remote -v
git log -1 --oneline
```

The preview was developed from monorepo commit `9bd8cf1667310def711e8c491c9e6b317cdece78`, then the tip of `internal/monorepo-move`. `app-v2` preserves that history and the current implementation. At migration, `origin/main` was `84a23e5f8d358b78d24ba92ce185b482b5f97ebc`, three commits ahead of this base. Those commits add reboot restoration, change release CI, and fix terminal input sequence recovery; they have **not** been incorporated here. Bring main forward deliberately next session, especially `app_state.dart` and terminal recovery tests. This is already monorepo history, so a later merge requires no repository import.

The former preview folder `/Users/ab/code/harness-app-v2` is retained as a backup and contains the already-built app. Its `origin` now also points at the monorepo; the old personal fork remains under remote name `fork`. The old GitHub fork has not been deleted and is no longer the working destination. The existing `/Users/ab/code/autonomous-harness` checkout was clean before switching from `main` to `app-v2`.

## Product contract and design reference

Harness is one place to work with all your agents. Swarms are named, chosen collections of agent terminal views across machines and projects, shown as real native window tabs on macOS.

- No Models, Grid, permanent workspace sidebar, persistent workspace toolbar, or pane footer.
- Keep native traffic lights. Tabs sit beside them in the title bar, not in a Flutter row below a simulated title bar.
- Empty swarm: wallpaper, search, New agent, machine starters, project starters, Link machine, Add project.
- A machine/project starter seeds membership once. Discovery must not silently alter membership afterward.
- The same agent may belong to multiple swarms. Reuse one session/controller and buffer for it.
- Closing a pane or swarm removes views and must never stop/delete the agent.
- Per-swarm layout, focus, zoom, and wallpaper. Canceling Add agent preserves the view and zoom.
- Rounded dark panes with padding/gaps over plum. Compact header: original colored engine mark, agent, available project/branch, machine, close.
- Small Add agent `+` overlays a pane corner and opens a stable dialog.
- Preserve terminal input, clipboard, resize, remote transports, spoken tasks, and dial routing. Cmd+Enter zoom and Cmd+HJKL directional focus remain.
- Notifications reflect actual pending questions, never fabricated sample statuses.
- New agent uses real engine discovery, working folders, Codex profiles, and permissions. An agent name is not a submitted task prompt.

Approved reference: `/Users/ab/code/harness-new-ui`, React prototype commit `f83b32338f44dd675e2ad668519e6d429342d9ff` on `ui-prototype`, pushed to `autonomous-ai/harness-app-landing-page`. Its `HARNESS.md` and `research/conversation-history.md` record product decisions. Six wallpapers were copied from `public/`. This reference informs the existing native Flutter app implementation.

## Implementation map

### Swarm and terminal state

- New `desktop/lib/state/swarm.dart`: tab ID/name/wallpaper, memberships, focus/zoom, presets, measured grid columns, pins.
- `AppNotifier`: swarm list/active swarm; `panes` is active membership, `allPanes` is the deduplicated session pool. Transport event fan-out uses all unique sessions.
- New/select/rename/reorder/close tabs, wallpaper cycling, add-to-swarm, and machine/project seeding.
- Replacing membership creates/reuses a different pane identity instead of mutating a pane shared with another swarm.
- Session detachment waits until the final membership closes. Sends terminal-close, never agent-delete.
- Seeding records membership synchronously before awaiting attachments. Agent creation captures its destination before the RPC completes, so tab switching cannot redirect results.
- Limits: 24 swarms, 64 panes per swarm. Normal add/seed paths report capacity explicitly; legacy migration retains the nine-pane storage limit. A dial capacity exception remains below.
- `PaneLayoutStore` writes `swarm_layout_v1`: tab order/selection/names, wallpaper, pane intent, focus/zoom, presets, per-swarm pins, composer visibility.
- Restore pools shared pane identity, keeps disconnected memberships, and defers initial attachment of inactive panes until shown. Previous focus and measured grid columns currently live in memory; audit whether they need persistence.
- Focus follows zoom and wraps without an invisible sidebar. Legacy `HomeScreen`/rail code remains but is no longer the authenticated V2 shell.
- Agent comparison considers project and launch-state metadata so polling can refresh those details.

### Retained terminal views

- `PaneGrid` swarm mode parks previously displayed inactive terminal widgets under Offstage with ticking/focus disabled and their last visible dimensions preserved.
- `TerminalPane.lastViewSize` retains geometry. Hidden `TerminalPanel` views stop auto-resizing/reporting viewport and release input focus.
- Compact headers remove routine transport/status/pin clutter, retaining exceptional states and offline/unavailable placeholders.
- Existing terminal sessions/transports/renderer and patched `third_party/xterm` are retained. One regression verifies renderer identity, hidden geometry during window resize, and input going only to the active view.
- The old composer grip is hidden in compact mode; add a discoverable replacement entry point.

### Shell and dialogs

- `desktop/lib/screens/swarm_screen.dart` is wired into the authenticated case in `main.dart`.
- `widgets/swarm_welcome.dart`: wallpapers, live search, real machines/projects, New agent. Wallpaper rotates for a new swarm, stays stable, and supports manual next.
- `widgets/swarm_dialogs.dart`: fixed-size Add agent picker, rename, Add project, Link machine entry points.
- Add project saves an **existing folder**, via native local picker or existing remote folder browser. It does not clone a GitHub URL.
- `NewAgentDialog`: machine chooser, initial folder, captured destination swarm; local default when available. Reuses engine probes, Codex profiles, advanced permission behavior, and remote browsing.
- `state/swarm_catalog.dart`: search, project grouping, saved folders (`swarm_projects_v1`). Group by canonical remote if supplied, otherwise owning machine and full folder path; matching basenames never establish identity.
- Notifications come from real blocked agents; selecting an existing membership navigates back to its swarm.
- Spoken-task subscription/reporting/window reveal and existing linking dialogs are retained. Settings is in the title bar.
- Non-macOS/tests use a Flutter reorderable tab-strip fallback. Linux/Windows have not been built or visually reviewed.

### Native macOS tabs

- `desktop/macos/Runner/SwarmTitlebar.swift`, registered in Xcode and owned by `MainFlutterWindow`.
- `NSTitlebarAccessoryViewController` with native scrollable tabs, new button, notification bell, settings. Automatic native window tabbing disabled; Flutter content begins below title bar.
- Method channel `harness/swarm_tabs`: Dart sends tab ID/name/selection/attention; Swift sends new/select/close/rename/reorder/navigation/settings/notifications.
- Native tab click, double-click rename, context menu, close, drag/drop reorder. Tab button instances are retained across refreshes.
- Native Swarm menu includes new/close/rename, previous/next, Add agent, close agent view, Settings.
- Real tabs alongside traffic lights were visually verified. Full native keyboard/drag/accessibility testing remains.

### CLI project metadata

- New `cli/src/lib/agentProject.ts`; `agentFrame.ts` includes its result in the common list/push agent payload.
- Reads cwd, Git root/origin/symbolic branch using bounded `execFile`, no shell/network/repository mutation. Detached HEAD returns no branch.
- Four concurrent folder inspections, 256-entry cache, 15-second TTL, subprocess timeout/output limit.
- Remote normalization strips credentials/transport syntax. Missing/non-Git metadata degrades gracefully; optional Dart `AgentProject` accepts older daemon payloads.
- Production CLI was **not** installed/restarted to expose these fields. Project/branch detail appears only when a daemon running this code reports it. Older daemons still work.

### V2 identity and isolation

- macOS name `Harness V2`, bundle ID `ai.autonomous.harness.v2`.
- Desktop state/log namespace `~/.harness/desktop-app-v2`, including setup logs. CLI transport/login identity remains shared.
- `core/build_identity.dart` marks V2. Default updater checks disabled in `AppNotifier`/`DesktopUpdater`; injected updater tests retain their test path. Native Check for Updates removed.
- Analytics category `harness-desktop-v2`; existing opt-out behavior retained.
- `debugShowCheckedModeBanner` is false in source; first built preview predates this small change.
- Cross-platform product names, About messaging, and manual updater entry points still need follow-up.

## Current shortcuts

| Action | Binding |
| --- | --- |
| New / close swarm | Cmd+T / Cmd+W |
| Rename swarm | Cmd+Shift+R |
| Previous / next swarm | Cmd+Shift+[ / ], Ctrl+Shift+Tab / Ctrl+Tab |
| Add agent picker / New agent | Cmd+Shift+F or Cmd+P / Cmd+N |
| Focus neighboring pane | Cmd+H/J/K/L or Cmd+arrow |
| Move pane | Cmd+Shift+H/J/K/L or Cmd+Shift+arrow |
| Previous / next agent view | Cmd+[ / ] |
| Zoom / previous focus | Cmd+Enter / Cmd+; |
| Focus index | Cmd+1 through Cmd+9 |
| Layout / pin | Cmd+S / Cmd+Shift+P |
| Task palette / reload machines | Cmd+B / Cmd+R |
| Settings / shortcut sheet | Cmd+, / Cmd+/ |
| Close agent view | Cmd+Shift+W in native macOS menu; Flutter binding still needed |

Swarm shortcuts are partly hardcoded in `SwarmScreen`; the old table in `shortcuts/app_shortcuts.dart` still powers help. Consolidate them: help is stale about sidebar, Cmd+W, and Ctrl+Tab. Preserve terminal clipboard/select-all and shell/TUI keys. Do not reintroduce AppKit menu key equivalents that intercept clipboard or Cmd+H/J before Flutter.

## Verification and limits

| Check | Result |
| --- | --- |
| macOS debug build | Passed; `Harness V2.app` launched and visually reviewed. Predates the final small source/test fixes; rebuild next session. |
| Swarm state tests | 8 passed: shared sessions, replacement/pins, async seeding, capacity, restore, tab IDs/close, focus/zoom, grouping. |
| Swarm widget tests | 3 passed: welcome/search/cancel, retained renderer and input isolation, real notification navigation. |
| Crash-log isolation tests | 2 passed. Rechecked with Swarms at migration: **13 passed total**. Widget tap hit-test warning still needs cleanup. |
| CLI typecheck | `npm run typecheck` passed for metadata changes. |
| CLI targeted tests | `agentFrame.spec.ts` + `agentProject.spec.ts`: 9 passed in 2 files. |
| Latest Flutter analyzer | **0 errors, 1 warning, 36 infos**, exits 1. Unused `harness_file_store.dart` import in `app_state.dart`; own brace/import/deprecation cleanup and existing vendored xterm infos. Not a clean pass. |
| Last full Flutter suite | **919 passed, 1 skipped, 21 failed** before subsequent expectation/isolation fixes. Not rerun in full afterward; do not call it green. |
| Production E2E / release | Not run. No release, installer, or production CLI update/restart for this preview. |

Full-suite failures: old replacement/nine-pane/persistence expectations; five boot-flow tests expecting removed sidebar; four dial expectations; old store/analytics namespace assertions; crash log; two Usage copy assertions; two shortcut-deck assertions. Some updates are in `terminal_pane_test.dart`, `pane_lattice_test.dart`, `dial_desk_test.dart`, and `harness_file_store_test.dart`; review and rerun. Do not call Usage/shortcut failures baseline without checking. The first updated dial test may still have an inconsistent pane-count assertion.

**Test isolation incident:** the original upstream crash-log test deleted real default `~/.harness/desktop-app/errors.log` if it existed. The suite ran before discovery, so the previous error log may have been removed; the user was informed. The test now uses a disposable temporary directory, and `CrashLog.record` skips test file I/O unless `CrashLog.testFile` is supplied. Do not rerun the original unisolated test or claim no production file could have been affected. No terminal data, agent processes, or user project files were intentionally modified by tests.

Evidence on this Mac under `/private/tmp`:

- `harness-v2-build.log`: first successful build.
- `harness-v2-cli-check.log`, `harness-v2-cli-tests.log`: CLI checks.
- `harness-v2-all-tests.log`: full-suite result above.
- `harness-v2-migration-analyze.log`: latest analyzer, 37 diagnostics.
- `harness-v2-migration-tests.log`: latest focused 13-test pass.
- `harness-v2-branch-migration.json`: SHA-256 inventory of all 45 changed/new files before migration; this handoff is intentionally rewritten afterward.

Older `harness-v2-analyze.log` and `harness-v2-swarm-tests.log` contain failures since fixed. Use migration logs for latest focused results. Temporary logs/toolchain are local conveniences, not committed artifacts.

## Remaining work, in recommended order

1. Review/incorporate current main, especially terminal sequence recovery; preserve Swarm fan-out in `app_state.dart`.
2. Remove unused import; format/lint changed Dart files; change fallback `onReorder` to `onReorderItem` with its already-adjusted index. Leave vendored xterm style alone.
3. Finish full-suite transition and rerun. Boot-flow tests must exercise Swarm welcome/settings/linking. Fix behavior, not just assertions. Investigate Usage/shortcut failures and widget tap warning.
4. Known bug: `openAgentFromDial` still replaces the last membership at capacity. Use explicit capacity handling or a deliberate new swarm, no silent eviction.
5. Centralize Swarm shortcuts/help; add Flutter Cmd+Shift+W; audit native menu conflicts and shortcuts while dialogs/settings are open.
6. Restore discoverable composer access in compact mode and account/sign-out access in Settings after removal of old sidebar footer.
7. About must say Harness V2 and accurately describe disabled updates. Audit manual/apply updater paths; finish Linux/Windows identity before testing those builds.
8. Add meaningful async launch tests for tab switch/close/disposal during RPC and machine change during folder/profile probes. Audit restore revision guard after legacy asynchronous loads, not just initial load.
9. Handle project-store write errors visibly; audit load/add races. Consider normalizing explicit default Git ports (SSH 22) across transports.
10. Native QA: drag/reorder, close-last-tab, rename, overflow, shortcuts, accessibility of tab close subbuttons. CUA exposed parent buttons; independently accessible close controls still need checking.
11. Rebuild/review final source; run justified local-only terminal integration checks with disposable fixtures and separate test identity. Never automatically take over a user's terminal or replace the review app with an integration runner.

Items 4–7 are known gaps; async/persistence/accessibility/cross-platform items include pending audits, not claims each path already failed.

## Toolchain and workflow

Read `desktop/CLAUDE.md`. No AGENTS.md was found in this checkout/ancestors during implementation. Some architecture/integration-test comments there are stale; prefer current source and analyzer evidence. This is a native app, not Sites. No subagents were requested.

Flutter **3.47.2 / Dart 3.13.2** lives at `/private/tmp/harness-v2-flutter`, matching release pin. Swift Package Manager is required. Tool settings are isolated under `/private/tmp/harness-v2-tool-config`; npm cache under `/private/tmp/harness-v2-npm-cache`.

```bash
cd /Users/ab/code/autonomous-harness/desktop
export XDG_CONFIG_HOME=/private/tmp/harness-v2-tool-config
/private/tmp/harness-v2-flutter/bin/flutter --suppress-analytics config --enable-swift-package-manager
/private/tmp/harness-v2-flutter/bin/flutter --suppress-analytics pub get --offline
/private/tmp/harness-v2-flutter/bin/flutter --suppress-analytics analyze --no-pub
/private/tmp/harness-v2-flutter/bin/flutter --suppress-analytics test --no-pub test/swarm_state_test.dart test/swarm_screen_test.dart test/crash_log_test.dart
/private/tmp/harness-v2-flutter/bin/flutter --suppress-analytics test --no-pub
/private/tmp/harness-v2-flutter/bin/flutter --suppress-analytics build macos --debug --no-pub
open -n 'build/macos/Build/Products/Debug/Harness V2.app'
```

Use online `pub get` if packages are not cached. Enable SPM before pub get; do not accept CocoaPods fallback rewriting the project. Do not commit generated build/ephemeral files or caches. Analyzer currently needs cleanup; `--no-fatal-infos` is useful once warnings are resolved and does not erase remaining infos.

```bash
cd /Users/ab/code/autonomous-harness/cli
npm ci --ignore-scripts --cache /private/tmp/harness-v2-npm-cache --no-audit --no-fund
npm run typecheck
npx vitest run src/lib/agentFrame.spec.ts src/lib/agentProject.spec.ts
```

Some tests require permission to bind disposable loopback sockets. Inject memory/temp stores, skip real credential/usage pollers using `kUnderTest`, and never treat a real Harness home as a fixture. Keep patched `desktop/third_party/xterm`, not pub.dev xterm.

The app open for review was launched from `/Users/ab/code/harness-app-v2/desktop/build/macos/Build/Products/Debug/Harness V2.app`. It has the separate V2 bundle identity. The user has been interacting with it, opening swarms and saving a project; leave those views alone during migration. Another-app-controls-terminal is a real ownership state, not permission to take over. Building in the new folder does not move the running process; coordinate the next V2 relaunch and preserve saved state.

## Publishing boundaries

The user authorized publishing branch `app-v2` in `autonomous-ai/autonomous-harness` for later merging. This is not authorization to merge, release/tag, publish binaries, run production E2E, update/restart the production CLI, or delete the old fork. No PR is needed yet.

Workflow triggers were checked: CI runs for PRs/manual calls; internal desktop builds for `internal/**`; release/deployment for suffixed tags. A plain `app-v2` push does not trigger those release workflows. Keep future work/pushes on `app-v2` unless the user changes that instruction.
