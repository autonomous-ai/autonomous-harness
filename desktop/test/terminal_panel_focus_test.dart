import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/terminal_panel.dart';

void main() {
  TerminalSession sessionFor(
    String agentId,
    List<TerminalBinaryFrame> inputFrames,
  ) {
    final session = TerminalSession(
      machineId: 'local',
      agentId: agentId,
      agentName: agentId,
      engineId: 'codex',
      send: (_, _) async => true,
      sendBinary: (frame) async {
        if (frame.kind == TerminalBinaryKind.input) inputFrames.add(frame);
        return true;
      },
    );
    session.status = TerminalSessionStatus.controlling;
    session.streamId = 'stream-$agentId';
    return session;
  }

  for (final platform in [TargetPlatform.macOS, TargetPlatform.linux]) {
    testWidgets(
      'Shift + horizontal arrows reach Codex on $platform in both buffers',
      (tester) async {
        debugDefaultTargetPlatformOverride = platform;
        addTearDown(() => debugDefaultTargetPlatformOverride = null);
        final frames = <TerminalBinaryFrame>[];
        final session = sessionFor('codex', frames);
        final notifier = AppNotifier(
          config: AppConfig.dev,
          authSession: AuthSession(),
          configStore: null,
        );
        addTearDown(() {
          session.dispose();
          notifier.dispose();
        });

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

        // Codex's queued-question picker uses Shift+Left in the normal
        // screen. Other TUIs use the alternate screen; both must receive
        // the standard xterm modifier sequence through the real input path.
        for (final alternate in [false, true]) {
          if (alternate) session.terminal.write('\x1b[?1049h');
          expect(session.terminal.isUsingAltBuffer, alternate);
          frames.clear();
          await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
          await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
          await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
          await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
          await tester.pump(const Duration(milliseconds: 20));

          expect(
            utf8.decode(frames.expand((frame) => frame.bytes).toList()),
            '\x1b[1;2D\x1b[1;2C',
            reason:
                'Shift+Left/Right must reach the PTY in '
                '${alternate ? 'the alternate' : 'the normal'} screen',
          );
        }
        debugDefaultTargetPlatformOverride = null;
      },
    );
  }

  testWidgets(
    'switching an agent in the focused pane restores keyboard input',
    (tester) async {
      final firstFrames = <TerminalBinaryFrame>[];
      final secondFrames = <TerminalBinaryFrame>[];
      final first = sessionFor('claude', firstFrames);
      final second = sessionFor('codex', secondFrames);
      final activeSession = ValueNotifier<TerminalSession>(first);
      final notifier = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );
      addTearDown(() {
        activeSession.dispose();
        first.dispose();
        second.dispose();
        notifier.dispose();
      });

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 900,
              height: 320,
              child: ValueListenableBuilder<TerminalSession>(
                valueListenable: activeSession,
                builder: (_, session, _) => TerminalPanel(
                  notifier: notifier,
                  session: session,
                  focused: true,
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      expect(tester.testTextInput.hasAnyClients, isTrue);

      // This mirrors a rail selection that replaces the current pane rather
      // than creating a second tile. The FocusNode remains the same while the
      // TerminalView and its native TextInputClient are remounted.
      activeSession.value = second;
      await tester.pump();
      await tester.pump();

      expect(tester.testTextInput.hasAnyClients, isTrue);
      tester.testTextInput.updateEditingValue(
        const TextEditingValue(
          text: 'codex input',
          selection: TextSelection.collapsed(offset: 11),
        ),
      );
      await tester.pump(const Duration(milliseconds: 10));

      expect(firstFrames, isEmpty);
      expect(secondFrames, hasLength(1));
      expect(utf8.decode(secondFrames.single.bytes), 'codex input');
    },
  );
}
