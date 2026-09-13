# Harness App V2 — development handoff

Updated 2026-09-12 after the implementation continuation and live-data review. This is a working preview, not a release.

## Resume here

- Repository: https://github.com/autonomous-ai/autonomous-harness
- Branch: `app-v2`, tracking `origin/app-v2` in that repository.
- Resume folder: `/Users/ab/code/autonomous-harness`.
- Desktop: `desktop/`. CLI: `cli/`. Backend: `backend/`.
- The user resumed implementation here, requested real machines/projects after seeing the temporary QA app, and then asked Codex to keep working while away for a couple of hours. The original active goal is a polished, very fast, keyboard-first native app with each tab representing a Swarm.
- The QA app was closed. Review uses the normal `lib/main.dart` entry point, the existing Harness account, and saved V2 Swarms. Keep sample fixtures out of the foreground review app.
- Continue implementation here. Do not create another repository or fork for V2.

```bash
cd /Users/ab/code/autonomous-harness
git status --short -b
git remote -v
git log -1 --oneline
```

The preview was developed from monorepo commit `9bd8cf1667310def711e8c491c9e6b317cdece78`. Current main through `84a23e5f8d358b78d24ba92ce185b482b5f97ebc` is now incorporated into `app-v2`: reboot restoration, release CI changes, and terminal input sequence recovery. Swarm transport fan-out still uses all deduplicated sessions. This does not merge V2 into main or publish a release.

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
- Limits: 24 swarms, 64 panes per swarm. Add, seed, and dial paths report capacity explicitly without silently evicting a view; legacy migration retains the nine-pane storage limit.
- `PaneLayoutStore` writes `swarm_layout_v1`: tab order/selection/names, wallpaper, pane intent, focus/zoom, presets, per-swarm pins, composer visibility.
- Restore pools shared pane identity, keeps disconnected memberships, and defers initial attachment of inactive panes until shown. Previous focus is persisted; grid columns remain measured runtime geometry. Revision guards cover every asynchronous legacy restore read.
- Focus follows zoom and wraps without an invisible sidebar. Legacy `HomeScreen`/rail code remains but is no longer the authenticated V2 shell.
- Agent comparison considers project and launch-state metadata so polling can refresh those details.

### Retained terminal views

- `PaneGrid` swarm mode parks previously displayed inactive terminal widgets under Offstage with ticking/focus disabled and their last visible dimensions preserved.
- `TerminalPane.lastViewSize` retains geometry. Hidden `TerminalPanel` views stop auto-resizing/reporting viewport and release input focus.
- Compact headers remove routine transport/status/pin clutter, retaining exceptional states and offline/unavailable placeholders.
- Existing terminal sessions/transports/renderer and patched `third_party/xterm` are retained. One regression verifies renderer identity, hidden geometry during window resize, and input going only to the active view.
- Compact remote panes expose a Show/Hide message composer button in their header. Closing the final visible pane restores keyboard focus even when its shared terminal remains parked in another Swarm.

### Shell and dialogs

- `desktop/lib/screens/swarm_screen.dart` is wired into the authenticated case in `main.dart`.
- `widgets/swarm_welcome.dart`: wallpapers, live search, real machines/projects, New agent. Wallpaper rotates for a new swarm, stays stable, and supports manual next.
- `widgets/swarm_dialogs.dart`: fixed-size Add agent picker, rename, Add project, Link machine entry points.
- Add project saves an **existing folder**, via native local picker or existing remote folder browser. It does not clone a GitHub URL.
- `NewAgentDialog`: machine chooser, initial folder, captured destination swarm; local default when available. Reuses engine probes, Codex profiles, advanced permission behavior, and remote browsing. Profile/folder responses are rejected after a machine switch, including switching away and back. Launch replies are ignored after notifier disposal or machine replacement.
- `state/swarm_catalog.dart`: search, project grouping, saved folders (`swarm_projects_v1`). Group by canonical remote if supplied, otherwise owning machine and full folder path; matching basenames never establish identity.
- Project-store load/add operations are serialized, and failures are visible without claiming a project was saved.
- Search supports arrows, Ctrl-N/P, and Return, reveals the selected row, and retains the highlighted agent across live list changes. Both the welcome and picker immediately focus search; blank Return on welcome does not open an invisible first result.
- Notifications come from real blocked agents; selecting an existing membership navigates back to its swarm.
- Spoken-task subscription/reporting/window reveal and existing linking dialogs are retained. Settings is in the title bar, with Account/sign-out restored inside Settings.
- Non-macOS/tests use a Flutter reorderable tab-strip fallback. Linux/Windows have not been built or visually reviewed.

