import 'dart:async';
import 'dart:io' show exit, pid;

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../analytics/analytics.dart';
import '../api/api_client.dart';
import '../auth/auth_session.dart';
import '../auth/cli_link.dart';
import '../auth/cli_login.dart';
import '../bootstrap/environment_provisioner.dart';
import '../core/config.dart';
import '../core/engine_availability.dart';
import '../core/local_hostname.dart';
import '../core/models.dart';
import '../core/retry.dart';
import '../settings/config_store.dart';
import '../stats/harness_stats.dart';
import '../terminal/terminal_session.dart';
import '../terminal/remote_media_download.dart';
import '../widgets/engine_identity.dart' show allEngines;
import '../core/harness_file_store.dart';
import 'dial_status.dart';
import 'pane_layout_store.dart';
import 'terminal_pane.dart';
import '../terminal/terminal_binary.dart';
import '../update/desktop_updater.dart';
import '../update/manual_update_check.dart';
import '../ws/ws_conn.dart';
import '../ws/local_cli_discovery.dart';
import '../ws/ws_pool.dart';
import 'pane_preset.dart';
import 'pending_question.dart';
import '../usage/remote_usage.dart';
import '../usage/usage_accounts.dart';

enum AppStatus {
  bootstrapping,
  checkingEnvironment,
  preparingEnvironment,
  unauthenticated,
  authenticated,
}

enum AgentLoadStatus { idle, needsLink, loading, loaded, error }

enum MachineTransportMode { cloudE2ee, localPlaintext, localOffline }

/// Result of [AppNotifier.restartAgent]. [error] null means the RPC succeeded; [resumed] then says
/// whether the daemon reattached the agent's prior session or fell back to a fresh one (e.g. the
/// engine's resume flag wasn't recognized) — worth telling the user about, since it's not a failure
/// but the conversation may not have continued the way "Restart" implies.
class RestartAgentResult {
  final String? error;
  final bool resumed;

  const RestartAgentResult({this.error, this.resumed = true});
}

String? _normalizeComputerId(String? raw) {
  if (raw == null) return null;
  final value = raw.trim().toLowerCase().replaceAll('-', '');
  return RegExp(r'^[a-f0-9]{16,64}$').hasMatch(value) ? value : null;
}

/// Explicit, compile-time guarded fixture used only by `main_local_manual.dart`.
///
/// It lets a normal Flutter window exercise the local Backend -> Harness CLI ->
/// tmux path without depending on SSO. The API key and setup token are random,
/// disposable values produced by the local launcher and are never persisted.
class LocalManualFixture {
  final String apiBaseUrl;
  final String apiKey;
  final String machineId;
  final String machineName;
  final String setupToken;

  const LocalManualFixture({
    required this.apiBaseUrl,
    required this.apiKey,
    required this.machineId,
    required this.machineName,
    required this.setupToken,
  });
}

@visibleForTesting
Map<String, dynamic> eventWithClearPayload(
  Map<String, dynamic> frame,
  String type,
  Map<String, dynamic> payload,
) => {...frame, 'type': type, 'payload': payload};

class MachineState {
  Machine machine;
  ConnectionStatus connectionStatus = ConnectionStatus.disconnected;
  MachineTransportMode transportMode = MachineTransportMode.cloudE2ee;

  /// Set when this machine is bound to the local CLI's stable computer id. A
  /// local machine never falls back to cloud E2EE while that identity exists.
  bool localOnly = false;
  LocalCliEndpoint? localEndpoint;
  // Set when the local CLI's relay reports NO_PEER_LINK for this (non-local) machine — it needs
  // `harness link connect <machineId>` (the other machine's remote password) before it can
  // connect. The CLI owns E2EE entirely now; this is just "is trust established yet", not a
  // crypto/pairing state the app has any data for.
  bool needsLink = false;
  List<Agent> agents = [];
  AgentLoadStatus agentLoadStatus = AgentLoadStatus.idle;
  bool agentsRefreshing = false;
  String? agentsLoadError;
  Future<void>? agentsLoadInFlight;
  String? activeAgentId;
  bool terminalCapabilityLoaded = false;
  bool terminalCapabilityAvailable = false;
  String? terminalCapabilityError;
  // Whether this machine's CLI daemon understands `terminal_paste` (a clipboard paste delivered as
  // one atomic tmux paste-buffer, not chunked like ordinary keystrokes — see TerminalSession.pasteText).
  // False for any CLI published before this existed; the panel falls back to the old chunked path.
  bool terminalPasteRawAvailable = false;
  // Whether this machine's CLI daemon understands TerminalBinaryKind.imagePaste (a native clipboard
  // IMAGE paste — see TerminalSession.pasteImage). False for any CLI published before this existed;
  // the panel falls back to forwarding a bare Ctrl+V, today's only option for an image paste.
  bool terminalImagePasteAvailable = false;
  // Whether this machine's CLI daemon understands TerminalBinaryKind.pasteFile (a dropped non-image
  // file, written to disk on that machine and pasted as a path — see TerminalSession.pasteFile).
  // Only consulted for a REMOTE pane; a local one pastes its own path directly and never needs this.
  bool terminalPasteFileAvailable = false;
  bool mediaPreviewAvailable = false;
  // Which engines this machine actually has, as this machine answered it. Kept
  // on MachineState rather than globally because that is the whole point: two
  // machines on one account hold different engines, and the Docker rig holds
  // exactly one. See `engines_probe` in the CLI's backendSocket.
  final MachineEngines engines = MachineEngines();
  // Adapter/manager presence for this machine, from `node_status` pushes —
  // distinct from `connectionStatus`, which only reflects OUR websocket to
  // the backend. null = not seen yet (initial connect).
  bool? nodeOnline;
  // The agent the user selected while the Harness adapter was offline. Keep
  // this separate from activeAgentId so the UI can show a join guide without
  // opening a terminal stream against an unavailable node.
  String? pendingOfflineAgentId;
  final Set<String> processingAgentIds = {};

  /// Agents on this machine that have stopped to ask something, by agentId.
  /// At most one per agent: a pane shows one dialog at a time, and the daemon
  /// re-announces the same open question rather than queueing a second.
  final Map<String, PendingQuestion> blockedAgents = {};
  final Map<String, String> sessionAgentIds = {};
  // Turn events can arrive while the initial agents_list RPC is still in
  // flight. Retain session correlation until that snapshot binds the row.
  final Set<String> pendingProcessingSessions = {};

  MachineState(this.machine);

  bool get isRemote => machine.authMode == MachineAuthMode.remote;
  bool get isLocalMachine => localOnly || localEndpoint != null;
  bool get usesLocalTransport => localEndpoint != null;

  Agent? get activeAgent {
    for (final agent in agents) {
      if (agent.id == activeAgentId) return agent;
    }
    return null;
  }
}

/// Auth, Remote-machine discovery, E2EE and one explicit terminal attachment.
/// Structured chat intentionally does not exist in the Desktop MVP state.
/// A spoken task the daemon wants THIS window to route — see the `voice_route_request` case below.
///
/// Deliberately not the palette's own [SpokenTask]: this layer holds no callback and knows nothing about
/// dialogs. The screen that can open one turns this into that, and wires the answer back through
/// [AppNotifier.reportVoiceRoute].
class SpokenTaskRequest {
  const SpokenTaskRequest({
    required this.voiceId,
    required this.machineId,
    required this.text,
    required this.cmd,
  });

  final String voiceId;

  /// Which daemon asked — the answer has to go back to that one, not to whichever is selected when the
  /// person finally picks.
  final String machineId;
  final String text;

  /// 'goal', 'loop', or empty: which of the dial's three buttons was held.
  final String cmd;
}

/// One line in the rail: a machine, or an agent under one.
///
/// A record rather than a widget key, because the cursor has to survive a
/// rebuild that changes what is on screen — an agent finishing, a machine going
/// offline — and an index into a list of widgets does not.
@immutable
class RailRow {
  const RailRow({required this.machineId, this.agentId});

  final String machineId;

  /// Null for the machine's own row.
  final String? agentId;

  @override
  bool operator ==(Object other) =>
      other is RailRow &&
      other.machineId == machineId &&
      other.agentId == agentId;

  @override
  int get hashCode => Object.hash(machineId, agentId);
}

class AppNotifier extends ChangeNotifier {
  final AuthSession session;
  AppConfig config;
  late ApiClient api;
  final CliLogin cliLogin;
  final CliLink cliLink;
  final ConfigStore? _store;

  /// Spoken tasks waiting for a palette. Broadcast because the screen subscribes and unsubscribes with
  /// its own lifetime, and a request that arrives with no screen up is dropped rather than queued — the
  /// daemon's own deadline is the thing that decides how long a spoken task stays interesting.
  final StreamController<SpokenTaskRequest> _spokenTasks =
      StreamController<SpokenTaskRequest>.broadcast();

  /// Words from the dial, for whoever can put a palette on screen.
  Stream<SpokenTaskRequest> get spokenTasks => _spokenTasks.stream;
  final LocalManualFixture? localManualFixture;
  final Duration turnActivityTimeout;
  final LocalCliDiscovery? localCliDiscovery;

  /// ONE discovery for the whole notifier. It used to be built fresh at each of
  /// three call sites, which was harmless while it was stateless and is not
  /// now that the supervisor's ready-transition callback lives on it.
  ///
  /// `late`, so it reads `config` on first use — which is [ensureCliDaemonReady]
  /// during bootstrap, AFTER the persisted config has been loaded over the
  /// default. Touch it earlier and it freezes the wrong `localCliBaseUrl`.
  late final LocalCliDiscovery _discovery =
      localCliDiscovery ?? LocalCliDiscovery(config: config);
  final EnvironmentProvisioner? environmentProvisioner;
  final DesktopUpdater? desktopUpdater;
  final Map<String, Timer> _turnActivityWatchdogs = {};

  /// When this launch became signed in, and by which route — until the first
  /// message of that session has been reported, after which it is null.
  ///
  /// One record for the whole app, not one per agent: the question is how long
  /// somebody sits signed in before talking to anything at all, and which agent
  /// they finally picked is `agent_created`'s business. A session where nobody
  /// ever sends a message simply leaves this set until sign-out or quit, which
  /// is exactly the population the event exists to measure the absence of.
  ({DateTime at, String from})? _awaitingFirstMessage;

  final Map<String, Timer> _offlineRetryTimers = {};
  // Periodic retry for a machine the relay reported NO_PEER_LINK for — a `harness link connect` run
  // in a terminal (or another app instance) has no way to notify this one, so this is what makes the
  // app pick up a fresh link within a few seconds instead of only on the next manual click/restart.
  final Map<String, Timer> _linkRetryTimers = {};
  // Safety-net reconciliation for a connected machine's agent list, on top of the push events
  // (agent_synced/agent_created/agent_renamed/agent_deleted) that normally keep it live — catches the
  // rare case a push event was dropped. Runs silently: see _syncAgentsIfChanged.
  final Map<String, Timer> _agentSyncTimers = {};
  // Keeps the local `harness` daemon alive for the whole app run — started once after the first
  // successful bootstrap (see `ensureCliDaemonReady`), cancelled on dispose. Cancelling only stops this
  // Dart-side loop; the daemon itself self-daemonizes and must keep running after the app quits.
  Timer? _daemonSupervisionTimer;

  /// The last [ensureCliDaemonReady] did not reach a ready daemon — the one
  /// error the supervisor's ready transition is allowed to retry away.
  bool _daemonGateFailed = false;
  // Update checks do not depend on the daemon or SSO. A signed-out user should
  // still be able to replace a broken desktop build from the login screen.
  Timer? _updateCheckTimer;
  String? _skippedDesktopUpdateVersion;
  UpdateInfo? availableUpdate;
  bool isCheckingForUpdate = false;
  bool isInstallingUpdate = false;
  String? updateError;
  final Set<String> _offlinePollsInFlight = {};
  final Set<String> _offlineRecoveryInFlight = {};
  bool _disposed = false;

  WsPool? _pool;
  late String _autonomousEnv;
  String? _lastError;
  // Retrying re-runs `refreshMachines()` — a real fix for "could not load
  // machines" or a daemon hiccup, but a no-op for a failure that already
  // finished (an agent's launch), where the only honest control is to
  // dismiss it.
  bool _lastErrorRetryable = true;
  // Shown on the pre-navigation `bootstrapping` screen while [_finishBootstrapSignedIn] waits on the
  // local daemon — null the rest of the time, including once [status] flips to `authenticated`.
  String? _bootStatusMessage;
  EnvironmentReadiness environmentReadiness = EnvironmentReadiness.initial();
  bool _environmentSetupInFlight = false;
  // Polls a step stuck in needsTerminal/failed every 5s (see `_scheduleEnvironmentRecheck`) so a user
  // who fixes it by hand in their own terminal doesn't have to remember to click Recheck. A one-shot
  // Timer that reschedules itself rather than `Timer.periodic`, so a slow recheck can't overlap with
  // the next tick.
  Timer? _environmentRecheckTimer;

  /// Whether a stuck step is being auto-polled right now — drives the "Checking automatically…"
  /// caption on [EnvironmentSetupScreen] alongside its Recheck button.
  bool get environmentRecheckPending => _environmentRecheckTimer != null;

  /// Whether a provisioning run (initial or a per-step recheck) is in flight — lets the setup
  /// screen disable its Recheck/Start over buttons and show a spinner instead of a second click
  /// racing the first.
  bool get environmentSetupInFlight => _environmentSetupInFlight;

  // The daemon's own advertised local-ws endpoint — the dial target for EVERY machine's data plane
  // now, not just this computer's own one (see src/lib/remoteRelay.ts in the harness CLI repo: a
  // foreign machineId is relayed to backend transparently, so the app never dials backend directly).
  LocalCliEndpoint? _cliEndpoint;

  AppStatus status = AppStatus.bootstrapping;
  CurrentUserProfile? currentUser;
  List<Machine> machines = [];
  final Map<String, MachineState> machineStates = {};
  final Set<String> expandedMachines = {};
  String? selectedMachineId;

  /// The grid, in reading order. At most [maxPanes].
  final List<TerminalPane> panes = [];

  /// Which tile the keyboard, the dial and the rail's highlight all mean.
  ///
  /// Typing itself does NOT go through this on macOS — the renderer is a
  /// WebView, so a click makes that pane's WKWebView the first responder and
  /// AppKit routes keys there without asking. This is for everything that has
  /// no pointer behind it: the dial's scroll and focus frames, and which agent
  /// the rail draws as current.
  int? focusedPaneId;

  /// The chosen shape for a grid of this size, or the shipped one.
  final Map<int, PanePreset> panePresets = {};

  PanePreset? presetFor(int paneCount) =>
      panePresets[paneCount] ?? PanePreset.defaultFor(paneCount);

  /// Choose a shape. Keyed by tile COUNT: three tiles and four tiles are
  /// different shapes and one choice cannot speak for both.
  ///
  /// The shape is now the ONLY thing to choose about the grid — tiles are laid
  /// out at the proportions the shape states and nothing is draggable. Which is
  /// why the shapes had to become a real list first: dragging was what a person
  /// reached for when the one shape on offer was not the one they wanted.
  void setPreset(int paneCount, PanePreset preset) {
    if (!PanePreset.forCount(paneCount).contains(preset)) return;
    if (presetFor(paneCount) == preset) return;
    panePresets[paneCount] = preset;
    notifyListeners();
    unawaited(_paneLayout?.savePresets(panePresets));
  }

  int _nextPaneId = 1;

  static const maxPanes = PaneLayoutStore.maxPanes;
  // Set only while `harness login --force --json` is waiting for the user to finish SSO in their system
  // browser. It arrives PART WAY THROUGH the flow — the CLI has to start before it can hand one
  // over — so it says "the browser is open", not "a sign-in is running". Use [signingIn] for the
  // second question; see the note there.
  String? pendingAuthorizeUrl;

  /// True from the moment the user presses Sign in until the flow settles, one way or the other.
  ///
  /// **Not the same question as `pendingAuthorizeUrl != null`, and the difference was a bug.**
  /// `login()` flips [status] to `bootstrapping` immediately, but the authorize URL only lands
  /// once the CLI has spawned Node and got as far as printing one — seconds later — and it is
  /// cleared again in `finally` while `_finishBootstrapSignedIn()` is still restoring panes and
  /// fetching machines. `RootShell` keyed the sign-in screen off the URL, so both of those windows
  /// dropped the user onto a bare full-screen spinner: the card they were looking at vanished on
  /// the click, came back, then vanished again on success.
  ///
  /// This flag spans the whole flow, so the screen the user pressed a button on stays put.
  bool signingIn = false;

  AppNotifier({
    required AppConfig config,
    required AuthSession authSession,
    ConfigStore? configStore,
    this.localManualFixture,
    this.localCliDiscovery,
    this.environmentProvisioner,
    this.desktopUpdater,
    CliLogin? cliLogin,
    CliLink? cliLink,
    PaneLayoutStore? paneLayoutStore,
    this.turnActivityTimeout = const Duration(seconds: 12),
  }) : _paneLayout = paneLayoutStore,
       // Remembers "a dial has been seen here" on the same terms the pane
       // layout is remembered: with a layout store there is a state file, and
       // without one (the tests) nothing is written anywhere.
       dial = DialState(
         paneLayoutStore == null ? null : HarnessFileStore.shared,
       ),
       session = authSession,
       _store = configStore,
       cliLogin = cliLogin ?? CliLogin(),
       cliLink = cliLink ?? CliLink(),
       config = configStore?.config ?? config {
    _autonomousEnv = this.config.autonomousEnv;
    api = ApiClient(config: this.config, session: session);
  }

  String? get lastError => _lastError;
  bool get lastErrorRetryable => _lastErrorRetryable;
  String? get bootStatusMessage => _bootStatusMessage;

  /// Clears the error strip without retrying anything, for a failure retrying
  /// cannot fix (see [_lastErrorRetryable]).
  void dismissError() {
    _lastError = null;
    notifyListeners();
  }

  String get autonomousEnv => _autonomousEnv;
  bool get hasAvailableUpdate => availableUpdate != null;

  static const offlineRetryInterval = Duration(seconds: 5);
  static const agentSyncInterval = Duration(seconds: 60);

  MachineState? stateOf(String machineId) => machineStates[machineId];

  // ── the grid ────────────────────────────────────────────────────────────────────────────────────

  /// Null means "remember nothing", which is what a test gets by default.
  ///
  /// Deliberately NOT `?? PaneLayoutStore()` like the stores above it. Those
  /// only read, and only when asked; this one WRITES on every pane change, and
  /// a widget test that opens an agent would otherwise rewrite the layout in
  /// the developer's own ~/.harness state file. Production passes one; see
  /// [appStateProvider].
  final PaneLayoutStore? _paneLayout;

  /// The dial on this desk, for the rail's device row. Fed by `dial_status`
  /// frames from the local daemon; its own notifier, so the row rebuilds
  /// without dragging the whole rail through a machine-list rebuild.
  final DialState dial;

  TerminalPane? get focusedPane {
    final id = focusedPaneId;
    if (id == null) return null;
    for (final pane in panes) {
      if (pane.id == id) return pane;
    }
    return null;
  }

  /// The one tile everything single-terminal still means.
  ///
  /// Kept as a getter rather than deleted because the alternative — teaching
  /// every caller about tiles — would have spread the grid across code that has
  /// no business knowing there is one (a rename arriving, an agent being
  /// deleted, the window closing). The handful of callers that must reach EVERY
  /// tile of a machine, rather than only the focused one, call [panesFor]
  /// instead; those are the transport-wide events, and they are marked.
  TerminalSession? get activeTerminal => focusedPane?.session;

  bool get canAddPane => panes.length < maxPanes;

  Iterable<TerminalPane> panesFor(String machineId) =>
      panes.where((pane) => pane.machineId == machineId);

  TerminalPane? paneOfAgent(String machineId, String agentId) {
    for (final pane in panes) {
      if (pane.machineId == machineId && pane.agentId == agentId) return pane;
    }
    return null;
  }

  bool isAgentInPane(String machineId, String agentId) =>
      paneOfAgent(machineId, agentId) != null;

  /// True while the KEYBOARD is in the rail rather than on the grid.
  ///
  /// Folded into [isPaneFocused] on purpose, and it does two jobs at once. The
  /// terminal re-claims the native input connection when `focused` goes false →
  /// true (TerminalPanel.didUpdateWidget), so flipping this is what hands the
  /// keys over and what takes them back. And the focus ring leaves the tile
  /// while the rail has the cursor, which is the honest thing to draw: a ring on
  /// a pane that is not receiving keys is a lie the whole feature would rest on.
  bool railFocused = false;

