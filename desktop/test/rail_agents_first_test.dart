import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/layouts/widgets/sidebar_item.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/machine_rail.dart';

/// The rail leads with the agents; a machine is the caption over them.
///
/// These guard what that redesign turned on: every action on a machine sits on
/// that machine's own row and stays out of the way until you point at it, and
/// the two numbers the guide line is built from — the trunk at 19 and the rows
/// at 28 — stay in step with each other.
void main() {
  const machine = Machine(
    machineId: 'machine-1',
    apiKey: '',
    authMode: MachineAuthMode.remote,
    name: 'prod-mac',
    status: 'online',
  );

  Agent agent(String id, String name, String engine) => Agent.fromJson({
    'id': id,
    'sessionId': 'session-$id',
    'name': name,
    'engine': engine,
    'status': 'active',
    'terminal': {
      'runtimes': [
        {'backend': 'tmux', 'paneId': '%1'},
      ],
    },
  });

  AppNotifier railNotifier({bool expanded = true}) {
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
        agent('a', 'Ban làm được gì', 'claude'),
        agent('b', '9989 · Folder10', 'codex'),
        agent('c', 'Claude Code', 'claude'),
      ];
    notifier.machines = [machine];
    notifier.machineStates[machine.machineId] = state;
    if (expanded) notifier.expandedMachines.add(machine.machineId);
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
            child: MachineRail(notifier: notifier),
          ),
        ),
      ),
    );
    await tester.pump();
  }

  testWidgets('the rail lays out at every width it can be dragged to', (
    tester,
  ) async {
    // 220 is the rail's floor and 520 its ceiling (see home_screen.dart). A
    // RenderFlex overflow at either end fails this test on its own — which is
    // the point of pumping both rather than only the default.
    for (final width in [220.0, 264.0, 520.0]) {
      final notifier = railNotifier();
      await pumpRail(tester, notifier, width: width);

      expect(
        find.text('prod-mac'),
        findsOneWidget,
        reason: 'the rail did not render at ${width}px',
      );
      expect(find.text('Ban làm được gì'), findsOneWidget);
      notifier.dispose();
    }
  });

  testWidgets('a machine hides ⋯ and + until you point at its row', (
    tester,
  ) async {
    final notifier = railNotifier();
    await pumpRail(tester, notifier);

    // Folded, not merely faded: the pair is clipped to zero width, so the
    // hostname has the whole row and nothing invisible sits there to be clicked
    // by accident. Measured on the clip box, not on a button — each button
    // keeps its own 24px inside it either way.
    final menu = find.byTooltip('Machine options');
    final plus = find.byTooltip('New agent here…');
    expect(menu, findsOneWidget);
    expect(plus, findsOneWidget);
    Size actionsBox() => tester.getSize(
      find.ancestor(of: plus, matching: find.byType(ClipRect)).first,
    );
    expect(actionsBox().width, 0);

    final gesture = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await gesture.addPointer(location: Offset.zero);
    addTearDown(gesture.removePointer);
    await gesture.moveTo(tester.getCenter(find.text('prod-mac')));
    await tester.pumpAndSettle();

    // Opened out, both on the machine's own row, with + at the far end —
    // nearest the rail's edge, where the hand is already going.
    expect(actionsBox().width, greaterThan(40));
    expect(
      tester.getCenter(plus).dx,
      greaterThan(tester.getCenter(menu).dx),
      reason: 'the + sits to the right of the ⋯',
    );
    notifier.dispose();
  });

  testWidgets('an agent row starts where the guide line reaches for it', (
    tester,
  ) async {
    final notifier = railNotifier();
    await pumpRail(tester, notifier);

    // 28px, and it is not a free number: SidebarTimeline runs its trunk at 19
    // and reaches 7px out of it, so a row starting anywhere else leaves the arm
    // pointing at a gap. Moving one without the other is the bug this catches.
    final row = find
        .ancestor(
          of: find.text('9989 · Folder10'),
          matching: find.byType(SidebarItem),
        )
        .first;
    expect(tester.getTopLeft(row).dx, 28);
    notifier.dispose();
  });

  testWidgets('the machine mark sits on the trunk the agents hang off', (
    tester,
  ) async {
    final notifier = railNotifier();
    await pumpRail(tester, notifier);

    // The line runs THROUGH this glyph, so its centre has to land on the trunk.
    // A chevron or any other mark to its left is what breaks this.
    final mark = find.byKey(const ValueKey('machine-connection-icon'));
    expect(tester.getCenter(mark).dx, 19);
    notifier.dispose();
  });

  testWidgets('a closed machine says how many agents are inside it', (
    tester,
  ) async {
    final notifier = railNotifier(expanded: false);
    await pumpRail(tester, notifier);

    // Closed: the count is the only thing left saying the machine has anything.
    expect(find.text('prod-mac'), findsOneWidget);
    expect(find.text('3'), findsOneWidget);
    expect(find.text('Claude Code'), findsNothing);

    // Open: the count goes away, because a number beside a list you can see is
    // noise. It leaves on the same clock as the rows arrive on, though — cut at
    // frame one it would be a second stage of a change that is meant to read as
    // one.
    notifier.toggleExpand(machine.machineId);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 60));
    expect(find.text('3'), findsOneWidget);

    await tester.pumpAndSettle();
    expect(find.text('3'), findsNothing);
    expect(find.text('Claude Code'), findsOneWidget);
    notifier.dispose();
  });

  testWidgets('the machine caption opens and closes its own agents', (
    tester,
  ) async {
    final notifier = railNotifier();
    await pumpRail(tester, notifier);
    expect(find.text('Claude Code'), findsOneWidget);

    await tester.tap(find.text('prod-mac'));
    await tester.pump();

    expect(notifier.expandedMachines, isNot(contains(machine.machineId)));
    // Still mounted, and that is the point: the rows are clipped away by a
    // shrinking box rather than deleted the instant the caption is tapped.
    expect(find.text('Claude Code'), findsOneWidget);

    await tester.pumpAndSettle();
    expect(find.text('Claude Code'), findsNothing);
    notifier.dispose();
  });
}
