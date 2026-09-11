// What the dial turning to an agent does to the grid.
//
// The dial's carousel walks the window's tiles, in tile order, and nothing else — swipe is "the next
// pane". So a focus arriving from the dial is always about a tile that already exists, and it does what
// a click on the rail does.
//
// It used to be more than that. The ring carried on past either end of the desk into agents with no
// tile, and landing on one put it on the desk by REPLACING the tile at the end it was reached from —
// with the daemon naming that end (`edge`), since only it holds the flat list of every agent on every
// machine. That is gone, and so are the tests that pinned it; what survives here is the ordinary path
// and the notification verb beside it, which was always different.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/terminal_pane.dart';

AppNotifier _notifier() => AppNotifier(
  config: AppConfig.dev,
  authSession: AuthSession(),
  configStore: null,
);

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

List<String?> _desk(AppNotifier app) => [for (final p in app.panes) p.agentId];

Future<AppNotifier> _withTiles(List<String> agentIds) async {
  final app = _notifier();
  _machine(app, 'm1', ['a1', 'a2', 'a3', 'a4', 'a5']);
  for (final id in agentIds) {
    await app.assignAgentToPane(null, 'm1', id);
  }
  return app;
}

void main() {
  test('the roster the daemon builds its ring from is in tile order', () {
    // The section in the rail, the tile order on screen and the dial's carousel
    // are one list. This is the end of it the window owns: what it reports is
    // the order it draws, so the numbers beside the rail rows and the steps
    // under the thumb are the same walk.
    final app = _notifier();
    _machine(app, 'm1', ['a1', 'a2', 'a3']);
    app.panes.addAll([
      TerminalPane(id: 1, machineId: 'm1', agentId: 'a3'),
      TerminalPane(id: 2, machineId: 'm1', agentId: 'a1'),
    ]);
    expect(_desk(app), ['a3', 'a1']);
    app.dispose();
  });

  test('an agent that already has a tile is focused, never duplicated', () async {
    final app = await _withTiles(['a1', 'a2']);
    await app.selectAgentFromDial('m1', 'a1');

    // Two tiles before, two after — and the one holding it is the focused one.
    expect(_desk(app), ['a1', 'a2']);
    expect(app.focusedPane?.agentId, 'a1');
    app.dispose();
  });

  test(
    'an agent with no tile takes the focused one, replacing nothing at an edge',
    () async {
      // The carousel cannot reach this agent any more, but the pull-down switcher still names it and the
      // window is still told. What happens then is ordinary selection — the focused tile becomes it —
      // rather than the old rule, which chose a tile by which END of the desk the thumb had walked off.
      final app = await _withTiles(['a1', 'a2']);
      await app.selectAgentFromDial('m1', 'a3');

      expect(app.panes.length, 2);
      expect(app.focusedPane?.agentId, 'a3');
      app.dispose();
    },
  );

  test('with no tiles at all, one is opened', () async {
    final app = _notifier();
    _machine(app, 'm1', ['a1', 'a2']);
    await app.selectAgentFromDial('m1', 'a2');

    expect(_desk(app), ['a2']);
    app.dispose();
  });

  // ── a notification asks for a tile of its own ───────────────────────────────
  //
  // Turning the dial says where the eye is and a tile moves to match. Tapping a
  // notification is a different verb: the turn just FINISHED, so it is something
  // new to look at, not a replacement for what the person was already watching.
  test('a notification opens a NEW tile, leaving the others alone', () async {
    final app = await _withTiles(['a1', 'a2']);
    await app.openAgentFromDial('m1', 'a3');

    expect(_desk(app), ['a1', 'a2', 'a3']);
    expect(app.focusedPane?.agentId, 'a3');
    app.dispose();
  });

  test('at the ceiling it reuses the LAST tile rather than refusing', () async {
    // Refusing would make the notification a liar: it says there is something to
    // see and then does nothing when pressed. The last tile is already the place
    // the desk treats as where things arrive — it is what the dial's own right
    // edge replaces.
    final app = _notifier();
    _machine(app, 'm1', [
      for (var i = 0; i < AppNotifier.maxPanes + 1; i++) 'a$i',
    ]);
    for (var i = 0; i < AppNotifier.maxPanes; i++) {
      await app.assignAgentToPane(null, 'm1', 'a$i');
    }
    expect(app.canAddPane, isFalse);
    final untouched = [
      for (final p in app.panes.take(app.panes.length - 1)) p.agentId,
    ];

    await app.openAgentFromDial('m1', 'a${AppNotifier.maxPanes}');

    expect(app.panes.length, AppNotifier.maxPanes, reason: 'the grid holds');
    expect(app.panes.last.agentId, 'a${AppNotifier.maxPanes}');
    expect(
      [for (final p in app.panes.take(app.panes.length - 1)) p.agentId],
      untouched,
      reason: 'every other tile is where it was',
    );
    app.dispose();
  });

  test('a notification for a tile already open only focuses it', () async {
    final app = await _withTiles(['a1', 'a2', 'a3']);
    app.focusPane(app.panes.first.id);

    await app.openAgentFromDial('m1', 'a3');

    expect(_desk(app), ['a1', 'a2', 'a3'], reason: 'nothing opened twice');
    expect(app.focusedPane?.agentId, 'a3');
    app.dispose();
  });

  // ── the wire ────────────────────────────────────────────────────────────────
  //
  // Everything above calls the method directly, which proves the rule and
  // nothing about the frame that carries it. These drive the real `dial_focus`
  // frame through the app's own handler, because a typo in one string is
  // exactly how this feature would look installed and be inert — and that is
  // the failure that actually happened, twice, on the real dial.
  Future<void> dialFocus(AppNotifier app, String agentId) =>
      app.handleEventForTest('m1', {
        'type': 'dial_focus',
        'payload': {'machineId': 'm1', 'agentId': agentId},
      });

  test('a dial_focus frame for a tile that is open only moves the focus', () async {
    // Walking WITHIN the desk. The daemon sends no edge for these, and the grid
    // must not change at all — this is the swipe people make constantly.
    final app = await _withTiles(['a1', 'a2', 'a3']);
    app.focusPane(app.panes.first.id);
    await dialFocus(app, 'a3');

    expect(_desk(app), ['a1', 'a2', 'a3']);
    expect(app.focusedPane?.agentId, 'a3');
    app.dispose();
  });

  test('an edge from an older daemon is ignored, not obeyed', () async {
    // A daemon that predates this change still sends `edge` on its focus frames. The field is gone
    // here, and the frame must land as an ordinary selection rather than replacing a tile at an end
    // this build no longer has a rule for.
    final app = await _withTiles(['a2', 'a3', 'a4']);
    app.focusPane(app.panes.last.id);
    await app.handleEventForTest('m1', {
      'type': 'dial_focus',
      'payload': {'machineId': 'm1', 'agentId': 'a1', 'edge': 'head'},
    });

    expect(app.focusedPane?.agentId, 'a1');
    expect(_desk(app), ['a2', 'a3', 'a1']);
    app.dispose();
  });

  test(
    'a dial_open frame opens a tile, where dial_focus would replace one',
    () async {
      // The two verbs side by side, driven through the app's own handler: the same
      // agent, one frame each, and the grid ends up a different size.
      final app = await _withTiles(['a1', 'a2']);
      await app.handleEventForTest('m1', {
        'type': 'dial_open',
        'payload': {'machineId': 'm1', 'agentId': 'a4'},
      });
      expect(_desk(app), ['a1', 'a2', 'a4']);

      app.focusPane(app.panes.last.id);
      await dialFocus(app, 'a5');
      expect(_desk(app), [
        'a1',
        'a2',
        'a5',
      ], reason: 'focus replaces, open adds');
      app.dispose();
    },
  );

  test(
    'a focus replaces the FOCUSED tile, which is what a rail click does',
    () async {
      final app = await _withTiles(['a1', 'a2', 'a3']);
      app.focusPane(app.panes[1].id);
      await app.selectAgentFromDial('m1', 'a4');

      expect(_desk(app), ['a1', 'a4', 'a3']);
      app.dispose();
    },
  );
}