### Native macOS tabs

- `desktop/macos/Runner/SwarmTitlebar.swift`, registered in Xcode and owned by `MainFlutterWindow`.
- `NSTitlebarAccessoryViewController` with native scrollable tabs, new button, notification bell, settings. Automatic native window tabbing disabled; Flutter content begins below title bar.
- Method channel `harness/swarm_tabs`: Dart sends tab ID/name/selection/attention; Swift sends new/select/close/rename/reorder/navigation/settings/notifications.
- Native tab click, double-click rename, context menu, close, drag/drop reorder. Tab button instances are retained across refreshes.
- Native Swarm menu includes new/close/rename, previous/next, Add agent, close agent view, Settings.
- Real tabs alongside traffic lights were visually verified. Native selection, new tabs, modal-disabled controls, and independently accessible select/close buttons were checked. Drag/reorder, overflow, and a wider keyboard/accessibility audit remain.

### CLI project metadata

- New `cli/src/lib/agentProject.ts`; `agentFrame.ts` includes its result in the common list/push agent payload.
- Reads cwd, Git root/origin/symbolic branch using bounded `execFile`, no shell/network/repository mutation. Detached HEAD returns no branch.
- Four concurrent folder inspections, 256-entry cache, 15-second TTL, subprocess timeout/output limit.
- Remote normalization strips credentials/transport syntax and normalizes explicit default SSH/git ports. Missing/non-Git metadata degrades gracefully; optional Dart `AgentProject` accepts older daemon payloads.
- Production CLI was **not** installed/restarted. Newer daemons report full project/branch metadata across machines.
- Older local daemons already report real session working folders in `/api/status`. The existing validated loopback discovery probe now carries that snapshot into project grouping, search, and headers, refreshing every ready supervision probe without extra HTTP calls. Home-relative folders are expanded for this computer only. Rich agent metadata takes precedence; local folders cannot be applied to peers or establish cross-machine repository identity.
- The compatibility path was tested against a running CLI 0.2.17. Remote machines still require their actual existing links and connectivity; no link credentials were fabricated or daemons upgraded.

### V2 identity and isolation

- macOS name `Harness V2`, bundle ID `ai.autonomous.harness.v2`.
- Desktop state/log namespace `~/.harness/desktop-app-v2`, including setup logs. CLI transport/login identity remains shared.
- `core/build_identity.dart` marks V2. Default updater checks disabled in `AppNotifier`/`DesktopUpdater`; injected updater tests retain their test path. Native Check for Updates removed.
- Analytics category `harness-desktop-v2`; existing opt-out behavior retained.
- `debugShowCheckedModeBanner` is false. About identifies Harness V2 and explicitly describes disabled updates. Check, download/stage, and apply are all blocked by default for V2.
- Linux/Windows names and binary identity now also use Harness V2 / `harness-v2`; those platforms have not been built on this Mac.

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
| Close agent view | Cmd+Shift+W |

Swarm shortcuts, help, and tooltips now read the same catalog in `shortcuts/app_shortcuts.dart`. The retained legacy HomeScreen explicitly opts into its old bindings. Native Swarm actions and controls are blocked while Swarm dialogs or Settings are open. Clipboard/select-all and shell/TUI keys remain owned by the terminal. Do not add AppKit menu equivalents that intercept Cmd+H/J before Flutter.

## Verification and limits

| Check | Result |
| --- | --- |
| macOS debug build | Passed and launched from the monorepo with real saved Swarms and terminals. |
| macOS optimized local build | Passed with ad hoc signing and the real entry point. The distribution Developer ID certificate is unavailable; nothing was uploaded. The Mac locked before visual review, and the running debug app declined a normal quit request, so it was left running. |
| Full Flutter suite | **968 passed, 1 skipped** after live-project discovery, keyboard navigation, and multi-machine folder-race fixes. |
| Focused interaction checks | 8 passed: picker navigation/scroll/refresh, welcome keys, shared-view close, composer, native modal guard, profile and folder races. |
| Local CLI discovery | 25 passed, including older-daemon folder parsing and continuous snapshots without spawning/reconnecting. |
| CLI typecheck | `npm run typecheck` passed. |
| CLI targeted tests | 135 passed across project/frame, registry/restore, and terminal recovery files. Project/frame tests rerun after port normalization: 9 passed. |
| Flutter analyzer | **0 errors, 0 warnings, 12 existing vendored xterm infos**; passes with `--no-fatal-infos`. |
| Remote terminals / production release | No remote takeover, release, installer, or production CLI update/restart. Cross-platform and latency measurements remain. |

