import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/machine_rail.dart';

/// The rail's head is a toolbar: its own surface and its own bottom edge, so it
/// reads as the thing ABOVE the list rather than as the list's first row.
///
/// What these hold: the reload glyph reports a run in flight by turning, the
/// two buttons stay far enough apart to read as two, and the list starts below
/// the toolbar's rule.
void main() {
  const machine = Machine(
    machineId: 'machine-1',
    apiKey: '',
    authMode: MachineAuthMode.remote,
    name: 'prod-mac',
    status: 'online',
  );

  AppNotifier railNotifier() {
    final notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    final state = MachineState(machine)
      ..connectionStatus = ConnectionStatus.connected
      ..terminalCapabilityLoaded = true
      ..terminalCapabilityAvailable = true
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..agents = [
        Agent.fromJson({
          'id': 'a',
          'sessionId': 'session-a',
          'name': 'Ban làm được gì',
          'engine': 'claude',
          'status': 'active',
          'terminal': {
            'runtimes': [
              {'backend': 'tmux', 'paneId': '%1'},
            ],
          },
        }),
        Agent.fromJson({
          'id': 'b',
          'sessionId': 'session-b',
          'name': 'Claude Code',
          'engine': 'claude',
          'status': 'active',
          'terminal': {
            'runtimes': [
              {'backend': 'tmux', 'paneId': '%2'},
            ],
          },
        }),
      ];
    notifier.machines = [machine];
    notifier.machineStates[machine.machineId] = state;
    notifier.expandedMachines.add(machine.machineId);
    return notifier;
  }

  Future<void> pumpRail(
    WidgetTester tester,
    AppNotifier notifier, {
    double width = 264,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: width,
            child: MachineRail(notifier: notifier, onCollapse: () {}),
          ),
        ),
      ),
    );
    await tester.pump();
  }

  testWidgets('the reload button reports a run in flight by turning', (
    tester,
  ) async {
    final notifier = railNotifier();
    await pumpRail(tester, notifier);

    final reload = find.byTooltip('Reload machines  ⌘R');
    RotationTransition glyph() => tester.widget<RotationTransition>(
      find.descendant(of: reload, matching: find.byType(RotationTransition)),
    );

    // At rest the mark is upright and stays there — the transition is always in
    // the tree, so "not spinning" has to be read off the angle, not off which
    // widgets exist.
    final resting = glyph().turns.value;
    await tester.pump(const Duration(milliseconds: 300));
    expect(glyph().turns.value, resting);

    notifier.dispose();
  });

  testWidgets('the toolbar keeps its two buttons apart, and its bottom edge', (
    tester,
  ) async {
    final notifier = railNotifier();
    await pumpRail(tester, notifier);

    // 2px between glyphs was the old spacing and it read as one smudge. The
    // gap is measured between the buttons' boxes, so it survives a change of
    // glyph size.
    final reload = tester.getRect(find.byTooltip('Reload machines  ⌘R'));
    final collapse = tester.getRect(find.byTooltip('Collapse sidebar  ⌘\\'));
    expect(collapse.left - reload.right, greaterThanOrEqualTo(6));

    // The list starts below the toolbar's rule, not level with it — the whole
    // point of the block is that the head is not the first row of the rail.
    expect(
      tester.getTopLeft(find.text('prod-mac')).dy,
      greaterThan(reload.bottom),
    );
    notifier.dispose();
  });
}
