import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/state/pane_preset.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/state/swarm.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/ws/ws_conn.dart';

class MemoryStore implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async {
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    values.remove(key);
  }
}

AppNotifier createApp({
  MemoryStore? store,
  WsConn Function(String)? connectionForTest,
}) {
  final app = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
    connectionForTest: connectionForTest,
    paneLayoutStore: store == null ? null : PaneLayoutStore(storage: store),
  )..hasNavigationRail = false;
  const machine = Machine(
    machineId: 'm',
    authMode: MachineAuthMode.remote,
    name: 'Test host',
  );
  app.machines = [machine];
  app.machineStates['m'] = MachineState(machine)
    ..nodeOnline = false
    ..agentLoadStatus = AgentLoadStatus.loaded
    ..agents = [
      for (var i = 0; i < 70; i++)
        Agent(
          id: 'a$i',
          name: 'Agent $i',
          engine: 'codex',
          terminalAvailable: true,
        ),
    ];
  return app;
}

void main() {
  test(
    'New Tab reuses the unused page from every tab, and past two dozen tabs still opens one',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      final starter = app.activeSwarm;
      for (var i = 0; i < 10; i++) {
        app.newSwarm();
      }
      expect(app.swarms, [starter]);

      for (var i = 1; i < 30; i++) {
        app.newSwarm(name: 'Project $i');
      }
      final project = app.activeSwarm;
      for (var i = 0; i < 10; i++) {
        app.selectSwarm(project.id);
        app.newSwarm();
        expect(app.activeSwarm, same(starter));
        expect(app.swarms, hasLength(30));
      }

      await app.addAgentToSwarm('m', 'a0');
      app.newSwarm();
      expect(app.activeSwarm, isNot(same(starter)));
      expect(app.panes, isEmpty);
      expect(app.swarms, hasLength(31));
    },
  );

  for (final activeId in ['empty-2', 'work']) {
    test(
      'restore consolidates unused tabs while retaining $activeId',
      () async {
        final storage = MemoryStore();
        final store = PaneLayoutStore(storage: storage);
        await store.saveSwarms([
          Swarm(id: 'empty-1'),
          Swarm(id: 'work', name: 'Work')
            ..panes.add(TerminalPane(id: 1, machineId: 'm', agentId: 'a0')),
          Swarm(id: 'empty-2'),
          Swarm(id: 'named', name: 'Plan'),
          Swarm(id: 'layout')..presets[2] = PanePreset.rows,
          Swarm(id: 'empty-3', name: 'New tab'),
        ], activeId);
        final app = createApp(store: storage);
        addTearDown(app.dispose);
        await app.restorePaneLayoutForTest();
        expect(app.activeSwarmId, activeId);
        expect(app.swarms.where((swarm) => swarm.isEmptyStarter), hasLength(1));
        expect(app.swarms.map((swarm) => swarm.id), [
          if (activeId == 'work') 'empty-1',
          'work',
          if (activeId == 'empty-2') 'empty-2',
          'named',
          'layout',
        ]);
        expect(app.allPanes.single.agentId, 'a0');
        expect(app.allPanes.single.session, isNull);
        expect(app.closedHistory, isEmpty);
        await app.flushPaneLayout();
        final saved = await store.loadSwarms();
        expect((saved!['swarms'] as List), hasLength(4));
        expect(saved['activeId'], activeId);
      },
    );
  }

  for (final legacy in [
    'New swarm',
    'New tab',
    'New Tab',
    'New Harness',
    'New Tab',
  ]) {
    test(
      '$legacy empty tabs restore as New Tab and number the first occupied tab',
      () async {
        final store = MemoryStore();
        final original = createApp(store: store);
        original.renameSwarm(original.activeSwarmId, legacy);
        await original.flushPaneLayout();
        // Retain the old payload exactly as previous versions wrote it.
        expect(
          store.values.values.any((value) => value.contains(legacy)),
          isTrue,
        );
        original.dispose();
        final restored = createApp(store: store);
        addTearDown(restored.dispose);
        await restored.restorePaneLayoutForTest();
        expect(restored.activeSwarm.name, 'New Tab');
        await restored.addAgentToSwarm('m', 'a0');
        expect(restored.activeSwarm.name, 'harness-1');
      },
    );
  }

  test(
    'first agent names a swarm and survives closing and reopening',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      await app.addAgentToSwarm('m', 'a0');
      expect(app.activeSwarm.name, 'harness-1');
      await app.addAgentToSwarm('m', 'a1');
      expect(app.activeSwarm.name, 'harness-1');
      expect(app.activeSwarm.toJson()['name'], 'harness-1');
      await app.closeSwarm(app.activeSwarmId);
      app.reopenClosedSwarm();
      expect(app.activeSwarm.name, 'harness-1');
    },
  );

  test(
    'first agent preserves custom names and names the requested swarm',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      app.renameSwarm(app.activeSwarmId, 'My project');
      await app.addAgentToSwarm('m', 'a0');
      expect(app.activeSwarm.name, 'My project');
      app.newSwarm();
      final target = app.activeSwarm;
      app.newSwarm(name: 'Elsewhere');
      await app.addAgentToSwarm('m', 'a1', swarmId: target.id);
      expect(target.name, 'harness-1');
      expect(app.activeSwarm.name, 'Elsewhere');
    },
  );

  test('tab numbering skips saved and recently closed names', () async {
    final store = MemoryStore();
    final app = createApp(store: store);
    await app.addAgentToSwarm('m', 'a0');
    app.newSwarm();
    await app.addAgentToSwarm('m', 'a1');
    expect(app.activeSwarm.name, 'harness-2');
    await app.closeSwarm(app.activeSwarmId);
    app.newSwarm();
    await app.addAgentToSwarm('m', 'a2');
    expect(app.activeSwarm.name, 'harness-3');
    app.renameSwarm(app.activeSwarmId, 'harness-10');
    await app.flushPaneLayout();
    app.dispose();
    final restored = createApp(store: store);
    addTearDown(restored.dispose);
    await restored.restorePaneLayoutForTest();
    restored.newSwarm();
    await restored.addAgentToSwarm('m', 'a3');
    expect(restored.activeSwarm.name, 'harness-11');
  });

  test(
    'shared memberships own one controller and close only the final stream',
    () async {
      final app = createApp();
      final sent = <String>[];
      final session =
          TerminalSession(
              machineId: 'm',
              agentId: 'a0',
              agentName: 'A',
              engineId: 'codex',
              send: (type, payload) async {
                sent.add(type);
                return true;
              },
              sendBinary: (_) async => true,
            )
            ..status = TerminalSessionStatus.controlling
            ..streamId = 'shared';
      final pane = app.adoptSessionForTest(session);
      final first = app.activeSwarmId;
      app.newSwarm();
      await app.addAgentToSwarm('m', 'a0');
      expect(app.panes.single, same(pane));
      expect(app.allPanes.length, 1);
      await app.closeSwarm(first);
      expect(app.panes.single.session, same(session));
      expect(sent, isNot(contains('terminal_close')));
      await app.closePane(pane.id);
      expect(sent.where((v) => v == 'terminal_close').length, 1);
      expect(sent, isNot(contains('agent_delete')));
      app.dispose();
    },
  );

  test('replacement and pinning cannot change another swarm', () async {
    final app = createApp();
    await app.addAgentToSwarm('m', 'a0');
    await app.addAgentToSwarm('m', 'a1');
    final first = app.activeSwarm;
    final shared = first.panes.first;
    app.togglePinPane(shared.id);
    app.newSwarm();
    await app.addAgentToSwarm('m', 'a0');
    expect(app.isPanePinned(shared), isFalse);
    await app.assignAgentToPane(shared.id, 'm', 'a2');
    expect(app.panes.single.agentId, 'a2');
    expect(first.panes.first, same(shared));
    expect(shared.agentId, 'a0');
    app.selectSwarm(first.id);
    expect(app.isPanePinned(shared), isTrue);
    app.dispose();
  });

  test(
    'seeding records every membership before any tab switch and exceeds nine',
    () async {
      final app = createApp();
      final first = app.activeSwarm;
      final work = app.seedSwarm('Fleet', [
        for (var i = 0; i < 20; i++) (machineId: 'm', agentId: 'a$i'),
      ]);
      app.newSwarm();
      await work;
      expect(first.panes.length, 20);
      expect(app.panes, isEmpty);
      await app.addAgentToSwarm('m', 'a22', swarmId: first.id);
      expect(first.panes.last.agentId, 'a22');
      expect(app.panes, isEmpty);
      await app.closeSwarm(first.id);
      await app.addAgentToSwarm('m', 'a23', swarmId: first.id);
      expect(app.panes, isEmpty);
      app.dispose();
    },
  );

  test(
    'starter capacity is explicit and never evicts selected agents',
    () async {
      final app = createApp();
      await app.seedSwarm('Large fleet', [
        for (var i = 0; i < 70; i++) (machineId: 'm', agentId: 'a$i'),
      ]);
      expect(app.panes.length, AppNotifier.maxPanes);
      expect(app.lastError, contains('Open another tab'));
      expect(app.panes.first.agentId, 'a0');
      app.dispose();
    },
  );

  test(
    'all swarm intent, focus, zoom and shared identity restore offline',
    () async {
      final storage = MemoryStore();
      final app = createApp(store: storage);
      await app.addAgentToSwarm('m', 'a0');
      await app.addAgentToSwarm('m', 'a1');
      app.focusPane(app.panes.first.id);
      app.toggleZoomPane();
      app.setPreset(2, PanePreset.rows);
      app.togglePinPane(app.panes.first.id);
      app.renameSwarm(app.activeSwarmId, 'First');
      final first = app.activeSwarm;
      app.newSwarm(name: 'Second');
      await app.addAgentToSwarm('m', 'a0');
      await Future<void>.delayed(Duration.zero);
      final restored = createApp(store: storage);
      await restored.restorePaneLayoutForTest();
      expect(restored.swarms.map((s) => s.name), ['First', 'Second']);
      expect(
        restored.swarms.first.panes.first,
        same(restored.swarms.last.panes.single),
      );
      expect(restored.allPanes.every((p) => p.session == null), isTrue);
      expect(restored.isPanePinned(restored.panes.single), isFalse);
      restored.selectSwarm(first.id);
      expect(restored.zoomedPaneId, restored.focusedPaneId);
      expect(restored.activeSwarm.previousPaneId, restored.panes.last.id);
      expect(restored.presetFor(2), PanePreset.rows);
      expect(restored.isPanePinned(restored.panes.first), isTrue);
      app.dispose();
      restored.dispose();
    },
  );

  test(
    'new tab ids cannot collide after reorder and gaps in saved ids',
    () async {
      final app = createApp();
      app.newSwarm(name: 'Second');
      app.newSwarm(name: 'Third');
      app.newSwarm(name: 'Fourth');
      await app.closeSwarm('swarm-2');
      app.reorderSwarm('swarm-4', 0);
      app.newSwarm(name: 'Fifth');
      app.newSwarm(name: 'Sixth');
      expect(app.swarms.map((s) => s.id).toSet().length, app.swarms.length);
      while (app.swarms.length > 1) {
        await app.closeSwarm(app.swarms.first.id);
      }
      await app.closeSwarm(app.activeSwarmId);
      expect(app.swarms.length, 1);
      expect(app.panes, isEmpty);
      app.dispose();
    },
  );

  test('focus changes follow zoom and wrap without a hidden rail', () async {
    final app = createApp();
    await app.addAgentToSwarm('m', 'a0');
    await app.addAgentToSwarm('m', 'a1');
    app.toggleZoomPane();
    app.focusPane(app.panes.first.id);
    expect(app.zoomedPaneId, app.panes.first.id);
    app.focusPaneHorizontally(-1);
    expect(app.railFocused, isFalse);
    expect(app.zoomedPaneId, app.focusedPaneId);
    app.dispose();
  });

  test(
    'same remote groups across machines but matching folder names do not',
    () {
      final app = createApp();
      final remote = app.machineStates['m']!;
      const second = Machine(machineId: 'n', authMode: MachineAuthMode.remote);
      app.machineStates['n'] = MachineState(second);
      remote.agents = [
        const Agent(
          id: 'a',
          name: 'A',
          project: AgentProject(
            name: 'app',
            cwd: '/one/app',
            remote: 'github.com/org/app',
          ),
        ),
        const Agent(
          id: 'b',
          name: 'B',
          project: AgentProject(name: 'private', cwd: '/one/private'),
        ),
      ];
      app.machineStates['n']!.agents = [
        const Agent(
          id: 'c',
          name: 'C',
          project: AgentProject(
            name: 'app',
            cwd: '/two/app',
            remote: 'github.com/org/app',
          ),
        ),
        const Agent(
          id: 'd',
          name: 'D',
          project: AgentProject(name: 'private', cwd: '/one/private'),
        ),
      ];
      final groups = swarmProjects(app, []);
      expect(groups.length, 3);
      expect(groups.firstWhere((g) => g.name == 'app').agents.length, 2);
      expect(
        Agent.fromJson({'id': 'old', 'name': 'Older daemon'}).project,
        isNull,
      );
      app.dispose();
    },
  );
}
