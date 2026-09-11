# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Harness Desktop — a Flutter app that lists Harness machines and attaches xterm terminals to the
agents running on them. **macOS and Linux (Ubuntu) are both real, released targets** — first-run
provisioning (`lib/bootstrap/environment_provisioner.dart`), self-update
(`lib/update/desktop_updater.dart`), and packaging (`scripts/upload-desktop.sh` /
`scripts/upload-desktop-linux.sh`, see RELEASE.md) all branch per-OS internally rather than being
separate code paths. The Windows runner exists but is unexercised. Package name is `harness`
(`import 'package:harness/...'`). It lives under `desktop/` in the `autonomous-harness` repo, beside
the CLI (`../cli`) and the backend (`../backend`); a few comments still point at `autonomous-code`,
the older backend checkout, which is a sibling of this repo rather than part of it.

**Grid was removed on 2026-09-11, when the project was killed**: no `lib/grid/`, no `lib/share/`, no
Settings ▸ Providers or Share Intelligence, no provider pill, model picker, node dashboard or
usage-limit card, and first-run setup no longer installs the Grid CLI. The last commit that still
has all of it is the `archive/grid` branch — bring anything back from there rather than rewriting
it from memory. The harness CLI (`autonomous-harness`) still carries its own grid code
(`gridLaunch.ts`, `gridWebMcp.ts`, `agent_retarget`, `harness grid login`); nothing here calls it.

## Toolchain and commands

`pubspec.yaml` pins `sdk: ^3.13.0`, i.e. **Flutter ≥ 3.47 / Dart ≥ 3.13**. An older Flutter fails at
`flutter pub get` ("version solving failed") and every command below fails with it — check
`flutter --version` first.

The macOS project is migrated to **Swift Package Manager** (`macos/Runner.xcodeproj` references
`FlutterGeneratedPluginSwiftPackage`). Run `flutter config --enable-swift-package-manager` once, then
`flutter pub get` — the generated `macos/Flutter/ephemeral/Packages/FlutterGeneratedPluginSwiftPackage/Package.swift`
only lists the plugin dependencies when SPM is on at `pub get` time. With SPM off, `flutter run` falls
back to CocoaPods and rewrites tracked files (`project.pbxproj`, `contents.xcworkspacedata`, the
`Flutter-*.xcconfig`s) and adds `macos/Podfile`; revert those rather than committing them.

```bash
flutter pub get
flutter analyze                                   # lints: package:flutter_lints, no custom rules
flutter test                                      # whole unit/widget suite (test/)
flutter test test/terminal_session_test.dart      # one file
flutter test test/ws_conn_test.dart --plain-name "reconnects"   # one test by name substring
flutter run -d macos                              # or: flutter run -d linux
flutter build macos --debug
flutter build macos --release
flutter build linux --release                     # Ubuntu build host only — no cross-compiling
```

Integration tests (`integration_test/`) need a device: `flutter test integration_test/native_terminal_e2e_test.dart -d macos`
(swap `-d linux` on an Ubuntu host).
`local_terminal_e2e_test.dart` and `prod_terminal_e2e_test.dart` still import `package:harness/e2ee/*`
and `widgets/remote_setup_screen.dart`, which no longer exist, and `native_terminal_e2e_test.dart`
builds `TerminalPanel` without its required `focused` argument — all three fail `flutter analyze` and
are the only analyzer errors in the repo (everything else is `info` inside `third_party/xterm`). Fix or
delete them before relying on them.

Local stack / E2E scripts (the CLI comes from this repo's `../cli`; the backend from a sibling
`autonomous-code` checkout next to `autonomous-harness` — override with `AUTONOMOUS_CODE_ROOT` /
`HARNESS_REPO_ROOT`; see README):

```bash
make terminal-local-manual   # boots backend+CLI locally and runs lib/main_local_manual.dart
make terminal-local-e2e
make terminal-prod-e2e       # opt-in, refuses without PROD_TERMINAL_E2E=1 + release evidence vars
```

