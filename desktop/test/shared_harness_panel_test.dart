import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/sharing/shared_harness_panel.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/terminal/terminal_binary.dart';

import 'support/real_fonts.dart';

void main() {
  setUpAll(() async {
    await loadRealFonts();
    HttpOverrides.global = null;
  });
  const streamId = '00112233-4455-6677-8899-aabbccddeeff';
  testWidgets(
    'read-only terminal receives output, keeps its lease alive and never sends input or resize',
    (tester) async {
      final sent = <Map<String, dynamic>>[], binary = <TerminalBinaryFrame>[];
      final session = TerminalSession(
        machineId: 'shared',
        agentId: 'agent',
        agentName: 'Demo',
        engineId: 'codex',
        readOnly: true,
        send: (type, payload) async {
          sent.add({'type': type, ...payload});
          return true;
        },
        sendBinary: (frame) async {
          binary.add(frame);
          return true;
        },
      );
      await session.open();
      await session.handleFrame('terminal_ready', {
        'requestId': sent.first['requestId'],
        'protocolVersion': 3,
        'streamId': streamId,
        'agentId': 'agent',
      });
      await session.handleBinary(
        TerminalBinaryFrame(
          kind: TerminalBinaryKind.keyframe,
          streamId: streamId,
          seq: 0,
          bytes: Uint8List.fromList(utf8.encode('Live shared output')),
          compressed: false,
          cols: 110,
          rows: 33,
        ),
      );
      expect(session.terminal.buffer.getText(), contains('Live shared output'));
      expect(session.acceptsInput, isFalse);
      session.terminal.textInput('forbidden');
      session.resize(12, 12);
      expect(await session.sendComposerText('forbidden'), isFalse);
      expect(await session.pasteText('forbidden'), isFalse);
      session.sendScrollCommand(true, 10);
      await tester.pump(const Duration(seconds: 15));
      expect(
        sent.where((frame) => frame['type'] == 'terminal_alive'),
        isNotEmpty,
      );
      expect(
        sent.where((frame) => frame['type'] == 'terminal_resize'),
        isEmpty,
      );
      expect(binary, isEmpty);
      session.dispose();
    },
  );

  for (final width in [1100.0, 620.0]) {
    testWidgets(
      'shared pane live output, reconnect, revocation and renewal at width $width',
      (tester) async {
        tester.view.physicalSize = Size(width, 760);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        final sockets = <WebSocket>[], requests = <Map<String, dynamic>>[];
        final closingSockets = <WebSocket>{};
        late HttpServer server;
        await tester.runAsync(() async {
          server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
          server.listen((request) async {
            final ws = await WebSocketTransformer.upgrade(request);
            sockets.add(ws);
            ws.listen((raw) {
              if (closingSockets.contains(ws) ||
                  ws.readyState != WebSocket.open) {
                return;
              }
              if (raw is! String) {
                fail('An observer sent terminal bytes');
              }
              final frame = jsonDecode(raw) as Map<String, dynamic>;
              requests.add(frame);
              final p = frame['payload'] as Map;
              if (frame['type'] == 'machine_select') {
                ws.add(
                  jsonEncode({
                    'type': 'connected',
                    'payload': {'machineId': 'shared', 'readOnly': true},
                  }),
                );
              } else if (frame['type'] == 'terminal_open') {
                ws.add(
                  jsonEncode({
                    'type': 'terminal_ready',
                    'payload': {
                      'requestId': p['requestId'],
                      'protocolVersion': 3,
                      'streamId': streamId,
                      'agentId': 'agent',
                      'readOnly': true,
                    },
                  }),
                );
                ws.add(
                  encodeTerminalLocal(
                    TerminalBinaryFrame(
                      kind: TerminalBinaryKind.keyframe,
                      streamId: streamId,
                      seq: 0,
                      bytes: Uint8List.fromList(
                        utf8.encode('LIVE_OBSERVER_OUTPUT'),
                      ),
                      compressed: false,
                      cols: 110,
                      rows: 33,
                    ),
                  )!,
                );
              } else if (frame['type'] == 'observer_viewer') {
                ws.add(
                  jsonEncode({
                    'type': 'observer_viewer',
                    'payload': {
                      'state': 'waiting',
                      'message': 'The viewer will appear when this harness produces an output.',
                    },
                  }),
                );
              }
            });
          });
        });
        final app = AppNotifier(
          config: AppConfig(
            apiBaseUrl: 'http://127.0.0.1:9',
            localCliBaseUrl: 'http://127.0.0.1:${server.port}',
          ),
          authSession: AuthSession(),
          configStore: null,
        );
        final grant = SharedHarness(
          id: 'grant',
          agentId: 'agent',
          name: 'Climate dashboard',
          engine: 'codex',
          expiresAt: DateTime(2027),
        );
        final pane = TerminalPane(id: 1, machineId: 'shared', agentId: 'agent')
          ..sharedHarness = grant
          ..sharedOwnerName = 'D';
        var hasAccess = true, closePressed = false;
        Future<void> draw() => tester.pumpWidget(
          MaterialApp(
            theme: grid.buildAppTheme(brightness: Brightness.dark),
            home: Scaffold(
              body: SharedHarnessPanel(
                notifier: app,
                pane: pane,
                grant: grant,
                hasAccess: hasAccess,
                visible: true,
                onClose: () => closePressed = true,
              ),
            ),
          ),
        );
        Future<void> settleNetwork(bool Function() ready) async {
          for (var i = 0; i < 100; i++) {
            await tester.runAsync(
              () => Future<void>.delayed(const Duration(milliseconds: 20)),
            );
            await tester.pump();
            if (ready()) return;
          }
          fail('Observer UI did not reach expected state');
        }

        await draw();
        await settleNetwork(() => find.text('Live').evaluate().isNotEmpty);
        expect(requests.first['payload'], containsPair('shareId', 'grant'));
        expect(find.text('View only'), findsOneWidget);
        await settleNetwork(
          () => requests.any((r) => r['type'] == 'observer_viewer'),
        );
        if (width < 880) {
          await tester.tap(find.text('Viewer'));
          await tester.pump();
        }
        expect(find.textContaining('The viewer will appear'), findsOneWidget);
        expect(
          requests.map((r) => r['type']),
          isNot(contains('terminal_resize')),
        );
        expect(tester.takeException(), isNull);
        void viewer(Map<String, dynamic> payload) => sockets.last.add(
          jsonEncode({'type': 'observer_viewer', 'payload': payload}),
        );
        viewer({'state': 'loading'});
        await settleNetwork(
          () => find.text('Opening the viewer…').evaluate().isNotEmpty,
        );
        viewer({'state': 'live', 'data': 'not-base64!'});
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 30)),
        );
        await tester.pump();
        expect(tester.takeException(), isNull);
        viewer({'state': 'live', 'data': 'aW52YWxpZC1pbWFnZQ=='});
        await settleNetwork(
          () => find
              .text('Waiting for the next viewer frame.')
              .evaluate()
              .isNotEmpty,
        );
        viewer({
          'state': 'live',
          'data': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=',
        });
        await settleNetwork(() => find.byType(Image).evaluate().isNotEmpty);
        if (width < 880) {
          await tester.tap(find.text('Terminal'));
          await tester.pump();
        }
        await tester.runAsync(() async {
          closingSockets.add(sockets.last);
          await sockets.last.close(1001, 'Owner disconnected');
        });
        await settleNetwork(
          () => find.text('Reconnecting').evaluate().isNotEmpty,
        );
        await tester.pump(const Duration(seconds: 1));
        await settleNetwork(
          () => sockets.length == 2 && find.text('Live').evaluate().isNotEmpty,
        );
        await tester.runAsync(() async {
          closingSockets.add(sockets.last);
          await sockets.last.close(4403, 'Access removed');
        });
        await settleNetwork(
          () => find.text('Sharing ended').evaluate().isNotEmpty,
        );
        expect(find.text('Access removed'), findsOneWidget);
        await tester.pump(const Duration(seconds: 30));
        expect(sockets.length, 2);
        hasAccess = false;
        await draw();
        hasAccess = true;
        await draw();
        await settleNetwork(
          () => sockets.length == 3 && find.text('Live').evaluate().isNotEmpty,
        );
        hasAccess = false;
        await draw();
        expect(
          find.text('Access removed or invitation expired.'),
          findsOneWidget,
        );
        await tester.tap(find.byTooltip('Close shared harness'));
        expect(closePressed, isTrue);
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        await tester.runAsync(() async {
          for (final ws in sockets) {
            closingSockets.add(ws);
            unawaited(ws.close());
          }
          await server.close(force: true);
        });
        await tester.pump(const Duration(seconds: 6));
      },
    );
  }
  testWidgets(
    'a restored pane without an invitation opens in the ended state',
    (tester) async {
      final app = AppNotifier(
        config: const AppConfig(
          apiBaseUrl: 'http://127.0.0.1:9',
          localCliBaseUrl: 'http://127.0.0.1:9',
        ),
        authSession: AuthSession(),
        configStore: null,
      );
      final grant = SharedHarness(
        id: 'expired',
        agentId: 'agent',
        name: 'Demo',
        expiresAt: DateTime(2000),
      );
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SharedHarnessPanel(
              notifier: app,
              pane: TerminalPane(id: 1, machineId: 'shared', agentId: 'agent'),
              grant: grant,
              hasAccess: false,
              visible: true,
              onClose: () {},
            ),
          ),
        ),
      );
      expect(find.text('Sharing ended'), findsOneWidget);
      expect(
        find.text('Access removed or invitation expired.'),
        findsOneWidget,
      );
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );
}
