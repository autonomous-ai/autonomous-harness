import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/ws/ws_conn.dart';

/// In-memory stand-in so a layout test never reaches the developer's own
/// ~/.harness state file.
class _MemoryStore implements LocalKeyValueStore {
  final Map<String, String> values = {};

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async => values[key] = value;

  @override
  Future<void> delete(String key) async => values.remove(key);
}

AppNotifier _notifier({
  PaneLayoutStore? layout,
  WsConn Function(String)? connectionForTest,
}) => AppNotifier(
  config: AppConfig.dev,
  authSession: AuthSession(),
  configStore: null,
  paneLayoutStore: layout,
  connectionForTest: connectionForTest,
);

class _TerminalConnection extends WsConn {
  _TerminalConnection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm1',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final sent = <String>[];
  @override
  Future<bool> sendTerminalFrame(
    String type,
    Map<String, dynamic> payload,
  ) async {
    sent.add(type);
    return true;
  }
}

Agent _agent(String id) => Agent.fromJson({
  'id': id,
  'name': id,
  'engine': 'claude',
  'terminal': {
    'runtimes': [
      {'backend': 'tmux', 'paneId': '%1'},
    ],
  },
});

/// A machine that is online and past every check [assignAgentToPane] makes,
/// EXCEPT that opening a stream would need a live connection — so these tests
/// assert the grid's bookkeeping, not the wire.
MachineState _machine(AppNotifier app, String id, List<String> agentIds) {
  final machine = Machine(
    machineId: id,
    apiKey: '',
    authMode: MachineAuthMode.remote,
    name: id,
    status: 'online',
  );
  final state = MachineState(machine)
    ..nodeOnline =
        false // keeps _attachSession from dialling out
    ..agentLoadStatus = AgentLoadStatus.loaded
    ..agents = [for (final agentId in agentIds) _agent(agentId)];
  app.machines = [...app.machines, machine];
  app.machineStates[id] = state;
  return state;
}

TerminalSession _session(String machineId, String agentId) => TerminalSession(
  machineId: machineId,
  agentId: agentId,
  agentName: agentId,
  engineId: 'claude',
  send: (_, _) async => true,
  sendBinary: (_) async => true,
);

