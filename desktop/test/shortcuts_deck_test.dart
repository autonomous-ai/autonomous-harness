// Settings ▸ Keyboard shortcuts draws the deck; the ⌘/ sheet draws the column.
// What this guards is the reason the deck exists: the rows have to reflow into
// the width the pane actually has, instead of sitting in one 460px lane with
// the rest of the window empty.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart';
import 'package:harness/shortcuts/app_shortcuts.dart';
import 'package:harness/shortcuts/key_cap.dart';
import 'package:harness/shortcuts/shortcuts_list.dart';

void main() {
  Future<void> pumpDeck(WidgetTester tester, double width) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: SingleChildScrollView(
            child: SizedBox(width: width, child: const ShortcutsDeck()),
          ),
        ),
      ),
    );
    await tester.pump();
  }

  /// Each cap at the size it asks for when nothing offers it room to fill.
  Future<void> pumpNaturalCaps(WidgetTester tester, List<String> labels) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (final label in labels)
                UnconstrainedBox(child: KeyCap(label)),
            ],
          ),
        ),
      ),
    );
    await tester.pump();
  }

  testWidgets('a wide pane puts the groups side by side', (tester) async {
    tester.view.physicalSize = const Size(1400 * 2, 900 * 2);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);

    await pumpDeck(tester, 900);

    final navigate = tester.getTopLeft(find.text('NAVIGATE'));
    final panes = tester.getTopLeft(find.text('PANES'));
    expect(panes.dx, greaterThan(navigate.dx), reason: 'a second lane');
    expect(panes.dy, navigate.dy, reason: 'and level with the first');
  });

  testWidgets('a narrow pane stacks them, which is the sheet again', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(600 * 2, 1400 * 2);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);

    await pumpDeck(tester, 320);

    final navigate = tester.getTopLeft(find.text('NAVIGATE'));
    final panes = tester.getTopLeft(find.text('PANES'));
    expect(panes.dx, navigate.dx);
    expect(panes.dy, greaterThan(navigate.dy));
  });

  testWidgets('every row is printed, with a cap per key', (tester) async {
    tester.view.physicalSize = const Size(1400 * 2, 1200 * 2);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);

    await pumpDeck(tester, 900);

    for (final row in shortcutRows()) {
      expect(
        find.text(row.label),
        findsOneWidget,
        reason: '${row.label} is missing from the deck',
      );
    }

    // ⌘] is two caps. Ctrl+Tab switches swarms.
    final next = find.ancestor(
      of: find.text('Next agent'),
      matching: find.byType(Row),
    );
    expect(
      find.descendant(of: next.first, matching: find.byType(KeyCap)),
      findsNWidgets(2),
    );

    // And the keys the app deliberately leaves alone are named too.
    expect(find.text('The terminal keeps'.toUpperCase()), findsOneWidget);
    expect(find.text(kTerminalOwnedKeys.first.label), findsOneWidget);
  });

  // A cap is a KEY, and a key is the size of the glyph on it. Bounding the
  // chord's width to stop it overflowing (see [_ShortcutRowView]) also handed
  // every cap a bounded width — and a `Container(alignment:)` fills one. Each
  // cap then took the whole row, a chord became one cap per line, and the
  // label beside it was squeezed to a single character per line.
  //
  // Every other test here finds a label by its text, which a column one glyph
  // wide still satisfies. Measuring is what catches it.
  testWidgets('a cap is the width of its key, not of the row', (tester) async {
    tester.view.physicalSize = const Size(1400 * 2, 1200 * 2);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);

    await pumpDeck(tester, 900);
    final inDeck = <String, double>{};
    for (final element in find.byType(KeyCap).evaluate()) {
      final cap = element.widget as KeyCap;
      inDeck[cap.label] = (element.renderObject! as RenderBox).size.width;
    }
    expect(inDeck, isNotEmpty);

    // The control: the same caps with nothing bounding them. An
    // [UnconstrainedBox] rather than a plain parent on purpose — an infinite
    // width is the one case the old `Container(alignment:)` shrank in too, so
    // this measures the cap's real appetite instead of reproducing the bug and
    // comparing it against itself.
    await pumpNaturalCaps(tester, inDeck.keys.toList());
    for (final label in inDeck.keys) {
      final natural = tester.getSize(
        find.byWidgetPredicate((w) => w is KeyCap && w.label == label),
      );
      expect(
        inDeck[label],
        natural.width,
        reason: '"$label" stretched to fill its row instead of its glyph',
      );
    }
  });

  // The other half of the same squeeze: whatever the chord does not take
  // belongs to the label, which has to read as a sentence rather than as a
  // column one character wide.
  testWidgets('the label keeps the room the chord leaves', (tester) async {
    tester.view.physicalSize = const Size(1400 * 2, 1200 * 2);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);

    await pumpDeck(tester, 900);

    final label = tester.renderObject<RenderBox>(find.text('Next agent'));
    expect(
      label.size.height,
      lessThan(KeyCap.height),
      reason: 'the label wrapped instead of sitting on one line',
    );
  });

  // The invariant the deck's minimum card width is FOR. It used to hold only by
  // 5.5px at three columns, so the row that outgrew it overflowed just once the
  // deck handed a card its minimum — a layout no fixed-width test rendered, so
  // it surfaced as the two tests above failing at random.
  //
  // Rendering at exactly _minCardWidth is what makes it deterministic: if a new
  // chord outgrows a card again, THIS fails, by name, every time.
  testWidgets('no row overflows a card at its narrowest', (tester) async {
    tester.view.physicalSize = const Size(1400 * 2, 4000 * 2);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);

    // One lane, sized so the deck's LayoutBuilder settles on a single card at
    // exactly the minimum it will ever draw.
    await pumpDeck(tester, ShortcutsDeck.minCardWidth);

    expect(
      tester.takeException(),
      isNull,
      reason: 'a chord outgrew the narrowest card — it must wrap, not overflow',
    );
  });
}
