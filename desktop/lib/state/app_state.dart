import 'dart:async';
import 'dart:io' show Platform, exit, pid;
import 'dart:math' show Random;

import 'package:dio/dio.dart';

import 'dart:ui' show Color;

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart' show BuildContext;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../analytics/analytics.dart';
import '../api/api_client.dart';
import '../viewer/sign_in_browser.dart';
import '../viewer/viewer_services.dart';
import '../auth/auth_session.dart';
import '../auth/peer_link_client.dart';
import '../auth/sign_in_client.dart';
import '../auth/cli_link.dart';
import '../auth/cli_login.dart';
import '../bootstrap/environment_provisioner.dart';
import '../core/backend_path.dart';
import '../core/viewer_mode.dart';
import '../core/config.dart';
import '../core/agent_preference.dart';
import '../core/dsh_catalog.dart';
import '../core/engine_availability.dart';
import '../core/local_hostname.dart';
import '../core/local_git_projects.dart';
import '../core/test_run.dart';
import '../core/models.dart';
import '../core/project_folder.dart';
import '../core/project_history.dart';
import '../core/project_preview.dart';
import '../core/repository_clone.dart';
import '../core/retry.dart';
import '../settings/config_store.dart';
import '../stats/harness_stats.dart';
import '../terminal/terminal_session.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import '../logging/app_log.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../terminal/remote_media_download.dart';
import '../widgets/engine_identity.dart'
    show allEngines, engineIdentity, isTerminalEngine;
import '../store/store_screen.dart' show openStoreAgent;
import 'dial_status.dart';
import 'pane_layout_store.dart';
import 'terminal_pane.dart';
import 'swarm.dart';
import '../terminal/terminal_binary.dart';
import '../update/desktop_updater.dart';
import '../update/manual_update_check.dart';
import '../ws/ws_conn.dart';
import 'retarget_refusal.dart';
import '../ws/local_cli_discovery.dart';
import '../ws/ws_pool.dart';
import 'pane_preset.dart';
import 'pane_arrangement.dart';
import 'pending_question.dart';
import 'session_preview.dart';
import '../usage/remote_usage.dart';
import '../usage/usage_accounts.dart';
import '../orchestrator/orchestrator_controller.dart';

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

/// Result of [AppNotifier.forkAgent]. [error] null means the fork is open;
/// [level] then says what it got — `native` (the engine's own fork, the whole
/// context) or `handoff` (a first message composed from what the daemon
/// remembers of the source, for an engine that cannot fork).
class ForkAgentResult {
  final String? error;
  final String level;
  final String? agentId;

  const ForkAgentResult({this.error, this.level = 'native', this.agentId});
}

/// One deliberate creation, retained by the form if its reply is lost. Reusing
/// it checks the original request; opening New agent starts a fresh intent.
class AgentCreationAttempt {
  AgentCreationAttempt() {
    final random = Random.secure();
    _id = List.generate(
      16,
      (_) => random.nextInt(256),
    ).map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();
  }

  late final String _id;
  String? _machineId, _targetId;
  Map<String, dynamic>? _choices;
  PaneSplitRequest? _split;
  Future<String?>? _inFlight;
  bool _awaitingConfirmation = false, _finished = false;
  String? _outcome;
  String? _preparedFolder;

  bool get awaitingConfirmation => _awaitingConfirmation;

  /// A completed folder survives a refused agent launch, so correcting the
  /// agent choice does not clone or create the same project again.
  String? get preparedFolder => _preparedFolder;

  String? _complete(String? error) {
    _finished = true;
    _awaitingConfirmation = false;
    return _outcome = error;
  }
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
  Map<String, AgentProject> localProjects = const {};
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
  Future<void>? terminalCapabilityLoadInFlight;
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
  // Which domain-specific harnesses this machine has or could install, as it
  // answered `dsh_list`. Per machine for the same reason `engines` is: an
  // install is a clone and a toolchain on ONE box.
  final MachineDsh dsh = MachineDsh();
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

  AgentProject? projectOf(Agent agent) =>
      agent.project ??
      localProjects[agent.id] ??
      localEndpoint?.agentProjects[agent.id];

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

  /// Signs in, and says whether this computer is signed in: the harness CLI in a desktop build,
  /// [ViewerServices.login] in a viewer build — which has no CLI — under one name, so every call
  /// site reads the same in both.
  late final SignInClient cliLogin;
  final CliLink cliLink;

  /// Links to other machines by remote password: [cliLink] in a desktop build, the app itself in a
  /// viewer. THIS machine's own remote password stays on [cliLink] — a viewer is not a machine, and
  /// has no password for anyone to link to.
  late final PeerLinkClient peerLinks;

  /// A viewer build's stand-ins for the harness CLI (`lib/viewer/`); null on a desktop build.
  final ViewerServices? viewer;
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

  /// Set by `_refreshMachines` from the resolved CLI. On Windows the CLI may run
  /// inside WSL2, where a Windows path is not a path it can open — see
  /// [machineSharesGuiFilesystem] and [backendFolderFor].
  bool _localCliInWsl = false;

  /// Pins the "the local CLI runs in WSL2" fact for a widget/unit test, which
  /// otherwise has to spawn a real `wsl.exe` to learn it.
  @visibleForTesting
  void debugSetLocalCliInWsl(bool value) {
    _localCliInWsl = value;
  }

  /// Pins the distribution name reported for that CLI, for the same reason.
  @visibleForTesting
  String? debugLocalCliWslDistro;
  final EnvironmentProvisioner? environmentProvisioner;
  final DesktopUpdater? desktopUpdater;
  @visibleForTesting
  final WsConn Function(String machineId)? connectionForTest;
  final Map<String, Timer> _turnActivityWatchdogs = {};

  late final sessionPreviews = SessionPreviewStore(
    canFetch: _canFetchPreview,
    fetchRecent: (key) => _conn(key.machineId).request(
      'agent_recent',
      payload: {'agentId': key.agentId, 'n': 3},
      timeout: const Duration(seconds: 6),
    ),
  );

  SessionPreviewKey previewKey(String machineId, Agent agent) =>
      (machineId: machineId, agentId: agent.id, sessionId: agent.sessionId);

  bool _canFetchPreview(SessionPreviewKey key) {
    if (_disposed || (_pool == null && connectionForTest == null)) return false;
    final machine = machineStates[key.machineId];
    return machine != null &&
        machine.nodeOnline != false &&
        !machine.needsLink &&
        (machine.connectionStatus == ConnectionStatus.connected ||
            connectionForTest != null) &&
        machine.agents.any(
          (agent) =>
              agent.id == key.agentId && agent.sessionId == key.sessionId,
        );
  }

  void _warmPreviews(MachineState machine) => sessionPreviews.warm(
    machine.agents.map((agent) => previewKey(machine.machine.machineId, agent)),
  );

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
  // Backend REST can fail while the daemon and its WebSocket remain ready. Recover that list
  // independently, with capped backoff and the same in-flight request as a manual retry.
  Timer? _machineRecoveryTimer;
  Timer? _sharingDiscoveryTimer;
  bool _sharingDiscoveryBusy = false;
  int _machineRecoveryAttempts = 0;
  String? _machineLoadError;

  /// The last [ensureCliDaemonReady] did not reach a ready daemon — the one
  /// error the supervisor's ready transition is allowed to retry away.
  bool _daemonGateFailed = false;

  /// The daemon's backend link as it last reported it (`/api/status.connected`), fed by the boot
  /// probe and then by the supervisor's 5s tick. Null until a daemon has answered at all. False is
  /// not an error: this computer's agents work over the loopback regardless; it is what makes the
  /// rail say "offline copy" and what keeps a failed machine list from raising the red strip.
  bool? _backendOnline;
  bool? get backendOnline => _backendOnline;
  // The last probe state the boot gate logged, so a daemon that sits in one state for a minute
  // costs one line, not one per 500ms tick.
  String? _loggedDaemonState;
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

  // Account and inventory replies belong to the session that requested them.
  // Signing out invalidates them before asynchronous connection cleanup.
  int _authRevision = 0;
  Future<void>? _profileInFlight;

  bool _authWorkCurrent(int revision) =>
      !_disposed && revision == _authRevision;

  int _invalidateAuthWork() {
    _stopMachineRecovery();
    _machineLoadError = null;
    _resetLoginBrowser();
    _loginAuthorized = false;
    _profileInFlight = null;
    _retryInFlight = null;
    machinesLoading = false;
    return ++_authRevision;
  }

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
  late final _localGitProjects = LocalGitProjects(
    onChanged: _applyLocalGitProjects,
  );

  AppStatus status = AppStatus.bootstrapping;
  CurrentUserProfile? currentUser;
  List<Machine> machines = [];
  final Map<String, MachineState> machineStates = {};
  final Set<String> expandedMachines = {};
  String? selectedMachineId;

  /// Swarms own arrangements; a shared pane owns one live terminal controller.
  final List<Swarm> swarms = [Swarm(id: 'swarm-1')];
  String _activeSwarmId = 'swarm-1';
  int _nextSwarmId = 2;
  // No tab cap, as in Chrome: only the visible tab's panes are built, so a background tab costs its
  // terminal streams and nothing else — its web panes are unloaded until it is shown again.
  static const maxClosedSwarms = 24;
  final List<ClosedWork> _closedHistory = [];
  int _nextClosedHistoryId = 1;
  List<ClosedWork> get closedHistory =>
      List.unmodifiable(_closedHistory.reversed);
  List<ClosedSwarm> get closedSwarms =>
      List.unmodifiable(_closedHistory.reversed.whereType<ClosedSwarm>());
  bool get canReopenClosedSwarm {
    final saved = _closedHistory.whereType<ClosedSwarm>().lastOrNull;
    return saved != null && _canReopenSwarm(saved);
  }

  bool get canReopenLastClosed =>
      _closedHistory.isNotEmpty &&
      canReopenClosed(_closedHistory.last.historyId);

  bool canReopenClosed(String historyId) {
    if (_disposed) return false;
    final entry = _closedHistory
        .where((entry) => entry.historyId == historyId)
        .firstOrNull;
    if (entry is ClosedSwarm) return _canReopenSwarm(entry);
    if (entry is! ClosedAgent) return false;
    final target = swarms.where((s) => s.id == entry.swarmId).firstOrNull;
    return target == null ||
        target.panes.length < maxPanes ||
        target.panes.any(
          (p) => p.machineId == entry.machineId && p.agentId == entry.agentId,
        );
  }

  bool _canReopenSwarm(ClosedSwarm saved) {
    if (_disposed) return false;
    final target = swarms.where((swarm) => swarm.id == saved.id).firstOrNull;
    if (target == null) return true;
    final present = {
      for (final pane in target.panes) (pane.machineId, pane.agentId),
    };
    final missing = {
      for (final pane in saved.panes)
        if (!present.contains((pane.machineId, pane.agentId)))
          (pane.machineId, pane.agentId),
    };
    return target.panes.length + missing.length <= maxPanes;
  }

  void _rememberClosed(ClosedWork entry) {
    // An unused starter has no work to recover. This also covers empty pages
    // restored from builds that did not mark them as drafts.
    if (entry is ClosedSwarm &&
        Swarm.normalizeName(entry.name) == Swarm.defaultName &&
        entry.panes.isEmpty &&
        entry.presets.isEmpty) {
      return;
    }
    _closedHistory.add(entry);
    if (_closedHistory.length > maxClosedSwarms) _closedHistory.removeAt(0);
  }

  Swarm get activeSwarm => swarms.firstWhere(
    (s) => s.id == _activeSwarmId,
    orElse: () => swarms.first,
  );
  List<TerminalPane> get panes => activeSwarm.panes;
  Iterable<TerminalPane> get allPanes => swarms.expand((s) => s.panes).toSet();
  String get activeSwarmId => activeSwarm.id;

  final _orchestratorProjects = <String, OrchestratorController>{};

  Future<Map<String, dynamic>> orchestratorRequest(
    String machineId,
    Map<String, dynamic> payload,
  ) async {
    if (machineId != localMachineState?.machine.machineId) {
      throw StateError(
        'Orchestrator projects currently run on this computer only.',
      );
    }
    try {
      return await _conn(machineId).request(
        'orchestrator',
        payload: payload,
        timeout: const Duration(seconds: 35),
      );
    } on WsRequestFailure catch (e) {
      if (e.code == 'UNSUPPORTED') {
        throw StateError(
          'Update the local Harness CLI to use the orchestrator.',
        );
      }
      rethrow;
    }
  }

  OrchestratorController orchestratorProject(String machineId, String id) =>
      _orchestratorProjects.putIfAbsent(
        '$machineId/$id',
        () => OrchestratorController(
          id: id,
          request: (payload) => orchestratorRequest(machineId, payload),
        ),
      );

  void openOrchestratorProject(String machineId, String id, String title) {
    final existing = swarms
        .where(
          (s) => s.orchestratorId == id && s.orchestratorMachineId == machineId,
        )
        .firstOrNull;
    if (existing != null) {
      selectSwarm(existing.id);
      return;
    }
    final name = title.trim().replaceAll(RegExp(r'\s+'), ' ');
    newSwarm(
      name: name.isEmpty
          ? 'Orchestrator'
          : name.substring(0, name.length.clamp(0, 48)),
    );
    activeSwarm
      ..kind = 'orchestrator'
      ..orchestratorId = id
      ..orchestratorMachineId = machineId;
    _persistLayout();
    notifyListeners();
  }

  Future<void> inspectOrchestratorAgent(
    String machineId,
    String agentId,
  ) async {
    newSwarm(name: 'Inspect agent');
    await addAgentToSwarm(machineId, agentId, swarmId: activeSwarmId);
  }

  // A New Tab remains temporary until it has content or a custom name.
  // The return destination is session-local; abandoned drafts are never saved.
  final _draftSwarmReturns = <String, String>{};

  bool isDraftSwarm(String id) {
    if (!_draftSwarmReturns.containsKey(id)) return false;
    final swarm = swarms.where((swarm) => swarm.id == id).firstOrNull;
    return swarm != null &&
        swarm.panes.isEmpty &&
        swarm.name == Swarm.defaultName &&
        swarm.presets.isEmpty;
  }

  void newSwarm({String name = Swarm.defaultName, bool draft = false}) {
    name = Swarm.normalizeName(name);
    // Every New Tab entry point reuses the existing start page, including
    // when another tab is selected or the tab limit has been reached.
    if (name == Swarm.defaultName) {
      final starter = activeSwarm.isEmptyStarter
          ? activeSwarm
          : swarms.where((swarm) => swarm.isEmptyStarter).firstOrNull;
      if (starter != null) {
        if (starter.id != activeSwarmId) selectSwarm(starter.id);
        return;
      }
    }
    while (swarms.any((s) => s.id == 'swarm-$_nextSwarmId')) {
      _nextSwarmId++;
    }
    final swarm = Swarm(id: 'swarm-${_nextSwarmId++}', name: name);
    if (draft) {
      _draftSwarmReturns[swarm.id] =
          _draftSwarmReturns[activeSwarmId] ?? activeSwarmId;
    }
    swarms.add(swarm);
    selectSwarm(swarm.id);
  }

  /// The Harness Store takes over the tab it was opened from — the New Tab
  /// whose start page carries the card — exactly as the first agent takes
  /// over a New Tab. One store tab per window, like one New Tab: when it is
  /// already open somewhere, that one is selected. From a tab with panes it
  /// gets a tab of its own.
  ///
  /// [harness] opens the Store straight on that harness's page — the model
  /// picker's door when Grid is not installed yet. Held until the Store tab
  /// reads it ([takePendingStoreHarness]): the tab may exist already, or be
  /// about to be built, and either way the page turns exactly once.
  void openStore({String? harness}) {
    if (harness != null) _pendingStoreHarness = harness;
    final current = activeSwarm;
    if (current.isStore) {
      if (harness != null) notifyListeners();
      return;
    }
    final existing = swarms.where((swarm) => swarm.isStore).firstOrNull;
    if (existing != null) {
      selectSwarm(existing.id);
      return;
    }
    if (current.isEmptyStarter) {
      current
        ..kind = 'store'
        ..name = Swarm.storeName;
      _draftSwarmReturns.remove(current.id);
      _persistLayout();
      notifyListeners();
      return;
    }
    while (swarms.any((s) => s.id == 'swarm-$_nextSwarmId')) {
      _nextSwarmId++;
    }
    final swarm = Swarm(
      id: 'swarm-${_nextSwarmId++}',
      name: Swarm.storeName,
      kind: 'store',
    );
    swarms.add(swarm);
    selectSwarm(swarm.id);
  }

  String? _pendingStoreHarness;

  /// The harness page [openStore] was asked for, handed over once. The Store
  /// tab reads it when it is built and on every change while it is open.
  String? takePendingStoreHarness() {
    final id = _pendingStoreHarness;
    _pendingStoreHarness = null;
    return id;
  }

  void selectSwarm(String id, {bool attachPending = true}) {
    if (!swarms.any((s) => s.id == id)) return;
    if (id != activeSwarmId && isDraftSwarm(activeSwarmId)) {
      final abandoned = activeSwarmId;
      swarms.removeWhere((swarm) => swarm.id == abandoned);
      _draftSwarmReturns.remove(abandoned);
    }
    _activeSwarmId = id;
    railFocused = false;
    final pane = focusedPane;
    selectedMachineId = pane?.machineId;
    _persistLayout();
    _announceAppFocus();
    if (attachPending) {
      for (final machine in machineStates.values) {
        _attachPendingPanes(machine, retryExisting: false);
      }
    }
    notifyListeners();
  }

  /// Cancel an untouched New Tab without closing a session or recording
  /// Recently Closed. A sole workspace remains the app's starting screen.
  bool cancelSwarmDraft(String id) {
    final returnId = _draftSwarmReturns[id];
    final target = swarms.where((swarm) => swarm.id == id).firstOrNull;
    if (returnId == null ||
        target == null ||
        target.panes.isNotEmpty ||
        target.name != Swarm.defaultName ||
        target.presets.isNotEmpty ||
        swarms.length == 1) {
      return false;
    }
    final wasActive = activeSwarmId == id;
    swarms.remove(target);
    _draftSwarmReturns.remove(id);
    if (wasActive) {
      selectSwarm(
        swarms.any((swarm) => swarm.id == returnId) ? returnId : swarms.last.id,
      );
    } else {
      _persistLayout();
      notifyListeners();
    }
    return true;
  }

  /// Navigate to an existing view without opening, retrying or taking control
  /// of a terminal. A shared view prefers the current Swarm, then the requested
  /// owner. Publish the destination and its focus together, preserving layout.
  bool revealAgentView(
    String machineId,
    String agentId, {
    String? preferredSwarmId,
  }) {
    if (_disposed) return false;
    bool contains(Swarm swarm) => swarm.panes.any(
      (p) => p.machineId == machineId && p.agentId == agentId,
    );
    final owner = contains(activeSwarm)
        ? activeSwarm
        : swarms
                  .where((s) => s.id == preferredSwarmId && contains(s))
                  .firstOrNull ??
              swarms.where(contains).firstOrNull;
    if (owner == null) return false;
    final pane = owner.panes.firstWhere(
      (p) => p.machineId == machineId && p.agentId == agentId,
    );
    if (owner == activeSwarm) {
      focusPane(pane.id, reveal: true);
      return true;
    }
    if (owner.focusedPaneId != pane.id) {
      owner.previousPaneId = owner.focusedPaneId;
      owner.focusedPaneId = pane.id;
    }
    if (owner.zoomedPaneId != null) owner.zoomedPaneId = pane.id;
    _activeSwarmId = owner.id;
    railFocused = false;
    selectedMachineId = machineId;
    _paneFocusRequest++;
    _persistLayout();
    _announceAppFocus();
    notifyListeners();
    return true;
  }

  /// Command-number follows the current visual tab order, retaining each tab's
  /// focused pane. A missing position is a no-op, never a pane selection.
  void selectSwarmByIndex(int index) {
    if (index < 0 || index >= swarms.length) return;
    selectSwarm(swarms[index].id);
  }

  void stepSwarm(int delta) {
    final index = swarms.indexOf(activeSwarm);
    selectSwarm(swarms[(index + delta) % swarms.length].id);
  }