Release (`make release-desktop` from the repo root, which tags `vX.Y.Z_desktop` and lets CI build; `make upload-desktop VERSION=…` and
`make upload-desktop-linux` are the by-hand escape hatches, the latter on an Ubuntu host only) is
documented in RELEASE.md. **macOS ships TWO builds of one universal app**, differing only in
`FLTEnableImpeller`: Intel on Skia under the old `desktop-macos` key (which every older install and the
website download also read), Apple Silicon on Impeller under `desktop-macos-arm64`, both built by
`scripts/publish-macos-variant.sh` — RELEASE.md, "Two macOS builds", has the why. An **internal**
build for testers — both macOS builds, signed and notarized by CI, behind an unlisted link, with
self-update off — is `git push origin HEAD:internal/<name>` (`../.github/workflows/desktop-internal-build.yml`,
RELEASE.md "Internal builds"); never cut one by hand. The run prints the links, and **this repository
is public**, run pages included — so they are unlisted, not private. All platforms
publish to the same GCS `metadata.json` under different keys and share one version
number by default; `pubspec.yaml`'s `version:` is a placeholder and is never bumped — Linux instead
gets a `version.txt` written into the built bundle at package time (see `lib/core/app_version.dart`,
since `flutter build linux` has no Info.plist-style stamping). Test the updater against a scratch
manifest with `--dart-define=DESKTOP_UPDATE_METADATA_URL=...`; `HARNESS_RUNTIME_METADATA_URL` does
the same for the desktop updater only. The managed Node runtime is still published from this repo with
`make upload-node-runtime ARGS=22.23.2` (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`), but
its consumer is now the `harness` installer rather than this app.

## Architecture

### The app talks only to the local `harness` CLI

This is the single most important thing to know. The desktop app **never** dials the cloud backend or
holds an SSO token:

- **Auth** lives in the CLI. `lib/auth/cli_login.dart` shells out to `harness auth status --json` and
  drives `harness login --json` (NDJSON event stream); `cli_link.dart` wraps `harness link create/import/list`.
- **REST** (`lib/api/api_client.dart`, Dio) goes to `AppConfig.localCliBaseUrl` (`http://127.0.0.1:18473`),
  and the CLI proxies to the backend with its own session. Responses are `{success, data|error}` and
  unwrapped into `ApiException`.
- **WebSocket** (`lib/ws/`) — `WsPool` owns one `WsConn` per machine. Every real connection uses
  `WsTransportKind.localPlaintext` against the CLI daemon's loopback WS (discovered/started by
  `LocalCliDiscovery`, which runs `harness start` when needed). The CLI terminates E2EE for relayed
  machines; the app carries no crypto. Close code `4404`/`NO_PEER_LINK` means the machine needs
  `harness link import` — surfaced as `MachineState.needsLink` and polled via `_linkRetryTimers`.
- The **only** direct-to-backend path is `LocalManualFixture` (`lib/main_local_manual.dart`), a
  compile-time-gated dev entrypoint fed by `scripts/start-terminal-local-manual.sh`. It fails closed
  unless every `--dart-define` is present.

`lib/core/harness_cli_runner.dart` is how the app finds the CLI without a shell: prefer
`~/.harness/runtime/current-node` + `~/.harness/cli/cli.js`, then `~/.local/bin/harness`, then PATH.
`lib/bootstrap/environment_provisioner.dart` installs the CLI and tmux (plus, on Linux, the clipboard
helper) on first run (the `preparingEnvironment` status).

