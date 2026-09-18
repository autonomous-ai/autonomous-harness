import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_binary.dart';

import 'swarm_state_test.dart' show createApp;
import 'swarm_screen_test.dart' show terminal;

/// Records `deleteMachine` calls without touching the network. The real client
/// only builds its `Dio` lazily, so overriding the method keeps it offline.
class _RecordingApi extends ApiClient {
  _RecordingApi() : super(config: AppConfig.dev, session: AuthSession());
  final List<String> deleted = [];
  @override
  Future<void> deleteMachine({required String machineId}) async {
    deleted.add(machineId);
  }
}

void main() {
  test(
    'shared machines never enter the general machine connection path',
    () async {
      var requestedConnections = 0;
      final app = createApp(
        connectionForTest: (_) {
          requestedConnections++;
          throw StateError('A shared machine requested a full connection');
        },
      );
      const shared = Machine(
        machineId: 'shared',
        authMode: MachineAuthMode.remote,
        isShared: true,
      );
      app.machines.add(shared);
      app.machineStates['shared'] = MachineState(shared);
      await expectLater(app.listRemoteFolder('shared', '/'), throwsStateError);
      final restart = await app.restartAgent('shared', 'shared-agent');
      expect(restart.error, contains('view-only'));
      await app.gridModels('shared');
      expect(requestedConnections, 0);
      app.dispose();
    },
  );

  testWidgets(
    'shared machines expose only invited agents and carry a view-only owner label',
    (tester) async {
      const channel = MethodChannel('harness/swarm_tabs');
      final messages = <MethodCall>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
        call,
      ) async {
        messages.add(call);
        return true;
      });
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          null,
        ),
      );
      final app = createApp();
      final grant = SharedHarness(
        id: 'grant',
        agentId: 'shared-agent',
        name: 'Climate dashboard',
        expiresAt: DateTime(2027),
      );
      final shared = Machine(
        machineId: 'shared',
        authMode: MachineAuthMode.remote,
        name: 'Studio',
        isShared: true,
        ownerName: 'D',
        sharedHarnesses: [grant],
      );
      app.machines.add(shared);
      app.machineStates['shared'] = MachineState(shared)
        ..nodeOnline = true
        ..agentLoadStatus = AgentLoadStatus.loaded
        ..agents = [
          const Agent(
            id: 'shared-agent',
            name: 'Climate dashboard',
            terminalAvailable: true,
          ),
        ];
      final projects = SwarmProjectStore();
      await tester.pumpWidget(
        MaterialApp(
          home: SwarmScreen(
            notifier: app,
            nativeTabs: true,
            projectStore: projects,
          ),
        ),
      );
      await tester.pump();
      final state =
          messages.lastWhere((m) => m.method == 'machinesState').arguments
              as Map;
      final machines = state['machines'] as List;
      final row = machines.cast<Map>().firstWhere((m) => m['id'] == 'shared');
      expect(row['shared'], isTrue);
      expect(row['ownerName'], 'D');
      expect(row['linkRequired'], isFalse);
      expect(
        (row['agents'] as List).single,
        containsPair('id', 'shared-agent'),
      );
      expect((row['agents'] as List).single, containsPair('canOpen', true));
      expect(
        app.machineStates['shared']!.connectionStatus,
        ConnectionStatus.disconnected,
      );
      await tester.pumpWidget(const SizedBox());
      app.dispose();
      projects.dispose();
    },
  );
  testWidgets('tab navigation does not resend the agent inventory', (
    tester,
  ) async {
    const channel = MethodChannel('harness/swarm_tabs');
    final messages = <MethodCall>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
      call,
    ) async {
      messages.add(call);
      return true;
    });
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        channel,
        null,
      ),
    );
    final app = createApp();
    final machine = app.machineStates['m']!;
    machine.agents = [
      for (var i = 0; i < 512; i++)
        Agent(id: 'a$i', name: 'Agent $i', terminalAvailable: true),
    ];
    final first = app.activeSwarmId;
    app.adoptSessionForTest(terminal('a0', []));
    app.newSwarm(name: 'Second');
    final second = app.activeSwarmId;
    final projects = SwarmProjectStore();
    await tester.pumpWidget(
      MaterialApp(
        home: SwarmScreen(
          notifier: app,
          nativeTabs: true,
          projectStore: projects,
        ),
      ),
    );
    await tester.pump();
    List<List> inventories() => [
      for (final call in messages)
        if (call.arguments case {'machines': final List machines}) machines,
    ];
    expect((inventories().last.single as Map)['agents'], hasLength(512));
    messages.clear();
    for (var i = 0; i < 3; i++) {
      app.selectSwarm(first);
      await tester.pump();
      app.selectSwarm(second);
      await tester.pump();
    }
    expect(messages.where((call) => call.method == 'update'), isNotEmpty);
    expect(inventories(), isEmpty);

    // Changing one visible name still refreshes the menu, including when the
    // inventory list itself is retained by discovery.
    messages.clear();
    machine.agents[1] = machine.agents[1].copyWith(name: 'Renamed agent');
    app.notifyListeners();
    await tester.pump();
    expect(inventories(), hasLength(1));
    final refreshed = inventories().single.single as Map;
    expect((refreshed['agents'] as List)[1]['title'], 'Renamed agent');
    messages.clear();
    app.notifyListeners();
    await tester.pump();
    expect(inventories(), isEmpty);

    machine.agents[1] = const Agent(id: 'a1', name: 'Renamed agent');
    app.notifyListeners();
    await tester.pump();
    Map renamed() =>
        ((inventories().last.single as Map)['agents'] as List)[1] as Map;
    expect(renamed()['canOpen'], isFalse);
    final retained = app.adoptSessionForTest(terminal('a1', []));
    app.notifyListeners();
    await tester.pump();
    expect(renamed()['canOpen'], isTrue);
    await app.closePane(retained.id);
    await tester.pump();
    expect(renamed()['canOpen'], isFalse);

    await tester.pumpWidget(const SizedBox());
    expect(inventories().last, isEmpty);
    app.dispose();
    projects.dispose();
  });

  testWidgets(
    'machine submenu lists cached agents and opens an exact existing view',
    (tester) async {
      const channel = MethodChannel('harness/swarm_tabs');
      final messenger = tester.binding.defaultBinaryMessenger;
      final messages = <MethodCall>[];
      messenger.setMockMethodCallHandler(channel, (call) async {
        messages.add(call);
        return true;
      });
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
      final app = createApp();
      final input = <TerminalBinaryFrame>[];
      final original = app.activeSwarmId;
      final pane = app.adoptSessionForTest(terminal('a0', input));
      app.newSwarm(name: 'Second');
      final projects = SwarmProjectStore();
      await tester.pumpWidget(
        MaterialApp(
          home: SwarmScreen(
            notifier: app,
            nativeTabs: true,
            projectStore: projects,
          ),
        ),
      );
      await tester.pump();
      final snapshot =
          messages.lastWhere((c) => c.method == 'machinesState').arguments
              as Map;
      final machine = (snapshot['machines'] as List).single as Map;
      expect(machine['agentCount'], 70);
      final rows = machine['agents'] as List;
      expect(rows.first['id'], 'a0');
      expect(rows.first['title'], 'Agent 0');
      expect(rows.first['canOpen'], isTrue);
      final reply = Completer<void>();
      messenger.handlePlatformMessage(
        channel.name,
        const StandardMethodCodec().encodeMethodCall(
          const MethodCall('machineAgent', {'machineId': 'm', 'agentId': 'a0'}),
        ),
        (_) => reply.complete(),
      );
      await tester.pumpAndSettle();
      await reply.future;
      expect(app.activeSwarmId, original);
      expect(app.focusedPane, same(pane));
      expect(input, isEmpty);
      final stale = Completer<void>();
      messenger.handlePlatformMessage(
        channel.name,
        const StandardMethodCodec().encodeMethodCall(
          const MethodCall('machineAgent', {
            'machineId': 'm',
            'agentId': 'removed',
          }),
        ),
        (_) => stale.complete(),
      );
      await tester.pumpAndSettle();
      await stale.future;
      expect(app.focusedPane, same(pane));
      expect(app.swarms, hasLength(2));
      await tester.pumpWidget(const SizedBox());
      app.dispose();
      projects.dispose();
    },
  );
  testWidgets('deleteMachine confirms before dropping a remote machine', (
    tester,
  ) async {
    const channel = MethodChannel('harness/swarm_tabs');
    final messenger = tester.binding.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, (call) async => true);
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
    final app = createApp();
    final projects = SwarmProjectStore();
    await tester.pumpWidget(
      MaterialApp(
        home: SwarmScreen(
          notifier: app,
          nativeTabs: true,
          projectStore: projects,
        ),
      ),
    );
    await tester.pump();

    // The remote machine's row is deletable; the native menu drives this call.
    final reply = Completer<void>();
    messenger.handlePlatformMessage(
      channel.name,
      const StandardMethodCodec().encodeMethodCall(
        const MethodCall('deleteMachine', {'id': 'm'}),
      ),
      (_) => reply.complete(),
    );
    // The native reply is withheld until endOfFrame (focus handoff), so pump
    // first, then the dialog opens on the following frames.
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await reply.future;
    expect(find.text('Delete machine'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Delete'), findsOneWidget);

    // Cancelling leaves the machine in place.
    await tester.tap(find.text('Cancel'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('Delete machine'), findsNothing);
    expect(app.machineStates.containsKey('m'), isTrue);

    await tester.pumpWidget(const SizedBox());
    app.dispose();
    projects.dispose();
  });

  testWidgets('deleteMachine removes the machine once confirmed', (
    tester,
  ) async {
    const channel = MethodChannel('harness/swarm_tabs');
    final messenger = tester.binding.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, (call) async => true);
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
    final app = createApp();
    final api = _RecordingApi();
    app.api = api; // keep the delete off the network
    final projects = SwarmProjectStore();
    await tester.pumpWidget(
      MaterialApp(
        home: SwarmScreen(
          notifier: app,
          nativeTabs: true,
          projectStore: projects,
        ),
      ),
    );
    await tester.pump();

    final reply = Completer<void>();
    messenger.handlePlatformMessage(
      channel.name,
      const StandardMethodCodec().encodeMethodCall(
        const MethodCall('deleteMachine', {'id': 'm'}),
      ),
      (_) => reply.complete(),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await reply.future;
    expect(find.text('Delete machine'), findsOneWidget);

    // Confirming drops the machine from the client and the API.
    await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(api.deleted, ['m']);
    expect(app.machineStates.containsKey('m'), isFalse);
    expect(app.machines.any((m) => m.machineId == 'm'), isFalse);

    await tester.pumpWidget(const SizedBox());
    app.dispose();
    projects.dispose();
  });

  testWidgets('deleteMachine ignores this computer', (tester) async {
    const channel = MethodChannel('harness/swarm_tabs');
    final messenger = tester.binding.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, (call) async => true);
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
    final app = createApp();
    app.machineStates['m']!.localOnly = true; // this computer, not deletable
    final projects = SwarmProjectStore();
    await tester.pumpWidget(
      MaterialApp(
        home: SwarmScreen(
          notifier: app,
          nativeTabs: true,
          projectStore: projects,
        ),
      ),
    );
    await tester.pump();

    final reply = Completer<void>();
    messenger.handlePlatformMessage(
      channel.name,
      const StandardMethodCodec().encodeMethodCall(
        const MethodCall('deleteMachine', {'id': 'm'}),
      ),
      (_) => reply.complete(),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await reply.future;
    expect(find.text('Delete machine'), findsNothing);
    expect(app.machineStates.containsKey('m'), isTrue);

    await tester.pumpWidget(const SizedBox());
    app.dispose();
    projects.dispose();
  });

  testWidgets('machinesState reports presence and link state independently', (
    tester,
  ) async {
    const channel = MethodChannel('harness/swarm_tabs');
    final messenger = tester.binding.defaultBinaryMessenger;
    final messages = <MethodCall>[];
    messenger.setMockMethodCallHandler(channel, (call) async {
      messages.add(call);
      return true;
    });
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
    final app = createApp();
    final state = app.machineStates['m']!;
    final projects = SwarmProjectStore();
    await tester.pumpWidget(
      MaterialApp(
        home: SwarmScreen(
          notifier: app,
          nativeTabs: true,
          projectStore: projects,
        ),
      ),
    );
    await tester.pump();

    Map machine() =>
        ((messages.lastWhere((c) => c.method == 'machinesState').arguments
                        as Map)['machines']
                    as List)
                .single
            as Map;

    // Online + linked: presence shows "Online", trailing status drops out so
    // the agent count can fill the slot.
    state
      ..needsLink = false
      ..nodeOnline = true;
    app.notifyListeners();
    await tester.pump();
    expect(machine()['presence'], 'Online');
    expect(machine()['linkRequired'], isFalse);
    expect(machine()['status'], '');

    // Unlinked but the node is up: BOTH indicators are set — the whole point of
    // splitting them. Link state no longer masks presence.
    state.needsLink = true;
    app.notifyListeners();
    await tester.pump();
    expect(machine()['presence'], 'Online');
    expect(machine()['linkRequired'], isTrue);
    expect(machine()['status'], 'Link required');

    // Offline while agents are still cached (agentCount stays non-null): the
    // "Offline" presence must survive rather than being masked by the count in
    // the trailing slot.
    state
      ..needsLink = false
      ..nodeOnline = false;
    app.notifyListeners();
    await tester.pump();
    expect(machine()['presence'], 'Offline');
    expect(machine()['linkRequired'], isFalse);
    expect(machine()['status'], '');
    expect(machine()['agentCount'], 70); // cached agents remain

    await tester.pumpWidget(const SizedBox());
    app.dispose();
    projects.dispose();
  });
}
