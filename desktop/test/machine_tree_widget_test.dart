import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/machine_rail.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart';

class ReloadTrackingNotifier extends AppNotifier {
  int machineRefreshes = 0;
  final List<String> agentReloads = [];

  ReloadTrackingNotifier()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );

  @override
  Future<void> ensureCliDaemonReady() async {}

  @override
  Future<void> refreshMachines() async {
    machineRefreshes++;
  }

  @override
  Future<void> reloadMachineData(String machineId) async {
    agentReloads.add(machineId);
  }
}

void main() {
  const machine = Machine(
    machineId: 'machine-1',
    apiKey: '',
    authMode: MachineAuthMode.remote,
    name: 'prod-mac',
    status: 'online',
  );

  AppNotifier notifierWithTree() {
    final notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    final state = MachineState(machine)
      ..connectionStatus = ConnectionStatus.connected
      ..terminalCapabilityLoaded = true
      ..terminalCapabilityAvailable = true
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..agents = [
        Agent.fromJson({
          'id': 'parent',
          'sessionId': 'session-parent',
          'name': 'backend-api',
          'engine': 'codex',
          'status': 'busy',
          'terminal': {
            'runtimes': [
              {'backend': 'tmux', 'paneId': '%1'},
            ],
          },
        }),
        Agent.fromJson({
          'id': 'child',
          'sessionId': 'session-child',
          'parentAgentId': 'parent',
          'name': 'future-worker',
          'engine': 'engine-added-after-app-release',
          'status': 'active',
          'terminal': {
            'runtimes': [
              {'backend': 'tmux', 'paneId': '%2'},
            ],
          },
        }),
        Agent.fromJson({
          'id': 'herdr-only',
          'sessionId': 'session-herdr',
          'name': 'herdr-session',
          'engine': 'claude',
          'status': 'active',
          'terminal': {
            'runtimes': [
              {
                'backend': 'herdr',
                'endpointId': 'endpoint-a',
                'sessionName': 'default',
                'terminalId': 'terminal-a',
                'paneId': 'w1:p1',
              },
            ],
          },
        }),
      ];
    state.sessionAgentIds.addAll({
      'session-parent': 'parent',
      'session-child': 'child',
      'session-herdr': 'herdr-only',
    });
    notifier.machines = [machine];
    notifier.machineStates[machine.machineId] = state;
    notifier.expandedMachines.add(machine.machineId);
    return notifier;
  }

  AppNotifier notifierWithLoadState(
    AgentLoadStatus loadStatus, {
    String? error,
  }) {
    final notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    final state = MachineState(machine)
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = loadStatus
      // In production these two are always set together — see onLocalFailure
      // in app_state.dart — so a needsLink fixture must carry both, or the
      // caption row's link affordance (which reads the raw bool, the same
      // signal the root-cause fix operates on) would never see it.
      ..needsLink = loadStatus == AgentLoadStatus.needsLink
      ..agentsLoadError = error;
    notifier.machines = [machine];
    notifier.machineStates[machine.machineId] = state;
    notifier.expandedMachines.add(machine.machineId);
    return notifier;
  }

  test('reselecting the active agent keeps its terminal controller', () async {
    final notifier = notifierWithTree();
    final active =
        TerminalSession(
            machineId: machine.machineId,
            agentId: 'parent',
            agentName: 'backend-api',
            engineId: 'codex',
            send: (_, _) async => true,
            sendBinary: (_) async => true,
          )
          ..status = TerminalSessionStatus.controlling
          ..streamId = 'stream-active';
    notifier.adoptSessionForTest(active);

    await notifier.selectAgent(machine.machineId, 'parent');

    expect(notifier.activeTerminal, same(active));
    expect(active.streamId, 'stream-active');
    expect(notifier.stateOf(machine.machineId)?.activeAgentId, 'parent');
    notifier.dispose();
  });

  testWidgets('an empty machine offers a row, not a sentence and a button', (
    tester,
  ) async {
    // The empty state IS the list, with one row in it that would become an agent. What it must NOT be is
    // what it was: a 13.5px status line under an 11px machine caption — a sentence outranking its own
    // heading — over an accent-washed button that read as the primary action of the whole window for a
    // machine that is merely idle.
    final notifier = notifierWithLoadState(AgentLoadStatus.loaded);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(width: 320, child: MachineRail(notifier: notifier)),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('New agent…'), findsOneWidget);
    expect(find.text('no running agents'), findsNothing);
    // The old button read "New agent" flat, and it is the ellipsis that promises a dialog rather than an
    // agent appearing on the spot.
    expect(find.text('New agent'), findsNothing);
  });

  testWidgets('a machine that HAS agents is offered the same row, last', (
    tester,
  ) async {
    // The same problem one row further down: adding to a machine that already has agents was reachable
    // only through a `+` revealed on hover of the machine's caption, which nobody finds who does not
    // already know it is there.
    final notifier = notifierWithTree();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(width: 320, child: MachineRail(notifier: notifier)),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('backend-api'), findsOneWidget);
    expect(find.text('New agent…'), findsOneWidget);
    // …and LAST, because a row that would create the next agent has to stand where the next agent would.
    final rowY = tester.getTopLeft(find.text('New agent…')).dy;
    for (final name in ['backend-api', 'future-worker', 'herdr-session']) {
      expect(
        tester.getTopLeft(find.text(name)).dy,
        lessThan(rowY),
        reason: '$name should sit above the invitation',
      );
    }
  });

  testWidgets('renders one-line agent rows with engine identity', (
    tester,
  ) async {
    final notifier = notifierWithTree();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(width: 320, child: MachineRail(notifier: notifier)),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('prod-mac'), findsOneWidget);
    final machineIcon = tester.widget<Icon>(
      find.byKey(const ValueKey('machine-connection-icon')),
    );
    expect(machineIcon.color, AppPalette.online);
    expect(find.text('backend-api'), findsOneWidget);
    expect(find.text('future-worker'), findsOneWidget);
    expect(find.byKey(const ValueKey('engine-icon-codex')), findsOneWidget);
    expect(
      find.byKey(
        const ValueKey('engine-fallback-engine-added-after-app-release'),
      ),
      findsOneWidget,
    );
    expect(find.text('herdr-session'), findsOneWidget);
    expect(find.text('CTRL'), findsNothing);
    expect(find.text('active'), findsNothing);
    expect(find.text('busy'), findsNothing);
    expect(find.text('NO TMUX'), findsNothing);
    await tester.tap(find.text('herdr-session'));
    await tester.pump();
    expect(notifier.activeTerminal, isNull);
    expect(notifier.machineStates['machine-1']!.activeAgentId, isNull);
    notifier.dispose();
  });

  testWidgets('shows a gray computer icon when the machine is offline', (
    tester,
  ) async {
    final notifier = notifierWithTree();
    notifier.machineStates[machine.machineId]!.connectionStatus =
        ConnectionStatus.disconnected;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(width: 320, child: MachineRail(notifier: notifier)),
        ),
      ),
    );
    await tester.pump();

    final machineIcon = tester.widget<Icon>(
      find.byKey(const ValueKey('machine-connection-icon')),
    );
    expect(machineIcon.color, AppPalette.textFaint);
    notifier.dispose();
  });

  testWidgets(
    'shows a gray computer icon when nodeOnline is false even if the relay WS reports connected',
    (tester) async {
      final notifier = notifierWithTree();
      notifier.machineStates[machine.machineId]!
        ..connectionStatus = ConnectionStatus.connected
        ..nodeOnline = false;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(width: 320, child: MachineRail(notifier: notifier)),
          ),
        ),
      );
      await tester.pump();

      final machineIcon = tester.widget<Icon>(
        find.byKey(const ValueKey('machine-connection-icon')),
      );
      expect(machineIcon.color, AppPalette.textFaint);
      notifier.dispose();
    },
  );

  testWidgets(
    'shows a green icon and an always-visible link button when reachable but not yet linked',
    (tester) async {
      // The backend says the machine is up; only our own link to it is
      // missing. That reads as online — our socket bouncing off NO_PEER_LINK
      // says nothing about the other computer — and the fix is one click away
      // on the row itself, not hidden behind hover or a Link this machine… row
      // nobody expanded to.
      final notifier = notifierWithLoadState(AgentLoadStatus.needsLink);
      notifier.machineStates[machine.machineId]!
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.disconnected;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(width: 320, child: MachineRail(notifier: notifier)),
          ),
        ),
      );
      await tester.pump();

      final machineIcon = tester.widget<Icon>(
        find.byKey(const ValueKey('machine-connection-icon')),
      );
      expect(machineIcon.color, AppPalette.online);
      expect(find.text('offline'), findsNothing);
      final linkButton = find.byKey(const ValueKey('machine-link-affordance'));
      expect(linkButton, findsOneWidget);

      await tester.tap(linkButton);
      await tester.pump();
      expect(notifier.selectedMachineId, machine.machineId);
      notifier.dispose();
    },
  );

  testWidgets(
    'an unlinked machine of unknown reachability is offered a link but not called online',
    (tester) async {
      // NO_PEER_LINK is the local CLI's peer table saying no before anything is
      // dialled, so with no REST verdict yet there is nothing to paint green —
      // the machine may well be off. The link is still offered, as
      // _LinkMachineRow does, because "unknown" is not "off".
      final notifier = notifierWithLoadState(AgentLoadStatus.needsLink);
      notifier.machineStates[machine.machineId]!
        ..nodeOnline = null
        ..connectionStatus = ConnectionStatus.disconnected;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(width: 320, child: MachineRail(notifier: notifier)),
          ),
        ),
      );
      await tester.pump();

      final machineIcon = tester.widget<Icon>(
        find.byKey(const ValueKey('machine-connection-icon')),
      );
      expect(machineIcon.color, AppPalette.textFaint);
      expect(find.text('offline'), findsNothing);
      expect(
        find.byKey(const ValueKey('machine-link-affordance')),
        findsOneWidget,
      );
      notifier.dispose();
    },
  );

  testWidgets('marks and prioritizes this computer', (tester) async {
    const localMachine = Machine(
      machineId: 'machine-local',
      apiKey: '',
      authMode: MachineAuthMode.remote,
      name: 'this-mac',
      status: 'offline',
    );
    final notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    notifier.machines = [machine, localMachine];
    notifier.machineStates[machine.machineId] = MachineState(machine);
    notifier.machineStates[localMachine.machineId] = MachineState(localMachine)
      ..localOnly = true;

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(width: 320, child: MachineRail(notifier: notifier)),
        ),
      ),
    );
    await tester.pump();

    final localRow = find.byKey(const ValueKey('machine-row-machine-local'));
    final remoteRow = find.byKey(const ValueKey('machine-row-machine-1'));
    expect(
      tester.getTopLeft(localRow).dy,
      lessThan(tester.getTopLeft(remoteRow).dy),
    );
    // This computer and a machine across the network must not draw the same
    // mark — telling them apart is the whole job of the glyph, and a rail where
    // every row looks alike makes the user read names to find their own box.
    Icon markOf(Finder row) => tester.widget<Icon>(
      find.descendant(
        of: row,
        matching: find.byKey(const ValueKey('machine-connection-icon')),
      ),
    );
    expect(markOf(localRow).icon, isNot(markOf(remoteRow).icon));
    // The glyph carries the fact, so it still has to say so out loud for a
    // screen reader — the visible 'This computer' tooltip it replaced is gone.
    expect(
      tester
          .widget<Semantics>(
            find
                .ancestor(
                  of: find.descendant(
                    of: localRow,
                    matching: find.byKey(
                      const ValueKey('machine-connection-icon'),
                    ),
                  ),
                  matching: find.byType(Semantics),
                )
                .first,
          )
          .properties
          .label,
      'This computer',
    );
    notifier.dispose();
  });

  testWidgets('offline agent selection keeps the agent pending', (
    tester,
  ) async {
    final notifier = notifierWithTree();
    final state = notifier.machineStates[machine.machineId]!;
    state.nodeOnline = false;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(width: 320, child: MachineRail(notifier: notifier)),
        ),
      ),
    );
    await tester.tap(find.text('backend-api'));
    // Past the double-tap window, not just one frame: an agent row also takes a
    // double click (rename), so its single tap is only resolved once the second
    // one can no longer arrive. A bare pump() lands inside that window and sees
    // a row that has apparently done nothing.
    await tester.pump(kDoubleTapTimeout);

    expect(state.activeAgentId, 'parent');
    expect(state.pendingOfflineAgentId, 'parent');
    expect(notifier.activeTerminal, isNull);
    notifier.dispose();
  });

  testWidgets('turn lifecycle drives only the processing spinner', (
    tester,
  ) async {
    final notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      turnActivityTimeout: const Duration(milliseconds: 100),
    );
    final seeded = notifierWithTree();
    notifier.machines = seeded.machines;
    notifier.machineStates.addAll(seeded.machineStates);
    notifier.expandedMachines.addAll(seeded.expandedMachines);
    seeded.machineStates.clear();
    seeded.dispose();

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(width: 320, child: MachineRail(notifier: notifier)),
        ),
      ),
    );

    await notifier.handleEventForTest('machine-1', {
      'type': 'turn_heartbeat',
      'dbSessionId': 'session-parent',
      'payload': {'sessionId': 'session-parent'},
    });
    await tester.pump();
    expect(
      find.byKey(const ValueKey('agent-processing-indicator')),
      findsOneWidget,
    );

    await notifier.handleEventForTest('machine-1', {
      'type': 'turn_ended',
      'agentId': 'parent',
      'payload': {'agentId': 'parent'},
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 150));
    expect(
      find.byKey(const ValueKey('agent-processing-indicator')),
      findsNothing,
    );

    await notifier.handleEventForTest('machine-1', {
      'type': 'turn_started',
      'agentId': 'parent',
      'payload': {'agentId': 'parent'},
    });
    await tester.pump();
    expect(
      find.byKey(const ValueKey('agent-processing-indicator')),
      findsOneWidget,
    );
    await tester.pump(const Duration(milliseconds: 250));
    await tester.pump(const Duration(milliseconds: 150));
    expect(
      find.byKey(const ValueKey('agent-processing-indicator')),
      findsNothing,
    );
    notifier.dispose();
  });

  testWidgets(
    'retains lifecycle activity that arrives before the agent snapshot',
    (tester) async {
      final notifier = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        turnActivityTimeout: const Duration(seconds: 1),
      );
      final state = MachineState(machine)
        ..connectionStatus = ConnectionStatus.connected
        ..terminalCapabilityLoaded = true
        ..terminalCapabilityAvailable = true
        ..agentLoadStatus = AgentLoadStatus.loaded;
      notifier.machines = [machine];
      notifier.machineStates[machine.machineId] = state;
      notifier.expandedMachines.add(machine.machineId);

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(width: 320, child: MachineRail(notifier: notifier)),
          ),
        ),
      );

      await notifier.handleEventForTest(machine.machineId, {
        'type': 'turn_heartbeat',
        'dbSessionId': 'session-before-list',
        'payload': {'sessionId': 'session-before-list'},
      });
      await notifier.handleEventForTest(machine.machineId, {
        'type': 'agent_synced',
        'payload': {
          'agent': {
            'id': 'agent-before-list',
            'sessionId': 'session-before-list',
            'name': 'late-agent',
            'engine': 'claude',
            'terminal': {
              'runtimes': [
                {'backend': 'tmux', 'paneId': '%8'},
              ],
            },
          },
        },
      });
      await tester.pump();
      expect(
        find.byKey(const ValueKey('agent-processing-indicator')),
        findsOneWidget,
      );
      notifier.dispose();
    },
  );

  testWidgets('agent lifecycle updates rows without replacing the tree', (
    tester,
  ) async {
    final notifier = notifierWithTree();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(width: 320, child: MachineRail(notifier: notifier)),
        ),
      ),
    );

    await notifier.handleEventForTest('machine-1', {
      'type': 'agent_synced',
      'payload': {
        'agent': {
          'id': 'new-agent',
          'sessionId': 'new-session',
          'name': 'new-worker',
          'engine': 'claude',
          'terminal': {
            'runtimes': [
              {'backend': 'tmux', 'paneId': '%9'},
            ],
          },
        },
      },
    });
    await tester.pump();
    expect(find.text('new-worker'), findsOneWidget);
    expect(find.byKey(const ValueKey('engine-icon-claude')), findsNWidgets(2));

    await notifier.handleEventForTest('machine-1', {
      'type': 'agent_renamed',
      'payload': {'agentId': 'new-agent', 'name': 'renamed-worker'},
    });
    await tester.pump();
    expect(find.text('new-worker'), findsNothing);
    expect(find.text('renamed-worker'), findsOneWidget);

    await notifier.handleEventForTest('machine-1', {
      'type': 'agent_deleted',
      'payload': {'agentId': 'new-agent'},
    });
    await tester.pump();
    expect(find.text('renamed-worker'), findsNothing);
    notifier.dispose();
  });

  test('decrypted events preserve session correlation metadata', () {
    final clear = eventWithClearPayload(
      {
        'type': 'turn_started',
        'agentId': 'agent-1',
        'dbSessionId': 'session-1',
        'payload': {'__e2e': {}},
      },
      'turn_started',
      {'userMessage': 'hello'},
    );

    expect(clear['agentId'], 'agent-1');
    expect(clear['dbSessionId'], 'session-1');
    expect(clear['payload'], {'userMessage': 'hello'});
  });

  test('rename and delete update the selected terminal session', () async {
    final notifier = notifierWithTree();
    final state = notifier.machineStates[machine.machineId]!;
    final terminal = TerminalSession(
      machineId: machine.machineId,
      agentId: 'parent',
      agentName: 'backend-api',
      engineId: 'codex',
      send: (_, _) async => true,
      sendBinary: (_) async => true,
    );
    notifier.adoptSessionForTest(terminal);
    state.activeAgentId = 'parent';

    await notifier.handleEventForTest(machine.machineId, {
      'type': 'agent_renamed',
      'payload': {'agentId': 'parent', 'name': 'renamed-api'},
    });
    expect(terminal.agentName, 'renamed-api');
    expect(state.agents.first.name, 'renamed-api');

    await notifier.handleEventForTest(machine.machineId, {
      'type': 'agent_deleted',
      'payload': {'agentId': 'parent'},
    });
    expect(notifier.activeTerminal, isNull);
    expect(state.activeAgentId, isNull);
    expect(state.agents.any((agent) => agent.id == 'parent'), isFalse);
    notifier.dispose();
  });

  test(
    'renameAgent/deleteAgent reject an unknown machine or empty name',
    () async {
      final notifier = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );
      expect(
        await notifier.renameAgent('missing-machine', 'agent-1', 'new name'),
        'Machine not found',
      );
      expect(
        await notifier.deleteAgent('missing-machine', 'agent-1'),
        'Machine not found',
      );

      final seeded = notifierWithTree();
      notifier.machines = seeded.machines;
      notifier.machineStates.addAll(seeded.machineStates);
      seeded.machineStates.clear();
      seeded.dispose();

      expect(
        await notifier.renameAgent(machine.machineId, 'parent', '   '),
        'Name cannot be empty',
      );
      notifier.dispose();
    },
  );

  test('restartAgent rejects an unknown machine', () async {
    final notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    expect(
      (await notifier.restartAgent('missing-machine', 'agent-1')).error,
      'Machine not found',
    );
    notifier.dispose();
  });

  test('renameMachine rejects an unknown machine or empty name', () async {
    final notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    expect(
      await notifier.renameMachine('missing-machine', 'new name'),
      'Machine not found',
    );

    final seeded = notifierWithTree();
    notifier.machines = seeded.machines;
    notifier.machineStates.addAll(seeded.machineStates);
    seeded.machineStates.clear();
    seeded.dispose();

    expect(
      await notifier.renameMachine(machine.machineId, '   '),
      'Name cannot be empty',
    );
    notifier.dispose();
  });

  test('deleteMachine rejects an unknown machine', () async {
    final notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    expect(
      await notifier.deleteMachine('missing-machine'),
      'Machine not found',
    );
    notifier.dispose();
  });

  test(
    'node_status offline marks the active terminal transport lost',
    () async {
      final notifier = notifierWithTree();
      final state = notifier.machineStates[machine.machineId]!;
      final terminal = TerminalSession(
        machineId: machine.machineId,
        agentId: 'parent',
        agentName: 'backend-api',
        engineId: 'codex',
        send: (_, _) async => true,
        sendBinary: (_) async => true,
      );
      terminal.status = TerminalSessionStatus.controlling;
      notifier.adoptSessionForTest(terminal);

      // First "online" after boot is not a reconnect (nodeOnline starts
      // null) — nothing should happen to an already-controlling terminal.
      await notifier.handleEventForTest(machine.machineId, {
        'type': 'node_status',
        'payload': {'online': true},
      });
      expect(state.nodeOnline, isTrue);
      expect(terminal.status, TerminalSessionStatus.controlling);

      // The adapter drops (e.g. `harness stop`) while our own websocket to
      // the backend stays up — the terminal has nothing to reattach to.
      await notifier.handleEventForTest(machine.machineId, {
        'type': 'node_status',
        'payload': {'online': false},
      });
      expect(state.nodeOnline, isFalse);
      expect(state.pendingOfflineAgentId, 'parent');
      expect(terminal.status, TerminalSessionStatus.error);
      notifier.dispose();
    },
  );

  test('a mid-session NO_PEER_LINK marks the open terminal lost without calling the node offline', () async {
    // The CLI closes with 4404 when the peer revokes trust while terminals
    // are open. The socket drop that follows must no longer paint the
    // machine offline (NO_PEER_LINK is a local lookup, not a verdict on the
    // other computer) — but the tiles still have to know, and what they
    // showed still has to be recorded for the reattach after relinking.
    final notifier = notifierWithTree();
    final state = notifier.machineStates[machine.machineId]!..nodeOnline = true;
    final terminal = TerminalSession(
      machineId: machine.machineId,
      agentId: 'parent',
      agentName: 'backend-api',
      engineId: 'codex',
      send: (_, _) async => true,
      sendBinary: (_) async => true,
    )..status = TerminalSessionStatus.controlling;
    notifier.adoptSessionForTest(terminal);

    notifier.localFailureForTest(machine.machineId, 4404, 'peer revoked trust');

    expect(state.needsLink, isTrue);
    expect(state.agentLoadStatus, AgentLoadStatus.needsLink);
    expect(state.nodeOnline, isTrue);
    expect(state.pendingOfflineAgentId, 'parent');
    expect(terminal.status, TerminalSessionStatus.error);
    notifier.dispose();
  });

  test('collapse only changes the tree and does not close active terminal', () {
    final notifier = notifierWithTree();
    final terminal = TerminalSession(
      machineId: machine.machineId,
      agentId: 'parent',
      agentName: 'backend-api',
      engineId: 'codex',
      send: (_, _) async => true,
      sendBinary: (_) async => true,
    );
    notifier.adoptSessionForTest(terminal);

    notifier.toggleExpand(machine.machineId);

    expect(notifier.expandedMachines, isNot(contains(machine.machineId)));
    expect(identical(notifier.activeTerminal, terminal), isTrue);
    expect(terminal.status, TerminalSessionStatus.closed);
    notifier.dispose();
  });

  testWidgets('an unlinked machine that is offline is not offered a link', (
    tester,
  ) async {
    // Linking is a handshake with the daemon on the other computer. A daemon
    // that is not running cannot shake hands, so the row that starts it must
    // not exist while the machine is off — it would be a button for the
    // impossible. What shows instead names the state and what comes next.
    final notifier = notifierWithLoadState(AgentLoadStatus.needsLink);
    notifier.machineStates[machine.machineId]!.nodeOnline = false;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(width: 320, child: MachineRail(notifier: notifier)),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('Link this machine…'), findsNothing);
    expect(
      find.text("Harness isn't running on it · link when it's back"),
      findsOneWidget,
    );
    // …and the offline mark is a word on the caption, not a chip.
    expect(find.text('offline'), findsOneWidget);
    // Offline wins on the caption row too: no link button pretending the
    // handshake is one click away, and the icon reads exactly as offline.
    expect(find.byKey(const ValueKey('machine-link-affordance')), findsNothing);
    final machineIcon = tester.widget<Icon>(
      find.byKey(const ValueKey('machine-connection-icon')),
    );
    expect(machineIcon.color, AppPalette.textFaint);
    notifier.dispose();
  });

  testWidgets(
    'shows link-required, loading, and retryable agent error states',
    (tester) async {
      var notifier = notifierWithLoadState(AgentLoadStatus.needsLink);
      notifier.machineStates[machine.machineId]!.nodeOnline = true;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(width: 320, child: MachineRail(notifier: notifier)),
          ),
        ),
      );
      // A row, not a status line: the link is the step before this machine's
      // first agent, and it wears that row's shape. The old "link required" was
      // a condition dressed as a command.
      expect(find.text('Link this machine…'), findsOneWidget);
      expect(find.text('link required'), findsNothing);
      // The same fact is also on the caption row itself, not just the
      // expanded tree — a machine the backend calls up, merely unlinked, reads
      // as online, with its own one-click way to fix it right beside the name.
      final machineIcon = tester.widget<Icon>(
        find.byKey(const ValueKey('machine-connection-icon')),
      );
      expect(machineIcon.color, AppPalette.online);
      expect(
        find.byKey(const ValueKey('machine-link-affordance')),
        findsOneWidget,
      );
      final otherPane = notifier.adoptSessionForTest(
        TerminalSession(
          machineId: 'other-machine',
          agentId: 'other-agent',
          agentName: 'other-agent',
          engineId: 'codex',
          send: (_, _) async => true,
          sendBinary: (_) async => true,
        ),
      );
      await tester.tap(find.text('Link this machine…'));
      await tester.pump();
      expect(notifier.selectedMachineId, machine.machineId);
      // showMachinePane's own doc comment: a needsLink machine gets no tile
      // of its own (the blocking link dialog is the surface for it instead),
      // so selecting it must not steal focus from whatever pane is already
      // open — it stays the unrelated session adopted above.
      expect(notifier.activeTerminal, same(otherPane.session));
      notifier.dispose();

      notifier = notifierWithLoadState(AgentLoadStatus.loading);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(width: 320, child: MachineRail(notifier: notifier)),
          ),
        ),
      );
      // Rows-shaped placeholders, not a sentence: the real rows land where
      // these are, so nothing under the machine moves.
      expect(find.byKey(const ValueKey('agents-loading')), findsOneWidget);
      expect(find.text('loading agents…'), findsNothing);
      notifier.dispose();

      notifier = notifierWithLoadState(
        AgentLoadStatus.error,
        error: 'Could not load agents: disconnected',
      );
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(width: 320, child: MachineRail(notifier: notifier)),
          ),
        ),
      );
      expect(find.textContaining('Could not load agents'), findsOneWidget);
      expect(find.byTooltip('Retry agents'), findsOneWidget);
      notifier.dispose();
    },
  );

  testWidgets('keeps existing agents visible while refreshing', (tester) async {
    final notifier = notifierWithTree();
    notifier.machineStates[machine.machineId]!.agentsRefreshing = true;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(width: 320, child: MachineRail(notifier: notifier)),
        ),
      ),
    );

    expect(find.text('backend-api'), findsOneWidget);
    expect(find.byType(LinearProgressIndicator), findsOneWidget);
    notifier.dispose();
  });

  test(
    'global reload refreshes machines and every expanded agent tree',
    () async {
      final notifier = ReloadTrackingNotifier();
      notifier.expandedMachines.addAll(['machine-a', 'machine-b']);

      await notifier.retryMachines();

      expect(notifier.machineRefreshes, 1);
      expect(notifier.agentReloads, containsAll(['machine-a', 'machine-b']));
      notifier.dispose();
    },
  );
}
