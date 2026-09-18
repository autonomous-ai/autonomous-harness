import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/agent_index.dart';
import 'package:harness_mobile/phone/compact_age.dart';
import 'package:harness_mobile/phone/phone_search_folder_header.dart';
import 'package:harness_mobile/phone/phone_search_groups.dart';
import 'package:harness_mobile/phone/phone_search_index.dart';
import 'package:harness_mobile/phone/phone_search_page.dart';
import 'package:harness_mobile/phone/phone_search_rank.dart';
import 'package:harness_mobile/state/agent_recall.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/state/pending_question.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

final _now = DateTime.now();

Agent _agent(
  String id, {
  String? title,
  String cwd = '/srv/work',
  int? minutesAgo,
  bool terminal = true,
  String? gridModel,
  String? dshName,
}) => Agent(
  id: id,
  name: 'work · $id',
  title: title,
  engine: 'codex',
  gridModel: gridModel,
  dshName: dshName,
  project: AgentProject(name: 'work', cwd: cwd),
  updatedAt: minutesAgo == null
      ? null
      : _now.subtract(Duration(minutes: minutesAgo)),
  terminalAvailable: terminal,
);

MachineState _machine(String id, List<Agent> agents) =>
    MachineState(
        Machine(machineId: id, authMode: MachineAuthMode.remote, name: id),
      )
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..agents = agents;

void _markWaiting(MachineState machine, String agentId) =>
    machine.blockedAgents[agentId] = PendingQuestion(
      machineId: machine.machine.machineId,
      agentId: agentId,
      requestId: 'r',
      answerKey: 'q',
      prompt: 'q',
      options: const ['yes'],
      multi: false,
      since: _now,
    );

AppNotifier _app(List<MachineState> machines, {WsConn? conn}) {
  final app = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
    connectionForTest: conn == null ? null : (_) => conn,
  );
  app.machines = [for (final state in machines) state.machine];
  for (final state in machines) {
    app.machineStates[state.machine.machineId] = state;
  }
  return app;
}

/// A machine that remembers what was asked of each agent, and answers nothing else.
class _RecallConn extends WsConn {
  _RecallConn(this.asks)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'box',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  /// Agent id → the person's recent questions to it, newest first.
  final Map<String, List<String>> asks;
  final asked = <String>[];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type != 'agent_recent') return {'error': 'UNEXPECTED'};
    final agentId = payload['agentId'] as String;
    asked.add(agentId);
    return {'agentId': agentId, 'events': const [], 'asks': asks[agentId]};
  }
}

