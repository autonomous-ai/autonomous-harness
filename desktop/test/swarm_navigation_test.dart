import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/terminal/terminal_session.dart';

import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

void main() {
  test(
    'search matches project, branch, folder and machine in either word order',
    () {
      final app = createApp();
      addTearDown(app.dispose);
      app.machineStates['m']!.agents = [
        const Agent(
          id: 'auth',
          name: 'Auth',
          engine: 'codex',
          terminalAvailable: true,
          project: AgentProject(
            name: 'Payments',
            cwd: '/work/billing',
            branch: 'fix-login',
          ),
        ),
        const Agent(
          id: 'loose',
          name: 'A user testing harness',
          terminalAvailable: true,
        ),
      ];
      final catalog = swarmDestinations(app);
      for (final query in [
        'HOST auth',
        'auth host',
        'payments login',
        'billing auth',
        'ath',
      ]) {
        expect(
          rankSwarmDestinations(catalog, query).first.agentId,
          'auth',
          reason: query,
        );
      }
      expect(rankSwarmDestinations(catalog, 'AUTH').first.agentId, 'auth');
      expect(rankSwarmDestinations(catalog, 'missing project'), isEmpty);
    },
  );

  test('a shared agent has one result and prefers the current owner', () async {
    final app = createApp();
    addTearDown(app.dispose);
    await app.addAgentToSwarm('m', 'a0');
    final first = app.activeSwarmId;
    app.newSwarm();
    await app.addAgentToSwarm('m', 'a0');
    final rows = swarmDestinations(
      app,
      recent: [swarmDestinationId(first)],
    ).where((r) => r.agentId == 'a0');
    expect(rows, hasLength(1));
    expect(rows.single.swarmId, app.activeSwarmId);
    expect(rows.single.current, isTrue);
  });

  for (final status in [
    TerminalSessionStatus.controlling,
    TerminalSessionStatus.takenOver,
    TerminalSessionStatus.error,
  ]) {
    test(
      'jump preserves $status session and publishes destination focus atomically',
      () async {
        final app = createApp();
        addTearDown(app.dispose);
        final sent = <String>[];
        final session = TerminalSession(
          machineId: 'm',
          agentId: 'a0',
          agentName: 'Retained Auth',
          engineId: 'codex',
          send: (type, _) async {
            sent.add(type);
            return true;
          },
          sendBinary: (_) async => true,
        )..status = TerminalSessionStatus.controlling;
        session.terminal.write('retained scrollback\r\n');
        final target = app.adoptSessionForTest(session);
        final other = app.adoptSessionForTest(terminal('a1', []));
        app.toggleZoomPane();
        app.togglePinPane(target.id);
        final owner = app.activeSwarm;
        final order = [...owner.panes];
        final pins = Map.of(owner.pinnedSlots);
        final text = session.terminal.buffer.getText();
        app.newSwarm();
        session.status = status;
        final source = app.activeSwarm;
        final observations = <(String, int?)>[];
        app.addListener(
          () => observations.add((app.activeSwarmId, app.focusedPaneId)),
        );
        sent.clear();
        expect(app.revealAgentView('m', 'a0'), isTrue);
        await Future<void>.delayed(Duration.zero);
        expect(observations, [(owner.id, target.id)]);
        expect(owner.panes, order);
        expect(owner.pinnedSlots, pins);
        expect(owner.previousPaneId, other.id);
        expect(owner.zoomedPaneId, target.id);
        expect(source.panes, isEmpty);
        expect(target.session, same(session));
        expect(session.status, status);
        expect(session.terminal.buffer.getText(), text);
        expect(sent.where((s) => s.startsWith('terminal_')), isEmpty);
      },
    );
  }

  test('opening a swarm restores its saved focus and zoom', () async {
    final app = createApp();
    addTearDown(app.dispose);
    app.adoptSessionForTest(terminal('a0', []));
    final focused = app.adoptSessionForTest(terminal('a1', []));
    app.toggleZoomPane();
    final owner = app.activeSwarm;
    app.newSwarm();
    final destination = swarmDestinations(app)
        .firstWhere((r) => r.id == swarmDestinationId(owner.id));
    await activateSwarmDestination(
      app,
      destination,
      destinationSwarmId: app.activeSwarmId,
    );
    expect(app.focusedPaneId, focused.id);
    expect(app.zoomedPaneId, focused.id);
    expect(owner.panes, hasLength(2));
  });

  test('offline open work remains findable after its roster disappears', () {
    final app = createApp();
    addTearDown(app.dispose);
    final pane = app.adoptSessionForTest(terminal('a0', []));
    app.machineStates.clear();
    final row = rankSwarmDestinations(
      swarmDestinations(app),
      'session a0',
    ).firstWhere((r) => !r.isSwarm);
    expect(row.title, 'Session a0');
    expect(row.hasView, isTrue);
    expect(app.revealAgentView('m', 'a0'), isTrue);
    expect(app.focusedPaneId, pane.id);
  });

  test('a vanished existing view never turns into an Add action', () async {
    final app = createApp();
    addTearDown(app.dispose);
    await app.addAgentToSwarm('m', 'a0');
    final row = swarmDestinations(app).firstWhere((r) => r.agentId == 'a0');
    await app.closePane(app.panes.single.id);
    expect(
      await activateSwarmDestination(
        app,
        row,
        destinationSwarmId: app.activeSwarmId,
      ),
      isFalse,
    );
    expect(app.panes, isEmpty);
  });

  test('an explicit Open view captures its destination and reuses intervening work', () async {
    final app = createApp();
    addTearDown(app.dispose);
    final target = app.activeSwarm;
    final row = swarmDestinations(app).firstWhere((r) => r.agentId == 'a0');
    app.newSwarm();
    final elsewhere = app.activeSwarm;
    await activateSwarmDestination(app, row, destinationSwarmId: target.id);
    expect(target.panes.single.agentId, 'a0');
    expect(elsewhere.panes, isEmpty);
    // Selecting the old snapshot again must find that existing view.
    await activateSwarmDestination(app, row, destinationSwarmId: elsewhere.id);
    expect(app.activeSwarmId, target.id);
    expect(app.allPanes, hasLength(1));
    expect(elsewhere.panes, isEmpty);
  });

  test('recents return to previous work without notification churn or retained sessions', () async {
    final app = createApp();
    addTearDown(app.dispose);
    final history = SwarmNavigationHistory();
    app.addListener(() => history.record(app));
    await app.addAgentToSwarm('m', 'a0');
    final first = app.activeSwarm;
    app.newSwarm();
    await app.addAgentToSwarm('m', 'a1');
    final before = history.recent;
    for (var i = 0; i < 100; i++) {
      app.dismissError();
    }
    expect(history.recent, before);
    var rows = rankSwarmDestinations(
      swarmDestinations(app),
      '',
      recent: history.recent,
    );
    expect(rows.first.agentId, 'a0');
    await activateSwarmDestination(
      app,
      rows.first,
      destinationSwarmId: app.activeSwarmId,
    );
    rows = rankSwarmDestinations(
      swarmDestinations(app),
      '',
      recent: history.recent,
    );
    expect(rows.first.agentId, 'a1');
    await app.closeSwarm(first.id);
    rows = rankSwarmDestinations(
      swarmDestinations(app),
      '',
      recent: history.recent,
    );
    expect(rows.where((r) => r.id == swarmDestinationId(first.id)), isEmpty);
    expect(rows.first.hasView, isTrue);
    for (var i = 0; i < 80; i++) {
      app.newSwarm();
      await app.closeSwarm(app.activeSwarmId);
    }
    expect(
      history.recent.length,
      lessThanOrEqualTo(SwarmNavigationHistory.capacity),
    );
  });
}