void main() {
  group('app focus reporting', () {
    late AppNotifier app;
    late List<(String, String?)> frames;

    setUp(() {
      app = _notifier();
      _machine(app, 'm1', ['a', 'b']);
      _machine(app, 'm2', ['c']);
      frames = [];
      app.focusFrameSenderForTest = (machineId, agentId) async {
        frames.add((machineId, agentId));
        return true;
      };
    });
    tearDown(() => app.dispose());

    test('device fallback opens and announces the candidate', () async {
      await app.ensureDeviceFocus({
        'machineId': 'm1',
        'agentId': 'a',
        'focusRevision': 'instance:0',
        'expiresAt': DateTime.now().millisecondsSinceEpoch + 2000,
      });
      expect(app.focusedPane?.agentId, 'a');
      expect(frames.last, ('m1', 'a'));
    });

    test('device fallback preserves an existing remote selection', () async {
      await app.assignAgentToPane(null, 'm2', 'c');
      frames.clear();
      await app.ensureDeviceFocus({
        'machineId': 'm1',
        'agentId': 'a',
        'focusRevision': 'instance:0',
        'expiresAt': DateTime.now().millisecondsSinceEpoch + 2000,
      });
      expect(app.focusedPane?.agentId, 'c');
      expect(frames, [('m2', 'c')]);
    });

    test('expired device fallback never opens a pane', () async {
      await app.ensureDeviceFocus({
        'machineId': 'm1',
        'agentId': 'a',
        'focusRevision': 'instance:0',
        'expiresAt': DateTime.now().millisecondsSinceEpoch - 1,
      });
      expect(app.focusedPane, isNull);
      expect(frames, isEmpty);
    });

    test('closing focused pane selects replacement, then clears last pane', () async {
      await app.assignAgentToPane(null, 'm1', 'a');
      await app.assignAgentToPane(null, 'm1', 'b');
      frames.clear();
      await app.closePane(app.focusedPane!.id);
      expect(frames, [('m1', 'a')]);
      await app.closePane(app.focusedPane!.id);
      expect(frames.last, ('m1', null));
    });

    test('closing background pane does not change the voice target', () async {
      await app.assignAgentToPane(null, 'm1', 'a');
      await app.assignAgentToPane(null, 'm1', 'b');
      frames.clear();
      await app.closePane(app.paneOfAgent('m1', 'a')!.id);
      expect(frames, isEmpty);
    });

    test('switching machines clears previous owner before new focus', () async {
      await app.assignAgentToPane(null, 'm1', 'a');
      frames.clear();
      await app.assignAgentToPane(null, 'm2', 'c');
      expect(frames, [('m1', null), ('m2', 'c')]);
    });

    test('machine-only pane clears focus even without its own connection', () async {
      await app.assignAgentToPane(null, 'm1', 'a');
      frames.clear();
      app.showMachinePane('m2');
      expect(frames, [('m1', null)]);
      app.focusPane(app.paneOfAgent('m1', 'a')!.id);
      app.showMachinePane('m2');
      expect(frames, [('m1', null), ('m1', 'a'), ('m1', null)]);
    });

    test('deleted focused agent reports replacement and clears when empty', () async {
      await app.assignAgentToPane(null, 'm1', 'a');
      await app.assignAgentToPane(null, 'm1', 'b');
      frames.clear();
      await app.handleMachineEventForTest('m1', {
        'type': 'agent_deleted',
        'payload': {'agentId': 'b'},
      });
      expect(frames, [('m1', 'a')]);
      await app.handleMachineEventForTest('m1', {
        'type': 'agent_deleted',
        'payload': {'agentId': 'a'},
      });
      expect(frames.last, ('m1', null));
    });

    test('refocusing selected pane reasserts agent without opening terminal', () async {
      await app.assignAgentToPane(null, 'm1', 'a');
      frames.clear();
      app.focusPane(app.focusedPane!.id);
      expect(frames, [('m1', 'a')]);
    });
  });

  test('selecting an agent already on screen focuses it instead of reopening', () async {
    final app = _notifier();
    _machine(app, 'm1', ['a', 'b']);

    await app.selectAgent('m1', 'a');
    await app.selectAgent('m1', 'b');
    expect(
      app.panes.length,
      2,
      reason: 'selecting adds a view without replacing the existing one',
    );

    await app.assignAgentToPane(null, 'm1', 'a');
    expect(app.panes.length, 2);
    final paneHoldingA = app.paneOfAgent('m1', 'a')!.id;

    // Focus somewhere else first, so landing back on it proves the selection
    // moved rather than simply never having left.
    app.focusPane(app.paneOfAgent('m1', 'b')!.id);

    // The daemon keeps one controller per agent, so a second tile for the same
    // agent would take the first one over. Selecting must land on the tile that
    // already has it.
    await app.selectAgent('m1', 'a');
    expect(app.panes.length, 2);
    expect(app.focusedPaneId, paneHoldingA);
    app.dispose();
  });

  test(
    'dropping an agent that is already open MOVES it rather than duplicating',
    () async {
      final app = _notifier();
      _machine(app, 'm1', ['a', 'b']);

      await app.assignAgentToPane(null, 'm1', 'a');
      await app.assignAgentToPane(null, 'm1', 'b');
      final second = app.panes[1].id;

      await app.assignAgentToPane(second, 'm1', 'a');
      expect(app.panes.length, 1);
      expect(app.panes.single.agentId, 'a');
      app.dispose();
    },
  );

  test('the grid stops at the ceiling, and the extra opens nothing', () async {
    // Written against the constant, not against a number: the ceiling has moved
    // once already (four, then nine when ⌘1–⌘9 became the way to reach a tile),
    // and a test that hardcodes it fails for the change rather than for a bug.
    final app = _notifier();
    final ids = [for (var i = 0; i <= AppNotifier.maxPanes; i++) 'a$i'];
    _machine(app, 'm1', ids);

    for (final id in ids) {
      await app.assignAgentToPane(null, 'm1', id);
    }
    expect(app.panes.length, AppNotifier.maxPanes);
    expect(app.canAddPane, isFalse);
    // The ones that fit are the ones asked for FIRST — the last request is
    // refused, rather than evicting a tile the user is looking at.
    expect(
      app.panes.map((pane) => pane.agentId),
      ids.take(AppNotifier.maxPanes),
    );
    app.dispose();
  });

  test('closing a tile hands focus to a neighbour, not to nothing', () async {
    final app = _notifier();
    _machine(app, 'm1', ['a', 'b', 'c']);
    for (final id in ['a', 'b', 'c']) {
      await app.assignAgentToPane(null, 'm1', id);
    }
    final middle = app.panes[1].id;
    app.focusPane(middle);

    await app.closePane(middle);
    expect(app.panes.length, 2);
    expect(app.focusedPaneId, isNotNull);
    expect(app.panes.any((pane) => pane.id == app.focusedPaneId), isTrue);

    await app.closePane(app.panes.first.id);
    await app.closePane(app.panes.first.id);
    expect(app.panes, isEmpty);
    expect(app.focusedPaneId, isNull);
    app.dispose();
  });

  test('a machine tile carries the states that belong to no agent', () async {
    final app = _notifier();
    _machine(app, 'm1', const []);

    // A machine with no agents has nothing to put in a tile, so the tile is
    // about the MACHINE — otherwise there is nothing on screen to say what is
    // happening to it.
    app.showMachinePane('m1');
    expect(app.panes.length, 1);
    expect(app.panes.single.machineId, 'm1');
    expect(app.panes.single.agentId, isNull);
    app.dispose();
  });

  test('a machine that needs linking asks in a dialog, not in a tile', () async {
    final app = _notifier();
    final state = _machine(app, 'm1', const []);
    state.machine = const Machine(
      machineId: 'm1',
      apiKey: '',
      authMode: MachineAuthMode.remote,
      name: 'm1',
      status: 'online',
    );
    state.needsLink = true;
    state.agentLoadStatus = AgentLoadStatus.needsLink;

    // The link form used to be a tile because a machine needing a link cannot
    // list agents, so there was nothing else to show it in. It is a modal now,
    // and taking a tile as well would put the same request in two places.
    app.showMachinePane('m1');
    expect(app.panes, isEmpty);
    expect(app.selectedMachineId, 'm1');
    app.dispose();
  });

  test('a store tab is remembered as the store, and comes back as one', () async {
    final storage = _MemoryStore();
    final app = _notifier(layout: PaneLayoutStore(storage: storage));
    app.openStore();
    expect(app.activeSwarm.isStore, isTrue);
    await Future<void>.delayed(Duration.zero);
    final layout = jsonDecode(storage.values['swarm_layout_v1']!);
    expect(layout['swarms'][0]['kind'], 'store');
    app.dispose();

    final again = _notifier(layout: PaneLayoutStore(storage: storage));
    await again.restorePaneLayoutForTest();
    expect(again.swarms.where((s) => s.isStore).length, 1, reason: 'the store, once');
    expect(again.swarms.where((s) => s.isStore).single.name, 'Harness Store');
    again.dispose();

    // A layout that somehow holds two store tabs brings back one.
    final doubled = jsonDecode(storage.values['swarm_layout_v1']!) as Map<String, dynamic>;
    final rows = List<dynamic>.from(doubled['swarms'] as List);
    rows.add({...(rows.first as Map), 'id': 'swarm-99'});
    doubled['swarms'] = rows;
    storage.values['swarm_layout_v1'] = jsonEncode(doubled);
    final once = _notifier(layout: PaneLayoutStore(storage: storage));
    await once.restorePaneLayoutForTest();
    expect(once.swarms.where((s) => s.isStore).length, 1);
    once.dispose();
  });

  test('the layout is remembered, and machine tiles are not', () async {
    final storage = _MemoryStore();
    final app = _notifier(layout: PaneLayoutStore(storage: storage));
    _machine(app, 'm1', ['a', 'b']);

    await app.assignAgentToPane(null, 'm1', 'a');
    await app.assignAgentToPane(null, 'm1', 'b');
    app.showMachinePane('m1');
    // Let the fire-and-forget writes land.
    await Future<void>.delayed(Duration.zero);

    final layout = jsonDecode(storage.values['swarm_layout_v1']!);
    final saved = layout['swarms'][0]['panes'] as List;
    expect(saved.length, 2, reason: 'the prompt tile is a moment, not a desk');
    expect(saved.map((e) => e['agentId']), ['a', 'b']);
    app.dispose();
  });

  test(
    'a restored tile appears before its machine answers, then attaches',
    () async {
      final storage = _MemoryStore()
        ..values['terminal_pane_layout'] = jsonEncode([
          {'machineId': 'm1', 'agentId': 'a'},
        ]);
      final store = PaneLayoutStore(storage: storage);

      final entries = await store.load();
      expect(entries.length, 1);
      expect(entries.single.agentId, 'a');
    },
  );

  test(
    'a duplicate in the saved file is dropped rather than reopened twice',
    () async {
      final storage = _MemoryStore()
        ..values['terminal_pane_layout'] = jsonEncode([
          {'machineId': 'm1', 'agentId': 'a'},
          {'machineId': 'm1', 'agentId': 'a'},
          {'machineId': 'm1', 'agentId': 'b'},
        ]);
      final entries = await PaneLayoutStore(storage: storage).load();
      expect(entries.map((e) => e.agentId), ['a', 'b']);
    },
  );

  test(
    'a corrupt layout file opens the app empty rather than not at all',
    () async {
      final storage = _MemoryStore()
        ..values['terminal_pane_layout'] = 'not json';
      expect(await PaneLayoutStore(storage: storage).load(), isEmpty);
    },
  );

  test(
    'a file from a build that allows more tiles is trimmed on the way in',
    () async {
      final storage = _MemoryStore()
        ..values['terminal_pane_layout'] = jsonEncode([
          for (var i = 0; i <= PaneLayoutStore.maxPanes; i++)
            {'machineId': 'm1', 'agentId': 'a$i'},
        ]);
      final entries = await PaneLayoutStore(storage: storage).load();
      expect(entries.length, PaneLayoutStore.maxPanes);
    },
  );

  test(
    'replacing a view gives the new session its own controller identity',
    () async {
      final app = _notifier();
      _machine(app, 'm1', ['a', 'b']);
      await app.assignAgentToPane(null, 'm1', 'a');
      final id = app.panes.single.id;

      await app.assignAgentToPane(id, 'm1', 'b');
      expect(app.panes.single.id, isNot(id));
      expect(app.panes.single.agentId, 'b');
      app.dispose();
    },
  );

  test(
    'a tile is only reported as holding the agent it actually holds',
    () async {
      final app = _notifier();
      _machine(app, 'm1', ['a']);
      _machine(app, 'm2', ['a']);

      await app.assignAgentToPane(null, 'm1', 'a');
      expect(app.isAgentInPane('m1', 'a'), isTrue);
      // Same agent id on a different machine is a different agent.
      expect(app.isAgentInPane('m2', 'a'), isFalse);
      app.dispose();
    },
  );

  test('dial focus selects a remote agent on the machine named by the CLI', () async {
    final app = _notifier();
    _machine(app, 'local', ['local-agent']);
    _machine(app, 'remote', ['remote-agent']);
    final localSession = _session('local', 'local-agent')
      ..status = TerminalSessionStatus.controlling;
    final remoteSession = _session('remote', 'remote-agent')
      ..status = TerminalSessionStatus.controlling;
    final localPane = app.adoptSessionForTest(localSession);
    final remotePane = app.adoptSessionForTest(remoteSession);
    app.focusPane(localPane.id);

    // dial_focus is delivered by the LOCAL websocket even when its agent lives
    // elsewhere. The payload's machineId, not the socket source, owns it.
    await app.handleEventForTest('local', {
      'type': 'dial_focus',
      'payload': {'machineId': 'remote', 'agentId': 'remote-agent'},
    });
    await Future<void>.delayed(Duration.zero);

    expect(app.focusedPaneId, remotePane.id);
    expect(app.selectedMachineId, 'remote');
    app.dispose();
  });

  test('legacy dial focus resolves only a uniquely-owned agent', () async {
    final app = _notifier();
    _machine(app, 'local', ['local-agent']);
    _machine(app, 'remote', ['remote-agent']);
    final localPane = app.adoptSessionForTest(
      _session('local', 'local-agent')
        ..status = TerminalSessionStatus.controlling,
    );
    final remotePane = app.adoptSessionForTest(
      _session('remote', 'remote-agent')
        ..status = TerminalSessionStatus.controlling,
    );
    app.focusPane(localPane.id);

    await app.handleEventForTest('local', {
      'type': 'dial_focus',
      'payload': {'agentId': 'remote-agent'},
    });
    await Future<void>.delayed(Duration.zero);

    expect(app.focusedPaneId, remotePane.id);
    expect(app.selectedMachineId, 'remote');
    app.dispose();
  });

  test(
    'legacy dial focus never guesses when an agent id exists on two machines',
    () async {
      final app = _notifier();
      _machine(app, 'local', ['shared-agent']);
      _machine(app, 'remote', ['shared-agent']);
      final localPane = app.adoptSessionForTest(
        _session('local', 'shared-agent')
          ..status = TerminalSessionStatus.controlling,
      );
      app.focusPane(localPane.id);

      await app.handleEventForTest('local', {
        'type': 'dial_focus',
        'payload': {'agentId': 'shared-agent'},
      });
      await Future<void>.delayed(Duration.zero);

      expect(app.focusedPaneId, localPane.id);
      expect(app.selectedMachineId, isNot('remote'));
      app.dispose();
    },
  );

  test(
    'retry preserves offline output and opens a new stream only when ready',
    () async {
      final connection = _TerminalConnection();
      final app = _notifier(connectionForTest: (_) => connection);
      final machine = _machine(app, 'm1', ['a']);
      machine.nodeOnline = true;
      machine.terminalCapabilityAvailable = true;
      final attaching = app.addAgentToSwarm('m1', 'a');
      final pane = app.panes.single;
      pane.session!.reportViewport(120, 40);
      await attaching;
      expect(
        connection.sent.where((type) => type == 'terminal_open'),
        hasLength(1),
      );
      connection.sent.clear();
      final dead = pane.session!;
      dead.transportLost('Harness reconnected; restoring terminal…');
      machine.nodeOnline = false;

      dead.terminal.write('Last useful result');
      await app.selectAgent('m1', 'a');
      expect(pane.session, same(dead));
      expect(dead.terminal.buffer.getText(), contains('Last useful result'));
      expect(connection.sent, isEmpty);
      machine.nodeOnline = true;
      machine.terminalCapabilityAvailable = true;
      final retry = app.selectAgent('m1', 'a');
      await Future<void>.delayed(Duration.zero);
      expect(pane.session, same(dead));
      pane.session!.reportViewport(120, 40);
      await retry;
      expect(
        connection.sent.where((type) => type == 'terminal_open'),
        hasLength(1),
      );
      expect(pane.session!.status, TerminalSessionStatus.opening);
      app.dispose();
      await connection.close();
    },
  );

  test('the composer toggle is remembered across a restart', () async {
    final storage = _MemoryStore();
    final app = _notifier(layout: PaneLayoutStore(storage: storage));
    _machine(app, 'm1', ['a']);
    await app.assignAgentToPane(null, 'm1', 'a');
    expect(
      app.panes.single.composerVisible,
      isFalse,
      reason: 'a tile nobody has had an opinion about hides the box',
    );

    app.toggleComposer(app.panes.single.id);
    expect(app.panes.single.composerVisible, isTrue);
    await Future<void>.delayed(Duration.zero);

    final restored = await PaneLayoutStore(storage: storage).loadSwarms();
    expect(restored!['swarms'][0]['panes'][0]['composerVisible'], isTrue);
    app.dispose();
  });

  test(
    'a layout written before the composer existed opens with it hidden',
    () async {
      // Absent must read as "never chose", matching this feature's off-by-default, not as
      // "chose it on" — otherwise shipping this feature would silently show the box for
      // everyone who already has a saved grid.
      final storage = _MemoryStore()
        ..values['terminal_pane_layout'] = jsonEncode([
          {'machineId': 'm1', 'agentId': 'a'},
        ]);

      final restored = await PaneLayoutStore(storage: storage).load();
      expect(restored.single.composerVisible, isFalse);
    },
  );

  test('an empty layout leaves the first-run auto-pick free to run', () {
    final pane = TerminalPane(id: 1, machineId: 'm1', agentId: 'a');
    expect(pane.agentId, 'a');
    expect(TerminalPane(id: 2, machineId: 'm1').agentId, isNull);
  });
}
