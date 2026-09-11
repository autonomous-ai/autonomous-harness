import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_menu.dart';
import 'package:harness/shared/widgets/app_select_field.dart';

/// [top] puts the field at the top of the window instead of its middle.
///
/// A `MenuAnchor` squeezes its panel into the room BELOW the anchor, so a field
/// centred in a 600pt test window leaves only ~300 and a seven-row list gets
/// compressed — an artefact of the harness, not of the widget. Any test that
/// measures a tall panel has to give it somewhere to open.
Widget _host(Widget child, {bool top = false}) => MaterialApp(
  theme: grid.buildAppTheme(brightness: Brightness.dark),
  themeAnimationDuration: Duration.zero,
  home: Builder(
    builder: (context) {
      grid.AppTheme.brightness.value = Theme.of(context).brightness;
      return grid.BrightnessScope(
        child: Scaffold(
          body: top
              ? Align(alignment: Alignment.topCenter, child: child)
              : Center(child: child),
        ),
      );
    },
  ),
);

const _options = <SelectOption<String?>>[
  SelectOption(value: null, label: 'System', note: 'SF Pro'),
  SelectOption(value: 'Helvetica Neue', label: 'Helvetica Neue'),
  SelectOption(value: 'Menlo', label: 'Menlo'),
];

/// Type-agnostic: the suite exercises both `AppSelectField<String?>` (the font
/// picker, where null means "system") and `AppSelectField<String>`.
final _field = find.byWidgetPredicate(
  (w) => w.runtimeType.toString().startsWith('AppSelectField<'),
);

Future<void> _open(WidgetTester tester) async {
  await tester.tap(_field);
  await tester.pumpAndSettle();
}

