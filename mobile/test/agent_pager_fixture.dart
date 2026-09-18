import 'dart:convert';
import 'dart:typed_data';

import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/agent_index.dart';
import 'package:harness_mobile/phone/agent_swipe_list.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/terminal_binary.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';
import 'package:harness_mobile/viewer/viewer_key_store.dart';
import 'package:harness_mobile/viewer/viewer_services.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

import 'voice_fakes.dart';

/// A machine that accepts every terminal frame and remembers what it was sent.
class PagerConn extends WsConn {
  PagerConn()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final List<(String, Map<String, dynamic>)> frames = [];

  List<Map<String, dynamic>> get opens => [
    for (final (type, payload) in frames)
      if (type == 'terminal_open') payload,
  ];

  @override
  Future<bool> sendTerminalFrame(
    String type,
    Map<String, dynamic> payload,
  ) async {
    frames.add((type, payload));
    return true;
  }

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async => {};
}

const pagerAgentIds = ['a', 'b', 'c', 'd'];

/// One machine `m` running [pagerAgentIds], reached through [conn] — as a phone reaches it when
/// [viewer], with no CLI and nothing written to disk.
AppNotifier pagerApp(
  PagerConn conn, {
  bool online = true,
  bool viewer = false,
}) {
  final session = AuthSession();
  final app = AppNotifier(
    config: AppConfig.dev,
    authSession: session,
    configStore: null,
    connectionForTest: (_) => conn,
    viewer: viewer
        ? ViewerServices(
            config: AppConfig.dev,
            session: session,
            keys: ViewerKeyStore(storage: MemoryKeyValueStore()),
          )
        : null,
  );
  const machine = Machine(
    machineId: 'm',
    authMode: MachineAuthMode.remote,
    name: 'Test host',
  );
  app.machines = [machine];
  app.machineStates['m'] = MachineState(machine)
    ..nodeOnline = online
    ..connectionStatus = ConnectionStatus.connected
    ..agentLoadStatus = AgentLoadStatus.loaded
    ..terminalCapabilityAvailable = true
    ..activeAgentId = 'a'
    ..agents = [
      for (final id in pagerAgentIds)
        Agent(
          id: id,
          name: id,
          engine: 'claude',
          project: const AgentProject(name: 'work', cwd: '/work'),
          terminalAvailable: true,
        ),
    ];
  return app;
}

/// Every agent on `m`, in order, as the pager swipes through them.
AgentSwipeList pagerList(AppNotifier app) => AgentSwipeList([
  for (final agent in app.stateOf('m')!.agents)
    AgentEntry(machine: app.stateOf('m')!, agent: agent),
]);

/// The agent on screen, live at a phone's size.
Future<TerminalSession> liveAgent(AppNotifier app, String agentId) async {
  final session = TerminalSession(
    machineId: 'm',
    agentId: agentId,
    agentName: agentId,
    engineId: 'claude',
    send: (_, _) async => true,
    sendBinary: (_) async => true,
  );
  app.adoptSessionForTest(session);
  await goLive(session);
  return session;
}

/// The machine's first keyframe landing on [session]: a screen, at a phone's size.
///
/// ⚠️ **A keyframe, not fields set by hand.** Only a keyframe gives a session a screen
/// (`hasRenderedFrame`); until then the page lays its skeleton over the terminal, and that skeleton
/// breathes for ever — no `pumpAndSettle` would return. It also disarms the open's watchdog and
/// notifies, which is the signal the pager waits on.
///
/// ⚠️ **`terminal_ready` is skipped on purpose.** It starts the session's heartbeat, a periodic
/// timer `testWidgets` fails on before `addTearDown` has disposed the app.
Future<void> goLive(TerminalSession session) async {
  final streamId = 'stream-${session.agentId}';
  session.streamId = streamId;
  await session.handleBinary(
    TerminalBinaryFrame(
      kind: TerminalBinaryKind.keyframe,
      streamId: streamId,
      seq: 0,
      bytes: Uint8List.fromList(utf8.encode('prompt> ')),
      compressed: false,
      cols: 46,
      rows: 38,
    ),
  );
}
