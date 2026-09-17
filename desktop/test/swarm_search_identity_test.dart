import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/widgets/search_result_text.dart';

import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

void main() {
  test(
    'single-harness tabs collapse by identity and keep their names searchable',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      final machine = app.machineStates['m']!;
      machine.agents = [
        for (final id in ['a0', 'a1'])
          Agent(
            id: id,
            name: 'Harness extensibility architecture',
            engine: 'claude',
            terminalAvailable: true,
          ),
      ];
      app.adoptSessionForTest(terminal('a0', []));
      final first = app.activeSwarm;
      app.renameSwarm(first.id, 'Architecture review');
      // A viewer is part of the same harness, not a second harness.
      first.panes.add(
        TerminalPane(
          id: 1000,
          machineId: 'm',
          kind: PaneKind.web,
          ownerAgentId: 'a0',
          url: 'http://localhost:8080',
        ),
      );
      app.newSwarm(name: 'Another view');
      await app.addAgentToSwarm('m', 'a0');
      final cache = SwarmSearchCatalog();
      final entries = cache.read(app, []);
      expect(entries.where((row) => row.isSwarm), isEmpty);
      final matches = rankSwarmDestinations(
        entries,
        'Harness extensibility architecture',
      );
      expect(matches.map((row) => row.agentId).toSet(), {'a0', 'a1'});
      for (final alias in ['Architecture review', 'Another view']) {
        expect(rankSwarmDestinations(entries, alias).single.agentId, 'a0');
      }
      app.renameSwarm(first.id, 'Release planning');
      final renamed = cache.read(app, []);
      expect(
        rankSwarmDestinations(renamed, 'Release planning').single.agentId,
        'a0',
      );
      expect(rankSwarmDestinations(renamed, 'Architecture review'), isEmpty);

      // History still addresses tabs individually; this is a search collapse.
      expect(
        swarmDestinations(app, openOnly: true).where((row) => row.isSwarm),
        hasLength(2),
      );
    },
  );

  test('harness subtitles use domain types and place the branch glyph after the project', () {
    final app = createApp();
    addTearDown(app.dispose);
    final machine = app.machineStates['m']!..nodeOnline = true;
    machine.agents = [
      for (final (id, engine, dsh) in [
        ('source', 'claude', null),
        ('board', 'claude', 'autonomous/autonomous-circuit'),
        ('part', 'codex', 'autonomous/autonomous-workshop'),
        ('deck', 'claude', 'autonomous/marp'),
      ])
        Agent(
          id: id,
          name: id,
          engine: engine,
          dsh: dsh,
          terminalAvailable: true,
          project: const AgentProject(
            name: 'Workbench',
            cwd: '/work/workbench',
            branch: 'main',
          ),
        ),
      const Agent(
        id: 'loose',
        name: 'Loose code',
        engine: 'codex',
        terminalAvailable: true,
      ),
      const Agent(
        id: 'no-branch',
        name: 'Folder',
        engine: 'codex',
        terminalAvailable: true,
        project: AgentProject(name: 'Folder', cwd: '/work/folder'),
      ),
    ];
    final entries = SwarmSearchCatalog().read(app, []);
    for (final (id, type) in [
      ('source', 'Code'),
      ('board', 'PCB'),
      ('part', 'CAD'),
      ('deck', 'Slides'),
    ]) {
      final row = entries.singleWhere((row) => row.agentId == id);
      expect(row.detail, '$type · Workbench · main · Test host');
      expect(row.detailBranchOffset, row.detail.indexOf('main'));
      expect(rankSwarmDestinations(entries, '$type $id').single, row);
    }
    final loose = entries.singleWhere((row) => row.agentId == 'loose');
    expect(loose.detail, 'Code · Test host');
    expect(loose.detailBranchOffset, isNull);
    final folder = entries.singleWhere((row) => row.agentId == 'no-branch');
    expect(folder.detail, 'Code · Folder · Test host');
    expect(folder.detailBranchOffset, isNull);
  });

  test('machine-provided harness categories refresh the cached search', () {
    final app = createApp();
    addTearDown(app.dispose);
    final machine = app.machineStates['m']!..nodeOnline = true;
    machine.agents = const [
      Agent(
        id: 'robot',
        name: 'Robot arm',
        engine: 'codex',
        dsh: 'studio/robotics',
        terminalAvailable: true,
      ),
    ];
    final cache = SwarmSearchCatalog();
    final before = cache.read(app, []);
    expect(
      before.singleWhere((row) => row.agentId == 'robot').detail,
      'Test host',
    );
    machine.dsh.replace(const [
      DshEntry(
        id: 'studio/robotics',
        name: 'Robot Studio',
        engine: 'codex',
        category: 'Robotics',
      ),
    ]);
    final after = cache.read(app, []);
    expect(after, isNot(same(before)));
    expect(
      after.singleWhere((row) => row.agentId == 'robot').detail,
      'Robotics · Test host',
    );
    expect(rankSwarmDestinations(after, 'Robotics').single.agentId, 'robot');
    expect(cache.read(app, []), same(after));
  });

  test(
    'tab counts use distinct repositories and machines, ignoring viewers',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      final local = app.machineStates['m']!;
      local.agents = const [
        Agent(
          id: 'a0',
          name: 'Local checkout',
          engine: 'codex',
          terminalAvailable: true,
          project: AgentProject(
            name: 'Workbench',
            cwd: '/local/work',
            remote: 'github.com/team/workbench',
          ),
        ),
        Agent(
          id: 'a1',
          name: 'Different repository',
          engine: 'claude',
          terminalAvailable: true,
          project: AgentProject(
            name: 'Workbench',
            cwd: '/local/other',
            remote: 'github.com/other/workbench',
          ),
        ),
      ];
      app.machineStates['remote'] =
          MachineState(
              const Machine(
                machineId: 'remote',
                name: 'Remote Mac',
                authMode: MachineAuthMode.remote,
              ),
            )
            ..nodeOnline = false
            ..agents = const [
              Agent(
                id: 'a0',
                name: 'Remote checkout',
                engine: 'codex',
                terminalAvailable: true,
                project: AgentProject(
                  name: 'Workbench',
                  cwd: '/remote/work',
                  remote: 'github.com/team/workbench',
                ),
              ),
            ];
      await app.addAgentToSwarm('m', 'a0');
      await app.addAgentToSwarm('remote', 'a0');
      final tab = app.activeSwarm;
      app.renameSwarm(tab.id, 'Release work');
      tab.panes.add(
        TerminalPane(
          id: 1000,
          machineId: 'm',
          kind: PaneKind.web,
          ownerAgentId: 'a0',
          url: 'http://localhost:8080',
        ),
      );
      final cache = SwarmSearchCatalog();
      var rows = cache.read(app, []);
      expect(
        rows.singleWhere((row) => row.isSwarm).detail,
        '2 harnesses · 1 project · 2 machines',
      );
      expect(rows.where((row) => row.agentId == 'a0'), hasLength(2));
      expect(rows.singleWhere((row) => row.isSwarm).title, 'Release work');
      await app.addAgentToSwarm('m', 'a1');
      rows = cache.read(app, []);
      expect(
        rows.singleWhere((row) => row.isSwarm).detail,
        '3 harnesses · 2 projects · 2 machines',
      );

      app.newSwarm();
      final search = SwarmSearchController(
        app,
        [],
        adding: true,
        catalog: cache,
      );
      addTearDown(search.dispose);
      search.setQuery('Release work');
      final group = search.rows.singleWhere((row) => row.isSwarm);
      expect(search.actionLabel(group), 'Open 3 Harnesses');
      expect(
        await activateSwarmSearchSelection(
          app,
          search.submit(group)!,
          destinationSwarmId: app.activeSwarmId,
        ),
        isTrue,
      );
      expect(app.panes.where((pane) => pane.agentId != null), hasLength(3));
      expect(tab.panes.where((pane) => pane.agentId != null), hasLength(3));
    },
  );

  test(
    'saved project membership counts once when metadata is unavailable',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      await app.addAgentToSwarm('m', 'a0');
      await app.addAgentToSwarm('m', 'a1');
      const projects = [
        SavedSwarmProject(
          machineId: 'm',
          path: '/work/old-daemon',
          name: 'Legacy project',
          members: [
            (machineId: 'm', agentId: 'a0'),
            (machineId: 'm', agentId: 'a1'),
          ],
        ),
      ];
      final cache = SwarmSearchCatalog();
      expect(
        cache.read(app, projects).singleWhere((row) => row.isSwarm).detail,
        '2 harnesses · 1 project · 1 machine',
      );
      expect(
        cache.read(app, []).singleWhere((row) => row.isSwarm).detail,
        '2 harnesses · 1 machine',
      );
    },
  );

  test(
    'a retained harness remains searchable while its machine is unavailable',
    () {
      final app = createApp();
      addTearDown(app.dispose);
      app.adoptSessionForTest(terminal('a0', []));
      app.renameSwarm(app.activeSwarmId, 'Offline review');
      app.machineStates.clear();
      final entries = SwarmSearchCatalog().read(app, []);
      expect(entries, hasLength(1));
      expect(entries.single.agentId, 'a0');
      expect(
        rankSwarmDestinations(entries, 'Offline review').single,
        entries.single,
      );
    },
  );

  testWidgets(
    'Cmd O renders one harness result and opens it from a tab-name alias',
    (tester) async {
      final app = createApp();
      final machine = app.machineStates['m']!..nodeOnline = true;
      machine.agents = const [
        Agent(
          id: 'a0',
          name: 'Harness extensibility architecture',
          engine: 'claude',
          terminalAvailable: true,
          project: AgentProject(
            name: 'autonomous-harness',
            cwd: '/work/harness',
            branch: 'main',
          ),
        ),
      ];
      final session = terminal('a0', []);
      app.adoptSessionForTest(session);
      app.renameSwarm(app.activeSwarmId, 'Architecture review');
      final source = app.activeSwarm;
      app.newSwarm();
      final target = app.activeSwarm;
      await mount(tester, app);
      await chord(tester, LogicalKeyboardKey.keyO);
      final input = find.byKey(const ValueKey('swarm-search-input'));
      expect(
        tester.widget<TextField>(input).decoration!.hintText,
        'Find a harness',
      );
      await tester.enterText(input, 'extensibility');
      await tester.pump();
      expect(find.byType(ListTile), findsOneWidget);
      final result = tester.widget<ListTile>(find.byType(ListTile));
      final subtitle = result.subtitle! as SearchResultText;
      expect(subtitle.text, 'Code · autonomous-harness · main · Test host');
      expect(subtitle.iconOffset, subtitle.text.indexOf('main'));
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('swarm-row-action')),
          matching: find.text('Open Harness'),
        ),
        findsOneWidget,
      );
      await tester.enterText(input, 'Architecture review');
      await tester.pump();
      expect(find.byType(ListTile), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(app.activeSwarm, same(target));
      expect(target.panes.single.session, same(session));
      expect(source.panes.single.session, same(session));
      expect(input, findsNothing);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );
}
