// Fork a harness: the request the app sends, where the fork lands, and what
// the model keeps about it.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/widgets/fork_agent_dialog.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show createApp;

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

  @override
  Future<void> connect() async {}
}

Map<String, dynamic> _agentJson(
  String id, {
  Map<String, dynamic>? forkedFrom,
}) => {
  'id': id,
  'name': id,
  'engine': 'claude',
  'status': 'active',
  'terminal': {'available': true, 'primary': '', 'runtimes': []},
  'forkedFrom': forkedFrom,
};

void main() {
  test(
    'the model keeps where a fork came from, and nothing for other agents',
    () {
      final fork = Agent.fromJson(
        _agentJson('f', forkedFrom: {'agentId': 'a0', 'name': 'Kinh Te'}),
      );
      expect(fork.forkedFrom?.agentId, 'a0');
      expect(fork.forkedFrom?.name, 'Kinh Te');
      expect(fork.copyWith(name: 'x').forkedFrom?.agentId, 'a0');
      expect(Agent.fromJson(_agentJson('a')).forkedFrom, isNull);
      // A row with an id and no name still says it is a fork.
      expect(
        Agent.fromJson(_agentJson('g', forkedFrom: {'agentId': 'a0'}))
            .forkedFrom
            ?.name,
        'an agent',
      );
    },
  );

  test('forkAgent sends agent_fork with the name and task, then lands the fork beside its source', () async {
    final connection = _Connection();
    final app = createApp(connectionForTest: (_) => connection);
    addTearDown(app.dispose);
    connection.answer = (type, payload) async {
      if (type == 'agent_fork') {
        return {
          'agent': _agentJson(
            'a0-fork',
            forkedFrom: {'agentId': 'a0', 'name': 'Agent 0'},
          ),
          'level': 'native',
        };
      }
      return {};
    };
    await app.addAgentToSwarm('m', 'a0');
    expect(app.activeSwarm.panes.map((p) => p.agentId), ['a0']);

    final result = await app.forkAgent(
      'm',
      'a0',
      name: 'Agent 0 - fork',
      prompt: 'ship it',
    );
    expect(result.error, isNull);
    expect(result.level, 'native');
    expect(result.agentId, 'a0-fork');
    final call = connection.calls.firstWhere((c) => c.$1 == 'agent_fork');
    expect(call.$2, {
      'agentId': 'a0',
      'name': 'Agent 0 - fork',
      'prompt': 'ship it',
    });

    // Beside the source, in the tab that was open, focused, and known to the machine.
    expect(app.activeSwarm.panes.map((p) => p.agentId), ['a0', 'a0-fork']);
    expect(app.focusedPane?.agentId, 'a0-fork');
    expect(
      app.machineStates['m']!.agents.any((a) => a.id == 'a0-fork'),
      isTrue,
    );
  });

  test('a refusal comes back as words, and nothing is placed', () async {
    final connection = _Connection();
    final app = createApp(connectionForTest: (_) => connection);
    addTearDown(app.dispose);
    connection.answer = (type, payload) async => {
      'error': 'AGENT_BUSY',
      'detail': 'Wait for it to finish, then fork.',
    };
    await app.addAgentToSwarm('m', 'a0');
    final result = await app.forkAgent('m', 'a0');
    expect(result.error, 'Wait for it to finish, then fork.');
    expect(app.activeSwarm.panes.map((p) => p.agentId), ['a0']);
    // An older daemon has no word for it; the app says what to do.
    connection.answer = (type, payload) async => {
      'error': 'UNSUPPORTED_ON_REMOTE',
    };
    expect(
      (await app.forkAgent('m', 'a0')).error,
      contains('Update the harness CLI'),
    );
  });

  test('a dial_forked push lands the fork the same way', () async {
    final connection = _Connection();
    final app = createApp(connectionForTest: (_) => connection);
    addTearDown(app.dispose);
    await app.addAgentToSwarm('m', 'a0');
    app.machineStates['m']!.agents.add(
      Agent.fromJson(
        _agentJson('a0-fork', forkedFrom: {'agentId': 'a0', 'name': 'Agent 0'}),
      ),
    );
    await app.handleEventForTest('m', {
      'type': 'dial_forked',
      'payload': {
        'machineId': 'm',
        'agentId': 'a0-fork',
        'sourceAgentId': 'a0',
      },
    });
    await Future<void>.delayed(Duration.zero);
    expect(app.activeSwarm.panes.map((p) => p.agentId), ['a0', 'a0-fork']);
    expect(app.focusedPane?.agentId, 'a0-fork');
  });

  testWidgets(
    'the dialog opens named "X - fork", takes a task, and ⌘Return forks',
    (tester) async {
      ({String name, String task})? picked;
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => TextButton(
              onPressed: () async {
                picked = await showForkAgentDialogForTest(
                  context,
                  'Kinh Te',
                  engine: 'claude',
                );
              },
              child: const Text('open'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.text('Fork Harness'), findsOneWidget);
      expect(find.textContaining('everything “Kinh Te” knows'), findsOneWidget);
      final name = tester.widget<TextField>(
        find.byKey(const ValueKey('fork-name')),
      );
      expect(name.controller!.text, 'Kinh Te - fork');
      await tester.enterText(
        find.byKey(const ValueKey('fork-task')),
        'ship it',
      );
      await tester.tap(find.byKey(const ValueKey('fork-submit')));
      await tester.pumpAndSettle();
      expect(picked, (name: 'Kinh Te - fork', task: 'ship it'));
    },
  );

  test('Fork is offered only where the daemon (or the engine) can fork', () {
    expect(
      Agent.fromJson({..._agentJson('a'), 'forkable': false}).canFork,
      isFalse,
    );
    expect(
      Agent.fromJson({..._agentJson('a'), 'forkable': true, 'engine': 'devin'})
          .canFork,
      isTrue,
    );
    // An older daemon says nothing: the engine decides.
    expect(
      Agent.fromJson({..._agentJson('a'), 'engine': 'devin'}).canFork,
      isFalse,
    );
    expect(
      Agent.fromJson({..._agentJson('a'), 'engine': 'codex'}).canFork,
      isTrue,
    );
    expect(
      Agent.fromJson({..._agentJson('a'), 'engine': 'opencode'}).canFork,
      isTrue,
    );
  });

  test('forkNameFor is the source name with " - fork"', () {
    expect(forkNameFor('Kinh Te'), 'Kinh Te - fork');
    expect(forkNameFor(' '), 'Agent - fork');
  });
}
