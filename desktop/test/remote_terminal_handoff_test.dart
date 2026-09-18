// `harness remote`, typed in a terminal tile: the daemon pushes `remote_terminal_handoff` and the tile
// becomes the new agent's on the other machine — same slot, same tab — while the shell it was typed in
// is stopped. A window with no such tile does nothing; an agent that has not arrived yet is waited for.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/ws_conn.dart';

class _Connection extends WsConn {
  _Connection(String machineId)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: machineId,
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final calls = <(String, Map<String, dynamic>)>[];
  Future<Map<String, dynamic>> Function(String type, Map<String, dynamic>)?
  answer;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    calls.add((type, Map.of(payload)));
    return answer?.call(type, payload) ?? Future.value({});
  }
}

Map<String, dynamic> _agentJson(String id, {String engine = 'terminal'}) => {
  'id': id,
  'name': id,
  'engine': engine,
  'terminal': {
    'runtimes': [
      {'backend': 'tmux', 'paneId': '%1'},
    ],
  },
};

Agent _agent(String id, {String engine = 'terminal'}) =>
    Agent.fromJson(_agentJson(id, engine: engine));

MachineState _machine(AppNotifier app, String id, List<Agent> agents) {
  final machine = Machine(
    machineId: id,
    apiKey: '',
    authMode: MachineAuthMode.remote,
    name: id,
    status: 'online',
  );
  final state = MachineState(machine)
    ..nodeOnline =
        false // keeps _attachSession from dialling out
    ..agentLoadStatus = AgentLoadStatus.loaded
    ..agents = agents;
  app.machines = [...app.machines, machine];
  app.machineStates[id] = state;
  return state;
}

List<(String, String?)> _desk(AppNotifier app) => [
  for (final p in app.panes) (p.machineId, p.agentId),
];

void main() {
  late Map<String, _Connection> connections;
  AppNotifier notifier() => AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
    connectionForTest: (machineId) =>
        connections.putIfAbsent(machineId, () => _Connection(machineId)),
  );

  setUp(() => connections = {});

  Future<void> handoff(
    AppNotifier app, {
    String from = 'shell-local',
    String machine = 'box',
    String agent = 'shell-remote',
  }) => app.handleEventForTest('mac', {
    'type': 'remote_terminal_handoff',
    'payload': {'fromAgentId': from, 'machineId': machine, 'agentId': agent},
  });

  test('the tile the command was typed in becomes the remote terminal, in place, and the old shell is stopped', () async {
    final app = notifier();
    _machine(app, 'mac', [
      _agent('claude-1', engine: 'claude'),
      _agent('shell-local'),
    ]);
    _machine(app, 'box', [_agent('shell-remote')]);
    await app.assignAgentToPane(null, 'mac', 'claude-1');
    await app.assignAgentToPane(null, 'mac', 'shell-local');
    expect(_desk(app), [('mac', 'claude-1'), ('mac', 'shell-local')]);
    final tile = app.panes[1];
    tile.pinnedSlot = 1;

    await handoff(app);
    await Future<void>.delayed(Duration.zero);

    expect(_desk(app), [('mac', 'claude-1'), ('box', 'shell-remote')]);
    // The same tile, re-pointed: no new pane, no remount, its pin kept.
    expect(identical(app.panes[1], tile), isTrue);
    expect(tile.pinnedSlot, 1);
    expect(app.focusedPane?.agentId, 'shell-remote');
    expect(
      connections['mac']!.calls
          .where((call) => call.$1 == 'agent_delete')
          .map((call) => call.$2['agentId']),
      ['shell-local'],
      reason: 'the shell harness remote ran in is ended, not left behind',
    );
    expect(app.machineStates['mac']!.agents.map((a) => a.id), ['claude-1']);
    app.dispose();
  });

  test('a window with no tile for that shell does nothing', () async {
    final app = notifier();
    _machine(app, 'mac', [_agent('shell-local')]);
    _machine(app, 'box', [_agent('shell-remote')]);
    await handoff(app);
    await Future<void>.delayed(Duration.zero);
    expect(_desk(app), isEmpty);
    expect(connections['mac']?.calls ?? [], isEmpty);
    app.dispose();
  });

  test('an agent whose agent_created arrives after the hand-over is waited for, then placed', () async {
    final app = notifier();
    _machine(app, 'mac', [_agent('shell-local')]);
    _machine(app, 'box', []);
    await app.assignAgentToPane(null, 'mac', 'shell-local');

    await handoff(app);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(_desk(app), [
      ('mac', 'shell-local'),
    ], reason: 'not yet: the agent is unknown');
    // The other machine's own push lands on its own connection, a moment later.
    await app.handleEventForTest('box', {
      'type': 'agent_created',
      'payload': {'agent': _agentJson('shell-remote')},
    });
    await Future<void>.delayed(const Duration(milliseconds: 700));

    expect(_desk(app), [('box', 'shell-remote')]);
    app.dispose();
  });

  test('a malformed push is ignored', () async {
    final app = notifier();
    _machine(app, 'mac', [_agent('shell-local')]);
    await app.assignAgentToPane(null, 'mac', 'shell-local');
    await app.handleEventForTest('mac', {
      'type': 'remote_terminal_handoff',
      'payload': {'fromAgentId': 'shell-local', 'machineId': 'box'},
    });
    await Future<void>.delayed(Duration.zero);
    expect(_desk(app), [('mac', 'shell-local')]);
    expect(connections['mac']?.calls ?? [], isEmpty);
    app.dispose();
  });
}
