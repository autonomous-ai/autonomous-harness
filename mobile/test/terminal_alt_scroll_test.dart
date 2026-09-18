import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
// The view that turns an alternate-buffer drag into wheel events: it is not
// exported, and the bug lived in its render object.
// ignore: implementation_imports
import 'package:xterm/src/ui/infinite_scroll_view.dart';

/// A full-screen agent (Claude Code) is scrolled through [InfiniteScrollView],
/// which reports each drag so it can be sent on as wheel events.
///
/// The reported case: open New Agent from the terminal, come back, and the
/// terminal no longer scrolled — until the agent was opened again. The
/// Scrollable had replaced its position (it does on every dependency change),
/// and the view was still listening to the old one.
void main() {
  testWidgets('a drag still reports after the scroll position is replaced', (
    tester,
  ) async {
    final offsets = <double>[];
    var ratio = 2.0;
    late StateSetter rebuild;
    await tester.pumpWidget(
      MaterialApp(
        home: StatefulBuilder(
          builder: (context, setState) {
            rebuild = setState;
            return MediaQuery(
              data: MediaQuery.of(context).copyWith(devicePixelRatio: ratio),
              child: InfiniteScrollView(
                onScroll: offsets.add,
                child: const SizedBox.expand(),
              ),
            );
          },
        ),
      ),
    );

    await tester.drag(find.byType(InfiniteScrollView), const Offset(0, 120));
    await tester.pumpAndSettle();
    expect(offsets, isNotEmpty);

    // A dependency of the Scrollable changes, so it builds a new position.
    rebuild(() => ratio = 3.0);
    await tester.pump();
    offsets.clear();

    await tester.drag(find.byType(InfiniteScrollView), const Offset(0, 120));
    await tester.pumpAndSettle();
    expect(offsets, isNotEmpty);
  });
}
