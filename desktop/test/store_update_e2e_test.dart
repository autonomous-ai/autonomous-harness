import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/store/store_screen.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show createApp;

/// Real Store button → AppNotifier → WsConn → BackendSocket → update/setup/doctor.
/// Needs only the companion CLI dependencies; no accounts, model, or installed harness is used.
void main() {
  final cliRoot = Platform.environment['DSH_UPDATE_CLI_ROOT'];
  if (cliRoot == null) {
    test(
      'Store updates end to end',
      () {},
      skip: 'Set DSH_UPDATE_CLI_ROOT to the companion CLI checkout.',
    );
    return;
  }

  testWidgets(
    'failed release rolls back; retry updates the harness and viewer while preserving the project',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1280, 1800);
      addTearDown(tester.view.reset);
      late Directory fixture;
      late Process daemon;
      late AppNotifier app;
      late WsConn connection;
      final diagnostics = StringBuffer();
      const id = 'acme/thing';
      const viewer = 'acme/pane';
      await tester.runAsync(() async {
        fixture = await Directory.systemTemp.createTemp('harness-update-e2e-');
        daemon = await Process.start(
          'node',
          ['--import', 'tsx', 'scripts/smoke-dsh-updates.ts', fixture.path],
          workingDirectory: cliRoot,
          environment: {
            'HARNESS_DSH_UPDATE_SMOKE': '1',
            'ADAPTER_DATA_DIR': '${fixture.path}/data',
            'ADAPTER_RUNTIME_DIR': '${fixture.path}/runtime',
            'DSH_DIR': '${fixture.path}/installed',
            'HARNESS_STORE_CATALOG_URL': 'http://127.0.0.1:9/catalog.json',
          },
        );
        daemon.stderr.transform(utf8.decoder).listen(diagnostics.write);
        final port = Completer<int>();
        daemon.stdout
            .transform(utf8.decoder)
            .transform(const LineSplitter())
            .listen(
              (line) {
                diagnostics.writeln(line);
                try {
                  final message = jsonDecode(line);
                  if (message is Map &&
                      message['port'] is int &&
                      !port.isCompleted) {
                    port.complete(message['port'] as int);
                  }
                } on FormatException {
                  /* Progress also goes to stdout. */
                }
              },
              onDone: () {
                if (!port.isCompleted) {
                  port.completeError(
                    StateError('Daemon did not start: $diagnostics'),
                  );
                }
              },
            );
        final localPort = await port.future.timeout(
          const Duration(seconds: 60),
        );
        final ready = Completer<void>();
        connection = WsConn(
          wsBaseUrl: '',
          autonomousEnv: 'test',
          machineId: 'm',
          accessTokenProvider: (_, _) async => '',
          onAuthFailure: fail,
          onEvent: (event) => unawaited(app.handleEventForTest('m', event)),
          onStatus: (status) {
            if (status == ConnectionStatus.connected && !ready.isCompleted) {
              ready.complete();
            }
          },
          transportKind: WsTransportKind.localPlaintext,
          localWsUri: Uri.parse('ws://127.0.0.1:$localPort'),
        );
        app = createApp(connectionForTest: (_) => connection);
        app.stateOf('m')!
          ..localOnly = true
          ..nodeOnline = true;
        await connection.connect();
        await ready.future.timeout(const Duration(seconds: 10));
        await app.probeDsh('m', force: true);
      });
      addTearDown(() async {
        app.dispose();
        await connection.close();
        await daemon.stdin.close();
        await daemon.exitCode.timeout(
          const Duration(seconds: 10),
          onTimeout: () {
            daemon.kill();
            return -1;
          },
        );
        await fixture.delete(recursive: true);
      });

      Future<void> open(String packageId) async {
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: StoreTab(
                key: ValueKey(packageId),
                notifier: app,
                initialHarness: packageId,
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
      }

      Future<void> waitUntil(bool Function() done) async {
        final deadline = DateTime.now().add(const Duration(seconds: 30));
        while (!done()) {
          if (DateTime.now().isAfter(deadline)) {
            fail('Update did not finish: $diagnostics');
          }
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 50)),
          );
          await tester.pump();
        }
        await tester.pumpAndSettle();
      }

      final catalog = app.stateOf('m')!.dsh;
      final original = catalog[id]!.installedCommit;
      await open(id);
      final action = find.byKey(const ValueKey('store-primary-action'));
      expect(
        find.descendant(of: action, matching: find.text('Update')),
        findsOneWidget,
      );
      await tester.tap(action);
      await tester.pump();
      expect(catalog.runs[id]!.inProgress, isTrue);
      await waitUntil(() => catalog.runs[id]!.failed);
      expect(catalog[id]!.installedCommit, original);
      expect(catalog[id]!.hasUpdate, isTrue);
      final afterFailure = await tester.runAsync(
        () => connection.request('smoke_reopen'),
      );
      expect(afterFailure!['preview'], 'my finished project');
      expect(afterFailure['skill'], 'skill version 1');

      await tester.runAsync(() async {
        await connection.request('smoke_publish');
        await app.probeDsh('m', force: true);
      });
      await tester.pumpAndSettle();
      await tester.tap(action);
      await waitUntil(() => !catalog[id]!.hasUpdate);
      expect(catalog[id]!.installedCommit, isNot(original));
      expect(
        find.descendant(of: action, matching: find.text('Open')),
        findsOneWidget,
      );
      final reopened = await tester.runAsync(
        () => connection.request('smoke_reopen'),
      );
      expect(reopened!['preview'], 'my finished project');
      expect(
        reopened['instructions'],
        '<!-- harness:dsh acme/thing -->\noriginal instructions\n\nmy custom instructions\n',
      );
      expect(reopened['skill'], 'skill version 3');
      expect(reopened['verdict'], {'ready': true, 'summary': 'finished'});

      await tester.runAsync(() async {
        await connection.request(
          'smoke_publish',
          payload: {'viewerOnly': true},
        );
        await app.probeDsh('m', force: true);
      });
      expect(
        catalog[id]!.hasUpdate,
        isFalse,
        reason: 'An unrelated viewer commit does not update the harness',
      );
      expect(catalog[viewer]!.hasUpdate, isTrue);
      await open(viewer);
      expect(
        find.descendant(of: action, matching: find.text('Update')),
        findsOneWidget,
      );
      await tester.tap(action);
      await waitUntil(() => !catalog[viewer]!.hasUpdate);
      final withNewViewer = await tester.runAsync(
        () => connection.request('smoke_reopen'),
      );
      expect(withNewViewer!['preview'], 'my finished project');
      expect(
        action,
        findsNothing,
        reason: 'An installed viewer has no standalone Open action',
      );
      expect(tester.takeException(), isNull);
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
