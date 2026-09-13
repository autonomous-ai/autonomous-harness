import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/pane_grid.dart';
import 'package:harness/widgets/terminal_panel.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:xterm/xterm.dart';

import 'swarm_state_test.dart' show createApp;

Future<void> mount(WidgetTester tester, AppNotifier app) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(1280, 800);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: SwarmScreen(
        notifier: app,
        nativeTabs: false,
        projectStore: SwarmProjectStore(),
      ),
    ),
  );
  await tester.pump(const Duration(milliseconds: 100));
}

TerminalSession terminal(String id, List<TerminalBinaryFrame> input) =>
    TerminalSession(
        machineId: 'm',
        agentId: id,
        agentName: 'Session $id',
        engineId: 'codex',
        send: (_, _) async => true,
        sendBinary: (frame) async {
          if (frame.kind == TerminalBinaryKind.input) input.add(frame);
          return true;
        },
      )
      ..status = TerminalSessionStatus.controlling
      ..streamId = 'stream-$id';

void main() {
  testWidgets(
    'an older daemon working folder is searchable and seeds its real agents',
    (tester) async {
      final app = createApp();
      app.machineStates['m']!.localEndpoint = LocalCliEndpoint(
        computerId: 'local-computer',
        wsUri: Uri.parse('ws://fixture.invalid'),
        protocolVersion: 1,
        terminalProtocolVersion: 3,
        agentProjects: const {
          'a0': AgentProject(name: 'Existing project', cwd: '/work/existing'),
          'a1': AgentProject(name: 'Existing project', cwd: '/work/existing'),
        },
      );
      await mount(tester, app);
      expect(find.text('Existing project'), findsOneWidget);
      await tester.enterText(find.byType(TextField), '/work/existing');
      await tester.pump();
      expect(find.text('Agent 0'), findsOneWidget);
      expect(find.text('Agent 1'), findsOneWidget);
      expect(find.text('Agent 2'), findsNothing);
      await tester.enterText(find.byType(TextField), '');
      await tester.pump();
      await tester.tap(find.text('Existing project'));
      await tester.pump(const Duration(milliseconds: 100));
      expect(app.activeSwarm.name, 'Existing project');
      expect(app.panes.map((p) => p.agentId), ['a0', 'a1']);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'welcome, search and picker cancellation leave layout and zoom intact',
    (tester) async {
      final app = createApp();
      await mount(tester, app);
      expect(find.text('Start a swarm'), findsOneWidget);
      expect(find.text('Models'), findsNothing);
      expect(find.text('Machines'), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'Agent 1');
      await tester.pump();
      expect(find.text('Agent 1').last, findsOneWidget);
      await tester.tap(find.text('Agent 1').last);
      await tester.pump();
      await app.addAgentToSwarm('m', 'a2');
      app.toggleZoomPane();
      await tester.pump();
      final zoom = app.zoomedPaneId;
      final before = tester.getSize(find.byType(PaneGrid));
      await tester.tap(find.byTooltip('Add agent  ⌘P'));
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('Add agent'), findsOneWidget);
      expect(app.panes.length, 2);
      expect(app.zoomedPaneId, zoom);
      expect(tester.getSize(find.byType(PaneGrid)), before);
      await tester.tap(find.byTooltip('Close agent picker'));
      await tester.pump(const Duration(milliseconds: 300));
      expect(app.zoomedPaneId, zoom);
      expect(app.panes.length, 2);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'tab and zoom switches retain one renderer per session and preserve hidden geometry',
    (tester) async {
      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      final framesA = <TerminalBinaryFrame>[];
      final framesB = <TerminalBinaryFrame>[];
      final a = terminal('a0', framesA);
      final b = terminal('a1', framesB);
      app.adoptSessionForTest(a);
      app.adoptSessionForTest(b);
      final first = app.activeSwarmId;
      await mount(tester, app);
      await tester.pump(const Duration(milliseconds: 100));
      final rendererA = tester.state(
        find.byWidgetPredicate(
          (w) => w is TerminalView && w.terminal == a.terminal,
        ),
      );
      final rendererB = tester.state(
        find.byWidgetPredicate(
          (w) => w is TerminalView && w.terminal == b.terminal,
        ),
      );
      final geometryB = (b.terminal.viewWidth, b.terminal.viewHeight);
      app.newSwarm();
      await app.addAgentToSwarm('m', 'a0');
      await tester.pump(const Duration(milliseconds: 80));
      expect(find.byType(TerminalPanel), findsOneWidget);
      expect(find.byType(TerminalPanel, skipOffstage: false), findsNWidgets(2));
      expect(
        tester.state(
          find.byWidgetPredicate(
            (w) => w is TerminalView && w.terminal == a.terminal,
          ),
        ),
        same(rendererA),
      );
      expect((b.terminal.viewWidth, b.terminal.viewHeight), geometryB);
      tester.view.physicalSize = const Size(1000, 700);
      await tester.pump(const Duration(milliseconds: 80));
      expect((b.terminal.viewWidth, b.terminal.viewHeight), geometryB);
      framesA.clear();
      framesB.clear();
      expect(tester.testTextInput.hasAnyClients, isTrue);
      tester.testTextInput.updateEditingValue(
        const TextEditingValue(
          text: 'x',
          selection: TextSelection.collapsed(offset: 1),
        ),
      );
      await tester.pump(const Duration(milliseconds: 30));
      expect(utf8.decode(framesA.expand((f) => f.bytes).toList()), 'x');
      expect(framesB, isEmpty);
      app.selectSwarm(first);
      await tester.pump(const Duration(milliseconds: 80));
      expect(
        tester.state(
          find.byWidgetPredicate(
            (w) => w is TerminalView && w.terminal == b.terminal,
          ),
        ),
        same(rendererB),
      );
      app.toggleZoomPane();
      await tester.pump(const Duration(milliseconds: 60));
      expect(find.byType(TerminalPanel, skipOffstage: false), findsNWidgets(2));
      app.toggleZoomPane();
      await tester.pump(const Duration(milliseconds: 60));
      expect(
        tester.state(
          find.byWidgetPredicate(
            (w) => w is TerminalView && w.terminal == a.terminal,
          ),
        ),
        same(rendererA),
      );
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'notifications show only current questions and navigate to their originating swarm',
    (tester) async {
      final app = createApp();
      await app.addAgentToSwarm('m', 'a0');
      final first = app.activeSwarmId;
      app.newSwarm();
      await app.handleEventForTest('m', {
        'type': 'commander_question',
        'payload': {
          'agentId': 'a0',
          'requestId': 'question',
          'questions': [
            {
              'q': 'Which folder?',
              'options': ['A', 'B'],
            },
          ],
        },
      });
      await mount(tester, app);
      await tester.tap(
        find.widgetWithIcon(IconButton, Icons.notifications_none),
      );
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('Which folder?'), findsOneWidget);
      await tester.tap(find.text('Which folder?'));
      await tester.pump(const Duration(milliseconds: 300));
      expect(app.activeSwarmId, first);
      expect(app.focusedPane?.agentId, 'a0');
      await app.handleEventForTest('m', {
        'type': 'commander_question_close',
        'payload': {'agentId': 'a0', 'requestId': 'question'},
      });
      await tester.tap(
        find.widgetWithIcon(IconButton, Icons.notifications_none),
      );
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('No agents need your input'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );
}