/// Lets every in-flight recall reply land.
Future<void> _settle() async {
  for (var i = 0; i < 8; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

List<String> _agentIds(List<PhoneSearchResult> rows) => [
  for (final row in rows)
    if (row.entry != null) row.entry!.agent.id,
];

void main() {
  group('Agent.fromJson', () {
    test('reads the title and when the conversation last moved', () {
      final agent = Agent.fromJson({
        'id': 'a',
        'name': 'work · 3188',
        'title': 'Fix login redirect',
        'updatedAt': '2026-09-17T07:00:00.000Z',
      });
      expect(agent.title, 'Fix login redirect');
      expect(agent.updatedAt, DateTime.utc(2026, 9, 17, 7));
      expect(agent.copyWith(name: 'x').updatedAt, agent.updatedAt);
    });

    test('reads what it runs on and what it was made as', () {
      final agent = Agent.fromJson({
        'id': 'a',
        'grid': {'baseUrl': 'http://grid', 'model': 'llama-3.1-8b-q4'},
        'selectedModel': 'gpt-5-codex',
        'dshName': 'Model manager',
      });
      expect(agent.gridModel, 'llama-3.1-8b-q4');
      expect(agent.selectedModel, 'gpt-5-codex');
      expect(agent.dshName, 'Model manager');
      expect(agent.copyWith(name: 'x').gridModel, agent.gridModel);
      expect(Agent.fromJson({'id': 'a', 'grid': null}).gridModel, isNull);
    });

    test('an older daemon, or garbage, leaves both unknown', () {
      final agent = Agent.fromJson({
        'id': 'a',
        'title': null,
        'updatedAt': 'yesterday-ish',
      });
      expect(agent.title, isNull);
      expect(agent.updatedAt, isNull);
    });
  });

  test('recentAgents: waiting, working, openable, then newest first', () {
    final machine = _machine('m', [
      _agent('undated'),
      _agent('old', minutesAgo: 90),
      _agent('gone', minutesAgo: 1, terminal: false),
      _agent('fresh', minutesAgo: 2),
      _agent('busy', minutesAgo: 60),
      _agent('asking', minutesAgo: 30),
    ]);
    machine.processingAgentIds.add('busy');
    _markWaiting(machine, 'asking');
    final entries = [
      for (final agent in machine.agents)
        AgentEntry(machine: machine, agent: agent),
    ];
    expect(recentAgents(entries).map((entry) => entry.agent.id), [
      'asking',
      'busy',
      'fresh',
      'old',
      'undated',
      'gone',
    ]);
  });

  group('search', () {
    final app = _app([
      _machine('box', [
        _agent('3188', minutesAgo: 1),
        _agent('48e9', title: 'Review payment flow', minutesAgo: 20),
        _agent('2312', cwd: '/srv/node', minutesAgo: 5),
      ]),
    ]);
    tearDownAll(app.dispose);

    test('a title ranks like a name, ahead of a fresher metadata hit', () {
      final withFolderHit = _app([
        _machine('box', [
          _agent('f00d', cwd: '/srv/reviewer', minutesAgo: 0),
          ...app.machineStates['box']!.agents,
        ]),
      ]);
      addTearDown(withFolderHit.dispose);
      final ranked = rankPhoneSearch(phoneSearchIndex(withFolderHit), 'review');
      expect(_agentIds(ranked), ['48e9', 'f00d']);
      expect(ranked.first.subtitle, 'Review payment flow');
    });

    test('groups keep recency: the freshest agent heads the first group', () {
      final groups = phoneSearchGroups(phoneSearchIndex(app));
      expect([for (final group in groups) group.folder], ['work', 'node']);
      expect(_agentIds(phoneSearchGroupedRows(groups)), [
        '3188',
        '48e9',
        '2312',
      ]);
    });

    test('what it runs on finds it: a grid model, a harness name', () {
      final models = _app([
        _machine('box', [
          _agent('1111', minutesAgo: 1),
          _agent('2222', gridModel: 'llama-3.1-8b-q4', minutesAgo: 9),
          _agent('3333', dshName: 'Model manager', minutesAgo: 30),
        ]),
      ]);
      addTearDown(models.dispose);
      final all = phoneSearchIndex(models);
      expect(_agentIds(rankPhoneSearch(all, 'llama')), ['2222']);
      expect(_agentIds(rankPhoneSearch(all, 'model manager')), ['3333']);
    });

    test('the best match is the first row of the first group', () {
      final ranked = rankPhoneSearch(phoneSearchIndex(app), '2312');
      final groups = phoneSearchGroups(ranked);
      expect(groups.first.folder, 'node');
      expect(_agentIds(groups.first.rows).first, '2312');
    });
  });

  group('recall', () {
    test('asks first, then each recap; cleaned, deduped, summaries only', () {
      final recall = parseAgentRecall({
        'asks': ['which \x1b[1mllama.cpp\x1b[0m build\nis this?', ''],
        'events': [
          {
            'kind': 'summary',
            'recap': 'Pinned llama.cpp b4521',
            'text': 'Pinned llama.cpp b4521',
          },
          {'kind': 'tool', 'text': 'ls -la'},
          'garbage',
        ],
      });
      expect(recall.lines, [
        'which llama.cpp build is this?',
        'Pinned llama.cpp b4521',
      ]);
      expect(recall.searchText, contains('b4521'));
    });

    test(
      'warms two at a time, never re-asks lately, survives failures',
      () async {
        final pending = <String, Completer<Map<String, dynamic>>>{};
        var now = DateTime(2026, 9, 18, 9);
        final store = AgentRecallStore(
          fetch: (key) => (pending[key.agentId] = Completer()).future,
          canFetch: (key) => key.machineId != 'offline',
          now: () => now,
        );
        addTearDown(store.dispose);
        AgentRecallKey key(String agentId, [String machineId = 'box']) =>
            (machineId: machineId, agentId: agentId, sessionId: null);

        store.warm([key('a'), key('b'), key('c'), key('x', 'offline')]);
        expect(pending.keys, ['a', 'b']);

        pending['a']!.complete({
          'agentId': 'a',
          'asks': ['llama?'],
        });
        pending['b']!.completeError(StateError('socket dropped'));
        await _settle();
        expect(pending.keys, ['a', 'b', 'c']);
        expect(store.read(key('a'))!.lines, ['llama?']);
        expect(store.read(key('b')), isNull);
        pending['c']!.complete({'agentId': 'c', 'asks': const []});
        await _settle();

        pending.clear();
        store.warm([key('a'), key('b')]);
        expect(
          pending,
          isEmpty,
          reason: 'both were asked less than freshFor ago',
        );
        now = now.add(const Duration(minutes: 3));
        store.warm([key('a'), key('b')]);
        expect(pending.keys, ['a', 'b']);
      },
    );

    test(
      'a word only said to an agent finds it, after every field match',
      () async {
        final conn = _RecallConn({
          'said': ['which llama.cpp build is running?'],
          'quiet': ['fix the login redirect'],
        });
        final app = _app([
          _machine('box', [
            _agent('said', minutesAgo: 1),
            _agent('quiet', minutesAgo: 2),
            _agent('named', gridModel: 'llama-3.1-8b', minutesAgo: 30),
          ]),
        ], conn: conn);
        addTearDown(app.dispose);
        expect(_agentIds(rankPhoneSearch(phoneSearchIndex(app), 'llama')), [
          'named',
        ]);

        app.agentRecall.warm([
          for (final agent in app.machineStates['box']!.agents)
            app.agentRecallKey('box', agent),
        ]);
        await _settle();
        final ranked = rankPhoneSearch(phoneSearchIndex(app), 'llama');
        expect(_agentIds(ranked), ['named', 'said']);
        expect(phoneRecallSnippet(ranked.first, ['llama']), isNull);
        expect(
          phoneRecallSnippet(ranked.last, ['llama']),
          'which llama.cpp build is running?',
        );
      },
    );
  });

  test('compactAge', () {
    final now = DateTime(2026, 9, 17, 12);
    String ago(Duration age) => compactAge(now.subtract(age), now);
    expect(ago(const Duration(seconds: 20)), 'now');
    expect(ago(const Duration(minutes: 4)), '4m');
    expect(ago(const Duration(hours: 2, minutes: 59)), '2h');
    expect(ago(const Duration(days: 3)), '3d');
    expect(ago(const Duration(days: 15)), '2w');
    expect(ago(const Duration(days: 400)), '1y');
    expect(compactAge(now.add(const Duration(minutes: 5)), now), 'now');
  });

  testWidgets('before a word: one Recent run, newest first, each row placed', (
    tester,
  ) async {
    final app = _app([
      _machine('box', [
        _agent('3188', title: 'Fix login redirect', minutesAgo: 4),
        _agent('2312', cwd: '/srv/node', minutesAgo: 30),
        _agent('9999', minutesAgo: 90),
      ]),
    ]);
    addTearDown(app.dispose);
    await tester.pumpWidget(MaterialApp(home: PhoneSearchPage(notifier: app)));
    await tester.pump();

    expect(find.text('RECENT'), findsOneWidget);
    expect(find.byType(PhoneSearchFolderHeader), findsNothing);
    expect(find.text('Fix login redirect · work · box'), findsOneWidget);
    expect(find.text('node · box'), findsOneWidget);
    expect(find.text('4m'), findsOneWidget);
    expect(find.text('30m'), findsOneWidget);
    double top(String name) => tester.getTopLeft(find.text(name)).dy;
    // The fresh `work` agent, then `node`, then the stale `work` one: a folder
    // does not pull its old agent up past a fresher one elsewhere.
    expect(top('work · 3188'), lessThan(top('work · 2312')));
    expect(top('work · 2312'), lessThan(top('work · 9999')));

    await tester.enterText(find.byType(TextField), 'login');
    await tester.pump();
    expect(find.text('RECENT'), findsNothing);
    expect(find.text('work · 2312'), findsNothing);
    expect(find.byType(PhoneSearchFolderHeader), findsOneWidget);
  });

  testWidgets('opening search asks for recall; the matching line is quoted', (
    tester,
  ) async {
    final conn = _RecallConn({
      '3188': ['which llama.cpp build is running?'],
    });
    final app = _app([
      _machine('box', [
        _agent('3188', minutesAgo: 4),
        _agent('2312', minutesAgo: 30),
      ]),
    ], conn: conn);
    addTearDown(app.dispose);
    await tester.pumpWidget(MaterialApp(home: PhoneSearchPage(notifier: app)));
    await tester.pump();
    expect(conn.asked, ['3188', '2312']);

    await tester.enterText(find.byType(TextField), 'llama');
    await tester.pump();
    expect(find.text('work · 3188'), findsOneWidget);
    expect(find.text('work · 2312'), findsNothing);
    expect(
      find.text('which llama.cpp build is running?', findRichText: true),
      findsOneWidget,
    );
  });

  testWidgets('one bar: no Cancel beside it, and its chevron closes search', (
    tester,
  ) async {
    final app = _app([
      _machine('box', [_agent('3188', minutesAgo: 4)]),
    ]);
    addTearDown(app.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () => openPhoneSearch(context, app),
            child: const Text('Open search'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open search'));
    await tester.pumpAndSettle();
    expect(find.byType(PhoneSearchPage), findsOneWidget);
    expect(find.text('Cancel'), findsNothing);

    await tester.tap(find.bySemanticsLabel('Back'));
    await tester.pumpAndSettle();
    expect(find.byType(PhoneSearchPage), findsNothing);
  });
}
