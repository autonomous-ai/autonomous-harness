import 'support/new_agent_project.dart';

import 'dart:async';

import 'package:file_selector_platform_interface/file_selector_platform_interface.dart';
import 'package:flutter/material.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/codex_profiles.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/settings/settings_screen.dart';
import 'package:harness/shared/widgets/app_choice_picker.dart';
import 'package:harness/shared/widgets/app_select_field.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/codex_profile_field.dart';
import 'package:harness/widgets/new_agent_dialog.dart';
import 'package:harness/widgets/pane_header_actions.dart';
import 'package:harness/widgets/swarm_dialogs.dart';
import 'package:harness/widgets/terminal_find_bar.dart';

import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp, MemoryStore;

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
  for (final native in [false, true]) {
    testWidgets(
      'New Tab actions reuse the existing page (native: $native)',
      (tester) async {
        const channel = MethodChannel('harness/swarm_tabs');
        const codec = StandardMethodCodec();
        final messenger = tester.binding.defaultBinaryMessenger;
        messenger.setMockMethodCallHandler(channel, (_) async => true);
        addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
        final app = createApp();
        app.machineStates['m']!.nodeOnline = true;
        app.adoptSessionForTest(terminal('a0', []));
        final work = app.activeSwarmId;
        app.newSwarm();
        final starter = app.activeSwarmId;
        final projects = SwarmProjectStore(storage: MemoryStore());
        await tester.pumpWidget(
          MaterialApp(
            home: SwarmScreen(
              notifier: app,
              nativeTabs: native,
              projectStore: projects,
            ),
          ),
        );
        await tester.pumpAndSettle();

        Future<void> newFromChrome() async {
          if (!native) {
            await tester.tap(
              find.byKey(const ValueKey('swarm-new-tab-button')),
            );
            return;
          }
          var replied = false;
          messenger.handlePlatformMessage(
            channel.name,
            codec.encodeMethodCall(const MethodCall('new')),
            (_) => replied = true,
          );
          for (var i = 0; i < 5 && !replied; i++) {
            await tester.pump();
          }
          expect(replied, isTrue);
        }

        for (final action in <Future<void> Function()>[
          () => chord(tester, LogicalKeyboardKey.keyT),
          newFromChrome,
          () async {
            await chord(tester, LogicalKeyboardKey.keyP, shift: true);
            await tester.enterText(
              find.byKey(const ValueKey('swarm-search-input')),
              'New Tab',
            );
            await tester.pump();
            await tester.sendKeyEvent(LogicalKeyboardKey.enter);
          },
        ]) {
          app.selectSwarm(work);
          await tester.pumpAndSettle();
          await action();
          await tester.pumpAndSettle();
          expect(app.activeSwarmId, starter);
          expect(app.swarms, hasLength(2));
          await chord(tester, LogicalKeyboardKey.keyT);
          expect(app.activeSwarmId, starter);
          expect(app.swarms, hasLength(2));
          final input = tester.widget<TextField>(
            find.byKey(const ValueKey('harness-start-search')),
          );
          expect(input.focusNode!.hasFocus, isTrue);
          expect(
            find.byKey(const ValueKey('harness-start-results')),
            findsNothing,
          );
          tester.testTextInput.enterText('Agent 1');
          await tester.pump();
          expect(
            find.byKey(const ValueKey('harness-start-results')),
            findsOneWidget,
          );
          await tester.sendKeyEvent(LogicalKeyboardKey.escape);
          await tester.pump();
          expect(input.focusNode!.hasFocus, isFalse);
          await newFromChrome();
          await tester.pump();
          expect(app.activeSwarmId, starter);
          expect(app.swarms, hasLength(2));
          expect(input.focusNode!.hasFocus, isTrue);
          expect(
            find.byKey(const ValueKey('harness-start-results')),
            findsNothing,
          );
        }
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        projects.dispose();
      },
    );
  }

  testWidgets(
    'welcome opens the shared search and supports readline selection',
    (tester) async {
      final app = createApp();
      await mount(tester, app);
      await chord(tester, LogicalKeyboardKey.keyO);
      await tester.pump();
      expect(app.panes, isEmpty);
      await tester.enterText(
        find.byKey(const ValueKey('swarm-search-input')),
        'Agent 1',
      );
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

  testWidgets('pane controls zoom, confirm stopping and close only this view', (
    tester,
  ) async {
    final app = createApp();
    app.machineStates['m']!.nodeOnline = true;
    final input = <TerminalBinaryFrame>[];
    final session = terminal('a0', input);
    app.adoptSessionForTest(session);
    final original = app.activeSwarm;
    app.newSwarm();
    await app.addAgentToSwarm('m', 'a0');
    final pane = app.panes.single;
    app.adoptSessionForTest(terminal('a1', []));
    await mount(tester, app);

    final controls = find.byType(PaneHeaderActions).first;
    expect(
      find.descendant(of: controls, matching: find.byType(IconButton)),
      findsNWidgets(6),
    );
    expect(find.byTooltip('Stop Harness').first.hitTestable(), findsNothing);
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: const Offset(1, 1));
    Future<void> hover() async {
      await mouse.moveTo(tester.getCenter(controls));
      await tester.pump(const Duration(milliseconds: 120));
    }

    await hover();
    await tester.tap(find.byTooltip('Show message composer').first);
    await tester.pump();
    expect(pane.composerVisible, isTrue);
    await hover();
    await tester.tap(find.byTooltip('Hide message composer').first);
    await tester.pump();
    expect(pane.composerVisible, isFalse);
    await hover();
    await tester.tap(find.byTooltip('Zoom Pane').first);
    await tester.pump();
    expect(app.zoomedPaneId, pane.id);
    await hover();
    await tester.tap(find.byTooltip('Zoom Pane'));
    await tester.pump();
    expect(app.zoomedPaneId, isNull);
    await hover();

    await tester.tap(
      find.descendant(of: controls, matching: find.byTooltip('Stop Harness')),
    );
    await tester.pumpAndSettle();
    expect(find.text('Stop Harness'), findsNWidgets(2));
    expect(app.panes, contains(pane));
    expect(original.panes.single.session, same(session));
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(app.panes, contains(pane));
    await hover();

    await tester.tap(
      find.descendant(of: controls, matching: find.byTooltip('Close Pane')),
    );
    await tester.pump();
    await mouse.removePointer();
    expect(app.panes.single.agentId, 'a1');
    expect(original.panes.single.session, same(session));
    app.selectSwarm(original.id);
    await tester.pump();
    tester.testTextInput.enterText('x');
    await tester.pump(const Duration(milliseconds: 20));
    expect(
      String.fromCharCodes(
        input.where((f) => f.kind == TerminalBinaryKind.input).single.bytes,
      ),
      'x',
    );
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets(
    'native tab replies wait for destination focus and allow rename input',
    (tester) async {
      const channel = MethodChannel('harness/swarm_tabs');
      const codec = StandardMethodCodec();
      final messenger = tester.binding.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(channel, (_) async => true);
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
      final app = createApp();
      final input = <TerminalBinaryFrame>[];
      app.machineStates['m']!.nodeOnline = true;
      app.adoptSessionForTest(terminal('a0', input));
      final first = app.activeSwarmId;
      app.newSwarm();
      app.adoptSessionForTest(terminal('a1', input));
      final second = app.activeSwarmId;
      app.selectSwarm(first);
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

      Future<void> activate(String method, [Object? args]) async {
        final reply = Completer<void>();
        messenger.handlePlatformMessage(
          channel.name,
          codec.encodeMethodCall(MethodCall(method, args)),
          (bytes) {
            try {
              codec.decodeEnvelope(bytes!);
              reply.complete();
            } catch (error, stack) {
              reply.completeError(error, stack);
            }
          },
        );
        for (var frame = 0; frame < 5 && !reply.isCompleted; frame++) {
          await tester.pump();
        }
        expect(
          reply.isCompleted,
          isTrue,
          reason: '$method must acknowledge its visible result',
        );
        await reply.future;
      }

      await activate('select', {'id': second});
      expect(app.activeSwarmId, second);
      // No extra frame between the native acknowledgement and the first key.
      expect(tester.testTextInput.hasAnyClients, isTrue);
      tester.testTextInput.enterText('x');
      await tester.idle();
      expect(input.single.streamId, 'stream-a1');
      expect(String.fromCharCodes(input.single.bytes), 'x');
      await activate('rename', {'id': second});
      expect(find.text('Rename Tab'), findsOneWidget);
      final name = tester.widget<TextField>(find.byType(TextField));
      expect(name.focusNode!.hasPrimaryFocus, isTrue);
      tester.testTextInput.enterText('Keyboard work');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pump();
      expect(app.activeSwarm.name, 'Keyboard work');
      expect(input, hasLength(1));

      await activate('close', {'id': second});
      expect(app.activeSwarmId, first);
      expect(tester.testTextInput.hasAnyClients, isTrue);
      tester.testTextInput.enterText('y');
      await tester.idle();
      expect(input.last.streamId, 'stream-a0');
      expect(String.fromCharCodes(input.last.bytes), 'y');
      await activate('close', {'id': first});
      expect(app.swarms, hasLength(1));
      expect(app.panes, isEmpty);
      expect(app.activeSwarmId, isNot(anyOf(first, second)));
      expect(
        find.byKey(const ValueKey('harness-start-search')),
        findsOneWidget,
      );
      final starter = app.activeSwarmId;
      await activate('new');
      expect(app.swarms, hasLength(1));
      expect(app.activeSwarmId, starter);
      expect(input, hasLength(2));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
      projects.dispose();
    },
  );

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
    await native('notifications');
    expect(find.text('Needs input'), findsNothing);
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
    final attention = native('notifications');
    await tester.pump();
    expect(find.text('Needs input'), findsOneWidget);
    expect(updates.last['enabled'], isFalse);
    await native('new');
    await native('notifications');
    expect(app.swarms.single.name, 'Recover me');
    expect(find.byType(Dialog), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    await attention;
    expect(updates.last['enabled'], isTrue);
    expect(updates.last['canFind'], isFalse);
    app.machineStates['m']!.nodeOnline = true;
    final session = terminal('a0', []);
    session.terminal.write('marker one\r\nmarker two\r\n');
    app.adoptSessionForTest(session);
    app.dismissError();
    await tester.pump();
    expect(updates.last['canFind'], isTrue);
    app.machineStates['m']!.nodeOnline = false;
    app.dismissError();
    await tester.pump();
    expect(
      updates.last['canFind'],
      isTrue,
      reason: 'Retained offline output stays searchable',
    );
    await native('findTerminal');
    await tester.pump();
    expect(find.byType(TerminalFindBar), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'marker');
    await tester.pump(const Duration(milliseconds: 10));
    final search = tester
        .widget<TerminalFindBar>(find.byType(TerminalFindBar))
        .search!;
    expect(search.count, 2);
    await native('findNext');
    await tester.pump();
    expect(search.selected, 1);
    await native('findPrevious');
    await tester.pump();
    expect(search.selected, 0);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    expect(find.byType(TerminalFindBar), findsNothing);
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
      await browseNewAgentProject(tester);
      await tester.pump();
      await tester.pump();
      final field = find.byKey(const Key('new-agent-machine-field'));
      tester.widget<AppChoicePicker<String>>(field).onChanged('b');
      await tester.pump();
      tester.widget<AppChoicePicker<String>>(field).onChanged('a');
      await tester.pump();
      folder.answer.complete('/old-machine-folder');
      await tester.pump();
      expect(find.textContaining('/old-machine-folder'), findsNothing);
      expect(find.text('New project'), findsOneWidget);
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
