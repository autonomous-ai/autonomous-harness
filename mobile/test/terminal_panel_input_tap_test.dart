import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';
import 'package:harness_mobile/widgets/terminal_panel.dart';
import 'package:xterm/xterm.dart';

import 'terminal_panel_fixture.dart';

/// On the phone the page decides what a tap on the terminal does — it types
/// what the mic heard into the prompt before it raises the keyboard. The panel
/// is where that tap is taken: xterm would otherwise raise the keyboard itself
/// before anyone else could say otherwise.
void main() {
  late AppNotifier notifier;
  late TerminalSession session;
  late int inputTaps;

  setUp(() {
    notifier = panelNotifier();
    session = controllingSession();
    inputTaps = 0;
  });

  tearDown(() {
    session.dispose();
    notifier.dispose();
  });

  Future<void> pumpPanel(
    WidgetTester tester, {
    VoidCallback? onInputTap,
  }) async {
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
              onInputTap: onInputTap,
            ),
          ),
        ),
      ),
    );
    await tester.pump();
  }

  testWidgets('a taken tap raises no keyboard, and runs the host instead', (
    tester,
  ) async {
    await pumpPanel(tester, onInputTap: () => inputTaps++);

    await tester.tap(find.byType(TerminalView));
    // Past the double-tap window, which is what holds a single tap back.
    await tester.pump(kDoubleTapTimeout);

    expect(inputTaps, 1);
    expect(tester.testTextInput.hasAnyClients, isFalse);
  });

  testWidgets('only a tap on the prompt runs the host; the output swallows it', (
    tester,
  ) async {
    await pumpPanel(tester, onInputTap: () => inputTaps++);
    session.terminal.write(
      '${List.generate(60, (i) => 'output $i').join('\r\n')}\r\n\r\n› prompt',
    );
    await tester.pump();
    // Aimed through the render box, not the widget: the widget's padding is no
    // row at all, and a tap there never reaches the terminal's gestures.
    final render = tester
        .state<TerminalViewState>(find.byType(TerminalView))
        .renderTerminal;

    await tester.tapAt(render.localToGlobal(const Offset(20, 4)));
    await tester.pump(kDoubleTapTimeout);
    expect(inputTaps, 0, reason: 'reading the output raises nothing');
    expect(tester.testTextInput.hasAnyClients, isFalse);

    await tester.tapAt(
      render.localToGlobal(Offset(20, render.size.height - 4)),
    );
    await tester.pump(kDoubleTapTimeout);
    expect(inputTaps, 1);
  });

  testWidgets('without a host the tap is still xterm\'s, keyboard and all', (
    tester,
  ) async {
    await pumpPanel(tester);

    await tester.tap(find.byType(TerminalView));
    // Past the double-tap window, which is what holds a single tap back.
    await tester.pump(kDoubleTapTimeout);

    expect(tester.testTextInput.hasAnyClients, isTrue);
  });

  testWidgets('a scroll that began as a press opens nothing', (tester) async {
    await pumpPanel(tester, onInputTap: () => inputTaps++);

    final gesture = await tester.startGesture(
      tester.getCenter(find.byType(TerminalView)),
    );
    // Held past the press timeout, so the tap recognizer has already reported
    // tap DOWN before the finger moves.
    await tester.pump(const Duration(milliseconds: 200));
    await gesture.moveBy(const Offset(0, -120));
    await gesture.up();
    await tester.pump();

    expect(inputTaps, 0);
    expect(tester.testTextInput.hasAnyClients, isFalse);
  });
}