  /// Which row the rail's cursor is on, indexing [railRows].
  int railCursor = 0;

  bool isPaneFocused(int paneId) => !railFocused && focusedPaneId == paneId;

  /// The rail as a flat list of rows, in the order it is drawn.
  ///
  /// ONE source for the cursor and for the highlight. The rail builds its own
  /// tree from the same pieces, and a second traversal that "should" agree is
  /// exactly how an arrow key ends up selecting a different row than the one
  /// lit up — so the widget reads its highlight from this list too.
  ///
  /// Local machine first, then the backend's order, which is what the rail has
  /// always drawn; a machine that is collapsed contributes its own row and none
  /// of its agents, because a cursor cannot rest on something not on screen.
  List<RailRow> railRows() {
    final rows = <RailRow>[];
    final ordered = <Machine>[
      ...machines.where((m) => stateOf(m.machineId)?.isLocalMachine == true),
      ...machines.where((m) => stateOf(m.machineId)?.isLocalMachine != true),
    ];
    for (final machine in ordered) {
      rows.add(RailRow(machineId: machine.machineId));
      if (!expandedMachines.contains(machine.machineId)) continue;
      for (final agent
          in stateOf(machine.machineId)?.agents ?? const <Agent>[]) {
        rows.add(RailRow(machineId: machine.machineId, agentId: agent.id));
      }
    }
    return rows;
  }

  /// Hand the keyboard to the rail — ⌘h off the left edge of the grid.
  ///
  /// The cursor starts on the agent the window is already looking at, so the
  /// first press of `j` steps off it rather than jumping to the top of a list
  /// of thirty. Same reasoning as the layout palette's cursor.
  void focusRail() {
    final rows = railRows();
    if (rows.isEmpty) return;
    final pane = panes.where((p) => p.id == focusedPaneId).firstOrNull;
    var at = 0;
    if (pane?.agentId != null) {
      final found = rows.indexWhere(
        (row) =>
            row.agentId == pane!.agentId && row.machineId == pane.machineId,
      );
      if (found >= 0) at = found;
    }
    railFocused = true;
    railCursor = at;
    notifyListeners();
  }

  /// Give it back. The focused tile re-claims the keys on the next frame.
  void unfocusRail() {
    if (!railFocused) return;
    railFocused = false;
    notifyListeners();
  }

  /// The row the cursor is on, or null when the rail has changed under it.
  ///
  /// Bounds-checked rather than clamped, and that distinction is the point: an
  /// agent finishing or a machine collapsing can shorten the list between a
  /// keypress and the frame that draws it, and clamping would silently light up
  /// a DIFFERENT row than the one the cursor was on. Null draws nothing, which
  /// is the honest answer for one frame.
  RailRow? railRowAt(int index) {
    final rows = railRows();
    if (index < 0 || index >= rows.length) return null;
    return rows[index];
  }

  void moveRailCursor(int delta) {
    final rows = railRows();
    if (rows.isEmpty) return;
    // Clamped, not wrapped: the rail is a column you can see the ends of, and a
    // cursor that leaps from the last machine back to the first reads as a
    // mis-key. The grid's own focus wraps because it is a loop of tiles.
    railCursor = (railCursor + delta).clamp(0, rows.length - 1);
    notifyListeners();
  }

  /// Enter on the cursor's row.
  ///
  /// A machine row toggles; an agent row opens and gives the keyboard back —
  /// because "go to this agent" is a request to work in it, and leaving the
  /// keys in the sidebar would make every open a two-step.
  Future<void> activateRailRow() async {
    final rows = railRows();
    if (railCursor < 0 || railCursor >= rows.length) return;
    final row = rows[railCursor];
    if (row.agentId == null) {
      toggleExpand(row.machineId);
      return;
    }
    railFocused = false;
    notifyListeners();
    await selectAgent(row.machineId, row.agentId!);
  }

  /// `h` in the rail — out of an agent list, then out of the rail.
  ///
  /// Two steps rather than one, and that is the vim shape: `h` at the top level
  /// leaves, `h` inside something closes it first. Pressed on an agent it jumps
  /// to that agent's machine row and folds it, which is where the eye already
  /// is; pressed on a machine row it hands the keyboard back to the grid.
  void railCollapseOrExit() {
    final rows = railRows();
    if (railCursor < 0 || railCursor >= rows.length) {
      unfocusRail();
      return;
    }
    final row = rows[railCursor];
    if (row.agentId != null) {
      final head = rows.indexWhere(
        (r) => r.machineId == row.machineId && r.agentId == null,
      );
      if (head >= 0) railCursor = head;
      toggleExpand(row.machineId);
      notifyListeners();
      return;
    }
    if (expandedMachines.contains(row.machineId)) {
      toggleExpand(row.machineId);
      return;
    }
    unfocusRail();
  }

  /// Show or hide one tile's composer textbox, and remember the choice.
  void toggleComposer(int paneId) {
    for (final pane in panes) {
      if (pane.id != paneId) continue;
      pane.composerVisible = !pane.composerVisible;
      _persistLayout();
      notifyListeners();
      return;
    }
  }

  void focusPane(int paneId) {
    if (!panes.any((pane) => pane.id == paneId)) return;
    final moved = focusedPaneId != paneId;
    // Remembered only on a REAL move. Re-focusing the tile you are already on
    // happens constantly — see the note below about why it is announced anyway
    // — and recording it would make ⌘; a key that returns you to where you
    // already are, which is the same as a key that does nothing.
    if (moved) _previousPaneId = focusedPaneId;
    focusedPaneId = paneId;
    // Announced even when this tile was ALREADY focused.
    //
    // The dial can be turned by hand, and then the two disagree with nobody
    // knowing. Choosing this agent — from the rail or by clicking its tile — is
    // how someone says "no, look at THIS one", so it has to be able to say it.
    //
    // The old guard here made that impossible in exactly the case that needed
    // it. An agent that is NOT open yet gets a fresh stream, and the daemon
    // follows `terminal_open` as a side effect; one that IS open opens nothing,
    // so `app_focus` is the only thing that can move the dial — and this
    // returned before sending it. That is why a single pane always worked
    // (every switch re-attached) and a second pane broke it.
    //
    // Re-sending the same agent is safe: the daemon drops it against the dial's
    // real position (`agentId === this.dialFocus` in cableSession), which is the
    // only side that can judge, because only it knows where the dial is.
    _announceFocusToDial();
    // Only a real move is worth a rebuild.
    if (moved) notifyListeners();
  }

  /// Tell the local daemon which agent this window is looking at, so the dial follows it.
  ///
  /// Said outright rather than left to be inferred. The daemon used to work this out from
  /// `terminal_open`, which was equivalent while a window could only show one terminal: every move
  /// opened a stream, so opening one meant it had moved.
  ///
  /// A pane grid breaks that equivalence. Clicking a tile that already holds a live session opens
  /// nothing at all, so the dial stayed on whichever agent the last rail click had opened — which is
  /// why the rail appeared to work and the panes did not.
  ///
  /// Fire-and-forget, and only for a tile that has an agent: a machine tile is not somewhere the
  /// dial can go.
  void _announceFocusToDial() {
    final pane = focusedPane;
    final agentId = pane?.agentId;
    if (pane == null || agentId == null) return;
    // The EXISTING connection, never `_conn`, which builds one. Opening a socket as a side effect of
    // moving a focus ring is the wrong trade in both directions: it dials a machine nobody asked to
    // reach, and `_conn` throws outright before the pool exists — which took focusPane down with it,
    // so clicking a tile did nothing at all rather than merely failing to reach the dial.
    //
    // Nothing here is worth failing a click for: no dial attached, no daemon yet, a socket mid
    // reconnect — the tile still focuses and the window still works.
    final connection = _pool?[pane.machineId];
    if (connection == null) return;
    unawaited(
      connection
          .sendTerminalFrame('app_focus', {'agentId': agentId})
          .catchError((_) => false),
    );
  }

  /// Tell the daemon which agents have a tile on the grid, so the dial can stay
  /// quiet about a turn that finished in front of the person.
  ///
  /// An OPEN tile counts as seen. Not a focused one: with four tiles all four
  /// are on screen, and the window has no honest way to say which the eye is
  /// on. Nor is the window's own focus consulted — a decision, not an
  /// oversight: it means a turn that lands while the app is behind a browser
  /// stays silent, and the alternative is a dial that beeps about tiles you are
  /// looking straight at.
  ///
  /// Sent to EVERY connected daemon, with the full list across all machines.
  /// The dial belongs to whichever daemon owns the cable, and only a complete
  /// roster lets that one judge; the others store a list they never use, which
  /// costs nothing and saves the window from having to know which is which.
  void _announceOpenPanesToDial() {
    final pool = _pool;
    if (pool == null) return;
    final agentIds = <String>[for (final pane in panes) ?pane.agentId];
    for (final machineId in machineStates.keys) {
      final connection = pool[machineId];
      if (connection == null) continue;
      unawaited(
        connection
            .sendTerminalFrame('app_panes', {'agentIds': agentIds})
            .catchError((_) => false),
      );
    }
  }

  /// Machines whose link prompt the user has waved away.
  ///
  /// Dismissing cannot mean "deselect": [activeMachineState] falls back to the
  /// first expanded machine, so clearing the selection would often re-arrive at
  /// the very machine that was just closed. And it must not mean "linked" —
  /// nothing changed about the machine, which still cannot be read and still
  /// says so in the rail. It means only that the pane stops insisting.
  ///
  /// Held in memory, not on disk, and cleared the moment the machine is chosen
  /// again: someone who clicks that row is asking to see it.
  final Set<String> _dismissedLinkPrompts = {};

  bool isLinkPromptDismissed(String machineId) =>
      _dismissedLinkPrompts.contains(machineId);

  void dismissLinkPrompt(String machineId) {
    if (_dismissedLinkPrompts.add(machineId)) notifyListeners();
  }

  // ── ⌘B: a typed task, and which agent it belongs to ────────────────────────────────────────────

  /// The machine this window is running ON — where the daemon that ANSWERS ⌘B lives.
  ///
  /// It is not the scope of the search: the daemon weighs agents on every machine and answers with the
  /// one each pick belongs to. This is only the socket the question travels on, because the router, the
  /// registry and the recap mirror it reads are all on this computer.
  MachineState? get localMachineState {
    for (final state in machineStates.values) {
      if (state.isLocalMachine) {
        return state; // the flag is the STATE's, not the machine row's
      }
    }
    return null;
  }

  /// Ask the daemon which agent a typed task belongs to. Sends nothing.
  ///
  /// Rides the app's own rpc convention (`ws_conn.request`), so the pending map, the timeout and the
  /// logging are the ones every other request already uses. Returns null when there is nobody to ask —
  /// no local machine, or its socket is not up — which the palette says out loud rather than spinning.
  /// Answer the daemon about a spoken task it asked this window to route.
  ///
  /// Fire and forget, and correlated by `voiceId` rather than by the rpc convention ⌘B uses: the question
  /// travelled the other way this time, so the pending id belongs to the daemon and this is a report, not
  /// a request. Sent back to the machine that ASKED — with two daemons attached, answering the selected
  /// one leaves the asker waiting on a reply that went to a stranger.
  void reportVoiceRoute(
    String machineId,
    String voiceId,
    String state,
    String agentId,
  ) {
    final connection = _pool?[machineId];
    if (connection == null) return;
    unawaited(
      connection
          .sendTerminalFrame('voice_route_reply', {
            'voiceId': voiceId,
            'state': state,
            if (agentId.isNotEmpty) 'agentId': agentId,
          })
          .catchError((_) => false),
    );
  }

  Future<RouteAnswer?> routeTask(String text) async {
    final machineId = localMachineState?.machine.machineId;
    final connection = machineId == null ? null : _pool?[machineId];
    if (connection == null) return null;
    try {
      final reply = await connection.request(
        'route_task',
        payload: {'text': text},
        // Over the daemon's own classification budget — which is 20s on this path — plus room for
        // gathering the candidates and the round trip. A request that gives up BEFORE the router does
        // leaves the person with nothing WHILE the answer is on its way, which is the one outcome worse
        // than waiting; and at exactly 20s each it would be a coin toss which of the two fired first.
        timeout: const Duration(seconds: 35),
      );
      return RouteAnswer.fromJson(reply);
    } catch (_) {
      // A timeout or a transport failure is not an error the person can act on — the palette shows the
      // candidates it has and lets them choose, which is the same thing it does for a weak answer.
      return null;
    }
  }

  /// Commit: deliver the task, then bring the agent onto the grid the way a rail click does.
  ///
  /// The daemon delivers it through the SAME door as the web's messages and the dial's — queueing,
  /// retries and the per-engine slash-command adaptation are not re-implemented for the caller that
  /// types instead of speaking.
  /// Commit: deliver the task, then bring the agent onto the grid the way a rail click does.
  ///
  /// Returns null when it landed, or a sentence saying why it did not — which the palette shows instead
  /// of closing. It ASKS rather than tells for a reason measured on the desk: the remote leg carries no
  /// ack of its own, so a machine that has gone deaf takes the turn and nothing comes back. A confident
  /// route closes this window silently, so without an answer that is a task that vanished with no mark
  /// anywhere — the worst outcome this flow can produce.
  ///
  /// [agentMachineId] is the agent's OWN machine, which is not this one when the router reached across.
  Future<String?> sendRoutedTask(
    String agentId,
    String agentMachineId,
    String text,
  ) async {
    final localId = localMachineState?.machine.machineId;
    if (localId == null) return 'No local machine is connected.';
    final connection = _pool?[localId];
    if (connection == null) return 'No local machine is connected.';
    // The task goes to the LOCAL daemon whichever machine the agent is on: it owns the dispatch that
    // knows the difference (its own registry, or the fleet link to the other computer). Sending it down
    // the remote machine's own socket would be a second delivery path for the same thing.
    try {
      final reply = await connection.request(
        'route_send',
        payload: {'agentId': agentId, 'text': text},
        timeout: const Duration(seconds: 15),
      );
      if (reply['ok'] != true) {
        final machine = (reply['machine'] as String?) ?? '';
        final reason =
            (reply['reason'] as String?) ?? 'it could not be delivered';
        return machine.isEmpty
            ? 'Not sent — $reason.'
            : 'Not sent to $machine — $reason.';
      }
    } catch (_) {
      return 'The daemon did not answer. Nothing was sent.';
    }
    // …the PANE opens on the agent's machine. Falling back to this computer would open a tile for an
    // agent it does not have and leave the person looking at an empty terminal.
    final target = agentMachineId.isNotEmpty ? agentMachineId : localId;
    await selectAgent(target, agentId);
    return null;
  }

  MachineState? get activeMachineState {
    final terminal = activeTerminal;
    if (terminal != null) return machineStates[terminal.machineId];
    final selected = selectedMachineId;
    if (selected != null) return machineStates[selected];
    return expandedMachines.isEmpty
        ? null
        : machineStates[expandedMachines.first];
  }

  bool? _nodeOnlineFromStatus(String? status) {
    switch (status?.trim().toLowerCase()) {
      case 'running':
      case 'online':
      case 'connected':
      case 'ready':
        return true;
      case 'offline':
      case 'stopped':
      case 'disconnected':
      case 'unreachable':
      case 'error':
      case 'failed':
        return false;
      default:
        return null;
    }
  }

  Future<void> selectAutonomousEnv(String value) async {
    if (value != 'prod' && value != 'stag') return;
    _autonomousEnv = value;
    config = AppConfig(
      apiBaseUrl: config.apiBaseUrl,
      autonomousEnv: value,
      localCliBaseUrl: config.localCliBaseUrl,
    );
    _lastError = null;
    notifyListeners();
    await _store?.saveEnvironment(value);
  }

  Future<void> bootstrap() async {
    final localFixture = localManualFixture;
    if (localFixture != null) {
      _bootstrapLocalManual(localFixture);
      return;
    }
    try {
      if (_store != null) {
        try {
          config = await _store.load().timeout(const Duration(seconds: 5));
        } catch (error) {
          // Connection settings are optional local preferences. An unavailable
          // state file must not invalidate an otherwise recoverable SSO flow;
          // use the store's safe cached/default production config.
          debugPrint(
            'bootstrap: config store unavailable, using defaults: $error',
          );
          config = _store.config;
        }
        // Forced, not read from persisted config: staging is a dev-only
        // escape hatch with no UI to reach it anymore (see login_screen.dart
        // history) — a stale `stag` value saved before that removal must
        // never silently resurrect it.
        _autonomousEnv = 'prod';
        api = ApiClient(config: config, session: session);
        _skippedDesktopUpdateVersion = _store.skippedDesktopUpdateVersion;
      }
      _startUpdateChecking();
      final environmentReady = await _prepareEnvironment();
      if (!environmentReady) return;
      await _continueAfterEnvironmentReady();
    } catch (error, stack) {
      debugPrint('bootstrap: fallback to login after error: $error\n$stack');
      currentUser = null;
      status = AppStatus.unauthenticated;
      notifyListeners();
    } finally {
      // A `finally` rather than a call per exit path: bootstrap resolves four
      // ways (environment not ready, signed out, signed in, thrown) and the
      // launch happened in all four. `retryEnvironmentSetup` re-enters here,
      // which is why the event itself is once-per-launch.
      _trackAppOpened();
    }
  }

  bool _appOpenedTracked = false;

  /// `app_opened`, once, with the answer bootstrap actually reached. Sent from
  /// here rather than from the first frame because `signed_in` is not known
  /// until the CLI has been asked, and a first-frame event would report every
  /// launch as signed out.
  void _trackAppOpened() {
    if (_appOpenedTracked) return;
    _appOpenedTracked = true;
    final signedIn = status == AppStatus.authenticated;
    analytics.appOpened(signedIn: signedIn);
    // A returning user is signed in before the app is even on screen, so their
    // wait starts here rather than at a sign-in that never happens.
    if (signedIn) _armFirstMessage('launch');
  }

  /// Runs before we invoke a single Harness subcommand. A fresh mac used to
  /// fail here with a generic Sign in error because `harness` and its Node
  /// runtime were absent; provisioning now makes that a visible, recoverable
  /// first-run phase instead.
  Future<bool> _prepareEnvironment() async {
    if (_environmentSetupInFlight) return false;
    _environmentSetupInFlight = true;
    status = AppStatus.checkingEnvironment;
    environmentReadiness = EnvironmentReadiness.initial();
    notifyListeners();
    try {
      // Always read-only here. Installation starts only after explicit confirmation in the wizard.
      final result = await _runProvisioner(install: false);
      if (!result.isReady) {
        status = AppStatus.preparingEnvironment;
        notifyListeners();
        return false;
      }
      _cancelEnvironmentRecheckTimer();
      return true;
    } finally {
      _environmentSetupInFlight = false;
    }
  }

  /// Shared with [_prepareEnvironment]: runs the provisioner, updates
  /// [environmentReadiness] as it streams progress, and reports the outcome.
  Future<EnvironmentReadiness> _runProvisioner({
    EnvironmentReadiness? resumeFrom,
    bool install = false,
    EnvironmentSetupMode? mode,
    bool quiet = false,
  }) async {
    final provisioner = environmentProvisioner ?? EnvironmentProvisioner();
    final result = await provisioner.ensureReady(
      onProgress: (value) {
        if (quiet &&
            value.phase != EnvironmentSetupPhase.ready &&
            value.phase != EnvironmentSetupPhase.failed) {
          // A 5-second Terminal poll must not repaint the wizard through
          // preflight -> review -> waiting. Keep the stable handoff surface
          // and only stream its diagnostics until there is a real terminal
          // outcome or installation can continue.
          environmentReadiness = environmentReadiness.copyWith(
            output: value.output,
            terminalLogPath: value.terminalLogPath,
            terminalResultPath: value.terminalResultPath,
            terminalSetup: value.terminalSetup,
            systemReady: value.systemReady,
          );
        } else {
          environmentReadiness = value;
        }
        // A successful probe belongs to the quiet pre-flight surface, never
        // the installation wizard. This also prevents the setup screen from
        // flashing its own ready phase for one frame after an install/recheck.
        if (value.isReady) status = AppStatus.checkingEnvironment;
        notifyListeners();
      },
      resumeFrom: resumeFrom,
      install: install,
      mode: mode,
    );
    environmentReadiness = result;
    if (!quiet ||
        result.isReady ||
        result.phase == EnvironmentSetupPhase.failed) {
      analytics.environmentPrepared(ready: result.isReady);
    }
    return result;
  }

