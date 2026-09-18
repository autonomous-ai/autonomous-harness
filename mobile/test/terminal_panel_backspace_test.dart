import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/widgets/terminal_panel.dart';
import 'package:xterm/xterm.dart';

import 'keyboard_fakes.dart';
import 'terminal_panel_fixture.dart';

/// Text typed on the desktop sits in the agent's prompt, and this phone's
/// keyboard never typed it: its buffer holds nothing of that line. Backspace on
/// the phone still has to reach the pty, or the line can only be erased from the
/// desktop.
///
/// TestFlight build 11 shipped without that — a merge (cb47ba35) had dropped
/// the panel's `deleteDetection`, and iOS answers Backspace over an empty
/// buffer with nothing at all. `terminal_ime_input_test.dart` covers xterm's
/// side; this pins the panel actually asking for it.
void main() {
  const erased = [0x7f, 0x7f, 0x7f, 0x7f, 0x7f];

  /// Opens a pane over a prompt the desktop typed into and raises the keyboard
  /// on it. Returns the bytes the pane puts on the wire.
  ///
  /// ⚠️ Built here, not in `setUp`: the session's send queue is a Future, and
  /// one made outside the test's fake clock never drains inside it.
  Future<List<int>> raiseKeyboard(WidgetTester tester) async {
    final wire = <int>[];
    final notifier = panelNotifier();
    final session = controllingSession(
      sendBinary: (frame) async {
        wire.addAll(frame.bytes);
        return true;
      },
    );
    addTearDown(notifier.dispose);
    addTearDown(session.dispose);
    // What the desktop typed, as the phone sees it: output, not keystrokes.
    session.terminal.write('> fssss');

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 400,
            height: 320,
            child: TerminalPanel(
              notifier: notifier,
              session: session,
              focused: false,
              showHeader: false,
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.byType(TerminalView));
    // Past the double-tap window, which is what holds a single tap back.
    await tester.pump(kDoubleTapTimeout);
    expect(tester.testTextInput.hasAnyClients, isTrue);
    return wire;
  }

  /// Past the session's input coalescing, so every key is on the wire.
  Future<void> flushInput(WidgetTester tester) =>
      tester.pump(const Duration(milliseconds: 50));

  testWidgets(
    'Backspace as an edit to the keyboard\'s buffer erases the desktop\'s text',
    (tester) async {
      final wire = await raiseKeyboard(tester);

      for (var press = 0; press < erased.length; press++) {
        await deleteBackward(tester);
      }
      await flushInput(tester);

      expect(wire, erased);
    },
    variant: TargetPlatformVariant({
      TargetPlatform.iOS,
      TargetPlatform.android,
    }),
  );

  testWidgets(
    'Backspace as a key, the way Gboard sends it, erases the desktop\'s text',
    (tester) async {
      final wire = await raiseKeyboard(tester);

      for (var press = 0; press < erased.length; press++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.backspace);
      }
      await flushInput(tester);

      expect(wire, erased);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.android),
  );
}
