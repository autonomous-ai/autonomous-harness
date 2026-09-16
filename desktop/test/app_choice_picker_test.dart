import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/widgets/app_choice_picker.dart';
import 'package:harness/shared/widgets/app_menu.dart';
import 'package:harness/shared/widgets/app_select_field.dart';

void main() {
  testWidgets('tiled overflow omits direct choices and keeps one selection', (
    tester,
  ) async {
    var selected = 'codex';
    const moreKey = ValueKey('more');
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: StatefulBuilder(
            builder: (context, setState) => AppChoicePicker<String>(
              value: selected,
              options: const [
                SelectOption(value: 'codex', label: 'Codex'),
                SelectOption(value: 'claude', label: 'Claude Code'),
                SelectOption(value: 'opencode', label: 'OpenCode'),
                SelectOption(value: 'amp', label: 'Amp'),
                SelectOption(value: 'pi', label: 'Pi'),
              ],
              optionKey: (id) => ValueKey(id),
              moreKey: moreKey,
              moreLabel: 'More engines',
              tileSize: const Size(180, 76),
              onChanged: (value) => setState(() => selected = value),
            ),
          ),
        ),
      ),
    );
    Future<void> chooseFromMenu(LogicalKeyboardKey key, String letter) async {
      await tester.tap(find.byKey(moreKey));
      await tester.sendKeyEvent(key, character: letter);
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
    }

    await tester.tap(find.byKey(moreKey));
    await tester.pumpAndSettle();
    for (final name in ['Codex', 'Claude Code', 'OpenCode']) {
      expect(
        find.text(name),
        findsOneWidget,
      ); // Only the tile, never a menu row.
    }
    expect(find.text('Amp'), findsOneWidget);
    expect(find.text('Pi'), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();

    await chooseFromMenu(LogicalKeyboardKey.keyA, 'a');
    expect(selected, 'amp');
    expect(
      tester.widget<AppSelectField<String>>(find.byKey(moreKey)).selected,
      isTrue,
    );
    expect(
      tester
          .widgetList<AppChoiceTile>(find.byType(AppChoiceTile))
          .where((tile) => tile.selected),
      isEmpty,
    );

    await tester.tap(find.byKey(const ValueKey('codex')));
    await tester.pumpAndSettle();
    // Browsing alternatives and cancelling returns focus to the fourth tile.
    await tester.tap(find.byKey(moreKey));
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(selected, 'codex');
    expect(find.text('Amp'), findsOneWidget);
    final more = find.byKey(moreKey);
    final trigger = tester.widget<InkWell>(
      find.descendant(of: more, matching: find.byType(InkWell)).first,
    );
    expect(trigger.focusNode!.hasPrimaryFocus, isTrue);
    expect(tester.widget<AppSelectField<String>>(more).selected, isFalse);
    final container = tester.widget<AnimatedContainer>(
      find.descendant(of: more, matching: find.byType(AnimatedContainer)).first,
    );
    expect(
      ((container.decoration! as BoxDecoration).border! as Border).top.color,
      Colors.transparent,
    );
    expect(
      tester
          .widgetList<AppChoiceTile>(find.byType(AppChoiceTile))
          .where((tile) => tile.selected)
          .map((tile) => tile.label),
      ['Codex'],
    );
  });

  testWidgets(
    'overflow selection replaces the third choice and retains keyboard control',
    (tester) async {
      var selected = 'local';
      final changes = <String>[];
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Center(
              child: SizedBox(
                width: 520,
                child: StatefulBuilder(
                  builder: (context, setState) => AppChoicePicker<String>(
                    value: selected,
                    options: const [
                      SelectOption(
                        value: 'local',
                        label: 'M2',
                        detail: 'This computer',
                      ),
                      SelectOption(
                        value: 'office',
                        label: 'Office',
                        detail: 'Remote',
                      ),
                      SelectOption(
                        value: 'home',
                        label: 'Home',
                        detail: 'Remote · Offline',
                      ),
                      SelectOption(
                        value: 'studio',
                        label: 'Studio',
                        detail: 'Remote',
                      ),
                    ],
                    showDetails: true,
                    optionKey: (id) => ValueKey(id),
                    moreKey: const ValueKey('more'),
                    moreLabel: 'More machines',
                    onChanged: (value) => setState(() {
                      selected = value;
                      changes.add(value);
                    }),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      expect(find.byType(TextButton), findsNWidgets(3));
      expect(find.text('Remote · Offline'), findsOneWidget);
      expect(find.text('Studio'), findsNothing);
      await tester.tap(find.byKey(const ValueKey('local')));
      expect(changes, isEmpty);
      await tester.tap(find.byKey(const ValueKey('more')));
      // Type immediately, before the first menu frame.
      await tester.sendKeyEvent(LogicalKeyboardKey.keyS, character: 's');
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(changes, ['studio']);
      expect(find.byType(TextButton), findsNWidgets(3));
      expect(find.text('Home'), findsNothing);
      expect(find.text('Studio'), findsOneWidget);
      final overflowFocus = tester
          .widget<InkWell>(
            find
                .descendant(
                  of: find.byKey(const ValueKey('more')),
                  matching: find.byType(InkWell),
                )
                .first,
          )
          .focusNode!;
      expect(overflowFocus.hasPrimaryFocus, isTrue);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.text('Home'), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(changes, ['studio']);
      expect(overflowFocus.hasPrimaryFocus, isTrue);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('the overflow lists the named kind before the rest', (
    tester,
  ) async {
    // The three tiles are the preferred values and are untouched; what is left
    // over is sorted by KIND, so the harnesses somebody opened More for are not
    // buried under engines that differ from the tiles only by name.
    const moreKey = ValueKey('more');
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AppChoicePicker<String>(
            value: 'codex',
            options: const [
              SelectOption(value: 'codex', label: 'Codex'),
              SelectOption(value: 'claude', label: 'Claude Code'),
              SelectOption(value: 'opencode', label: 'OpenCode'),
              SelectOption(value: 'cursor', label: 'Cursor'),
              SelectOption(value: 'kilo', label: 'Kilo'),
              SelectOption(value: 'autonomous/typst', label: 'Typst'),
              SelectOption(value: 'someone/robot-arm', label: 'Robot Arm'),
            ],
            preferredValues: const ['codex', 'claude', 'opencode'],
            overflowFirst: (id) => id.contains('/'),
            optionKey: (id) => ValueKey(id),
            moreKey: moreKey,
            moreLabel: 'More agents',
            tileSize: const Size(200, 100),
            onChanged: (_) {},
          ),
        ),
      ),
    );
    await tester.tap(find.byKey(moreKey));
    await tester.pumpAndSettle();
    expect(
      tester
          .widgetList<AppMenuItem>(find.byType(AppMenuItem))
          .map((row) => row.label),
      ['Typst', 'Robot Arm', 'Cursor', 'Kilo'],
    );
    expect(
      tester
          .widgetList<AppChoiceTile>(find.byType(AppChoiceTile))
          .map((tile) => tile.label),
      ['Codex', 'Claude Code', 'OpenCode'],
      reason: 'the direct tiles are the preferred values, unsorted',
    );
  });

  testWidgets('an overflow past eight rows gets a search field', (
    tester,
  ) async {
    const moreKey = ValueKey('more');
    var selected = 'e0';
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: StatefulBuilder(
            builder: (context, setState) => AppChoicePicker<String>(
              value: selected,
              options: [
                for (var i = 0; i < 12; i++)
                  SelectOption(value: 'e$i', label: 'Engine $i'),
              ],
              optionKey: (id) => ValueKey(id),
              moreKey: moreKey,
              moreLabel: 'More engines',
              tileSize: const Size(200, 100),
              onChanged: (value) => setState(() => selected = value),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.byKey(moreKey));
    await tester.pumpAndSettle();
    // Nine rows in the overflow — the picker turns the field on by handing
    // `filterable` down; the threshold is the field's own.
    expect(find.byType(AppMenuItem), findsNWidgets(9));
    final filter = find.byKey(const Key('app-select-filter'));
    expect(filter, findsOneWidget);
    await tester.enterText(filter, 'ne 7');
    await tester.pumpAndSettle();
    expect(find.byType(AppMenuItem), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(selected, 'e7');
  });

  group('a tile\'s detail line', () {
    test('spends the spare line on the detail unless the name needs it', () {
      // 68 points is the room a 100pt tile has inside its padding: three lines
      // between the two of them, and one of them gets the second.
      ({int label, int detail}) lines({
        required double room,
        required bool labelWraps,
      }) => AppChoiceTileContent.linesFor(
        room: room,
        labelWraps: labelWraps,
        hasDetail: true,
        scaler: TextScaler.noScaling,
      );
      expect(lines(room: 68, labelWraps: false), (label: 1, detail: 2));
      expect(lines(room: 68, labelWraps: true), (label: 2, detail: 1));
      expect(lines(room: 120, labelWraps: true), (label: 2, detail: 2));
      expect(lines(room: 40, labelWraps: true), (label: 1, detail: 1));
      expect(
        AppChoiceTileContent.linesFor(
          room: 68,
          labelWraps: true,
          hasDetail: false,
          scaler: TextScaler.noScaling,
        ),
        (label: 2, detail: 0),
      );
    });

    testWidgets('draws on two lines, and a wrapping name still wraps', (
      tester,
    ) async {
      Future<void> pump(String label, String detail) => tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Center(
              child: AppChoiceTile(
                // The dialog's own tile at a 4-column desktop width.
                size: const Size(190, 100),
                label: label,
                detail: detail,
                onPressed: () {},
              ),
            ),
          ),
        ),
      );

      await pump('Manim', 'Math animation · Manim Community');
      final detail = tester.widget<Text>(
        find.text('Math animation · Manim Community'),
      );
      expect(detail.maxLines, 2);
      expect(
        tester.getSize(find.text('Math animation · Manim Community')).height,
        greaterThan(
          AppChoiceTileContent.detailSize *
              AppChoiceTileContent.lineHeight *
              1.5,
        ),
        reason: 'the maker\'s name belongs on the tile, not behind an ellipsis',
      );
      expect(tester.takeException(), isNull);

      // A name that genuinely needs two lines keeps them: the second line is
      // the detail's only while the name can spare it.
      await pump('dees-MacBook-Pro.local', 'Remote · Offline');
      expect(
        tester.widget<Text>(find.text('dees-MacBook-Pro.local')).maxLines,
        2,
      );
      expect(tester.widget<Text>(find.text('Remote · Offline')).maxLines, 1);
      expect(tester.takeException(), isNull);
    });
  });

  testWidgets('up to three options need no overflow menu', (tester) async {
    for (var count = 1; count <= 3; count++) {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AppChoicePicker<int>(
              value: 0,
              options: [
                for (var i = 0; i < count; i++)
                  SelectOption(value: i, label: 'Machine $i'),
              ],
              optionKey: (id) => ValueKey(id),
              moreLabel: 'More machines',
              onChanged: (_) {},
            ),
          ),
        ),
      );
      expect(find.byType(TextButton), findsNWidgets(count));
      expect(find.byType(AppSelectField<int>), findsNothing);
      expect(tester.takeException(), isNull);
    }
  });
}
