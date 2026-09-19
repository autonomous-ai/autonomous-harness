import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/orchestrator/orchestrator_controller.dart';
import 'package:harness/orchestrator/orchestrator_workspace.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/terminal_panel.dart';
import 'package:harness/widgets/web_pane_panel.dart';

class _MemoryStore implements LocalKeyValueStore {
  final data = <String, String>{};
  @override
  Future<String?> read(String key) async => data[key];
  @override
  Future<void> write(String key, String value) async {
    data[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    data.remove(key);
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('real WKWebViews arrive without replacing the director draft', (
    tester,
  ) async {
    // This test must fail, not quietly exercise URL placeholders, if native
    // webviews are unavailable. The regular widget suite covers the fallback.
    expect(WebPanePanel.webviewAvailable, isTrue);
    await tester.binding.setSurfaceSize(const Size(1280, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final visited = <String>{};
    server.listen((request) async {
      final path = request.uri.path;
      visited.add(path);
      request.response.headers.contentType = ContentType.html;
      request.response.write(
        '<!doctype html><body style="background:#172022;color:#e4f6ef;font:24px sans-serif"><h1>Live $path viewer</h1><p>Verified local fixture</p></body>',
      );
      await request.response.close();
    });
    addTearDown(() => server.close(force: true));
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(storage: _MemoryStore()),
    );
    addTearDown(app.dispose);
    const id = '77777777777777777777777777777777';
    final tasks = <Map<String, dynamic>>[];
    var revision = 0;
    final controller = OrchestratorController(
      id: id,
      request: (_) async => {
        'project': {
          'id': id,
          'revision': ++revision,
          'state': 'active',
          'directorId': 'fixture-director',
          'directorAvailable': true,
          'tasks': List<Map<String, dynamic>>.of(tasks),
          'messages': [
            {
              'id': 'first',
              'role': 'assistant',
              'text': 'I’m coordinating the specialists.',
            },
          ],
        },
      },
    );
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: OrchestratorWorkspace(
            notifier: app,
            machineId: 'fixture',
            projectId: id,
            controller: controller,
          ),
        ),
      ),
    );
    await tester.pump();
    final composer = find.byKey(const ValueKey('orchestrator-composer'));
    await tester.tap(composer);
    // Native integration bindings do not register a fake text-input channel.
    tester.widget<TextField>(composer).controller!.text =
        'Keep the base slimmer';
    for (final name in ['shape', 'scene', 'film']) {
      tasks.add({
        'id': name,
        'title': name,
        'harness': 'fixture/$name',
        'state': 'running',
        'attempt': 1,
        'agentId': 'fixture-$name',
        'hasViewer': true,
        'runtime': {
          'viewerUrl': 'http://127.0.0.1:${server.port}/$name',
          'viewerName': name,
        },
      });
      await controller.refresh();
      await tester.pump(const Duration(milliseconds: 100));
    }
    final deadline = DateTime.now().add(const Duration(seconds: 30));
    while (visited.length < 3 && DateTime.now().isBefore(deadline)) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(visited, containsAll(['/shape', '/scene', '/film']));
    expect(find.byType(WebViewWidget), findsNWidgets(3));
    for (final view in tester.widgetList<WebViewWidget>(
      find.byType(WebViewWidget),
    )) {
      final text = await view.platform.params.controller
          .runJavaScriptReturningResult('document.body.innerText')
          .timeout(const Duration(seconds: 10));
      expect(text.toString(), contains('Verified local fixture'));
    }
    expect(
      tester.widget<TextField>(composer).controller!.text,
      'Keep the base slimmer',
    );
    expect(tester.widget<TextField>(composer).focusNode!.hasFocus, isTrue);
    expect(find.byType(TerminalPanel), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });
}