  /// What `bootstrap()` does right after the environment is confirmed ready — pulled out so
  /// [recheckEnvironmentStep] can reach the same destination without repeating `bootstrap()`'s config
  /// load and update-check startup, which already ran on the launch that got stuck here.
  Future<void> _continueAfterEnvironmentReady() async {
    _cancelEnvironmentRecheckTimer();
    status = AppStatus.checkingEnvironment;
    notifyListeners();
    // Auth now lives entirely with the local `harness` CLI — it owns the SSO session on disk and
    // refreshes it itself. This app never reads, stores, or refreshes a token of its own; it just
    // asks the CLI whether this computer is currently signed in.
    try {
      final authStatus = await cliLogin.checkStatus();
      if (!authStatus.loggedIn) {
        currentUser = null;
        status = AppStatus.unauthenticated;
        notifyListeners();
        return;
      }
      status = AppStatus.bootstrapping;
      notifyListeners();
      await _finishBootstrapSignedIn();
    } catch (error, stack) {
      debugPrint(
        'continueAfterEnvironmentReady: fallback to login after error: '
        '$error\n$stack',
      );
      currentUser = null;
      status = AppStatus.unauthenticated;
      notifyListeners();
    }
  }

  void showEnvironmentReview() {
    environmentReadiness = environmentReadiness.copyWith(
      phase: EnvironmentSetupPhase.review,
    );
    notifyListeners();
  }

  void showEnvironmentMethodChoice() {
    environmentReadiness = environmentReadiness.copyWith(
      phase: EnvironmentSetupPhase.chooseMethod,
    );
    notifyListeners();
  }

  void selectEnvironmentSetupMode(EnvironmentSetupMode mode) {
    environmentReadiness = environmentReadiness.copyWith(mode: mode);
    notifyListeners();
  }

  Future<void> startEnvironmentSetup() async {
    if (_environmentSetupInFlight) return;
    _cancelEnvironmentRecheckTimer();
    final mode = environmentReadiness.mode ?? EnvironmentSetupMode.automatic;
    if (mode == EnvironmentSetupMode.manual) {
      notifyListeners();
      return;
    }
    _environmentSetupInFlight = true;
    notifyListeners();
    try {
      final result = await _runProvisioner(
        resumeFrom: environmentReadiness,
        install: true,
        mode: mode,
      );
      if (!result.isReady) {
        _scheduleEnvironmentRecheck();
        return;
      }
      await _continueAfterEnvironmentReady();
    } finally {
      _environmentSetupInFlight = false;
      notifyListeners();
    }
  }

  Future<void> continueAfterEnvironmentSetup() async {
    if (!environmentReadiness.isReady) return;
    await _continueAfterEnvironmentReady();
  }

  /// A manual repair always returns to a read-only probe.
  Future<void> retryEnvironmentSetup() async {
    if (_environmentSetupInFlight) return;
    _environmentSetupInFlight = true;
    notifyListeners();
    try {
      final result = await _runProvisioner(
        install: false,
        mode: environmentReadiness.mode,
      );
      if (result.isReady) await _continueAfterEnvironmentReady();
    } finally {
      _environmentSetupInFlight = false;
      notifyListeners();
    }
  }

  /// Rechecks a single stuck step (`failed`/`needsTerminal`) without re-running steps already
  /// `ready` — the user fixed it by hand (see `environment_step_guidance.dart`'s command) and this
  /// confirms it, then falls through to whatever step comes next, exactly like a fresh `bootstrap()`
  /// would have. [step] identifies which row's Recheck button was pressed; the provisioner itself
  /// decides what to (re-)attempt from the current [environmentReadiness], so an already-resolved
  /// step is never disturbed regardless of which row triggered this.
  Future<void> recheckEnvironmentStep(EnvironmentStep step) async {
    if (_environmentSetupInFlight) return;
    _cancelEnvironmentRecheckTimer();
    _environmentSetupInFlight = true;
    notifyListeners();
    try {
      final visibleBeforeProbe = environmentReadiness;
      final mode = environmentReadiness.mode;
      var result = await _runProvisioner(
        resumeFrom: environmentReadiness,
        install: false,
        mode: mode,
        quiet:
            mode == EnvironmentSetupMode.automatic &&
            environmentReadiness.phase ==
                EnvironmentSetupPhase.waitingForTerminal,
      );
      if (!result.isReady &&
          mode == EnvironmentSetupMode.automatic &&
          result.phase != EnvironmentSetupPhase.waitingForTerminal &&
          result.systemReady &&
          result.steps[EnvironmentStep.tmux] == EnvironmentStepStatus.ready &&
          (result.steps[EnvironmentStep.clipboard] ==
                  EnvironmentStepStatus.ready ||
              result.steps[EnvironmentStep.clipboard] ==
                  EnvironmentStepStatus.notApplicable)) {
        result = await _runProvisioner(
          resumeFrom: result,
          install: true,
          mode: mode,
        );
      }
      if (!result.isReady) {
        if (mode == EnvironmentSetupMode.automatic &&
            result.phase != EnvironmentSetupPhase.failed) {
          environmentReadiness = visibleBeforeProbe.copyWith(
            phase: EnvironmentSetupPhase.waitingForTerminal,
            output: result.output,
            terminalLogPath: result.terminalLogPath,
            terminalResultPath: result.terminalResultPath,
            terminalSetup: result.terminalSetup,
            systemReady: result.systemReady,
          );
        }
        _scheduleEnvironmentRecheck();
        return;
      }
      await _continueAfterEnvironmentReady();
    } catch (error, stack) {
      debugPrint(
        'recheckEnvironmentStep: fallback to login after error: $error\n$stack',
      );
      currentUser = null;
      status = AppStatus.unauthenticated;
    } finally {
      _environmentSetupInFlight = false;
      notifyListeners();
      _trackAppOpened();
    }
  }

  /// Polls the currently-stuck required step every 5s (see `_environmentRecheckTimer`'s doc) so
  /// fixing it in another window and forgetting to click Recheck still moves the app forward.
  /// A no-op unless automatic setup is waiting on the real Terminal window.
  void _scheduleEnvironmentRecheck() {
    _environmentRecheckTimer?.cancel();
    if (environmentReadiness.phase !=
            EnvironmentSetupPhase.waitingForTerminal ||
        environmentReadiness.mode != EnvironmentSetupMode.automatic) {
      return;
    }
    EnvironmentStep? stuck;
    for (final entry in environmentReadiness.steps.entries) {
      if (!entry.key.isRequired) continue;
      if (entry.value == EnvironmentStepStatus.needsTerminal ||
          entry.value == EnvironmentStepStatus.failed) {
        stuck = entry.key;
        break;
      }
    }
    if (stuck == null && environmentReadiness.terminalSetup == null) return;
    // Base system setup has no EnvironmentStep row of its own. The callback
    // argument is only a UI trigger; the provisioner rechecks the complete
    // environment and uses terminalSetup to attribute any failure.
    final step = stuck ?? EnvironmentStep.tmux;
    _environmentRecheckTimer = Timer(const Duration(seconds: 5), () {
      unawaited(recheckEnvironmentStep(step));
    });
  }

  void _cancelEnvironmentRecheckTimer() {
    _environmentRecheckTimer?.cancel();
    _environmentRecheckTimer = null;
  }

  void _bootstrapLocalManual(LocalManualFixture fixture) {
    _autonomousEnv = 'prod';
    config = AppConfig(apiBaseUrl: fixture.apiBaseUrl);
    api = ApiClient(config: config, session: session);
    currentUser = const CurrentUserProfile.local();
    final machine = Machine(
      machineId: fixture.machineId,
      apiKey: fixture.apiKey,
      authMode: MachineAuthMode.remote,
      name: fixture.machineName,
      status: 'online',
    );
    machines = [machine];
    machineStates
      ..clear()
      ..[machine.machineId] = MachineState(machine);
    machineStates[machine.machineId]!.nodeOnline = true;
    expandedMachines.clear();
    selectedMachineId = null;
    status = AppStatus.authenticated;
    _lastError = null;
    _ensurePool();
    _autoConnectAndLoadMachines();
    notifyListeners();
  }

  /// Both `bootstrap()` (already signed in) and `login()` (just finished signing in) land here once
  /// the CLI confirms a session exists — ensure the local daemon is actually up first (it does not
  /// start on its own, and every call below is a local-CLI-proxied request that needs it), then fetch
  /// the profile and load the machine list over it.
  Future<void> _finishBootstrapSignedIn() async {
    // Stays on the pre-navigation `bootstrapping` screen (main.dart) until the daemon is
    // confirmed reachable — flipping to `authenticated` any earlier is what let the home UI
    // race `harness start`'s own backend handshake and surface a bogus 30s "Could not load
    // machines" timeout. A daemon that never comes up still gets a home screen below, with
    // the failure shown there as before, since that's where the retry affordance lives.
    _bootStatusMessage = 'Starting local service…';
    notifyListeners();
    // Before the machines, deliberately: the tiles are intent, they render as
    // "waiting for that machine" on their own, and each attaches as its machine
    // answers. Waiting for the machine list first would leave the window empty
    // for as long as the slowest one takes, and would hand the first-run
    // auto-pick a window in which the grid still looks empty.
    await _restorePaneLayout();
    await dial.restore();
    _ensurePool();
    try {
      await ensureCliDaemonReady();
    } catch (error) {
      _bootStatusMessage = null;
      status = AppStatus.authenticated;
      _lastError = '$error';
      _lastErrorRetryable = true;
      notifyListeners();
      return;
    }
    _bootStatusMessage = null;
    // `ensureCliDaemonReady` may have signed the app out instead of succeeding (daemon absent AND
    // the saved session gone) — that already routed to the login screen, so don't clobber it.
    if (status == AppStatus.unauthenticated) return;
    status = AppStatus.authenticated;
    await _loadProfile();
    try {
      await refreshMachines();
    } catch (error) {
      _lastError = 'Could not load machines: $error';
      _lastErrorRetryable = true;
    }
    notifyListeners();
  }

  /// The local daemon (`harness start`) must be up before any local REST/WS call can work — unlike
  /// `harness login`, it does not start on its own. Sets [_cliEndpoint], the dial target every
  /// machine's WsConn now uses. Public (like [refreshMachines]) so a test subclass can stub it
  /// without shelling out to a real `harness` binary.
  /// Who is signed in, from the daemon. Shared by the boot path and by the
  /// retry path, because a boot that found the daemon still connecting now
  /// finishes THROUGH the retry path — and a session that never learns its
  /// own account has an empty footer and unattributed analytics.
  Future<void> _loadProfile() async {
    try {
      final me = await api.me();
      if (me != null) {
        final profile = CurrentUserProfile.fromMe(me);
        currentUser = profile;
        // Every event from here on is filed under the account, including ones
        // queued while this call was still in flight — the queue reads the
        // account per event, not per launch.
        analyticsAccount.set(id: profile.id, email: profile.email);
      }
    } catch (error) {
      debugPrint('bootstrap: profile unavailable: $error');
    }
  }

  Future<void> ensureCliDaemonReady() async {
    final discovery = _discovery;
    final probe = await discovery.ensureRunning();
    switch (probe.state) {
      case LocalCliProbeState.ready:
        _cliEndpoint = probe.endpoint;
        _daemonGateFailed = false;
      case LocalCliProbeState.notReady:
        _daemonGateFailed = true;
        // Running, not ready — most often a daemon fresh from a self-update still shaking hands
        // with the backend. Not "did not start": that sentence sends people to run `harness start`
        // against a daemon that is up, and the CLI's own lock will just tell them so. It keeps
        // retrying by itself; the supervisor below picks the app up the moment it gets there.
        _startDaemonSupervision(discovery);
        throw StateError(
          'Harness is running${probe.version == null ? '' : ' (v${probe.version})'} but has not '
          'connected to the backend yet — ${probe.reason}. It usually finishes on its own; '
          'retry in a moment.',
        );
      case LocalCliProbeState.down:
        _daemonGateFailed = true;
        // Before blaming the environment, check whether the daemon is missing because it signed itself
        // out. "Try running `harness start` yourself" is advice that cannot work in that case — the
        // session file is gone, so every start exits again — and it is the advice this branch used to
        // give unconditionally.
        if (!(await cliLogin.checkStatus()).loggedIn) {
          _signedOutAtRuntime(_signedOutMessage);
          return;
        }
        throw StateError(
          'The local Harness daemon did not start. Try running `harness start` yourself, then reopen the app.',
        );
    }
    _startDaemonSupervision(discovery);
  }

  /// Supervision starts once the daemon is at least ANSWERING — ready or still connecting. It used to
  /// wait for ready, out of fear of a concurrent `harness start` from both places; the supervisor
  /// no longer spawns while anything answers on the port, so that race is gone, and starting it on
  /// a not-ready daemon is what lets a boot that landed mid-update recover without a click.
  void _startDaemonSupervision(LocalCliDiscovery discovery) {
    _daemonSupervisionTimer ??= discovery.startSupervising(
      stillSignedIn: () async => (await cliLogin.checkStatus()).loggedIn,
      onSignedOut: () => _signedOutAtRuntime(_signedOutMessage),
      onReady: (endpoint) {
        // Back (or here for the first time). If the app is sitting on the error strip from a boot
        // or reload that found the daemon not ready, this is the moment it was waiting for.
        //
        // Gated on OUR failure, not on `_lastError`: that strip is shared with errors this cannot
        // fix (an agent that failed to launch, say), and the supervisor's first tick after every
        // boot would otherwise clear one of those five seconds after it appeared.
        if (_cliEndpoint == null || _daemonGateFailed) {
          _cliEndpoint ??= endpoint;
          unawaited(retryMachines());
        }
      },
    );
  }

  /// Deliberately says nothing about WHY. The daemon clears its session identically whether the
  /// machine was deleted from another machine or the SSO token simply expired, and guessing between
  /// them in the copy would sometimes be wrong. Signing in again is the answer to both.
  static const _signedOutMessage =
      'You were signed out on this computer. Sign in again to reconnect.';

  /// The session went away while the app was already running — send the user to [LoginScreen] with a
  /// reason, and stop the background work that can only fail from here.
  ///
  /// Cold start already handles this: [bootstrap] asks the CLI whether it is signed in. The hole this
  /// fills is the app that was ALREADY authenticated when the session disappeared underneath it,
  /// where nothing re-checked and the daemon supervisor simply respawned `harness start` forever.
  void _signedOutAtRuntime(String message) {
    if (status == AppStatus.unauthenticated) {
      return; // idempotent: several sources can race here
    }
    _daemonSupervisionTimer?.cancel();
    _daemonSupervisionTimer = null;
    _cliEndpoint = null;
    unawaited(_pool?.closeAll());
    _pool = null;
    _lastError = message;
    _lastErrorRetryable = true;
    status = AppStatus.unauthenticated;
    notifyListeners();
  }

  void _startUpdateChecking() {
    _updateCheckTimer ??= (desktopUpdater ?? DesktopUpdater()).startChecking(
      onUpdateAvailable: _handleBackgroundUpdate,
    );
  }

  void _handleBackgroundUpdate(UpdateInfo info) {
    if (_disposed) return;
    if (_skippedDesktopUpdateVersion == info.version) return;
    if (availableUpdate?.version == info.version) return;
    availableUpdate = info;
    updateError = null;
    notifyListeners();
  }

  /// A manual check deliberately returns a skipped version too, so the user
  /// can choose to install it from the account menu after changing their mind.
  Future<ManualUpdateCheck> checkForUpdates() async {
    if (isCheckingForUpdate) {
      return ManualUpdateCheck(update: availableUpdate);
    }
    isCheckingForUpdate = true;
    updateError = null;
    notifyListeners();
    try {
      final info = await (desktopUpdater ?? DesktopUpdater()).checkOnce();
      if (info == null) return const ManualUpdateCheck();
      final skipped = _skippedDesktopUpdateVersion == info.version;
      availableUpdate = info;
      return ManualUpdateCheck(update: info, isSkipped: skipped);
    } finally {
      isCheckingForUpdate = false;
      if (!_disposed) notifyListeners();
    }
  }

  /// Clears a failed install without burying the offer.
  ///
  /// Skipping is permanent — it records the version so the background check
  /// stops raising it. A failure is not a decision about the version, so the
  /// way out of one has to leave the update on the table.
  void dismissUpdateError() {
    if (updateError == null) return;
    updateError = null;
    notifyListeners();
  }

  Future<void> skipAvailableUpdate() async {
    final info = availableUpdate;
    if (info == null) return;
    _skippedDesktopUpdateVersion = info.version;
    await _store?.saveSkippedDesktopUpdateVersion(info.version);
    availableUpdate = null;
    updateError = null;
    notifyListeners();
  }

  /// Downloads, verifies, and installs only after an explicit user action.
  /// A failed operation leaves the running app untouched and retryable.
  Future<bool> installAvailableUpdate() async {
    final info = availableUpdate;
    if (info == null || isInstallingUpdate) return false;
    isInstallingUpdate = true;
    updateError = null;
    notifyListeners();
    try {
      final updater = desktopUpdater ?? DesktopUpdater();
      final staged = await updater.downloadAndStage(info);
      if (staged == null) {
        updateError = 'Could not download and verify Harness ${info.version}.';
        return false;
      }
      final applied = await updater.applyStaged(staged, selfPid: pid);
      if (!applied) {
        updateError =
            'This copy of Harness cannot install updates automatically.';
        return false;
      }
      exit(0);
    } catch (error) {
      updateError = 'Could not install Harness ${info.version}: $error';
      return false;
    } finally {
      isInstallingUpdate = false;
      if (!_disposed) notifyListeners();
    }
  }

