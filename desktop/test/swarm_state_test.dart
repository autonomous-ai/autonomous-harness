import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/state/pane_preset.dart';
import 'package:harness/state/swarm_catalog.dart';
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
      expect(app.lastError, contains('Open another swarm'));
      expect(app.panes.first.agentId, 'a0');
      app.dispose();
    },
  );

  test('all swarm intent, focus, zoom, wallpaper and shared identity restore offline', () async {
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
    app.nextSwarmWallpaper();
    final wallpaper = app.activeSwarm.wallpaper;
    await Future<void>.delayed(Duration.zero);
    final restored = createApp(store: storage);
    await restored.restorePaneLayoutForTest();
    expect(restored.swarms.map((s) => s.name), ['First', 'Second']);
    expect(restored.activeSwarm.wallpaper, wallpaper);
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
  });

  test(
    'new tab ids cannot collide after reorder and gaps in saved ids',
    () async {
      final app = createApp();
      app.newSwarm();
      app.newSwarm();
      app.newSwarm();
      await app.closeSwarm('swarm-2');
      app.reorderSwarm('swarm-4', 0);
      app.newSwarm();
      app.newSwarm();
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
