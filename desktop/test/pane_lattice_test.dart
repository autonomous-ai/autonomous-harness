// Five tiles and up: the grid.
//
// The shape is not ceil(sqrt(n)) — it is "as many columns as the WIDTH can
// carry at 40 usable terminal columns", because a tile narrower than that shows
// a grid wider than its own box and silently loses the right-hand text. So the
// tests here are about width and height, not about counts.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/widgets/pane_grid.dart';

AppNotifier _withPanes(int n) {
  final notifier = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
  );
  for (var i = 0; i < n; i++) {
    notifier.panes.add(TerminalPane(id: i, machineId: 'm', agentId: 'a$i'));
  }
  return notifier;
}

Future<void> _pump(WidgetTester tester, int n, Size size) async {
  await tester.binding.setSurfaceSize(size);
  await tester.pumpWidget(
    MaterialApp(
      home: ColoredBox(
        color: const Color(0xFF181818),
        child: PaneGrid(notifier: _withPanes(n)),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  test('machine starters can contain more than nine agents', () {
    expect(PaneLayoutStore.maxPanes, 9);
    expect(AppNotifier.maxPanes, greaterThan(PaneLayoutStore.maxPanes));
  });

  for (final n in [5, 6, 7, 8, 9]) {
    testWidgets('$n tiles lay out without overflowing', (tester) async {
      // The failure this guards is real and was hit while building it: dividing
      // the height evenly among six rows gave 115px a tile against a 46px
      // header, and the pane's own chrome overflowed its box. A render overflow
      // is a bug at any window size.
      await _pump(tester, n, const Size(1750, 900));
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets(
    'a window too short to hold the rows scrolls instead of squeezing',
    (tester) async {
      // Squeezing is the tempting answer and wrong twice: the daemon clamps the
      // terminal at twelve rows anyway, so a shrunk tile just loses its own
      // bottom, and the chrome overflows. Nine usable tiles behind a scrollbar
      // beat nine unusable ones in view.
      await _pump(tester, 9, const Size(1750, 420));
      expect(tester.takeException(), isNull);
      expect(find.byType(SingleChildScrollView), findsWidgets);
    },
  );

  testWidgets('a window with the room does not scroll', (tester) async {
    await _pump(tester, 6, const Size(1750, 900));
    expect(find.byType(SingleChildScrollView), findsNothing);
  });

  testWidgets('four tiles keep the shape they were tuned to', (tester) async {
    // 2×2, not a lattice. Three tiles are two over one with the bottom SPANNING,
    // and no uniform grid can say that — so the hand-tuned shapes stay.
    await _pump(tester, 4, const Size(1750, 900));
    expect(tester.takeException(), isNull);
    expect(find.byType(SingleChildScrollView), findsNothing);
  });
}