  void renameSwarm(String id, String name) {
    final clean = name.trim();
    if (clean.isEmpty) return;
    final swarm = swarms.where((s) => s.id == id).firstOrNull;
    if (swarm == null) return;
    swarm.name = clean.length > 80 ? clean.substring(0, 80) : clean;
    _persistLayout();
    notifyListeners();
  }

  void reorderSwarm(String id, int destination) {
    final index = swarms.indexWhere((s) => s.id == id);
    if (index < 0) return;
    final swarm = swarms.removeAt(index);
    swarms.insert(destination.clamp(0, swarms.length), swarm);
    _persistLayout();
    notifyListeners();
  }

  Future<void> closeSwarm(String id) async {
    if (cancelSwarmDraft(id)) return;
    final index = swarms.indexWhere((s) => s.id == id);
    if (index < 0) return;
    // Held ⌘W must not manufacture and close an endless sequence of blank
    // welcome tabs, evicting the real work from recently closed history.
    if (swarms.length == 1 &&
        swarms.single.panes.isEmpty &&
        swarms.single.name == Swarm.defaultName &&
        swarms.single.presets.isEmpty) {
      return;
    }
    final removed = swarms.removeAt(index);
    Swarm? replacement;
    if (swarms.isEmpty) {
      replacement = Swarm(id: 'swarm-${_nextSwarmId++}');
      swarms.add(replacement);
    }
    _rememberClosed(
      ClosedSwarm(
        removed,
        historyId: 'closed-${_nextClosedHistoryId++}',
        index: index,
        replacement: replacement,
        engine: removed.panes.length == 1
            ? stateOf(removed.panes.single.machineId)?.agents
                      .where(
                        (agent) => agent.id == removed.panes.single.agentId,
                      )
                      .firstOrNull
                      ?.identityEngine ??
                  removed.panes.single.session?.engineId
            : null,
      ),
    );
    if (_activeSwarmId == id) {
      _activeSwarmId = swarms[index.clamp(0, swarms.length - 1)].id;
    }
    _persistLayout();
    notifyListeners();
    selectedMachineId = focusedPane?.machineId;
    _announceAppFocus();
    for (final machine in machineStates.values) {
      _attachPendingPanes(machine);
    }
    for (final pane in removed.panes) {
      if (!allPanes.contains(pane)) await _detachSession(pane, sendClose: true);
    }
  }

  void reopenClosedSwarm({String? historyId}) {
    if (_disposed) return;
    final index = _closedHistory.lastIndexWhere(
      (entry) =>
          entry is ClosedSwarm &&
          (historyId == null || entry.historyId == historyId),
    );
    if (index < 0) return;
    final saved = _closedHistory[index] as ClosedSwarm;
    if (!_canReopenSwarm(saved)) return;
    _closedHistory.removeAt(index);
    if (swarms.length == 1 && saved.replacesUntouchedWelcome(swarms.single)) {
      swarms.clear();
    }
    final pool = {
      for (final pane in allPanes) (pane.machineId, pane.agentId): pane,
    };
    final target = swarms.where((swarm) => swarm.id == saved.id).firstOrNull;
    if (target != null) {
      // Reopening an individual agent may have restored this swarm already.
      // Reunite its missing views without cloning the tab or overwriting edits
      // made since then. Live peers keep their terminal, draft and selection.
      final present = {
        for (final pane in target.panes) (pane.machineId, pane.agentId),
      };
      final previousCount = target.panes.length;
      for (final entry in saved.panes) {
        if (!present.add((entry.machineId, entry.agentId))) continue;
        target.panes.add(
          pool.putIfAbsent(
            (entry.machineId, entry.agentId),
            () => TerminalPane(
              id: _nextPaneId++,
              machineId: entry.machineId,
              agentId: entry.agentId,
            )..composerVisible = entry.composerVisible,
          ),
        );
      }
      if (target.panes.length != previousCount) {
        // An old manual shape for this count describes different membership.
        // Keep current presets/pins and use the normal layout for added views.
        target.paneSizes.remove('${target.panes.length}:manual');
        target.arranged = null;
        target.arrangedKey = null;
      }
      target.focusedPaneId ??= target.panes.firstOrNull?.id;
      _paneFocusRequest++;
      selectSwarm(target.id);
      return;
    }
    final restored = Swarm(id: saved.id, name: saved.name, kind: saved.kind)
      ..orchestratorId = saved.orchestratorId
      ..orchestratorMachineId = saved.orchestratorMachineId
      ..gridColumns = saved.gridColumns
      ..presets.addAll(saved.presets)
      ..paneSizes.addAll(saved.paneSizes);
    for (final entry in saved.panes) {
      final pane = pool.putIfAbsent(
        (entry.machineId, entry.agentId),
        () => TerminalPane(
          id: _nextPaneId++,
          machineId: entry.machineId,
          agentId: entry.agentId,
        )..composerVisible = entry.composerVisible,
      );
      restored.panes.add(pane);
      if (entry.pinnedSlot != null) {
        restored.pinnedSlots[pane.id] = entry.pinnedSlot!;
      }
    }
    int? paneAt(int index) => index >= 0 && index < restored.panes.length
        ? restored.panes[index].id
        : null;
    restored.focusedPaneId =
        paneAt(saved.focus) ?? restored.panes.firstOrNull?.id;
    restored.previousPaneId = paneAt(saved.previousFocus);
    restored.zoomedPaneId = paneAt(saved.zoom);
    swarms.insert(saved.index.clamp(0, swarms.length), restored);
    selectSwarm(restored.id);
  }

  /// Reopen the chosen closure, or the newest closure for Cmd-Shift-T.
  /// Membership is restored synchronously; a slow detach cannot resurrect an
  /// old controller or redirect the destination after a network wait.
  bool reopenClosed({String? historyId}) {
    final id = historyId ?? _closedHistory.lastOrNull?.historyId;
    if (id == null || !canReopenClosed(id)) return false;
    final index = _closedHistory.indexWhere((entry) => entry.historyId == id);
    final saved = _closedHistory[index];
    if (saved is ClosedSwarm) {
      reopenClosedSwarm(historyId: id);
      return true;
    }
    final agent = saved as ClosedAgent;
    _closedHistory.removeAt(index);
    var target = swarms.where((s) => s.id == agent.swarmId).firstOrNull;
    if (target == null) {
      target = Swarm(id: agent.swarmId, name: agent.swarmName);
      swarms.add(target);
    }
    final pane =
        allPanes
            .where(
              (p) =>
                  p.machineId == agent.machineId && p.agentId == agent.agentId,
            )
            .firstOrNull ??
        (TerminalPane(
          id: _nextPaneId++,
          machineId: agent.machineId,
          agentId: agent.agentId,
        )..composerVisible = agent.composerVisible);
    if (!target.panes.contains(pane)) {
      final restoreManual =
          agent.manualLayout != null &&
          listEquals(
            target.panes.map((p) => (p.machineId, p.agentId)).toList(),
            agent.remainingAgents,
          ) &&
          (target.panes.length == 1 ||
              listEquals(
                target.manualLayout?.tiles,
                agent.manualLayout!.remove(agent.index)?.tiles,
              ));
      if (restoreManual) {
        target.pinnedSlots.updateAll(
          (_, slot) => slot >= agent.index ? slot + 1 : slot,
        );
      }
      target.panes.insert(agent.index.clamp(0, target.panes.length), pane);
      if (restoreManual) {
        target.savePaneSizes(
          '${target.panes.length}:manual',
          agent.manualLayout!,
        );
      } else if (agent.manualLayout != null) {
        target.paneSizes.remove('${target.panes.length}:manual');
      }
      if (agent.pinnedSlot != null &&
          !target.pinnedSlots.containsValue(agent.pinnedSlot)) {
        target.pinnedSlots[pane.id] = agent.pinnedSlot!;
      }
    }
    if (target.focusedPaneId != pane.id) {
      target.previousPaneId = target.focusedPaneId;
    }
    target.focusedPaneId = pane.id;
    if (agent.zoomed || target.zoomedPaneId != null) {
      target.zoomedPaneId = pane.id;
    }
    _activeSwarmId = target.id;
    _settlePins();
    _paneFocusRequest++;
    selectSwarm(target.id);
    return true;
  }

  /// Capture the destination before any network wait or tab change.
  Future<void> addAgentToSwarm(
    String machineId,
    String agentId, {
    String? swarmId,
  }) => assignAgentToPane(null, machineId, agentId, swarmId: swarmId);

  Future<void> seedSwarm(
    String name,
    List<({String machineId, String agentId})> agents,
  ) async {
    final target = activeSwarm;
    renameSwarm(target.id, name);
    // Each call records membership synchronously, before its attachment waits.
    // A slow/offline host must not hold back the other panes or retarget a tab.
    final attachments = <Future<void>>[];
    for (final agent in agents) {
      attachments.add(
        addAgentToSwarm(agent.machineId, agent.agentId, swarmId: target.id),
      );
    }
    await Future.wait(attachments);
  }

  /// Which tile the keyboard, the dial and the rail's highlight all mean.
  ///
  /// Typing itself does NOT go through this on macOS — the renderer is a
  /// WebView, so a click makes that pane's WKWebView the first responder and
  /// AppKit routes keys there without asking. This is for everything that has
  /// no pointer behind it: the dial's scroll and focus frames, and which agent
  /// the rail draws as current.
  int? get focusedPaneId => activeSwarm.focusedPaneId;
  set focusedPaneId(int? value) => activeSwarm.focusedPaneId = value;

  int _paneFocusRequest = 0;

  /// Explicit navigation must reveal and refocus even an already-selected pane.
  int get paneFocusRequest => _paneFocusRequest;

  /// An explicit relayout reveals live output even in tiles whose rectangle
  /// does not change. This is view intent, so it is never persisted.
  int _paneLayoutRequest = 0;
  int get paneLayoutRequest => _paneLayoutRequest;

  /// The chosen shape for a grid of this size, or the shipped one.
  Map<int, PanePreset> get panePresets => activeSwarm.presets;

  PanePreset? presetFor(int paneCount) =>
      panePresets[paneCount] ?? PanePreset.defaultFor(paneCount);

  /// Choosing a preset also resets custom sizes for that pane count. Selecting
  /// the current preset in Command-S is the quick way back to its proportions.
  void setPreset(int paneCount, PanePreset preset) {
    if (!preset.supportsCount(paneCount)) return;
    final resized = activeSwarm.paneSizes.keys.any(
      (key) => key.startsWith('$paneCount:'),
    );
    _paneLayoutRequest++;
    if (presetFor(paneCount) == preset && !resized) {
      notifyListeners();
      return;
    }
    panePresets[paneCount] = preset;
    activeSwarm.paneSizes.removeWhere(
      (key, _) => key.startsWith('$paneCount:'),
    );
    activeSwarm.arranged = null;
    activeSwarm.arrangedKey = null;
    notifyListeners();
    _persistLayout();
  }

  int _paneResizeRequest = 0;
  int get paneResizeRequest => _paneResizeRequest;
  void beginPaneResize() {
    if (panes.length < 2 || zoomedPaneId != null) return;
    _paneResizeRequest++;
    notifyListeners();
  }

  PaneSplitRequest? preparePaneSplit(PaneResizeAxis axis, {int? paneId}) {
    if (zoomedPaneId != null || panes.length >= maxPanes) return null;
    final targetId = paneId ?? focusedPaneId;
    final before = activeSwarm.arranged;
    final minimum = activeSwarm.arrangedMinimum;
    final index = panes.indexWhere(
      (p) => p.id == targetId && p.agentId != null,
    );
    if (before == null ||
        minimum == null ||
        before.tiles.length != panes.length) {
      return null;
    }
    final after = before.split(index, axis, minimum: minimum);
    if (after == null || targetId == null) return null;
    return PaneSplitRequest(
      swarmId: activeSwarmId,
      paneId: targetId,
      axis: axis,
      paneIds: panes.map((p) => p.id),
      before: before,
      after: after,
    );
  }

  bool isPaneSplitCurrent(PaneSplitRequest split) {
    final target = swarms.where((s) => s.id == split.swarmId).firstOrNull;
    final minimum = target?.arrangedMinimum;
    return !_disposed &&
        target != null &&
        target.zoomedPaneId == null &&
        minimum != null &&
        listEquals(target.panes.map((p) => p.id).toList(), split.paneIds) &&
        listEquals(target.arranged?.tiles, split.before.tiles) &&
        split.before.split(
              split.paneIds.indexOf(split.paneId),
              split.axis,
              minimum: minimum,
            ) !=
            null;
  }

  /// Drag frames only update in-memory intent. The completed gesture performs
  /// one ordinary coalesced layout save; terminal sessions remain untouched.
  bool resizePanes(
    String swarmId,
    String layoutKey,
    PaneArrangement arrangement, {
    bool persist = true,
  }) {
    if (activeSwarmId != swarmId ||
        zoomedPaneId != null ||
        arrangement.tiles.length != panes.length ||
        activeSwarm.arrangedKey != layoutKey) {
      return false;
    }
    if (identical(activeSwarm.paneSizes[layoutKey], arrangement)) {
      if (persist) _persistLayout();
      return true;
    }
    activeSwarm.savePaneSizes(layoutKey, arrangement);
    activeSwarm.arranged = arrangement;
    _paneLayoutRequest++;
    notifyListeners();
    if (persist) _persistLayout();
    return true;
  }

  void resetPaneSizes() {
    setPreset(panes.length, presetFor(panes.length) ?? PanePreset.auto);
  }

  int _nextPaneId = 1;

