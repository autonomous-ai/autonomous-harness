import 'dart:async';

import 'package:file_selector_platform_interface/file_selector_platform_interface.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/codex_profiles.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/settings/settings_screen.dart';
import 'package:harness/shared/widgets/app_select_field.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/widgets/codex_profile_field.dart';
import 'package:harness/widgets/new_agent_dialog.dart';
import 'package:harness/widgets/swarm_dialogs.dart';
import 'package:harness/widgets/terminal_composer.dart';

import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

class _ProfilesNotifier extends AppNotifier {
  _ProfilesNotifier()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );
  final pending = <String, Completer<Map<String, dynamic>>>{};
  @override
  Future<void> probeEngines(String machineId, {bool force = false}) async {}
  @override
  Future<Map<String, dynamic>> listCodexProfiles(
    String machineId, {
    Set<String> observedPaths = const {},
  }) => (pending[machineId] = Completer()).future;
}

class _PendingFolder extends FileSelectorPlatform {
  final answer = Completer<String?>();
  @override
  Future<String?> getDirectoryPath({
    String? initialDirectory,
    String? confirmButtonText,
  }) => answer.future;
}

Future<void> chord(
  WidgetTester tester,
  LogicalKeyboardKey key, {
  bool shift = false,
}) async {
  await tester.sendKeyDownEvent(LogicalKeyboardKey.meta);
  if (shift) await tester.sendKeyDownEvent(LogicalKeyboardKey.shift);
  await tester.sendKeyEvent(key);
  if (shift) await tester.sendKeyUpEvent(LogicalKeyboardKey.shift);
  await tester.sendKeyUpEvent(LogicalKeyboardKey.meta);
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 100));
}