void main() {
  tearDown(() => grid.AppTheme.brightness.value = Brightness.light);

  testWidgets('an unpicked row draws NO glyph — not an empty checkbox', (
    tester,
  ) async {
    // The regression this exists for: the leading slot was once filled with
    // `Icons.check_box_outline_blank` to keep the labels aligned. That glyph
    // draws a real outlined square, so a pick-one menu rendered as a list of
    // empty checkboxes — and put a border where §1 allows none.
    await tester.pumpWidget(
      _host(
        AppSelectField<String?>(
          value: null,
          options: _options,
          onChanged: (_) {},
          width: 188,
        ),
      ),
    );
    await _open(tester);

    expect(find.byType(AppMenuItem), findsNWidgets(3));
    expect(find.byIcon(Icons.check_box_outline_blank), findsNothing);
    // Exactly one glyph in the whole panel: the tick on the chosen row.
    expect(
      find.descendant(
        of: find.byType(AppMenuItem),
        matching: find.byType(Icon),
      ),
      findsOneWidget,
    );
    expect(find.byIcon(LucideIcons.check300), findsOneWidget);
  });

  testWidgets('the choice is marked three ways, not by colour alone', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        AppSelectField<String?>(
          value: 'Menlo',
          options: _options,
          onChanged: (_) {},
          width: 188,
        ),
      ),
    );
    await _open(tester);

    Text labelIn(String label) => tester.widget<Text>(
      find.descendant(
        of: find.widgetWithText(AppMenuItem, label),
        matching: find.text(label),
      ),
    );

    // 1. the tick, 2. the heavier label. (3. the accent wash is painted by an
    // `Ink` and is checked by eye, not here.)
    expect(find.byIcon(LucideIcons.check300), findsOneWidget);
    expect(labelIn('Menlo').style?.fontWeight, grid.AppFont.semibold);
    expect(labelIn('Helvetica Neue').style?.fontWeight, grid.AppFont.medium);
  });

  testWidgets('a note reads as an aside, not as part of the name', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        AppSelectField<String?>(
          value: null,
          options: _options,
          onChanged: (_) {},
          width: 188,
        ),
      ),
    );
    await _open(tester);

    // Two Texts inside the row, not one label with a '·' glued into it — so the
    // face name can take quieter ink than the choice it qualifies.
    //
    // Scoped to the panel: the closed field shows the same pair, which is the
    // point — the control and its menu say the same thing the same way.
    final row = find.widgetWithText(AppMenuItem, 'System');
    expect(row, findsOneWidget);
    expect(
      find.descendant(of: row, matching: find.text('SF Pro')),
      findsOneWidget,
    );
    expect(find.textContaining('·'), findsNothing);

    final note = tester.widget<Text>(
      find.descendant(of: row, matching: find.text('SF Pro')),
    );
    final label = tester.widget<Text>(
      find.descendant(of: row, matching: find.text('System')),
    );
    expect(note.style?.color, isNot(label.style?.color));
    expect(note.style!.fontSize!, lessThan(label.style!.fontSize!));
  });

  testWidgets('a row mark gets its own slot, so labels never shift', (
    tester,
  ) async {
    // The engine picker carries a logo per row AND a tick on the chosen one.
    // They cannot share the leading slot: the picked row's label would sit a
    // glyph further right than every other row's.
    await tester.pumpWidget(
      _host(
        AppSelectField<String>(
          value: 'b',
          options: [
            SelectOption(
              value: 'a',
              label: 'Alpha',
              leading: () => const Icon(Icons.circle, size: 14),
            ),
            SelectOption(
              value: 'b',
              label: 'Beta',
              leading: () => const Icon(Icons.square, size: 14),
            ),
          ],
          onChanged: (_) {},
          width: 188,
        ),
      ),
    );
    await _open(tester);

    double labelX(String text) => tester
        .getTopLeft(
          find.descendant(
            of: find.byType(AppMenuItem),
            matching: find.text(text),
          ),
        )
        .dx;

    expect(
      labelX('Beta'),
      labelX('Alpha'),
      reason: 'the ticked row and the unticked one start on the same column',
    );
    // Both marks are drawn, and the tick is drawn as well as them, not instead.
    expect(find.byIcon(Icons.circle), findsWidgets);
    expect(find.byIcon(Icons.square), findsWidgets);
    expect(find.byIcon(LucideIcons.check300), findsOneWidget);
  });

  testWidgets('picking a row reports it and closes the panel', (tester) async {
    String? picked = 'unset';
    await tester.pumpWidget(
      _host(
        AppSelectField<String?>(
          value: null,
          options: _options,
          onChanged: (value) => picked = value,
          width: 188,
        ),
      ),
    );
    await _open(tester);

    await tester.tap(find.widgetWithText(AppMenuItem, 'Menlo'));
    await tester.pumpAndSettle();

    expect(picked, 'Menlo');
    expect(find.byType(AppMenuItem), findsNothing);
  });

  testWidgets('re-picking the current value reports nothing', (tester) async {
    var calls = 0;
    await tester.pumpWidget(
      _host(
        AppSelectField<String?>(
          value: 'Menlo',
          options: _options,
          onChanged: (_) => calls++,
          width: 188,
        ),
      ),
    );
    await _open(tester);

    await tester.tap(find.widgetWithText(AppMenuItem, 'Menlo'));
    await tester.pumpAndSettle();

    expect(calls, 0, reason: 'a no-op choice must not write to disk');
  });

  testWidgets('the picker uses the roomy row, a context menu keeps compact', (
    tester,
  ) async {
    // Two sizes exist on purpose (see AppMenuRowMetrics). This is the line
    // between them: a picker's list is read down, a ⋯ menu is glanced at.
    await tester.pumpWidget(
      _host(
        Column(
          children: [
            AppSelectField<String?>(
              value: null,
              options: _options,
              onChanged: (_) {},
              width: 188,
            ),
            AppMenuItem(
              icon: Icons.circle,
              label: 'A context row',
              onPressed: () {},
            ),
          ],
        ),
      ),
    );

    final contextRow = tester.widget<AppMenuItem>(
      find.widgetWithText(AppMenuItem, 'A context row'),
    );
    expect(contextRow.metrics, AppMenuRowMetrics.compact);

    await _open(tester);
    final pickerRow = tester.widget<AppMenuItem>(
      find.widgetWithText(AppMenuItem, 'Menlo'),
    );
    expect(pickerRow.metrics, AppMenuRowMetrics.roomy);
    expect(
      AppMenuRowMetrics.roomy.fontSize,
      greaterThan(AppMenuRowMetrics.compact.fontSize),
    );
    expect(
      AppMenuRowMetrics.roomy.iconSize,
      greaterThan(AppMenuRowMetrics.compact.iconSize),
    );
  });

  testWidgets('a row measures the extent its metrics claim', (tester) async {
    // The constant IS a measurement, and this is the measurement — the STRIDE
    // between two rows, not one row's own box, because the first row abuts the
    // panel edge and reports a pixel that is not there.
    //
    // It got its value this way: the arithmetic said 38.8, the layout said 40.
    // A panel sized from the arithmetic overflows and hangs a scrollbar on
    // itself, which is the bug this test exists to prevent coming back.
    await tester.pumpWidget(
      _host(
        AppSelectField<String?>(
          value: null,
          options: _options,
          onChanged: (_) {},
          width: 188,
        ),
      ),
    );
    await _open(tester);

    final first = tester.getRect(find.byType(AppMenuItem).at(0));
    final second = tester.getRect(find.byType(AppMenuItem).at(1));
    expect(
      second.top - first.top,
      closeTo(AppMenuRowMetrics.roomy.extent, 0.1),
    );
  });

  testWidgets('a list that fits does NOT grow a scrollbar', (tester) async {
    // Seven rows is the engine picker, and at AppControl.menuMaxHeight (240) it
    // overflowed by five pixels — enough for Material to draw furniture saying
    // there was more to see.
    final many = [
      for (var i = 0; i < 7; i++)
        SelectOption<String?>(value: 'e$i', label: 'Engine $i'),
    ];
    await tester.pumpWidget(
      _host(
        AppSelectField<String?>(
          value: 'e0',
          options: many,
          onChanged: (_) {},
          width: 188,
        ),
        top: true,
      ),
    );
    await _open(tester);

    // What matters is that all seven are laid out and the last one is whole —
    // at AppControl.menuMaxHeight (240) the panel held six and a scrollbar.
    //
    // The exact stride is pinned by the three-row test above, not here: a panel
    // this tall is squeezed by whatever room the anchor has below it, so a
    // stride measured here is a fact about the test window, not about the row.
    expect(find.byType(AppMenuItem), findsNWidgets(7));
    final first = tester.getRect(find.byType(AppMenuItem).at(0));
    final last = tester.getRect(find.byType(AppMenuItem).at(6));
    expect(last.top, greaterThan(first.top));
    expect(last.height, greaterThan(AppMenuRowMetrics.compact.extent));
    expect(
      last.bottom - first.top,
      greaterThan(6 * AppMenuRowMetrics.compact.extent),
      reason: 'seven roomy rows must occupy more than seven compact ones would',
    );
  });

  testWidgets('the panel is at least as wide as the field it hangs off', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        AppSelectField<String?>(
          value: null,
          options: _options,
          onChanged: (_) {},
          width: 188,
        ),
      ),
    );
    final fieldWidth = tester.getSize(_field).width;
    await _open(tester);

    final rowWidth = tester.getSize(find.byType(AppMenuItem).first).width;
    expect(
      rowWidth,
      greaterThanOrEqualTo(fieldWidth - 1),
      reason: 'a panel narrower than its control reads as an unrelated box',
    );
    // …and never narrower than the floor, whatever the field does. A 188pt
    // field holds names that a 188pt list would have to truncate.
    expect(rowWidth, greaterThanOrEqualTo(240));
  });

  group('a detail line', () {
    const detailed = <SelectOption<String>>[
      SelectOption(
        value: 'invite',
        label: 'Invite only',
        detail: 'Only people you invite can use this grid.',
      ),
      SelectOption(
        value: 'public',
        label: 'Public',
        detail: 'Anyone can use this grid.',
      ),
    ];

    testWidgets('shows the sentence in the open menu, not in the field', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(
          AppSelectField<String>(
            value: 'invite',
            options: detailed,
            onChanged: (_) {},
          ),
          top: true,
        ),
      );
      // Closed, the control is only as wide as itself — a sentence would arrive
      // clipped mid-clause and read as a rendering bug.
      expect(find.textContaining('Only people you invite'), findsNothing);

      await _open(tester);
      expect(find.textContaining('Only people you invite'), findsOneWidget);
      expect(find.textContaining('Anyone can use'), findsOneWidget);
    });

    // A panel measured with the plain extent is shorter than its own rows, and
    // grows a scrollbar to show the overflow — furniture that says "there is
    // more here" when there is not.
    testWidgets('is counted when the panel is sized, so no scrollbar', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(
          AppSelectField<String>(
            value: 'invite',
            options: detailed,
            onChanged: (_) {},
          ),
          top: true,
        ),
      );
      await _open(tester);

      final rows = tester
          .widgetList<AppMenuItem>(find.byType(AppMenuItem))
          .length;
      expect(rows, 2);
      final first = tester.getRect(find.byType(AppMenuItem).at(0));
      expect(
        first.height,
        greaterThan(AppMenuRowMetrics.roomy.extent),
        reason: 'a row carrying a sentence is taller than one without',
      );
      expect(
        tester.getRect(find.byType(AppMenuItem).at(1)).bottom - first.top,
        lessThanOrEqualTo(2 * AppMenuRowMetrics.roomy.detailExtent + 1),
      );
    });
  });
}