Node is deliberately not the user's: it is a private, sha256-verified runtime under
`~/.harness/runtime`, never Homebrew, nvm or PATH. **The app does not install it — `install.sh` does**,
on its own or on the app's behalf, and records it in `current-node`; the launcher it writes names that
binary absolutely, so a Finder launch (PATH is launchd's bare `/usr/bin:/bin:/usr/sbin:/sbin`) and a
Terminal launch behave identically. One implementation, shared with everyone who installs the CLI from
a terminal, instead of a second copy here that had to keep its own pinned checksums in step.
**tmux** is the one dependency still taken from the OS package manager, and the only reason the setup
screen ever opens a terminal: a fresh Homebrew or any `apt-get install` needs a password prompt on a
real tty.

### Boot and state

`lib/main.dart`: `CrashLog.install()` → `loadPersistedSettings()` (theme mode + terminal font, awaited
before the first frame to avoid flicker) → `RootShell`, which switches on `AppStatus`
(`bootstrapping → preparingEnvironment → unauthenticated → authenticated`).

`lib/state/app_state.dart` (`AppNotifier`, a `ChangeNotifier` exposed through the single Riverpod
`appStateProvider`) is the whole app model: machines, agents, connections, panes, updater, login.
Widgets receive `notifier` explicitly and rebuild via `ListenableBuilder`; Riverpod is only the
injection point (`main_local_manual.dart` overrides it). `bootstrap()` → `_prepareEnvironment()` →
`cliLogin.checkStatus()` → `_finishBootstrapSignedIn()` (restore pane layout, create `WsPool`, ensure
the daemon, `api.me()`, `refreshMachines()`).

Per-machine runtime state is `MachineState` (connection status, transport mode, agents, `nodeOnline`
from `node_status` pushes — distinct from our own socket status, pending offline agent, turn activity).

### Terminals

- `TerminalPane` (`lib/state/terminal_pane.dart`) separates **intent** (machine + agent id, stable
  `id` used as the widget key) from the live `TerminalSession`, so a tile can exist before its machine
  answers and survive the machine going offline. `PaneLayoutStore` persists intent only, max 4 panes;
  `PaneGrid` renders fixed 1–4 tile shapes (deliberately not a splittable tree).
- `TerminalSession` (`lib/terminal/terminal_session.dart`, protocol v3) owns one `xterm` `Terminal`
  for one agent: `terminal_open`/`terminal_ready` handshake matched by requestId+agentId, seq-tracked
  output with bounded resync and one auto-reopen, batched input/resize, heartbeat, and
  `onOpenStalled` to force a transport redial. `engineId == 'grok'` scrolls via tmux copy-mode instead
  of mouse reports (see `scrollViaTmuxCopyMode`).
- Bulk terminal bytes are binary WS frames framed by `lib/terminal/terminal_binary.dart`
  (`HTRL` magic, kinds input/output/keyframe/sync, zlib flag). `AppNotifier._handleTerminalBinary`
  decodes once and offers the frame to **every** session on that machine; each session drops frames
  whose `streamId` is not its own. The same fan-out applies to JSON events in `_handleEvent`: all pane
  sessions get `handleFrame` first (a session returns true for any terminal frame, even one not
  addressed to it), then the app-level switch handles `node_status`, `agent_*`, `turn_*`, and the
  hardware-dial events `dial_scroll`/`dial_focus`.
- `third_party/xterm` is a **vendored, patched** xterm 4.0.0 (atomic `replaceRange` fix for scroll
  regions — see its `README.autonomous.md`). Do not replace it with the pub package; the regression
  lives in `test/terminal_session_test.dart`.

### Theming — two files, one source of truth

- `lib/shared/theme/app_theme.dart` (imported as `grid`) is the design-system token layer:
  `AppPalette`/`AppSurface`/... members are **getters** that resolve against the global
  `grid.AppTheme.brightness`, which `_GridTokenScope` in `main.dart` sets from `Theme.of(context)`.
  Chrome widgets call `grid.AppTheme.watch(context)` at the top of `build` so `const` subtrees still
  repaint on a theme flip.
- `lib/theme/app_theme.dart` (`AppColors`, `AppTheme.terminalLight/terminalDark`) is a set of
  adapters over those tokens. Nothing here is `const` on purpose — freezing a colour is how light mode
  silently breaks. Do not add a parallel palette.
- `ThemeModeStore` and `TerminalFontStore` are `ValueNotifier` singletons (they must resolve above the
  provider scope and before sign-in).

### Persistence and native integration

- All local state is in `HarnessFileStore` (`~/.harness/desktop-app/state.json`, mode 0600, keyed
  strings behind `LocalKeyValueStore`): connection config, skipped update version, theme, font, pane
  layout. `~/.harness/computer-id` is the machine identity shared with the CLI.
- The window is frameless on macOS via `window_manager` (`lib/core/desktop_window.dart`, same size and
  `TitleBarStyle.hidden` as Grid). The traffic lights float over the rail's head, which leaves
  `railTopInset` above the wordmark and is a `DragToMoveArea`; so are the pane headers. A screen that
  fills the window goes through `FullWindowScreen` (`lib/widgets/window_chrome.dart`) for its drag
  strip, and a full-width band at the top edge pads by `trafficLightClearance`.
- `macos/Runner/MainFlutterWindow.swift` installs native menu items and calls into Dart over the
  `harness/app_menu` MethodChannel (`checkForUpdates`, `flashFirmware`, `showShortcuts`, terminal font
  size). Keep the menu in Swift; only the handler lives in `RootShell`.
- **The status rail is where the app polls** (`lib/widgets/status_rail/`): a 26px full-bleed strip
  along the window's bottom edge carrying what the agent accounts have spent, right-aligned against
  the key hints (`key_hints.dart`). The hover/pin surface is `rail_figure.dart` + `rail_panel.dart`.
  The `UsageController` behind it is owned by `_HomeScreenState`, not by the rail, because the rail
  unmounts when the sidebar folds and a poller living in it would restart on every unfold.
- **Agent-account usage is what the rail reads** (`lib/usage/`, `widgets/status_rail/usage_readout.dart`
  + `usage_panel.dart`): what the Claude and Codex accounts on this machine — and on the remote
  machines that answer `usage_read` — have spent. **The strip prints ONE figure per account — the WEEKLY
  window** (`ProviderUsage.railWindow`, deliberately not `tightest`): Claude answers with three
  windows and Codex with one, so printing them all made one account three figures wide and the
  other one — two readouts that read as different KINDS of thing rather than the same thing about
  two accounts. Weekly rather than the tightest, because the rail wants the figure worth a GLANCE
  and the five-hour window refills all day: it is back to nothing by the time anybody reads it.
  `tightest` stays for the question it actually answers, which limit stops the work first. A
  provider reporting no weekly window falls back to it — one figure is the rule, and a blank strip
  is a worse answer than the wrong window. `kWeeklyWindowLabel` is written down once because the
  rail MATCHES on it and the two sources spell it separately; the panel behind the figure still
  shows every window. The block sits at the RIGHT end of the strip, beside the key hints: furniture
  you only read belongs at the edge you are not reaching for.
  **Remote machines' accounts arrive through `usage_read`** (`AppNotifier.readRemoteUsage`,
  `usage/remote_usage.dart`, `usage/usage_accounts.dart`; CLI side `cli/src/lib/accountUsage.ts`).
  A remote machine may be signed in to a DIFFERENT subscription, and the only honest way to read
  that one is to ask the machine holding it — so its CLI calls the vendors with ITS OWN token and
  hands back their HTTP status and body untouched, and this app reads them with the SAME
  `claudeUsageFromAnswer`/`codexUsageFromAnswer` it reads its own with. The credential never
  crosses the relay, and the window-naming rules live in one language. Readings are grouped ONE
  PER ACCOUNT (`groupUsageAccounts`): an account key — the first 16 hex of
  sha256(`<provider>:<id>`), `usageAccountKey` here and `accountKey` there, both suites pinning one
  vector — decides whether a remote subscription is this one again (folded in, unlabelled) or
  another (its own figure, labelled with the machine). Hashed because RPC replies are logged.
  ⚠️ A null key never matches, itself included, and a remote reading folds into this computer's
  only when this computer HAS figures — otherwise a token that expired here would swallow a live
  reading of the same account taken there. `readings` stays this computer's alone and `accounts`
  is the grouped view. ⚠️ **`usage_read` is in the E2EE type sets** (`core.ts`),
  which re-pinned the interop keystone the browser client and the paired device share. And a
  remote CLI that predates it does not refuse the frame — it cannot open the envelope, loses the
  requestId and goes silent — so this asks with a 10s timeout and treats every failure as nothing
  to add, never holding up this computer's own figures.
  **This is the one exception to "the app talks only to the local CLI"**, and a narrow one: nothing
  here is dialled on the app's own behalf. `UsageCredentials` reads the tokens
  the agent CLIs already wrote — the macOS Keychain item `Claude Code-credentials` (falling back to
  `~/.claude/.credentials.json`, which is all Linux has) and `~/.codex/auth.json` — and spends them
  against the vendors' own usage endpoints. It never writes or refreshes them: one sign-in per
  machine, owned by the CLI that made it.
  A rate limit is scoped to an **account**, not a machine, so reading it here is right even though
  the agents run elsewhere — provided the remote machines sign in as the same account.
  ⚠️ **Both endpoints are undocumented** — `api.anthropic.com/api/oauth/usage` (needs
  `anthropic-beta: oauth-2025-04-20` and the CLI's own user agent, because the OAuth token was minted
  for the CLI) and `chatgpt.com/backend-api/wham/usage`. Either can change without notice; both
  failures land as a `ProviderUsage` state rather than an exception. **`signedOut` is kept apart from
  `failed`**: retrying a sign-out fails identically forever. Claude's Fable window has been spelled three ways
  across releases and all three are tried; Codex names its windows from `limit_window_seconds` rather
  than assuming, because a confident "5h" beside a real percentage reads as measured.
  `loading` is false **before** `start()` as well as after the first answer — a controller nobody
  started is not waiting for anything, and a skeleton for it would promise an answer never coming.
  That is also what keeps `flutter test` honest: `kUnderTest` (`core/test_run.dart`, shared with
  `AnalyticsConfig`) stops the poll auto-starting, since a `Timer.periodic` is a `pumpAndSettle` that
  never settles and these sources would otherwise shell out to `security` and open real sockets.
  The rail figure and `UsageBar` share one pair of thresholds through `usagePressureOf`
  (`usage/usage_pressure.dart`) — amber from 80%, red from 90% — so a window cannot be amber in the
  strip and plain in the panel that expands it.
