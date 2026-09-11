// The shape you pick is the shape you get.
//
// Every preset carries a list of unit rectangles (`PanePreset.tiles`). The
// palette PAINTS that list, so if the grid ever laid tiles out somewhere else,
// the picker would be advertising a shape the app does not build — and the only
// symptom would be a person picking the wrong one. So these tests measure the
// real laid-out tiles and hold them against the same list.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_preset.dart';
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

/// Where each tile actually landed, as fractions of the grid.
Future<List<Rect>> _layout(WidgetTester tester, AppNotifier notifier) async {
  // Tall enough that no shape here hits the scroll fallback. Two columns of
  // nine tiles is five rows, and a window without the height for five rows at
  // the terminal floor SCROLLS rather than squeezing — correct behaviour, and
  // covered in pane_lattice_test, but it puts tiles outside the grid box and
  // there are no fractions of a visible grid left to measure.
  await tester.binding.setSurfaceSize(const Size(1600, 1500));
  await tester.pumpWidget(MaterialApp(home: PaneGrid(notifier: notifier)));
  await tester.pump();
  final grid = tester.getRect(find.byType(PaneGrid));
  return [
    for (final pane in notifier.panes)
      () {
        final r = tester.getRect(find.byKey(pane.cellKey));
        return Rect.fromLTRB(
          (r.left - grid.left) / grid.width,
          (r.top - grid.top) / grid.height,
          (r.right - grid.left) / grid.width,
          (r.bottom - grid.top) / grid.height,
        );
      }(),
  ];
}

/// Dividers eat a few pixels, so an edge lands near its fraction, not on it.
/// 0.02 of 1600px is 32px — wide enough for any divider, far too narrow to let
/// a half pass as a third.
void _expectShape(List<Rect> actual, List<Rect> want) {
  expect(actual.length, want.length);
  for (var i = 0; i < want.length; i++) {
    expect(actual[i].left, closeTo(want[i].left, 0.02), reason: 'tile $i left');
    expect(actual[i].top, closeTo(want[i].top, 0.02), reason: 'tile $i top');
    expect(
      actual[i].right,
      closeTo(want[i].right, 0.02),
      reason: 'tile $i right',
    );
    expect(
      actual[i].bottom,
      closeTo(want[i].bottom, 0.02),
      reason: 'tile $i bottom',
    );
  }
}

