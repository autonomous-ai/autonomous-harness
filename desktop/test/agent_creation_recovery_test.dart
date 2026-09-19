import 'support/new_agent_project.dart';

import 'dart:async';

import 'package:file_selector_platform_interface/file_selector_platform_interface.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/stats/harness_stats.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/new_agent_dialog.dart';
import 'package:harness/widgets/swarm_switcher.dart';
import 'package:harness/ws/ws_conn.dart';

import 'keymap_runtime_test.dart' as runtime;
import 'swarm_state_test.dart' show createApp;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_interactions_test.dart' show chord;

class _FolderPicker extends FileSelectorPlatform {
  @override
  Future<String?> getDirectoryPath({
    String? initialDirectory,
    String? confirmButtonText,
  }) async => '/work';
}

class _Request {
  _Request(this.type, this.payload);
  final String type;
  final Map<String, dynamic> payload;
  final reply = Completer<Map<String, dynamic>>();
  String get creationId => payload['creationId'] as String;
  void status(String state, {Map<String, dynamic>? agent}) => reply.complete({
    'creationId': creationId,
    'state': state,
    'agent': ?agent,
  });
  void created([String id = 'created']) => status(
    'created',
    agent: {'id': id, 'name': 'Recovered agent', 'engine': 'claude'},
  );
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
    if (type == 'codex_profiles_list') return Future.value({'profiles': []});
    final request = _Request(type, Map.of(payload));
    calls.add(request);
    return request.reply.future;
  }
}

Future<void> _timeOut(
  AppNotifier app,
  _Connection connection,
  AgentCreationAttempt attempt,
) async {
  final create = app.createAgent(
    'm',
    engine: 'claude',
    folder: '/work',
    attempt: attempt,
  );
  connection.calls.last.reply.completeError(
    const WsRequestTimeout('agent_create'),
  );
  expect(await create, contains('Check status'));
  expect(attempt.awaitingConfirmation, isTrue);
}