- **The token ledger is the OTHER usage feature, and the two must not be merged** (`lib/usage/ledger/`,
  Settings ▸ Usage in `settings/sections/usage_section.dart` + `usage_panels.dart`). The rail's readout
  above asks the vendors *how much of your rate limit is left* — a percentage, scoped to an **account**,
  true whichever machine burned it. This counts **tokens**, scoped to **this machine**, with a history:
  it reads the logs the agent CLIs already wrote to this disk and calls nobody. Ported from Orca
  (`src/main/{claude,codex,opencode}-usage/`); keep the pricing tables in step with its
  `claude-model-pricing.ts` / `codex-model-pricing.ts`.
  **Three providers, three unrelated formats.** Claude: JSONL under `~/.claude/projects` *and*
  `~/.claude/transcripts` (the older layout — reading only the first drops every pre-move session),
  usage off `message.usage` on `type == "assistant"` rows. Codex: JSONL under
  `$CODEX_HOME`/`~/.codex/{sessions,archived_sessions}`, usage off `event_msg`/`token_count`. OpenCode:
  a **SQLite** database at `$XDG_DATA_HOME/opencode/opencode*.db`, one aggregate row per session.
  ⚠️ **Codex reports CUMULATIVE totals where Claude reports per-turn figures** — summing
  `total_token_usage` would bill a 40-turn session forty times over, so `resolveCodexDelta` takes the
  increment and guards the compaction/resume regressions. ⚠️ **`UsageTotals.freshInput` is
  cache-EXCLUSIVE for all three**, which costs Codex a subtraction because its `input_tokens` includes
  `cached_input_tokens`; Orca deliberately does *not* normalise, which is right for a scanner that
  round-trips a file format and wrong here, where one panel adds all three together. Codex's
  `cache_write_input_tokens` is dropped on purpose — OpenAI writes its cache free, so a bucket for it
  would show tokens nobody is billed for.
  **`costUsd` is nullable and null is never zero.** Only OpenCode fills it, from its own `cost` column;
  Claude and Codex are priced from `model_pricing.dart`, and a model that matches no row leaves
  `hasUnpricedModel` set so the panel calls the figure a floor. A Grid session records a real `0.0`
  (Grid inference is free, grid ADR 0039 D-g) and that measurement must not render like an unpriced
  model. Same rule as the rail: `LedgerStatus.unavailable` is kept apart from `failed`, because a
  machine with no OpenCode is never fixed by retrying.
  **Off is the resting state**, per provider, persisted through `LocalKeyValueStore`: these transcripts
  hold every prompt, path and branch a session touched and this feature wants only the counts, so
  nothing is read until somebody switches it on — and switching one off deletes its snapshot from disk
  as well as from memory. Scans are incremental against a `{path, mtime, size}` fingerprint cached in
  `~/.harness/desktop-app/usage-ledger-<provider>.json`, and `kLedgerStaleAfter` (5 min) keeps opening
  the pane from re-walking the disk; a cold Claude scan is ~3s over 71 transcripts, which is why
  neither of those is optional. Nothing polls — a ledger only moves when an agent writes here.
  ⚠️ **Local only, by decision.** Agents launched onto remote machines write their transcripts there and
  nothing here reaches them; the pane's subtitle says so, because a total that silently excluded most of
  a team's work would be worse than no total. `UsageSource` in `usage/usage_source.dart` is where a
  per-machine source would arrive if that changes.
  `sqlite3` is a **Dart-only FFI** dependency (never `sqlite3_flutter_libs`): it dlopens the system
  library, so it registers no native plugin and leaves the macOS SPM package list alone. `kUnderTest`
  keeps `UsageSection` from auto-loading, for the same reason the rail's poller does not start there.
  ⚠️ **The snapshot goes through `SnapshotStore` (`core/snapshot_store.dart`), and a test MUST pass
  `MemorySnapshotStore`** — this is not tidiness. A real `File.writeAsString` never completes inside
  `testWidgets`' fake-async zone, so a store awaiting one hangs the whole run until the shell is
  killed rather than failing; that seam is what keeps `dart:io` out of a widget test, exactly as
  `LocalKeyValueStore` does. It is deliberately NOT `LocalKeyValueStore`: that is `state.json`, one
  small locked document, and a multi-megabyte usage snapshot in it would be rewritten on every theme
  flip. `HarnessStats` uses the same seam.
