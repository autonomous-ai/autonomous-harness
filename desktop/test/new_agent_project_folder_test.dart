import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/new_agent_dialog.dart';
import 'package:harness/ws/ws_conn.dart';

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
  final calls =
      <(String, Map<String, dynamic>, Completer<Map<String, dynamic>>)>[];
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    final result = Completer<Map<String, dynamic>>();
    // New Harness asks the machine for its harnesses on every open; that read is not what these
    // tests are about, so it answers at once with none and is not recorded.
    if (type == 'dsh_list') return Future.value(const {'dsh': []});
    calls.add((type, payload, result));
    return result.future;
  }

  void fail({String? folder}) {
    final (_, payload, result) = calls.last;
    result.complete({
      'creationId': payload['creationId'],
      'state': 'failed',
      'preparedFolder': ?folder,
      'failure': {'code': 'TMUX_UNAVAILABLE'},
    });
  }
}

class _App extends AppNotifier {
  _App(_Connection connection, {required bool local})
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        connectionForTest: (_) => connection,
      ) {
    const machine = Machine(
      machineId: 'm',
      name: 'Studio',
      authMode: MachineAuthMode.remote,
    );
    machineStates['m'] = MachineState(machine)
      ..localOnly = local;
  }
  final prepared = <ProjectFolderRequest>[];
  final labels = <String>[];
  @override
  Future<void> probeEngines(String machineId, {bool force = false}) async {}
  @override
  Future<String> prepareLocalProjectFolder(
    ProjectFolderRequest request, {
    String label = 'harness',
  }) async {
    prepared.add(request);
    labels.add(label);
    return '/local/Harness Projects/project-test';
  }
}

Future<void> _mount(WidgetTester tester, _App app) async {
  await app.agentPreference.select('claude');
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            onPressed: () =>
                showNewAgentDialog(context, app, 'm', source: 'test'),
            child: const Text('Open'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Open'));
  await tester.pumpAndSettle();
}

void main() {
  for (final (local, wsl) in [(true, false), (false, false), (true, true)]) {
    testWidgets(
      'New prepares only on the selected machine (local=$local, wsl=$wsl)',
      (tester) async {
        final connection = _Connection();
        final app = _App(connection, local: local);
        app.debugSetLocalCliInWsl(wsl);
        addTearDown(() async {
          await tester.pumpWidget(const SizedBox());
          app.dispose();
        });
        await _mount(tester, app);
        expect(app.prepared, isEmpty);
        expect(connection.calls, isEmpty);
        await tester.ensureVisible(
          find.byKey(const ValueKey('new-agent-folder-newProject')),
        );
        await tester.tap(
          find.byKey(const ValueKey('new-agent-folder-newProject')),
        );
        await tester.pumpAndSettle();
        expect(
          app.prepared,
          isEmpty,
          reason: 'Selecting New does not create folders',
        );
        await tester.tap(find.byKey(const ValueKey('create-agent-submit')));
        await tester.pump();
        final (_, payload, _) = connection.calls.single;
        if (local && !wsl) {
          expect(app.prepared, hasLength(1));
          expect(payload['cwd'], '/local/Harness Projects/project-test');
          expect(
            payload.containsKey('projectSource'),
            isFalse,
            reason: 'Current local CLIs retain the existing cwd protocol',
          );
        } else {
          expect(app.prepared, isEmpty);
          expect(payload['projectSource'], 'new');
          expect(
            payload.containsKey('cwd'),
            isFalse,
            reason: 'An older remote CLI must refuse instead of starting in the wrong folder',
          );
        }
        connection.fail(
          folder: local && !wsl
              ? null
              : '/remote/Harness Projects/project-test',
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('create-agent-submit')));
        await tester.pump();
        expect(
          connection.calls.last.$2['cwd'],
          '${local && !wsl ? '/local' : '/remote'}/Harness Projects/project-test',
        );
        expect(connection.calls.last.$2.containsKey('projectSource'), isFalse);
        expect(app.prepared.length, local && !wsl ? 1 : 0);
        if (local && !wsl) {
          expect(app.labels.single, 'Claude',
              reason: 'the folder is named after who the harness is');
        }
        connection.fail();
        await tester.pumpAndSettle();
      },
      skip: wsl && !Platform.isWindows,
    );
  }

  test('Windows cwd conversion preserves creation receipt recovery', () async {
    final connection = _Connection();
    final app = _App(connection, local: true);
    app.debugSetLocalCliInWsl(true);
    app.debugLocalCliWslDistro = 'Ubuntu';
    addTearDown(app.dispose);
    final attempt = AgentCreationAttempt();
    final first = app.createAgent(
      'm',
      engine: 'claude',
      folder: r'C:\work\project',
      attempt: attempt,
    );
    final (type, payload, reply) = connection.calls.single;
    expect(type, 'agent_create');
    expect(payload['cwd'], '/mnt/c/work/project');
    expect(payload['creationId'], isNotEmpty);
    reply.completeError(const WsRequestTimeout('agent_create'));
    expect(await first, contains('Check status'));
    final retry = app.createAgent(
      'm',
      engine: 'claude',
      folder: r'C:\work\project',
      attempt: attempt,
    );
    expect(connection.calls.last.$1, 'agent_create_status');
    expect(connection.calls.last.$2, {'creationId': payload['creationId']});
    connection.fail();
    await retry;
    expect(app.prepared, isEmpty);
  }, skip: !Platform.isWindows);

  test('Windows network path is refused before agent creation', () async {
    final connection = _Connection();
    final app = _App(connection, local: true)..debugSetLocalCliInWsl(true);
    addTearDown(app.dispose);
    expect(
      await app.createAgent('m', engine: 'claude', folder: r'\\server\share'),
      contains('inside WSL2'),
    );
    expect(connection.calls, isEmpty);
  }, skip: !Platform.isWindows);

  testWidgets('Git uses its URL dialog and status retries never clone again', (
    tester,
  ) async {
    final connection = _Connection();
    final app = _App(connection, local: false);
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    });
    await _mount(tester, app);
    final git = find.byKey(const Key('new-agent-project-git'));
    await tester.ensureVisible(git);
    await tester.tap(git);
    await tester.pumpAndSettle();
    final field = find.byKey(const Key('new-agent-git-url'));
    expect(tester.widget<TextField>(field).autofocus, isTrue);
    await tester.enterText(field, 'owner/repo');
    await tester.pump();
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('create-agent-submit')));
    await tester.pump();
    final (_, payload, result) = connection.calls.single;
    expect(payload['projectSource'], 'remote');
    expect(payload['repositoryUrl'], 'https://github.com/owner/repo.git');
    expect(app.prepared, isEmpty);
    result.completeError(const WsRequestTimeout('agent_create'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('create-agent-submit')));
    await tester.pump();
    expect(connection.calls.last.$1, 'agent_create_status');
    expect(connection.calls.last.$2, {'creationId': payload['creationId']});
    connection.fail();
    await tester.pumpAndSettle();
  });
}
