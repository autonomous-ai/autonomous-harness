// Moving between panes is a RING, and the rail is a seat in it.
//
// The two rules this pins, both asked for by name: walking off an edge comes
// round rather than stopping dead, and the sidebar is one of the places the ring
// passes through — not a wall at one end of it. A key that means "go left" in
// the middle of a grid and "do nothing" at its edge is a key people stop
// trusting, which is the whole reason for the change.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_preset.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/terminal_pane.dart';

const _machine = Machine(
  machineId: 'm',
  apiKey: '',
  authMode: MachineAuthMode.remote,
  name: 'prod-mac',
  status: 'online',
);

/// A grid, and a rail with something in it.
///
/// The machine matters: an EMPTY rail is deliberately not a seat — the ring
/// skips it rather than stopping on a cursor nobody can see — so a helper
/// without one would test the fallback and call it the feature.
AppNotifier _grid(int n, {PanePreset? preset, bool withMachine = true}) {
  final notifier = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
  );
  if (withMachine) {
    notifier.machines = [_machine];
    notifier.machineStates[_machine.machineId] = MachineState(_machine);
  }
  for (var i = 0; i < n; i++) {
    notifier.panes.add(TerminalPane(id: i, machineId: 'm', agentId: 'a$i'));
  }
  if (preset != null) notifier.setPreset(n, preset);
  notifier.focusedPaneId = 0;
  return notifier;
}

void main() {
  group('the ring closes', () {
    test('off the RIGHT edge seats you in the rail', () {
      final n = _grid(2, preset: PanePreset.columns);
      n.focusedPaneId = 1; // the right-hand tile
      n.focusPaneHorizontally(1);
      expect(n.railFocused, isTrue);
    });

    test('off the LEFT edge seats you in the rail too', () {
      // Both edges, not just the one the sidebar is drawn on: the ring has two
      // ends and the rail is the single seat between them.
      final n = _grid(2, preset: PanePreset.columns);
      n.focusedPaneId = 0;
      n.focusPaneHorizontally(-1);
      expect(n.railFocused, isTrue);
    });

    test('out of the rail, left lands on the LAST tile', () {
      final n = _grid(3);
      n.focusRail();
      n.focusPaneHorizontally(-1);
      expect(n.railFocused, isFalse);
      expect(n.focusedPaneId, 2);
    });

    test('out of the rail, right lands on the FIRST tile', () {
      final n = _grid(3);
      n.focusRail();
      n.focusPaneHorizontally(1);
      expect(n.railFocused, isFalse);
      expect(n.focusedPaneId, 0);
    });

    test('a full lap comes home', () {
      // Two tiles and a rail is a ring of three. Three presses of the same key
      // must end where they started, or it is not a ring.
      final n = _grid(2, preset: PanePreset.columns);
      final from = n.focusedPaneId;
      for (var i = 0; i < 3; i++) {
        n.focusPaneHorizontally(1);
      }
      expect(n.railFocused, isFalse);
      expect(n.focusedPaneId, from);
    });

    test('one tile and a rail still turns', () {
      // The degenerate ring: nothing to step between on the grid, so the rail is
      // the only other seat and the key must still do something.
      final n = _grid(1);
      n.focusPaneHorizontally(1);
      expect(n.railFocused, isTrue);
      n.focusPaneHorizontally(1);
      expect(n.railFocused, isFalse);
      expect(n.focusedPaneId, 0);
    });

    test('with no tiles at all, leaving the rail does nothing', () {
      final n = _grid(0);
      n.railFocused = true;
      n.focusPaneHorizontally(1);
      expect(n.railFocused, isTrue);
    });

    test('an EMPTY rail is skipped, not stopped on', () {
      // focusRail refuses when there is nothing to put a cursor on — no machines
      // yet, or a list still loading. The ring has to carry on past it, or the
      // key does nothing at the edge, which is what the ring exists to remove.
      final n = _grid(2, preset: PanePreset.columns, withMachine: false);
      n.focusedPaneId = 1;
      n.focusPaneHorizontally(1);
      expect(n.railFocused, isFalse);
      expect(n.focusedPaneId, 0, reason: 'straight round to the first tile');
    });
  });

  group('up and down wrap IN COLUMN', () {
    test('down off the bottom comes back to the top of the same column', () {
      // Not to panes.first. From the bottom-right of a 2x2 that would change the
      // column as well as the row, which reads as a mis-key rather than as
      // having come round.
      final n = _grid(4, preset: PanePreset.quad);
      n.focusedPaneId = 2; // bottom-left
      n.focusPaneVertically(1);
      expect(n.focusedPaneId, 0); // top-left, same column
    });

    test('up off the top comes back to the bottom of the same column', () {
      final n = _grid(4, preset: PanePreset.quad);
      n.focusedPaneId = 1; // top-right
      n.focusPaneVertically(-1);
      expect(n.focusedPaneId, 3); // bottom-right
    });

    test('a single row has nowhere to wrap to, and says so by not moving', () {
      final n = _grid(2, preset: PanePreset.columns);
      n.focusedPaneId = 0;
      n.focusPaneVertically(1);
      expect(n.focusedPaneId, 0);
    });

    test('the rail is not in the VERTICAL ring', () {
      // It sits beside the grid, not above or below it. Wrapping into it on ⌘j
      // would be a seat the direction does not point at.
      final n = _grid(2, preset: PanePreset.rows);
      n.focusedPaneId = 1;
      n.focusPaneVertically(1);
      expect(n.railFocused, isFalse);
    });
  });
}
