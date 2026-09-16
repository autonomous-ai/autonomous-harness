import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/pane_grid.dart';
import 'package:harness/widgets/terminal_panel.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:xterm/xterm.dart';

import 'swarm_state_test.dart' show createApp;
import 'swarm_interactions_test.dart' show chord;

Future<void> mount(
  WidgetTester tester,
  AppNotifier app, {
  SwarmProjectStore? projects,
  bool nativeTabs = false,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(1280, 800);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: SwarmScreen(
        notifier: app,
        nativeTabs: nativeTabs,
        projectStore: projects ?? SwarmProjectStore(),
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
  testWidgets('tab close marks follow hover and keyboard focus', (
    tester,
  ) async {
    final app = createApp();
    final first = app.activeSwarm;
    app.renameSwarm(first.id, 'First tab');
    app.newSwarm();
    final second = app.activeSwarm;
    app.renameSwarm(second.id, 'Second tab');
    await mount(tester, app);
    Finder close(String id) => find.byKey(ValueKey('tab-close:$id'));
    double opacity(String id) => tester.widget<Opacity>(close(id)).opacity;
    expect(opacity(first.id), 0);
    expect(opacity(second.id), 0);
    final pointer = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await pointer.addPointer(location: const Offset(900, 500));
    await pointer.moveTo(tester.getCenter(find.text('First tab')));
    await tester.pump();
    expect(opacity(first.id), 1);
    expect(opacity(second.id), 0);
    await pointer.moveTo(const Offset(900, 500));
    await tester.pump();
    expect(opacity(first.id), 0);
    Focus.of(tester.element(find.text('First tab'))).requestFocus();
    await tester.pumpAndSettle();
    expect(opacity(first.id), 1);
    final closeIcon = find.descendant(
      of: close(first.id),
      matching: find.byType(Icon),
    );
    Focus.of(tester.element(closeIcon)).requestFocus();
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.space);
    await tester.pump();
    expect(app.swarms.map((swarm) => swarm.id), [second.id]);
    await pointer.removePointer();
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  for (final native in [false, true]) {
    testWidgets('the store tab wears a storefront, not New Tab\'s plus (native=$native)', (
      tester,
    ) async {
      const channel = MethodChannel('harness/swarm_tabs');
      final updates = <Map>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
        call,
      ) async {
        if (call.method == 'update') updates.add(call.arguments as Map);
        return true;
      });
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          null,
        ),
      );
      final app = createApp();
      final tab = app.activeSwarm;
      await mount(tester, app, nativeTabs: native);
      app.openStore();
      await tester.pump();
      expect(tab.isStore, isTrue);
      if (native) {
        final row = (updates.last['tabs'] as List).single as Map;
        expect(row['kind'], 'store');
        expect(row['agentCount'], 0);
        expect(row['iconAsset'], 'assets/engine-icons/store.png');
      } else {
        expect(find.byKey(ValueKey('tab-store:${tab.id}')), findsOneWidget);
      }
    });

    testWidgets('tab identity follows its agent count (native=$native)', (
      tester,
    ) async {
      const channel = MethodChannel('harness/swarm_tabs');
      final updates = <Map>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
        call,
      ) async {
        if (call.method == 'update') updates.add(call.arguments as Map);
        return true;
      });
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          null,
        ),
      );
      final app = createApp();
      final tab = app.activeSwarm;
      await mount(tester, app, nativeTabs: native);
      expect(tab.name, 'New Tab');
      expect(
        find.byKey(const ValueKey('harness-start-search')),
        findsOneWidget,
      );

      await app.addAgentToSwarm('m', 'a0');
      await tester.pump();
      if (native) {
        final row = (updates.last['tabs'] as List).single as Map;
        expect(row['agentCount'], 1);
        expect(row['engine'], 'codex');
        expect(row['iconAsset'], 'assets/engine-icons/codex.png');
      } else {
        expect(find.byKey(ValueKey('tab-engine:${tab.id}')), findsOneWidget);
      }

      await app.addAgentToSwarm('m', 'a1');
      await tester.pump();
      if (native) {
        final row = (updates.last['tabs'] as List).single as Map;
        expect(row['agentCount'], 2);
        expect(row['engine'], isNull);
      } else {
        expect(find.byKey(ValueKey('tab-group:${tab.id}')), findsOneWidget);
      }

      await app.closePane(app.panes.last.id);
      await tester.pump();
      if (native) {
        expect(
          ((updates.last['tabs'] as List).single as Map)['engine'],
          'codex',
        );
      } else {
        expect(find.byKey(ValueKey('tab-engine:${tab.id}')), findsOneWidget);
        expect(find.byKey(ValueKey('tab-group:${tab.id}')), findsNothing);
      }
      expect(app.activeSwarm, same(tab));
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    });
  }

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
      expect(find.text('Existing project'), findsNothing);
      await chord(tester, LogicalKeyboardKey.keyO);
      await tester.pump();
      await tester.enterText(
        find.byKey(const ValueKey('swarm-search-input')),
        '/work/existing',
      );
      await tester.pump();
      expect(
        find.byKey(ValueKey(agentDestinationId('m', 'a0'))),
        findsOneWidget,
      );
      expect(
        find.byKey(ValueKey(agentDestinationId('m', 'a1'))),
        findsOneWidget,
      );
      expect(find.byKey(ValueKey(agentDestinationId('m', 'a2'))), findsNothing);
      await tester.tap(find.widgetWithText(ListTile, 'Existing project'));
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
      expect(
        find.byKey(const ValueKey('harness-start-search')),
        findsOneWidget,
      );
      expect(find.text('Models'), findsNothing);
      expect(find.text('Machines'), findsNothing);
      await chord(tester, LogicalKeyboardKey.keyO);
      await tester.pump();
      await tester.enterText(
        find.byKey(const ValueKey('swarm-search-input')),
        'Agent 1',
      );
      await tester.pump();
      expect(find.text('Agent 1').last, findsOneWidget);
      await tester.tap(find.byKey(ValueKey(agentDestinationId('m', 'a1'))));
      await tester.pump();
      await app.addAgentToSwarm('m', 'a2');
      app.toggleZoomPane();
      // The Open button appears when the first agent replaces the welcome page.
      await tester.pump(const Duration(milliseconds: 200));
      final zoom = app.zoomedPaneId;
      final before = tester.getSize(find.byType(PaneGrid));
      await tester.tap(find.byKey(const ValueKey('swarm-open-agent-button')));
      await tester.pump(const Duration(milliseconds: 300));
      expect(
        find.byKey(const ValueKey('swarm-search-results')),
        findsOneWidget,
      );
      expect(find.byType(Dialog), findsNothing);
      expect(app.panes.length, 2);
      expect(app.zoomedPaneId, zoom);
      expect(tester.getSize(find.byType(PaneGrid)), before);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
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
    'parked terminals keep output and selection and reveal the latest on return',
    (tester) async {
      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      final session = terminal('a0', []);
      session.terminal.write(
        List.generate(200, (i) => 'saved line $i\r\n').join(),
      );
      app.adoptSessionForTest(session);
      final first = app.activeSwarmId;
      await mount(tester, app);
      final renderer = tester.state(find.byType(TerminalView));
      final view = tester.widget<TerminalView>(find.byType(TerminalView));
      view.scrollController!.jumpTo(100);
      view.controller!.setSelection(
        session.terminal.buffer.createAnchor(0, 3),
        session.terminal.buffer.createAnchor(5, 3),
      );
      await tester.pump();
      final selection = session.terminal.buffer.getText(
        view.controller!.selection,
      );
      final scroll = view.scrollController!.offset;
      app.newSwarm();
      await tester.pump();
      // A second switch leaves the first terminal parked in the same slot.
      app.newSwarm();
      session.terminal.write('arrived while hidden\r\n');
      await app.handleEventForTest('m', {
        'type': 'agent_renamed',
        'payload': {'agentId': 'a0', 'name': 'Renamed while hidden'},
      });
      await tester.pump();
      expect(find.byType(TerminalView), findsNothing);
      expect(view.scrollController!.offset, scroll);
      app.selectSwarm(first);
      await tester.pump();
      expect(tester.state(find.byType(TerminalView)), same(renderer));
      expect(find.text('Renamed while hidden'), findsOneWidget);
      expect(
        session.terminal.buffer.getText(),
        contains('arrived while hidden'),
      );
      expect(
        session.terminal.buffer.getText(view.controller!.selection),
        selection,
      );
      expect(
        view.scrollController!.offset,
        view.scrollController!.position.maxScrollExtent,
      );
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'a replacement session reaches its parked view before the tab is shown',
    (tester) async {
      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      final original = terminal('a0', []);
      final pane = app.adoptSessionForTest(original);
      final first = app.activeSwarmId;
      await mount(tester, app);
      app.newSwarm();
      await tester.pump();
      final replacement = terminal('a0', [])
        ..terminal.write('replacement stream');
      pane.session = replacement;
      app.notifyListeners();
      await tester.pump();
      final parked = tester.widget<TerminalPanel>(
        find.byType(TerminalPanel, skipOffstage: false),
      );
      expect(parked.session, same(replacement));
      expect(parked.visible, isFalse);
      original.removeListener(app.notifyListeners);
      original.dispose();
      app.selectSwarm(first);
      await tester.pump();
      expect(
        tester.widget<TerminalPanel>(find.byType(TerminalPanel)).session,
        same(replacement),
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
      await chord(tester, LogicalKeyboardKey.keyI, shift: true);
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
      await chord(tester, LogicalKeyboardKey.keyI, shift: true);
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('No agents need your input'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );
}
