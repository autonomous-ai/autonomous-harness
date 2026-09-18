import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/agent_neighbour_warmer.dart';
import 'package:harness_mobile/phone/agent_swipe.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:xterm/xterm.dart';

import 'agent_pager_fixture.dart';

/// The pager puts the keyboard away for a swipe between agents — and for nothing else.
void main() {
  bool terminalHasFocus(WidgetTester tester) =>
      tester.binding.focusManager.primaryFocus?.context
          ?.findAncestorWidgetOfExactType<TerminalView>() !=
      null;

  Future<AppNotifier> pumpPager(WidgetTester tester) async {
    final app = pagerApp(PagerConn());
    addTearDown(app.dispose);
    final session = await liveAgent(app, 'b');
    for (var line = 0; line < 400; line++) {
      session.terminal.write('output line $line\r\n');
    }
    await tester.pumpWidget(
      MaterialApp(
        home: AgentSwipeHost(
          notifier: app,
          machineId: 'm',
          agentId: 'b',
          neighbours: pagerList(app),
        ),
      ),
    );
    await tester.pump();
    return app;
  }

  /// The software keyboard sliding up, as the platform reports it.
  Future<void> raiseKeyboard(WidgetTester tester) async {
    tester.view.viewInsets = const FakeViewPadding(bottom: 900);
    addTearDown(tester.view.resetViewInsets);
    await tester.pump();
    await tester.pump();
  }

  testWidgets('reading back through the scrollback leaves the keyboard up', (
    tester,
  ) async {
    await pumpPager(tester);
    await raiseKeyboard(tester);
    expect(terminalHasFocus(tester), isTrue);

    await tester.drag(find.byType(TerminalView), const Offset(0, 300));
    await tester.pump(const Duration(milliseconds: 500));

    expect(
      terminalHasFocus(tester),
      isTrue,
      reason: 'the terminal\'s own scroll is not a swipe to another agent',
    );
  });

  testWidgets('a swipe with no keyboard up does not swallow the next one', (
    tester,
  ) async {
    final app = await pumpPager(tester);
    // The neighbour opens and answers before the swipe reaches it, as in use.
    await tester.pump(AgentNeighbourWarmer.delay);
    await tester.pump();
    await goLive(app.paneOfAgent('m', 'c')!.session!);

    await tester.fling(find.byType(PageView), const Offset(-400, 0), 1000);
    await tester.pumpAndSettle();
    await raiseKeyboard(tester);

    expect(terminalHasFocus(tester), isTrue);
  });
}
