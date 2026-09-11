// Pinning a tile to its slot.
//
// The thing it protects against is small and real: close one tile of four and
// every tile after it slides up a slot, so an agent someone was reading moves
// somewhere else because of an action aimed at something else entirely.
import 'dart:async';

import 'package:flutter_test/flutter_test.dart';

import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/terminal_pane.dart';

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

List<String> _order(AppNotifier n) => [for (final p in n.panes) p.agentId!];

void main() {
  test('pinning records the slot the tile is already in', () {
    final notifier = _withPanes(4);
    notifier.togglePinPane(2);
    expect(notifier.panes[2].pinnedSlot, 2);
    expect(notifier.panes[2].isPinned, isTrue);

    notifier.togglePinPane(2);
    expect(notifier.panes[2].pinnedSlot, isNull);
  });

  test('a pinned tile keeps its slot when an earlier tile closes', () async {
    // The whole feature in one assertion: a2 was pinned to the third slot, and
    // closing a1 must not move it there — a3 fills the hole instead.
    final notifier = _withPanes(4);
    notifier.togglePinPane(2);
    await notifier.closePane(1);
    expect(_order(notifier), ['a0', 'a3', 'a2']);
  });

  test('an unpinned grid slides up, which is why the pin exists', () async {
    final notifier = _withPanes(4);
    await notifier.closePane(1);
    expect(_order(notifier), ['a0', 'a2', 'a3']);
  });

  test('with two pins, the one the smaller grid can still honour wins', () {
    // Closing a tile takes a slot away with it, so two pins on the last two
    // slots of four cannot both be met by a grid of three — the arithmetic
    // decides that, not a policy. What is guaranteed is that a pin the grid
    // CAN honour is honoured, and the tile whose slot no longer exists takes
    // what is left rather than dragging the other one out of place.
    final notifier = _withPanes(4)
      ..togglePinPane(2)
      ..togglePinPane(3);
    unawaited(notifier.closePane(0));
    expect(_order(notifier), ['a1', 'a3', 'a2']);
    expect(notifier.panes.last.agentId, 'a2', reason: 'slot 2, as pinned');
    expect(notifier.panes[1].pinnedSlot, 3, reason: 'a3 still wants slot 3');
  });

  test('a pin past the end of a shrunken grid is held, not forgotten', () async {
    // The tiles that closed can come back. Dropping the pin the moment the grid
    // got small would quietly undo a choice nobody revisited.
    final notifier = _withPanes(3);
    notifier.togglePinPane(2);
    await notifier.closePane(0);
    expect(notifier.panes.length, 2);
    expect(notifier.panes.last.pinnedSlot, 2, reason: 'still remembered');
  });

  test('a drag takes the pin with it rather than bouncing back', () {
    // A pin binds automatic movement. Dragging is the same person answering the
    // same question again, so the answer is updated, not refused — a tile that
    // sprang back would look like a broken drag, not an enforced rule.
    final notifier = _withPanes(4);
    notifier.togglePinPane(1);
    notifier.reorderPane(1, 3);
    expect(_order(notifier), ['a0', 'a3', 'a2', 'a1']);
    expect(notifier.panes[3].pinnedSlot, 3);
    expect(notifier.panes[3].agentId, 'a1');
  });

  test('a tile displaced BY a drag keeps a pin on where it landed', () {
    final notifier = _withPanes(4);
    notifier.togglePinPane(3);
    notifier.reorderPane(1, 3);
    expect(notifier.panes[1].agentId, 'a3');
    expect(notifier.panes[1].pinnedSlot, 1);
  });

  _reach();

  test('the pin survives a restart', () {
    // It rides in the tile's own saved entry, and an entry from a build that
    // did not have pins simply has none.
    const entry = PaneLayoutEntry(machineId: 'm', agentId: 'a', pinnedSlot: 2);
    expect(PaneLayoutEntry.fromJson(entry.toJson())?.pinnedSlot, 2);

    const plain = PaneLayoutEntry(machineId: 'm', agentId: 'a');
    expect(plain.toJson().containsKey('pinnedSlot'), isFalse);
    expect(PaneLayoutEntry.fromJson(plain.toJson())?.pinnedSlot, isNull);

    // A hand-edited or downgraded file must not be able to invent a slot.
    expect(
      PaneLayoutEntry.fromJson({
        'machineId': 'm',
        'agentId': 'a',
        'pinnedSlot': -3,
      })?.pinnedSlot,
      isNull,
    );
    expect(
      PaneLayoutEntry.fromJson({
        'machineId': 'm',
        'agentId': 'a',
        'pinnedSlot': 'second',
      })?.pinnedSlot,
      isNull,
    );
  });
}

// Reaching the raised ceiling.
//
// The cap moved from four to nine, but for a while the ONLY way to add a tile
// was dragging a rail row onto the grid — so the extra five slots existed and
// nobody could get to them. These hold the state layer to the new ceiling.
void _reach() {
  test('the grid grows past four, up to the ceiling', () {
    final notifier = _withPanes(4);
    expect(notifier.canAddPane, isTrue, reason: 'four is no longer full');

    final full = _withPanes(AppNotifier.maxPanes);
    expect(full.canAddPane, isFalse);
  });
}