void main() {
  for (final entry in ['header', 'shortcut', 'search shortcut', 'start page']) {
    for (final dismissal in ['outside', 'escape']) {
      testWidgets('$entry creation dismisses once on $dismissal', (
        tester,
      ) async {
        final connection = _Connection();
        final app = createApp(connectionForTest: (_) => connection);
        app.stateOf('m')!.localOnly = true;
        final input = <TerminalBinaryFrame>[];
        final pane = app.adoptSessionForTest(terminal('a0', input));
        final original = app.activeSwarmId;
        final keymap = AppKeymap();
        await runtime.mount(tester, app, keymap);
        switch (entry) {
          case 'header':
            await tester.tap(
              find.byKey(const ValueKey('swarm-new-agent-button')),
            );
          case 'start page':
            await chord(tester, LogicalKeyboardKey.keyT);
            await tester.tap(find.byKey(const ValueKey('harness-start-new')));
          case 'search shortcut':
            await chord(tester, LogicalKeyboardKey.keyO);
            await tester.enterText(
              find.byKey(const ValueKey('swarm-search-input')),
              'Agent 12',
            );
            await chord(tester, LogicalKeyboardKey.keyN);
          default:
            await chord(tester, LogicalKeyboardKey.keyN);
        }
        await tester.pumpAndSettle();
        expect(find.byType(AlertDialog), findsOneWidget);
        expect(find.text('Cancel'), findsNothing);
        expect(find.text('Back to Search'), findsNothing);
        if (dismissal == 'outside') {
          await tester.tapAt(const Offset(12, 72));
        } else {
          await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        }
        await tester.pumpAndSettle();
        expect(find.byType(AlertDialog), findsNothing);
        expect(find.byType(SwarmSearchResults), findsNothing);
        if (entry == 'start page') {
          expect(app.swarms, hasLength(2));
          expect(app.activeSwarmId, isNot(original));
          final field = tester.widget<TextField>(
            find.byKey(const ValueKey('harness-start-search')),
          );
          expect(field.focusNode!.hasFocus, isFalse);
          // The unused page remains usable and closes without a history entry.
          await chord(tester, LogicalKeyboardKey.keyW);
        }
        expect(app.focusedPane, same(pane));
        expect(app.swarms, hasLength(1));
        expect(app.closedHistory, isEmpty);
        expect(connection.calls, isEmpty);
        expect(input, isEmpty);
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
        await tester.pump();
        expect(input.single.bytes, [27, 91, 66]);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        keymap.dispose();
      });
    }
  }

  testWidgets('dismiss first-use creation returns to the idle start page', (
    tester,
  ) async {
    final connection = _Connection();
    final app = createApp(connectionForTest: (_) => connection);
    await mount(tester, app);
    await chord(tester, LogicalKeyboardKey.keyN);
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsOneWidget);
    await tester.tapAt(const Offset(12, 72));
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsNothing);
    expect(find.byType(SwarmSearchResults), findsNothing);
    expect(
      tester
          .widget<TextField>(find.byKey(const ValueKey('harness-start-search')))
          .focusNode!
          .hasFocus,
      isFalse,
    );
    expect(app.swarms, hasLength(1));
    expect(connection.calls, isEmpty);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  test('a creation receipt opens its exact agent instead of an older matching-engine pane', () async {
    final connection = _Connection();
    final app = createApp(connectionForTest: (_) => connection);
    addTearDown(app.dispose);
    final stale = app.adoptSessionForTest(
      terminal('stale-codex', <TerminalBinaryFrame>[]),
    );

    final creating = app.createAgent('m', engine: 'codex', folder: '/work');
    final request = connection.calls.single;
    request.reply.complete({
      'creationId': request.creationId,
      'state': 'created',
      'agent': {'id': 'fresh-codex', 'name': 'Fresh Codex', 'engine': 'codex'},
    });

    expect(await creating, isNull);
    expect(app.panes.map((pane) => pane.agentId), [
      'stale-codex',
      'fresh-codex',
    ]);
    expect(app.panes.first, same(stale));
  });

  for (final entry in ['Open', 'Split right', 'Split down']) {
    testWidgets(
      'New from $entry preserves its destination without stacking search',
      (tester) async {
        final files = FileSelectorPlatform.instance;
        FileSelectorPlatform.instance = _FolderPicker();
        addTearDown(() => FileSelectorPlatform.instance = files);
        final connection = _Connection();
        final app = createApp(connectionForTest: (_) => connection);
        app.stateOf('m')!.localOnly = true;
        final input = <TerminalBinaryFrame>[];
        final pane = app.adoptSessionForTest(terminal('a0', input));
        final target = app.activeSwarm;
        await mount(tester, app);
        final field = find.byKey(const ValueKey('swarm-search-input'));
        if (entry == 'Open') {
          await chord(tester, LogicalKeyboardKey.keyO);
        } else {
          await chord(tester, LogicalKeyboardKey.keyP, shift: true);
          await tester.enterText(field, '> $entry');
          await tester.pump();
          await tester.sendKeyEvent(LogicalKeyboardKey.enter);
          await tester.pump();
        }
        expect(find.byType(SwarmSearchResults), findsOneWidget);
        await chord(tester, LogicalKeyboardKey.keyN);
        await tester.pumpAndSettle();
        expect(find.byType(AlertDialog), findsOneWidget);
        expect(find.byType(SwarmSearchResults), findsNothing);
        expect(
          find.text(switch (entry) {
            'Split right' => 'New Harness to the right',
            'Split down' => 'New Harness below',
            _ => 'New Harness',
          }),
          findsWidgets,
        );
        await browseNewAgentProject(tester);
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('create-agent-submit')));
        await tester.pump();
        expect(connection.calls.map((call) => call.type), ['agent_create']);
        connection.calls.single.created();
        // The fake new terminal has no handshake, so its spinner never settles.
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 200));
        expect(find.byType(AlertDialog), findsNothing);
        expect(find.byType(SwarmSearchResults), findsNothing);
        expect(app.activeSwarm, same(target));
        expect(target.panes.first, same(pane));
        expect(target.panes.last.agentId, 'created');
        expect(target.panes, hasLength(2));
        if (entry != 'Open') expect(target.manualLayout, isNotNull);
        expect(input, isEmpty);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      },
    );
  }

  for (final change in ['unchanged', 'switch', 'closed', 'stale split']) {
    testWidgets('uncertain creation recovers once after destination $change', (
      tester,
    ) async {
      final files = FileSelectorPlatform.instance;
      FileSelectorPlatform.instance = _FolderPicker();
      addTearDown(() => FileSelectorPlatform.instance = files);
      final connection = _Connection();
      final app = createApp(connectionForTest: (_) => connection);
      app.stateOf('m')!.localOnly = true;
      final input = <TerminalBinaryFrame>[];
      final originalPane = app.adoptSessionForTest(terminal('a0', input));
      final original = app.activeSwarm;
      await mount(tester, app);
      if (change == 'stale split') {
        await chord(tester, LogicalKeyboardKey.keyP, shift: true);
        await tester.enterText(
          find.byKey(const ValueKey('swarm-search-input')),
          '> split right',
        );
        await tester.pump();
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();
      }
      await chord(tester, LogicalKeyboardKey.keyN);
      await tester.pumpAndSettle();
      await browseNewAgentProject(tester);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('create-agent-submit')));
      await tester.pump();
      final create = connection.calls.single;
      create.reply.completeError(const WsRequestTimeout('agent_create'));
      await tester.pumpAndSettle();
      expect(find.text('Close'), findsOneWidget);
      expect(find.text('Back to Search'), findsNothing);
      expect(find.widgetWithText(TextButton, 'Find a harness'), findsNothing);
      if (change == 'switch' || change == 'closed') app.newSwarm();
      if (change == 'closed') await app.closeSwarm(original.id);
      if (change == 'stale split') {
        app.adoptSessionForTest(terminal('a1', input));
      }
      final current = app.activeSwarmId;
      await tester.pump();
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Check status'),
            )
            .focusNode!
            .hasPrimaryFocus,
        isTrue,
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(connection.calls.map((call) => call.type), [
        'agent_create',
        'agent_create_status',
      ]);
      final check = connection.calls.last;
      expect(check.creationId, create.creationId);
      // A pending check is still one operation, even on repeated activation.
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(connection.calls, hasLength(2));
      check.created();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 200));
      expect(find.byType(AlertDialog), findsNothing);
      expect(find.byType(SwarmSearchResults), findsNothing);
      expect(app.activeSwarmId, current);
      if (change == 'closed' || change == 'stale split') {
        expect(app.allPanes.any((p) => p.agentId == 'created'), isFalse);
        expect(app.lastError, contains('Open Harness'));
      } else {
        expect(original.panes.first, same(originalPane));
        expect(original.panes.last.agentId, 'created');
        expect(original.panes, hasLength(2));
        if (change == 'switch') expect(app.panes, isEmpty);
      }
      expect(app.stateOf('m')!.agents.any((a) => a.id == 'created'), isTrue);
      expect(input, isEmpty);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    });
  }

  testWidgets('closing an uncertain creation returns to the terminal once', (
    tester,
  ) async {
    final files = FileSelectorPlatform.instance;
    FileSelectorPlatform.instance = _FolderPicker();
    addTearDown(() => FileSelectorPlatform.instance = files);
    final connection = _Connection();
    final app = createApp(connectionForTest: (_) => connection);
    app.stateOf('m')!.localOnly = true;
    final input = <TerminalBinaryFrame>[];
    final pane = app.adoptSessionForTest(terminal('a0', input));
    await mount(tester, app);
    await chord(tester, LogicalKeyboardKey.keyO);
    await chord(tester, LogicalKeyboardKey.keyN);
    await tester.pumpAndSettle();
    await browseNewAgentProject(tester);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('create-agent-submit')));
    await tester.pump();
    connection.calls.single.reply.completeError(
      const WsRequestTimeout('agent_create'),
    );
    await tester.pumpAndSettle();
    // Check status owns focus. Shift-Tab reaches Close without terminal input.
    await tester.sendKeyDownEvent(LogicalKeyboardKey.shift);
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.shift);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsNothing);
    expect(find.byType(SwarmSearchResults), findsNothing);
    expect(app.panes, [pane]);
    expect(connection.calls.map((c) => c.type), ['agent_create']);
    expect(input, isEmpty);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    expect(input.single.bytes, [27, 91, 66]);
    await chord(tester, LogicalKeyboardKey.keyO);
    expect(find.byType(SwarmSearchResults), findsOneWidget);
    expect(find.byKey(const ValueKey('create-agent-submit')), findsNothing);
    expect(connection.calls, hasLength(1));
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  test(
    'lost creation reply recovers into the original swarm and counts once',
    () async {
      final connection = _Connection();
      final app = createApp(connectionForTest: (_) => connection);
      addTearDown(app.dispose);
      final destination = app.activeSwarm;
      final attempt = AgentCreationAttempt();
      final before = harnessStats.summary.agentsSpawned;
      await _timeOut(app, connection, attempt);
      app.newSwarm(name: 'Another task');
      final recover = app.createAgent(
        'm',
        engine: 'claude',
        folder: '/work',
        attempt: attempt,
      );
      expect(connection.calls.last.type, 'agent_create_status');
      expect(
        connection.calls.last.creationId,
        connection.calls.first.creationId,
      );
      connection.calls.last.created();
      expect(await recover, isNull);
      expect(attempt.awaitingConfirmation, isFalse);
      expect(destination.panes.single.agentId, 'created');
      expect(app.activeSwarm.panes, isEmpty);
      expect(harnessStats.summary.agentsSpawned, before + 1);
      // Reusing the completed intent does not count or apply it a second time.
      expect(
        await app.createAgent(
          'm',
          engine: 'claude',
          folder: '/work',
          attempt: attempt,
        ),
        isNull,
      );
      expect(connection.calls, hasLength(2));
      expect(harnessStats.summary.agentsSpawned, before + 1);
    },
  );

  test('concurrent submits share one request; a deliberate fresh intent gets a new id', () async {
    final connection = _Connection();
    final app = createApp(connectionForTest: (_) => connection);
    addTearDown(app.dispose);
    final attempt = AgentCreationAttempt();
    final first = app.createAgent(
      'm',
      engine: 'claude',
      folder: '/work',
      attempt: attempt,
    );
    final duplicate = app.createAgent(
      'm',
      engine: 'claude',
      folder: '/work',
      attempt: attempt,
    );
    expect(connection.calls, hasLength(1));
    connection.calls.single.created();
    expect(await first, isNull);
    expect(await duplicate, isNull);
    final fresh = app.createAgent(
      'm',
      engine: 'claude',
      folder: '/work',
      attempt: AgentCreationAttempt(),
    );
    expect(
      connection.calls.last.creationId,
      isNot(connection.calls.first.creationId),
    );
    connection.calls.last.created('new-intent');
    expect(await fresh, isNull);
  });

  for (final result in [
    'unsupported',
    'timeout',
    'disconnect',
    'pending',
    'unconfirmed',
    'missing',
    'wrong receipt',
    'malformed',
  ]) {
    test('$result never turns a status check into another launch', () async {
      final connection = _Connection();
      final app = createApp(connectionForTest: (_) => connection);
      addTearDown(app.dispose);
      final attempt = AgentCreationAttempt();
      await _timeOut(app, connection, attempt);
      final recover = app.createAgent(
        'm',
        engine: 'claude',
        folder: '/work',
        attempt: attempt,
      );
      final check = connection.calls.last;
      switch (result) {
        case 'unsupported':
          check.reply.completeError(
            const WsRequestFailure(
              responseType: 'agent_create_status_result',
              code: 'UNSUPPORTED',
            ),
          );
        case 'timeout':
          check.reply.completeError(
            const WsRequestTimeout('agent_create_status'),
          );
        case 'disconnect':
          check.reply.completeError(StateError('fixture disconnected'));
        case 'wrong receipt':
          check.reply.complete({
            'creationId': 'not-this-creation',
            'state': 'missing',
          });
        case 'malformed':
          check.status('created', agent: {});
        default:
          check.status(result);
      }
      expect(await recover, isNotNull);
      expect(attempt.awaitingConfirmation, isTrue);
      expect(connection.calls.map((c) => c.type), [
        'agent_create',
        'agent_create_status',
      ]);
      expect(app.panes, isEmpty);
    });
  }

  test(
    'changing launch choices cannot redirect an uncertain request',
    () async {
      final connection = _Connection();
      final app = createApp(connectionForTest: (_) => connection);
      addTearDown(app.dispose);
      final attempt = AgentCreationAttempt();
      await _timeOut(app, connection, attempt);
      expect(
        await app.createAgent(
          'm',
          engine: 'codex',
          folder: '/different',
          attempt: attempt,
        ),
        contains('original request'),
      );
      expect(connection.calls, hasLength(1));
      expect(attempt.awaitingConfirmation, isTrue);
    },
  );

  for (final state in ['failed', 'unavailable']) {
    test(
      'a recorded $state outcome ends recovery without another launch',
      () async {
        final connection = _Connection();
        final app = createApp(connectionForTest: (_) => connection);
        addTearDown(app.dispose);
        final attempt = AgentCreationAttempt();
        await _timeOut(app, connection, attempt);
        final recover = app.createAgent(
          'm',
          engine: 'claude',
          folder: '/work',
          attempt: attempt,
        );
        final request = connection.calls.last;
        request.reply.complete({
          'creationId': request.creationId,
          'state': state,
          'failure': {'code': 'CWD_NOT_FOUND'},
        });
        expect(
          await recover,
          contains(
            state == 'failed' ? 'Choose another folder' : 'no longer available',
          ),
        );
        expect(attempt.awaitingConfirmation, isFalse);
        expect(connection.calls, hasLength(2));
      },
    );
  }

  test('closing the original swarm does not block recovery or add into a different swarm', () async {
    final connection = _Connection();
    final app = createApp(connectionForTest: (_) => connection);
    addTearDown(app.dispose);
    final original = app.activeSwarmId;
    final attempt = AgentCreationAttempt();
    await _timeOut(app, connection, attempt);
    app.newSwarm(name: 'Other');
    await app.closeSwarm(original);
    final recover = app.createAgent(
      'm',
      engine: 'claude',
      folder: '/work',
      attempt: attempt,
    );
    connection.calls.last.created();
    expect(await recover, isNull);
    expect(app.panes, isEmpty);
    expect(
      app.stateOf('m')!.agents.any((agent) => agent.id == 'created'),
      isTrue,
    );
    expect(app.lastError, contains('Open Harness'));
  });

  testWidgets(
    'timeout keeps choices and keyboard focus on Check status, then opens the recovered agent',
    (tester) async {
      final connection = _Connection();
      final app = createApp(connectionForTest: (_) => connection);
      app.stateOf('m')!.localOnly = true;
      await tester.binding.setSurfaceSize(const Size(960, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () => showNewAgentDialog(
                  context,
                  app,
                  'm',
                  source: 'test',
                  initialFolder: '/work',
                  initialEngineProbe: Future.value(),
                ),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('create-agent-submit')));
      await tester.pump();
      connection.calls.last.reply.completeError(
        const WsRequestTimeout('agent_create'),
      );
      await tester.pumpAndSettle();
      expect(find.text('work'), findsOneWidget);
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('create-agent-submit')),
          matching: find.text('New Harness'),
        ),
        findsNothing,
      );
      final action = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'Check status'),
      );
      expect(action.focusNode!.hasFocus, isTrue);
      expect(find.text('Close'), findsOneWidget);
      // The original settings remain locked while the request is uncertain.
      await tester.tap(
        find.byKey(const Key('new-agent-agent-field')),
        warnIfMissed: false,
      );
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(connection.calls.map((c) => c.type), [
        'agent_create',
        'agent_create_status',
      ]);
      connection.calls.last.created();
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsNothing);
      expect(app.panes.single.agentId, 'created');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  // The three refusals a grid launch can raise before anything starts, each with the sentence the
  // daemon actually sends beside its code (`backendSocket.ts` / `launchOverrides.ts`). What the
  // person reads must be that sentence, never the bare code.
  for (final (code, detail) in const [
    ('INVALID_GRID', 'grid is missing networkId, apiKey'),
    (
      'TMUX_TOO_OLD_FOR_GRID',
      "this machine's tmux is older than 3.2, which is the first version that can give a pane its own environment — so claude could not be pointed at grid Team grid.",
    ),
    (
      'GRID_CONFIG_FAILED',
      "could not write pi's grid configuration · EACCES: permission denied",
    ),
  ]) {
    test('a $code refusal reads as a sentence, not a code', () async {
      final connection = _Connection();
      final app = createApp(connectionForTest: (_) => connection);
      addTearDown(app.dispose);
      final attempt = AgentCreationAttempt();
      final create = app.createAgent(
        'm',
        engine: 'claude',
        folder: '/work',
        attempt: attempt,
      );
      connection.calls.last.reply.completeError(
        WsRequestFailure(
          responseType: 'agent_create_result',
          code: code,
          detail: detail,
        ),
      );
      final message = await create;
      expect(message, isNotNull);
      expect(message, contains(detail));
      expect(message, isNot(contains(code)));
      // Refused before a launch: nothing to recover, and a second Create is safe.
      expect(attempt.awaitingConfirmation, isFalse);
    });
  }
}