- **Settings ▸ Usage has a second half, and it counts the APP rather than the CLIs**
  (`lib/stats/harness_stats.dart`, drawn by `StatsSummaryCards`). Ported from Orca's
  `src/main/stats/`: agents spawned, time agents worked, and a "Tracking since" line. These are this
  app's own events, so unlike the ledger there is no permission to ask and no switch — an app may
  count what it did. `harnessStats` is a singleton like `analytics`, loaded by
  `loadPersistedSettings` (not for the first frame — because the counters start moving as soon as an
  agent does, and a load landing after the first `onAgentSpawned` would overwrite it) and flushed by
  `AnalyticsLifecycle.didRequestAppExit`, which is the ONLY place a turn still running at quit gets
  its time counted.
  Three hooks, all in `AppNotifier`: `createAgent` (**not** the `agent_created` push, which also
  fires for agents another client made on the same machine), the `turn_started` case (**not**
  `turn_heartbeat`, which is a turn already under way), and `_cancelTurnActivity` plus the turn
  watchdog for the end. ⚠️ **The watchdog end is load-bearing**: it is the only close a stalled turn
  ever gets, and a stats turn left open would sit there until quit and then bank every hour since as
  work. A start on a live key is ignored rather than restarting the clock, and an end with no start
  contributes nothing — that is what makes the disconnect sweep safe.
  ⚠️ **Two deliberate departures from Orca.** The third card is TURNS, not PRs created: this app
  opens no pull requests, and a card wired to a number that can only read zero is worse than one
  showing something true. And no event log is kept — Orca persists 10,000 events beside its
  aggregates for breakdowns it does not draw, at ~900KB per write; `firstEventAt` is stored directly,
  which is the one thing that log was protecting.
