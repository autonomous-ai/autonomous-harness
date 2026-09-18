import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';
import 'package:harness_mobile/widgets/terminal_panel.dart';
import 'package:xterm/xterm.dart';

import 'terminal_panel_fixture.dart';

/// What a phone terminal draws while it is not the page being read, or while
/// the keyboard is still sliding.
///
/// Both used to stop painting outright. A swipe then showed the incoming
/// agent's OLDEST scrollback until it passed halfway and jumped to the end, and
/// the output froze for every keyboard slide. What those two states must hold
/// back is the resize of the far machine's shell — nothing else.
void main() {
  late AppNotifier notifier;
  late TerminalSession session;
  late List<Map<String, dynamic>> resizes;

  setUp(() {
    notifier = panelNotifier();
    resizes = [];
    session = controllingSession(
      send: (type, payload) async {
        if (type == 'terminal_resize') resizes.add(payload);
        return true;
      },
    );
    for (var line = 0; line < 200; line++) {
      session.terminal.write('output line $line\r\n');
    }
  });

  tearDown(() {
    session.dispose();
    notifier.dispose();
  });

  Future<void> pumpPanel(
    WidgetTester tester, {
    required bool visible,
    bool settling = false,
    double height = 320,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Align(
            alignment: Alignment.topLeft,
            child: SizedBox(
              width: 400,
              height: height,
              child: TerminalPanel(
                notifier: notifier,
                session: session,
                focused: false,
                visible: visible,
                settling: settling,
                showHeader: false,
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
  }

  ScrollPosition terminalScroll(WidgetTester tester) => tester
      .state<ScrollableState>(
        find.descendant(
          of: find.byType(TerminalView),
          matching: find.byType(Scrollable),
        ),
      )
      .position;

  testWidgets('a parked page lays out at the end of its output', (
    tester,
  ) async {
    await pumpPanel(tester, visible: false);

    final position = terminalScroll(tester);
    // Unlaid-out, the offset stays at zero: the top of the scrollback is what
    // the page would draw as it slides in.
    expect(position.hasContentDimensions, isTrue);
    expect(position.maxScrollExtent, greaterThan(0));
    expect(position.pixels, position.maxScrollExtent);
  });

  testWidgets('a parked page asks the far machine for no resize', (
    tester,
  ) async {
    await pumpPanel(tester, visible: false);
    await pumpPanel(tester, visible: false, height: 200);

    expect(resizes, isEmpty);
  });

  testWidgets('while the keyboard slides the output keeps moving and the '
      'shell is resized once, when it stops', (tester) async {
    await pumpPanel(tester, visible: true);
    await tester.pumpAndSettle();
    resizes.clear();

    // Three frames of a keyboard rising, each a different height, with the
    // agent still printing.
    var extent = terminalScroll(tester).maxScrollExtent;
    for (final height in [300.0, 260.0, 220.0]) {
      await pumpPanel(tester, visible: true, settling: true, height: height);
      session.terminal.write('streamed while sliding\r\n');
      await tester.pump();
      final position = terminalScroll(tester);
      // The new line was laid out — the view grew and is still at its end.
      expect(position.maxScrollExtent, greaterThan(extent));
      expect(position.pixels, position.maxScrollExtent);
      extent = position.maxScrollExtent;
    }
    expect(resizes, isEmpty, reason: 'no SIGWINCH per frame of the slide');

    await pumpPanel(tester, visible: true, height: 220);
    await tester.pumpAndSettle();

    expect(resizes, hasLength(1));
  });
}
