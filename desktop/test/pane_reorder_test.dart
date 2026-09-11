// Reordering is a swap in one list, so these test the list — the geometry and the
// persistence both follow from it (PaneGrid lays panes out row-major, and the
// layout store is an ordered array).
import 'package:flutter_test/flutter_test.dart';

import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/terminal_pane.dart';

/// `configStore: null` and `paneLayoutStore` left off, so nothing here writes to
/// the real ~/.harness state the way a running app would.
AppNotifier notifierWithPanes(int count) {
  final notifier = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
  );

  for (var i = 0; i < count; i++) {
    notifier.panes.add(TerminalPane(id: i, machineId: 'm', agentId: 'a$i'));
  }
  return notifier;
}

List<String?> order(AppNotifier n) => [for (final p in n.panes) p.agentId];

void main() {
  test('swaps the two panes and leaves every other one where it was', () {
    final n = notifierWithPanes(4);
    n.reorderPane(0, 2);
    expect(order(n), ['a2', 'a1', 'a0', 'a3']);
  });

  test('focus follows the pane, not the slot', () {
    final n = notifierWithPanes(3);
    n.focusPane(0);
    n.reorderPane(0, 2);
    expect(n.focusedPaneId, 0, reason: 'the dragged tile stays focused');
    expect(n.panes[2].id, 0, reason: '…and it is the one that moved');
  });

  test('a pane id that is not on the grid changes nothing', () {
    final n = notifierWithPanes(2);
    n.reorderPane(0, 99);
    expect(order(n), ['a0', 'a1']);
  });

  test('dropping a pane on itself changes nothing', () {
    final n = notifierWithPanes(2);
    n.reorderPane(1, 1);
    expect(order(n), ['a0', 'a1']);
  });

  test('the keyboard move stops at the ends instead of wrapping', () {
    // A grid is a shape, not a ring: a tile jumping from the last slot to the
    // first reads as a bug, not as a move.
    final n = notifierWithPanes(3);
    n.focusPane(0);
    n.movePaneBy(-1);
    expect(order(n), ['a0', 'a1', 'a2'], reason: 'already first');
    n.focusPane(2);
    n.movePaneBy(1);
    expect(order(n), ['a0', 'a1', 'a2'], reason: 'already last');
  });

  test('the keyboard move walks one slot at a time', () {
    final n = notifierWithPanes(3);
    n.focusPane(2);
    n.movePaneBy(-1);
    expect(order(n), ['a0', 'a2', 'a1']);
    n.movePaneBy(-1);
    expect(order(n), ['a2', 'a0', 'a1']);
  });
}