  Future<void> login() async {
    _lastError = null;
    status = AppStatus.bootstrapping;
    signingIn = true;
    pendingAuthorizeUrl = null;
    notifyListeners();
    try {
      await cliLogin.login(
        onAuthorizeUrl: (url) {
          pendingAuthorizeUrl = url;
          notifyListeners();
          // Must be the system browser, not an embedded webview: this SSO page's Google button uses
          // Google's popup-based Identity Services flow (a real popup window posts the result back to
          // its opener), which only a real browser can satisfy.
          unawaited(
            launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication),
          );
        },
      );
      await _finishBootstrapSignedIn();
      analytics.signedIn();
      // Restarts the clock even if `_trackAppOpened` already started one: this
      // person met the login screen, so their wait begins where the launch's
      // did not.
      _armFirstMessage('sign_in');
    } catch (error) {
      status = AppStatus.unauthenticated;
      _lastError = error.toString();
      _lastErrorRetryable = true;
      // A short code, never `error.toString()` — a CLI failure carries paths
      // and host names, and this stream is not the place for them. Only the
      // two the TYPE can tell apart: a cancelled sign-in and a refused one both
      // arrive as a `StateError` differing in message text, and matching on
      // English sentences is how a stream starts lying after a copy edit.
      analytics.signInFailed(
        error is CliNotAvailableException ? 'cli_missing' : 'failed',
      );
    } finally {
      pendingAuthorizeUrl = null;
      // Cleared last, and only here: everything above may still be running when the URL goes, and
      // dropping the flag any earlier is what put a bare spinner over the user's own screen.
      signingIn = false;
    }
    notifyListeners();
  }

  /// Aborts an in-flight [login] — the embedded sign-in webview's close button calls this.
  void cancelLogin() => cliLogin.cancel();

  Future<void> logout() async {
    // Best-effort and fire-and-forget: local state is cleared below regardless of whether the CLI
    // process could be reached, but a real `harness logout` clears its saved session so the NEXT
    // launch doesn't silently sign back in without ever showing the login screen.
    unawaited(cliLogin.logout());
    _stopAllOfflineRetries();
    _stopAllLinkRetries();
    _stopAllAgentSyncTimers();
    // Tiles go, the saved layout stays: signing out and back in is the same
    // person at the same desk, and the file is only read once machines exist.
    await _closeAllPanes(persist: false);
    await _pool?.closeAll();
    _pool = null;
    _cliEndpoint = null;
    // Nothing to supervise for a signed-out app — and a daemon started by hand
    // on the login screen must not have its ready transition retry the machines.
    _daemonSupervisionTimer?.cancel();
    _daemonSupervisionTimer = null;
    _daemonGateFailed = false;
    _clearAllTurnActivity();
    currentUser = null;
    machines = [];
    machineStates.clear();
    expandedMachines.clear();
    selectedMachineId = null;
    status = AppStatus.unauthenticated;
    analytics.signedOut();
    // A session that ended without a message reports nothing — its absence IS
    // the finding, and a stale clock would attach that wait to whoever signs in
    // next.
    _awaitingFirstMessage = null;
    analyticsAccount.clear();
    notifyListeners();
  }

  void _onLocalFailure(String machineId, int code, String reason) {
    final machine = machineStates[machineId];
    if (machine == null || code != 4404) return;
    // The local CLI's relay found no linked trust for this machine — it now owns E2EE entirely.
    // A `harness link connect` run in a terminal (or another app instance) has no way to notify
    // this one directly, so poll every few seconds until it's picked up instead of waiting for
    // the user to click back into this machine.
    machine.needsLink = true;
    machine.agentLoadStatus = AgentLoadStatus.needsLink;
    // A 4404 can also arrive MID-SESSION ("peer revoked trust" in the CLI's
    // remoteRelay.ts) with terminals open on this machine. The disconnect
    // that follows deliberately no longer marks the node offline (see the
    // onStatus branch in _ensurePool), so the tiles have to be told here
    // instead — otherwise they keep rendering as live until a heartbeat
    // fails, and nothing records what to reattach once the machine is linked
    // again.
    _markSessionsUnreachable(
      machine,
      'This machine is no longer linked. Link it again to reconnect.',
    );
    notifyListeners();
    _startLinkRetry(machineId);
  }

  void _ensurePool() {
    if (_pool != null) return;
    _pool = WsPool(
      wsBaseUrl: config.wsBaseUrl,
      autonomousEnv: _autonomousEnv,
      // Every real WsConn now dials the local CLI's loopback WS (transportKind.localPlaintext, see
      // _conn()), which never calls this — only the compile-time-only local-manual dev fixture (see
      // LocalManualFixture) still dials a backend directly with a token.
      accessTokenProvider: (_, _) async {
        final fixture = localManualFixture;
        if (fixture != null) return fixture.apiKey;
        throw StateError(
          'unreachable: only the local-manual dev fixture uses a token-bearing WS transport',
        );
      },
      onAuthFailure: _signedOutAtRuntime,
      onLocalFailure: _onLocalFailure,
      onEvent: _handleEvent,
      onStatus: (machineId, nextStatus) {
        final machine = machineStates[machineId];
        if (machine == null) return;
        machine.connectionStatus = nextStatus;
        if (nextStatus == ConnectionStatus.connected) {
          machine.needsLink = false;
          _stopLinkRetry(machineId);
          // A daemon that just came up — first connect, or a reconnect after it
          // restarted — has never been told what is on the grid. Without this
          // the dial goes back to beeping about tiles in plain sight until the
          // next time a pane happens to change.
          _announceOpenPanesToDial();
          // ...nor which tile this window is looking at. The daemon repeats that to the dial after every
          // list push, which is what keeps the two screens from drifting apart — but it can only repeat
          // something it has been told, and until now the first telling waited for the focus to CHANGE.
          // A daemon restarted mid-session therefore had nothing to say, and a dial that re-anchored onto
          // the wrong tile stayed there.
          _announceFocusToDial();
          // The local CLI never hands back `connected` until it has terminated E2EE (or confirmed
          // none is needed, for its own machine) — every machine's data is ready to load right away,
          // with no separate app-side readiness gate to wait on anymore.
          if (machine.isLocalMachine) {
            machine.transportMode = MachineTransportMode.localPlaintext;
          } else {
            machine.transportMode = MachineTransportMode.cloudE2ee;
          }
          // Route through _applyNodeStatus (not just `machine.nodeOnline = true`) for every machine,
          // not only the local one — a successful select IS the machine being reachable again, and
          // this is what lets a pending agent (captured below on disconnect) reattach automatically
          // instead of leaving the user stuck on the empty "select a machine" placeholder.
          unawaited(_applyNodeStatus(machine, true));
          unawaited(_loadMachineData(machine, force: true));
          _startAgentSyncTimer(machineId);
        } else if (nextStatus == ConnectionStatus.reconnecting ||
            nextStatus == ConnectionStatus.disconnected) {
          _stopAgentSyncTimer(machineId);
          _clearMachineActivity(machine);
          if (machine.isLocalMachine) {
            machine.transportMode = MachineTransportMode.localOffline;
          }
          // Same reasoning as above, mirrored: capture pendingOfflineAgentId from the currently-open
          // terminal (if any) so the connected branch above can reattach it, for every machine — this
          // used to be local-only, which is why a remote machine's terminal never came back on its own
          // after `harness start` on that machine, even though the guide screen promised it would.
          //
          // NOT while the machine is unlinked. NO_PEER_LINK is the local CLI failing a lookup in its
          // own peer table (remoteRelay.ts `dial`) before anything is dialled, so neither that close
          // nor the one `_startLinkRetry`'s `closeMachine` fires every few seconds says anything about
          // whether the OTHER computer is up — our socket never reaches it. Forcing nodeOnline false
          // here overwrote the REST `/api/machines` status, the one signal that does, and painted
          // every unlinked machine as off. Keyed on the sticky flag rather than the 4404 close on
          // purpose: the retry loop's own close() lands as a plain `disconnected` too. needsLink is
          // set by onLocalFailure, which runs before this branch for 4404 (see WsConn._onDone).
          if (!machine.needsLink) {
            unawaited(_applyNodeStatus(machine, false));
          }
        }
        notifyListeners();
      },
    );
  }

  /// The machine list is being fetched and there is nothing to show meanwhile.
  ///
  /// Only the FIRST fetch sets it: a refresh over a list already on screen
  /// keeps that list up (the rows are still true, just not from a moment ago)
  /// and reports nothing. The rail reads this to tell "loading" from "no
  /// machines", which an empty list alone cannot say.
  bool machinesLoading = false;

  Future<void> refreshMachines() async {
    if (localManualFixture != null) {
      notifyListeners();
      return;
    }
    if (machines.isEmpty && !machinesLoading) {
      machinesLoading = true;
      notifyListeners();
    }
    try {
      await _refreshMachines();
    } finally {
      // Said out loud: the list's own notify fires before this, so a flag
      // dropped silently here would leave the rail on its placeholders.
      if (machinesLoading) {
        machinesLoading = false;
        notifyListeners();
      }
    }
  }

  Future<void> _refreshMachines() async {
    final discovery = _discovery;
    // The CLI computer id is the local identity source of truth. The loopback
    // status endpoint is trusted only when it advertises that same identity.
    final localComputerId = await discovery.computerId();
    final localFuture = discovery.discover(expectedComputerId: localComputerId);
    final list = await _fetchMachines();
    final localEndpoint = await localFuture;
    machines = list
        .where((machine) => machine.authMode == MachineAuthMode.remote)
        .toList();
    final visible = machines.map((machine) => machine.machineId).toSet();
    for (final entry in machineStates.entries) {
      if (!visible.contains(entry.key)) {
        _clearMachineActivity(entry.value);
        _stopOfflineRetry(entry.key);
        _stopLinkRetry(entry.key);
        _stopAgentSyncTimer(entry.key);
      }
    }
    machineStates.removeWhere((id, _) => !visible.contains(id));
    for (final machine in machines) {
      final state = machineStates.update(
        machine.machineId,
        (state) => state..machine = machine,
        ifAbsent: () => MachineState(machine),
      );
      state.localOnly =
          localComputerId != null &&
          _normalizeComputerId(machine.computerId) == localComputerId;
      if (state.localOnly && localEndpoint?.computerId == localComputerId) {
        state.localEndpoint = localEndpoint;
        if (state.connectionStatus == ConnectionStatus.connected) {
          state.transportMode = MachineTransportMode.localPlaintext;
        } else {
          state.transportMode = MachineTransportMode.localOffline;
        }
      } else if (state.localOnly) {
        // The token still identifies this as local, but the CLI is offline or
        // failed its identity/capability check. Never fall back to cloud E2EE.
        state.localEndpoint = null;
        state.transportMode = MachineTransportMode.localOffline;
        state.nodeOnline = false;
        _startOfflineRetry(state);
      } else {
        state.localEndpoint = null;
        state.transportMode = MachineTransportMode.cloudE2ee;
      }
      final reportedOnline = _nodeOnlineFromStatus(machine.status);
      if (!state.isLocalMachine &&
          reportedOnline != null &&
          (state.nodeOnline == null || state.nodeOnline != reportedOnline)) {
        unawaited(_applyNodeStatus(state, reportedOnline));
      }
    }
    _autoConnectAndLoadMachines();
    notifyListeners();
  }

  // The daemon reports `connected` only once its own backend socket is open, but
  // `/api/machines` is a separate REST leg (fresh token refresh + fetch) that can still stall
  // briefly right after that — a bounded retry absorbs that transient window without falling
  // back to the 30s Dio timeout. Never retries an `ApiException` (a real HTTP error response);
  // only a `DioException` (timeout/connection failure) is worth a second try.
  // Capped at 2 attempts, not 3: `receiveTimeout` is 30s, so every retried attempt can cost
  // another 30s on a genuine failure — one retry absorbs the transient window above without
  // tripling how long a truly broken backend takes to surface its error.
  Future<List<Machine>> _fetchMachines() => withRetry(
    api.machines,
    maxAttempts: 2,
    initialDelay: const Duration(milliseconds: 500),
    isRetryable: (error) => error is DioException,
  );

  void _startOfflineRetry(MachineState machine) {
    final machineId = machine.machine.machineId;
    if (machine.nodeOnline != false ||
        (!machine.isLocalMachine && machine.pendingOfflineAgentId == null)) {
      _stopOfflineRetry(machineId);
      return;
    }
    if (_offlineRetryTimers.containsKey(machineId)) return;
    _offlineRetryTimers[machineId] = Timer.periodic(
      offlineRetryInterval,
      (_) => unawaited(_pollOfflineMachine(machineId)),
    );
  }

  void _stopOfflineRetry(String machineId) {
    _offlineRetryTimers.remove(machineId)?.cancel();
  }

  void _startLinkRetry(String machineId) {
    if (_linkRetryTimers.containsKey(machineId)) return;
    _linkRetryTimers[machineId] = Timer.periodic(offlineRetryInterval, (_) {
      final state = machineStates[machineId];
      if (state == null || !state.needsLink) {
        _stopLinkRetry(machineId);
        return;
      }
      unawaited(_pool?.closeMachine(machineId));
      _connectMachine(state);
    });
  }

  void _stopLinkRetry(String machineId) {
    _linkRetryTimers.remove(machineId)?.cancel();
  }

  void _stopAllLinkRetries() {
    for (final timer in _linkRetryTimers.values) {
      timer.cancel();
    }
    _linkRetryTimers.clear();
  }

  void _stopAllOfflineRetries() {
    for (final timer in _offlineRetryTimers.values) {
      timer.cancel();
    }
    _offlineRetryTimers.clear();
    _offlinePollsInFlight.clear();
  }

  void _startAgentSyncTimer(String machineId) {
    if (_agentSyncTimers.containsKey(machineId)) return;
    _agentSyncTimers[machineId] = Timer.periodic(agentSyncInterval, (_) {
      final machine = machineStates[machineId];
      if (machine == null) {
        _stopAgentSyncTimer(machineId);
        return;
      }
      unawaited(_syncAgentsIfChanged(machine));
    });
  }

  void _stopAgentSyncTimer(String machineId) {
    _agentSyncTimers.remove(machineId)?.cancel();
  }

  void _stopAllAgentSyncTimers() {
    for (final timer in _agentSyncTimers.values) {
      timer.cancel();
    }
    _agentSyncTimers.clear();
  }

  /// Silent safety-net reconciliation, ticked every [agentSyncInterval] while a machine is connected.
  /// Only writes/notifies if the fetched list actually differs from what's already shown — a steady
  /// state where push events (agent_synced et al.) have kept everything in sync produces zero visible
  /// effect. Deliberately does not touch agentLoadStatus/agentsLoadError/notifyListeners on failure:
  /// a real connectivity problem is already surfaced by the push path and the existing offline
  /// detection in _performMachineDataLoad, and a quiet background tick should not fight either.
  Future<void> _syncAgentsIfChanged(MachineState machine) async {
    if (machine.connectionStatus != ConnectionStatus.connected) return;
    if (machine.agentsLoadInFlight != null) {
      return; // a real (foreground) load already owns this tick
    }
    final connection = _conn(machine.machine.machineId);
    try {
      final response = await connection.request(
        'agents_list',
        timeout: const Duration(seconds: 10),
      );
      final agents = (response['agents'] as List<dynamic>? ?? [])
          .map((item) => Agent.fromJson(item as Map<String, dynamic>))
          .toList();
      if (agentsEqual(machine.agents, agents)) return;
      _replaceAgents(machine, agents);
      notifyListeners();
    } catch (_) {
      // Silent by design — see doc comment above.
    }
  }

  /// Order-insensitive value equality for [Agent] lists — [Agent] has no operator== override, and a
  /// backend that returns the same agents in a different order must not register as "changed".
  ///
  /// ⚠️ Every field of [Agent] that the UI reads belongs here. This list is hand-maintained, and the
  /// cost of forgetting one is silent: the poll fetches the truth, compares it, decides nothing
  /// happened, and throws it away — so the field stays frozen at whatever it was for as long as the
  /// app runs. Add the field here in the same commit you add it to [Agent].
  @visibleForTesting
  static bool agentsEqual(List<Agent> a, List<Agent> b) {
    if (a.length != b.length) return false;
    final byId = {for (final agent in a) agent.id: agent};
    for (final agent in b) {
      final prev = byId[agent.id];
      if (prev == null ||
          prev.name != agent.name ||
          prev.sessionId != agent.sessionId ||
          prev.engine != agent.engine ||
          prev.engineDisplayName != agent.engineDisplayName ||
          prev.engineIconHint != agent.engineIconHint ||
          prev.codexHome != agent.codexHome ||
          prev.parentAgentId != agent.parentAgentId ||
          prev.status != agent.status ||
          prev.terminalAvailable != agent.terminalAvailable ||
          prev.terminalUnavailableReason != agent.terminalUnavailableReason) {
        return false;
      }
    }
    return true;
  }

  /// Public retry hook used by the offline join guide's "Retry now" action.
  Future<void> retryOfflineMachine(String machineId) =>
      _pollOfflineMachine(machineId);

  /// Runs `harness link connect <machineId> --stdin --json` (via [CliLink]) for a machine the
  /// relay reported `NO_PEER_LINK` for, then reconnects it. Returns null on success, or an error
  /// message to show inline. The app never sees the password's cryptographic use — this just
  /// pipes it to the CLI on stdin, the same as typing it at a terminal prompt would.
  Future<String?> connectWithPassword(
    String machineId,
    String password, {
    void Function(String stage)? onProgress,
  }) async {
    if (password.isEmpty) return 'Enter the remote password first';
    final result = await cliLink.connect(
      machineId,
      password,
      onProgress: onProgress,
      displayName: machineStates[machineId]?.machine.displayName,
    );
    if (result.error != null) return result.error;
    final targetId = result.linkedMachineId ?? machineId;
    final state = machineStates[targetId];
    if (state != null) {
      state.needsLink = false;
      state.agentLoadStatus = AgentLoadStatus.idle;
      notifyListeners();
      // The old WsConn closed itself permanently on NO_PEER_LINK — connFor() would otherwise see a
      // matching endpointKey and hand back that dead connection instead of dialing a fresh one.
      await _pool?.closeMachine(targetId);
      _connectMachine(state);
    }
    return null;
  }

  List<LinkedMachine> linkedMachines = [];
  bool linkedMachinesLoading = false;
  String? linkedMachinesError;

  /// Sets (or replaces) THIS machine's persistent remote password (`harness remote-password
  /// set --stdin --json`) — another machine later connects with `connectWithPassword` using the
  /// same password, no token copy/paste involved.
  Future<RemotePasswordSetResult> setRemotePassword(String password) =>
      cliLink.setRemotePassword(password);

  /// Queries THIS machine's remote-password state (`harness remote-password status --json`).
  Future<RemotePasswordStatus> remotePasswordStatus() =>
      cliLink.remotePasswordStatus();

  /// Clears THIS machine's remote password (`harness remote-password clear --json`). Returns null
  /// on success.
  Future<String?> clearRemotePassword() => cliLink.clearRemotePassword();

  /// Refreshes the "machines this one trusts" list (`harness link list`).
  Future<void> refreshLinkedMachines() async {
    linkedMachinesLoading = true;
    notifyListeners();
    final result = await cliLink.list();
    linkedMachinesLoading = false;
    linkedMachinesError = result.error;
    linkedMachines = result.machines;
    notifyListeners();
  }

  /// Removes a linked machine's trust pin, then refreshes the list. Returns null on success.
  Future<String?> unlinkMachine(String machineId) async {
    final error = await cliLink.unlink(machineId);
    if (error == null) await refreshLinkedMachines();
    return error;
  }

  Future<void> _pollOfflineMachine(String machineId) async {
    final machine = machineStates[machineId];
    if (machine == null ||
        machine.nodeOnline != false ||
        (!machine.isLocalMachine && machine.pendingOfflineAgentId == null) ||
        _offlinePollsInFlight.contains(machineId)) {
      return;
    }
    _offlinePollsInFlight.add(machineId);
    try {
      if (machine.isLocalMachine) {
        final discovery = _discovery;
        final localComputerId = await discovery.computerId();
        if (localComputerId == null ||
            _normalizeComputerId(machine.machine.computerId) !=
                localComputerId) {
          return;
        }
        final endpoint = await discovery.discover(
          expectedComputerId: localComputerId,
        );
        if (endpoint == null || endpoint.computerId != localComputerId) return;
        machine.localEndpoint = endpoint;
        machine.localOnly = true;
        machine.transportMode = MachineTransportMode.localPlaintext;
        machine.nodeOnline = true;
        _connectMachine(machine);
        await _loadMachineData(machine, force: true);
        final pending = machine.pendingOfflineAgentId;
        if (pending != null) unawaited(_recoverPendingAgent(machine, pending));
        return;
      }
      final latest = (await _fetchMachines()).where(
        (item) => item.machineId == machineId,
      );
      if (latest.isEmpty) return;
      final reportedOnline = _nodeOnlineFromStatus(latest.first.status);
      if (reportedOnline == null) return;
      machine.machine = latest.first;
      await _applyNodeStatus(machine, reportedOnline);
    } catch (error) {
      debugPrint('offline node retry failed: $machineId: $error');
    } finally {
      _offlinePollsInFlight.remove(machineId);
    }
  }

  /// Open only the machine data sockets after discovery. Terminal panes remain
  /// lazy and are attached only when the user selects an agent row.
  void _autoConnectAndLoadMachines() {
    final visible = machines.map((machine) => machine.machineId).toSet();
    expandedMachines
      ..removeWhere((machineId) => !visible.contains(machineId))
      ..addAll(visible);
    if (machines.isEmpty) {
      selectedMachineId = null;
      return;
    }
    if (!visible.contains(selectedMachineId)) {
      // This computer, when it is one of them. The backend's order is its own
      // business and the local machine is not reliably first in it — landing on
      // someone else's box is a poor default when the user's own is right there.
      selectedMachineId = machines
          .firstWhere(
            (machine) =>
                machineStates[machine.machineId]?.isLocalMachine == true,
            orElse: () => machines.first,
          )
          .machineId;
    }
    for (final machine in machines) {
      _connectMachine(machineStates[machine.machineId]!);
      unawaited(_loadMachineData(machineStates[machine.machineId]!));
    }
  }

  /// A user-triggered reload is in flight.
  ///
  /// Read by the rail's reload button, which spins its glyph and stops taking
  /// clicks while this is true. It is deliberately NOT [machinesLoading]: that
  /// one means "there is nothing on screen yet", and a refresh over a list
  /// already up leaves it false on purpose.
  bool get machinesRefreshing => _retryInFlight != null;

  /// The run itself, so a second press joins the first instead of starting a
  /// second `GET /api/machines` beside it. The button's disabled state makes
  /// this hard to reach by pointer, but ⌘R has no such guard, and neither has
  /// the error strip's own retry.
  Future<void>? _retryInFlight;

  Future<void> retryMachines() {
    final inFlight = _retryInFlight;
    if (inFlight != null) return inFlight;
    late final Future<void> run;
    run = _performRetryMachines().whenComplete(() {
      if (identical(_retryInFlight, run)) {
        _retryInFlight = null;
        notifyListeners();
      }
    });
    _retryInFlight = run;
    notifyListeners();
    return run;
  }

  Future<void> _performRetryMachines() async {
    // Re-verify the daemon first: a retry that skips straight to `refreshMachines()` can hit
    // the exact same "daemon not connected yet" timeout the button was pressed to escape.
    try {
      await ensureCliDaemonReady();
    } catch (error) {
      _lastError = '$error';
      _lastErrorRetryable = true;
      notifyListeners();
      return;
    }
    if (status == AppStatus.unauthenticated) return;
    if (currentUser == null) await _loadProfile();
    try {
      await refreshMachines();
      _lastError = null;
    } catch (error) {
      _lastError = 'Could not load machines: $error';
      _lastErrorRetryable = true;
      notifyListeners();
      return;
    }
    await Future.wait(expandedMachines.toList().map(reloadMachineData));
    notifyListeners();
  }

  void toggleExpand(String machineId) {
    if (expandedMachines.contains(machineId)) {
      expandedMachines.remove(machineId);
    } else {
      expandedMachines.add(machineId);
      selectedMachineId = machineId;
      final machine = machineStates[machineId];
      if (machine != null) {
        _connectMachine(machine);
        unawaited(_loadMachineData(machine));
      }
    }
    notifyListeners();
  }

  /// Selects a machine without toggling its tree. Setup/status rows use this
  /// action so clicking an E2EE prompt always opens that machine's setup pane.
  Future<void> selectMachineForSetup(String machineId) async {
    final machine = machineStates[machineId];
    if (machine == null) return;
    _dismissedLinkPrompts.remove(machineId);
    selectedMachineId = machineId;
    expandedMachines.add(machineId);
    // Nothing is torn down here any more. That line existed because the content
    // area was one terminal belonging to whichever machine was selected, so
    // browsing to a second machine's setup form would otherwise have left the
    // first machine's terminal rendering underneath it. Tiles now say what they
    // are on their own and outlive the rail's selection, which makes selecting
    // a machine navigation again — and closing someone's running terminals
    // because they clicked a row would be the surprise, not the fix.
    //
    // The form itself arrives as a tile, which is the only way it can arrive at
    // all: a machine that needs linking has no agents to open.
    showMachinePane(machineId);
    _connectMachine(machine);
    notifyListeners();
  }

  void _connectMachine(MachineState machine) {
    // connFor() starts a new socket and reports `connecting` through onStatus,
    // or returns the existing socket with its current status intact. Do not
    // overwrite an already-connected socket when the user collapses and
    // re-expands the machine row; doing so leaves the UI permanently yellow
    // and disables every agent even though the transport is still ready.
    if (_pool != null &&
        (!machine.isLocalMachine || machine.usesLocalTransport)) {
      _conn(machine.machine.machineId);
    }
  }

  WsConn _conn(String machineId) {
    // The local-manual dev fixture exercises a locally-run backend+node stack directly (no real
    // `harness` CLI involved) — keep it on the old direct-cloud dial. Every other (real) machine now
    // goes through the local CLI daemon regardless of whether it's this computer's own machine or a
    // relayed one: the CLI proxies foreign machines to backend transparently (see `remoteRelay.ts` in
    // the harness CLI repo), so this app never dials backend's WS directly anymore.
    final connection = localManualFixture != null
        ? _pool!.connFor(machineId, transportKind: WsTransportKind.cloudE2ee)
        : _pool!.connFor(
            machineId,
            transportKind: WsTransportKind.localPlaintext,
            localWsUri: _cliEndpoint?.wsUri,
            localProtocolVersion:
                _cliEndpoint?.protocolVersion ?? localWsProtocolVersion,
          );
    _wireConnectionHooks(connection, machineId);
    return connection;
  }

  // Every machine — this computer's own, or a relayed one — now speaks the same plaintext local wire
  // protocol to the CLI (which terminates E2EE itself for relayed machines; see remoteRelay.ts in the
  // harness CLI repo). There is no per-machine branching left here at all.
  //
  // Known gap: LocalManualFixture (main_local_manual.dart, a compile-time-gated dev entry point that
  // exercises a locally-run backend+machine-node stack without SSO) used to run its OWN simulated E2EE
  // handshake against that local stack. That simulation depended on the crypto this app no longer
  // carries — the fixture now sends/receives plaintext-local-framed terminal data like every other
  // machine, which needs the target local machine-node to also expect plaintext for the fixture to
  // keep working end-to-end. Fixing that (if still desired) is a machine-node-side change, out of
  // scope here.
  void _wireConnectionHooks(WsConn connection, String machineId) {
    connection.onBinaryFrame = (frame) =>
        _handleTerminalBinary(machineId, frame);
  }

  /// Bulk terminal data for a machine, which may now be feeding several tiles.
  ///
  /// Offered to EVERY tile on that machine rather than routed by this side:
  /// each session already drops a frame whose `streamId` is not its own, and
  /// that check is the authority on which stream a frame belongs to. Choosing
  /// here instead would mean keeping a second copy of that mapping in sync with
  /// the first, and the copy that drifts is the one nobody is looking at.
  Future<void> _handleTerminalBinary(String machineId, Uint8List raw) async {
    final targets = panesFor(machineId)
        .map((pane) => pane.session)
        .whereType<TerminalSession>()
        .toList();
    if (targets.isEmpty) return;
    final clear = decodeTerminalLocal(raw);
    if (clear == null) {
      // Undecodable says the transport is wrong, not that one stream is — so
      // it goes to all of them.
      for (final terminal in targets) {
        terminal.transportLost('Binary terminal frame could not be decoded');
      }
      return;
    }
    for (final terminal in targets) {
      await terminal.handleBinary(clear);
    }
  }

  Future<bool> _sendTerminalBinary(
    String machineId,
    TerminalBinaryFrame frame,
  ) async {
    final encoded = encodeTerminalLocal(frame);
    if (encoded == null) return false;
    return _conn(machineId).sendTerminalBinary(encoded);
  }

  Future<void> _loadMachineData(
    MachineState machine, {
    bool force = false,
  }) async {
    if (machine.agentLoadStatus == AgentLoadStatus.loaded && !force) return;
    if (machine.isLocalMachine && !machine.usesLocalTransport) {
      machine.transportMode = MachineTransportMode.localOffline;
      machine.nodeOnline = false;
      machine.agentsRefreshing = false;
      machine.agentsLoadError = 'Harness is offline — run harness login';
      machine.agentLoadStatus = machine.agents.isEmpty
          ? AgentLoadStatus.error
          : AgentLoadStatus.loaded;
      notifyListeners();
      return;
    }
    final inFlight = machine.agentsLoadInFlight;
    if (inFlight != null) return inFlight;
    late final Future<void> load;
    load = _performMachineDataLoad(machine).whenComplete(() {
      if (identical(machine.agentsLoadInFlight, load)) {
        machine.agentsLoadInFlight = null;
      }
    });
    machine.agentsLoadInFlight = load;
    return load;
  }

  Future<void> _performMachineDataLoad(MachineState machine) async {
    final hadAgents = machine.agents.isNotEmpty;
    machine.agentsRefreshing = hadAgents;
    if (!hadAgents) machine.agentLoadStatus = AgentLoadStatus.loading;
    machine.agentsLoadError = null;
    notifyListeners();
    final connection = _conn(machine.machine.machineId);
    debugPrint('agents_list start: ${machine.machine.machineId}');
    try {
      final response = await connection.request(
        'agents_list',
        timeout: const Duration(seconds: 10),
      );
      final agents = (response['agents'] as List<dynamic>? ?? [])
          .map((item) => Agent.fromJson(item as Map<String, dynamic>))
          .toList();
      _replaceAgents(machine, agents);
      machine.agentLoadStatus = AgentLoadStatus.loaded;
      machine.agentsRefreshing = false;
      machine.agentsLoadError = null;
      debugPrint(
        'agents_list success: ${machine.machine.machineId} '
        '(${machine.agents.length} agents)',
      );
      await _loadTerminalCapabilities(machine, connection);
    } catch (error) {
      machine.agentsRefreshing = false;
      // A request timing out while the local relay session still nominally reports "connected" means
      // the remote node itself has stopped answering — exactly what a REST-status flip to offline
      // means elsewhere, so route it through _applyNodeStatus (not just `nodeOnline = false`) so the
      // pending agent gets captured for auto-reattach, same as any other offline detection path.
      if (error is WsRequestTimeout) {
        machine.agentsLoadError = machine.isLocalMachine
            ? 'Harness is offline — run harness login'
            : 'Harness is offline — run harness start on that machine';
        if (machine.nodeOnline != false) {
          unawaited(_applyNodeStatus(machine, false));
        }
        if (!machine.isLocalMachine) {
          // The relay's cached upstream session can go stale at the E2EE-session layer without the
          // underlying transport ever closing — most commonly the relayed machine's own Harness
          // process restarting, which drops its in-memory session state but doesn't touch the socket.
          // Nothing else would ever notice, so force a fresh dial rather than let every future retry
          // keep timing out against the same dead session.
          unawaited(connection.forceReconnect());
        }
      } else {
        machine.agentsLoadError = 'Could not load agents: $error';
      }
      // A NO_PEER_LINK close already set needsLink (via onLocalFailure) perhaps a microtask before
      // this catch runs — don't downgrade that specific, actionable state back to a generic error.
      if (!hadAgents && machine.agentLoadStatus != AgentLoadStatus.needsLink) {
        machine.agentLoadStatus = AgentLoadStatus.error;
      }
      debugPrint('agents_list failed: ${machine.machine.machineId}: $error');
    }
    // Order matters: a restored tile for THIS machine claims its agent before
    // the first-run convenience gets to look, so the two can never both open.
    _attachPendingPanes(machine);
    _autoPickFirstAgent();
    notifyListeners();
  }

  /// Whether the app has already opened a terminal on its own.
  ///
  /// Once, at startup, and never again: a later refresh must not reopen a
  /// terminal the user deliberately closed, and a machine that reconnects
  /// mid-session must not yank the pane away from whatever they are watching.
  bool _autoPickedAgent = false;

  /// Open the first agent on this computer, so the app arrives at work instead
  /// of at an instruction.
  ///
  /// "Select a machine, then an agent terminal" is a correct sentence and a
  /// poor first screen: in the ordinary case — one computer, agents already
  /// running on it — there is exactly one thing the user was going to click.
  ///
  /// Runs after a machine's data load rather than after the machine list,
  /// because [selectAgent] refuses on three counts that are only settled by
  /// then: the agent must exist, it must have a tmux terminal, and the
  /// machine's terminal protocol must have been negotiated. Called on every
  /// load and guarded, rather than wired to one specific load, because which
  /// machine answers first is not something this side decides.
  void _autoPickFirstAgent() {
    if (_autoPickedAgent || panes.isNotEmpty) return;

    // This computer first. A remote machine may well answer sooner, and
    // opening a terminal on someone else's box because its list arrived first
    // is a surprise, not a convenience.
    MachineState? target;
    for (final state in machineStates.values) {
      if (state.isLocalMachine) {
        target = state;
        break;
      }
    }
    target ??= machineStates.length == 1 ? machineStates.values.first : null;
    if (target == null) return;
    if (target.nodeOnline == false) return;
    if (!target.terminalCapabilityAvailable) return;

    for (final agent in target.agents) {
      if (!agent.terminalAvailable) continue;
      _autoPickedAgent = true;
      unawaited(selectAgent(target.machine.machineId, agent.id));
      return;
    }
  }

  /// Ask a machine which engines it has.
  ///
  /// Called when the New Agent dialog opens, not at connect: the answer costs
  /// one interactive shell per engine on the far side, and it is only ever
  /// looked at in that dialog.
  ///
  /// That caller passes [force], and should: engines come and go through a
  /// terminal this app never sees, and an install the dialog itself started
  /// invalidates the stored answer as it finishes. Without it the app probes
  /// once per run and then insists, for the rest of the session, on what was
  /// true when it started. The cache is here to collapse a re-open into one
  /// sweep, not to spare the machine the question.
  ///
  /// Deduplicated on [MachineEngines.inFlight] so opening the dialog twice, or
  /// reopening it mid-probe, does not start a second sweep. Never throws — a
  /// machine that cannot answer leaves every engine unknown, and unknown is
  /// rendered as the dialog behaved before this existed.
  Future<void> probeEngines(String machineId, {bool force = false}) {
    final machine = machineStates[machineId];
    if (machine == null) return Future.value();
    final existing = machine.engines.inFlight;
    if (existing != null) return existing;
    if (machine.engines.loaded && !force) return Future.value();
    final work = _probeEngines(machine);
    machine.engines.inFlight = work;
    notifyListeners();
    return work;
  }

  Future<void> _probeEngines(MachineState machine) async {
    try {
      final result = await _conn(machine.machine.machineId).request(
        'engines_probe',
        // The engine list travels so a machine only pays for what the dialog
        // shows. An older CLI that does not know this request answers with an
        // error, which lands in the catch below as "unknown" — never as a wrong
        // "not installed", because a CLI predating the feature would otherwise
        // report every engine missing and offer to install the ones already
        // there.
        payload: {'engines': allEngines.map((e) => e.id).toList()},
        timeout: const Duration(seconds: 30),
      );
      final raw = result['engines'];
      if (raw is! List) throw const FormatException('engines_probe: no list');
      machine.engines.replace(
        raw.map(EngineAvailability.fromJson).whereType<EngineAvailability>(),
      );
    } catch (error) {
      // A CLI that predates `engines_probe` refuses it by code; `detail` already
      // reads as a sentence when the peer sends one, so prefer it verbatim.
      machine.engines.error = error is WsRequestFailure
          ? (error.detail?.isNotEmpty == true ? error.detail : error.code)
          : 'This machine could not report its engines';
    } finally {
      machine.engines.inFlight = null;
      notifyListeners();
    }
  }

  Future<void> _loadTerminalCapabilities(
    MachineState machine,
    WsConn connection,
  ) async {
    try {
      final result = await connection.request(
        'terminal_capabilities',
        payload: {'protocolVersion': TerminalSession.protocolVersion},
        timeout: const Duration(seconds: 8),
      );
      machine.terminalCapabilityLoaded = true;
      machine.terminalCapabilityAvailable =
          result['protocolVersion'] == TerminalSession.protocolVersion &&
          result['backend'] == 'tmux' &&
          result['available'] == true;
      machine.terminalCapabilityError = machine.terminalCapabilityAvailable
          ? null
          : 'tmux terminal streaming is unavailable';
      final features = result['features'];
      machine.terminalPasteRawAvailable =
          features is Map && features['pasteRaw'] == true;
      machine.terminalImagePasteAvailable =
          features is Map && features['imagePaste'] == true;
      machine.terminalPasteFileAvailable =
          features is Map && features['pasteFile'] == true;
      machine.mediaPreviewAvailable =
          features is Map && features['mediaPreview'] == true;
    } catch (_) {
      machine.terminalCapabilityLoaded = true;
      machine.terminalCapabilityAvailable = false;
      machine.terminalCapabilityError = 'Could not negotiate terminal protocol';
      machine.terminalPasteRawAvailable = false;
      machine.terminalImagePasteAvailable = false;
      machine.terminalPasteFileAvailable = false;
      machine.mediaPreviewAvailable = false;
    }
  }

  void _replaceAgents(MachineState machine, List<Agent> agents) {
    final nextIds = agents.map((agent) => agent.id).toSet();
    for (final agentId in machine.processingAgentIds.difference(nextIds)) {
      _cancelTurnActivity(machine.machine.machineId, agentId);
    }
    machine.agents = agents;
    final pending = machine.pendingOfflineAgentId;
    if (pending != null && !nextIds.contains(pending)) {
      machine.pendingOfflineAgentId = null;
      _stopOfflineRetry(machine.machine.machineId);
    }
    if (machine.activeAgentId != null &&
        !nextIds.contains(machine.activeAgentId) &&
        panesFor(machine.machine.machineId).isEmpty) {
      machine.activeAgentId = null;
    }
    machine.processingAgentIds.removeWhere((id) => !nextIds.contains(id));
    machine.sessionAgentIds.clear();
    for (final agent in agents) {
      final sessionId = agent.sessionId;
      if (sessionId != null) machine.sessionAgentIds[sessionId] = agent.id;
    }
    for (final sessionId in machine.pendingProcessingSessions.toList()) {
      final agentId = machine.sessionAgentIds[sessionId];
      if (agentId == null) continue;
      machine.pendingProcessingSessions.remove(sessionId);
      _markAgentProcessing(machine, agentId);
    }
  }

  void _upsertAgent(MachineState machine, Agent agent) {
    final index = machine.agents.indexWhere((item) => item.id == agent.id);
    final previous = index == -1 ? null : machine.agents[index];
    if (index == -1) {
      machine.agents = [...machine.agents, agent];
    } else {
      machine.agents = [...machine.agents]..[index] = agent;
    }
    machine.sessionAgentIds.removeWhere((_, id) => id == agent.id);
    final sessionId = agent.sessionId;
    if (sessionId != null) {
      machine.sessionAgentIds[sessionId] = agent.id;
      if (machine.pendingProcessingSessions.remove(sessionId)) {
        _markAgentProcessing(machine, agent.id);
      }
    }
    machine.agentLoadStatus = AgentLoadStatus.loaded;
    machine.agentsLoadError = null;
    if (agent.launchState == 'failed' && previous?.launchState != 'failed') {
      _lastError = agent.launchDetail ?? 'Failed to start ${agent.name}';
      // The launch already ran and failed (e.g. the engine's automatic
      // install failed) — reloading the machine list will not install it.
      _lastErrorRetryable = false;
    }
  }

  void _renameAgent(MachineState machine, String agentId, String name) {
    final index = machine.agents.indexWhere((agent) => agent.id == agentId);
    if (index == -1 || name.trim().isEmpty) return;
    final cleanName = name.trim();
    machine.agents = [...machine.agents]
      ..[index] = machine.agents[index].copyWith(name: cleanName);
    for (final pane in panesFor(machine.machine.machineId)) {
      if (pane.agentId != agentId) continue;
      pane.session?.renameAgent(cleanName);
    }
  }

  Future<void> _removeAgent(MachineState machine, String agentId) async {
    machine.agents = machine.agents
        .where((agent) => agent.id != agentId)
        .toList();
    machine.sessionAgentIds.removeWhere((_, id) => id == agentId);
    _cancelTurnActivity(machine.machine.machineId, agentId);
    if (machine.activeAgentId == agentId) machine.activeAgentId = null;
    if (machine.pendingOfflineAgentId == agentId) {
      machine.pendingOfflineAgentId = null;
      _stopOfflineRetry(machine.machine.machineId);
    }
    // Every tile showing it, not just the focused one — and without
    // `terminal_close`, which would be addressed to an agent the machine has
    // already destroyed.
    final machineId = machine.machine.machineId;
    for (final pane in panes.toList()) {
      if (pane.machineId != machineId || pane.agentId != agentId) continue;
      await _detachSession(pane, sendClose: false);
      panes.remove(pane);
      if (focusedPaneId == pane.id) {
        focusedPaneId = panes.isEmpty ? null : panes.first.id;
      }
    }
    _persistLayout();
  }

  String? _eventAgentId(
    MachineState machine,
    Map<String, dynamic> event,
    Map<String, dynamic> payload,
  ) {
    final explicit = payload['agentId'] ?? event['agentId'];
    if (explicit is String && explicit.isNotEmpty) return explicit;
    final session = payload['sessionId'] ?? event['dbSessionId'];
    if (session is! String || session.isEmpty) return null;
    return machine.sessionAgentIds[session];
  }

  String? _eventSessionId(
    Map<String, dynamic> event,
    Map<String, dynamic> payload,
  ) {
    final session = payload['sessionId'] ?? event['dbSessionId'];
    return session is String && session.isNotEmpty ? session : null;
  }

  /// Starts the clock `app_first_message` measures. [from] is `sign_in` for a
  /// fresh log-in and `launch` for an app opened with a session already there.
  ///
  /// One body, called by both routes and by the test seam below — a second
  /// place building this record is a second place to get it wrong.
  void _armFirstMessage(String from) =>
      _awaitingFirstMessage = (at: DateTime.now(), from: from);

  /// Closes that clock out, once.
  ///
  /// A one-shot latch rather than a counter: the record is read and cleared in
  /// the same breath, so every turn after the first finds nothing and there is
  /// never a "which message is this" to get wrong.
  ///
  /// ⚠️ Called from `turn_started` ONLY, never from the other two routes into
  /// [_markAgentProcessing]. A `turn_heartbeat`, and an adopted agent found
  /// already mid-turn when this app connected, are both work that was under way
  /// before anybody here typed anything — counting either would report a
  /// near-zero wait for a returning user who has not said a word.
  void _reportFirstMessage() {
    if (_awaitingFirstMessage case final login?) {
      _awaitingFirstMessage = null;
      analytics.appFirstMessage(
        from: login.from,
        secondsSinceLogin: DateTime.now().difference(login.at).inSeconds,
      );
    }
  }

  /// [_armFirstMessage], for a test: signing in needs a live CLI, and what is
  /// worth pinning is what the first turn AFTER it does.
  @visibleForTesting
  void armFirstMessageForTest(String from) => _armFirstMessage(from);

  String _turnActivityKey(String machineId, String agentId) =>
      '$machineId\u0000$agentId';

  void _markAgentProcessing(MachineState machine, String agentId) {
    machine.processingAgentIds.add(agentId);
    final key = _turnActivityKey(machine.machine.machineId, agentId);
    _turnActivityWatchdogs.remove(key)?.cancel();
    _turnActivityWatchdogs[key] = Timer(turnActivityTimeout, () {
      _turnActivityWatchdogs.remove(key);
      // Closed even when the machine has been replaced under us: this path is
      // the only end a stalled turn ever gets, and a stats turn left open would
      // sit there until quit and then bank every hour since as work.
      harnessStats.onTurnEnded(key);
      final current = machineStates[machine.machine.machineId];
      if (!identical(current, machine)) return;
      if (machine.processingAgentIds.remove(agentId)) notifyListeners();
    });
  }

  /// Whether this agent is mid-turn, by the app's own reckoning.
  ///
  /// Fed by `turn_started`/`turn_heartbeat`/`turn_ended` and by the same watchdog that clears a
  /// stalled turn, so it answers what the tiles already draw rather than a second opinion.
  ///
  /// Read by the model menu, which disables itself for exactly the agents the CLI would refuse with
  /// AGENT_BUSY. It is deliberately NOT authoritative: only the CLI inspects the pane, and a turn
  /// can begin between a build and a tap. This spares the user the round trip in the common case;
  /// the refusal remains the thing that guarantees no turn is lost.
  bool agentIsProcessing(String machineId, String agentId) =>
      machineStates[machineId]?.processingAgentIds.contains(agentId) ?? false;

  // ── blocked agents ────────────────────────────────────────────────────────

  /// The question this agent stopped on, if it is waiting for one.
  ///
  /// Read by the tile, which rings itself while its agent is blocked. That ring
  /// is the whole surface: an agent asking something is a fact about the pane
  /// you are looking at, not a queue to be worked through somewhere else.
  PendingQuestion? questionFor(String machineId, String agentId) =>
      machineStates[machineId]?.blockedAgents[agentId];

  void _cancelTurnActivity(String machineId, String agentId) {
    final key = _turnActivityKey(machineId, agentId);
    _turnActivityWatchdogs.remove(key)?.cancel();
    // Every ordinary end of a turn comes through here — `turn_ended`, a
    // disconnect, a deleted agent — so this is where the clock stops. An end for
    // a turn this process never saw start contributes nothing (see
    // `HarnessStats.onTurnEnded`), which is what makes the disconnect sweep safe.
    harnessStats.onTurnEnded(key);
    final machine = machineStates[machineId];
    machine?.processingAgentIds.remove(agentId);
    // A question cannot outlive its own turn — the daemon's watcher says the
    // same thing from the other end, tearing down and announcing a close when
    // the turn ends. Clearing here as well means the row cannot survive a close
    // frame that was dropped, and this is also the path a deleted agent takes.
    machine?.blockedAgents.remove(agentId);
  }

  void _clearMachineActivity(MachineState machine) {
    for (final agentId in machine.processingAgentIds.toList()) {
      _cancelTurnActivity(machine.machine.machineId, agentId);
    }
    machine.processingAgentIds.clear();
    machine.pendingProcessingSessions.clear();
    machine.blockedAgents.clear();
  }

  void _clearAllTurnActivity() {
    for (final timer in _turnActivityWatchdogs.values) {
      timer.cancel();
    }
    _turnActivityWatchdogs.clear();
    for (final machine in machineStates.values) {
      machine.processingAgentIds.clear();
      machine.pendingProcessingSessions.clear();
      machine.blockedAgents.clear();
    }
  }

  Future<void> reloadMachineData(String machineId) async {
    final machine = machineStates[machineId];
    if (machine == null) return;
    _connectMachine(machine);
    await _loadMachineData(machine, force: true);
  }

  /// What every connected REMOTE machine's agent accounts have spent, asked in
  /// parallel and read there with that machine's own credentials (`usage_read`).
  ///
  /// This computer's own accounts are not asked here — the app reads those
  /// directly, the Keychain included. A remote machine may be signed in to a
  /// different subscription, and a rate limit belongs to an account rather than
  /// a computer, so the only honest way to show that one is to ask the machine
  /// that holds it.
  ///
  /// ⚠️ **A machine whose CLI predates `usage_read` does not refuse it — it goes
  /// silent.** The frame reaches it as an E2EE envelope it does not know to
  /// open, so the requestId inside is never read and nothing replies. That is a
  /// timeout, not an `UNSUPPORTED`, which is why this asks with a short one and
  /// treats every failure alike: a machine that cannot say has nothing to add,
  /// and it must never hold up the figures of the ones that can.
  Future<List<MachineUsage>> readRemoteUsage() async {
    final remotes = [
      for (final machine in machineStates.values)
        if (!machine.isLocalMachine &&
            machine.connectionStatus == ConnectionStatus.connected)
          machine,
    ];
    final answers = await Future.wait([
      for (final machine in remotes) _readMachineUsage(machine),
    ]);
    return [for (final answer in answers) ?answer];
  }

  /// What to call THIS computer wherever a usage figure has to say whose it is.
  ///
  /// The same `displayName` the sidebar prints and `_readMachineUsage` labels
  /// every remote machine with, so a panel listing one local and one remote
  /// account names them in one vocabulary rather than setting a hostname
  /// beside the words "this computer".
  ///
  /// Falls back to the OS hostname when the local machine has not been fetched
  /// yet — the rail can open before `refreshMachines` lands — and to null when
  /// even that is empty, which the caller renders by dropping the caption
  /// rather than printing a blank one.
  String? get thisMachineName {
    for (final state in machineStates.values) {
      if (state.isLocalMachine) return state.machine.displayName;
    }
    return localHostnameOrNull();
  }

  Future<MachineUsage?> _readMachineUsage(MachineState machine) async {
    try {
      final reply = await _conn(machine.machine.machineId)
          .request('usage_read', timeout: const Duration(seconds: 10));
      final readings = parseUsageReadResult(reply);
      if (readings.isEmpty) return null;
      return MachineUsage(
        machineName: machine.machine.displayName,
        readings: readings,
      );
    } catch (_) {
      return null;
    }
  }

  /// Media uses the existing machine-scoped, encrypted file RPC. It is never
  /// queued for a disconnected machine or resolved against this app's cwd.
  Future<Map<String, dynamic>> readRemoteMediaChunk(
    String machineId,
    String agentId,
    String target, {
    required int offset,
    String? revision,
  }) async {
    final machine = machineStates[machineId];
    if (machine == null || machine.needsLink || machine.nodeOnline == false ||
        machine.connectionStatus != ConnectionStatus.connected) {
      throw const RemoteMediaException('This machine is disconnected. Reconnect and try opening the preview again.');
    }
    if (!machine.mediaPreviewAvailable) {
      throw const RemoteMediaException('Update the Harness CLI on this remote machine to open image and video previews.');
    }
    final connection = _conn(machineId);
    if (!connection.isReady) {
      throw const RemoteMediaException('This machine is disconnected. Reconnect and try opening the preview again.');
    }
    try {
      return await connection.request('agent_read_file', payload: {
        'agentId': agentId, 'path': target, 'media': true, 'offset': offset,
        'revision': ?revision,
      }, timeout: const Duration(seconds: 15));
    } on WsRequestFailure catch (error) {
      throw RemoteMediaException(switch (error.code) {
        'MEDIA_NOT_FOUND' || 'NOT_FOUND' => 'This file is no longer available on the remote machine. It may have moved or been deleted.',
        'MEDIA_TOO_LARGE' => 'Remote previews support files up to 512 MB. Use a smaller export or transfer this file separately.',
        'MEDIA_CHANGED' => 'The file changed while downloading. Wait for it to finish generating and try again.',
        'MEDIA_UNSUPPORTED' => 'This file is not a supported image or video.',
        'MEDIA_INVALID_REQUEST' => 'Use a full path or a path inside this agent’s working folder.',
        'AGENT_NOT_FOUND' => 'This agent is no longer available. Reconnect to the agent and try again.',
        'NOT_TEXT' || 'FILE_TOO_LARGE' => 'Update the Harness CLI on this remote machine to open media previews.',
        _ => 'The remote machine could not read this file. Check that it is accessible and try again.',
      });
    } catch (_) {
      throw const RemoteMediaException('The media download was interrupted. Check the connection and try again.');
    }
  }

  /// One-level directory listing on the remote machine, for the New Agent folder browser.
  /// Returns `{path, entries: [{name, isDir}], truncated}` or `{error}` — the caller renders both.
  Future<Map<String, dynamic>> listRemoteFolder(
    String machineId,
    String? path,
  ) async {
    final connection = _conn(machineId);
    try {
      return await connection.request(
        'fs_list_dir',
        payload: {
          ...?path == null ? null : {'path': path},
        },
        timeout: const Duration(seconds: 10),
      );
    } catch (error) {
      return {'error': 'UNREACHABLE'};
    }
  }

  /// Every Codex profile folder the CLI on [machineId] can offer, merged with [observedPaths]
  /// (Codex homes already known from this same machine's other Codex agents). Runs entirely on that
  /// machine — this app never touches a filesystem itself, which is what makes it work for a remote
  /// machine too. Returns `{profiles: [{path, label}]}` or `{error}`.
  Future<Map<String, dynamic>> listCodexProfiles(
    String machineId, {
    Set<String> observedPaths = const {},
  }) async {
    final connection = _conn(machineId);
    try {
      return await connection.request(
        'codex_profiles_list',
        payload: {'observedPaths': observedPaths.toList()},
        timeout: const Duration(seconds: 10),
      );
    } catch (error) {
      return {'error': 'UNREACHABLE'};
    }
  }

  /// Links [path] as a Codex profile on [machineId], persisted there so it survives future
  /// requests. Returns `{profile: {path, label}}` or `{error}`.
  Future<Map<String, dynamic>> linkCodexProfile(
    String machineId,
    String path,
  ) async {
    final connection = _conn(machineId);
    try {
      return await connection.request(
        'codex_profile_link',
        payload: {'path': path},
        timeout: const Duration(seconds: 10),
      );
    } catch (error) {
      return {'error': 'UNREACHABLE'};
    }
  }

  /// Spawns a new engine session on [machineId] via the harness CLI, then jumps into its terminal.
  /// Returns null on success, or an error message to show inline in the New Agent dialog.
  Future<String?> createAgent(
    String machineId, {
    required String engine,
    required String folder,
    bool bypassPermission = false,
    String? codexHome,
  }) async {
    final machine = machineStates[machineId];
    if (machine == null) return 'Machine not found';
    if (codexHome != null) {
      if (engine != 'codex') {
        return 'Choose a Codex profile only for Codex';
      }
      if (machine.engines['codex']?.supportsCodexHome != true) {
        return 'Update the harness CLI on this machine to choose a Codex profile';
      }
    }
    final connection = _conn(machineId);
    Map<String, dynamic> result;
    try {
      result = await connection.request(
        'agent_create',
        payload: {
          'engine': engine,
          'cwd': folder,
          'bypassPermission': bypassPermission,
          'codexHome': ?codexHome,
        },
        timeout: const Duration(seconds: 20),
      );
    } on WsRequestFailure catch (failure) {
      // A refusal the CLI MEANT arrives as a thrown WsRequestFailure, never as an `error` key on a
      // reply that was returned — see that class. This used to be a branch on `result['error']`
      // below, which could not run, so the user got the wire code in place of the sentence.
      return failure.code == 'UNSUPPORTED_ON_REMOTE' ||
              failure.code == 'UNSUPPORTED'
          ? 'Update the harness CLI on this machine to use New Agent'
          : 'Create agent failed: ${failure.detail ?? failure.code}';
    } catch (error) {
      return 'Create agent failed: $error';
    }
    final raw = result['agent'];
    if (raw is! Map) return 'Create agent failed: malformed response';
    final agent = Agent.fromJson(Map<String, dynamic>.from(raw));
    // Idempotent on agent.id — safe even if the CLI's own agent_synced push for this session
    // arrives separately (it's fire-and-forget on the CLI side and unordered relative to this reply).
    _upsertAgent(machine, agent);
    // Counted HERE and not on the `agent_created` push, which also fires for
    // agents another client made on the same machine. "Agents spawned" is a
    // count of what this app launched.
    harnessStats.onAgentSpawned();
    notifyListeners();
    await selectAgent(machineId, agent.id);
    return null;
  }

  /// Renames a machine via `PATCH /api/machines/:machineId` (control-plane REST — the machine's
  /// `name` is backend-owned, unlike an agent's, which lives on the harness CLI). Returns null on
  /// success, or an error message to show inline in the caller's dialog.
  Future<String?> renameMachine(String machineId, String name) async {
    final state = machineStates[machineId];
    if (state == null) return 'Machine not found';
    final trimmed = name.trim();
    if (trimmed.isEmpty) return 'Name cannot be empty';
    try {
      await api.renameMachine(machineId: machineId, name: trimmed);
    } catch (error) {
      return 'Rename failed: $error';
    }
    state.machine = state.machine.copyWith(name: trimmed);
    final index = machines.indexWhere((m) => m.machineId == machineId);
    if (index != -1) machines[index] = state.machine;
    notifyListeners();
    return null;
  }

  /// Permanently deletes a machine from the account (backend `DELETE /api/machines/:id`) — not to
  /// be confused with [unlinkMachine], which only drops this computer's local E2EE trust pin and
  /// leaves the machine itself intact. Returns null on success, or an error message to show inline.
  Future<String?> deleteMachine(String machineId) async {
    final state = machineStates[machineId];
    if (state == null) return 'Machine not found';
    try {
      await api.deleteMachine(machineId: machineId);
    } catch (error) {
      return 'Delete failed: $error';
    }
    // Any tile still showing this machine would otherwise sit forever in the "waiting to answer"
    // busy state, since the machine can never be found again after this.
    for (final pane in panesFor(machineId).toList()) {
      await closePane(pane.id, persist: false);
    }
    _stopAgentSyncTimer(machineId);
    machineStates.remove(machineId);
    machines.removeWhere((m) => m.machineId == machineId);
    if (selectedMachineId == machineId) selectedMachineId = null;
    notifyListeners();
    return null;
  }

  /// Renames an agent via `agent_update`. Returns null on success, or an error message to show
  /// inline in the caller's dialog.
  Future<String?> renameAgent(
    String machineId,
    String agentId,
    String name,
  ) async {
    final machine = machineStates[machineId];
    if (machine == null) return 'Machine not found';
    final trimmed = name.trim();
    if (trimmed.isEmpty) return 'Name cannot be empty';
    Map<String, dynamic> result;
    try {
      result = await _conn(
        machineId,
      ).request('agent_update', payload: {'agentId': agentId, 'name': trimmed});
    } catch (error) {
      return 'Rename failed: $error';
    }
    final error = result['error'];
    if (error is String) return 'Rename failed: $error';
    _renameAgent(machine, agentId, trimmed);
    notifyListeners();
    return null;
  }

  /// Deletes an agent via `agent_delete`. Returns null on success, or an error message to show
  /// inline in the caller's dialog.
  Future<String?> deleteAgent(String machineId, String agentId) async {
    final machine = machineStates[machineId];
    if (machine == null) return 'Machine not found';
    Map<String, dynamic> result;
    try {
      result = await _conn(machineId)
          .request('agent_delete', payload: {'agentId': agentId});
    } catch (error) {
      return 'Delete failed: $error';
    }
    final error = result['error'];
    if (error is String) return 'Delete failed: $error';
    await _removeAgent(machine, agentId);
    notifyListeners();
    return null;
  }

  /// Restarts an agent via `agent_restart` — exits its current engine process and relaunches it
  /// daemon-side, resuming its session where possible.
  ///
  /// The reply carries the same fresh `Agent` shape `agent_synced` pushes once the new process is
  /// confirmed, so this upserts from the reply directly — idempotent on `agent.id`, same as
  /// [createAgent], and safe even if the CLI's own `agent_synced` push for the restart arrives
  /// separately (fire-and-forget on the CLI side, unordered relative to this reply).
  Future<RestartAgentResult> restartAgent(
    String machineId,
    String agentId,
  ) async {
    final machine = machineStates[machineId];
    if (machine == null) {
      return const RestartAgentResult(error: 'Machine not found');
    }
    Map<String, dynamic> result;
    try {
      result = await _conn(machineId)
          .request('agent_restart', payload: {'agentId': agentId});
    } catch (error) {
      return RestartAgentResult(error: 'Restart failed: $error');
    }
    final error = result['error'];
    if (error is String) {
      final detail = result['detail'];
      return RestartAgentResult(
        error: detail is String ? detail : 'Restart failed: $error',
      );
    }
    final raw = result['agent'];
    if (raw is Map) {
      try {
        _upsertAgent(machine, Agent.fromJson(Map<String, dynamic>.from(raw)));
        notifyListeners();
      } catch (_) {
        // Malformed reply agent — harmless, the CLI's own agent_synced push still lands.
      }
    }
    // Absent (older daemon build) reads as true — assume resumed rather than warn about a fresh
    // session that may not have happened, since this field is purely additive UI polish.
    final resumed = result['resumed'];
    return RestartAgentResult(resumed: resumed is bool ? resumed : true);
  }

  /// Every tile on the machine, not just the focused one: the machine is what
  /// went away, so a tile of the same machine sitting in another corner of the
  /// grid is just as dead and must say so rather than keep showing a terminal
  /// that can no longer receive anything. Records what was open so the next
  /// `connected` can put it back (`_recoverPendingAgent`).
  void _markSessionsUnreachable(MachineState machine, String message) {
    for (final pane in panesFor(machine.machine.machineId)) {
      final session = pane.session;
      if (session == null) continue;
      machine.activeAgentId ??= session.agentId;
      // A pane someone else already took over must stay frozen until the user retries it
      // themselves (see `_paneNeedsAttach`) — recording it here would have `_recoverPendingAgent`
      // call `selectAgent` on reconnect and silently win it back the moment the connection
      // returns, fighting whichever machine holds it now.
      if (session.status != TerminalSessionStatus.takenOver) {
        machine.pendingOfflineAgentId ??= session.agentId;
      }
      // Do not send terminal_close: the adapter is already gone and the
      // next client attachment should be the only stream that owns the pane.
      session.transportLost(message);
    }
  }

  Future<void> _applyNodeStatus(MachineState machine, bool online) async {
    if (_disposed) return;
    final machineId = machine.machine.machineId;
    final wasOnline = machine.nodeOnline;
    machine.nodeOnline = online;

    if (!online) {
      _markSessionsUnreachable(
        machine,
        machine.isLocalMachine
            ? 'Harness is offline. Run harness login to reconnect.'
            : 'Harness is offline. Run harness start on that machine to reconnect.',
      );
      _startOfflineRetry(machine);
    } else {
      _stopOfflineRetry(machineId);
      if (wasOnline == false) {
        for (final pane in panesFor(machineId)) {
          pane.session?.transportLost(
            'Harness reconnected; restoring terminal…',
          );
        }
      }
      final pending = machine.pendingOfflineAgentId;
      if (pending != null) {
        unawaited(_recoverPendingAgent(machine, pending));
      } else if (panesFor(machineId).any(_paneNeedsAttach)) {
        // A tile restored from the saved layout has no pendingOfflineAgentId —
        // nothing of its was interrupted, it simply arrived before its machine
        // did. Without this it would sit on "Attaching…" forever on a machine
        // that has since come back, because every other route to _attachSession
        // runs off a load that nothing here would trigger.
        unawaited(_loadMachineData(machine, force: true));
      }
    }
    notifyListeners();
  }

  Future<void> _recoverPendingAgent(
    MachineState machine,
    String agentId,
  ) async {
    final machineId = machine.machine.machineId;
    if (!_offlineRecoveryInFlight.add(machineId)) return;
    try {
      // E2EE and agents_list can become ready in separate frames after a
      // node restart. Poll briefly instead of racing a single request.
      for (var attempt = 0; attempt < 40; attempt++) {
        if (_disposed ||
            machine.nodeOnline != true ||
            machine.pendingOfflineAgentId != agentId) {
          return;
        }
        await _loadMachineData(machine, force: true);
        final agent = machine.agents.cast<Agent?>().firstWhere(
          (candidate) => candidate?.id == agentId,
          orElse: () => null,
        );
        if (agent != null &&
            agent.terminalAvailable &&
            machine.terminalCapabilityAvailable) {
          machine.pendingOfflineAgentId = null;
          // Only reattach the terminal if the user is still on THIS machine — recovery can finish
          // well after the user has moved on to a different machine/agent, and forcing selectAgent
          // here would yank their focus back to what they were looking at before, mid-navigation.
          // The recovered agent still shows normally in the rail; they can click it themselves.
          if (selectedMachineId == machineId) {
            await selectAgent(machineId, agentId);
          } else {
            notifyListeners();
          }
          return;
        }
        await Future<void>.delayed(const Duration(milliseconds: 250));
      }
    } finally {
      _offlineRecoveryInFlight.remove(machineId);
    }
  }

  /// Bring an agent up, the way a click on the rail means it.
  ///
  /// Already on screen means FOCUS it, never open it twice: the daemon keeps a
  /// single controller per agent, so a second open is a takeover — the window
  /// would fight itself and the first tile would go dark with
  /// `TERMINAL_TAKEN_OVER`.
  ///
  /// Otherwise it replaces the focused tile rather than adding one. Adding is a
  /// deliberate act (drag a row onto an empty slot); a click is navigation, and
  /// a click that silently grew the grid would make four terminals out of four
  /// glances at the rail.
  /// Bring up an agent the DIAL turned to.
  ///
  /// The rule the dial's carousel is built around: the tiles come first, in tile order, and past either
  /// end of them the ring continues into agents that have no tile. Landing on one of those is what puts
  /// it on the desk — it replaces the tile at the end it was reached from, so the grid stays the size the
  /// user chose and the tile that changes is the one they walked off.
  ///
  /// Which end is the daemon's answer, not a guess made here: it owns the flat list of every agent on
  /// every machine, so it is the only side that can say whether an agent sits before the first tile or
  /// after the last. With no tiles at all there is no end to replace, and the agent opens a new one.
  /// A notification on the dial was tapped: give that agent a tile of its OWN.
  ///
  /// A different verb from turning the dial, and the difference is the point. Turning says where the eye
  /// is, and a tile moves to match; a notification is a turn that just FINISHED — something new to look
  /// at, not a replacement for whatever the person was already watching. So the grid grows.
  ///
  /// At the ceiling it reuses the LAST tile. The alternative is refusing, and a notification that cannot
  /// be opened is a notification that lies: it says there is something to see and then does nothing when
  /// pressed. The last tile is the one the desk already treats as the place things arrive — it is what
  /// the dial's own right edge replaces.
  Future<void> openAgentFromDial(String machineId, String agentId) async {
    // Already on the desk: it has its tile, so this is only "look at it".
    final existing = paneOfAgent(machineId, agentId);
    if (existing != null) {
      focusPane(existing.id);
      selectedMachineId = machineId;
      notifyListeners();
      return;
    }
    if (canAddPane) {
      await assignAgentToPane(null, machineId, agentId);
      return;
    }
    await assignAgentToPane(panes.last.id, machineId, agentId);
  }

  /// The dial turned to an agent. Ordinary selection, the same path a click on the rail takes.
  ///
  /// It used to take a `DeskEdge` and, for an agent with no tile, replace the pane at that end — the
  /// dial's carousel could walk past the end of the desk onto an unopened agent, and the edge said
  /// which tile it had walked off. The carousel walks only open panes now, so there is no off-desk
  /// landing left to place and nothing to replace.
  Future<void> selectAgentFromDial(String machineId, String agentId) async {
    await selectAgent(machineId, agentId);
  }

  Future<void> selectAgent(String machineId, String agentId) async {
    final existing = paneOfAgent(machineId, agentId);
    if (existing != null) {
      selectedMachineId = machineId;
      machineStates[machineId]?.activeAgentId = agentId;
      focusPane(existing.id);
      final terminal = existing.session;
      if (terminal == null) {
        // The pane wanted this agent before `_attachSession` could actually attach it (the agent's
        // terminal wasn't verified yet, the machine was briefly offline, ...). Nothing else retries a
        // null session on its own — see `_attachPendingPanes` — so a click here has to.
        await _attachSession(existing);
      } else if (terminal.status != TerminalSessionStatus.opening &&
          terminal.status != TerminalSessionStatus.controlling &&
          terminal.status != TerminalSessionStatus.resyncing) {
        // A healthy pane is focus-only: opening the same daemon controller a
        // second time would take over its own first stream. A frozen/closed
        // pane is different — the explicit retry action needs a fresh session.
        await _detachSession(existing, sendClose: true);
        await _attachSession(existing);
      }
      return;
    }
    await assignAgentToPane(focusedPane?.id, machineId, agentId);
  }

  /// Show a MACHINE in the grid, for the states that belong to the machine
  /// rather than to any agent on it.
  ///
  /// It has to be a tile like any other — the alternative of letting a machine
  /// take over the whole content area would blank three working terminals
  /// belonging to two other machines. The one exception is a machine that
  /// already needs linking: that state now surfaces as a blocking popup
  /// (HomeScreen._maybeShowLinkDialog / showLinkMachineScreenDialog) rather
  /// than a tile, so opening one here too would just be a redundant "not
  /// linked" pane sitting behind it. Selecting is still worth doing — it's
  /// what makes the popup's gate notice this machine — the tile is not.
  void showMachinePane(String machineId) {
    final machine = machineStates[machineId];
    if (machine == null) return;
    _dismissedLinkPrompts.remove(machineId);
    selectedMachineId = machineId;
    if (machine.isRemote && !machine.isLocalMachine && machine.needsLink) {
      notifyListeners();
      return;
    }

    final existing = panes
        .where((pane) => pane.machineId == machineId && pane.agentId == null)
        .firstOrNull;
    if (existing != null) {
      focusedPaneId = existing.id;
      notifyListeners();
      return;
    }

    final target = focusedPane;
    if (target != null && target.agentId == null) {
      target.machineId = machineId;
      focusedPaneId = target.id;
      notifyListeners();
      return;
    }
    if (!canAddPane) {
      // Full grid: reuse the focused tile rather than refusing. Someone who
      // clicked "link required" asked to see it, and a click that did nothing
      // at all would read as a broken row.
      if (target != null) {
        unawaited(_detachSession(target, sendClose: true));
        target.machineId = machineId;
        target.agentId = null;
        _persistLayout();
        notifyListeners();
      }
      return;
    }
    final pane = TerminalPane(id: _nextPaneId++, machineId: machineId);
    panes.add(pane);
    focusedPaneId = pane.id;
    notifyListeners();
  }

  /// Put an agent into a specific tile, or into a NEW tile when [paneId] is
  /// null — which is what a drop on the empty slot means.
  Future<void> assignAgentToPane(
    int? paneId,
    String machineId,
    String agentId,
  ) async {
    final machine = machineStates[machineId];
    if (machine == null) return;

    Agent? agent;
    for (final candidate in machine.agents) {
      if (candidate.id == agentId) {
        agent = candidate;
        break;
      }
    }
    if (agent == null || !agent.terminalAvailable) return;

    // Moving an agent that is already somewhere else must not leave a copy
    // behind, for the takeover reason above. Dropping a row onto a second tile
    // is a MOVE.
    final duplicate = paneOfAgent(machineId, agentId);
    if (duplicate != null && duplicate.id != paneId) {
      await closePane(duplicate.id, persist: false);
    }

    TerminalPane? pane;
    if (paneId != null) {
      for (final candidate in panes) {
        if (candidate.id == paneId) {
          pane = candidate;
          break;
        }
      }
    }
    if (pane == null) {
      if (!canAddPane) return;
      pane = TerminalPane(
        id: _nextPaneId++,
        machineId: machineId,
        agentId: agentId,
      );
      panes.add(pane);
    } else {
      await _detachSession(pane, sendClose: true);
      pane.machineId = machineId;
      pane.agentId = agentId;
    }

    focusedPaneId = pane.id;
    selectedMachineId = machineId;
    _dismissedLinkPrompts.remove(machineId);
    machine.activeAgentId = agentId;
    _persistLayout();
    // SAID OUTRIGHT, like every other move.
    //
    // This path — a rail click on an agent with no tile — was the one that never said it. It relied on
    // the daemon inferring the move from the `terminal_open` that follows, which is the old
    // one-terminal-per-window equivalence [see _announceFocusToDial]. Two things wrong with that: the
    // roster below changes the dial's carousel, so the focus and the roster are one transaction and the
    // inference arrives after it by luck; and every early return under here (machine offline, terminal
    // capability missing, a session already attached) opens no stream at all, so nothing was ever sent
    // and the dial stayed on the old agent with the window on the new one.
    //
    // After _persistLayout, so the daemon has the new tile roster before it is told to move onto it. A
    // duplicate with the inferred one is free: the daemon drops the second against where the dial
    // already is.
    _announceFocusToDial();

    if (machine.nodeOnline == false) {
      machine.pendingOfflineAgentId = agentId;
      _startOfflineRetry(machine);
      notifyListeners();
      return;
    }
    if (!machine.terminalCapabilityAvailable) return;
    machine.pendingOfflineAgentId = null;
    _stopOfflineRetry(machineId);
    notifyListeners();
    await _attachSession(pane);
  }

  /// Open the stream for a tile that already knows what it wants.
  ///
  /// Separate from [assignAgentToPane] because a restored tile takes this path
  /// on its own, later, when its machine finally answers — the intent was
  /// settled at launch, and nothing about the selection should move again then.
  Future<void> _attachSession(TerminalPane pane) async {
    if (pane.session != null) return;
    final wantedAgentId = pane.agentId;
    if (wantedAgentId == null) return;
    final machine = machineStates[pane.machineId];
    if (machine == null) return;
    if (machine.nodeOnline == false) return;
    if (!machine.terminalCapabilityAvailable) return;

    Agent? agent;
    for (final candidate in machine.agents) {
      if (candidate.id == wantedAgentId) {
        agent = candidate;
        break;
      }
    }
    if (agent == null || !agent.terminalAvailable) return;

    final connection = _conn(pane.machineId);
    final terminal = TerminalSession(
      machineId: pane.machineId,
      agentId: agent.id,
      agentName: agent.name,
      engineId: agent.engine,
      send: connection.sendTerminalFrame,
      sendBinary: (frame) => _sendTerminalBinary(pane.machineId, frame),
      onOpenStalled: connection.forceReconnect,
    );
    pane.session = terminal;
    terminal.addListener(notifyListeners);
    notifyListeners();
    // Wait for the pane's actual measured viewport before asking the daemon to open anything.
    // Sending the 80x24 fallback here used to make the daemon spawn the remote TTY (and render its
    // first keyframe) at that wrong size, which then had to be corrected by a resize round trip —
    // visible as the terminal's content briefly rendering narrow before snapping to full width. The
    // blank "Attaching…" placeholder already covers this measurement, which lands within a frame or
    // two of the panel mounting; `waitForViewportSize`'s own 2s timeout falls back to 80x24 only if
    // the pane genuinely never gets laid out.
    await terminal.open(waitForViewportSize: true);
  }

  Future<void> _detachSession(
    TerminalPane pane, {
    required bool sendClose,
  }) async {
    final terminal = pane.session;
    pane.session = null;
    if (terminal == null) return;
    terminal.removeListener(notifyListeners);
    if (sendClose) await terminal.close();
    terminal.dispose();
  }

  /// Take a tile off the grid.
  ///
  /// Closing sends `terminal_close`, which is what lets the daemon put the
  /// agent's tmux window back to the size it had before this app borrowed it —
  /// a tile that vanished without saying so would leave that agent living in a
  /// quarter-width terminal.
  /// Put the pane at [paneId] where [targetPaneId] is, and that one where this
  /// one was.
  ///
  /// A SWAP, not an insert. Position here is nothing but the index in [panes] —
  /// PaneGrid lays the list out row-major — and on a 2x2 grid "between two
  /// cells" names no place, so shifting the others would move tiles the user
  /// did not touch. Swapping leaves every other tile exactly where it was.
  ///
  /// Focus follows the PANE, not the slot: `focusedPaneId` is an id, so a tile
  /// that was focused stays focused after it moves, which is what the hand that
  /// dragged it expects.
  void reorderPane(int paneId, int targetPaneId) {
    if (paneId == targetPaneId) return;
    final from = panes.indexWhere((pane) => pane.id == paneId);
    final to = panes.indexWhere((pane) => pane.id == targetPaneId);
    if (from == -1 || to == -1) return;
    final moved = panes[from];
    panes[from] = panes[to];
    panes[to] = moved;
    // The pin follows the hand. A pinned tile dragged elsewhere is someone
    // saying "here now", and a pinned tile displaced by another drag was still
    // put there deliberately — bouncing either back would make the drag look
    // broken while the state was in fact correct.
    if (panes[to].isPinned) panes[to].pinnedSlot = to;
    if (panes[from].isPinned) panes[from].pinnedSlot = from;
    _persistLayout();
    notifyListeners();
  }

  /// How many columns the grid last laid out.
  ///
  /// Only `auto` needs telling: it measures the window, so it is the one shape
  /// whose columns are not in its own description. Reported by the grid as it
  /// builds; null until then, and then the shape's own guess stands.
  int? gridColumns;

  /// Focus the tile above or below the focused one — ⌘↑ / ⌘↓.
  ///
  /// SPATIAL, unlike the left/right pair, which walks the tiles in order. Down
  /// from the top-left of a 2×2 is the tile under it, not the next one along,
  /// because that is what the arrow is pointing at. The shapes are read from
  /// [PanePreset.tilesFor] — the same rectangles the layout is built from and
  /// the picker draws — so this cannot describe a grid the app does not build.
  ///
  /// Nothing above or below (a single row, or the edge) leaves the focus where
  /// it is: an arrow that wraps to the far side of the screen reads as a jump,
  /// not as a step.
  void focusPaneVertically(int delta) {
    final to = _neighbour(dx: 0, dy: delta) ?? _wrapVertically(delta);
    if (to != null) focusPane(panes[to].id);
  }

  /// The tile at the far end of this column — ⌘j off the bottom row, ⌘k off the
  /// top.
  ///
  /// IN COLUMN, not in list order. Wrapping to `panes.first` from the bottom
  /// right of a 2x2 would jump a column as well as a row, which reads as the key
  /// having misfired rather than as having come round. This finds the tile that
  /// still overlaps ours horizontally and sits furthest in the direction pressed
  /// — the one directly above or below, as far as it goes.
  int? _wrapVertically(int delta) {
    final count = panes.length;
    if (count < 2) return null;
    final shape = presetFor(count)?.tilesFor(count, columns: gridColumns);
    if (shape == null || shape.length != count) return null;
    final at = panes.indexWhere((pane) => pane.id == focusedPaneId);
    if (at < 0) return null;

    final from = shape[at];
    int? best;
    double bestEdge = 0;
    for (var i = 0; i < count; i++) {
      if (i == at) continue;
      final to = shape[i];
      if ((from.right < to.left + 0.001) || (to.right < from.left + 0.001)) {
        continue;
      }
      // Going DOWN wraps to the topmost; going up, to the bottom-most.
      final edge = delta > 0 ? -to.top : to.top;
      if (best == null || edge > bestEdge) {
        bestEdge = edge;
        best = i;
      }
    }
    return best;
  }

  /// ⌘h / ⌘l, and ⌘← / ⌘→ — the tile beside this one, by POSITION.
  ///
  /// Spatial, like its vertical twin, and that is a change: left and right used
  /// to walk the panes in list order while up and down read the geometry, so
  /// half the compass answered "the next one" and half answered "the one over
  /// there". A vim user pressing `l` means the window to their right, and a
  /// scheme that means it in two directions out of four is one nobody can hold.
  void focusPaneHorizontally(int delta) {
    // THE RAIL IS A SEAT IN THE RING, not a wall at one end of it.
    //
    // No new key for "go to the sidebar": the sidebar is what is to the left of
    // the leftmost tile, so the key that means left already says it — the motion
    // vim users have, where `Ctrl-w h` out of the last split does not stop, it
    // reaches the next thing.
    //
    // And the ring CLOSES. Walking off either edge seats you in the rail, and
    // walking out of the rail continues round to the far side: left out of it
    // lands on the last tile, right onto the first. A ring that stopped dead at
    // one end would make the same key mean "go left" in the middle of the grid
    // and "do nothing" at its edge, which is a key people stop trusting.
    if (railFocused) {
      if (panes.isEmpty) return;
      unfocusRail();
      focusPane(delta < 0 ? panes.last.id : panes.first.id);
      return;
    }
    final to = _neighbour(dx: delta, dy: 0);
    if (to != null) {
      focusPane(panes[to].id);
      return;
    }
    focusRail();
    // An EMPTY rail is not a seat, so the ring skips it rather than stopping on
    // it. focusRail refuses when there is nothing to put a cursor on — no
    // machines yet, or a list that has not loaded — and without this the key
    // would simply do nothing at the edge, which is the exact behaviour the ring
    // exists to remove.
    if (!railFocused && panes.isNotEmpty) {
      focusPane(delta < 0 ? panes.last.id : panes.first.id);
    }
  }

  /// ⇧⌘h j k l — put this pane where its neighbour is, and that one here.
  ///
  /// A SWAP, not an insert. vim's `Ctrl-w H/J/K/L` — the capitals this mirrors —
  /// moves a window to the far edge, which needs a tree of splits to mean
  /// anything; this grid is a list of slots rendered into a shape, so the honest
  /// equivalent is to trade places with whoever is in the direction pressed.
  void movePaneDirection({required int dx, required int dy}) {
    final id = focusedPaneId;
    if (id == null) return;
    final at = panes.indexWhere((pane) => pane.id == id);
    final to = _neighbour(dx: dx, dy: dy);
    if (at < 0 || to == null) return;
    final moved = panes.removeAt(at);
    panes.insert(to, moved);
    _persistLayout();
    notifyListeners();
  }

  /// The index of the tile in the given direction, or null at the edge.
  ///
  /// Reads the laid-out RECTANGLES rather than the list, so "left" means left on
  /// screen whatever order the panes happen to be in. The two rules that make it
  /// honest: the neighbour has to actually be on that side (a tile whose edge is
  /// level with ours is not beside us), and the two have to OVERLAP on the other
  /// axis — otherwise the tile diagonally across counts as "down", which is how
  /// a 2x2 ends up with a key that moves like a knight.
  int? _neighbour({required int dx, required int dy}) {
    final count = panes.length;
    if (count < 2) return null;
    final shape = presetFor(count)?.tilesFor(count, columns: gridColumns);
    if (shape == null || shape.length != count) return null;
    final at = panes.indexWhere((pane) => pane.id == focusedPaneId);
    if (at < 0) return null;

    final from = shape[at];
    int? best;
    double bestGap = double.infinity;
    for (var i = 0; i < count; i++) {
      if (i == at) continue;
      final to = shape[i];
      final double gap;
      final bool apart;
      if (dy != 0) {
        gap = dy > 0 ? to.top - from.top : from.top - to.top;
        apart =
            (from.right < to.left + 0.001) || (to.right < from.left + 0.001);
      } else {
        gap = dx > 0 ? to.left - from.left : from.left - to.left;
        apart =
            (from.bottom < to.top + 0.001) || (to.bottom < from.top + 0.001);
      }
      if (gap <= 0.001 || apart) continue;
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    return best;
  }

  /// ⌘; — the pane focused before this one.
  ///
  /// tmux spells it the same way, and the reason it earns a key is that two
  /// agents at a time is the shape most work actually has: a thing being built
  /// and a thing being watched. Walking a list to get back to the other one is
  /// the wrong motion, and it gets longer as the grid fills.
  int? _previousPaneId;

  void focusLastPane() {
    final back = _previousPaneId;
    if (back == null) return;
    if (!panes.any((pane) => pane.id == back)) {
      // It was closed while we were away. Say nothing and stay put — jumping
      // somewhere arbitrary is worse than a key that did not fire.
      _previousPaneId = null;
      return;
    }
    focusPane(back);
  }

  /// ⌘⏎ — one pane filling the grid, and back.
  ///
  /// The id is held rather than a flag, so a zoom SURVIVES the thing that
  /// usually breaks this: focus moving. Zoomed on tile 3 and then jumping to
  /// tile 5 shows tile 5 zoomed, which is what tmux does and what the eye
  /// expects; a boolean would have shown tile 3 while the focus was elsewhere.
  int? zoomedPaneId;

  void toggleZoomPane() {
    final id = focusedPaneId;
    if (id == null || panes.length < 2) return;
    zoomedPaneId = zoomedPaneId == id ? null : id;
    notifyListeners();
  }

  /// Focus the nth tile on the grid — ⌘1…⌘9.
  ///
  /// The number is the tile's position on screen, which is also the number the
  /// dial walks, so "the third one" means one thing wherever it is said. A digit
  /// past the last tile does NOTHING: it used to address the sidebar instead,
  /// where ⌘3 opened an agent that was not on the grid and replaced a tile to
  /// show it — a key meant only to look, rearranging the desk.
  void focusPaneByIndex(int index) {
    if (index < 0 || index >= panes.length) return;
    focusPane(panes[index].id);
  }

  /// Walk the focus one tile — ⌘← / ⌘→, and ⌘[ / ⌘].
  ///
  /// Wraps, because the grid is what the eye reads as a loop of tiles; stopping
  /// dead at the last one reads as a broken key. Moves focus ONLY — nothing on
  /// the grid changes, which is what separates it from [movePaneBy].
  void focusPaneBy(int delta) {
    if (panes.length < 2) return;
    final at = panes.indexWhere((pane) => pane.id == focusedPaneId);
    final next = at < 0 ? 0 : (at + delta + panes.length) % panes.length;
    focusPane(panes[next].id);
  }

  /// Move the focused pane one slot, for the keyboard twin of the drag.
  ///
  /// Stops at the ends rather than wrapping: the grid is a shape, not a ring,
  /// and a tile jumping from the last slot to the first reads as a bug.
  void movePaneBy(int delta) {
    final id = focusedPaneId;
    if (id == null) return;
    final from = panes.indexWhere((pane) => pane.id == id);
    if (from == -1) return;
    final to = from + delta;
    if (to < 0 || to >= panes.length) return;
    reorderPane(id, panes[to].id);
  }

  /// Pin this tile to the slot it is in, or let it go.
  ///
  /// Pinning records the CURRENT slot rather than asking for one: the tile the
  /// user is looking at is the answer they mean, and a dialog asking "which
  /// number?" would be arithmetic about a thing they can already see.
  void togglePinPane(int paneId) {
    final index = panes.indexWhere((pane) => pane.id == paneId);
    if (index == -1) return;
    final pane = panes[index];
    pane.pinnedSlot = pane.isPinned ? null : index;
    _persistLayout();
    notifyListeners();
  }

  /// Put pinned tiles back in their slots after the list moved under them.
  ///
  /// Lifted rather than swapped: after a close everyone has slid up one, and
  /// lifting the pinned tile back into its slot leaves that slide intact for
  /// every other tile. A swap would instead fling whichever tile inherited the
  /// slot to the far end of the grid — one close, two tiles moved, and only one
  /// of them explicable.
  ///
  /// A pin past the end of a shrunken grid is HELD, not dropped: the tiles that
  /// closed can come back, and forgetting the pin the moment the grid got small
  /// would quietly undo a choice the user never revisited.
  void _settlePins() {
    final pinned = panes.where((pane) => pane.isPinned).toList()
      ..sort((a, b) => a.pinnedSlot!.compareTo(b.pinnedSlot!));
    for (final pane in pinned) {
      final want = pane.pinnedSlot!;
      if (want >= panes.length) continue;
      final at = panes.indexOf(pane);
      if (at == want) continue;
      panes.removeAt(at);
      panes.insert(want, pane);
    }
  }

  Future<void> closePane(int paneId, {bool persist = true}) async {
    final index = panes.indexWhere((pane) => pane.id == paneId);
    if (index == -1) return;
    final pane = panes.removeAt(index);
    // A zoom belongs to a tile, so closing that tile ends it. Left set, the grid
    // would try to fill itself with a pane that is no longer in the list and
    // draw nothing at all.
    if (zoomedPaneId == paneId) zoomedPaneId = null;
    if (_previousPaneId == paneId) _previousPaneId = null;
    _settlePins();
    await _detachSession(pane, sendClose: true);
    if (focusedPaneId == paneId) {
      focusedPaneId = panes.isEmpty
          ? null
          : panes[index.clamp(0, panes.length - 1)].id;
    }
    if (persist) _persistLayout();
    notifyListeners();
  }

  Future<void> _closeAllPanes({bool persist = true}) async {
    final open = panes.toList();
    panes.clear();
    focusedPaneId = null;
    for (final pane in open) {
      await _detachSession(pane, sendClose: true);
    }
    if (persist) _persistLayout();
  }

  void _persistLayout() {
    // The roster and the saved layout describe the same fact — which agents are
    // on the grid — so they are announced and written from the same place.
    // Before the early return below: a window with no layout store still has
    // tiles, and the dial still has to know about them.
    _announceOpenPanesToDial();
    final store = _paneLayout;
    if (store == null) return;
    unawaited(
      store.save([
        for (final pane in panes)
          // Machine tiles are deliberately not remembered: they are a prompt
          // about a machine's state right now ("link required"), and reopening
          // to a wall of prompts the user already answered would be noise.
          if (pane.agentId case final agentId?)
            PaneLayoutEntry(
              machineId: pane.machineId,
              agentId: agentId,
              composerVisible: pane.composerVisible,
              pinnedSlot: pane.pinnedSlot,
            ),
      ]),
    );
  }

  /// Rebuild the grid from disk as INTENT only — the tiles appear immediately,
  /// each saying which machine it is waiting for, and attach themselves as
  /// their machines answer.
  ///
  /// The tiles cannot wait for the machines: machines answer in an order this
  /// side does not decide, a restored grid commonly spans two of them, and one
  /// being slow or offline must not hold the others blank.
  Future<void> _restorePaneLayout() async {
    final store = _paneLayout;
    if (store == null) return;
    // Read before the guards below: the dividers are remembered even for a
    // grid this run has not restored any agents into, so a window that opens
    // empty and is then filled by hand still comes up the shape it was left.
    panePresets.addAll(await store.loadPresets());
    if (panes.isNotEmpty) return;
    final entries = await store.load();
    if (entries.isEmpty) {
      if (panePresets.isNotEmpty) notifyListeners();
      return;
    }
    for (final entry in entries) {
      panes.add(
        TerminalPane(
            id: _nextPaneId++,
            machineId: entry.machineId,
            agentId: entry.agentId,
          )
          ..composerVisible = entry.composerVisible
          ..pinnedSlot = entry.pinnedSlot,
      );
    }
    // The saved order already puts everything where it was left, so this is
    // only a repair: a layout whose file was hand-edited, or trimmed by the
    // pane ceiling on the way in, can arrive with a pinned tile off its slot.
    _settlePins();
    focusedPaneId = panes.first.id;
    // A restored grid IS the choice of what to open, so the first-run
    // convenience must not also fire and add a fifth agent nobody asked for.
    _autoPickedAgent = true;
    notifyListeners();
  }

  /// Attach any tile of this machine that is still waiting.
  ///
  /// Called after every load rather than once, because the three things
  /// [_attachSession] insists on — the agent exists, it has a tmux terminal,
  /// and the machine's terminal protocol has been negotiated — become true at
  /// different moments, and a machine that goes away and returns has to be able
  /// to re-arrive at them.
  void _attachPendingPanes(MachineState machine) {
    final machineId = machine.machine.machineId;
    for (final pane in panes.toList()) {
      if (pane.machineId != machineId) continue;
      if (!_paneNeedsAttach(pane)) continue;
      // Covers a tile that never attached AND one holding a stream the machine
      // lost. Only the first used to be covered, and the second is why a
      // reconnect left every tile but one frozen on "restoring terminal…":
      // recovery ran off pendingOfflineAgentId, which is a single slot, so it
      // could only ever promise restoration to one of them.
      unawaited(_reattachPane(pane));
    }
  }

  /// Whether this tile is showing something that is not a working terminal.
  ///
  /// `takenOver` is deliberately absent. A stream someone else claimed is only
  /// reopened when a person asks for it — see [selectAgent], which is reached
  /// from the tile's own retry button. Doing it automatically would have two
  /// windows trading one terminal back and forth for as long as both stayed
  /// open.
  bool _paneNeedsAttach(TerminalPane pane) {
    if (pane.agentId == null) return false;
    final session = pane.session;
    if (session == null) return true;
    return switch (session.status) {
      TerminalSessionStatus.error || TerminalSessionStatus.closed => true,
      _ => false,
    };
  }

  /// Throw away a tile's dead stream and open a fresh one for the same agent.
  ///
  /// `sendClose: false` — the stream being replaced is one the machine has
  /// already lost or closed, so a close addressed to it would at best be
  /// ignored and at worst land on whatever took its place.
  Future<void> _reattachPane(TerminalPane pane) async {
    await _detachSession(pane, sendClose: false);
    await _attachSession(pane);
  }

  /// Resolve a dial agent to the machine that owns it.
  ///
  /// New CLIs state the machine explicitly. Older CLIs only sent an agent id;
  /// that is safe to retain only when the current snapshots contain exactly
  /// one matching machine. The websocket carrying the event is always the
  /// local daemon and is therefore not evidence that the agent is local.
  String? _dialFocusMachine(Map<String, dynamic> payload, String agentId) {
    final explicitMachineId = payload['machineId'];
    if (explicitMachineId is String && explicitMachineId.isNotEmpty) {
      final state = machineStates[explicitMachineId];
      if (state == null ||
          !state.agents.any((candidate) => candidate.id == agentId)) {
        return null;
      }
      return explicitMachineId;
    }

    String? match;
    for (final entry in machineStates.entries) {
      if (!entry.value.agents.any((candidate) => candidate.id == agentId)) {
        continue;
      }
      if (match != null) return null; // Ambiguous legacy event: do not guess.
      match = entry.key;
    }
    return match;
  }

  Future<void> _handleEvent(
    String machineId,
    Map<String, dynamic> event,
  ) async {
    final machine = machineStates[machineId];
    if (machine == null) return;
    final type = event['type'] as String? ?? '';
    final payload = (event['payload'] as Map<String, dynamic>?) ?? {};
    // EVERY tile on this machine sees the frame, and each decides for itself.
    //
    // Not a routing choice — a correctness one. `handleFrame` answers "this was
    // a terminal frame", NOT "this was mine": a session that is not the one
    // being addressed still returns true so the app-level switch skips it. With
    // one terminal those two meanings were the same sentence. With four they
    // are not, and stopping at the first `true` would have let whichever tile
    // happened to be first swallow another tile's `terminal_ready` — the reply
    // is matched by requestId AND agentId inside the session, so only the right
    // one acts on it, but only if it is allowed to see it.
    //
    // It also fixes a fault that was invisible at one tile: a
    // `terminal_transport_error` describes the whole connection, and every
    // session must learn the transport died. Stopping early would have told one
    // tile and left the rest showing a terminal that can no longer receive
    // anything.
    var consumedByTerminal = false;
    for (final pane in panesFor(machineId).toList()) {
      final session = pane.session;
      if (session == null) continue;
      if (await session.handleFrame(type, payload)) consumedByTerminal = true;
    }
    if (consumedByTerminal) return;
    switch (type) {
      // ── the dial, over the cable, forwarded by the local daemon ──────────────────────────────────
      // Local-only frames (backend.sendLocal in the harness CLI): they describe a hand at THIS desk, so
      // they never reach the cloud web audience, who may be sitting at another computer entirely.
      case 'dial_status':
        // The dial came, went, or started taking an update. Its own notifier —
        // see [dial] — so nothing else in the window rebuilds for it.
        dial.apply(DialStatus.fromJson(payload));
        break;
      case 'dial_scroll':
        // Straight through, including the reports carrying no travel — the ends of a stroke are the point
        // of the message. The window does no arithmetic here; the terminal that owns the scrollback does.
        final phase = switch (payload['phase']) {
          'down' => 0,
          'up' => 2,
          _ => 1,
        };
        activeTerminal?.scroll(
          phase,
          (payload['dy'] as num?)?.round() ?? 0,
          (payload['velocity'] as num?)?.round() ?? 0,
        );
        break;
      case 'dial_focus':
        // Turning the dial to an agent brings that agent's terminal up here — the ordinary selection
        // path, the same one a click on the rail takes, failing the same way for a missing terminal,
        // an offline machine or an unknown id.
        //
        // It used to carry an `edge` for an agent with no tile, naming which end of the desk the
        // carousel had walked off so a tile could be replaced there. The carousel walks only open
        // panes now, so every focus it sends is about a pane that already exists.
        final agentId = payload['agentId'];
        if (agentId is String && agentId.isNotEmpty) {
          final targetMachineId = _dialFocusMachine(payload, agentId);
          if (targetMachineId != null) {
            unawaited(selectAgentFromDial(targetMachineId, agentId));
          }
        }
        break;
      case 'voice_route_request':
        // WORDS SPOKEN INTO THE DIAL, handed here to be routed.
        //
        // The dial used to pick the agent itself with an older copy of this router — no candidate cap,
        // untrimmed recaps, a shorter budget, and no way to ask when it was unsure, so an uncertain
        // route was still a send. This window has the palette that can hold the answer up, so the
        // decision moved to it and the dial became the microphone.
        //
        // The daemon is waiting on a reply for this voiceId; SpokenTask is what guarantees one goes
        // back on every path out of the palette.
        final voiceId = payload['voiceId'];
        final spokenText = payload['text'];
        if (voiceId is String &&
            voiceId.isNotEmpty &&
            spokenText is String &&
            spokenText.trim().isNotEmpty) {
          _spokenTasks.add(
            SpokenTaskRequest(
              voiceId: voiceId,
              machineId: machineId,
              text: spokenText.trim(),
              cmd: payload['cmd'] is String ? payload['cmd'] as String : '',
            ),
          );
        }
        break;
      case 'dial_open':
        // A notification was tapped on the dial. Unlike `dial_focus` this asks for a tile of its own —
        // see openAgentFromDial for why a finished turn is not a replacement for what is on screen.
        final openId = payload['agentId'];
        if (openId is String && openId.isNotEmpty) {
          final targetMachineId = _dialFocusMachine(payload, openId);
          if (targetMachineId != null) {
            unawaited(openAgentFromDial(targetMachineId, openId));
          }
        }
        break;
      case 'node_status':
        final online = payload['online'] == true;
        await _applyNodeStatus(machine, online);
        break;
      case 'machine_select_error':
        _lastError =
            'Machine selection failed: ${payload['error'] ?? 'unknown error'}';
        _lastErrorRetryable = true;
        machine.connectionStatus = ConnectionStatus.disconnected;
        break;
      case 'agent_synced':
        final raw = payload['agent'];
        if (raw is Map) {
          try {
            final agent = Agent.fromJson(Map<String, dynamic>.from(raw));
            if (agent.terminalAvailable) {
              _upsertAgent(machine, agent);
              // A pane created before this agent's terminal was verified is still sitting on
              // "Attaching…" with no session — nothing else re-checks it once agentLoadStatus is
              // already `loaded`, so this push is the only signal that it can attach now.
              _attachPendingPanes(machine);
            } else {
              await _removeAgent(machine, agent.id);
            }
          } catch (_) {
            unawaited(_loadMachineData(machine, force: true));
          }
        } else {
          unawaited(_loadMachineData(machine, force: true));
        }
        break;
      case 'agent_created':
        final raw = payload['agent'];
        if (raw is Map && raw['terminal'] is Map) {
          try {
            final agent = Agent.fromJson(Map<String, dynamic>.from(raw));
            _upsertAgent(machine, agent);
            // Same reattach as `agent_synced` above — a pane can be waiting on this exact agent
            // (e.g. one this window's own New Agent dialog just opened) with no session yet.
            _attachPendingPanes(machine);
          } catch (_) {
            unawaited(_loadMachineData(machine, force: true));
          }
        } else {
          unawaited(_loadMachineData(machine, force: true));
        }
        break;
      case 'agent_renamed':
        final agentId = _eventAgentId(machine, event, payload);
        final name = payload['name'];
        if (agentId != null && name is String) {
          _renameAgent(machine, agentId, name);
        } else {
          unawaited(_loadMachineData(machine, force: true));
        }
        break;
      case 'agent_deleted':
        final agentId = _eventAgentId(machine, event, payload);
        if (agentId != null) {
          await _removeAgent(machine, agentId);
        } else {
          unawaited(_loadMachineData(machine, force: true));
        }
        break;
      // An agent stopped and is waiting on the person. Ignored by this window
      // until now, even though the daemon had already shaped the question for
      // the dial — `sendCommander` is device-only, so it never came down this
      // wire at all.
      case 'commander_question':
        final agentId = _eventAgentId(machine, event, payload);
        if (agentId != null) {
          final asked = PendingQuestion.fromPayload(
            machineId: machineId,
            agentId: agentId,
            payload: payload,
            now: DateTime.now(),
          );
          if (asked != null) {
            // The daemon re-announces an open question after a reconnect, and
            // on attaching to a turn that was already mid-dialog. Keep the
            // original clock in that case: this is the same wait continuing,
            // and restarting it would make a long block look new.
            final known = machine.blockedAgents[agentId];
            machine.blockedAgents[agentId] =
                known != null && known.sameAs(asked)
                ? asked.withSince(known.since)
                : asked;
          }
        }
        break;
      // It stopped being on screen — answered here, in the pane by hand, on
      // another window, or on the dial. Whoever got there first, everyone else
      // is told to stop drawing it.
      case 'commander_question_close':
        final agentId = _eventAgentId(machine, event, payload);
        final requestId = payload['requestId'];
        if (agentId != null) {
          final open = machine.blockedAgents[agentId];
          // Only if it is the one being closed: a stale close must not wipe the
          // question that replaced it when a dialog advanced to its next page.
          if (open != null &&
              (requestId is! String ||
                  requestId.isEmpty ||
                  open.requestId == requestId)) {
            machine.blockedAgents.remove(agentId);
          }
        }
        break;
      case 'turn_started':
      case 'turn_heartbeat':
        // A turn that STARTS is somebody sending something; a heartbeat is a
        // turn already under way, which for an agent this app merely reconnected
        // to is work nobody here just asked for.
        if (type == 'turn_started') _reportFirstMessage();
        final agentId = _eventAgentId(machine, event, payload);
        if (agentId != null) {
          _markAgentProcessing(machine, agentId);
          // Only a START opens a stats turn, for the reason above: a heartbeat
          // is a turn already under way, and counting one would report an agent
          // this app merely reconnected to as work somebody just asked for.
          if (type == 'turn_started') {
            harnessStats.onTurnStarted(
              _turnActivityKey(machine.machine.machineId, agentId),
            );
          }
        } else {
          final sessionId = _eventSessionId(event, payload);
          if (sessionId != null) {
            machine.pendingProcessingSessions.add(sessionId);
          }
        }
        break;
      case 'turn_ended':
        final agentId = _eventAgentId(machine, event, payload);
        if (agentId != null) {
          _cancelTurnActivity(machine.machine.machineId, agentId);
        } else {
          final sessionId = _eventSessionId(event, payload);
          if (sessionId != null) {
            machine.pendingProcessingSessions.remove(sessionId);
          }
        }
        break;
    }
    notifyListeners();
  }

  /// Feed one machine event straight into the dispatcher.
  ///
  /// The frames worth testing here have no terminal to route through and no
  /// socket to arrive on — what they exercise is the bookkeeping either side of
  /// that, which is exactly what a live socket makes hard to reach.
  @visibleForTesting
  Future<void> handleMachineEventForTest(
    String machineId,
    Map<String, dynamic> event,
  ) => _handleEvent(machineId, event);

  /// Put an already-built session on the grid.
  ///
  /// The seam tests used to get from assigning `activeTerminal` directly, which
  /// a grid cannot offer: a session on screen is a session in a TILE, and the
  /// tile is what every lifecycle path — a machine going offline, an agent
  /// being deleted, a frame arriving — actually looks for.
  @visibleForTesting
  TerminalPane adoptSessionForTest(TerminalSession session) {
    final pane = TerminalPane(
      id: _nextPaneId++,
      machineId: session.machineId,
      agentId: session.agentId,
    )..session = session;
    panes.add(pane);
    focusedPaneId = pane.id;
    session.addListener(notifyListeners);
    return pane;
  }

  @visibleForTesting
  Future<void> handleEventForTest(
    String machineId,
    Map<String, dynamic> event,
  ) => _handleEvent(machineId, event);

  /// What the local CLI closing this machine's socket with [code] does to the
  /// model — the `WsPool.onLocalFailure` path, without a socket.
  @visibleForTesting
  void localFailureForTest(String machineId, int code, String reason) =>
      _onLocalFailure(machineId, code, reason);

  @override
  void dispose() {
    _disposed = true;
    _daemonSupervisionTimer?.cancel();
    _updateCheckTimer?.cancel();
    _environmentRecheckTimer?.cancel();
    _stopAllOfflineRetries();
    _stopAllLinkRetries();
    _stopAllAgentSyncTimers();
    _clearAllTurnActivity();
    for (final pane in panes) {
      pane.session?.removeListener(notifyListeners);
      pane.session?.dispose();
    }
    panes.clear();
    unawaited(_spokenTasks.close());
    super.dispose();
  }
}

final appStateProvider = Provider<AppNotifier>((ref) {
  final app = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: ConfigStore(),
    paneLayoutStore: PaneLayoutStore(),
  );
  app.bootstrap();
  return app;
});