Tests now exercise the actual V2 welcome/settings/linking flow. Usage pricing again explains a partial estimate as a lower bound. Small offline panes avoid overflowing the full connection guide. No remaining full-suite failures are being dismissed as baseline.

**Test isolation incident:** the original upstream crash-log test deleted real default `~/.harness/desktop-app/errors.log` if it existed. The suite ran before discovery, so the previous error log may have been removed; the user was informed. The test now uses a disposable temporary directory, and `CrashLog.record` skips test file I/O unless `CrashLog.testFile` is supplied. Do not rerun the original unisolated test or claim no production file could have been affected. No terminal data, agent processes, or user project files were intentionally modified by tests.

Evidence on this Mac under `/private/tmp`:

- `harness-v2-final-tests.log`: full 968-test pass.
- `harness-v2-final-analyze.log`: latest diagnostics.
- `harness-v2-final-build.log`: real-entry debug build.
- `harness-v2-release-build.log`: optimized local build.
- `harness-v2-final-cli-check.log`, `harness-v2-final-cli-tests.log`: final metadata checks.
- `harness-v2-resume-cli-tests.log`: 135-test CLI pass.
- `harness-v2-keyboard-tests.log`, `harness-v2-local-project-tests.log`: focused interaction/discovery checks.

Earlier logs contain superseded failures. Temporary logs and toolchains are local conveniences, not committed artifacts.

## Remaining work

1. Launch the completed optimized real-data build after the Mac is unlocked; verify actual local project starters and keyboard navigation in the native shell.
2. Audit native drag/reorder, overflow, close-last-tab, renaming and accessibility without changing the user's saved agent memberships. Keep any integration runner separate and out of the foreground review app.
3. Measure terminal input and tab-switch responsiveness before making latency claims. Preserve the existing immediate first-input flush and shared retained renderers.
4. Audit app-menu modal interactions (the older `harness/app_menu` path also opens Layout/Shortcuts/Firmware dialogs).
5. Build/review Linux and Windows when their toolchains are available. Remote full project/branch metadata requires daemons running the new wire format; do not upgrade them automatically.
6. Continue the agreed goal autonomously. The user has stepped away; lack of immediate replies is not a reason to stop independent implementation, checks, or app-v2 publishing.

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

Use online `pub get` if packages are not cached. Enable SPM before pub get; do not accept CocoaPods fallback rewriting the project. Do not commit generated build/ephemeral files or caches. Use `--no-fatal-infos` for the existing vendored xterm infos; do not modify vendored style merely to erase them.

```bash
cd /Users/ab/code/autonomous-harness/cli
npm ci --ignore-scripts --cache /private/tmp/harness-v2-npm-cache --no-audit --no-fund
npm run typecheck
npx vitest run src/lib/agentFrame.spec.ts src/lib/agentProject.spec.ts
```

Some tests require permission to bind disposable loopback sockets. Inject memory/temp stores, skip real credential/usage pollers using `kUnderTest`, and never treat a real Harness home as a fixture. Keep patched `desktop/third_party/xterm`, not pub.dev xterm.

The real review app is now built in `/Users/ab/code/autonomous-harness/desktop/build/macos/Build/Products/Debug/Harness V2.app`, with the separate V2 bundle identity and saved V2 state. An optimized ad hoc signed local build is ready in the sibling `Release/` directory. It has not been launched yet: the Mac is locked and the running debug app declined a normal quit request. No process was force-terminated. Production Harness remains a separate running app. Never automatically take over its terminals or use a real Harness home as a test fixture.

## Publishing boundaries

The user authorized publishing branch `app-v2` in `autonomous-ai/autonomous-harness` for later merging. This is not authorization to merge, release/tag, publish binaries, run production E2E, update/restart the production CLI, or delete the old fork. No PR is needed yet.

Workflow triggers were checked: CI runs for PRs/manual calls; internal desktop builds for `internal/**`; release/deployment for suffixed tags. A plain `app-v2` push does not trigger those release workflows. Keep future work/pushes on `app-v2` unless the user changes that instruction.
