// A harness created from the dialog gets a tab of its own, named after the
// harness — the viewer is the product and needs the width. A New Tab start
// page the user is already on is that tab; a tab with work in it is left alone.
import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

class _Request {
  _Request(this.type, this.payload);
  final String type;
  final Map<String, dynamic> payload;
  final reply = Completer<Map<String, dynamic>>();
  void created(String id) => reply.complete({
    'creationId': payload['creationId'],
    'state': 'created',
    'agent': {
      'id': id,
      'name': id,
      'engine': 'claude',
      'dsh': 'autonomous/autonomous-circuit',
    },
  });
}

class _Connection extends WsConn {
  _Connection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final calls = <_Request>[];
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    if (type == 'engines_probe') return Future.value({'engines': []});
    if (type == 'dsh_list') return Future.value({'dsh': []});
    final request = _Request(type, Map.of(payload));
    calls.add(request);
    return request.reply.future;
  }
}

void main() {
  test(
    'a harness created on an empty start page makes it the harness tab',
    () async {
      final connection = _Connection();
      final app = createApp(connectionForTest: (_) => connection);
      addTearDown(app.dispose);
      app.stateOf('m')!.localOnly = true;
      final starter = app.activeSwarm;
      expect(starter.isEmptyStarter, isTrue);

      final create = app.createAgent(
        'm',
        engine: 'claude',
        folder: '/w',
        dsh: 'autonomous/autonomous-circuit',
      );
      expect(app.swarms, hasLength(1), reason: 'the start page is reused');
      expect(app.activeSwarm.name, 'Autonomous Circuit');
      expect(connection.calls.single.type, 'agent_create');
      expect(connection.calls.single.payload['dsh'], 'autonomous/autonomous-circuit');
      connection.calls.single.created('c1');
      expect(await create, isNull);
      expect(app.activeSwarm, same(starter));
      expect(app.activeSwarm.panes.single.agentId, 'c1');
    },
  );

  test('a harness created beside other work opens its own tab', () async {
    final connection = _Connection();
    final app = createApp(connectionForTest: (_) => connection);
    addTearDown(app.dispose);
    app.stateOf('m')!.localOnly = true;
    final input = <TerminalBinaryFrame>[];
    app.adoptSessionForTest(terminal('a0', input));
    final busy = app.activeSwarm;

    final create = app.createAgent(
      'm',
      engine: 'codex',
      folder: '/w',
      dsh: 'autonomous/autonomous-workshop',
      // What the dialog passes when no tab was chosen: the current one.
      swarmId: app.activeSwarmId,
    );
    expect(app.swarms, hasLength(2));
    expect(app.activeSwarm, isNot(same(busy)));
    expect(app.activeSwarm.name, 'Autonomous Workshop');
    connection.calls.single.created('w1');
    expect(await create, isNull);
    expect(app.activeSwarm.panes.single.agentId, 'w1');
    expect(busy.panes, hasLength(1), reason: 'the other tab is untouched');
  });

  test('an engine without a harness lands where it always did', () async {
    final connection = _Connection();
    final app = createApp(connectionForTest: (_) => connection);
    addTearDown(app.dispose);
    app.stateOf('m')!.localOnly = true;
    final input = <TerminalBinaryFrame>[];
    app.adoptSessionForTest(terminal('a0', input));
    final busy = app.activeSwarm;
    final create = app.createAgent('m', engine: 'claude', folder: '/w');
    expect(app.swarms, hasLength(1));
    expect(app.activeSwarm, same(busy));
    connection.calls.single.created('p1');
    expect(await create, isNull);
    expect(busy.panes, hasLength(2));
  });
}
