import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:xterm/xterm.dart';

import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

final jumpField = find.byKey(const ValueKey('swarm-search-input'));

void main() {
  testWidgets(
    'clicking the real bar and cancelling restores terminal focus without sending the query',
    (tester) async {
      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      final inputs = <TerminalBinaryFrame>[];
      final session = terminal('a0', inputs);
      app.adoptSessionForTest(session);
      await mount(tester, app);
      final input = find.byKey(const ValueKey('swarm-search-input'));
      expect(input, findsNothing);
      await chord(tester, LogicalKeyboardKey.keyO);
      await tester.pump();
      final originalController = tester.widget<TextField>(input).controller;
      await tester.enterText(input, 'a query only');
      await tester.pump();
      expect(
        tester.widget<TextField>(input).controller,
        same(originalController),
      );
      expect(tester.widget<TextField>(input).focusNode!.hasFocus, isTrue);
      expect(inputs, isEmpty);
      await tester.tapAt(const Offset(20, 600));
      await tester.pump();
      expect(find.byKey(const ValueKey('swarm-search-results')), findsNothing);
      expect(originalController!.text, isEmpty);
      final terminalView = tester.widget<TerminalView>(
        find.byType(TerminalView),
      );
      expect(terminalView.focusNode!.hasFocus, isTrue);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
      await tester.pump(const Duration(milliseconds: 10));
      expect(inputs.single.bytes, [27, 91, 68]);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  test('an agent is found by its own title before any agent whose metadata or recap mentions the words', () {
    final app = createApp();
    addTearDown(app.dispose);
    final local = app.machineStates['m']!;
    local.agents = [
      const Agent(
        id: 'a6',
        name: 'harness-6',
        title: 'Board fab check and parts review',
        terminalAvailable: true,
        project: AgentProject(name: 'agent-1', cwd: '/h/agent-1'),
      ),
      const Agent(
        id: 'a10',
        name: 'harness-10',
        terminalAvailable: true,
        project: AgentProject(name: 'fab-shop', cwd: '/h/fab-shop'),
      ),
    ];
    final entries = SwarmSearchCatalog().read(app, const []);
    expect(rankSwarmDestinations(entries, 'Board fab check').first.agentId, 'a6');
    expect(rankSwarmDestinations(entries, 'parts review').first.agentId, 'a6');
    // a bare word that names a project outranks a title that merely contains it
    expect(rankSwarmDestinations(entries, 'fab').first.isProject, isTrue);
    // the whole title, exactly, is the strongest match there is
    expect(rankSwarmDestinations(entries, 'board fab check and parts review').first.agentId, 'a6');
  });

  test('one cached catalog searches all four objects and explicit remote project members', () {
    final app = createApp();
    addTearDown(app.dispose);
    app.renameSwarm(app.activeSwarmId, 'Morning work');
    final local = app.machineStates['m']!;
    local.agents = [
      const Agent(
        id: 'a0',
        name: 'Design',
        terminalAvailable: true,
        project: AgentProject(
          name: 'Solid',
          cwd: '/work/workshop',
          branch: 'feature/wood',
        ),
      ),
    ];
    const remote = Machine(
      machineId: 'remote',
      name: 'iMac Home',
      authMode: MachineAuthMode.remote,
    );
    app.machineStates['remote'] = MachineState(remote)
      ..agents = [
        const Agent(id: 'chess', name: 'Chess', terminalAvailable: true),
      ];
    const projects = [
      SavedSwarmProject(
        machineId: 'm',
        path: '/work/workshop',
        name: 'Solid',
        members: [(machineId: 'remote', agentId: 'chess')],
      ),
    ];
    final cache = SwarmSearchCatalog();
    final entries = cache.read(app, projects);
    expect(rankSwarmDestinations(entries, 'Morning').single.isSwarm, isTrue);
    expect(
      rankSwarmDestinations(entries, 'iMac Home').any((e) => e.isMachine),
      isTrue,
    );
    expect(
      rankSwarmDestinations(entries, 'Solid').any((e) => e.isProject),
      isTrue,
    );
    expect(
      rankSwarmDestinations(entries, 'Solid chess').single.agentId,
      'chess',
    );
    expect(rankSwarmDestinations(entries, 'wood Design').single.agentId, 'a0');
    expect(entries.singleWhere((e) => e.isProject).members, {
      agentDestinationId('m', 'a0'),
      agentDestinationId('remote', 'chess'),
    });
    app.dismissError();
    expect(cache.read(app, projects), same(entries));
    local.agents = [local.agents.single.copyWith(name: 'New design')];
    expect(cache.read(app, projects), isNot(same(entries)));
    expect(
      rankSwarmDestinations(
        cache.read(app, projects),
        'New design',
      ).single.agentId,
      'a0',
    );
  });

  test(
    'Add here reuses the exact terminal and refuses a closed destination swarm',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      final session = terminal('a0', []);
      session.terminal.write('retained output');
      final shared = app.adoptSessionForTest(session);
      final original = app.activeSwarm;
      app.newSwarm(name: 'Review');
      final target = app.activeSwarm;
      final entry = swarmDestinations(app)
          .singleWhere((e) => e.agentId == 'a0');
      final choice = SwarmSearchSelection(entry, SwarmSearchAction.addHere);
      expect(
        await activateSwarmSearchSelection(
          app,
          choice,
          destinationSwarmId: target.id,
        ),
        isTrue,
      );
      expect(app.activeSwarm, same(target));
      expect(original.panes.single, same(target.panes.single));
      expect(target.panes.single, same(shared));
      expect(shared.session, same(session));
      expect(session.terminal.buffer.getText(), contains('retained output'));
      await app.closeSwarm(target.id);
      expect(
        await activateSwarmSearchSelection(
          app,
          choice,
          destinationSwarmId: target.id,
        ),
        isFalse,
      );
      expect(app.swarms, [original]);
    },
  );

  test(
    'a machine result opens its agents in the empty swarm and reuses it',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      final machine = app.machineStates['m']!;
      machine.agents = machine.agents.take(2).toList();
      final original = app.activeSwarm;
      final search = SwarmSearchController(app, []);
      addTearDown(search.dispose);
      search.setQuery('Test host');
      final choice = search.submit();
      expect(choice?.destination.isMachine, isTrue);
      expect(SwarmSearchController.action(choice!.destination), 'Open Harness');
      expect(
        await activateSwarmSearchSelection(
          app,
          choice,
          destinationSwarmId: original.id,
        ),
        isTrue,
      );
      expect(app.activeSwarm, same(original));
      expect(app.activeSwarm.name, 'Test host');
      expect(app.panes.map((pane) => pane.agentId), ['a0', 'a1']);
      final panes = [...app.panes];
      app.newSwarm();
      final empty = app.activeSwarm;
      expect(
        await activateSwarmSearchSelection(
          app,
          choice,
          destinationSwarmId: empty.id,
        ),
        isTrue,
      );
      expect(app.swarms.length, 2);
      expect(app.activeSwarm, same(original));
      expect(app.panes, panes);
      expect(empty.panes, isEmpty);
    },
  );

  test(
    'opening a group from an occupied swarm keeps its work intact',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      final machine = app.machineStates['m']!;
      machine.agents = machine.agents.take(3).toList();
      await app.addAgentToSwarm('m', 'a2');
      final original = app.activeSwarm;
      final retained = app.panes.single;
      final group = SwarmSearchCatalog()
          .read(app, [])
          .singleWhere((e) => e.isMachine);
      expect(
        await activateSwarmSearchSelection(
          app,
          SwarmSearchSelection(group),
          destinationSwarmId: original.id,
        ),
        isTrue,
      );
      expect(app.swarms.length, 2);
      expect(original.panes, [retained]);
      expect(app.panes.map((pane) => pane.agentId).toSet(), {'a0', 'a1', 'a2'});
      expect(app.panes.contains(retained), isTrue);
    },
  );

  test(
    'removed group members and oversized groups cannot create a partial swarm',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      final machine = app.machineStates['m']!;
      final oversized = SwarmSearchCatalog()
          .read(app, [])
          .singleWhere((e) => e.isMachine);
      expect(
        await activateSwarmSearchSelection(
          app,
          SwarmSearchSelection(oversized),
          destinationSwarmId: app.activeSwarmId,
        ),
        isFalse,
      );
      machine.agents = machine.agents.take(2).toList();
      final group = SwarmSearchCatalog()
          .read(app, [])
          .singleWhere((e) => e.isMachine);
      machine.agents = machine.agents.take(1).toList();
      expect(
        await activateSwarmSearchSelection(
          app,
          SwarmSearchSelection(group),
          destinationSwarmId: app.activeSwarmId,
        ),
        isFalse,
      );
      expect(app.swarms.length, 1);
      expect(app.panes, isEmpty);
    },
  );

  testWidgets('Add imports all agents from a machine into this swarm', (
    tester,
  ) async {
    final app = createApp();
    app.machineStates['m']!.agents = app.machineStates['m']!.agents
        .take(3)
        .toList();
    await mount(tester, app);
    await chord(tester, LogicalKeyboardKey.keyO);
    await tester.pump();
    await tester.enterText(jumpField, 'Test host');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('machine:m')));
    await tester.pump();
    expect(app.activeSwarm.name, 'Test host');
    expect(app.panes.map((pane) => pane.agentId), ['a0', 'a1', 'a2']);
    expect(app.swarms.length, 1);
    expect(find.byKey(const ValueKey('swarm-search-results')), findsNothing);
    expect(find.text('Browse agents'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets('Add keeps a shared view here and the first key reaches it', (
    tester,
  ) async {
    final app = createApp();
    app.machineStates['m']!.nodeOnline = true;
    final firstInputs = <TerminalBinaryFrame>[];
    final secondInputs = <TerminalBinaryFrame>[];
    final firstSession = terminal('a0', firstInputs);
    final shared = app.adoptSessionForTest(firstSession);
    final original = app.activeSwarm;
    app.newSwarm(name: 'Review');
    app.adoptSessionForTest(terminal('a1', secondInputs));
    final target = app.activeSwarm;
    await mount(tester, app);
    await chord(tester, LogicalKeyboardKey.keyO);
    await tester.pump();
    await tester.enterText(jumpField, 'Agent 0');
    await tester.pump();
    expect(find.byKey(const ValueKey('swarm-row-action')), findsOneWidget);
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('swarm-row-action')),
        matching: find.text('Open Harness'),
      ),
      findsOneWidget,
    );
    await chord(tester, LogicalKeyboardKey.enter);
    expect(find.byType(Dialog), findsNothing);
    expect(app.activeSwarm, same(target));
    expect(target.panes.last, same(shared));
    expect(original.panes, [shared]);
    final view = tester.widget<TerminalView>(
      find.byWidgetPredicate(
        (w) =>
            w is TerminalView && identical(w.terminal, firstSession.terminal),
      ),
    );
    expect(view.focusNode!.hasFocus, isTrue);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
    await tester.pump(const Duration(milliseconds: 10));
    expect(firstInputs.single.bytes, [27, 91, 68]);
    expect(secondInputs, isEmpty);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  for (final adding in [false, true]) {
    testWidgets(
      'Return waits for composing text in ${adding ? 'Add' : 'New Harness'}',
      (tester) async {
        final app = createApp();
        app.adoptSessionForTest(terminal('a0', []));
        final original = app.activeSwarm;
        app.newSwarm();
        final target = app.activeSwarm;
        await mount(tester, app);
        final field = find.byKey(
          ValueKey(adding ? 'swarm-search-input' : 'harness-start-search'),
        );
        if (adding) {
          await chord(tester, LogicalKeyboardKey.keyO);
          await tester.pump();
        } else {
          await tester.tap(field);
          await tester.pump();
        }
        await tester.enterText(field, 'Agent 0');
        await tester.pump();
        final controller = tester.widget<TextField>(field).controller!;
        controller.value = controller.value.copyWith(
          composing: const TextRange(start: 0, end: 7),
        );
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();
        expect(
          find.byKey(
            ValueKey(adding ? 'swarm-search-results' : 'harness-start-results'),
          ),
          findsOneWidget,
        );
        expect(find.byType(Dialog), findsNothing);
        expect(app.panes, isEmpty);
        controller.clearComposing();
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();
        expect(app.panes.single.agentId, 'a0');
        expect(app.activeSwarm, same(target));
        expect(original.panes, hasLength(1));
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      },
    );
  }
}
