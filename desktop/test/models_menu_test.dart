import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/widgets/agent_picker.dart';
import 'package:harness/shared/widgets/app_choice_picker.dart';
import 'package:harness/store/store_screen.dart';
import 'package:harness/core/config.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/usage/models_menu_controller.dart';
import 'package:harness/usage/usage_accounts.dart';
import 'package:harness/usage/usage_controller.dart';
import 'package:harness/usage/usage_source.dart';
import 'package:harness/usage/usage_window.dart';

import 'swarm_state_test.dart' show createApp;

/// Stands in for the machine behind the Open Grid door: the probes New Agent
/// makes answer at once, and the harness list says whether Grid is installed
/// there. Nothing is created — the door's job ends when New Agent is open on
/// the right machine with Grid chosen, or the Store is open on Grid's page.
class _GridApp extends AppNotifier {
  _GridApp({required this.grid})
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      ) {
    hasNavigationRail = false;
  }

  /// Per machine: true = Grid installed, false = listed but not installed,
  /// absent = the machine never heard of it.
  final Map<String, bool> grid;

  @override
  Future<void> probeEngines(String machineId, {bool force = false}) async {}

  @override
  Future<void> probeDsh(String machineId, {bool force = false}) async {
    final installed = grid[machineId];
    machineStates[machineId]!.dsh.replace([
      if (installed != null)
        DshEntry(
          id: AppNotifier.gridHarness,
          name: 'Grid',
          engine: 'codex',
          description: 'Talk to your fleet.',
          installed: installed,
        ),
    ]);
    notifyListeners();
  }

  @override
  Future<Map<String, dynamic>> listCodexProfiles(
    String machineId, {
    Set<String> observedPaths = const {},
  }) async => {'profiles': <dynamic>[]};
}

_GridApp _gridApp({
  required Map<String, bool> grid,
  bool secondMachine = false,
}) {
  final app = _GridApp(grid: grid);
  const machine = Machine(
    machineId: 'm',
    authMode: MachineAuthMode.remote,
    name: 'Test host',
  );
  app.machines = [machine];
  app.machineStates['m'] = MachineState(machine)
    ..localOnly = true
    ..nodeOnline = true
    ..agentLoadStatus = AgentLoadStatus.loaded;
  if (secondMachine) {
    const other = Machine(
      machineId: 'other',
      authMode: MachineAuthMode.remote,
      name: 'Studio',
    );
    app.machines = [machine, other];
    app.machineStates['other'] = MachineState(other)
      ..nodeOnline = true
      ..agentLoadStatus = AgentLoadStatus.loaded;
  }
  return app;
}

class _Source implements UsageSource {
  _Source(this.provider, this.answer);
  @override
  final UsageProvider provider;
  Future<ProviderUsage> Function() answer;
  int calls = 0;
  @override
  Future<ProviderUsage> read() {
    calls++;
    return answer();
  }
}