void main() {
  testWidgets(
    'the picker walks and scrolls by keyboard and keeps its agent through live refreshes',
    (tester) async {
      final app = createApp();
      await mount(tester, app);
      await chord(tester, LogicalKeyboardKey.keyP);
      await tester.pump(const Duration(milliseconds: 200));
      for (var i = 0; i < 12; i++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
        await tester.pump();
      }
      await tester.pump();
      final selected = find.byWidgetPredicate(
        (w) => w is ListTile && w.selected,
      );
      expect(
        find.descendant(of: selected, matching: find.text('Agent 12')),
        findsOneWidget,
      );
      final row = tester.getRect(find.text('Agent 12'));
      final list = tester.getRect(find.byType(ListView));
      expect(row.top, greaterThanOrEqualTo(list.top));
      expect(row.bottom, lessThanOrEqualTo(list.bottom));
      final machine = app.machineStates['m']!;
      machine.agents = [
        const Agent(id: 'new', name: 'Discovered'),
        ...machine.agents,
      ];
      app.dismissError();
      await tester.pump();
      await tester.pump();
      expect(
        find.descendant(of: selected, matching: find.text('Agent 12')),
        findsOneWidget,
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump(const Duration(milliseconds: 200));
      expect(app.panes.single.agentId, 'a12');
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'welcome search supports readline selection and ignores an empty Return',
    (tester) async {
      final app = createApp();
      await mount(tester, app);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(app.panes, isEmpty);
      await tester.enterText(find.byType(TextField), 'Agent 1');
      await tester.pump();
      await tester.sendKeyDownEvent(LogicalKeyboardKey.control);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyN);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.control);
      await tester.pump();
      final selected = find.byWidgetPredicate(
        (w) => w is ListTile && w.selected,
      );
      expect(
        find.descendant(of: selected, matching: find.text('Agent 10')),
        findsOneWidget,
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(app.panes.single.agentId, 'a10');
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'close view and close swarm shortcuts keep shared sessions alive',
    (tester) async {
      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      final session = terminal('a0', []);
      app.adoptSessionForTest(session);
      final original = app.activeSwarm;
      app.newSwarm();
      await app.addAgentToSwarm('m', 'a0');
      await mount(tester, app);
      await chord(tester, LogicalKeyboardKey.keyW, shift: true);
      expect(app.swarms.length, 2);
      expect(app.panes, isEmpty);
      expect(original.panes.single.session, same(session));
      await chord(tester, LogicalKeyboardKey.keyW);
      expect(app.swarms.single, same(original));
      expect(app.panes.single.session, same(session));
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets('a remote compact pane exposes its message composer', (
    tester,
  ) async {
    final app = createApp();
    app.machineStates['m']!.nodeOnline = true;
    app.adoptSessionForTest(terminal('a0', []));
    await mount(tester, app);
    expect(find.byType(TerminalComposer), findsNothing);
    await tester.tap(find.byTooltip('Show message composer'));
    await tester.pump();
    expect(find.byType(TerminalComposer), findsOneWidget);
    await tester.tap(find.byTooltip('Hide message composer'));
    await tester.pump();
    expect(find.byType(TerminalComposer), findsNothing);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets('native Swarm commands cannot mutate the view behind Settings', (
    tester,
  ) async {
    const channel = MethodChannel('harness/swarm_tabs');
    final updates = <Map>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
      call,
    ) async {
      if (call.method == 'update') updates.add(call.arguments as Map);
      return null;
    });
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        channel,
        null,
      ),
    );
    Future<void> native(String method) {
      final result = Completer<void>();
      tester.binding.defaultBinaryMessenger.handlePlatformMessage(
        channel.name,
        const StandardMethodCodec().encodeMethodCall(MethodCall(method)),
        (_) => result.complete(),
      );
      return result.future;
    }

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
    final opening = native('settings');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byType(SettingsScreen), findsOneWidget);
    expect(updates.last['enabled'], isFalse);
    await native('new');
    await native('closeActive');
    expect(app.swarms.single.id, 'swarm-1');
    Navigator.of(tester.element(find.byType(SettingsScreen))).pop();
    await tester.pump(const Duration(milliseconds: 300));
    await opening;
    expect(updates.last['enabled'], isTrue);
    app.renameSwarm(app.activeSwarmId, 'Recover me');
    await app.closeSwarm(app.activeSwarmId);
    await tester.pump();
    final beforeExternal = app.activeSwarmId;
    expect(updates.last['canReopen'], isTrue);
    // Root app-menu dialogs enter outside SwarmScreen's own dialog helper.
    final external = showDialog<void>(
      context: tester.element(find.byType(SwarmScreen)),
      builder: (_) => const AlertDialog(title: Text('External menu dialog')),
    );
    await tester.pump(const Duration(milliseconds: 300));
    expect(updates.last['enabled'], isFalse);
    await native('new');
    await native('reopen');
    expect(app.swarms.single.id, beforeExternal);
    Navigator.of(tester.element(find.byType(AlertDialog))).pop();
    await tester.pump(const Duration(milliseconds: 300));
    await external;
    expect(updates.last['enabled'], isTrue);
    await native('reopen');
    await tester.pump();
    expect(app.swarms.single.name, 'Recover me');
    expect(updates.last['canReopen'], isFalse);
    await tester.pumpWidget(const SizedBox());
    projects.dispose();
    app.dispose();
  });

  testWidgets(
    'late profile discovery cannot cross a machine switch with identical observed paths',
    (tester) async {
      final app = _ProfilesNotifier();
      final selected = <LocalCodexProfile?>[];
      Widget host(String id) => MaterialApp(
        home: Scaffold(
          body: CodexProfileField(
            notifier: app,
            machineId: id,
            machineIsThisComputer: false,
            value: null,
            onChanged: selected.add,
          ),
        ),
      );
      await tester.pumpWidget(host('a'));
      await tester.pump();
      await tester.pumpWidget(host('b'));
      await tester.pump();
      app.pending['a']!.complete({
        'profiles': [
          {'path': '/old', 'label': 'Old'},
        ],
      });
      await tester.pump();
      expect(selected, isEmpty);
      app.pending['b']!.complete({
        'profiles': [
          {'path': '/new', 'label': 'New'},
        ],
      });
      await tester.pump();
      expect(selected.single?.path, '/new');
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'a folder picker result is discarded after switching away and back',
    (tester) async {
      final app = _ProfilesNotifier();
      for (final id in ['a', 'b']) {
        app.machineStates[id] = MachineState(
          Machine(machineId: id, authMode: MachineAuthMode.remote),
        )..localOnly = true;
      }
      final previous = FileSelectorPlatform.instance;
      final folder = _PendingFolder();
      FileSelectorPlatform.instance = folder;
      addTearDown(() => FileSelectorPlatform.instance = previous);
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => TextButton(
              onPressed: () =>
                  showNewAgentDialog(context, app, 'a', source: 'test'),
              child: const Text('Open'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await tester.pump(const Duration(milliseconds: 300));
      await tester.tap(find.text('Browse…'));
      await tester.pump();
      final field = find.byKey(const Key('new-agent-machine-field'));
      tester.widget<AppSelectField<String>>(field).onChanged('b');
      await tester.pump();
      tester.widget<AppSelectField<String>>(field).onChanged('a');
      await tester.pump();
      folder.answer.complete('/old-machine-folder');
      await tester.pump();
      expect(find.textContaining('/old-machine-folder'), findsNothing);
      expect(find.text('Browse…'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'Add project discards an old folder after switching away and back',
    (tester) async {
      final app = createApp();
      app.machineStates['m']!.localOnly = true;
      app.machineStates['other'] = MachineState(
        const Machine(machineId: 'other', authMode: MachineAuthMode.remote),
      );
      final previous = FileSelectorPlatform.instance;
      final folder = _PendingFolder();
      FileSelectorPlatform.instance = folder;
      addTearDown(() => FileSelectorPlatform.instance = previous);
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => TextButton(
              onPressed: () => showSwarmProjectDialog(context, app),
              child: const Text('Open'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await tester.pump(const Duration(milliseconds: 200));
      await tester.tap(find.text('Choose folder'));
      await tester.pump();
      final field = find.byType(AppSelectField<String>);
      tester.widget<AppSelectField<String>>(field).onChanged('other');
      await tester.pump();
      tester.widget<AppSelectField<String>>(field).onChanged('m');
      await tester.pump();
      folder.answer.complete('/stale-folder');
      await tester.pump();
      expect(find.text('/stale-folder'), findsNothing);
      expect(find.text('Choose folder'), findsOneWidget);
      expect(
        tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
        isNull,
      );
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );
}
