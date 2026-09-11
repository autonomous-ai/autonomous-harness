import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:xterm/xterm.dart';

import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/terminal_panel.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('native terminal replaces keyframes without stale render state', (
    tester,
  ) async {
    const streamId = '00112233-4455-6677-8899-aabbccddeeff';
    final controls = <({String type, Map<String, dynamic> payload})>[];
    final inputs = <TerminalBinaryFrame>[];
    final notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    final session = TerminalSession(
      machineId: 'machine',
      agentId: 'agent',
      agentName: 'native-terminal-fixture',
      engineId: 'grok',
      send: (type, payload) async {
        controls.add((type: type, payload: Map.of(payload)));
        return true;
      },
      sendBinary: (frame) async {
        inputs.add(frame);
        return true;
      },
    );
    addTearDown(notifier.dispose);
    addTearDown(session.dispose);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AnimatedBuilder(
            animation: session,
            builder: (_, _) => TerminalPanel(
              notifier: notifier,
              session: session,
              focused: true,
            ),
          ),
        ),
      ),
    );

    final opening = session.open(
      initialCols: 20,
      initialRows: 5,
      waitForViewportSize: true,
    );
    await tester.pump();
    await opening;
    expect(find.byType(TerminalView), findsOneWidget);
    expect(session.cols, greaterThan(20));
    expect(session.rows, greaterThan(5));

    final requestId = controls.single.payload['requestId'];
    await session.handleFrame('terminal_ready', {
      'requestId': requestId,
      'protocolVersion': TerminalSession.protocolVersion,
      'streamId': streamId,
      'agentId': 'agent',
    });

    final beforeKeyframe = session.terminal;
    await session.handleBinary(
      TerminalBinaryFrame(
        kind: TerminalBinaryKind.keyframe,
        streamId: streamId,
        seq: 0,
        bytes: Uint8List.fromList(
          utf8.encode(
            '\x1b[2J\x1b[H'
            'Grok fixture\r\n'
            '\x1b[32m● Run\x1b[0m  Fetch market data\r\n'
            '┌──────────┬──────────┐\r\n'
            '│ Bid/Ask  │ 2430.20  │\r\n'
            '└──────────┴──────────┘',
          ),
        ),
        compressed: false,
        cols: session.cols,
        rows: session.rows,
      ),
    );
    await tester.pump();

    expect(identical(beforeKeyframe, session.terminal), isFalse);
    expect(session.terminal.buffer.getText(), contains('Grok fixture'));
    expect(find.byType(TerminalView), findsOneWidget);
    expect(tester.takeException(), isNull);

    await session.handleBinary(
      TerminalBinaryFrame(
        kind: TerminalBinaryKind.output,
        streamId: streamId,
        seq: 1,
        bytes: Uint8List.fromList(utf8.encode('\x1b[?1049h')),
        compressed: false,
      ),
    );
    await tester.pump();
    session.scroll(0, 0, 0);
    session.scroll(1, 10, 0);
    await tester.pump(const Duration(milliseconds: 12));
    expect(
      utf8.decode([for (final frame in inputs) ...frame.bytes]),
      contains('\x1b[A'),
    );
    await session.handleBinary(
      TerminalBinaryFrame(
        kind: TerminalBinaryKind.output,
        streamId: streamId,
        seq: 2,
        bytes: Uint8List.fromList(utf8.encode('\x1b[?1049l')),
        compressed: false,
      ),
    );
    await tester.pump();

    await tester.tap(find.byType(TerminalView));
    tester.testTextInput.enterText('Tiếng Việt');
    await tester.pump(const Duration(milliseconds: 12));
    expect(
      utf8.decode([for (final frame in inputs) ...frame.bytes]),
      contains('Tiếng Việt'),
    );

    final firstKeyframeTerminal = session.terminal;
    await session.handleBinary(
      TerminalBinaryFrame(
        kind: TerminalBinaryKind.keyframe,
        streamId: streamId,
        seq: 7,
        bytes: Uint8List.fromList(
          utf8.encode('\x1b[2J\x1b[Hsecond authoritative screen'),
        ),
        compressed: false,
        cols: session.cols,
        rows: session.rows,
      ),
    );
    await tester.pump();

    expect(identical(firstKeyframeTerminal, session.terminal), isFalse);
    expect(session.terminal.buffer.getText(), contains('second authoritative'));
    expect(session.terminal.buffer.getText(), isNot(contains('Grok fixture')));
    expect(find.byType(TerminalView), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('switching agents leaves exactly one native terminal view', (
    tester,
  ) async {
    final notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    final sessions = List.generate(
      11,
      (index) => TerminalSession(
        machineId: 'machine',
        agentId: 'agent-$index',
        agentName: 'agent-$index',
        engineId: index.isEven ? 'grok' : 'codex',
        send: (_, _) async => true,
        sendBinary: (_) async => true,
      )..terminal.write('screen-$index'),
    );
    addTearDown(notifier.dispose);
    addTearDown(() {
      for (final session in sessions) {
        session.dispose();
      }
    });

    for (final session in sessions) {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: TerminalPanel(
              notifier: notifier,
              session: session,
              focused: true,
            ),
          ),
        ),
      );
      await tester.pump();

      expect(find.byType(TerminalView), findsOneWidget);
      expect(
        tester.widget<TerminalView>(find.byType(TerminalView)).terminal,
        same(session.terminal),
      );
      expect(tester.takeException(), isNull);
    }
  });
}
