import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart';
import 'package:harness/shared/widgets/app_icon_button.dart';

/// A button whose work outlives the click has to say so.
///
/// The rail's reload fires a REST call plus an `agents_list` per open machine —
/// long enough that a button which just sat there read as not having taken the
/// click, and long enough that an impatient second press used to start the
/// whole run again beside the first. Turning the glyph answers both: it reports
/// the work, and it is the state in which the button stops listening.
void main() {
  /// The app's own — MaterialApp puts a RotationTransition of its own in the
  /// tree (the route transition), so a bare byType finder matches two.
  final rotation = find.descendant(
    of: find.byType(AppIconButton),
    matching: find.byType(RotationTransition),
  );

  Future<void> pumpButton(
    WidgetTester tester, {
    required bool spinning,
    required VoidCallback onPressed,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Center(
            child: AppIconButton(
              icon: Icons.refresh,
              spinning: spinning,
              onPressed: onPressed,
            ),
          ),
        ),
      ),
    );
    await tester.pump();
  }

  testWidgets('a spinning button turns its glyph', (tester) async {
    await pumpButton(tester, spinning: true, onPressed: () {});

    double turns() => tester.widget<RotationTransition>(rotation).turns.value;

    // Angle at rest, then again part-way through a revolution. Comparing two
    // samples rather than asserting a number keeps this off the controller's
    // exact period.
    final start = turns();
    await tester.pump(const Duration(milliseconds: 300));
    expect(turns(), greaterThan(start));

    // Leave it settled — a repeating controller never ends on its own, and a
    // live one at teardown fails the test with a pending timer.
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('a spinning button refuses the press', (tester) async {
    var presses = 0;
    await pumpButton(tester, spinning: true, onPressed: () => presses++);

    await tester.tap(find.byType(AppIconButton));
    await tester.pump();
    expect(presses, 0, reason: 'the run it already started is still going');

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('the same button takes the press once it stops', (tester) async {
    var presses = 0;
    await pumpButton(tester, spinning: false, onPressed: () => presses++);

    await tester.tap(find.byType(AppIconButton));
    await tester.pump();
    expect(presses, 1);
  });

  testWidgets('spinning keeps its ink — it is working, not unavailable', (
    tester,
  ) async {
    await pumpButton(tester, spinning: true, onPressed: () {});
    final spinningInk = tester.widget<Icon>(find.byType(Icon)).color;
    await tester.pumpWidget(const SizedBox.shrink());

    await pumpButton(tester, spinning: false, onPressed: () {});
    expect(spinningInk, tester.widget<Icon>(find.byType(Icon)).color);

    // A button with nothing to do is the one that greys out.
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: Center(
            child: AppIconButton(icon: Icons.refresh, onPressed: null),
          ),
        ),
      ),
    );
    await tester.pump();
    expect(tester.widget<Icon>(find.byType(Icon)).color, AppPalette.textFaint);
  });

  testWidgets('the glyph comes to rest upright, not mid-turn', (tester) async {
    await pumpButton(tester, spinning: true, onPressed: () {});
    await tester.pump(const Duration(milliseconds: 300));

    await pumpButton(tester, spinning: false, onPressed: () {});
    await tester.pumpAndSettle();

    // Not 0.4 or wherever the reply landed: a mark frozen at an angle reads as
    // a failure state.
    expect(
      tester.widget<RotationTransition>(rotation).turns.value % 1,
      moreOrLessEquals(0, epsilon: 0.001),
    );
  });
}
