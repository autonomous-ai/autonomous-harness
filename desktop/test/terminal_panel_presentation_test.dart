import 'package:flutter/material.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/terminal_panel.dart';
import 'package:harness/widgets/pane_header_actions.dart';
import 'package:xterm/xterm.dart';

import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

void main() {
  testWidgets(
    'retained header uses current callbacks, names, projects and status',
    (tester) async {
      final app = createApp();
      final session = terminal('a0', []);
      final revision = ValueNotifier(0);
      final closed = <int>[];
      final deleted = <int>[];
      final restarted = <int>[];
      final zoomed = <int>[];
      final composed = <int>[];
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1100, 700);
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          home: ValueListenableBuilder<int>(
            valueListenable: revision,
            builder: (_, version, _) => TerminalPanel(
              notifier: app,
              session: session,
              focused: version.isEven,
              compactHeader: true,
              onClose: () => closed.add(version),
              onDelete: () => deleted.add(version),
              onRestart: () => restarted.add(version),
              onToggleZoom: () => zoomed.add(version),
              zoomed: version >= 2,
              onToggleComposer: () => composed.add(version),
            ),
          ),
        ),
      );
      await tester.pump();
      revision.value = 1;
      await tester.pump();
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(
        location: tester.getCenter(find.text(session.agentName)),
      );
      await tester.pump(const Duration(milliseconds: 120));
      await tester.tap(find.byTooltip('Show message composer'));
      await tester.tap(find.byTooltip('Zoom Pane'));
      await tester.tap(find.byTooltip('Restart Harness'));
      await tester.tap(find.byTooltip('Stop Harness'));
      await tester.tap(find.byTooltip('Close Pane'));
      await tester.pump();
      expect(closed, [1]);
      expect(deleted, [1]);
      expect(restarted, [1]);
      expect(zoomed, [1]);
      expect(composed, [1]);
      session.agentName = 'Renamed terminal';
      app.machineStates['m']!.agents = [
        const Agent(
          id: 'a0',
          name: 'Renamed terminal',
          engine: 'codex',
          terminalAvailable: true,
          project: AgentProject(
            name: 'Terminal project',
            cwd: '/work/terminal',
            branch: 'fast-focus',
          ),
        ),
      ];
      revision.value = 2;
      await tester.pump();
      expect(find.text('Renamed terminal'), findsOneWidget);
      expect(find.text('fast-focus'), findsOneWidget);
      expect(find.text('terminal'), findsOneWidget);
      expect(find.byTooltip('Zoom Pane'), findsOneWidget);
      session.status = TerminalSessionStatus.takenOver;
      revision.value = 3;
      await tester.pump();
      expect(find.text('Take control'), findsOneWidget);
      expect(
        find.byTooltip(
          'Read only: another app controls this terminal. Take control moves input ownership to this app.',
        ),
        findsOneWidget,
      );
      await mouse.removePointer();
      await tester.pumpWidget(const SizedBox());
      revision.dispose();
      session.dispose();
      app.dispose();
    },
  );
  for (final local in [true, false]) {
    testWidgets(
      '${local ? 'local' : 'remote'} header swaps details for actions without moving its title',
      (tester) async {
        final app = createApp();
        app.stateOf('m')!.localOnly = local;
        app.stateOf('m')!.agents = [
          const Agent(
            id: 'a0',
            name: 'Onboarding',
            engine: 'codex',
            terminalAvailable: true,
            project: AgentProject(
              name: 'Harness project',
              cwd: '/work/harness',
              branch: 'main',
            ),
          ),
        ];
        final session = terminal('a0', []);
        session.agentName = 'Onboarding';
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = const Size(720, 300);
        addTearDown(tester.view.reset);
        await tester.pumpWidget(
          MaterialApp(
            home: TerminalPanel(
              notifier: app,
              session: session,
              focused: false,
              compactHeader: true,
              onClose: () {},
              onDelete: () {},
              onToggleZoom: () {},
              onToggleComposer: () {},
            ),
          ),
        );
        await tester.pump();
        final title = find.text('Onboarding');
        final details = find.byKey(const ValueKey('pane-header-details'));
        final controls = find.byType(PaneHeaderActions);
        final terminalWidget = tester.widget<TerminalView>(
          find.byType(TerminalView),
        );
        final titleBounds = tester.getRect(title);
        expect(tester.widget<AnimatedOpacity>(details).opacity, 1);
        expect(find.text('harness'), findsOneWidget);
        expect(find.text('main'), findsOneWidget);
        expect(
          tester.getRect(find.text('harness')).left,
          greaterThan(titleBounds.right),
        );
        expect(
          tester.getRect(find.text('main')).left,
          greaterThan(tester.getRect(find.text('harness')).right),
        );
        expect(
          tester.getRect(find.text('Test host')).left,
          greaterThan(tester.getRect(find.text('main')).right),
        );
        expect(find.byTooltip('Stop Harness').hitTestable(), findsNothing);
        expect(
          find.descendant(of: controls, matching: find.byType(IconButton)),
          findsNWidgets(local ? 5 : 6),
        );
        final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
        await mouse.addPointer(location: tester.getCenter(title));
        await tester.pump(const Duration(milliseconds: 120));
        expect(tester.widget<AnimatedOpacity>(details).opacity, 0);
        expect(find.byTooltip('Stop Harness').hitTestable(), findsOneWidget);
        expect(find.byTooltip('Share harness').hitTestable(), findsOneWidget);
        expect(tester.getRect(title), titleBounds);
        expect(
          tester.widget<TerminalView>(find.byType(TerminalView)),
          same(terminalWidget),
        );
        await mouse.moveTo(const Offset(300, 200));
        await tester.pump(const Duration(milliseconds: 120));
        expect(tester.widget<AnimatedOpacity>(details).opacity, 1);
        expect(find.byTooltip('Stop Harness').hitTestable(), findsNothing);
        // Keyboard users can reveal and reach the same actions without a mouse.
        Focus.of(tester.element(find.byTooltip('Stop Harness'))).nextFocus();
        await tester.pump(const Duration(milliseconds: 120));
        expect(find.byTooltip('Stop Harness').hitTestable(), findsOneWidget);
        await mouse.removePointer();
        await tester.pumpWidget(const SizedBox());
        session.dispose();
        app.dispose();
      },
    );
  }
}