- **The per-provider detail pane is ONE file, not three** (`settings/sections/usage_provider_pane.dart`
  with `usage_detail_panels.dart`), against Orca's near-identical `ClaudeUsagePane` /
  `CodexUsagePane` / `OpenCodeUsagePane`. Everything that differs between providers is already in
  `usage/ledger/usage_report.dart`; three copies of the layout would be three places to fix a
  spacing bug. The lens picker at the top of Settings ▸ Usage switches between the overview and one
  provider, and `_Lens` is a nullable `LedgerProvider` so the per-provider cases stay exactly the
  providers that exist.
  **The overview opens on the last 30 days**, the window Orca's default range shows, so a figure here
  can be compared against one there — `_kDefaultOverviewRange`. All-time is a click away in the same
  picker the provider panes carry. Measured on one machine: 30 days reads 3.2B tokens / 20 active days
  / 80 sessions, where all-time reads 3.8B / 33 / 92 — both true, answering different questions. The
  intensity grid draws a fixed six weeks whatever the range is, as Orca's does: `overview.days` is
  already clipped, so the days before the window fill in as EMPTY cells rather than as stray data, and
  shrinking the strip to the range only costs it the context a heatmap exists for. Clipping
  happens in `clipLedger` at draw time, not at scan time: the scan is the expensive half and does not
  depend on the window being looked at, and `ledgerFromEntries` is shared with `buildProviderLedger` so
  a clipped ledger cannot sum its cost differently from the full one.
  ⚠️ **There is a RANGE filter and deliberately no SCOPE filter.** Orca offers "Orca worktrees only"
  against "all local usage" because it owns the worktrees its agents run in. This app owns no such
  boundary — agents launched through Harness run on OTHER machines and write their transcripts there
  — so a "Harness only" lens over this computer's logs would filter on a distinction that does not
  exist here and would answer nearly zero. Everything local is counted and the pane says so.
  ⚠️ **OpenCode's `tokens_cache_read` is a PEER of `tokens_input`, not a subset — Orca gets this
  wrong and this app must not copy it.** `opencode-usage-row-parsing.ts` clamps it with
  `Math.min(cache.read, input)` on the assumption it is contained, the way Codex's cached input is.
  Measured against a live database, three of nine sessions read more from cache than they had input at
  all (7,680 cached against 72 input), which no subset can do; the clamp threw away 30.2k of 51.0k real
  cache reads and dropped them from the total besides. OpenCode's schema keeps `tokens_input`,
  `tokens_cache_read` and `tokens_cache_write` as three columns, the Anthropic shape rather than the
  OpenAI one. Codex remains the only provider whose input needs the subtraction.
  ⚠️ **`UsageSessionsTable` states its width instead of stretching.** Inside a horizontal
  `SingleChildScrollView` the incoming width is unbounded, so `CrossAxisAlignment.stretch` asks for
  an infinite row and the layout throws; `_sessionTableWidth` sums the columns, which is the only
  honest width it has.