void main() {
  for (final count in [2, 3, 4, 5, 6, 7, 9]) {
    for (final preset in PanePreset.forCount(count)) {
      // `auto` measures the window, so its diagram is openly approximate and
      // there is nothing to hold it to — every other shape states its answer
      // and must lay out exactly that way.
      if (preset == PanePreset.auto) continue;
      testWidgets('$count tiles · ${preset.id} is laid out as it is drawn', (
        tester,
      ) async {
        final notifier = _withPanes(count);
        notifier.setPreset(count, preset);
        _expectShape(await _layout(tester, notifier), preset.tilesFor(count));
      });
    }
  }

  test('every size but one tile has something to choose', () {
    // The first cut offered nothing above four, on the theory that the window
    // decides. The window decides how many columns FIT; it does not decide how
    // many someone wants.
    expect(PanePreset.forCount(1), isEmpty);
    for (var n = 2; n <= 9; n++) {
      expect(PanePreset.forCount(n).length, greaterThan(1), reason: '$n tiles');
    }
  });

  testWidgets('five tiles: a full-height middle, two stacked either side', (
    tester,
  ) async {
    // Drawn on paper and handed over: three columns, the middle one whole, the
    // outer two split. The numbers in that drawing are the tile order — 1 and 4
    // down the left, 2 in the middle, 3 and 5 down the right — so a person
    // reading across the top gets 1, 2, 3.
    final notifier = _withPanes(5);
    notifier.setPreset(5, PanePreset.middleMain);
    final shape = await _layout(tester, notifier);

    expect(shape[0].right, closeTo(1 / 3, 0.02), reason: 'tile 1: left column');
    expect(shape[0].bottom, closeTo(1 / 2, 0.02), reason: 'tile 1: top half');
    expect(
      shape[1].top,
      closeTo(0, 0.02),
      reason: 'tile 2 runs the full height',
    );
    expect(shape[1].bottom, closeTo(1, 0.02));
    expect(shape[2].left, closeTo(2 / 3, 0.02), reason: 'tile 3: right column');
    expect(
      shape[3].top,
      closeTo(1 / 2, 0.02),
      reason: 'tile 4 is under tile 1',
    );
    expect(
      shape[4].left,
      closeTo(2 / 3, 0.02),
      reason: 'tile 5 is under tile 3',
    );
    expect(shape[4].bottom, closeTo(1, 0.02));
  });

  test('a big grid offers auto first, then column counts that fit', () {
    expect(PanePreset.forCount(5).first, PanePreset.auto);
    for (var count = 5; count <= 9; count++) {
      for (final preset in PanePreset.forCount(count).skip(1)) {
        final columns = preset.statedColumns;
        // A shape that is not a lattice carries its own rectangles instead —
        // `middleMain` is a full-height column with two stacked either side, and
        // no column count describes that.
        if (columns == null) {
          expect(preset.tilesFor(count).length, count, reason: preset.id);
          continue;
        }
        // More columns than tiles is the same grid with empty air in it.
        expect(columns <= count, isTrue, reason: '$columns cols, $count tiles');
      }
    }
  });

  test(
    'the lattice drawn is the lattice built, row-major with a short last row',
    () {
      // Seven tiles in three columns is three rows, the last holding one.
      final tiles = PanePreset.cols3.tilesFor(7);
      expect(tiles.length, 7);
      expect(tiles.first, const Rect.fromLTRB(0, 0, 1 / 3, 1 / 3));
      expect(tiles[3].top, closeTo(1 / 3, 1e-9), reason: 'second row starts');
      expect(tiles.last.left, closeTo(0, 1e-9), reason: 'last row starts left');
    },
  );

  test('an id written by the build that named columns by hand still opens', () {
    // Saved layouts from before the column count was general must not silently
    // fall back to the default shape.
    expect(PanePreset.byId('threeColumns'), PanePreset.cols3);
    expect(PanePreset.byId('fourColumns'), PanePreset.cols4);
  });

  test('every offered preset describes exactly that many tiles', () {
    for (var count = 2; count <= 9; count++) {
      for (final preset in PanePreset.forCount(count)) {
        expect(preset.tilesFor(count).length, count, reason: preset.id);
      }
    }
  });

  test('ids are what persist, and they are not the enum order', () {
    // Reordering the enum must not silently repoint saved layouts at a
    // different shape, so the id is the NAME. Round-trip proves it.
    for (final preset in PanePreset.values) {
      expect(PanePreset.byId(preset.id), preset);
    }
    expect(PanePreset.byId('a shape from a newer release'), isNull);
    expect(PanePreset.byId(null), isNull);
  });

  testWidgets('two tiles are separated by exactly one gap', (tester) async {
    // Measured against [kPaneGap] rather than against a number typed here:
    // these three tests asserted a 1px line for a release after the grid
    // stopped drawing one, which is what a test holding its own copy of a
    // design value always eventually does.
    final notifier = _withPanes(2);
    notifier.setPreset(2, PanePreset.columns);
    await _layout(tester, notifier);

    final left = tester.getRect(find.byKey(notifier.panes[0].cellKey));
    final right = tester.getRect(find.byKey(notifier.panes[1].cellKey));
    expect(right.left - left.right, closeTo(kPaneGap, 0.01));
  });

  testWidgets('and so are two rows', (tester) async {
    final notifier = _withPanes(2);
    notifier.setPreset(2, PanePreset.rows);
    await _layout(tester, notifier);

    final top = tester.getRect(find.byKey(notifier.panes[0].cellKey));
    final bottom = tester.getRect(find.byKey(notifier.panes[1].cellKey));
    expect(bottom.top - top.bottom, closeTo(kPaneGap, 0.01));
  });

  testWidgets('a big grid keeps the same single gap', (tester) async {
    // One gap between neighbours whichever way you cross it, and the same one
    // a two-tile grid uses — the lattice must not double it where a row and a
    // column meet.
    final notifier = _withPanes(6);
    notifier.setPreset(6, PanePreset.cols3);
    await _layout(tester, notifier);

    final first = tester.getRect(find.byKey(notifier.panes[0].cellKey));
    final second = tester.getRect(find.byKey(notifier.panes[1].cellKey));
    final below = tester.getRect(find.byKey(notifier.panes[3].cellKey));
    expect(
      second.left - first.right,
      closeTo(kPaneGap, 0.01),
      reason: 'column gap',
    );
    expect(
      below.top - first.bottom,
      closeTo(kPaneGap, 0.01),
      reason: 'row gap',
    );
  });

  testWidgets('no boundary offers a resize cursor', (tester) async {
    // Dragging is gone, and the surest sign it is really gone is that nothing
    // on screen still invites it.
    final notifier = _withPanes(4);
    await _layout(tester, notifier);

    final resizable = find.byWidgetPredicate(
      (w) =>
          w is MouseRegion &&
          (w.cursor == SystemMouseCursors.resizeColumn ||
              w.cursor == SystemMouseCursors.resizeRow),
    );
    expect(resizable, findsNothing);
  });
}
