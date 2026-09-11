// Picking a shape from the palette.
//
// Three ways in, and they must not contradict each other: a click and a digit
// apply straight away, while the arrows only MOVE — rearranging the grid under
// someone who is still reading the choices would be the picker answering for
// them.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_preset.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/widgets/layout_palette.dart';
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

Future<AppNotifier> _open(
  WidgetTester tester, {
  int panes = 3,
  PanePreset? preset,
}) async {
  final notifier = _withPanes(panes);
  if (preset != null) notifier.setPreset(panes, preset);
  await tester.pumpWidget(
    MaterialApp(
      home: Builder(
        builder: (context) => TextButton(
          onPressed: () => showLayoutPalette(context, notifier),
          child: const Text('open'),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
  return notifier;
}

void main() {
  testWidgets('picking a shape re-lays the grid there and then', (
    tester,
  ) async {
    // The end-to-end the other tests here do NOT cover: they set the shape
    // before the grid is built, which proves the arithmetic and nothing about
    // the app. This one taps the picker with a grid on screen and measures what
    // the tap did to it.
    final notifier = _withPanes(6);
    await tester.binding.setSurfaceSize(const Size(1512, 900));
    await tester.pumpWidget(
      MaterialApp(
        home: ListenableBuilder(
          listenable: notifier,
          builder: (context, _) => Column(
            children: [
              TextButton(
                onPressed: () => showLayoutPalette(context, notifier),
                child: const Text('open'),
              ),
              Expanded(child: PaneGrid(notifier: notifier)),
            ],
          ),
        ),
      ),
    );
    await tester.pump();

    double columnsOnScreen() {
      final grid = tester.getRect(find.byType(PaneGrid));
      final tile = tester.getRect(find.byKey(notifier.panes[0].cellKey));
      return (grid.width / tile.width).roundToDouble();
    }

    // Explicit pumps, not pumpAndSettle: a tile that has not attached yet spins
    // forever, so "settle" never arrives and the wait says nothing about the
    // layout.
    await tester.tap(find.text('open'));
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(find.text('3 columns'));
    await tester.pump(const Duration(milliseconds: 300));

    expect(notifier.presetFor(6), PanePreset.cols3);
    expect(columnsOnScreen(), 3, reason: 'the grid followed the pick');
  });

  testWidgets('an arrow moves the cursor and changes nothing yet', (
    tester,
  ) async {
    final notifier = await _open(tester);
    final before = notifier.presetFor(3);

    await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
    await tester.pump();

    expect(notifier.presetFor(3), before, reason: 'moving is not choosing');
    expect(find.byType(Dialog), findsOneWidget, reason: 'still open');
  });

  testWidgets('Enter takes the shape the arrows landed on', (tester) async {
    final notifier = await _open(tester);
    final choices = PanePreset.forCount(3);

    await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();

    expect(notifier.presetFor(3), choices[1]);
    expect(find.byType(Dialog), findsNothing, reason: 'picking closes it');
  });

  testWidgets('the cursor starts on the shape already in use', (tester) async {
    // So the first arrow press steps off the current shape rather than jumping
    // to the top of the list.
    final choices = PanePreset.forCount(3);
    final notifier = await _open(tester, preset: choices[2]);

    await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(notifier.presetFor(3), choices[1]);
  });

  testWidgets('the cursor stops at the ends rather than wrapping round', (
    tester,
  ) async {
    final notifier = await _open(tester);
    final choices = PanePreset.forCount(3);

    for (var i = 0; i < choices.length + 3; i++) {
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
    }
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();

    expect(notifier.presetFor(3), choices.last);
  });

  testWidgets('a digit picks straight away, without the arrows', (
    tester,
  ) async {
    final notifier = await _open(tester);
    final choices = PanePreset.forCount(3);

    await tester.sendKeyEvent(LogicalKeyboardKey.digit3);
    await tester.pumpAndSettle();

    expect(notifier.presetFor(3), choices[2]);
    expect(find.byType(Dialog), findsNothing);
  });

  testWidgets('a digit with no shape behind it does nothing', (tester) async {
    // Three tiles offer four shapes, so 5 names none of them. Closing on it
    // would throw away the choice someone was in the middle of making.
    final notifier = await _open(tester);
    final before = notifier.presetFor(3);

    await tester.sendKeyEvent(LogicalKeyboardKey.digit5);
    await tester.pumpAndSettle();

    expect(notifier.presetFor(3), before);
    expect(find.byType(Dialog), findsOneWidget);
  });

  testWidgets('a big grid offers the column counts, and they are pickable', (
    tester,
  ) async {
    final notifier = await _open(tester, panes: 6);
    final choices = PanePreset.forCount(6);
    expect(choices.first, PanePreset.auto);

    // RIGHT, not down. Down used to be a second spelling of "one along"; it
    // moves a ROW now, which is what the arrow on the cap says.
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();

    expect(notifier.presetFor(6), choices[1]);
    expect(notifier.presetFor(6)!.statedColumns, isNotNull);
  });

  testWidgets('down moves a ROW of the strip, not one along it', (
    tester,
  ) async {
    // Six shapes wrap to four over two, so down from the first lands on the
    // fifth — the one drawn underneath it. Reported from the desk: it used to
    // walk sideways, which is worse than a key that waits.
    final notifier = await _open(tester, panes: 6);
    final choices = PanePreset.forCount(6);

    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();

    expect(notifier.presetFor(6), choices[4]);
  });

  testWidgets('the strip comes round at both ends', (tester) async {
    final notifier = await _open(tester, panes: 3);
    final choices = PanePreset.forCount(3);

    // Left from the first shape appears at the last.
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();

    expect(notifier.presetFor(3), choices.last);
  });
}
