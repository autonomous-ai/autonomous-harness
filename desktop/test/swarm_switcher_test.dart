import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/terminal/terminal_binary.dart';

import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

Finder get jumpField => find.byWidgetPredicate(
  (w) =>
      w is TextField && w.decoration?.hintText == 'Jump to an agent or swarm…',
);
Finder get selectedRow =>
    find.byWidgetPredicate((w) => w is ListTile && w.selected);

void main() {
  testWidgets(
    'jump opens in one frame, owns typing, cancels, and leaves Add separate',
    (tester) async {
      final app = createApp();
      app.adoptSessionForTest(terminal('a0', []));
      await mount(tester, app);
      final membership = [...app.panes];
      await tester.sendKeyDownEvent(LogicalKeyboardKey.meta);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyP);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.meta);
      await tester.pump();
      expect(jumpField, findsOneWidget);
      final field = tester.widget<TextField>(jumpField);
      expect(field.focusNode!.hasFocus, isTrue);
      expect(
        (ModalRoute.of(
          tester.element(jumpField),
        ) as TransitionRoute).transitionDuration,
        Duration.zero,
      );
      expect(find.byType(BackdropFilter), findsNothing);
      await chord(tester, LogicalKeyboardKey.keyP);
      expect(find.byType(Dialog), findsOneWidget);
      await tester.enterText(jumpField, 'missing');
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(jumpField, findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(jumpField, findsNothing);
      expect(app.panes, membership);
      await chord(tester, LogicalKeyboardKey.keyF, shift: true);
      expect(find.text('Add agent'), findsOneWidget);
      expect(jumpField, findsNothing);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'Return jumps across swarms and a second jump returns to prior focus',
    (tester) async {
      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      final firstInput = <TerminalBinaryFrame>[];
      final secondInput = <TerminalBinaryFrame>[];
      final firstPane = app.adoptSessionForTest(terminal('a0', firstInput));
      final first = app.activeSwarm;
      await mount(tester, app);
      app.newSwarm();
      final secondPane = app.adoptSessionForTest(terminal('a1', secondInput));
      app.dismissError();
      await tester.pump();
      final second = app.activeSwarm;
      await chord(tester, LogicalKeyboardKey.keyP);
      expect(
        find.descendant(of: selectedRow, matching: find.text('Agent 0')),
        findsOneWidget,
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(app.activeSwarmId, first.id);
      expect(app.focusedPaneId, firstPane.id);
      expect(first.panes, [firstPane]);
      expect(second.panes, [secondPane]);
      expect(firstInput, isEmpty);
      expect(secondInput, isEmpty);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
      await tester.pump(const Duration(milliseconds: 10));
      expect(firstInput.single.bytes, [27, 91, 68]);
      expect(secondInput, isEmpty);
      await chord(tester, LogicalKeyboardKey.keyP);
      expect(
        find.descendant(of: selectedRow, matching: find.text('Agent 1')),
        findsOneWidget,
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(app.activeSwarmId, second.id);
      expect(app.focusedPaneId, secondPane.id);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
      await tester.pump(const Duration(milliseconds: 10));
      expect(firstInput, hasLength(1));
      expect(secondInput.single.bytes, [27, 91, 67]);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'keyboard selection scrolls, survives discovery, and explicitly opens a view',
    (tester) async {
      final app = createApp();
      app.adoptSessionForTest(terminal('a0', []));
      await mount(tester, app);
      await chord(tester, LogicalKeyboardKey.keyP);
      for (var i = 0; i < 12; i++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
        await tester.pump();
      }
      await tester.pump();
      final selectedId =
          (tester.widget<ListTile>(selectedRow).key! as ValueKey<String>).value;
      final rowRect = tester.getRect(selectedRow);
      final listRect = tester.getRect(find.byType(ListView));
      expect(rowRect.top, greaterThanOrEqualTo(listRect.top));
      expect(rowRect.bottom, lessThanOrEqualTo(listRect.bottom));
      final machine = app.machineStates['m']!;
      machine.agents = [
        const Agent(
          id: 'new',
          name: 'A newly discovered agent',
          terminalAvailable: true,
        ),
        ...machine.agents,
      ];
      app.dismissError();
      await tester.pump();
      await tester.pump();
      expect(tester.widget<ListTile>(selectedRow).key, ValueKey(selectedId));
      expect(find.textContaining('Open view in'), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(app.panes, hasLength(2));
      expect(
        agentDestinationId(
          app.focusedPane!.machineId,
          app.focusedPane!.agentId!,
        ),
        selectedId,
      );
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );
}