  static const maxPanes = 64;
  // Set only while `harness login --force --json` is waiting for the user to finish SSO in their system
  // browser. It arrives PART WAY THROUGH the flow — the CLI has to start before it can hand one
  // over. It identifies the current sign-in link; [signingIn] tracks the whole
  // attempt, including CLI startup and workspace restoration.
  String? pendingAuthorizeUrl;
  bool openingLoginBrowser = false;
  String? loginBrowserError;
  int _loginBrowserRevision = 0;
  bool _loginAuthorized = false;
  bool get canCancelLogin => signingIn && !_loginAuthorized;

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
    this.connectionForTest,
    SignInClient? cliLogin,
    CliLink? cliLink,
    PeerLinkClient? peerLinks,
    ViewerServices? viewer,
    PaneLayoutStore? paneLayoutStore,
    this.turnActivityTimeout = const Duration(seconds: 12),
  }) : _paneLayout = paneLayoutStore,
       // Remembers "a dial has been seen here" on the same terms the pane
       // layout is remembered: with a layout store there is a state file, and
       // without one (the tests) nothing is written anywhere.
       dial = DialState(paneLayoutStore?.storage),
       agentPreference = AgentPreference(paneLayoutStore?.storage),
       projectHistory = ProjectHistory(paneLayoutStore?.storage),
       session = authSession,
       _store = configStore,
       cliLink = cliLink ?? CliLink(),
       config = configStore?.config ?? config,
       viewer =
           viewer ??
           (kViewerMode
               ? ViewerServices(
                   config: configStore?.config ?? config,
                   session: authSession,
                 )
               : null) {
    this.cliLogin = cliLogin ?? this.viewer?.login ?? CliLogin();
    this.peerLinks = peerLinks ?? this.viewer?.links ?? this.cliLink;
    _autonomousEnv = this.config.autonomousEnv;
    api = _newApiClient();
    // `grid.AppTheme.palette`, not the prefs store: main.dart copies the saved
    // choice into the palette notifier while rebuilding, so the store fires
    // before the colours the panes actually use have moved.
    grid.AppTheme.palette.addListener(_announceTerminalThemeEverywhere);
    terminalThemeStore.addListener(_announceTerminalThemeEverywhere);
  }

  /// Through the local CLI in a desktop build; straight to the backend, signed, in a viewer.
  ApiClient _newApiClient() =>
      ApiClient(config: config, session: session, auth: viewer?.auth);

  String? get lastError => _lastError;

  /// The machine list's own failure, separate from [lastError] — that slot is shared with agent-launch
  /// and other one-off errors, and is cleared by [dismissError]. A pane asking "is this machine missing
  /// because we could not read the list?" needs the narrower question.
  String? get machineListError => _machineLoadError;

  /// True when the machine list on screen came from the daemon's cache because the backend could not be
  /// reached. The rows are the last known-good ones, not current.
  bool machinesAreStale = false;

  /// Whether a machine-list recovery is armed. Mirrors [environmentRecheckPending] — the honest way for a
  /// test to ask "is this still trying?" without reaching into a private timer.
  bool get machineRecoveryPending => _machineRecoveryTimer != null;
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
  static const localDaemonReconnectDelay = Duration(seconds: 1);
  static const agentSyncInterval = Duration(seconds: 60);

  MachineState? stateOf(String machineId) => machineStates[machineId];

  /// True when the CLI on [machineId] runs inside WSL2 while this GUI runs on
  /// Windows — the one case where "this is my computer" does NOT mean "we share
  /// a filesystem" (see [machineSharesGuiFilesystem]).
  bool _localMachineRunsInWsl(String machineId) {
    if (!Platform.isWindows) return false;
    final state = machineStates[machineId];
    if (state == null || !state.isLocalMachine) return false;
    return _localCliInWsl;
  }

  /// Whether a folder chosen by the GUI's own picker can be opened by the CLI on
  /// [machineId].
  ///
  /// The dialogs ask this instead of `isLocalMachine`, because a native panel on
  /// Windows browses THIS filesystem and a WSL2 CLI cannot open a Windows path.
  /// Where it is false the app browses the backend's filesystem over the
  /// daemon's `fs_list_dir` RPC — the flow that already exists for remote
  /// machines — and any GUI path that still arrives is converted or refused by
  /// [backendFolderFor].
  bool machineSharesGuiFilesystem(String machineId) {
    final state = machineStates[machineId];
    if (state == null || !state.isLocalMachine) return false;
    return !_localMachineRunsInWsl(machineId);
  }

  /// The path to hand the CLI for [folder] on [machineId], or an error sentence.
  ///
  /// This is the single choke point for the GUI-filesystem question: an agent's
  /// `cwd` and a Codex profile folder both go through it, so either can only
  /// ever send a path the selected backend can open. `error` is non-null exactly
  /// when the path cannot be expressed on the backend.
  ({String? path, String? error}) backendFolderFor(
    String machineId,
    String? folder,
  ) {
    if (folder == null) return (path: null, error: null);
    if (!_localMachineRunsInWsl(machineId)) {
      return (path: folder, error: null);
    }
    final distro = debugLocalCliWslDistro ?? _discovery.wslDistro;
    final converted = BackendPath.toBackend(
      folder,
      backendIsWsl: true,
      distro: distro,
    );
    if (converted != null) return (path: converted, error: null);
    return (
      path: null,
      error:
          'That folder is on Windows, but the Harness CLI on this machine runs '
          'inside WSL2${distro == null ? '' : ' ($distro)'}. Choose a folder '
          'inside the distribution, or enter a path it can open — for example '
          '/home/<user>/project or /mnt/c/Users/<user>/project.',
    );
  }

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
  final AgentPreference agentPreference;
  final ProjectHistory projectHistory;

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
      allPanes.where((pane) => pane.machineId == machineId);

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

  void focusPane(int paneId, {bool reveal = false}) {
    if (!panes.any((pane) => pane.id == paneId)) return;
    final moved = focusedPaneId != paneId || railFocused;
    railFocused = false;
    // Remembered only on a REAL move. Re-focusing the tile you are already on
    // happens constantly — see the note below about why it is announced anyway
    // — and recording it would make ⌘; a key that returns you to where you
    // already are, which is the same as a key that does nothing.
    if (moved) _previousPaneId = focusedPaneId;
    focusedPaneId = paneId;
    selectedMachineId = focusedPane?.machineId;
    if (reveal) _paneFocusRequest++;
    if (zoomedPaneId != null) zoomedPaneId = paneId;
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
    _announceAppFocus();
    if (moved) _persistLayout();
    if (moved || reveal) notifyListeners();
  }

  String? _announcedFocusMachineId;
  String? _deviceFocusRevision;

  @visibleForTesting
  Future<bool> Function(String machineId, String? agentId)?
  focusFrameSenderForTest;

  /// Publish the selected pane to the existing local CLI connection. The CLI
  /// shares this focus with paired devices and the dial; terminal attachments
  /// and operating-system window activation do not define the selected agent.
  /// The colours the panes are actually painted with — the terminal theme in
  /// force, not the app palette by assumption (Tango is its own scheme).
  static Map<String, String> terminalThemeColours() {
    final theme = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    );
    String hex(Color color) =>
        '#${(color.toARGB32() & 0xFFFFFF).toRadixString(16).padLeft(6, '0')}';
    return {
      'background': hex(theme.background),
      'foreground': hex(theme.foreground),
    };
  }

  /// Tells one machine's daemon the pane colours (`theme_set`, answered by
  /// the CLI's lib/hostTheme.ts). Fire-and-forget: a daemon that predates the
  /// type cannot open the envelope and goes silent, and that is nothing to
  /// put on the error strip — the pane still opens, only a TUI's palette may
  /// guess wrong there.
  void _announceTerminalTheme(String machineId) {
    if (_disposed) return;
    final connection = _pool != null || connectionForTest != null
        ? _conn(machineId)
        : null;
    if (connection == null) return;
    unawaited(
      connection
          .request(
            'theme_set',
            payload: terminalThemeColours(),
            timeout: const Duration(seconds: 5),
          )
          .catchError((Object error) {
            appLog.debug('ws', 'theme_set not applied on $machineId: $error');
            return <String, dynamic>{};
          }),
    );
  }

  /// The palette or terminal theme changed: every connected machine hears it,
  /// so a session created after this on any of them starts with the new
  /// colours and existing ones are restyled on the daemon's next scan.
  void _announceTerminalThemeEverywhere() {
    for (final entry in machineStates.entries) {
      if (entry.value.connectionStatus != ConnectionStatus.connected) continue;
      _announceTerminalTheme(entry.key);
    }
  }

  /// What a machine hears the moment its socket is up — first connect, or a
  /// reconnect after its daemon restarted, which has forgotten all of it.
  void _onMachineConnected(String machineId, MachineState machine) {
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
    _announceAppFocus();
    // ...nor what colour its panes are. tmux answers a TUI's "what is my background?"
    // (OSC 10/11 — Codex picks its light or dark diff palette from it) with whichever
    // terminal attached first, unless told; this tells it, for the sessions it owns.
    _announceTerminalTheme(machineId);
    // The local CLI never hands back `connected` until it has terminated E2EE (or confirmed
    // none is needed, for its own machine) — every machine's data is ready to load right away,
    // with no separate app-side readiness gate to wait on anymore.
    if (machine.isLocalMachine) {
      machine.transportMode = MachineTransportMode.localPlaintext;
      // The socket that just connected IS the endpoint. A machine refresh that ran while the
      // daemon was restarting (connection refused, or still scanning) had probed nothing and
      // cleared this — and with it `usesLocalTransport`, which `_canAttachPane` and the pane
      // header both read. The socket then came back on its own 1s retry, `nodeOnline` went true,
      // the offline poll (the one thing that would have re-probed) stopped, and the tiles sat on
      // "Offline" over a live terminal with nothing left to restore them. Measured 2026-09-18 21:50.
      machine.localEndpoint ??= _cliEndpoint;
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
  }

  @visibleForTesting
  void onMachineConnectedForTest(String machineId) {
    final machine = machineStates[machineId];
    if (machine == null) return;
    machine.connectionStatus = ConnectionStatus.connected;
    _onMachineConnected(machineId, machine);
  }

  void _announceAppFocus() {
    final pane = focusedPane;
    // A viewer is its agent's, so focusing it is focusing that agent: the dial
    // and the daemon see one agent at this desk, not a tile they cannot name.
    final agentId = pane?.agentId ?? pane?.ownerAgentId;
    final machineId = agentId == null ? null : pane?.machineId;
    final previousMachineId = _announcedFocusMachineId;
    _announcedFocusMachineId = machineId;
    if (previousMachineId != null && previousMachineId != machineId) {
      _sendAppFocus(previousMachineId, null);
    }
    if (machineId != null) _sendAppFocus(machineId, agentId);
  }

  void _sendAppFocus(String machineId, String? agentId) {
    // Never create a socket just to move focus, and never queue stale focus
    // across a reconnect. The connected callback reasserts the current pane.
    final send = focusFrameSenderForTest;
    final pending = send != null
        ? send(machineId, agentId)
        : _pool?[machineId]?.sendTerminalFrame('app_focus', {
            'agentId': agentId,
            if (_deviceFocusRevision != null)
              'focusRevision': _deviceFocusRevision,
          });
    if (pending != null) unawaited(pending.catchError((_) => false));
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
    // A terminal tile is not the dial's: the dial drives agents, and the daemon
    // never lists a shell to it. Naming one here would make the daemon "hold"
    // an id it has nothing for. The same tile IS named once an engine has been
    // typed into it — `_upsertAgent` re-announces on the engine change.
    bool onDial(TerminalPane pane) {
      final agentId = pane.agentId;
      if (agentId == null) return false;
      final agent = machineStates[pane.machineId]?.agents
          .where((agent) => agent.id == agentId)
          .firstOrNull;
      return !isTerminalEngine(agent?.engine);
    }

    final agentIds = <String>[
      for (final pane in panes)
        if (onDial(pane)) pane.agentId!,
    ];
    // The swarms travel with the tiles: the dial names the one on screen above the agent and offers
    // the others, and a pick there comes back as `dial_swarm`. Names and member ids only — the layout
    // inside a swarm is this window's business.
    final swarmRows = [
      for (final swarm in swarms)
        {
          'id': swarm.id,
          'name': swarm.name,
          'agentIds': [
            for (final pane in swarm.panes)
              if (onDial(pane)) pane.agentId!,
          ],
        },
    ];
    for (final machineId in machineStates.keys) {
      final connection = pool[machineId];
      if (connection == null) continue;
      unawaited(
        connection
            .sendTerminalFrame('app_panes', {'agentIds': agentIds})
            .catchError((_) => false),
      );
      unawaited(
        connection
            .sendTerminalFrame('app_swarms', {
              'active': activeSwarmId,
              'swarms': swarmRows,
            })
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

  /// The person asked to see the prompt again — a deliberate open, not the
  /// reactive gate. Without this, every way in that does not go through
  /// [showMachinePane] (the welcome's Machines row) opened a dialog that its
  /// own "still needed?" check closed on the first frame: one popup, then
  /// nothing, for as long as the app ran.
  void revisitLinkPrompt(String machineId) {
    if (_dismissedLinkPrompts.remove(machineId)) notifyListeners();
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
        api = _newApiClient();
        _skippedDesktopUpdateVersion = _store.skippedDesktopUpdateVersion;
      }
      // A viewer installs nothing and is updated by its store: provisioning and the updater both
      // serve a computer that runs the harness CLI. The updater is not merely useless there — it
      // throws on an architecture it has no channel for (`ios_arm64`), from inside bootstrap.
      if (viewer == null) {
        _startUpdateChecking();
        final environmentReady = await _prepareEnvironment();
        if (!environmentReady) return;
      }
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
    // A viewer has nothing to provision. The provisioner looks for a shell, the
    // POSIX tools, tmux and a managed Node runtime under `~/.harness` — all of
    // which exist to host the local `harness` CLI, which a viewer build does
    // not have and does not want. Running it on a phone reported every step
    // missing and parked the app on a setup screen whose two actions, Retry
    // and Switch to Manual, could not succeed either. Treated as ready so
    // bootstrap goes on to ask about sign-in, which a viewer can answer.
    if (viewer != null) return true;
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
            plan: value.plan,
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
    final revision = _authRevision;
    if (!_authWorkCurrent(revision)) return;
    _cancelEnvironmentRecheckTimer();
    // A viewer skipped the preflight (see [_prepareEnvironment]), so there is no
    // preflight screen to hold while the sign-in is checked — it stays on the
    // boot spinner instead.
    status = viewer == null
        ? AppStatus.checkingEnvironment
        : AppStatus.bootstrapping;
    notifyListeners();
    // Auth now lives entirely with the local `harness` CLI — it owns the SSO session on disk and
    // refreshes it itself. This app never reads, stores, or refreshes a token of its own; it just
    // asks the CLI whether this computer is currently signed in.
    try {
      final authStatus = await cliLogin.checkStatus();
      if (!_authWorkCurrent(revision)) return;
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
      if (!_authWorkCurrent(revision)) return;
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
  /// `ready` — the user fixed it by hand (with the command the review lists) and this
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
      // Every host step done means only the Harness CLI is left, and that
      // installs in-app without another prompt — so carry on into it.
      if (!result.isReady &&
          mode == EnvironmentSetupMode.automatic &&
          result.phase != EnvironmentSetupPhase.waitingForTerminal &&
          result.hostReady) {
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
            plan: result.plan,
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
    api = _newApiClient();
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
  /// the profile and machine list independently over it.
  Future<void> _finishBootstrapSignedIn() async {
    final revision = _authRevision;
    if (!_authWorkCurrent(revision)) return;
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
    // Every exit below clears the message: a boot superseded by a sign-out/sign-in mid-way (the
    // `_authWorkCurrent` returns) used to leave "Starting local service…" on a screen nothing would
    // ever repaint.
    await _restorePaneLayout();
    if (!_authWorkCurrent(revision)) {
      _bootStatusMessage = null;
      return;
    }
    await dial.restore();
    if (!_authWorkCurrent(revision)) {
      _bootStatusMessage = null;
      return;
    }
    _ensurePool();
    try {
      await ensureCliDaemonReady();
    } catch (error) {
      _bootStatusMessage = null;
      if (!_authWorkCurrent(revision)) return;
      status = AppStatus.authenticated;
      _lastError = '$error';
      _lastErrorRetryable = true;
      notifyListeners();
      return;
    }
    _bootStatusMessage = null;
    if (!_authWorkCurrent(revision)) return;
    // `ensureCliDaemonReady` may have signed the app out instead of succeeding (daemon absent AND
    // the saved session gone) — that already routed to the login screen, so don't clobber it.
    if (status == AppStatus.unauthenticated) return;
    status = AppStatus.authenticated;
    notifyListeners();
    // The CLI has confirmed sign-in and daemon readiness. Display-name/avatar
    // metadata is independent of machine discovery and must not delay work.
    unawaited(_loadProfile());
    try {
      await refreshMachines();
    } catch (error) {
      if (!_authWorkCurrent(revision)) return;
      _reportMachineLoadError(error);
    }
    if (_authWorkCurrent(revision)) notifyListeners();
  }

  /// The local daemon (`harness start`) must be up before any local REST/WS call can work — unlike
  /// `harness login`, it does not start on its own. Sets [_cliEndpoint], the dial target every
  /// machine's WsConn now uses. Public (like [refreshMachines]) so a test subclass can stub it
  /// without shelling out to a real `harness` binary.
  /// Who is signed in, from the daemon. Shared by the boot path and by the
  /// retry path, because a boot that found the daemon still connecting now
  /// finishes THROUGH the retry path — and a session that never learns its
  /// own account has an empty footer and unattributed analytics.
  Future<void> _loadProfile() {
    final pending = _profileInFlight;
    if (pending != null) return pending;
    final revision = _authRevision;
    late final Future<void> load;
    load = _readProfile(revision).whenComplete(() {
      if (identical(_profileInFlight, load)) _profileInFlight = null;
    });
    _profileInFlight = load;
    return load;
  }

  Future<void> _readProfile(int revision) async {
    try {
      final me = await api.me();
      if (!_authWorkCurrent(revision) || status != AppStatus.authenticated) {
        return;
      }
      if (me != null) {
        final profile = CurrentUserProfile.fromMe(me);
        currentUser = profile;
        // Every event from here on is filed under the account, including ones
        // queued while this call was still in flight — the queue reads the
        // account per event, not per launch.
        analyticsAccount.set(id: profile.id, email: profile.email);
        notifyListeners();
      }
    } catch (error) {
      if (_authWorkCurrent(revision)) {
        debugPrint('bootstrap: profile unavailable: $error');
      }
    }
  }

  Future<void> ensureCliDaemonReady() async {
    // A viewer has no daemon to start: it reaches every machine through the relay.
    if (viewer != null) return;
    final revision = _authRevision;
    final discovery = _discovery;
    final probe = await discovery.ensureRunning();
    if (!_authWorkCurrent(revision)) return;
    _logDaemonProbe(probe);
    switch (probe.state) {
      case LocalCliProbeState.ready:
        _cliEndpoint = probe.endpoint;
        _daemonGateFailed = false;
        _noteBackendOnline(probe.endpoint!.backendOnline);
      case LocalCliProbeState.notReady:
        _daemonGateFailed = true;
        // Running, not ready — most often a daemon fresh from a self-update still shaking hands
        // with the backend. Not "did not start": that sentence sends people to run `harness start`
        // against a daemon that is up, and the CLI's own lock will just tell them so. It keeps
        // retrying by itself; the supervisor below picks the app up the moment it gets there.
        _startDaemonSupervision(discovery);
        throw StateError(
          'Harness is running${probe.version == null ? '' : ' (v${probe.version})'} but is not '
          'ready yet — ${probe.reason}. It usually finishes on its own; retry in a moment.',
        );
      case LocalCliProbeState.down:
        _daemonGateFailed = true;
        // Before blaming the environment, check whether the daemon is missing because it signed itself
        // out. "Try running `harness start` yourself" is advice that cannot work in that case — the
        // session file is gone, so every start exits again — and it is the advice this branch used to
        // give unconditionally.
        final authStatus = await cliLogin.checkStatus();
        if (!_authWorkCurrent(revision)) return;
        if (!authStatus.loggedIn) {
          _signedOutAtRuntime(_signedOutMessage);
          return;
        }
        throw StateError(
          'The local Harness daemon did not start. Try running `harness start` yourself, then reopen the app.',
        );
    }
    _startDaemonSupervision(discovery);
  }

  /// One line per probe STATE the gate lands in, never per tick: this gate was silent, and the one
  /// machine that sat on "Starting local service…" for good had nothing in any log to say why.
  void _logDaemonProbe(LocalCliProbe probe) {
    final line = switch (probe.state) {
      LocalCliProbeState.ready =>
        'ready · backend ${probe.endpoint!.backendOnline ? 'online' : 'OFFLINE'}'
            '${probe.version == null ? '' : ' · v${probe.version}'}',
      LocalCliProbeState.notReady =>
        'not ready · ${probe.reason}${probe.version == null ? '' : ' · v${probe.version}'}',
      LocalCliProbeState.down => 'down · ${probe.reason}',
    };
    if (line == _loggedDaemonState) return;
    _loggedDaemonState = line;
    appLog.info('daemon', line);
  }

  /// The daemon's backend link changed (or was first seen). Coming BACK is the moment the app has
  /// been waiting for since it booted offline: the machine list (remote tiles, the real row for this
  /// computer) and the profile can be fetched now, without a click.
  ///
  /// [refetch] is false when the caller IS a machine refresh that just observed the flip through
  /// its own probe — it is already fetching, and a second run beside it would race the same state.
  void _noteBackendOnline(bool online, {bool refetch = true}) {
    if (_backendOnline == online) return;
    final wasOffline = _backendOnline == false;
    _backendOnline = online;
    appLog.info('daemon', 'backend ${online ? 'online' : 'offline'}');
    if (online && wasOffline && status == AppStatus.authenticated) {
      if (refetch && !machinesRefreshing) unawaited(retryMachines());
      if (currentUser == null) unawaited(_loadProfile());
    }
    notifyListeners();
  }

  /// Supervision starts once the daemon is at least ANSWERING — ready or still connecting. It used to
  /// wait for ready, out of fear of a concurrent `harness start` from both places; the supervisor
  /// no longer spawns while anything answers on the port, so that race is gone, and starting it on
  /// a not-ready daemon is what lets a boot that landed mid-update recover without a click.
  void _startDaemonSupervision(LocalCliDiscovery discovery) {
    _daemonSupervisionTimer ??= discovery.startSupervising(
      spawnAllowedAt: inSpawnSlot,
      stillSignedIn: () async => (await cliLogin.checkStatus()).loggedIn,
      onSignedOut: () => _signedOutAtRuntime(_signedOutMessage),
      onSnapshot: _updateLocalProjectSnapshot,
      onBackendOnline: _noteBackendOnline,
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

  void _updateLocalProjectSnapshot(LocalCliEndpoint endpoint) {
    if (_disposed) return;
    var changed = false;
    for (final machine in machineStates.values) {
      final previous = machine.localEndpoint;
      if (previous == null || previous.computerId != endpoint.computerId) {
        continue;
      }
      if (!mapEquals(previous.agentProjects, endpoint.agentProjects)) {
        machine.localEndpoint = endpoint;
        changed = true;
      }
      if (!kUnderTest) {
        for (final project in endpoint.agentProjects.values) {
          unawaited(_localGitProjects.read(project.cwd));
        }
      }
    }
    _applyLocalGitProjects();
    if (changed) notifyListeners();
  }

  void _applyLocalGitProjects() {
    if (_disposed) return;
    var changed = false;
    for (final machine in machineStates.values) {
      final projects = <String, AgentProject>{
        for (final entry
            in (machine.localEndpoint?.agentProjects ??
                    const <String, AgentProject>{})
                .entries)
          entry.key: ?_localGitProjects.cached(entry.value.cwd),
      };
      if (mapEquals(machine.localProjects, projects)) continue;
      machine.localProjects = Map.unmodifiable(projects);
      changed = true;
    }
    if (changed) notifyListeners();
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
    _invalidateAuthWork();
    currentUser = null;
    signingIn = false;
    pendingAuthorizeUrl = null;
    _awaitingFirstMessage = null;
    analyticsAccount.clear();
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
        updateError =
            'Could not download and verify OpenHarness ${info.version}.';
        return false;
      }
      final applied = await updater.applyStaged(staged, selfPid: pid);
      if (!applied) {
        updateError =
            'This copy of OpenHarness cannot install updates automatically.';
        return false;
      }
      exit(0);
    } catch (error) {
      updateError = 'Could not install OpenHarness ${info.version}: $error';
      return false;
    } finally {
      isInstallingUpdate = false;
      if (!_disposed) notifyListeners();
    }
  }

  Future<void> login() async {
    if (_disposed || signingIn) return;
    final revision = _invalidateAuthWork();
    _closedHistory.clear();
    _lastError = null;
    status = AppStatus.bootstrapping;
    signingIn = true;
    pendingAuthorizeUrl = null;
    notifyListeners();
    try {
      await cliLogin.login(
        onAuthorizeUrl: (url) {
          if (!_authWorkCurrent(revision)) return;
          if (pendingAuthorizeUrl == url) return;
          _resetLoginBrowser();
          pendingAuthorizeUrl = url;
          notifyListeners();
          // Through [openLoginBrowser] rather than straight to the launcher, so
          // the first handoff is the same one the login screen's retry button
          // takes and reports its outcome the same way. WHICH browser it opens
          // is decided in `viewer/sign_in_browser.dart`.
          unawaited(openLoginBrowser());
        },
      );
      if (!_authWorkCurrent(revision)) return;
      _loginAuthorized = true;
      pendingAuthorizeUrl = null;
      _resetLoginBrowser();
      notifyListeners();
      await _finishBootstrapSignedIn();
      if (!_authWorkCurrent(revision) || status != AppStatus.authenticated) {
        return;
      }
      analytics.signedIn();
      // Restarts the clock even if `_trackAppOpened` already started one: this
      // person met the login screen, so their wait begins where the launch's
      // did not.
      _armFirstMessage('sign_in');
    } catch (error) {
      if (!_authWorkCurrent(revision)) return;
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
      // Takes the in-app browser view down once the redirect has landed; a no-op
      // where the page opened in a browser of its own.
      unawaited(closeSignInPage());
      // Cleared last, and only here: everything above may still be running when the URL goes, and
      // dropping the flag any earlier is what put a bare spinner over the user's own screen.
      if (_authWorkCurrent(revision)) {
        _resetLoginBrowser();
        _loginAuthorized = false;
        pendingAuthorizeUrl = null;
        signingIn = false;
      }
    }
    if (_authWorkCurrent(revision)) notifyListeners();
  }

  void _resetLoginBrowser() {
    ++_loginBrowserRevision;
    openingLoginBrowser = false;
    loginBrowserError = null;
  }

  /// Reopens the current authorization URL without creating another login.
  Future<void> openLoginBrowser() async {
    final url = pendingAuthorizeUrl;
    if (_disposed || !signingIn || url == null || openingLoginBrowser) return;
    final authRevision = _authRevision;
    final browserRevision = ++_loginBrowserRevision;
    openingLoginBrowser = true;
    loginBrowserError = null;
    notifyListeners();
    var opened = false;
    try {
      final uri = Uri.tryParse(url);
      if (uri != null &&
          uri.hasAuthority &&
          (uri.scheme == 'https' || uri.scheme == 'http')) {
        // Not `launchUrl(..., externalApplication)` directly: on a desktop
        // [openSignInPage] IS that call, and on a phone it must not be. Handing
        // a phone to Safari suspends this app, and with it the loopback listener
        // the page redirects back to — the sign-in could then never land.
        // ⚠️ The reason the desktop insists on a real browser survives here: this
        // SSO page's Google button uses Google's popup-based Identity Services
        // flow, where a popup window posts the result back to its opener. Whether
        // an in-app browser view can satisfy that is open, and flagged in
        // `sign_in_browser.dart`; it is why the phone case is confined to phones
        // rather than made the rule.
        opened = await openSignInPage(uri);
      }
    } catch (_) {
      // Browser handoff failure is recoverable within the same sign-in. Never
      // put a credential-bearing URL or a raw platform exception in the UI.
    }
    if (!_authWorkCurrent(authRevision) ||
        browserRevision != _loginBrowserRevision ||
        pendingAuthorizeUrl != url) {
      return;
    }
    openingLoginBrowser = false;
    if (!opened) {
      loginBrowserError =
          'Couldn’t open your browser. Open it again or copy the sign-in link.';
    }
    notifyListeners();
  }

  /// Return immediately; late URLs, results and browser replies belong to the
  /// cancelled attempt and cannot change a subsequent sign-in.
  void cancelLogin() {
    if (_disposed || !canCancelLogin) return;
    _invalidateAuthWork();
    signingIn = false;
    pendingAuthorizeUrl = null;
    status = AppStatus.unauthenticated;
    _lastError = null;
    _lastErrorRetryable = false;
    cliLogin.cancel();
    notifyListeners();
  }

  Future<void> logout() async {
    final revision = _invalidateAuthWork();
    cliLogin.cancel();
    signingIn = false;
    pendingAuthorizeUrl = null;
    _closedHistory.clear();
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
    if (!_authWorkCurrent(revision)) return;
    _closedHistory.clear();
    await _pool?.closeAll();
    if (!_authWorkCurrent(revision)) return;
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
    sessionPreviews.clear();
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
    if (machine == null) return;
    if (code == 4403) {
      if (machine.isLocalMachine) {
        unawaited(_onLocalMachineMismatch(machine, reason));
      }
      return;
    }
    if (code != 4404) return;
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

  /// The daemon on this computer closed our select with 4403: it serves a different machine id than
  /// the row we hold for "this computer". Ask it which (`/api/status.machineId`), say so in the log —
  /// this used to be a silent reconnect every 30s, forever — and stand its machine up beside the
  /// stale row so the person can keep working; the stale row's tiles are told why they are dark. A
  /// machine list refresh re-keys everything properly once the backend answers.
  Future<void> _onLocalMachineMismatch(
    MachineState machine,
    String reason,
  ) async {
    final machineId = machine.machine.machineId;
    if (!_localMismatchReported.add(machineId)) return;
    final endpoint = viewer == null ? await _discovery.discover() : null;
    final served = endpoint?.machineId;
    appLog.warn(
      'daemon',
      'refused machine_select for $machineId ($reason) — the daemon serves '
          '${served ?? 'an unknown machine id'}',
    );
    if (_disposed || served == null || served == machineId) return;
    _markSessionsUnreachable(
      machine,
      'This computer now runs as a different machine (sign-in changed). Open it from the rail.',
    );
    // Awaited: the close reports `disconnected`, whose handler arms the offline retry — stopping
    // it before that would be undone a microtask later. `_connectMachine` also refuses this id now.
    await _pool?.closeMachine(machineId);
    _stopOfflineRetry(machineId);
    if (!machineStates.containsKey(served)) {
      _adoptLocalMachineFromDaemon(
        endpoint,
        await _discovery.computerId(),
        listUnavailable: _backendOnline == false,
      );
      final adopted = machineStates[served];
      if (adopted != null) {
        adopted.localEndpoint = endpoint;
        adopted.transportMode = MachineTransportMode.localPlaintext;
        _connectMachine(adopted);
      }
    }
    notifyListeners();
    if (_backendOnline != false) unawaited(retryMachines());
  }

  /// Local machine ids a 4403 has already been reported for — one log line and one adoption per
  /// stale id, not one per 30s retry.
  final Set<String> _localMismatchReported = {};

  void _ensurePool() {
    if (_pool != null) return;
    _pool = WsPool(
      wsBaseUrl: config.wsBaseUrl,
      autonomousEnv: _autonomousEnv,
      // Every real desktop WsConn dials the local CLI's loopback WS (transportKind.localPlaintext, see
      // _conn()), which never calls this — only the compile-time-only local-manual dev fixture (see
      // LocalManualFixture) still dials a backend directly with a token.
      accessTokenProvider: (force, failedToken) async {
        final directAuth = viewer?.auth;
        if (directAuth != null) {
          return directAuth.accessToken(force: force, failedToken: failedToken);
        }
        final fixture = localManualFixture;
        if (fixture != null) return fixture.apiKey;
        throw StateError(
          'unreachable: only a viewer build and the local-manual dev fixture use a token-bearing WS transport',
        );
      },
      relayCodecs: viewer?.relayCodecs,
      transportPlugins: viewer?.transportPlugins,
      onAuthFailure: _signedOutAtRuntime,
      onLocalFailure: _onLocalFailure,
      onEvent: _handleEvent,
      onStatus: (machineId, nextStatus) {
        final machine = machineStates[machineId];
        if (machine == null) return;
        machine.connectionStatus = nextStatus;
        if (nextStatus == ConnectionStatus.connected) {
          _onMachineConnected(machineId, machine);
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

  Future<Map<String, dynamic>> manageHarnessShares(
    String machineId,
    String agentId,
    String action, [
    Map<String, dynamic> payload = const {},
  ]) {
    if (machineStates[machineId]?.machine.isShared == true) {
      return Future.error(StateError('Only the owner can change sharing.'));
    }
    return _conn(machineId).request(
      'harness_share_$action',
      payload: {'agentId': agentId, ...payload},
    );
  }

  Future<void> refreshMachines() async {
    final revision = _authRevision;
    if (!_authWorkCurrent(revision)) return;
    if (localManualFixture != null) {
      notifyListeners();
      return;
    }
    if (machines.isEmpty && !machinesLoading) {
      machinesLoading = true;
      notifyListeners();
    }
    try {
      await _refreshMachines(revision);
      if (_authWorkCurrent(revision)) {
        // A cached answer is readable but not current, so the job is not done: leave the recovery timer
        // running and it converges on its own once the backend is back. Without this the daemon's 200
        // would read as success, recovery would stop, and the app would sit on stale rows until
        // somebody pressed reload.
        if (machinesAreStale) {
          _scheduleMachineRecovery(revision);
        } else {
          _stopMachineRecovery();
        }
        if (_lastError != null && _lastError == _machineLoadError) {
          _lastError = null;
          notifyListeners();
        }
        _machineLoadError = null;
      }
    } catch (error) {
      if (_authWorkCurrent(revision)) {
        if (isTransientApiError(error)) {
          _scheduleMachineRecovery(revision);
        } else {
          _stopMachineRecovery();
        }
      }
      rethrow;
    } finally {
      // Said out loud: the list's own notify fires before this, so a flag
      // dropped silently here would leave the rail on its placeholders.
      if (_authWorkCurrent(revision) && machinesLoading) {
        machinesLoading = false;
        notifyListeners();
      }
    }
  }

  void _stopMachineRecovery() {
    _machineRecoveryTimer?.cancel();
    _machineRecoveryTimer = null;
    _machineRecoveryAttempts = 0;
  }

  void _scheduleMachineRecovery(int revision) {
    if (!_authWorkCurrent(revision) ||
        status != AppStatus.authenticated ||
        _machineRecoveryTimer != null) {
      return;
    }
    const seconds = [2, 4, 8, 16, 30];
    final delay = seconds[_machineRecoveryAttempts];
    if (_machineRecoveryAttempts < seconds.length - 1) {
      _machineRecoveryAttempts++;
    }
    _machineRecoveryTimer = Timer(Duration(seconds: delay), () {
      _machineRecoveryTimer = null;
      if (_authWorkCurrent(revision) && status == AppStatus.authenticated) {
        unawaited(
          _retryMachines(automatic: true).whenComplete(() {
            // A timer can join a manual retry already in progress. Keep recovering if that run
            // stopped at the daemon gate; success and non-transient errors reset the counter.
            if (_machineRecoveryAttempts > 0) {
              _scheduleMachineRecovery(revision);
            }
          }),
        );
      }
    });
  }

  void _reportMachineLoadError(Object error, {bool automatic = false}) {
    // Offline is not an error to shout about: the daemon said it has no backend, this computer's
    // machine is standing in from the daemon (see _refreshMachines), and the rail already reads
    // "offline copy". The strip is for a backend that SHOULD be reachable and is not.
    if (_backendOnline == false) {
      machinesAreStale = true;
      // A strip this raised while the backend still looked reachable comes down with it.
      if (_lastError != null && _lastError == _machineLoadError) {
        _lastError = null;
      }
      _machineLoadError = null;
      return;
    }
    final message = 'Could not load machines: ${describeApiError(error)}';
    // A recovery must not replace a later agent error or redisplay a dismissed strip.
    if (!automatic || (_lastError != null && _lastError == _machineLoadError)) {
      _lastError = message;
      _lastErrorRetryable = true;
    }
    _machineLoadError = message;
  }

  /// The machine THIS computer's daemon serves, built from the daemon's own answer
  /// (`/api/status.machineId`) when the backend could not list it — no cache yet, backend down. Its
  /// local WS only selects that exact id (`localWsServer` `machine_select`), so nothing else would
  /// attach. Added, never replaced: a later real list carries the same id and updates the row in
  /// place through `machineStates.update` above. No-op when the daemon is not ready, reports no id,
  /// or a row already exists for it.
  ///
  /// [listUnavailable] is true on the failure path: the rows are then a stand-in for a list that
  /// never came, and the rail says so ("offline copy") while the recovery timer keeps asking. A
  /// fresh list that simply does not name this computer is not stale — marking it so would keep
  /// the recovery timer polling a backend that has already answered.
  void _adoptLocalMachineFromDaemon(
    LocalCliEndpoint? endpoint,
    String? localComputerId, {
    required bool listUnavailable,
  }) {
    final machineId = endpoint?.machineId;
    if (endpoint == null || machineId == null) return;
    if (machineStates.containsKey(machineId)) return;
    final machine = Machine(
      machineId: machineId,
      computerId: localComputerId ?? endpoint.computerId,
      authMode: MachineAuthMode.remote,
      name: localHostnameOrNull(),
      status: 'online',
    );
    machines = [...machines, machine];
    machineStates[machineId] = MachineState(machine)
      ..localOnly = true
      ..nodeOnline = true;
    if (listUnavailable) machinesAreStale = true;
    appLog.info(
      'daemon',
      'no machine list from the backend — this computer stands in from the daemon',
    );
  }

  /// What the loopback probe means for one machine's transport.
  ///
  /// Written once because two callers need the same answer: the refresh loop, and the failure path that
  /// keeps this computer usable when the backend list could not be read.
  void _applyLocalTransport(
    MachineState state,
    LocalCliEndpoint? localEndpoint,
    String? localComputerId,
  ) {
    if (state.localOnly && localEndpoint?.computerId == localComputerId) {
      state.localEndpoint = localEndpoint;
      state.transportMode = state.connectionStatus == ConnectionStatus.connected
          ? MachineTransportMode.localPlaintext
          : MachineTransportMode.localOffline;
    } else if (state.localOnly &&
        localEndpoint == null &&
        state.localEndpoint != null &&
        state.connectionStatus == ConnectionStatus.connected) {
      // The probe found nothing this time (the daemon mid-restart, or mid-scan) but the socket to
      // it is open and answering right now — the socket is the better witness. Keep the endpoint
      // it was dialed through; demoting a live connection to "offline" on a missed probe is what
      // took a working terminal's tiles dark.
      state.transportMode = MachineTransportMode.localPlaintext;
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
  }

  Future<void> _refreshMachines(int revision) async {
    // No machine is "this computer" to a viewer, which has no local CLI: every one — even the one
    // it runs on — is reached through the relay.
    final discovery = viewer == null ? _discovery : null;
    // The CLI computer id is the local identity source of truth. The loopback
    // status endpoint is trusted only when it advertises that same identity.
    final localComputerId = await discovery?.computerId();
    if (!_authWorkCurrent(revision)) return;
    // Null in a viewer build, which has no local CLI to probe — see `discovery` above.
    _localCliInWsl = discovery?.identity.usesWsl ?? false;
    final localFuture =
        discovery?.discover(expectedComputerId: localComputerId) ??
        Future<LocalCliEndpoint?>.value();
    // The two legs stay independent. The loopback probe reads a local file and asks 127.0.0.1, so it
    // cannot fail for a network reason — but awaiting it BEHIND the backend call meant a cloud outage
    // threw first and threw away an answer that was already correct, while awaiting it FIRST would let a
    // slow probe hold up the list. Latch it as it lands instead, and use it on both paths.
    LocalCliEndpoint? probed;
    final localSettled = localFuture.then((value) => probed = value).catchError(
      (Object error) {
        // A probe that fails is the CLI being unreachable, which the transport decision below already
        // handles — but swallowing it silently leaves nothing to diagnose from.
        debugPrint('local CLI probe failed: $error');
        return null;
      },
    );
    final List<Machine> list;
    try {
      list = await _fetchMachines();
      machinesAreStale = api.lastMachinesStale;
    } catch (_) {
      // A backend outage must not cost this computer its own transport. Without this the probe result
      // stayed unapplied, so `usesLocalTransport` went false and `_connectMachine` skipped the local
      // machine — while relayed machines, which never consult it, kept streaming. That asymmetry was the
      // bug: the local terminal stopped rendering and the relayed ones did not.
      await localSettled;
      if (_authWorkCurrent(revision)) {
        final endpoint = probed;
        // The probe is the freshest word on the backend link — fresher than the supervisor's last
        // tick — and it decides whether this failure is an outage to report or just "offline".
        if (endpoint != null) {
          _noteBackendOnline(endpoint.backendOnline, refetch: false);
        }
        // No list and no row for this computer — a first run offline, or a cache the daemon could
        // not serve. The daemon knows the machine it serves; stand it up from that so the person
        // can work locally, exactly as if the backend had listed it.
        _adoptLocalMachineFromDaemon(
          endpoint,
          localComputerId,
          listUnavailable: true,
        );
        for (final state in machineStates.values) {
          _applyLocalTransport(state, endpoint, localComputerId);
          _connectMachine(state);
        }
        if (endpoint != null) _updateLocalProjectSnapshot(endpoint);
        notifyListeners();
      }
      rethrow; // the recovery timer owns the retry; this only protects what already works
    }
    await localSettled;
    // Both legs are in: this is the one gate that decides whether a result that arrived after a
    // sign-out or a dispose may still be published.
    if (!_authWorkCurrent(revision)) return;
    final localEndpoint = probed;
    if (localEndpoint != null) {
      _noteBackendOnline(localEndpoint.backendOnline, refetch: false);
    }
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
    // A retired id the fresh list no longer carries has been re-keyed or removed — its 4403 verdict
    // is over with it. One the list STILL carries keeps the verdict: on the loopback the daemon is
    // the authority for which id it serves, and re-dialing on every 15s refresh would be a 4403
    // and a log line each time.
    _localMismatchReported.removeWhere((id) => !visible.contains(id));
    for (final machine in machines) {
      final state = machineStates.update(
        machine.machineId,
        (state) => state..machine = machine,
        ifAbsent: () => MachineState(machine),
      );
      if (machine.isShared) {
        state.agents = [
          for (final grant in machine.sharedHarnesses)
            Agent(
              id: grant.agentId,
              name: grant.name,
              engine: grant.engine,
              terminalAvailable: true,
            ),
        ];
        state.agentLoadStatus = AgentLoadStatus.loaded;
        state.needsLink = false;
        state.nodeOnline = machine.status == 'running';
        for (final pane in allPanes.where(
          (p) => p.machineId == machine.machineId,
        )) {
          pane.sharedHarness =
              machine.sharedHarnesses
                  .where((g) => g.agentId == pane.agentId)
                  .firstOrNull ??
              pane.sharedHarness;
          pane.sharedOwnerName = machine.ownerName;
        }
        continue;
      }
      state.localOnly =
          localComputerId != null &&
          _normalizeComputerId(machine.computerId) == localComputerId;
      _applyLocalTransport(state, localEndpoint, localComputerId);
      final reportedOnline = _nodeOnlineFromStatus(machine.status);
      if (!state.isLocalMachine &&
          reportedOnline != null &&
          (state.nodeOnline == null || state.nodeOnline != reportedOnline)) {
        unawaited(_applyNodeStatus(state, reportedOnline));
      }
    }
    // A list that arrived but does not name this computer (a stale copy from before this computer
    // was paired, say) still gets the daemon's own row, on the same rule as the failure path.
    if (localEndpoint != null &&
        localEndpoint.machineId != null &&
        !machineStates.containsKey(localEndpoint.machineId)) {
      _adoptLocalMachineFromDaemon(
        localEndpoint,
        localComputerId,
        listUnavailable: false,
      );
      _applyLocalTransport(
        machineStates[localEndpoint.machineId]!,
        localEndpoint,
        localComputerId,
      );
    }
    if (localEndpoint != null) _updateLocalProjectSnapshot(localEndpoint);
    _autoConnectAndLoadMachines();
    _sharingDiscoveryTimer ??= Timer.periodic(const Duration(seconds: 15), (
      _,
    ) async {
      if (_disposed ||
          status != AppStatus.authenticated ||
          _sharingDiscoveryBusy ||
          machinesRefreshing) {
        return;
      }
      final discoveryRevision = _authRevision;
      _sharingDiscoveryBusy = true;
      try {
        await refreshMachines();
      } catch (error) {
        if (_authWorkCurrent(discoveryRevision)) {
          _reportMachineLoadError(error, automatic: true);
          notifyListeners();
        }
      } finally {
        _sharingDiscoveryBusy = false;
      }
    });
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
    isRetryable: (error) => error is DioException && isTransientApiError(error),
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
          prev.project != agent.project ||
          prev.launchState != agent.launchState ||
          prev.launchError != agent.launchError ||
          prev.launchDetail != agent.launchDetail ||
          prev.status != agent.status ||
          prev.terminalAvailable != agent.terminalAvailable ||
          prev.terminalUnavailableReason != agent.terminalUnavailableReason ||
          prev.dsh != agent.dsh ||
          prev.dshName != agent.dshName ||
          prev.viewerUrl != agent.viewerUrl ||
          prev.viewerError != agent.viewerError ||
          prev.viewerName != agent.viewerName ||
          prev.verdict != agent.verdict) {
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
    final result = await peerLinks.connect(
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
    final result = await peerLinks.list();
    linkedMachinesLoading = false;
    linkedMachinesError = result.error;
    linkedMachines = result.machines;
    notifyListeners();
  }

  /// Removes a linked machine's trust pin, then refreshes the list. Returns null on success.
  Future<String?> unlinkMachine(String machineId) async {
    final error = await peerLinks.unlink(machineId);
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
        // The gate never got here (the daemon was down at boot): this is the endpoint it would have
        // recorded, and every later dial reads it.
        _cliEndpoint ??= endpoint;
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

  Future<void> retryMachines() => _retryMachines(automatic: false);

  Future<void> _retryMachines({required bool automatic}) {
    if (_disposed) return Future<void>.value();
    final inFlight = _retryInFlight;
    if (inFlight != null) return inFlight;
    late final Future<void> run;
    run = _performRetryMachines(automatic: automatic).whenComplete(() {
      if (identical(_retryInFlight, run)) {
        _retryInFlight = null;
        if (!_disposed) notifyListeners();
      }
    });
    _retryInFlight = run;
    notifyListeners();
    return run;
  }

  Future<void> _performRetryMachines({required bool automatic}) async {
    final revision = _authRevision;
    if (!_authWorkCurrent(revision)) return;
    // Re-verify the daemon first: a retry that skips straight to `refreshMachines()` can hit
    // the exact same "daemon not connected yet" timeout the button was pressed to escape.
    try {
      await ensureCliDaemonReady();
    } catch (error) {
      if (!_authWorkCurrent(revision)) return;
      if (automatic) {
        _scheduleMachineRecovery(revision);
      } else {
        _lastError = '$error';
        _lastErrorRetryable = true;
      }
      notifyListeners();
      return;
    }
    if (!_authWorkCurrent(revision) || status == AppStatus.unauthenticated) {
      return;
    }
    if (currentUser == null) unawaited(_loadProfile());
    try {
      await refreshMachines();
      if (!_authWorkCurrent(revision)) return;
      if (!automatic) _lastError = null;
    } catch (error) {
      if (!_authWorkCurrent(revision)) return;
      _reportMachineLoadError(error, automatic: automatic);
      notifyListeners();
      return;
    }
    await Future.wait(expandedMachines.toList().map(reloadMachineData));
    if (_authWorkCurrent(revision)) notifyListeners();
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
    if (machine.machine.isShared) return;
    // A row the daemon has refused as "not the machine I serve" is retired until a machine list
    // re-keys it (_onLocalMachineMismatch): the offline poll and the 15s refresh both reconnect
    // every row, and would otherwise dial that id again every few seconds, 4403 after 4403.
    if (_localMismatchReported.contains(machine.machine.machineId)) return;
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

  /// Put one agent back on its own vendor login — the Claude / Codex subscription it had before a
  /// grid model was chosen.
  ///
  /// `clearGrid` is a separate flag rather than `gridModel: null` on purpose: the daemon treats an
  /// absent field as "I did not mention the grid", so overloading null would make a forgotten field
  /// and a deliberate "put it back" the same frame. Same pane respawn as picking a model.
  Future<void> clearAgentGrid(String machineId, String agentId) async {
    try {
      await _conn(machineId).request(
        'agent_retarget',
        payload: {'agentId': agentId, 'clearGrid': true},
        timeout: const Duration(seconds: 30),
      );
    } on WsRequestFailure catch (failure) {
      _reportRetargetRefusal(machineId, agentId, failure.code);
    } catch (_) {
      // A transport failure or a timeout: the daemon may well have done the move, and the frame
      // that follows says where the agent is. A guess here would tell a story the pane contradicts.
    }
  }

  /// A refusal happens BEFORE the daemon touches the pane — an engine with no way onto a Local
  /// model, a busy agent, a machine that cannot resolve its Local models — so nothing in the
  /// terminal ever says why, and until this existed the click simply did nothing. One sentence, in
  /// the app's own words (`retargetRefusalMessage`); the daemon's detail names the grid.
  void _reportRetargetRefusal(String machineId, String agentId, String code) {
    final agent = machineStates[machineId]?.agents
        .where((a) => a.id == agentId)
        .firstOrNull;
    final label = engineIdentity(agent?.engine).label;
    _lastError = retargetRefusalMessage(code, engineLabel: label);
    _lastErrorRetryable = false;
    notifyListeners();
  }

  /// Point one agent at a model on the account's private grid.
  ///
  /// Sends the model id and nothing else: the daemon on that machine resolves the endpoint and the
  /// credential from its own signed-in `grid`, so neither travels over the relay and the app never
  /// holds a grid key. Moving an agent re-execs its pane, which is why this is an explicit choice in
  /// a menu rather than something that can happen by hovering.
  /// [gridName] is the grid the model was picked from — a shared grid's section in the picker.
  /// Absent, the daemon uses the account's own grid, as it always did.
  Future<void> retargetAgentToGridModel(
    String machineId,
    String agentId,
    String modelId, {
    String? gridName,
  }) async {
    try {
      await _conn(machineId).request(
        'agent_retarget',
        payload: {
          'agentId': agentId,
          'gridModel': modelId,
          if (gridName != null) 'gridName': gridName,
        },
        timeout: const Duration(seconds: 30),
      );
    } on WsRequestFailure catch (failure) {
      _reportRetargetRefusal(machineId, agentId, failure.code);
    } catch (_) {
      // See `clearAgentGrid`: a transport failure is not a refusal, and the next frame is the truth.
    }
  }

  /// Live models on the account's private harness grid, for the pane header's picker.
  ///
  /// Asked of the machine the pane belongs to rather than kept in app state: the answer is whatever
  /// that machine's `grid` reports at this moment (an engine can join or leave between two opens),
  /// and a cached list would offer a model nobody is serving any more.
  ///
  /// Never throws — a machine whose daemon is too old to know the RPC, one with no grid, and one
  /// that timed out are all "nothing to offer", which is what the picker shows.
  Future<GridModels> gridModels(String machineId) async {
    try {
      final response = await _conn(machineId)
          .request('grid_models_list', timeout: const Duration(seconds: 12));
      final models = (response['models'] as List<dynamic>? ?? [])
          .whereType<Map<String, dynamic>>()
          .map(
            (m) => GridModel(
              id: (m['id'] as String?) ?? '',
              node: (m['node'] as String?) ?? '',
            ),
          )
          .where((m) => m.id.isNotEmpty)
          .toList();
      final capable = response['localModelEngines'];
      List<GridModel> parseModels(Object? raw) => (raw as List<dynamic>? ?? [])
          .whereType<Map<String, dynamic>>()
          .map(
            (m) => GridModel(
              id: (m['id'] as String?) ?? '',
              node: (m['node'] as String?) ?? '',
            ),
          )
          .where((m) => m.id.isNotEmpty)
          .toList();
      final grids = (response['grids'] as List<dynamic>? ?? [])
          .whereType<Map<String, dynamic>>()
          .where((g) => (g['name'] as String?)?.isNotEmpty == true)
          .map(
            (g) => GridSection(
              name: g['name'] as String,
              own: g['own'] == true,
              models: [
                for (final m in parseModels(g['models']))
                  GridModel(id: m.id, node: m.node, grid: g['name'] as String),
              ],
            ),
          )
          .toList();
      return GridModels(
        gridName: response['gridName'] as String?,
        models: models,
        grids: grids,
        localModelEngines: capable is List
            ? capable.whereType<String>().map((e) => e.toLowerCase()).toSet()
            : null,
        gridCli: GridCli.parse(response['gridCli']),
      );
    } catch (_) {
      // NOT `gridName: null` with an empty list — that is the shape of "this account has no grid",
      // and a caller cannot tell it from "the machine did not answer". A signed-in user whose daemon
      // was offline was told to sign in again, which was both wrong and unactionable.
      return const GridModels.unreachable();
    }
  }

  /// The Store harness every "Open Grid" door opens: Grid, the agent that
  /// manages the models on a machine or a fleet, with its live viewer.
  static const gridHarness = 'autonomous/autonomous-grid';

  /// The one action behind every "Open Grid" entry — the pane picker's button
  /// and the Models menu — and it is exactly what the Store's Open button
  /// does: a draft tab of its own, then New Agent with Grid already chosen on
  /// [machineId]. Not a dialog of this feature's own: a second way to open a
  /// harness would be a second definition of what opening one means.
  ///
  /// Grid not installed on that machine → the Store, open on Grid's page,
  /// whose Install is the way in. Nothing here reports progress: the tab
  /// appearing is the confirmation.
  ///
  /// Takes the caller's [context] because New Agent needs one and this
  /// notifier holds none — the same shape as every other dialog a door opens.
  ///
  /// [machineId] is the computer Grid opens on — the pane's own machine from a
  /// pane's picker, the one chosen from the Models menu's list. Absent (a menu
  /// with one machine, or none named), it is this computer's own when the app
  /// has one, else whatever the person is looking at. Never guessed past a
  /// named machine: a picker on a remote pane that opened on this computer was
  /// the bug this argument exists to end.
  Future<void> runLocalModel(BuildContext context, {String? machineId}) async {
    final machine = machineId != null
        ? machineStates[machineId]
        : _localModelMachine();
    if (machine == null) {
      _lastError = machineId != null
          ? 'That machine is no longer linked.'
          : 'Connect a machine before opening Grid.';
      _lastErrorRetryable = false;
      notifyListeners();
      return;
    }
    machineId = machine.machine.machineId;
    // Whether Grid is installed THERE, from the machine's own list — a stored
    // answer is fine here, since an install this app started is pushed into
    // it as it lands.
    await probeDsh(machineId);
    if (machine.dsh[gridHarness]?.installed != true) {
      openStore(harness: gridHarness);
      return;
    }
    if (!context.mounted) return;
    await openStoreAgent(context, this, gridHarness, machineId);
  }

  /// The machine Grid belongs on when no door named one: this computer's own
  /// when the app has one, else whatever the person is looking at.
  MachineState? _localModelMachine() {
    final local = machineStates.values
        .where((state) => state.isLocalMachine)
        .firstOrNull;
    if (local != null) return local;
    final focused = focusedPane?.machineId ?? selectedMachineId;
    return (focused == null ? null : machineStates[focused]) ??
        machineStates.values.firstOrNull;
  }

  WsConn _conn(String machineId) {
    if (machineStates[machineId]?.machine.isShared == true) {
      throw StateError('This harness is shared with view-only access.');
    }
    final testConnection = connectionForTest;
    if (testConnection != null) return testConnection(machineId);
    // The local-manual dev fixture exercises a locally-run backend+node stack directly (no real
    // `harness` CLI involved) — keep it on the old direct-cloud dial. Every other (real) machine now
    // goes through the local CLI daemon regardless of whether it's this computer's own machine or a
    // relayed one: the CLI proxies foreign machines to backend transparently (see `remoteRelay.ts` in
    // the harness CLI repo), so this app never dials backend's WS directly anymore.
    final connection = localManualFixture != null || viewer != null
        ? _pool!.connFor(machineId, transportKind: WsTransportKind.cloudE2ee)
        : _pool!.connFor(
            machineId,
            transportKind: WsTransportKind.localPlaintext,
            // The endpoint the offline poll (or the machine refresh) found for THIS row first; the
            // boot gate's global one only as the fallback. `_cliEndpoint` is set only by a gate that
            // succeeded, so a boot that found the daemon down and a poll that later found it up
            // used to dial a null uri — a StateError per attempt, never a socket.
            localWsUri:
                machineStates[machineId]?.localEndpoint?.wsUri ??
                _cliEndpoint?.wsUri,
            localProtocolVersion:
                machineStates[machineId]?.localEndpoint?.protocolVersion ??
                _cliEndpoint?.protocolVersion ??
                localWsProtocolVersion,
            // This computer's own daemon: retry every second (see WsConn.fixedReconnectDelay). A
            // relayed machine keeps the backoff — its select costs the daemon a backend dial.
            fixedReconnectDelay:
                machineStates[machineId]?.isLocalMachine == true
                ? localDaemonReconnectDelay
                : null,
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
  /// Read the live session identity instead of maintaining a second registry.
  /// Skip unrelated sessions before awaiting: every ignored async call adds a
  /// scheduling turn to the socket's incoming queue. Matching frames enter the
  /// session's ordered renderer queue synchronously, regardless of tab order.
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
      if (terminal.streamId == clear.streamId) {
        await terminal.handleBinary(clear);
      }
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
    if (machine.machine.isShared) return;
    if (!_machineWorkCurrent(machine, _authRevision)) return;
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
    final revision = _authRevision;
    final hadAgents = machine.agents.isNotEmpty;
    machine.agentsRefreshing = hadAgents;
    if (!hadAgents) machine.agentLoadStatus = AgentLoadStatus.loading;
    machine.agentsLoadError = null;
    notifyListeners();
    final connection = _conn(machine.machine.machineId);
    final deadline = Stopwatch()..start();
    debugPrint('agents_list start: ${machine.machine.machineId}');
    try {
      const inventoryTimeout = Duration(seconds: 10);
      await connection.waitUntilReady(timeout: inventoryTimeout);
      if (!_machineWorkCurrent(machine, revision)) return;
      // Keep the inventory's existing total budget, including connection time.
      // Capabilities get their own budget only once the handshake is complete.
      final remaining = inventoryTimeout - deadline.elapsed;
      if (remaining <= Duration.zero) {
        throw const WsRequestTimeout('agents_list');
      }
      final capabilities = _loadTerminalCapabilities(
        machine,
        connection,
        revision,
      );
      final response = await connection.request(
        'agents_list',
        timeout: remaining,
      );
      if (!_machineWorkCurrent(machine, revision)) return;
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
      // Publish discovery immediately. The capability loader attaches waiting
      // panes when its reply arrives; either response may finish first.
      if (machine.terminalCapabilityLoadInFlight == null) {
        _attachPendingPanes(machine);
        _autoPickFirstAgent();
      }
      notifyListeners();
      await capabilities;
      return;
    } catch (error) {
      if (!_machineWorkCurrent(machine, revision)) return;
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
    if (!_machineWorkCurrent(machine, revision)) return;
    // Order matters: a restored tile for THIS machine claims its agent before
    // the first-run convenience gets to look, so the two can never both open.
    _attachPendingPanes(machine);
    _autoPickFirstAgent();
    notifyListeners();
  }

  bool _machineWorkCurrent(MachineState machine, int revision) =>
      _authWorkCurrent(revision) &&
      identical(machineStates[machine.machine.machineId], machine);

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
    if (_autoPickedAgent) return;
    // V2 opens on the welcome screen; discovering an agent is not a request
    // to attach its terminal. Keep the startup gate settled for this run.
    _autoPickedAgent = true;
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
  /// Which domain-specific harnesses [machineId] has or could install — the
  /// `dsh_list` answer, cached per machine and deduplicated on
  /// [MachineDsh.inFlight] exactly like [probeEngines]. The Create dialog asks
  /// with [force] on every open, since an install it started itself is what
  /// most often makes the stored answer stale.
  Future<void> probeDsh(String machineId, {bool force = false}) {
    final machine = machineStates[machineId];
    if (machine == null) return Future.value();
    final existing = machine.dsh.inFlight;
    if (existing != null) return existing;
    if (machine.dsh.loaded && !force) return Future.value();
    final work = _probeDsh(machine);
    machine.dsh.inFlight = work;
    notifyListeners();
    return work;
  }

  Future<void> _probeDsh(MachineState machine) async {
    try {
      final result = await _conn(machine.machine.machineId)
          .request('dsh_list', timeout: const Duration(seconds: 30));
      final raw = result['dsh'];
      if (raw is! List) throw const FormatException('dsh_list: no list');
      machine.dsh.replace(raw.map(DshEntry.fromJson).whereType<DshEntry>());
    } catch (error) {
      // A CLI that predates `dsh_list` refuses it by code, and the dialog then
      // offers only the harnesses this build ships a face for; the machine
      // has the final say at create time (`INVALID_DSH`).
      machine.dsh.error = error is WsRequestFailure
          ? (error.detail?.isNotEmpty == true ? error.detail : error.code)
          : 'This machine could not report its harnesses';
    } finally {
      machine.dsh.inFlight = null;
      notifyListeners();
    }
  }

  /// Uninstall the harness [id] from [machineId] (`dsh_remove`): the clone
  /// goes, a linked install loses only its link, and the machine's catalog is
  /// asked again so the store's "Installed" reads true. Null on success, else
  /// a sentence for the person who clicked.
  Future<String?> removeDsh(String machineId, String id) async {
    final machine = machineStates[machineId];
    if (machine == null) return 'Machine not found';
    final machineName = machine.machine.displayName;
    try {
      final result = await _conn(machineId).request(
        'dsh_remove',
        payload: {'id': id},
        timeout: const Duration(seconds: 30),
      );
      if (result['ok'] != true) {
        final detail = result['detail'];
        return detail is String && detail.isNotEmpty
            ? detail
            : 'Remove failed on $machineName';
      }
    } on WsRequestFailure catch (failure) {
      return switch (failure.code) {
        'UNSUPPORTED' || 'UNSUPPORTED_ON_REMOTE' =>
          'Update the harness CLI on $machineName to remove harnesses',
        _ =>
          failure.detail?.isNotEmpty == true
              ? failure.detail!
              : 'Remove failed on $machineName (${failure.code})',
      };
    } on WsRequestTimeout {
      return '$machineName did not answer. Try again.';
    } catch (_) {
      return 'Remove failed on $machineName';
    }
    await probeDsh(machineId, force: true);
    return null;
  }

  /// Install the harness [id] on [machineId]: clone, set up its toolchain, run
  /// its doctor. Minutes, not seconds — the Circuit toolchain alone is an
  /// `npm ci` — so the request carries its own long budget and the machine
  /// narrates progress through `dsh_install_status` pushes, which land in
  /// [MachineDsh.installs] for the dialog's status line. Null on success, else
  /// a sentence for the person who clicked.
  Future<String?> installDsh(String machineId, String id) =>
      _installOrUpdateDsh(machineId, id, update: false);

  Future<String?> updateDsh(String machineId, String id) =>
      _installOrUpdateDsh(machineId, id, update: true);

  Future<String?> _installOrUpdateDsh(
    String machineId,
    String id, {
    required bool update,
  }) async {
    final machine = machineStates[machineId];
    if (machine == null) return 'Machine not found';
    final machineName = machine.machine.displayName;
    final action = update ? 'Update' : 'Install';
    final verb = update ? 'update' : 'install';
    // A new run every time the button is pressed: a retry after a failure is
    // its own attempt, with its own clock.
    machine.dsh.runs.remove(id);
    machine.dsh.applyInstall(DshInstallProgress(id: id, phase: 'clone'));
    notifyListeners();
    try {
      final result = await _conn(machineId).request(
        update ? 'dsh_update' : 'dsh_install',
        payload: {'id': id},
        timeout: const Duration(minutes: 90),
      );
      if (result['ok'] != true) {
        final detail = result['detail'];
        return _finishInstall(
          machine,
          id,
          detail is String && detail.isNotEmpty
              ? detail
              : '$action failed on $machineName',
        );
      }
    } on WsRequestFailure catch (failure) {
      return _finishInstall(machine, id, switch (failure.code) {
        'UNSUPPORTED' || 'UNSUPPORTED_ON_REMOTE' =>
          'Update the harness CLI on $machineName to $verb harnesses',
        _ =>
          failure.detail?.isNotEmpty == true
              ? failure.detail!
              : '$action failed on $machineName (${failure.code})',
      });
    } on WsRequestTimeout {
      return _finishInstall(
        machine,
        id,
        '$machineName is still ${update ? 'updating' : 'installing'}. Try again in a few minutes.',
      );
    } catch (_) {
      return _finishInstall(machine, id, '$action failed on $machineName');
    }
    machine.dsh.applyInstall(DshInstallProgress(id: id, phase: 'done'));
    notifyListeners();
    // The stored answer just became stale by the dialog's own hand.
    await probeDsh(machineId, force: true);
    return null;
  }

  String _finishInstall(MachineState machine, String id, String error) {
    machine.dsh.applyInstall(
      DshInstallProgress(id: id, phase: 'failed', detail: error),
    );
    notifyListeners();
    return error;
  }

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
    int revision,
  ) {
    final pending = machine.terminalCapabilityLoadInFlight;
    if (pending != null) return pending;
    late final Future<void> load;
    load = _readTerminalCapabilities(machine, connection, revision)
        .whenComplete(() {
          if (identical(machine.terminalCapabilityLoadInFlight, load)) {
            machine.terminalCapabilityLoadInFlight = null;
          }
        });
    machine.terminalCapabilityLoadInFlight = load;
    return load;
  }

  Future<void> _readTerminalCapabilities(
    MachineState machine,
    WsConn connection,
    int revision,
  ) async {
    try {
      final result = await connection.request(
        'terminal_capabilities',
        payload: {'protocolVersion': TerminalSession.protocolVersion},
        timeout: const Duration(seconds: 8),
      );
      if (!_machineWorkCurrent(machine, revision)) return;
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
      if (!_machineWorkCurrent(machine, revision)) return;
      machine.terminalCapabilityLoaded = true;
      machine.terminalCapabilityAvailable = false;
      machine.terminalCapabilityError = 'Could not negotiate terminal protocol';
      machine.terminalPasteRawAvailable = false;
      machine.terminalImagePasteAvailable = false;
      machine.terminalPasteFileAvailable = false;
      machine.mediaPreviewAvailable = false;
    }
    if (!_machineWorkCurrent(machine, revision)) return;
    if (machine.agentLoadStatus != AgentLoadStatus.loading &&
        !machine.agentsRefreshing) {
      _attachPendingPanes(machine);
      _autoPickFirstAgent();
      notifyListeners();
    }
  }

  void _replaceAgents(MachineState machine, List<Agent> agents) {
    final nextIds = agents.map((agent) => agent.id).toSet();
    for (final old in machine.agents.where(
      (agent) => !nextIds.contains(agent.id),
    )) {
      sessionPreviews.removeAgent(machine.machine.machineId, old.id);
    }
    for (final agent in agents) {
      sessionPreviews.retainAgent(
        machine.machine.machineId,
        agent.id,
        agent.sessionId,
      );
    }
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
    _warmPreviews(machine);
    for (final agent in agents) {
      _syncViewerPane(machine, agent);
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
    sessionPreviews.retainAgent(
      machine.machine.machineId,
      agent.id,
      agent.sessionId,
    );
    sessionPreviews.warm([previewKey(machine.machine.machineId, agent)]);
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
    _syncViewerPane(machine, agent);
    // A terminal that adopted an engine, or let one go: the tiles already
    // attached to it keep their stream and change their face. The dial's
    // tile list changes with it — a terminal is not on it, its engine is.
    if (previous != null && previous.engine != agent.engine) {
      for (final pane in panesFor(machine.machine.machineId)) {
        if (pane.agentId == agent.id) pane.session?.setEngineId(agent.engine);
      }
      _announceOpenPanesToDial();
    }
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
    sessionPreviews.removeAgent(machine.machine.machineId, agentId);
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
    for (final pane in allPanes.toList()) {
      final owned =
          pane.machineId == machineId &&
          (pane.agentId == agentId ||
              (pane.isWeb && pane.ownerAgentId == agentId));
      if (!owned) continue;
      await _detachSession(pane, sendClose: false);
      for (final swarm in swarms) {
        swarm.remove(pane);
      }
    }
    _dismissedViewers.remove(_viewerKey(machineId, agentId));
    _persistLayout();
    _announceAppFocus();
  }

  // ── harness viewers ─────────────────────────────────────────────────────────

  /// Viewer URLs the person closed, by `machine/agent`. A frame carrying the
  /// same URL again leaves the tile closed; a different URL reopens it. Memory
  /// only — a restart is a fresh look at whatever the agent is showing.
  final _dismissedViewers = <String, String>{};

  String _viewerKey(String machineId, String agentId) => '$machineId/$agentId';

  /// Keep [agent]'s viewer tile in step with its frame.
  ///
  /// The daemon says where the harness's viewer is (`viewerUrl`); this puts a
  /// web tile immediately to the RIGHT of the agent's terminal in whichever
  /// tab that shows that terminal, navigates an open tile when the URL
  /// changes, and takes the tile down when the viewer or the terminal goes.
  /// It never steals focus: the person is typing in the terminal the viewer
  /// belongs to. Nothing is persisted — see [PaneKind.web].
  void _syncViewerPane(MachineState machine, Agent agent) {
    final machineId = machine.machine.machineId;
    final url = agent.viewerUrl;
    final viewerState = url ?? agent.viewerError;
    final dismissed =
        viewerState != null &&
        _dismissedViewers[_viewerKey(machineId, agent.id)] == viewerState;
    var changed = false;
    // Tab by tab: wherever this agent's terminal is, its viewer is beside it,
    // and nowhere else. A terminal opened in a second tab gets a second
    // viewer; a tab whose terminal went loses its viewer.
    for (final swarm in swarms) {
      final at = swarm.panes.indexWhere(
        (pane) =>
            !pane.isWeb &&
            pane.machineId == machineId &&
            pane.agentId == agent.id,
      );
      final viewers = [
        for (final pane in swarm.panes)
          if (pane.isWeb &&
              pane.machineId == machineId &&
              pane.ownerAgentId == agent.id)
            pane,
      ];
      if (viewerState == null || at < 0) {
        for (final pane in viewers) {
          swarm.remove(pane);
          changed = true;
        }
        continue;
      }
      if (viewers.isNotEmpty) {
        // The same page again is nothing new; a different one navigates in
        // place rather than reopening a tile.
        for (final pane in viewers) {
          pane.url = url;
          pane.viewerError = agent.viewerError;
        }
        continue;
      }
      if (dismissed || swarm.panes.length >= maxPanes) continue;
      // The viewer goes LEFT of the terminal: it is what the user watches, the
      // terminal is where they type, and reading order puts the product first.
      final insertion = at;
      final pane = TerminalPane(
        id: _nextPaneId++,
        machineId: machineId,
        kind: PaneKind.web,
        url: url,
        viewerError: agent.viewerError,
        ownerAgentId: agent.id,
      );
      swarm.panes.insert(insertion, pane);
      // The same bookkeeping a split does when it grows the grid by one:
      // pins past the insertion slide right, and the shape is re-derived.
      swarm.pinnedSlots.updateAll(
        (_, slot) => slot >= insertion ? slot + 1 : slot,
      );
      swarm.arranged = null;
      swarm.arrangedKey = null;
      // Alone with its terminal, the viewer takes two thirds of the tab — a
      // board or a part wants the width, and a third is the least a coding
      // agent's interface reads well at. Only when nobody has sized this pair
      // by hand: a manual layout is the user's.
      if (swarm.panes.length == 2 && swarm.paneSizes['2:manual'] == null) {
        swarm.savePaneSizes('2:manual', PaneArrangement.viewerBesideTerminal);
      }
      changed = true;
    }
    if (changed) _persistLayout();
  }

  /// Whether the active tab shows this agent's viewer beside its terminal.
  bool viewerPaneShown(String machineId, String agentId) =>
      activeSwarm.panes.any(
        (pane) =>
            pane.isWeb &&
            pane.machineId == machineId &&
            pane.ownerAgentId == agentId,
      );

  /// The header's viewer control: hide the viewer in this tab, or bring it
  /// back beside the terminal. Bringing it back also lifts a dismissal, so a
  /// page closed by hand earlier opens again on request.
  Future<void> toggleViewerPane(String machineId, String agentId) async {
    final viewer = activeSwarm.panes
        .where(
          (pane) =>
              pane.isWeb &&
              pane.machineId == machineId &&
              pane.ownerAgentId == agentId,
        )
        .firstOrNull;
    if (viewer != null) {
      await closePane(viewer.id);
      return;
    }
    final machine = machineStates[machineId];
    final agent = machine?.agents.where((a) => a.id == agentId).firstOrNull;
    if (machine == null ||
        agent == null ||
        (agent.viewerUrl == null && agent.viewerError == null)) {
      return;
    }
    _dismissedViewers.remove(_viewerKey(machineId, agentId));
    _syncViewerPane(machine, agent);
    notifyListeners();
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

  bool _markAgentProcessing(MachineState machine, String agentId) {
    final changed = machine.processingAgentIds.add(agentId);
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
    return changed;
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
    if (machine == null ||
        machine.needsLink ||
        machine.nodeOnline == false ||
        machine.connectionStatus != ConnectionStatus.connected) {
      throw const RemoteMediaException(
        'This machine is disconnected. Reconnect and try opening the preview again.',
      );
    }
    if (!machine.mediaPreviewAvailable) {
      throw const RemoteMediaException(
        'Update the Harness CLI on this remote machine to open image and video previews.',
      );
    }
    final connection = _conn(machineId);
    if (!connection.isReady) {
      throw const RemoteMediaException(
        'This machine is disconnected. Reconnect and try opening the preview again.',
      );
    }
    try {
      return await connection.request(
        'agent_read_file',
        payload: {
          'agentId': agentId,
          'path': target,
          'media': true,
          'offset': offset,
          'revision': ?revision,
        },
        timeout: const Duration(seconds: 15),
      );
    } on WsRequestFailure catch (error) {
      throw RemoteMediaException(switch (error.code) {
        'MEDIA_NOT_FOUND' || 'NOT_FOUND' => 'This file is no longer available on the remote machine. It may have moved or been deleted.',
        'MEDIA_TOO_LARGE' => 'Remote previews support files up to 512 MB. Use a smaller export or transfer this file separately.',
        'MEDIA_CHANGED' => 'The file changed while downloading. Wait for it to finish generating and try again.',
        'MEDIA_UNSUPPORTED' => 'This file is not a supported image or video.',
        'MEDIA_INVALID_REQUEST' =>
          'Use a full path or a path inside this agent’s working folder.',
        'AGENT_NOT_FOUND' =>
          'This agent is no longer available. Reconnect and try again.',
        'NOT_TEXT' || 'FILE_TOO_LARGE' => 'Update the Harness CLI on this remote machine to open media previews.',
        _ => 'The remote machine could not read this file. Check that it is accessible and try again.',
      });
    } catch (_) {
      throw const RemoteMediaException(
        'The media download was interrupted. Check the connection and try again.',
      );
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

  /// Reads source material only on the machine that owns the selected path.
  Future<Map<String, dynamic>> readProjectPreview(
    String machineId,
    String path,
  ) async {
    final machine = machineStates[machineId];
    if (machine == null) return {'error': 'UNAVAILABLE'};
    if (machineSharesGuiFilesystem(machineId)) {
      return readLocalProjectPreview(path).timeout(
        const Duration(seconds: 4),
        onTimeout: () => {'error': 'UNAVAILABLE'},
      );
    }
    if (machine.nodeOnline == false ||
        machine.needsLink ||
        machine.connectionStatus != ConnectionStatus.connected &&
            connectionForTest == null) {
      return {'error': 'UNAVAILABLE'};
    }
    try {
      return await _conn(machineId).request(
        'project_preview',
        payload: {'path': path},
        timeout: const Duration(seconds: 4),
      );
    } catch (_) {
      return {'error': 'UNAVAILABLE'};
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
    // A profile folder is a path on the CLI's own filesystem, exactly like an
    // agent's cwd: a Windows path cannot be one when the CLI runs in WSL2.
    final resolved = backendFolderFor(machineId, path);
    if (resolved.error != null) return {'error': resolved.error};
    final connection = _conn(machineId);
    try {
      return await connection.request(
        'codex_profile_link',
        payload: {'path': resolved.path},
        timeout: const Duration(seconds: 10),
      );
    } catch (error) {
      return {'error': 'UNREACHABLE'};
    }
  }

  /// Starts an agent, or recovers this form's earlier request after a lost reply.
  /// Returns null on success, or an inline message; [attempt] tells the form
  /// whether to offer Check status instead of inviting another creation.
  Future<String> prepareLocalProjectFolder(
    ProjectFolderRequest request, {
    String label = 'harness',
  }) => request.prepareLocal(label: label);

  Future<String?> createAgent(
    String machineId, {
    required String engine,

    /// Where the agent works. Null only for a terminal (`kTerminalEngine`),
    /// which the daemon then opens at the machine's home, as a terminal app
    /// would — every other engine is refused without one (`INVALID_CWD`).
    required String? folder,
    ProjectFolderRequest? projectFolder,
    bool bypassPermission = true,
    String? permissionMode,
    String? codexHome,
    String? dsh,
    String? prompt,
    String? name,
    String? agent,
    String? swarmId,
    PaneSplitRequest? split,
    AgentCreationAttempt? attempt,
  }) {
    final creation = attempt ?? AgentCreationAttempt();
    final choices = <String, dynamic>{
      'engine': engine,
      if (projectFolder == null && folder != null) 'cwd': folder,
      ...?projectFolder?.payload,
      'bypassPermission': bypassPermission,
      // The mode picked in New Harness (`permission_modes.dart`). A daemon that
      // predates modes ignores it and goes by `bypassPermission`, which the
      // dialog derives from the same choice.
      'permissionMode': ?permissionMode,
      'codexHome': ?codexHome,
      // The harness this agent is created from. `engine` above is its BASE —
      // the machine refuses the pair when they disagree (`INVALID_DSH`).
      'dsh': ?dsh,
      // A first message the engine is opened with, and the pane's name before
      // the engine reports a session title. Both absent unless asked for: a
      // daemon that predates them ignores an unknown field, but one that knows
      // them refuses a prompt for an engine with no way to take one
      // (`PROMPT_UNSUPPORTED`), and an empty field would trip that for every
      // ordinary create.
      'prompt': ?prompt,
      'name': ?name,
      // The engine's own named agent to open AS (opencode `--agent <name>`):
      // the pane is that agent, with its name and system prompt, rather than
      // a general session. Same absent-unless-asked rule as `prompt`, and the
      // same refusal for an engine that has no such thing (`AGENT_UNSUPPORTED`).
      'agent': ?agent,
    };
    if (creation._choices != null &&
        (creation._machineId != machineId ||
            !mapEquals(creation._choices, choices))) {
      return Future.value(
        'Check the original request before changing its choices.',
      );
    }
    if (creation._finished) return Future.value(creation._outcome);
    if (creation._inFlight case final inFlight?) return inFlight;
    if (creation._choices == null) {
      var targetId = split?.swarmId ?? swarmId ?? activeSwarmId;
      // A harness gets a tab of its own, named after it: its viewer is the
      // product and needs the width, and the two tiles read as one workspace
      // rather than two more tiles in whatever tab was open. A New Tab
      // start page the user is already on IS that tab. A split was asked for
      // by name and wins; so does a tab other than the current one. The
      // current tab is what the dialog passes when nothing was chosen.
      if (dsh != null &&
          split == null &&
          (swarmId == null || swarmId == activeSwarmId)) {
        final label = engineIdentity(dsh).label;
        if (activeSwarm.isEmptyStarter) {
          renameSwarm(activeSwarmId, label);
        } else {
          newSwarm(name: label);
        }
        targetId = activeSwarmId;
      }
      creation._choices = choices;
      creation._machineId = machineId;
      creation._targetId = targetId;
      creation._split = split;
    }
    final work = _createAgentWithReceipt(creation);
    creation._inFlight = work;
    return work.whenComplete(() => creation._inFlight = null);
  }

  String? _creationPlacementError(String targetId, PaneSplitRequest? split) {
    if (split != null && !isPaneSplitCurrent(split)) {
      return 'The layout changed. Close this dialog and split the pane again.';
    }
    final target = swarms.where((s) => s.id == targetId).firstOrNull;
    if (target == null) return 'This tab was closed';
    if (target.panes.length >= maxPanes) {
      return 'This tab is full. Open a new tab to create a harness.';
    }
    return null;
  }

  String _creationFailureMessage(String code, String? detail, String machine) =>
      switch (code) {
        'INVALID_PROJECT_SOURCE' ||
        'INVALID_REPOSITORY' ||
        'PROJECT_PREPARATION_FAILED' ||
        'PROJECT_EXISTS' ||
        'CLONE_FAILED' ||
        'CLONE_TIMEOUT' ||
        'GIT_UNAVAILABLE' =>
          detail ?? 'Could not prepare the project folder on $machine.',
        'CWD_NOT_FOUND' || 'INVALID_CWD' =>
          'The project folder is unavailable on $machine. '
              'Choose another folder and try again.',
        'TMUX_UNAVAILABLE' =>
          'Harness needs tmux to start harnesses on $machine. '
              'Install tmux there, then try again.',
        'UNSUPPORTED_ON_REMOTE' || 'UNSUPPORTED' =>
          'Update the harness CLI on this machine to create a harness',
        'INVALID_DSH' =>
          'This harness is not installed on $machine. '
              '${detail ?? 'Install it there, then try again.'}',
        'PROMPT_UNSUPPORTED' =>
          'This engine cannot be opened with a first message on $machine.',
        'PROMPT_TOO_LONG' =>
          'This first task is too long for $machine. Shorten it and try again.',
        'AGENT_UNSUPPORTED' =>
          'This engine cannot be opened as a named agent on $machine.',
        // A daemon that predates the terminal engine refuses it by name; the
        // fix is the same one the other UNSUPPORTED codes ask for.
        'INVALID_ENGINE' =>
          'Update the harness CLI on $machine to open this kind of pane.',
        _ => 'Create harness failed: ${detail ?? code}',
      };

  Future<String?> _createAgentWithReceipt(AgentCreationAttempt creation) async {
    final machineId = creation._machineId!;
    final targetId = creation._targetId!;
    final split = creation._split;
    final choices = creation._choices!;
    final machine = machineStates[machineId];
    if (machine == null) return 'Machine not found';
    final machineName = machine.machine.displayName;
    // A status check must remain possible even if the destination closed or a
    // capability probe changed while the first create was already in flight.
    if (!creation.awaitingConfirmation) {
      final placementError = _creationPlacementError(targetId, split);
      if (placementError != null) return placementError;
      if (choices['codexHome'] != null) {
        if (choices['engine'] != 'codex') {
          return 'Choose a Codex profile only for Codex';
        }
        if (machine.engines['codex']?.supportsCodexHome != true) {
          return 'Update the harness CLI on this machine to choose a Codex profile';
        }
      }
    }
    // Nothing to dial with before sign-in finishes (`_finishBootstrapSignedIn`
    // makes the pool) — a shortcut that fires in that window, such as ⌘⇧T, is
    // answered rather than crashed on.
    if (_pool == null && connectionForTest == null) {
      return 'Not connected to $machineName yet.';
    }
    final connection = _conn(machineId);
    var launchChoices = choices;
    if (!creation.awaitingConfirmation &&
        choices['projectSource'] != null &&
        machineSharesGuiFilesystem(machineId)) {
      try {
        final repository = choices['repositoryUrl'];
        final project = repository is String
            ? ProjectFolderRequest.remote(GitHubRepository.parse(repository)!)
            : const ProjectFolderRequest.newProject();
        final dshId = choices['dsh'];
        creation._preparedFolder ??= await prepareLocalProjectFolder(
          project,
          // The folder is named after who the harness is: the harness's own name, else the engine's.
          label: dshId is String && dshId.isNotEmpty
              ? (machine.dsh.entries
                        .where((entry) => entry.id == dshId)
                        .firstOrNull
                        ?.name ??
                    engineIdentity(dshId).label)
              : engineIdentity(choices['engine'] as String?).label,
        );
      } on RepositoryCloneException catch (error) {
        return creation._complete(error.message);
      } catch (_) {
        return creation._complete(
          'Could not prepare the project folder. Browse for an existing folder.',
        );
      }
      // Preparation may be slow. Revalidate before starting a process, using
      // the original machine and split rather than the current selection.
      final placementError = _creationPlacementError(targetId, split);
      if (placementError != null) return creation._complete(placementError);
      if (_disposed ||
          machineStates[machineId] != machine ||
          !machineSharesGuiFilesystem(machineId)) {
        return creation._complete(
          'The selected machine changed. Choose the machine again.',
        );
      }
      launchChoices = Map.of(choices)
        ..remove('projectSource')
        ..remove('repositoryUrl')
        ..['cwd'] = creation._preparedFolder;
    }
    if (!creation.awaitingConfirmation) {
      launchChoices = Map.of(launchChoices);
      for (final key in ['cwd', 'codexHome']) {
        final value = launchChoices[key];
        if (value is! String) continue;
        final resolved = backendFolderFor(machineId, value);
        if (resolved.error != null) return creation._complete(resolved.error);
        launchChoices[key] = resolved.path;
      }
    }
    final operation = creation.awaitingConfirmation
        ? 'agent_create_status'
        : 'agent_create';
    final unconfirmed =
        '$machineName has not confirmed the new agent yet. '
        'Check status before creating another.';
    Map<String, dynamic> result;
    creation._awaitingConfirmation = true;
    try {
      if (operation == 'agent_create_status') {
        result = await connection.request(
          operation,
          payload: {'creationId': creation._id},
          timeout: const Duration(seconds: 10),
        );
        if (result['creationId'] != creation._id) return unconfirmed;
      } else {
        result = await connection.request(
          operation,
          payload: {...launchChoices, 'creationId': creation._id},
          timeout: const Duration(seconds: 20),
        );
      }
    } on WsRequestFailure catch (failure) {
      if (operation == 'agent_create_status') {
        if (failure.code == 'UNSUPPORTED' ||
            failure.code == 'UNSUPPORTED_ON_REMOTE' ||
            failure.code == 'E2EE_REQUIRED') {
          return '$machineName cannot check this creation. '
              'Use Find a harness to look for it before creating another.';
        }
        return unconfirmed;
      }
      // Refusals that happen before a launch are safe to correct. INTERNAL,
      // spawn timeouts and connection failures cannot prove nothing started.
      const refusedBeforeLaunch = {
        'INVALID_PROJECT_SOURCE',
        'INVALID_REPOSITORY',
        'CWD_NOT_FOUND',
        'INVALID_CWD',
        'INVALID_ENGINE',
        'INVALID_GRID',
        'INVALID_CODEX_HOME',
        'INVALID_DSH',
        'PROMPT_UNSUPPORTED',
        'PROMPT_TOO_LONG',
        'INVALID_PROMPT',
        'AGENT_UNSUPPORTED',
        'TMUX_UNAVAILABLE',
        'TMUX_TOO_OLD_FOR_GRID',
        'GRID_CONFIG_FAILED',
        'UNSUPPORTED_ON_REMOTE',
        'UNSUPPORTED',
      };
      if (refusedBeforeLaunch.contains(failure.code)) {
        if (failure.code == 'INVALID_CWD' && choices['projectSource'] != null) {
          return creation._complete(
            'Update Harness CLI on $machineName to create or clone project folders. Local can open an existing folder.',
          );
        }
        return creation._complete(
          _creationFailureMessage(failure.code, failure.detail, machineName),
        );
      }
      return unconfirmed;
    } catch (_) {
      // Includes disconnects, malformed replies and timeouts. A transport error
      // is not evidence that the machine did not execute the request.
      return unconfirmed;
    }
    if ((result.containsKey('creationId') || result['state'] != null) &&
        result['creationId'] != creation._id) {
      return unconfirmed;
    }
    switch (result['state']) {
      case 'missing':
        // An old CLI may have created the agent before being updated to a
        // receipt-aware version. Missing is not proof that nothing started.
        // Check status stays read-only, even across upgrades and reconnects.
        return '$machineName has no record of this request. '
            'Use Find a harness to look for it before creating another.';
      case 'pending':
        return '$machineName is still starting your agent. Check again in a moment.';
      case 'unconfirmed':
        return '$machineName could not confirm whether this agent started. '
            'Use Open Harness to look for it before creating another.';
      case 'unavailable':
        return creation._complete(
          'This harness was created but is no longer available. '
          'You can create a new one.',
        );
      case 'failed':
        final failure = result['failure'];
        if (failure is! Map || failure['code'] is! String) return unconfirmed;
        if (result['preparedFolder'] case final String folder
            when folder.isNotEmpty) {
          creation._preparedFolder = folder;
        }
        return creation._complete(
          _creationFailureMessage(
            failure['code'] as String,
            failure['detail'] is String ? failure['detail'] as String : null,
            machineName,
          ),
        );
      case 'created':
      case null: // A successful first response from a CLI predating receipts.
        break;
      default:
        return unconfirmed;
    }
    final raw = result['agent'];
    if (raw is! Map || raw['id'] is! String || (raw['id'] as String).isEmpty) {
      return unconfirmed;
    }
    final Agent agent;
    try {
      agent = Agent.fromJson(Map<String, dynamic>.from(raw));
    } catch (_) {
      return unconfirmed;
    }
    creation._complete(null);
    if (_disposed || machineStates[machineId] != machine) return null;
    _upsertAgent(machine, agent);
    // Apply each creation receipt once, even if its transport result is replayed.
    final projectPath =
        agent.project?.cwd ?? creation.preparedFolder ?? choices['cwd'];
    if (projectPath is String && projectPath.isNotEmpty) {
      unawaited(projectHistory.select(machineId, projectPath));
    }
    harnessStats.onAgentSpawned();
    notifyListeners();
    if (_creationPlacementError(targetId, split) != null) {
      _lastError =
          'The harness was created, but its original tab or layout changed. '
          'Use Open Harness to find it.';
      _lastErrorRetryable = false;
      notifyListeners();
      return null;
    }
    await assignAgentToPane(
      null,
      machineId,
      agent.id,
      swarmId: targetId,
      split: split,
    );
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
      for (final swarm in swarms) {
        swarm.remove(pane);
      }
      await _detachSession(pane, sendClose: true);
    }
    _persistLayout();
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

  /// Stops an agent via the legacy `agent_delete` request, removing its active
  /// entry while preserving files and saved history. Returns an error on failure.
  Future<String?> deleteAgent(String machineId, String agentId) async {
    final machine = machineStates[machineId];
    if (machine == null) return 'Machine not found';
    Map<String, dynamic> result;
    try {
      result = await _conn(machineId)
          .request('agent_delete', payload: {'agentId': agentId});
    } catch (error) {
      return 'Stop failed: $error';
    }
    final error = result['error'];
    if (error is String) return 'Stop failed: $error';
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

  /// Forks an agent via `agent_fork`: a second agent that starts with the
  /// first one's whole history, in the same folder, then goes its own way.
  ///
  /// The fork lands beside its source — in the source's tab when that is the
  /// tab on screen, else in the current tab — and takes focus, because the
  /// person asked for it a moment ago and is about to give it its job. Same
  /// upsert-from-reply rule as [restartAgent].
  Future<ForkAgentResult> forkAgent(
    String machineId,
    String agentId, {
    String? name,
    String? prompt,
  }) async {
    final machine = machineStates[machineId];
    if (machine == null) {
      return const ForkAgentResult(error: 'Machine not found');
    }
    Map<String, dynamic> result;
    try {
      result = await _conn(machineId).request(
        'agent_fork',
        payload: {
          'agentId': agentId,
          if (name != null && name.trim().isNotEmpty) 'name': name.trim(),
          if (prompt != null && prompt.trim().isNotEmpty) 'prompt': prompt,
        },
      );
    } catch (error) {
      return ForkAgentResult(error: 'Fork failed: $error');
    }
    final error = result['error'];
    if (error is String) {
      final detail = result['detail'];
      return ForkAgentResult(
        error: detail is String
            ? detail
            : switch (error) {
                'UNSUPPORTED_ON_REMOTE' || 'UNSUPPORTED' =>
                  'Update the harness CLI on this machine to fork a harness.',
                'AGENT_BUSY' => 'This harness is in the middle of a turn. Wait for it to finish, then fork.',
                _ => 'Fork failed: $error',
              },
      );
    }
    final raw = result['agent'];
    if (raw is! Map) return const ForkAgentResult(error: 'Fork failed');
    final Agent fork;
    try {
      fork = Agent.fromJson(Map<String, dynamic>.from(raw));
    } catch (_) {
      return const ForkAgentResult(error: 'Fork failed');
    }
    _upsertAgent(machine, fork);
    notifyListeners();
    await placeFork(machineId, fork.id, sourceAgentId: agentId);
    final level = result['level'];
    return ForkAgentResult(
      level: level is String ? level : 'native',
      agentId: fork.id,
    );
  }

  /// Put a fork on screen beside its source and focus it — the window's half
  /// of a fork asked for here or on the dial (`dial_forked`).
  Future<void> placeFork(
    String machineId,
    String agentId, {
    required String sourceAgentId,
  }) async {
    if (revealAgentView(machineId, agentId)) return;
    // The current tab: it is where the source was forked from, whether by the
    // pane's own menu or by the dial, which shows this tab too. `sourceAgentId`
    // is kept on the wire for a placement that wants the source's tab later.
    assert(sourceAgentId.isEmpty || sourceAgentId != agentId);
    if (activeSwarm.panes.length >= maxPanes) {
      // Beside the source is the wish; a tab of its own is the honest fallback.
      newSwarm();
    }
    await addAgentToSwarm(machineId, agentId, swarmId: activeSwarmId);
    revealAgentView(machineId, agentId);
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
      //
      // Once per outage, not once per reconnect attempt: the local socket retries every second
      // now, and each attempt lands here again through the `reconnecting` status. A pane already
      // dark with this very message has nothing to learn and nothing to repaint.
      if (session.status == TerminalSessionStatus.error &&
          session.errorCode == 'TERMINAL_DISCONNECTED' &&
          session.errorMessage == message) {
        continue;
      }
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
          // Loading already reattaches retained panes across every tab. Selecting that agent
          // again would insert it into the current tab and steal focus from the user's work.
          // Only fulfill a pending selection when it has no pane yet and the user is still on
          // this machine; a reconnect must preserve the layout and selection they left open.
          final hasPane = allPanes.any(
            (pane) => pane.machineId == machineId && pane.agentId == agentId,
          );
          if (!hasPane && selectedMachineId == machineId) {
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

  /// A dial notification was tapped: bring that agent to the front.
  ///
  /// The window is tabs now (owner, 2026-09-15): the tab that already holds
  /// the agent wins — the current one first, then any other — and the tab
  /// switches with the pane focused. No tab holds it: it gets a tab of its own
  /// rather than a tile squeezed into whatever happened to be open, which is
  /// also what keeps a full tab from turning a tap into a capacity error.
  ///
  /// Never opened twice: the daemon keeps a single controller per agent, so a
  /// second open is a takeover — the window would fight itself and the first
  /// tile would go dark with `TERMINAL_TAKEN_OVER`. [revealAgentView] is what
  /// Open Harness uses for the same reason.
  /// `harness remote`'s hand-over: the tile showing [fromAgentId] on
  /// [fromMachineId] becomes [agentId]'s on [machineId] — the SAME tile, in
  /// place: its slot, its pin, its cell key and so its widget all stay, only
  /// the machine and agent it points at change and the terminal inside it is
  /// replaced. The shell the command was typed in is then stopped, so the old
  /// terminal is gone rather than left behind. Nothing happens when no tile
  /// here shows that agent: the push reaches every window, and the tile is
  /// in one.
  ///
  /// Not [assignAgentToPane]: that removes the tile and inserts a new one,
  /// which remounts the cell and can slide the grid — a move should read as
  /// the tile changing what it shows, not as one tile leaving and another
  /// arriving.
  ///
  /// The new agent may not be in [machineId]'s list yet: its `agent_created`
  /// push travels on that machine's connection, the hand-over on this one, and
  /// the two are unordered. So the list is asked for again, and the agent is
  /// waited for a little, before the tile is pointed at it.
  Future<void> handoffTerminalPane(
    String fromMachineId,
    String fromAgentId,
    String machineId,
    String agentId,
  ) async {
    Swarm? tab;
    TerminalPane? tile;
    for (final swarm in swarms) {
      for (final pane in swarm.panes) {
        if (pane.machineId == fromMachineId && pane.agentId == fromAgentId) {
          tab = swarm;
          tile = pane;
          break;
        }
      }
      if (tile != null) break;
    }
    if (tab == null || tile == null) return;
    final target = machineStates[machineId];
    if (target == null) {
      _lastError = 'The machine the terminal opened on is not in this window.';
      _lastErrorRetryable = false;
      notifyListeners();
      return;
    }
    if (!await _awaitAgent(target, agentId)) {
      _lastError =
          '${target.machine.displayName} opened a terminal, but it has not appeared yet.';
      _lastErrorRetryable = false;
      notifyListeners();
      return;
    }
    if (_disposed || !allPanes.contains(tile)) return;
    // The old stream goes first (the cell shows "Attaching…" for the moment
    // between), then the tile is re-pointed and the new one attached.
    await _detachSession(tile, sendClose: true);
    if (_disposed) return;
    tile
      ..machineId = machineId
      ..agentId = agentId
      ..sharedHarness = null
      ..sharedOwnerName = null;
    target.activeAgentId = agentId;
    _dismissedLinkPrompts.remove(machineId);
    if (tab.id != activeSwarmId) selectSwarm(tab.id);
    if (tab == activeSwarm) selectedMachineId = machineId;
    focusPane(tile.id, reveal: true);
    notifyListeners();
    _persistLayout();
    unawaited(_attachSession(tile));
    // The old shell: `harness remote` has exited in it, and the tile is no
    // longer its. Ending it is what makes the switch a move, not a copy.
    await deleteAgent(fromMachineId, fromAgentId);
  }

  /// Whether [machine] lists [agentId], asking it again and watching for the
  /// push for a few seconds when it does not yet. The reload is not awaited:
  /// it waits on the connection being ready, and the agent's own
  /// `agent_created` usually lands on it first.
  Future<bool> _awaitAgent(MachineState machine, String agentId) async {
    bool known() => machine.agents.any((agent) => agent.id == agentId);
    if (known()) return true;
    unawaited(_loadMachineData(machine, force: true).catchError((_) {}));
    for (var attempt = 0; attempt < 32 && !_disposed; attempt++) {
      await Future<void>.delayed(const Duration(milliseconds: 250));
      if (known()) return true;
    }
    return known();
  }

  Future<void> openAgentFromDial(String machineId, String agentId) async {
    if (revealAgentView(machineId, agentId)) {
      selectedMachineId = machineId;
      notifyListeners();
      return;
    }
    // Its own tab. newSwarm reuses an unused start page when there is one, and
    // at the tab limit leaves the current tab selected — the agent then lands
    // there, with the usual capacity message if that tab is full.
    newSwarm();
    await addAgentToSwarm(machineId, agentId, swarmId: activeSwarmId);
  }

  /// Enable-time fallback: preserve the user's current choice and acknowledge it.
  /// Selection records focus before waiting for terminal attachment, so a later
  /// user click is never overwritten by completion of an asynchronous open.
  Future<void> ensureDeviceFocus(Map<String, dynamic> payload) async {
    final expiresAt = payload['expiresAt'];
    final machineId = payload['machineId'];
    final agentId = payload['agentId'];
    final focusRevision = payload['focusRevision'];
    if (expiresAt is! num ||
        expiresAt <= DateTime.now().millisecondsSinceEpoch ||
        machineId is! String ||
        agentId is! String ||
        agentId.isEmpty ||
        focusRevision is! String ||
        focusRevision.isEmpty) {
      return;
    }
    if (focusedPane?.agentId != null) {
      _announceAppFocus();
      return;
    }
    // Tag only the synchronous fallback announcement, never a later user click.
    late Future<void> selection;
    _deviceFocusRevision = focusRevision;
    try {
      selection = selectAgent(machineId, agentId);
    } finally {
      _deviceFocusRevision = null;
    }
    await selection;
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
        if (!_canAttachPane(existing)) return;
        // Retry the dead stream in place so its output and view context remain
        // available until the next keyframe. Healthy panes stay focus-only.
        await terminal.reopen();
      }
      return;
    }
    await addAgentToSwarm(machineId, agentId);
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
        .where(
          (pane) =>
              pane.machineId == machineId &&
              pane.agentId == null &&
              !pane.isWeb,
        )
        .firstOrNull;
    if (existing != null) {
      focusPane(existing.id);
      notifyListeners();
      return;
    }

    final target = focusedPane;
    if (target != null && target.agentId == null && !target.isWeb) {
      target.machineId = machineId;
      focusPane(target.id);
      notifyListeners();
      return;
    }
    if (!canAddPane) return;
    final pane = TerminalPane(id: _nextPaneId++, machineId: machineId);
    panes.add(pane);
    focusPane(pane.id);
    notifyListeners();
  }

  /// Put an agent into a specific tile, or into a NEW tile when [paneId] is
  /// null — which is what a drop on the empty slot means.
  Future<void> assignAgentToPane(
    int? paneId,
    String machineId,
    String agentId, {
    String? swarmId,
    PaneSplitRequest? split,
  }) async {
    final target = swarms
        .where((s) => s.id == (swarmId ?? activeSwarmId))
        .firstOrNull;
    if (target == null || _disposed) return;
    if (split != null &&
        (split.swarmId != target.id ||
            paneId != null ||
            !isPaneSplitCurrent(split))) {
      return;
    }
    final targetPanes = target.panes;
    final machine = machineStates[machineId];
    if (machine == null) return;

    Agent? agent;
    for (final candidate in machine.agents) {
      if (candidate.id == agentId) {
        agent = candidate;
        break;
      }
    }
    if (agent == null) return;

    final shared = allPanes
        .where((p) => p.machineId == machineId && p.agentId == agentId)
        .firstOrNull;
    final existing = targetPanes
        .where((p) => p.machineId == machineId && p.agentId == agentId)
        .firstOrNull;
    if (paneId == null && existing != null) {
      if (target == activeSwarm) focusPane(existing.id);
      return;
    }
    final replaced = targetPanes.where((p) => p.id == paneId).firstOrNull;
    if (replaced == shared && shared != null) {
      if (target == activeSwarm) focusPane(shared.id);
      return;
    }
    if (replaced == null &&
        existing == null &&
        targetPanes.length >= maxPanes) {
      _lastError =
          'This tab holds $maxPanes agents. Open another tab to add more.';
      _lastErrorRetryable = false;
      notifyListeners();
      return;
    }
    final insertion = replaced == null
        ? split == null
              ? targetPanes.length
              : split.paneIds.indexOf(split.paneId) + 1
        : targetPanes.indexOf(replaced);
    if (existing != null) target.remove(existing);
    if (replaced != null) target.remove(replaced);
    final pane =
        shared ??
        TerminalPane(id: _nextPaneId++, machineId: machineId, agentId: agentId);
    final firstAgent = targetPanes.every((pane) => pane.agentId == null);
    if (machine.machine.isShared) {
      pane.sharedHarness = machine.machine.sharedHarnesses
          .where((g) => g.agentId == agentId)
          .firstOrNull;
      pane.sharedOwnerName = machine.machine.ownerName;
    }
    targetPanes.insert(insertion.clamp(0, targetPanes.length), pane);
    if (split != null) {
      target.pinnedSlots.updateAll(
        (_, slot) => slot >= insertion ? slot + 1 : slot,
      );
      final key = '${targetPanes.length}:manual';
      target.savePaneSizes(key, split.after);
      target.arranged = split.after;
      target.arrangedKey = key;
    }
    if (firstAgent && target.name == Swarm.defaultName) {
      target.name = _nextHarnessName();
    }
    if (replaced != null && !allPanes.contains(replaced)) {
      // Release just the desktop stream. The CLI agent process keeps running.
      unawaited(_detachSession(replaced, sendClose: true));
    }

    target.focusedPaneId = pane.id;
    target.zoomedPaneId = null;
    if (target == activeSwarm) selectedMachineId = machineId;
    _dismissedLinkPrompts.remove(machineId);
    machine.activeAgentId = agentId;
    _persistLayout();
    // SAID OUTRIGHT, like every other move.
    //
    // This path — a rail click on an agent with no tile — was the one that never said it. It relied on
    // the daemon inferring the move from the `terminal_open` that follows, which is the old
    // one-terminal-per-window equivalence [see _announceAppFocus]. Two things wrong with that: the
    // roster below changes the dial's carousel, so the focus and the roster are one transaction and the
    // inference arrives after it by luck; and every early return under here (machine offline, terminal
    // capability missing, a session already attached) opens no stream at all, so nothing was ever sent
    // and the dial stayed on the old agent with the window on the new one.
    //
    // After _persistLayout, so the daemon has the new tile roster before it is told to move onto it. A
    // duplicate with the inferred one is free: the daemon drops the second against where the dial
    // already is.
    if (target == activeSwarm) _announceAppFocus();
    // The agent may already have a viewer the grid could not show until now,
    // because this tile is what it hangs beside.
    _syncViewerPane(machine, agent);

    if (machine.nodeOnline == false) {
      machine.pendingOfflineAgentId = agentId;
      _startOfflineRetry(machine);
      notifyListeners();
      return;
    }
    if (!machine.terminalCapabilityAvailable) {
      notifyListeners();
      return;
    }
    machine.pendingOfflineAgentId = null;
    _stopOfflineRetry(machineId);
    notifyListeners();
    if (target == activeSwarm || pane.session != null) {
      await _attachSession(pane);
    }
  }

  /// Open the stream for a tile that already knows what it wants.
  ///
  /// Separate from [assignAgentToPane] because a restored tile takes this path
  /// on its own, later, when its machine finally answers — the intent was
  /// settled at launch, and nothing about the selection should move again then.
  Future<void> _attachSession(TerminalPane pane) async {
    if (_disposed || !allPanes.contains(pane) || pane.session != null) return;
    final wantedAgentId = pane.agentId;
    if (wantedAgentId == null) return;
    final machine = machineStates[pane.machineId];
    if (machine == null) return;
    if (machine.machine.isShared) {
      pane.sharedHarness = machine.machine.sharedHarnesses
          .where((g) => g.agentId == wantedAgentId)
          .firstOrNull;
      pane.sharedOwnerName = machine.machine.ownerName;
      notifyListeners();
      return;
    }
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

    final terminal = TerminalSession(
      machineId: pane.machineId,
      agentId: agent.id,
      agentName: agent.name,
      engineId: agent.engine,
      send: (type, payload) =>
          _conn(pane.machineId).sendTerminalFrame(type, payload),
      sendBinary: (frame) => _sendTerminalBinary(pane.machineId, frame),
      onOpenStalled: () => _conn(pane.machineId).forceReconnect(),
      // A `terminal_open` can round-trip app → local CLI → (for a relayed
      // machine) the E2EE relay → the remote peer → tmux → back, possibly
      // negotiating P2P on the way, so a cold open legitimately takes several
      // seconds. Give the open watchdog 15s before it forces a full redial, so
      // a merely slow open is not mistaken for a stale session and re-dialled
      // needlessly; the forced-reconnect recovery still runs if it elapses.
      resyncTimeout: const Duration(seconds: 15),
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
    if (isPanePinned(panes[to])) _setPin(panes[to], to);
    if (isPanePinned(panes[from])) _setPin(panes[from], from);
    _persistLayout();
    notifyListeners();
  }

  /// How many columns the grid last laid out.
  ///
  /// Only `auto` needs telling: it measures the window, so it is the one shape
  /// whose columns are not in its own description. Reported by the grid as it
  /// builds; null until then, and then the shape's own guess stands.
  int? get gridColumns => activeSwarm.gridColumns;
  set gridColumns(int? value) => activeSwarm.gridColumns = value;

  bool hasNavigationRail = true;

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
    final shape = activeSwarm.arranged?.tiles.length == count
        ? activeSwarm.arranged!.tiles
        : presetFor(count)?.tilesFor(count, columns: gridColumns);
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
    if (hasNavigationRail) focusRail();
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
    final shape = activeSwarm.arranged?.tiles.length == count
        ? activeSwarm.arranged!.tiles
        : presetFor(count)?.tilesFor(count, columns: gridColumns);
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
  int? get _previousPaneId => activeSwarm.previousPaneId;
  set _previousPaneId(int? value) => activeSwarm.previousPaneId = value;

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
  int? get zoomedPaneId => activeSwarm.zoomedPaneId;
  set zoomedPaneId(int? value) => activeSwarm.zoomedPaneId = value;

  void toggleZoomPane() {
    final id = focusedPaneId;
    if (id == null || panes.length < 2) return;
    zoomedPaneId = zoomedPaneId == id ? null : id;
    _persistLayout();
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
  int? pinnedSlotFor(TerminalPane pane) =>
      hasNavigationRail ? pane.pinnedSlot : activeSwarm.pinnedSlots[pane.id];

  bool isPanePinned(TerminalPane pane) => pinnedSlotFor(pane) != null;

  void _setPin(TerminalPane pane, int? slot) {
    if (slot == null) {
      activeSwarm.pinnedSlots.remove(pane.id);
    } else {
      activeSwarm.pinnedSlots[pane.id] = slot;
    }
    if (hasNavigationRail) pane.pinnedSlot = slot;
  }

  void togglePinPane(int paneId) {
    final index = panes.indexWhere((pane) => pane.id == paneId);
    if (index == -1) return;
    final pane = panes[index];
    _setPin(pane, isPanePinned(pane) ? null : index);
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
    final pinned = panes.where(isPanePinned).toList()
      ..sort((a, b) => pinnedSlotFor(a)!.compareTo(pinnedSlotFor(b)!));
    for (final pane in pinned) {
      final want = pinnedSlotFor(pane)!;
      if (want >= panes.length) continue;
      final at = panes.indexOf(pane);
      if (at == want) continue;
      panes.removeAt(at);
      panes.insert(want, pane);
    }
  }

  Future<void> closePane(int paneId, {bool persist = true}) async {
    final pane = panes.where((p) => p.id == paneId).firstOrNull;
    if (pane == null) return;
    if (pane.isWeb) {
      // A viewer closed by hand stays closed for THIS page: the agent's next
      // frame carries the same URL and must not reopen it. A different URL —
      // a new artifact, a restarted viewer — is news, and opens again.
      final owner = pane.ownerAgentId;
      final viewerState = pane.url ?? pane.viewerError;
      if (owner != null && viewerState != null) {
        _dismissedViewers[_viewerKey(pane.machineId, owner)] = viewerState;
      }
    }
    if (pane.agentId != null) {
      final machine = stateOf(pane.machineId);
      final agent = machine?.agents
          .where((a) => a.id == pane.agentId)
          .firstOrNull;
      _rememberClosed(
        ClosedAgent(
          pane,
          activeSwarm,
          historyId: 'closed-${_nextClosedHistoryId++}',
          name: agent?.name ?? pane.session?.agentName ?? pane.agentId!,
          machineName: machine?.machine.displayName ?? pane.machineId,
          engine: agent?.identityEngine ?? pane.session?.engineId,
        ),
      );
    }
    // Only a close that moves the focus is worth telling the daemon about: a
    // background tile going away changes nothing the dial can see.
    final wasFocused = focusedPaneId == paneId;
    activeSwarm.remove(pane);
    // A harness's viewer lives beside its terminal and nowhere else: closing
    // the terminal in this tab takes the viewer in this tab with it. The
    // viewer's own close above is different — it is a choice about the page.
    if (!pane.isWeb && pane.agentId != null) {
      for (final viewer in activeSwarm.panes.toList()) {
        if (viewer.isWeb &&
            viewer.machineId == pane.machineId &&
            viewer.ownerAgentId == pane.agentId) {
          activeSwarm.remove(viewer);
        }
      }
    }
    _settlePins();
    if (persist) _persistLayout();
    selectedMachineId = focusedPane?.machineId;
    if (wasFocused) _announceAppFocus();
    notifyListeners();
    if (!allPanes.contains(pane)) await _detachSession(pane, sendClose: true);
  }

  Future<void> _closeAllPanes({bool persist = true}) async {
    final open = allPanes.toList();
    for (final swarm in swarms) {
      swarm.panes.clear();
      swarm.focusedPaneId = null;
      swarm.zoomedPaneId = null;
    }
    _announceAppFocus();
    for (final pane in open) {
      await _detachSession(pane, sendClose: true);
    }
    if (persist) _persistLayout();
  }

  int _layoutRevision = 0;

  Future<void> flushPaneLayout() =>
      _paneLayout?.flushSwarms() ?? Future<void>.value();

  String _nextHarnessName() {
    var next = BigInt.one;
    final names = [
      for (final swarm in swarms) swarm.name,
      for (final entry in _closedHistory)
        if (entry is ClosedSwarm)
          entry.name
        else if (entry is ClosedAgent)
          entry.swarmName,
    ];
    for (final name in names) {
      final match = RegExp(r'^harness-([1-9]\d*)$').firstMatch(name);
      if (match == null) continue;
      final number = BigInt.parse(match.group(1)!);
      if (number >= next) next = number + BigInt.one;
    }
    return 'harness-$next';
  }

  void _persistLayout() {
    _draftSwarmReturns.removeWhere((id, _) {
      final swarm = swarms.where((swarm) => swarm.id == id).firstOrNull;
      return swarm == null ||
          swarm.panes.isNotEmpty ||
          swarm.name != Swarm.defaultName ||
          swarm.presets.isNotEmpty;
    });
    _layoutRevision++;
    _announceOpenPanesToDial();
    final saved = swarms.where((swarm) => !isDraftSwarm(swarm.id)).toList();
    if (saved.isEmpty) return;
    final savedActive = isDraftSwarm(activeSwarmId)
        ? _draftSwarmReturns[activeSwarmId]
        : activeSwarmId;
    unawaited(
      _paneLayout?.saveSwarms(
        saved,
        saved.any((swarm) => swarm.id == savedActive)
            ? savedActive!
            : saved.last.id,
      ),
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
    final initialSwarm = activeSwarm;
    final revision = _layoutRevision;
    final saved = await store.loadSwarms();
    if (_disposed || revision != _layoutRevision) return;
    if (saved != null &&
        allPanes.isEmpty &&
        swarms.length == 1 &&
        activeSwarm == initialSwarm) {
      final restored = <Swarm>[];
      final pool = <String, TerminalPane>{};
      for (final raw in (saved['swarms'] as List)) {
        if (raw is! Map || raw['id'] is! String || raw['panes'] is! List) {
          continue;
        }
        final id = raw['id'] as String;
        if (id.isEmpty || restored.any((s) => s.id == id)) continue;
        // An empty tab carrying the store's name is the store — a layout
        // saved by a build that did not yet write the kind — and one store
        // tab, as one New Tab: a second has nothing the first does not.
        final isStore =
            raw['kind'] == 'store' ||
            (raw['name'] == Swarm.storeName && (raw['panes'] as List).isEmpty);
        if (isStore && restored.any((s) => s.isStore)) continue;
        final swarm =
            Swarm(
                id: id,
                name:
                    raw['name'] is String &&
                        (raw['name'] as String).trim().isNotEmpty
                    ? (raw['name'] as String).substring(
                        0,
                        (raw['name'] as String).length.clamp(0, 80),
                      )
                    : Swarm.defaultName,
                kind: isStore
                    ? 'store'
                    : raw['kind'] == 'orchestrator'
                    ? 'orchestrator'
                    : 'harness',
              )
              ..orchestratorId =
                  raw['orchestratorId'] is String &&
                      RegExp(r'^[a-f0-9]{32}$')
                          .hasMatch(raw['orchestratorId'] as String)
                  ? raw['orchestratorId'] as String
                  : null
              ..orchestratorMachineId = raw['orchestratorMachineId'] is String
                  ? raw['orchestratorMachineId'] as String
                  : null;
        for (final item in (raw['panes'] as List).take(maxPanes)) {
          final entry = PaneLayoutEntry.fromJson(item);
          if (entry == null) continue;
          final key = '${entry.machineId}\u0000${entry.agentId}';
          final pane = pool.putIfAbsent(
            key,
            () =>
                TerminalPane(
                    id: _nextPaneId++,
                    machineId: entry.machineId,
                    agentId: entry.agentId,
                  )
                  ..composerVisible = entry.composerVisible
                  ..pinnedSlot = entry.pinnedSlot,
          );
          if (!swarm.panes.contains(pane)) {
            swarm.panes.add(pane);
            if (entry.pinnedSlot != null) {
              swarm.pinnedSlots[pane.id] = entry.pinnedSlot!;
            }
          }
        }
        int? paneAt(Object? index) =>
            index is int && index >= 0 && index < swarm.panes.length
            ? swarm.panes[index].id
            : null;
        swarm.focusedPaneId =
            paneAt(raw['focus']) ?? swarm.panes.firstOrNull?.id;
        swarm.zoomedPaneId = paneAt(raw['zoom']);
        swarm.previousPaneId = paneAt(raw['previousFocus']);
        if (raw['presets'] case final Map presets) {
          for (final e in presets.entries) {
            final count = int.tryParse(e.key.toString());
            final preset = PanePreset.byId(e.value?.toString());
            if (count != null &&
                count >= 2 &&
                count <= maxPanes &&
                preset != null &&
                preset.supportsCount(count)) {
              swarm.presets[count] = preset;
            }
          }
        }
        swarm.paneSizes.addAll(PaneArrangement.readSaved(raw['paneSizes']));
        restored.add(swarm);
      }
      if (restored.isNotEmpty) {
        // Older builds saved multiple unused start pages. Retain the selected
        // one when possible; custom names, presets and real work stay intact.
        final starters = restored.where((swarm) => swarm.isEmptyStarter);
        final starter =
            starters
                .where((swarm) => swarm.id == saved['activeId'])
                .firstOrNull ??
            starters.firstOrNull;
        final hadDuplicateStarters = starters.length > 1;
        if (hadDuplicateStarters) {
          restored.removeWhere(
            (swarm) => swarm.isEmptyStarter && swarm != starter,
          );
        }
        swarms
          ..clear()
          ..addAll(restored);
        _activeSwarmId = restored.any((s) => s.id == saved['activeId'])
            ? saved['activeId'] as String
            : restored.first.id;
        while (swarms.any((s) => s.id == 'swarm-$_nextSwarmId')) {
          _nextSwarmId++;
        }
        _autoPickedAgent = true;
        if (hadDuplicateStarters) _persistLayout();
        notifyListeners();
        return;
      }
    }
    // Read before the guards below: the dividers are remembered even for a
    // grid this run has not restored any agents into, so a window that opens
    // empty and is then filled by hand still comes up the shape it was left.
    final legacyPresets = await store.loadPresets();
    if (_disposed || revision != _layoutRevision) return;
    if (allPanes.isNotEmpty ||
        swarms.length != 1 ||
        activeSwarm != initialSwarm) {
      return;
    }
    final entries = await store.load();
    if (_disposed || revision != _layoutRevision) return;
    panePresets.addAll(legacyPresets);
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
  void _attachPendingPanes(MachineState machine, {bool retryExisting = true}) {
    final machineId = machine.machine.machineId;
    for (final pane in allPanes.toList()) {
      if (!panes.contains(pane) && pane.session == null) continue;
      if (pane.machineId != machineId) continue;
      // Navigation may mount a new view; it must never retry a retained stream
      // or discard its output while the machine is unavailable.
      if (!retryExisting && pane.session != null) continue;
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

  /// Reopen a dead stream in its existing session, keeping its rendered output.
  /// An already-lost stream needs no close addressed to its previous owner.
  Future<void> _reattachPane(TerminalPane pane) async {
    if (!_canAttachPane(pane)) return;
    final session = pane.session;
    if (session == null) {
      await _attachSession(pane);
    } else {
      await session.reopen();
    }
  }

  bool _canAttachPane(TerminalPane pane) {
    if (_disposed || !allPanes.contains(pane)) return false;
    final machine = machineStates[pane.machineId];
    return machine != null &&
        machine.nodeOnline != false &&
        machine.terminalCapabilityAvailable &&
        !(machine.isRemote && !machine.isLocalMachine && machine.needsLink) &&
        (!machine.isLocalMachine || machine.usesLocalTransport) &&
        machine.agents.any((a) => a.id == pane.agentId && a.terminalAvailable);
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
    if (type == 'orchestrator_changed') {
      _orchestratorProjects['$machineId/${payload['id']}']?.changed();
      return;
    }
    // Only terminal protocol frames visit the session pool. Heartbeats, dial
    // scroll and discovery events must not await every retained terminal.
    // Each session still sees terminal frames: ready replies match their own
    // request/agent, while transport errors must reach the whole machine.
    if (type.startsWith('terminal_')) {
      for (final pane in panesFor(machineId).toList()) {
        await pane.session?.handleFrame(type, payload);
      }
      return;
    }
    if (SessionPreviewStore.eventTypes.contains(type)) {
      final agentId = _eventAgentId(machine, event, payload);
      final agent = machine.agents
          .where((agent) => agent.id == agentId)
          .firstOrNull;
      final sessionId = _eventSessionId(event, payload);
      if (agent != null &&
          sessionId != null &&
          agent.sessionId != null &&
          sessionId != agent.sessionId) {
        return;
      }
      if (agent != null &&
          (sessionId == null ||
              agent.sessionId == null ||
              sessionId == agent.sessionId)) {
        sessionPreviews.ingest(
          previewKey(machineId, agent),
          type,
          payload,
          streamingText: agent.engine == 'opencode' || agent.engine == 'kilo',
        );
      }
      // Content belongs to the preview's notifier. It must not invalidate the
      // entire workspace and catalog for every token or tool event.
      if (type != 'turn_started' && type != 'turn_ended') return;
    }
    switch (type) {
      // ── the dial, over the cable, forwarded by the local daemon ──────────────────────────────────
      // Local-only frames (backend.sendLocal in the harness CLI): they describe a hand at THIS desk, so
      // they never reach the cloud web audience, who may be sitting at another computer entirely.
      case 'dial_status':
        // The dial came, went, or started taking an update. Its own notifier —
        // see [dial] — so nothing else in the window rebuilds for it.
        dial.apply(DialStatus.fromJson(payload));
        return;
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
        return;
      case 'device_focus':
        unawaited(ensureDeviceFocus(payload));
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
      case 'dial_swarm':
        // The dial picked a swarm from its own list. The ordinary switch, exactly as ⌘] or a click on
        // the tab: the desk changes, `_persistLayout` re-describes it, and the dial's ring and swarm
        // line follow from that — nothing is answered to the dial directly.
        final swarmId = payload['swarmId'];
        if (swarmId is String && swarmId.isNotEmpty) selectSwarm(swarmId);
        break;
      case 'dial_forked':
        // The dial forked an agent; the daemon already opened the pane on its
        // machine. Land it beside its source and focus it, as the window's own
        // Fork does.
        final forkId = payload['agentId'];
        final forkSource = payload['sourceAgentId'];
        if (forkId is String && forkId.isNotEmpty) {
          final targetMachineId = _dialFocusMachine(payload, forkId);
          if (targetMachineId != null) {
            unawaited(
              placeFork(
                targetMachineId,
                forkId,
                sourceAgentId: forkSource is String ? forkSource : '',
              ),
            );
          }
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
      case 'remote_terminal_handoff':
        // `harness remote`, typed in one of this window's terminal tiles, opened a
        // terminal on another machine: that tile becomes the new agent's, in
        // place, and the shell it was typed in is ended. Pushed to every
        // loopback client; only the window holding the tile acts.
        final fromAgentId = payload['fromAgentId'];
        final toMachineId = payload['machineId'];
        final toAgentId = payload['agentId'];
        if (fromAgentId is String &&
            fromAgentId.isNotEmpty &&
            toMachineId is String &&
            toMachineId.isNotEmpty &&
            toAgentId is String &&
            toAgentId.isNotEmpty) {
          unawaited(
            handoffTerminalPane(
              machine.machine.machineId,
              fromAgentId,
              toMachineId,
              toAgentId,
            ),
          );
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
              // A process replacement can briefly publish an agent before its
              // terminal route is verified. `agent_synced` is a snapshot, not
              // a deletion authority: removing every tile here turns that
              // short gap into a lost workspace even though tmux and the
              // agent are still alive. Keep the pane/layout intent and let a
              // later available sync reattach it. A confirmed `agent_deleted`
              // event remains the sole path that removes a person's panes.
              _upsertAgent(machine, agent);
              for (final pane in panesFor(machine.machine.machineId)) {
                if (pane.agentId != agent.id) continue;
                await _detachSession(pane, sendClose: false);
              }
              notifyListeners();
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
      case 'dsh_install_status':
        // The machine narrating an install this window (or another) asked for.
        // Only ever advances a known install: a phase for an id nobody here
        // asked about is still worth showing, so it is recorded either way.
        final progress = DshInstallProgress.fromJson(payload);
        if (progress != null) machine.dsh.applyInstall(progress);
        break;
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
        var changed = false;
        final agentId = _eventAgentId(machine, event, payload);
        if (agentId != null) {
          changed = _markAgentProcessing(machine, agentId);
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
            changed = machine.pendingProcessingSessions.add(sessionId);
          }
        }
        // Renew the watchdog on every heartbeat, but redraw only when the
        // agent first becomes busy. Expiry and turn end publish separately.
        if (!changed) return;
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
  Future<void> restorePaneLayoutForTest() => _restorePaneLayout();

  @visibleForTesting
  Future<void> handleMachineEventForTest(
    String machineId,
    Map<String, dynamic> event,
  ) => _handleEvent(machineId, event);

  @visibleForTesting
  Future<void> handleTerminalBinaryForTest(String machineId, Uint8List frame) =>
      _handleTerminalBinary(machineId, frame);

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
    for (final project in _orchestratorProjects.values) {
      project.dispose();
    }
    grid.AppTheme.palette.removeListener(_announceTerminalThemeEverywhere);
    terminalThemeStore.removeListener(_announceTerminalThemeEverywhere);
    _localGitProjects.dispose();
    sessionPreviews.dispose();
    _disposed = true;
    _sharingDiscoveryTimer?.cancel();
    _stopMachineRecovery();
    if (signingIn) cliLogin.cancel();
    _closedHistory.clear();
    _daemonSupervisionTimer?.cancel();
    _updateCheckTimer?.cancel();
    _environmentRecheckTimer?.cancel();
    _stopAllOfflineRetries();
    _stopAllLinkRetries();
    _stopAllAgentSyncTimers();
    _clearAllTurnActivity();
    for (final pane in allPanes) {
      pane.session?.removeListener(notifyListeners);
      pane.session?.dispose();
    }
    for (final swarm in swarms) {
      swarm.panes.clear();
    }
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