- **Behavioural analytics is a PORT of Grid's, not a second design** (`lib/analytics/`, copied from
  `autonomous-grid-app/lib/infrastructure/analytics/`). It reports to **Autonomous Analytics**, the
  stream the website and Grid already feed, so one person's path across the three products is one
  funnel; `AnalyticsConfig.category` (`harness-desktop`) is what keeps them apart inside it. Not to
  be confused with the CLI's `harness analytics`, which is a different product entirely — aggregate
  usage metering uploaded to the Harness backend. ⚠️ **It reports under GRID's write key**, not one
  of its own: `_defaultWriteKey` is the same constant `autonomous-grid-app` ships, so both apps
  append into one analytics project and are separable **only by `category`**, not at the source —
  a quota, a retention rule or a rotated key set on that project lands on both at once
  (**TODO(BE)**: a Harness Desktop key is a one-constant change here). ⚠️ **With the Grid project
  killed (2026-09-11), that shared project is the one to watch**: if it is wound down or its key
  rotated, this app's analytics go silent with it. `--dart-define=HARNESS_ANALYTICS_KEY=…`
  overrides it for a dev build. It still mutes for three other reasons — `HARNESS_ANALYTICS_DISABLED`,
  a test run, and an opt-out (`{"enabled": false}` in `~/.harness/desktop-app/analytics.json`) —
  checked in that order so `flutter test` never reads a real Harness home. The sink is a **singleton** (`analytics`), like
  `themeModeStore`: the call sites are `main`, `AppNotifier`, a settings pane and a menu inside a
  pane header, and most were handed a notifier rather than a `Ref`. Every event name is written down
  **once**, in `analytics_events.dart` — two call sites naming one action differently is what makes
  a stream unqueryable — and params are product facts only: a short code, an option, a count, an id.
  **Never** a prompt, terminal output, an agent or machine name, or a path. One event is
  deliberately not where you would look for it: `app_opened` is sent by `AppNotifier` when
  bootstrap resolves (a first-frame event would report every launch as signed out). **The agent funnel is
  three events, one per step, because the interesting numbers are the DROPS between them**:
  `new_agent_opened` is sent by `showNewAgentDialog` itself rather than by its four callers, so a
  fifth door cannot forget to report (its `source` is `required`, not defaulted); `agent_created`
  is sent by the dialog once Create succeeds, carrying only the engine and the bypass flag;
  `app_first_message` rides the CLI's `turn_started` rather than the
  composer, so a message typed straight into the terminal counts, and it fires **once per signed-in
  session, not per agent** (`_awaitingFirstMessage`) — the question is how long somebody sits
  logged in before talking to anything at all, so it carries the wait and `from` (`sign_in` against
  `launch`, two populations that must not be averaged together) and deliberately names no agent,
  engine or machine. Sign-out clears the clock: a session that ended without a message reports
  nothing, and its absence is the finding. `app_closed` hooks only
  `didRequestAppExit` — intercepting the window's close button needs `setPreventClose(true)`, and a
  bug on that path leaves a window nobody can close.
  **Settings ▸ Tracking is where that stream is read back** (`analytics/analytics_log.dart`,
  `settings/sections/tracking_*.dart`, ported from Grid's Tracking tab), and it answers the
  question analytics always raises and normally cannot: *did that event actually leave, and what
  was in it?* — an event never sent, sent with a missing field, or refused by the server looks
  exactly like one that landed, because the app is silent either way by design. `QueuedAnalytics`
  reports each row's life to an `AnalyticsLog` (`queued → attempted → settled`), so a retry is
  **one row with two attempts** rather than two rows, and the dialog shows the payload *as sent*
  beside the params the call site passed — the gap between those two is the bug it exists to find.
  Gated by `kDebugSurfaceEnabled` like Settings ▸ Debug, which now hides two rail rows rather than
  one (`_kDeveloperSections` in `settings_section.dart` names both, once). **The muted case is the
  one that matters**: a build can send nothing for four separate reasons, and a Tracking screen that
  were blank for any of them would be the exact trap it exists to spring — hence `MutedAnalytics`,
  which records every event as `dropped` with the reason, and a header card
  that says `Off` and why in a sentence. A release build has no such screen and gets `NoopAnalytics`
  and a `NoopAnalyticsLog`, so nothing is retained for a surface that is not there. The buffer is
  in memory and never written to disk — a stream that measures the app must not become a second
  thing the app writes on every click — which is also why recording is right even for a user who
  opted out: their choice is about what we *send*, and this sends nothing.
- Settings is a **screen**, not a dialog (`lib/settings/`): `showSettingsScreen` pushes a faded route
  whose rail lists `settingsGroups` from `settings_section.dart` and whose pane is one widget per
  `SettingsSection` (`sections/`). Adding a setting means adding an enum value, a group entry and a
  section widget — nothing else. Panes are framed by `shared/widgets/section_scaffold.dart` (copied
  from Grid), and one setting inside a pane is a `shared/widgets/setting_row.dart` — a raised block
  with its title and detail on the left and its control, fixed at `SettingRow.controlWidth`, on the
  right. Appearance and Terminal both use it; a pane that invents its own row shape is the bug.
  Controls come from `shared/widgets/` too (`AppSelectField`, `AppIconButton`) — raw Material
  `DropdownButton`/`IconButton` do not match anything else in the app.
- **The log is written to files, and Settings ▸ Debug reads them back** (`lib/logging/`,
  `settings/sections/debug_*.dart`). `appLog` (`app-YYYYMMDD.log`) is the narrative — `app`, `ws`,
  `api`, `flutter` — and `cliLog` (`cli-YYYYMMDD.log`) is a transcript of every child process, both
  ported from Grid and both pruned after 14 days. The CLI chokepoint writes it:
  `HarnessCliRunner.run/start` goes through `logging/cli_transcript.dart`, which logs the command
  **as a person reads it** (`harness auth status --json`, never the managed tier's
  `<node> <cli.js>` argv) and never its environment — a secret handed to a child rides there
  precisely to stay out of argv. The Dio clients carry `attachHttpLog`, one `api` line per finished request, method and
  URL only. **What a child PRINTS can still be a credential**, so CLI output and URLs go through
  `redactSecretsInText` (`logging/redact.dart`, beside the frame-level `redactValue`) before
  anything is written. The Debug pane is a **mirror** of those sinks, not a second stream
  (`log_stream.dart` + `log_stream_sinks.dart`): a bounded ring of the last 500 entries that
  `installFileLogs` tees into, so a line on screen is a line the file already has. It is developer
  furniture — `kDebugSurfaceEnabled` (`logging/debug_surface.dart`, `kDebugMode` or
  `--dart-define=HARNESS_DEBUG_SURFACE=true`) gates the rail row, the ⌘D shortcut
  (`kDebugShortcut`, in `appShortcuts()` rather than `kAppShortcuts`) and the ring itself; the log
  FILES are written either way, because a shipped app with no stderr is exactly the one whose logs
  matter.
- **A screen that waits on a call waits in the shape of its answer.** `shared/widgets/skeleton.dart`
  (`Skeleton`, `SkeletonText`, `SkeletonLine`, `SkeletonList`, `SkeletonBlock`) draws placeholders and
  `shared/widgets/pulse.dart` owns the app's one loading rhythm — an opacity breath between
  `AppSurface.recess` and `recessHover`, never a shimmer sweep, frozen at the **peak** under Reduce
  Motion because a block held at 40% reads as disabled. A spinner is still right where the shape is
  genuinely unknown (boot, a button mid-action); a list, table, card, row or figure gets a skeleton.
  Three rules the call sites keep, all guarded by `test/skeleton_test.dart` and
  `test/skeleton_sites_test.dart`: a placeholder is measured from the real content (`SkeletonText`
  lays out the style with a `TextPainter` rather than trusting arithmetic — see `AppMenuRowMetrics`
  for why), it wears the real row's surface and padding, and it is never **taller** than the answer
  usually is, since a skeleton that shrinks jumps the page upward. **"Loading" and "answered with
  nothing" must not render the same** — hence `AppNotifier.machinesLoading`, which is set on the
  first fetch only so a refresh keeps the rows already on screen. Same reason the status rail blanks
  its figures only before the first reading.
- `lib/shortcuts/app_shortcuts.dart` is the one list that feeds both the live bindings and the ⌘/
  sheet. `shortcutRows()` there is that list as the UI prints it — one row per action, so the two
  activators on "focus the next pane" (`⌘]`, `⌃⇥`) fold into one line, and `⌘1`–`⌘9` join as one.
  `shortcuts/shortcuts_list.dart` renders those rows in the two shapes the app needs and nothing
  else: `ShortcutsList` (the ⌘/ sheet's column, inside a 420px dialog) and `ShortcutsDeck` (Settings
  ▸ Keyboard shortcuts, group cards reflowed across the pane, plus the recessed "the terminal keeps"
  card built from `kTerminalOwnedKeys`). Same rows behind both, so they cannot disagree; keycaps come
  from `shortcuts/key_cap.dart`. Every shortcut is ⌘-based — Ctrl belongs to the shell/tmux, ⌥ is a
  Meta prefix for the pty, and ⌘C/⌘V/⌘A are owned by xterm — with one pinned exception, `⌃⇥`/`⌃⇧⇥`
  for the panes, which the terminal is made to let past.
- `lib/flash/` flashes the ESP32-S3 dial through the CLI runner; `SerialPortLease` pauses daemon
  supervision while the port is held so `harness start` cannot steal it mid-write.
- `lib/update/desktop_updater.dart` self-updates from the GCS manifest (sha256-verified, strictly
  newer only). Its keys must match what writes the manifest — `_otaKeyMacOS`/`_otaKeyMacOSArm64` the
  variant table in `scripts/publish-macos-variant.sh`, `desktop-linux-<arch>` the `OTA_KEY` in
  `scripts/upload-desktop-linux.sh`. An Intel Mac reads only `desktop-macos` (the Skia build); Apple
  Silicon takes the newer of `desktop-macos-arm64` and `desktop-macos`, arm64 winning a tie.

## Testing conventions

Unit tests build `AppNotifier(config: AppConfig.dev, authSession: AuthSession(), configStore: null)`
and set `status` directly, or pass subclass fakes (`CliLogin`, `EnvironmentProvisioner`, `ConfigStore`)
so nothing shells out to a real `harness` binary. Stores (`PaneLayoutStore`, `ThemeModeStore`,
`TerminalFontStore`) take an in-memory `LocalKeyValueStore` implementation instead of touching
`~/.harness`. `TerminalSession` is exercised with recording `send`/`sendBinary` closures and
`handleFrame`/`handleBinary`. Use the `@visibleForTesting` seams on `AppNotifier`
(`handleEventForTest`, `adoptSessionForTest`) rather than reaching into private state.
