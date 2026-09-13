import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/terminal_panel.dart';

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
            ),
          ),
        ),
      );
      await tester.pump();
      revision.value = 1;
      await tester.pump();
      await tester.tap(find.byTooltip('Close pane'));
      expect(closed, [1]);
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
      expect(find.text('Terminal project / fast-focus'), findsOneWidget);
      session.status = TerminalSessionStatus.takenOver;
      revision.value = 3;
      await tester.pump();
      expect(find.byTooltip('taken over'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      revision.dispose();
      session.dispose();
      app.dispose();
    },
  );
}