void main() {
  final instant = DateTime.utc(2026, 9, 13, 12);
  ProviderUsage reading({
    double session = 85,
    double weekly = 30,
    DateTime? reset,
    DateTime? fetched,
    String? account = 'aabbccddeeff0011',
  }) => ProviderUsage(
    provider: UsageProvider.claude,
    status: UsageStatus.ok,
    account: account,
    fetchedAt: fetched ?? instant,
    windows: [
      UsageWindow(label: 'Session', usedPercent: session, resetsAt: reset),
      UsageWindow(label: 'Weekly', usedPercent: weekly),
    ],
  );

  test(
    'remaining means the limiting window, with account deduplication',
    () async {
      final source = _Source(UsageProvider.claude, () async => reading());
      final usage = UsageController(
        sources: [source],
        autoStart: false,
        remote: () async => [
          MachineUsage(machineName: 'Shared Mac', readings: [reading()]),
          MachineUsage(
            machineName: 'Other Mac',
            readings: [reading(account: '1122334455667788', session: 50)],
          ),
        ],
      );
      final menu = ModelsMenuController(usage: usage, now: () => instant);
      addTearDown(usage.dispose);
      addTearDown(menu.dispose);
      await menu.refresh();
      expect(menu.rows, hasLength(2));
      expect(menu.rows.first['title'], 'Anthropic');
      expect(menu.rows.first['status'], '15% remaining');
      expect(menu.rows.first['details'], contains('Weekly — 70% remaining'));
      expect(menu.rows.first['account'], 'aabbcc');
      expect(menu.rows.toString(), isNot(contains('Shared Mac')));
      expect(menu.rows.last['title'], 'Anthropic');
      expect(menu.rows.last['account'], '112233');
      expect(menu.rows.last['status'], '50% remaining');
      expect(menu.rows.toString(), isNot(contains('aabbccddeeff0011')));
    },
  );

  test(
    'no startup work; opening coalesces and caches requests for a minute',
    () async {
      var now = instant;
      var answer = Completer<ProviderUsage>();
      final source = _Source(UsageProvider.claude, () => answer.future);
      final usage = UsageController(sources: [source], autoStart: false);
      final menu = ModelsMenuController(usage: usage, now: () => now);
      addTearDown(usage.dispose);
      addTearDown(menu.dispose);
      expect(source.calls, 0);
      final first = menu.refresh();
      expect(menu.refresh(), same(first));
      expect(source.calls, 1);
      answer.complete(reading());
      await first;
      await menu.refresh();
      expect(source.calls, 1);
      now = now.add(const Duration(minutes: 1));
      answer = Completer<ProviderUsage>();
      final second = menu.refresh();
      expect(source.calls, 2);
      answer.complete(reading());
      await second;
    },
  );

  test('unidentified accounts do not invent an account label', () async {
    final source = _Source(
      UsageProvider.claude,
      () async => reading(account: null),
    );
    final usage = UsageController(sources: [source], autoStart: false);
    final menu = ModelsMenuController(usage: usage, now: () => instant);
    addTearDown(usage.dispose);
    addTearDown(menu.dispose);
    await menu.refresh();
    expect(menu.rows.single['title'], 'Anthropic');
    expect(menu.rows.single['account'], '');
  });

  test(
    'unknown, expired and invalid readings never become made-up percentages',
    () async {
      ProviderUsage value = const ProviderUsage(
        provider: UsageProvider.claude,
        status: UsageStatus.signedOut,
      );
      var now = instant;
      final source = _Source(UsageProvider.claude, () async => value);
      final usage = UsageController(sources: [source], autoStart: false);
      final menu = ModelsMenuController(usage: usage, now: () => now);
      addTearDown(usage.dispose);
      addTearDown(menu.dispose);
      await menu.refresh();
      expect(menu.rows.single['status'], 'Not signed in');
      for (final next in [
        reading(reset: instant),
        reading(session: double.nan),
        reading(fetched: instant.subtract(const Duration(minutes: 3))),
      ]) {
        value = next;
        now = now.add(const Duration(minutes: 1));
        await menu.refresh();
        expect(menu.rows.single['status'], 'Usage unavailable');
        expect(menu.rows.single['details'].toString(), isNot(contains('%')));
      }
    },
  );

  test(
    'a positive fraction of remaining usage is not rounded to zero',
    () async {
      final source = _Source(
        UsageProvider.claude,
        () async => reading(session: 99.6),
      );
      final usage = UsageController(sources: [source], autoStart: false);
      final menu = ModelsMenuController(usage: usage, now: () => instant);
      addTearDown(usage.dispose);
      addTearDown(menu.dispose);
      await menu.refresh();
      expect(menu.rows.single['status'], '<1% remaining');
    },
  );

  test(
    'source errors and a late response after disposal are contained',
    () async {
      final answer = Completer<ProviderUsage>();
      final source = _Source(UsageProvider.codex, () => answer.future);
      final usage = UsageController(sources: [source], autoStart: false);
      final menu = ModelsMenuController(usage: usage, now: () => instant);
      addTearDown(usage.dispose);
      var notifications = 0;
      menu.addListener(() => notifications++);
      final request = menu.refresh();
      menu.dispose();
      final count = notifications;
      answer.completeError(StateError('synthetic secret must not reach UI'));
      await request;
      expect(notifications, count);
    },
  );

  testWidgets(
    'native Models opens lazily without changing the swarm or search',
    (tester) async {
      const channel = MethodChannel('harness/swarm_tabs');
      final messenger = tester.binding.defaultBinaryMessenger;
      final messages = <MethodCall>[];
      messenger.setMockMethodCallHandler(channel, (call) async {
        messages.add(call);
        return true;
      });
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
      final source = _Source(
        UsageProvider.codex,
        () async => const ProviderUsage(
          provider: UsageProvider.codex,
          status: UsageStatus.signedOut,
        ),
      );
      final usage = UsageController(sources: [source], autoStart: false);
      final menu = ModelsMenuController(usage: usage);
      final app = createApp();
      final original = app.activeSwarmId;
      final projects = SwarmProjectStore();
      await tester.pumpWidget(
        MaterialApp(
          home: SwarmScreen(
            notifier: app,
            nativeTabs: true,
            projectStore: projects,
            modelsMenu: menu,
          ),
        ),
      );
      expect(source.calls, 0);
      final previousUpdates = messages
          .where((c) => c.method == 'update')
          .length;
      final reply = Completer<void>();
      messenger.handlePlatformMessage(
        channel.name,
        const StandardMethodCodec().encodeMethodCall(
          const MethodCall('modelsOpened'),
        ),
        (_) => reply.complete(),
      );
      await reply.future;
      await tester.pump();
      expect(source.calls, 1);
      expect(app.activeSwarmId, original);
      expect(
        messages.where((c) => c.method == 'update').length,
        previousUpdates,
      );
      expect(messages.where((c) => c.method == 'closeSearch'), isEmpty);
      final snapshot =
          messages.lastWhere((c) => c.method == 'modelsState').arguments as Map;
      expect((snapshot['subscriptions'] as List).single['title'], 'OpenAI');
      expect(
        (snapshot['subscriptions'] as List).single['status'],
        'Not signed in',
      );
      await tester.pumpWidget(const SizedBox());
      expect(
        (messages.lastWhere((c) => c.method == 'modelsState').arguments
            as Map)['subscriptions'],
        isEmpty,
      );
      menu.dispose();
      usage.dispose();
      app.dispose();
      projects.dispose();
    },
  );

  /// Mount the swarm screen on [app] and send the native Models menu's
  /// `runLocalModel` command, with or without a machine.
  Future<void> openGridDoor(
    WidgetTester tester,
    _GridApp app, {
    String? machineId,
  }) async {
    tester.view.physicalSize = const Size(1200, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    const channel = MethodChannel('harness/swarm_tabs');
    final messenger = tester.binding.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, (call) async => true);
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
    final projects = SwarmProjectStore();
    addTearDown(projects.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: SwarmScreen(
          notifier: app,
          nativeTabs: true,
          projectStore: projects,
        ),
      ),
    );
    final reply = Completer<void>();
    messenger.handlePlatformMessage(
      channel.name,
      const StandardMethodCodec().encodeMethodCall(
        MethodCall(
          'runLocalModel',
          machineId == null ? null : {'machineId': machineId},
        ),
      ),
      (_) => reply.complete(),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('native runLocalModel opens New Agent with Grid chosen', (
    tester,
  ) async {
    // The Models menu's command arrives as a bare method call, the way Link
    // Machine… does. Grid is installed here, so the door is the Store's Open
    // button in another place: a draft tab, New Agent, Grid already chosen.
    final app = _gridApp(grid: {'m': true});
    await openGridDoor(tester, app);

    // The dialog is open (its title also names the tab and the start card).
    expect(find.byType(AgentPicker), findsOneWidget);
    final picker = tester.widget<AgentPicker>(find.byType(AgentPicker));
    expect(picker.value, AppNotifier.gridHarness);
    expect(app.activeSwarm.isStore, isFalse);
    expect(app.panes, isEmpty);

    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets('native runLocalModel with a machineId opens on THAT machine', (
    tester,
  ) async {
    // With two machines linked the native menu lists them and names the chosen
    // one: New Harness opens with that machine selected, so Grid manages the
    // models of the computer it runs on.
    final app = _gridApp(grid: {'m': true, 'other': true}, secondMachine: true);
    await openGridDoor(tester, app, machineId: 'other');

    expect(find.byType(AgentPicker), findsOneWidget);
    expect(
      tester.widget<AgentPicker>(find.byType(AgentPicker)).value,
      AppNotifier.gridHarness,
    );
    final machines = tester.widget<AppChoicePicker<String>>(
      find.byKey(const Key('new-agent-machine-field')),
    );
    expect(machines.value, 'other');

    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets("without Grid installed, the door is the Store on Grid's page", (
    tester,
  ) async {
    // No harness to open yet: the Store's page for Grid has Install, and that
    // is the way in. No New Harness, no pane.
    final app = _gridApp(grid: {'m': false});
    await openGridDoor(tester, app);

    expect(find.byType(AgentPicker), findsNothing);
    expect(app.activeSwarm.isStore, isTrue);
    expect(find.byType(StoreTab), findsOneWidget);
    expect(app.panes, isEmpty);

    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });
}
