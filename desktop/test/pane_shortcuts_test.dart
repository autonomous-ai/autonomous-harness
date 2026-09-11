// ⌘1…⌘9 and ⌘← / ⌘→ address the GRID.
//
// They used to address the sidebar: ⌘3 opened the third agent in the rail and
// replaced a tile to show it, so a key meant for "look at the third one" could
// rearrange the desk. The number on screen, the number the dial walks and the
// number under the key are one thing now.
import 'package:flutter_test/flutter_test.dart';

import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_preset.dart';
import 'package:harness/state/terminal_pane.dart';

/// Three tiles, in an order that is NOT the sidebar's — which is the point.
AppNotifier _withGrid() {
  final notifier = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
  );
  for (final id in ['a4', 'a2', 'a5']) {
    notifier.panes.add(
      TerminalPane(id: notifier.panes.length, machineId: 'm1', agentId: id),
    );
  }
  notifier.focusedPaneId = notifier.panes.first.id;
  return notifier;
}

List<String?> _grid(AppNotifier app) => [for (final p in app.panes) p.agentId];

void main() {
  test('a digit focuses the tile at that position', () {
    final app = _withGrid();

    app.focusPaneByIndex(1);
    expect(app.focusedPane?.agentId, 'a2');

    app.focusPaneByIndex(2);
    expect(app.focusedPane?.agentId, 'a5');

    // Looking never rearranges.
    expect(_grid(app), ['a4', 'a2', 'a5']);
    app.dispose();
  });

  test('a digit past the last tile does nothing at all', () {
    // Three tiles, so ⌘4 names none. It must not open the fourth AGENT — that
    // was the old behaviour, and it rearranged the desk to obey a key meant
    // only to look.
    final app = _withGrid();
    final before = app.focusedPane?.agentId;

    app.focusPaneByIndex(3);
    app.focusPaneByIndex(-1);

    expect(app.focusedPane?.agentId, before);
    expect(app.panes.length, 3);
    expect(_grid(app), ['a4', 'a2', 'a5']);
    app.dispose();
  });

  test('the arrows walk the tiles, and wrap', () {
    final app = _withGrid();
    expect(app.focusedPane?.agentId, 'a4');

    app.focusPaneBy(1);
    expect(app.focusedPane?.agentId, 'a2');
    app.focusPaneBy(1);
    expect(app.focusedPane?.agentId, 'a5');
    // Round the end: the grid reads as a loop of tiles, and a key that stops
    // dead at the last one reads as broken.
    app.focusPaneBy(1);
    expect(app.focusedPane?.agentId, 'a4');
    app.focusPaneBy(-1);
    expect(app.focusedPane?.agentId, 'a5');

    expect(_grid(app), ['a4', 'a2', 'a5'], reason: 'walking moves nothing');
    app.dispose();
  });

  // ── up and down ─────────────────────────────────────────────────────────────
  //
  // Spatial, unlike left and right: reported from the dial's own desk — "I am on
  // 1, pressing down to get to 3 does nothing" — where 1 and 3 are the left
  // column of a 2×2 and no ORDER makes 3 the one after 1.
  AppNotifier withPanes(int n) {
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    for (var i = 0; i < n; i++) {
      app.panes.add(TerminalPane(id: i, machineId: 'm1', agentId: 'a$i'));
    }
    app.focusedPaneId = 0;
    return app;
  }

  test('down from the top-left of a 2x2 is the tile UNDER it', () {
    final app = withPanes(4);
    expect(app.presetFor(4), PanePreset.quad);

    app.focusPaneVertically(1);
    expect(app.focusedPane?.agentId, 'a2', reason: 'tile 3 of the grid');

    app.focusPaneVertically(-1);
    expect(app.focusedPane?.agentId, 'a0');
    app.dispose();
  });

  test('down from the top-RIGHT lands under it, not on the row start', () {
    final app = withPanes(4);
    app.focusPaneByIndex(1);

    app.focusPaneVertically(1);
    expect(app.focusedPane?.agentId, 'a3', reason: 'tile 4, directly below');
    app.dispose();
  });

  test('the edge of the grid is where it COMES ROUND', () {
    // It used to stop, on the reasoning that an arrow jumping to the far side of
    // the screen reads as a jump rather than a step. Reversed on the owner's
    // call, and the argument against it turned out to be the stronger one: a key
    // that steps in the middle of the grid and does NOTHING at its edge is a key
    // people stop trusting, and the dead press is indistinguishable from the app
    // having missed the keystroke.
    //
    // It wraps IN COLUMN, which is what keeps it from reading as a jump: the
    // tile it lands on is the one directly above or below, as far as that goes.
    final app = withPanes(4);
    app.focusPaneVertically(-1);
    expect(
      app.focusedPane?.agentId,
      'a2',
      reason: 'up from the top of a column comes back to its bottom',
    );

    app.focusPaneByIndex(2);
    app.focusPaneVertically(1);
    expect(
      app.focusedPane?.agentId,
      'a0',
      reason: 'down from the bottom comes back to the top of the same column',
    );
    app.dispose();
  });

  test('a single row has nothing above or below', () {
    final app = withPanes(2)..setPreset(2, PanePreset.columns);
    app.focusPaneVertically(1);
    expect(app.focusedPane?.agentId, 'a0');
    app.dispose();
  });

  test('a spanning tile is reachable from either tile above it', () {
    // Three tiles: two over one, and the bottom one spans the width. Down from
    // EITHER of the top two lands on it.
    final app = withPanes(3)..setPreset(3, PanePreset.twoOverOne);
    app.focusPaneVertically(1);
    expect(app.focusedPane?.agentId, 'a2');

    app.focusPaneByIndex(1);
    app.focusPaneVertically(1);
    expect(app.focusedPane?.agentId, 'a2');
    app.dispose();
  });

  test('a big grid steps one row, using the columns the grid reports', () {
    // `auto` measures the window, so the grid tells the state what it laid out.
    // Six tiles in three columns: down from the first is the fourth.
    final app = withPanes(6)..gridColumns = 3;
    app.focusPaneVertically(1);
    expect(app.focusedPane?.agentId, 'a3');
    app.dispose();
  });

  test('one tile has nowhere to walk to', () {
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    app.panes.add(TerminalPane(id: 1, machineId: 'm1', agentId: 'only'));
    app.focusedPaneId = 1;

    app.focusPaneBy(1);
    expect(app.focusedPane?.agentId, 'only');
    app.dispose();
  });
}
