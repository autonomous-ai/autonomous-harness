import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/orchestrator/orchestrator_controller.dart';
import 'package:harness/orchestrator/orchestrator_launcher.dart';
import 'package:harness/orchestrator/orchestrator_workspace.dart';
import 'package:harness/state/pending_question.dart';
import 'package:harness/widgets/web_pane_panel.dart';
import 'package:harness/ws/ws_conn.dart';

import 'orchestrator_test.dart' show project, projectId, task;
import 'swarm_state_test.dart' show createApp;

class _Connection extends WsConn {
  _Connection(this.reply)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final OrchestratorRequest reply;
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) => reply(payload);
}

void largeSurface(WidgetTester tester) {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(1400, 1000);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);
}

void main() {
  test(
    'refresh failures remain visible and a later refresh recovers',
    () async {
      var fail = true;
      final model = OrchestratorController(
        id: projectId,
        request: (_) async {
          if (fail) throw StateError('Transport unavailable');
          return {'project': project()};
        },
      );
      addTearDown(model.dispose);
      await model.refresh();
      expect(model.error, contains('Transport unavailable'));
      fail = false;
      await model.refresh();
      expect(model.error, isNull);
    },
  );

  testWidgets(
    'launcher uses the preferred engine and displays list and launch errors',
    (tester) async {
      largeSurface(tester);
      final app = createApp(
        connectionForTest: (_) => _Connection((p) async {
          if (p['action'] == 'list') throw StateError('Saved projects offline');
          return {
            'error': 'DECLINED',
            'detail': 'The server refused this launch',
          };
        }),
      );
      app.machineStates['m']!.localOnly = true;
      app.agentPreference.value = 'codex';
      addTearDown(app.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => TextButton(
              onPressed: () => showOrchestratorLauncher(context, app),
              child: const Text('Launch'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Launch'));
      await tester.pumpAndSettle();
      expect(find.text('Codex director'), findsOneWidget);
      expect(find.textContaining('Saved projects offline'), findsOneWidget);
      await tester.enterText(
        find.byKey(const ValueKey('orchestrator-prompt')),
        'Test project',
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('orchestrator-start')));
      await tester.pumpAndSettle();
      expect(
        find.textContaining('The server refused this launch'),
        findsOneWidget,
      );
      await tester.tap(find.byTooltip('Close'));
      await tester.pumpAndSettle();
      expect(find.byType(OrchestratorLauncher), findsNothing);
    },
  );

  testWidgets(
    'normal workspace uses its cached controller and only opens terminals on Inspect',
    (tester) async {
      largeSurface(tester);
      final app = createApp(
        connectionForTest: (_) => _Connection(
          (p) async => p['action'] == 'list'
              ? {'projects': []}
              : {
                  'project': {
                    ...project(
                      tasks: [
                        {...task('cad'), 'agentId': 'a1'},
                      ],
                    ),
                    'directorId': 'a0',
                  },
                },
        ),
      );
      app.machineStates['m']!.localOnly = true;
      var disposed = false;
      addTearDown(() {
        if (!disposed) app.dispose();
      });
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: OrchestratorWorkspace(
              notifier: app,
              machineId: 'm',
              projectId: projectId,
            ),
          ),
        ),
      );
      await tester.pump();
      expect(app.panes, isEmpty);
      await tester.tap(find.byTooltip('Inspect cad'));
      await tester.pump();
      expect(app.activeSwarm.panes.any((p) => p.agentId == 'a1'), isTrue);
      await tester.tap(find.byTooltip('Inspect director'));
      await tester.pump();
      expect(app.activeSwarm.panes.any((p) => p.agentId == 'a0'), isTrue);
      await tester.tap(find.byTooltip('New project (⌘P)'));
      await tester.pumpAndSettle();
      expect(find.byType(OrchestratorLauncher), findsOneWidget);
      await tester.tap(find.byTooltip('Close'));
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox());
      app.dispose();
      disposed = true;
    },
  );
  test('task projection tolerates optional fields and ignores malformed artifact rows', () {
    final minimal = OrchestratorTask({
      'id': 'research',
      'artifacts': [
        null,
        {},
        {'path': 'notes.md'},
      ],
    });
    expect(minimal.title, 'research');
    expect(minimal.state, 'queued');
    expect(minimal.harness, '');
    expect(minimal.attempt, 1);
    expect(minimal.summary, '');
    expect(minimal.viewerName, 'research');
    expect(minimal.artifacts, ['notes.md']);
    expect(minimal.agentId, isNull);
    expect(minimal.runtime, isNull);
    expect(minimal.uncertain, isFalse);
    expect(minimal.hasViewer, isTrue);
    expect(
      OrchestratorTask({
        'id': 'x',
        'runtime': {'error': 'Viewer stopped'},
      }).error,
      'Viewer stopped',
    );
  });

  testWidgets(
    'subscriptions coalesce, refcount and stop polling when the tab closes',
    (tester) async {
      var reads = 0;
      final model = OrchestratorController(
        id: projectId,
        pollInterval: const Duration(seconds: 1),
        request: (_) async {
          reads++;
          return {'project': project(revision: reads)};
        },
      );
      model.changed();
      model.watch();
      model.watch();
      await tester.pump();
      expect(reads, 1);
      model.changed();
      model.changed();
      await tester.pump(const Duration(milliseconds: 180));
      expect(reads, 2);
      model.unwatch();
      await tester.pump(const Duration(seconds: 1));
      expect(reads, 3);
      model.changed();
      model.unwatch();
      await tester.pump(const Duration(seconds: 2));
      expect(reads, 3);
      model.dispose();
      model.watch();
      model.changed();
      model.unwatch();
    },
  );

  test('coalesces in-flight reads and ignores other projects and late disposed replies', () async {
    final response = Completer<Map<String, dynamic>>();
    var calls = 0;
    final model = OrchestratorController(
      id: projectId,
      request: (_) {
        calls++;
        return response.future;
      },
    );
    final first = model.refresh(), second = model.refresh();
    expect(calls, 1);
    expect(identical(first, second), isTrue);
    response.complete({
      'project': {...project(), 'id': 'different'},
    });
    await first;
    expect(model.project, isNull);
    model.dispose();
    expect(await model.perform('cancel'), isFalse);
    expect(await model.send('hello'), isFalse);
    await model.refresh(); // An outstanding caller cannot revive a disposed projection.
  });

  test(
    'action and send locks prevent double dispatch and preserve a newer draft',
    () async {
      var response = Completer<Map<String, dynamic>>();
      final model = OrchestratorController(
        id: projectId,
        request: (_) => response.future,
      );
      addTearDown(model.dispose);
      final operation = model.perform('retry', taskId: 'cad');
      expect(await model.perform('retry', taskId: 'cad'), isFalse);
      response.complete({
        'error': 'REFUSED',
        'detail': 'Inspect the original worker',
      });
      expect(await operation, isFalse);
      expect(model.error, contains('Inspect the original worker'));
      expect(model.operating, isFalse);
      expect(await model.send('   '), isFalse);
      response = Completer<Map<String, dynamic>>();
      model.draft = 'First message';
      final send = model.send(model.draft);
      expect(await model.send('Duplicate'), isFalse);
      model.draft = 'Newer unsent draft';
      response.complete({'project': project()});
      expect(await send, isTrue);
      expect(model.draft, 'Newer unsent draft');
    },
  );

  testWidgets(
    'launcher submits explicit options with Cmd-Enter and opens one project tab',
    (tester) async {
      largeSurface(tester);
      final requests = <Map<String, dynamic>>[];
      final connection = _Connection((p) async {
        requests.add(p);
        return p['action'] == 'list'
            ? {'projects': []}
            : {
                'project': {...project(), 'prompt': p['prompt']},
              };
      });
      final app = createApp(connectionForTest: (_) => connection);
      app.machineStates['m']!.localOnly = true;
      addTearDown(app.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => TextButton(
              onPressed: () => showOrchestratorLauncher(context, app),
              child: const Text('Launch'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Launch'));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<FilledButton>(
              find.byKey(const ValueKey('orchestrator-start')),
            )
            .onPressed,
        isNull,
      );
      await tester.enterText(
        find.byKey(const ValueKey('orchestrator-prompt')),
        '  A fitted enclosure  ',
      );
      await tester.tap(find.text('Claude director'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Codex director').last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Project options'));
      await tester.pumpAndSettle();
      final folder = find.byWidgetPredicate(
        (w) =>
            w is TextField &&
            w.decoration?.labelText == 'Project folder (optional)',
      );
      await tester.ensureVisible(folder);
      await tester.enterText(folder, ' /tmp/fixture-project ');
      expect(
        tester.widget<CheckboxListTile>(find.byType(CheckboxListTile)).value,
        isFalse,
      );
      await tester.ensureVisible(find.byType(CheckboxListTile));
      await tester.tap(find.byType(CheckboxListTile));
      await tester.pump();
      await tester.tap(folder);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
      await tester.pumpAndSettle();
      final start = requests.singleWhere((p) => p['action'] == 'start');
      expect(start['engine'], 'codex');
      expect(start['cwd'], '/tmp/fixture-project');
      expect(start['bypassPermission'], isTrue);
      expect(start['prompt'], 'A fitted enclosure');
      expect(app.activeSwarm.orchestratorId, projectId);
      expect(find.byType(OrchestratorLauncher), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('recent project opens without starting a new director', (
    tester,
  ) async {
    largeSurface(tester);
    final requests = <String>[];
    final app = createApp(
      connectionForTest: (_) => _Connection((p) async {
        requests.add(p['action'] as String);
        return {
          'projects': [
            {'id': projectId, 'prompt': 'Existing lamp', 'state': 'completed'},
          ],
        };
      }),
    );
    app.machineStates['m']!.localOnly = true;
    addTearDown(app.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () => showOrchestratorLauncher(context, app),
            child: const Text('Launch'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Launch'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Existing lamp'));
    await tester.tap(find.text('Existing lamp'));
    await tester.pumpAndSettle();
    expect(requests, ['list']);
    expect(app.activeSwarm.orchestratorId, projectId);
  });

  testWidgets(
    'disconnected launcher explains how to connect without creating a project',
    (tester) async {
      largeSurface(tester);
      final app = createApp();
      app.machineStates.clear();
      addTearDown(app.dispose);
      await tester.pumpWidget(
        MaterialApp(home: OrchestratorLauncher(notifier: app)),
      );
      await tester.enterText(
        find.byKey(const ValueKey('orchestrator-prompt')),
        'A lamp',
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('orchestrator-start')));
      await tester.pump();
      expect(
        find.text('Connect this computer’s Harness daemon first.'),
        findsOneWidget,
      );
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'workspace confirms scoped stopping and exposes safe retry and resume',
    (tester) async {
      largeSurface(tester);
      final app = createApp();
      addTearDown(app.dispose);
      var current = project(
        tasks: [
          {
            ...task('cad', state: 'failed'),
            'error': 'Missing tool',
            'attempt': 2,
          },
          {...task('unknown', state: 'blocked'), 'uncertain': true},
          {
            ...task('notes', state: 'succeeded'),
            'hasViewer': false,
            'summary': 'Verified notes',
            'artifacts': [
              {'path': 'notes.md'},
            ],
          },
        ],
      );
      final requests = <Map<String, dynamic>>[];
      final model = OrchestratorController(
        id: projectId,
        request: (p) async {
          requests.add(p);
          if (p['action'] == 'cancel') {
            current = {...current, 'state': 'cancelled', 'revision': 2};
          }
          if (p['action'] == 'resume') {
            current = {...current, 'state': 'active', 'revision': 3};
          }
          return {'project': current};
        },
      );
      addTearDown(model.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: OrchestratorWorkspace(
              notifier: app,
              machineId: 'm',
              projectId: projectId,
              controller: model,
            ),
          ),
        ),
      );
      await tester.pump();
      expect(find.byTooltip('Retry task'), findsOneWidget);
      await tester.tap(find.byTooltip('Retry task'));
      await tester.pump();
      expect(requests.last, {
        'action': 'retry',
        'id': projectId,
        'taskId': 'cad',
      });
      expect(find.text('notes.md'), findsOneWidget);
      await tester.tap(find.text('Stop'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Keep working'));
      await tester.pumpAndSettle();
      expect(requests.any((p) => p['action'] == 'cancel'), isFalse);
      await tester.tap(find.text('Stop'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Stop project'));
      await tester.pumpAndSettle();
      expect(requests.last, {'action': 'cancel', 'id': projectId});
      expect(
        tester
            .widget<TextField>(
              find.byKey(const ValueKey('orchestrator-composer')),
            )
            .enabled,
        isFalse,
      );
      await tester.tap(find.text('Resume'));
      await tester.pump();
      expect(requests.last['action'], 'resume');
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'viewer zoom, runtime errors, delivery receipts and director questions stay visible',
    (tester) async {
      largeSurface(tester);
      final app = createApp();
      addTearDown(app.dispose);
      app.machineStates['m']!.blockedAgents['director'] = PendingQuestion(
        machineId: 'm',
        agentId: 'director',
        requestId: 'q',
        answerKey: 'Continue?',
        prompt: 'Material?',
        options: const ['Metal'],
        multi: false,
        since: DateTime.now(),
      );
      var current = {
        ...project(
          tasks: [
            {
              ...task('cad', url: 'http://127.0.0.1:9999/'),
              'error': 'Viewer is reconnecting',
            },
            {...task('research'), 'hasViewer': false},
          ],
        ),
        'directorWorking': true,
        'error': 'Transport lost',
        'messages': [
          {'id': '1', 'role': 'user', 'text': 'First', 'delivery': 'unknown'},
          {
            'id': '2',
            'role': 'system',
            'text': 'Second',
            'delivery': 'failed',
            'deliveryReason': 'Cancelled',
          },
          {'id': '3', 'role': 'user', 'text': 'Third', 'delivery': 'queued'},
        ],
      };
      final requests = <Map<String, dynamic>>[];
      final model = OrchestratorController(
        id: projectId,
        request: (p) async {
          requests.add(p);
          return {'project': current};
        },
      );
      addTearDown(model.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: OrchestratorWorkspace(
              notifier: app,
              machineId: 'm',
              projectId: projectId,
              controller: model,
            ),
          ),
        ),
      );
      await tester.pump();
      expect(find.text('Viewer is reconnecting'), findsOneWidget);
      expect(find.textContaining('Delivery unconfirmed.'), findsOneWidget);
      expect(
        find.textContaining('Message not delivered. Cancelled'),
        findsOneWidget,
      );
      expect(find.text('Queued for the agent'), findsOneWidget);
      expect(find.text('Director is working…'), findsOneWidget);
      expect(
        find.textContaining('The director needs your input'),
        findsOneWidget,
      );
      expect(
        find.textContaining('This specialist works in the background.'),
        findsOneWidget,
      );
      tester.widget<WebPanePanel>(find.byType(WebPanePanel)).onToggleZoom!();
      await tester.pump();
      expect(find.text('All views'), findsOneWidget);
      expect(find.text('research'), findsNothing);
      await tester.tap(find.text('All views'));
      await tester.pump();
      expect(find.text('research'), findsOneWidget);
      await tester.tap(find.text('Reconnect'));
      await tester.pump();
      expect(requests.last['action'], 'status');
      final composer = find.byKey(const ValueKey('orchestrator-composer'));
      await tester.enterText(composer, 'Draft');
      await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
      await tester.pump();
      expect(requests.any((p) => p['action'] == 'message'), isFalse);
      await tester.tap(find.byTooltip('Send to director'));
      await tester.pump();
      expect(requests.last['action'], 'message');
      current = {
        ...current,
        'revision': 2,
        'state': 'starting',
        'tasks': [],
        'directorId': null,
      };
      await model.refresh();
      await tester.pump();
      expect(find.text('Starting your director…'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
