import 'dart:async';

import 'package:file_selector_platform_interface/file_selector_platform_interface.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/widgets/app_choice_picker.dart';
import 'package:harness/widgets/agent_picker.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:xterm/xterm.dart';

import 'support/agent_picker.dart';

import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_interactions_test.dart' show chord;
import 'keymap_host_test.dart' show MemoryKeymap;
import 'keymap_runtime_test.dart' as runtime;

final _newHarness = find.byKey(const ValueKey('harness-start-new'));
final _localProject = find.byKey(const Key('new-agent-project-browse'));
final _newProject = find.byKey(const Key('new-agent-folder-newProject'));

FocusNode _localFocus(WidgetTester tester) =>
    Focus.of(tester.element(find.text('Existing folder')));

Future<void> _browseLocal(WidgetTester tester) async {
  await tester.ensureVisible(_localProject);
  await tester.tap(_localProject);
}

final _startInput = find.byKey(const ValueKey('harness-start-search'));

class _FirstUseApp extends AppNotifier {
  _FirstUseApp()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      ) {
    hasNavigationRail = false;
    const machine = Machine(
      machineId: 'm',
      name: 'My computer',
      authMode: MachineAuthMode.remote,
    );
    machines = [machine];
    machineStates['m'] = MachineState(machine)
      ..localOnly = true
      ..nodeOnline = true
      ..agentLoadStatus = AgentLoadStatus.loaded;
  }

  Completer<void>? probe;
  var probes = 0;
  Completer<String?>? creation;
  final launches =
      <({String machine, String engine, String folder, bool bypass})>[];
  final input = <TerminalBinaryFrame>[];

  @override
  Future<void> probeEngines(String machineId, {bool force = false}) async {
    probes++;
    await probe?.future;
  }

  @override
  Future<String?> createAgent(
    String machineId, {
    required String engine,
    required String? folder,
    ProjectFolderRequest? projectFolder,
    bool bypassPermission = false,
    String? permissionMode,
    String? codexHome,
    String? dsh,
    String? prompt,
    String? name,
    String? agent,
    String? swarmId,
    PaneSplitRequest? split,
    AgentCreationAttempt? attempt,
  }) async {
    launches.add((
      machine: machineId,
      engine: engine,
      folder: folder!,
      bypass: bypassPermission,
    ));
    if (creation != null) {
      final error = await creation!.future;
      if (error != null) return error;
    }
    adoptSessionForTest(terminal('created', input));
    notifyListeners();
    return null;
  }
}

class _FolderPicker extends FileSelectorPlatform {
  var opened = 0;
  Completer<String?>? pending;
  @override
  Future<String?> getDirectoryPath({
    String? initialDirectory,
    String? confirmButtonText,
  }) async {
    opened++;
    if (pending != null) return pending!.future;
    return '/work/my-project';
  }
}

class _KeyboardCreationApp extends _FirstUseApp {
  final folderRequests = <({String machine, String? path})>[];

  @override
  Future<Map<String, dynamic>> listRemoteFolder(
    String machineId,
    String? path,
  ) async {
    folderRequests.add((machine: machineId, path: path));
    return {'path': path ?? '/home/dev', 'entries': <Object>[]};
  }
}

void main() {
  testWidgets(
    'machine, remote folder and agent can be chosen entirely by keyboard',
    (tester) async {
      final app = _KeyboardCreationApp();
      addTearDown(() async {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      });
      await app.agentPreference.select('claude');
      const remote = Machine(
        machineId: 'workshop',
        name: 'Workshop machine',
        authMode: MachineAuthMode.remote,
      );
      app.machines = [...app.machines, remote];
      app.machineStates['workshop'] = MachineState(remote)
        ..nodeOnline = true
        ..agentLoadStatus = AgentLoadStatus.loaded;
      app.machineStates['workshop']!.engines.replace(const [
        EngineAvailability(engine: 'claude', installed: true),
        EngineAvailability(engine: 'hermes', installed: true),
      ]);
      await mount(tester, app);
      await chord(tester, LogicalKeyboardKey.keyN);
      await tester.pumpAndSettle();
      Future<void> tabTo(FocusNode node, {bool back = false}) async {
        if (back) await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
        // Include the optional help buttons and the task field in the
        // dialog's tab order.
        for (var i = 0; i < 30 && !node.hasPrimaryFocus; i++) {
          await tester.sendKeyEvent(LogicalKeyboardKey.tab);
          await tester.pump();
        }
        if (back) await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
        expect(node.hasPrimaryFocus, isTrue);
      }

      await tabTo(Focus.of(tester.element(find.text('Workshop machine'))));
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<AppChoicePicker<String>>(
              find.byKey(const Key('new-agent-machine-field')),
            )
            .value,
        'workshop',
      );
      expect(app.launches, isEmpty);

      final folder = _localFocus(tester);
      await tabTo(folder);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      tester.testTextInput.enterText('/work/selected-project');
      await tester.pump();
      // Return in a platform text field arrives as the input method's action.
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      await chord(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.text('Choose a folder'), findsNothing);
      expect(app.folderRequests, [
        (machine: 'workshop', path: null),
        (machine: 'workshop', path: '/work/selected-project'),
      ]);

      // The agent bar is in the tab order. The first letter typed there opens
      // its search with that letter in it, and Return takes the first match
      // without leaving the keyboard.
      final bar = tester
          .widget<AgentPicker>(find.byType(AgentPicker))
          .focusNode!;
      await tabTo(bar, back: true);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyH, character: 'h');
      await tester.pump();
      await tester.pump();
      expect(tester.widget<TextField>(agentSearch).controller!.text, 'h');
      tester.testTextInput.enterText('hermes');
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(agentSearch, findsNothing, reason: 'a choice closes the search');
      expect(
        tester.widget<AgentPicker>(find.byType(AgentPicker)).value,
        'hermes',
      );
      expect(bar.hasPrimaryFocus, isTrue);
      expect(app.launches, isEmpty);
      final submit = tester.widget<FilledButton>(
        find.byKey(const ValueKey('create-agent-submit')),
      );
      await tabTo(submit.focusNode!);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(app.launches, [
        (
          machine: 'workshop',
          engine: 'hermes',
          folder: '/work/selected-project',
          bypass: false,
        ),
      ]);
      expect(app.input, isEmpty);
      expect(tester.takeException(), isNull);
    },
    variant: const TargetPlatformVariant({TargetPlatform.macOS}),
  );

  testWidgets('first use starts idle with separate Open and New actions', (
    tester,
  ) async {
    final app = _FirstUseApp();
    final projects = SwarmProjectStore();
    await projects.add(
      const SavedSwarmProject(
        machineId: 'm',
        path: '/work/saved-project',
        name: 'Saved project',
      ),
    );
    await mount(tester, app, projects: projects);
    expect(_startInput, findsOneWidget);
    expect(_newHarness, findsOneWidget);
    expect(find.byKey(const ValueKey('harness-start-open')), findsOneWidget);
    expect(tester.widget<TextField>(_startInput).focusNode!.hasFocus, isTrue);
    expect(find.byType(ListTile), findsNothing);
    expect(find.byType(AlertDialog), findsNothing);
    expect(find.text('Saved project'), findsNothing);
    expect(find.byKey(const ValueKey('harness-device-link')), findsOneWidget);
    expect(app.launches, isEmpty);
    expect(app.probes, 0);
    await tester.pumpWidget(const SizedBox());
    projects.dispose();
    app.dispose();
  });

  testWidgets('first discovery keeps entry idle until New is chosen', (
    tester,
  ) async {
    final app = _FirstUseApp();
    final local = app.machineStates.remove('m')!;
    app.machinesLoading = true;
    final oldPicker = FileSelectorPlatform.instance;
    final picker = _FolderPicker();
    FileSelectorPlatform.instance = picker;
    addTearDown(() => FileSelectorPlatform.instance = oldPicker);
    await mount(tester, app);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(picker.opened, 0);
    expect(app.probes, 0);
    expect(find.byType(AlertDialog), findsNothing);
    app.machineStates['m'] = local;
    app.machinesLoading = false;
    app.dismissError();
    await tester.pump();
    expect(tester.widget<TextField>(_startInput).focusNode!.hasFocus, isTrue);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    await tester.tap(_newHarness);
    await tester.pump();
    expect(picker.opened, 0);
    expect(find.byType(AlertDialog), findsOneWidget);
    expect(app.probes, 1);
    await _browseLocal(tester);
    await tester.pump();
    expect(picker.opened, 1);
    expect(find.text('my-project'), findsOneWidget);
    expect(app.launches, isEmpty);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets('discovery preserves the focused harness search', (tester) async {
    final app = _FirstUseApp();
    final local = app.machineStates.remove('m')!;
    app.machinesLoading = true;
    await mount(tester, app);
    final browsing = _startInput;
    final focus = tester.widget<TextField>(browsing).focusNode!;
    focus.requestFocus();
    await tester.pump();
    expect(focus.hasPrimaryFocus, isTrue);
    app.machineStates['m'] = local;
    app.machinesLoading = false;
    app.dismissError();
    await tester.pump();
    expect(focus.hasPrimaryFocus, isTrue);
    expect(find.text('Machines'), findsNothing);
    expect(find.byType(AlertDialog), findsNothing);
    expect(app.launches, isEmpty);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets(
    'another unavailable computer does not hide the local start path',
    (tester) async {
      final app = _FirstUseApp();
      const remote = Machine(
        machineId: 'r',
        name: 'Remote computer',
        authMode: MachineAuthMode.remote,
      );
      app.machineStates['r'] = MachineState(remote)
        ..nodeOnline = false
        ..agentLoadStatus = AgentLoadStatus.error;
      final oldPicker = FileSelectorPlatform.instance;
      final picker = _FolderPicker();
      FileSelectorPlatform.instance = picker;
      addTearDown(() => FileSelectorPlatform.instance = oldPicker);
      await mount(tester, app);
      expect(_newHarness, findsOneWidget);
      expect(find.text('Machines'), findsNothing);
      await tester.tap(_newHarness);
      await tester.pump();
      expect(picker.opened, 0);
      await _browseLocal(tester);
      await tester.pump();
      expect(picker.opened, 1);
      expect(find.text('my-project'), findsOneWidget);
      final localMachine = find.byKey(const ValueKey('new-agent-machine-m'));
      await tester.ensureVisible(localMachine);
      await tester.tap(localMachine);
      await tester.pump();
      expect(find.text('my-project'), findsOneWidget);
      expect(
        tester
            .widget<AppChoicePicker<String>>(
              find.byKey(const Key('new-agent-machine-field')),
            )
            .value,
        'm',
      );
      expect(
        tester
            .widget<AppChoicePicker<String>>(
              find.byKey(const Key('new-agent-machine-field')),
            )
            .options
            .last
            .detail,
        'Remote',
      );
      expect(app.launches, isEmpty);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'pending creation stays visible and an error preserves choices for retry',
    (tester) async {
      final app = _FirstUseApp()..creation = Completer<String?>();
      app.machineStates['m']!.engines.replace(const [
        EngineAvailability(engine: 'claude', installed: true),
      ]);
      final oldPicker = FileSelectorPlatform.instance;
      FileSelectorPlatform.instance = _FolderPicker();
      addTearDown(() => FileSelectorPlatform.instance = oldPicker);
      await mount(tester, app);
      await chord(tester, LogicalKeyboardKey.keyN);
      await tester.pump();
      await _browseLocal(tester);
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('create-agent-submit')));
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      await tester.tapAt(const Offset(8, 100));
      await tester.pump();
      expect(find.byType(AlertDialog), findsOneWidget);
      expect(find.text('Creating harness…'), findsOneWidget);
      expect(app.launches, hasLength(1));
      expect(app.panes, isEmpty);
      expect(tester.widget<AppChoiceTile>(_localProject).onPressed, isNull);

      app.creation!.complete('Choose another project folder and try again.');
      await tester.pump();
      expect(
        find.text('Choose another project folder and try again.'),
        findsOneWidget,
      );
      expect(find.text('my-project'), findsOneWidget);
      expect(
        tester.widget<AgentPicker>(find.byType(AgentPicker)).value,
        'claude',
      );
      await _browseLocal(tester);
      await tester.pump();
      expect(
        find.text('Choose another project folder and try again.'),
        findsNothing,
      );
      app.creation = null;
      await tester.tap(find.byKey(const ValueKey('create-agent-submit')));
      await tester.pump();
      expect(find.byType(AlertDialog), findsNothing);
      expect(find.byType(TerminalView), findsOneWidget);
      expect(app.launches, hasLength(2));
      expect(app.input, isEmpty);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  for (final native in [false, true]) {
    testWidgets(
      'New Harness ${native ? 'native menu' : 'header'} defaults to this computer',
      (tester) async {
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          const MethodChannel('harness/swarm_tabs'),
          (_) async => null,
        );
        addTearDown(
          () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            const MethodChannel('harness/swarm_tabs'),
            null,
          ),
        );
        final app = _FirstUseApp();
        final map = MemoryKeymap();
        app.machineStates['m']!.engines.replace(const [
          EngineAvailability(engine: 'codex', installed: true),
        ]);
        const remote = Machine(
          machineId: 'remote',
          name: 'Remote computer',
          authMode: MachineAuthMode.remote,
        );
        app.machines = [...app.machines, remote];
        app.machineStates['remote'] = MachineState(remote)
          ..nodeOnline = true
          ..agentLoadStatus = AgentLoadStatus.loaded
          ..agents = const [
            Agent(
              id: 'existing',
              name: 'Existing work',
              engine: 'codex',
              terminalAvailable: true,
              project: AgentProject(name: 'Workspace', cwd: '/work/existing'),
            ),
          ];
        final pane = app.adoptSessionForTest(
          TerminalSession(
              machineId: 'remote',
              agentId: 'existing',
              agentName: 'Existing work',
              engineId: 'codex',
              send: (_, _) async => true,
              sendBinary: (frame) async {
                if (frame.kind == TerminalBinaryKind.input) {
                  app.input.add(frame);
                }
                return true;
              },
            )
            ..status = TerminalSessionStatus.controlling
            ..streamId = 'stream-existing',
        );
        await runtime.mount(tester, app, map, native: native);
        if (native) {
          final opening = runtime.native(tester, 'newAgent');
          await tester.pump();
          await opening;
        } else {
          final addButton = find.byKey(
            const ValueKey('swarm-new-agent-button'),
          );
          final bell = find.byKey(const ValueKey('swarm-notifications-button'));
          expect(
            tester.getRect(bell).right,
            lessThan(tester.getRect(addButton).left),
          );
          expect(
            find.byKey(const ValueKey('swarm-new-harness-button')),
            findsNothing,
          );
          expect(find.byType(FloatingActionButton), findsNothing);
          await tester.tap(addButton);
          await tester.pump();
        }
        await tester.pump();
        expect(find.byType(AlertDialog), findsOneWidget);
        expect(find.text('/work/existing'), findsNothing);
        expect(tester.widget<AppChoiceTile>(_newProject).selected, isTrue);
        final machineField = tester.widget<AppChoicePicker<String>>(
          find.byKey(const Key('new-agent-machine-field')),
        );
        expect(machineField.value, 'm');
        expect(machineField.options.map((option) => option.detail), [
          'This computer',
          'Remote',
        ]);
        expect(machineField.options.map((option) => option.label), [
          'My computer',
          'Remote computer',
        ]);
        expect(
          tester.widget<AgentPicker>(find.byType(AgentPicker)).value,
          'codex',
        );
        expect(app.panes, [pane]);
        expect(app.launches, isEmpty);
        expect(app.input, isEmpty);
        expect(find.text('Cancel'), findsNothing);
        expect(find.text('Back to Search'), findsNothing);
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pump();
        await tester.pump();
        expect(find.byType(AlertDialog), findsNothing);
        expect(find.byKey(const ValueKey('swarm-search-input')), findsNothing);
        expect(
          tester
              .widget<TerminalView>(find.byType(TerminalView))
              .focusNode!
              .hasFocus,
          isTrue,
        );
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        map.dispose();
      },
    );
  }

  testWidgets(
    'new agent supports immediate keyboard creation',
    (tester) async {
      final app = _FirstUseApp();
      app.machineStates['m']!.engines.replace(const [
        EngineAvailability(engine: 'codex', installed: true),
      ]);
      final oldPicker = FileSelectorPlatform.instance;
      final picker = _FolderPicker()..pending = Completer<String?>();
      FileSelectorPlatform.instance = picker;
      addTearDown(() => FileSelectorPlatform.instance = oldPicker);
      await mount(tester, app);
      await chord(tester, LogicalKeyboardKey.keyN);
      await tester.pump();

      // The dialog opens with focus on the agent bar, ready to type.
      expect(
        tester
            .widget<AgentPicker>(find.byType(AgentPicker))
            .focusNode!
            .hasPrimaryFocus,
        isTrue,
      );
      for (var i = 0; i < 16 && !_localFocus(tester).hasPrimaryFocus; i++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.tab);
        await tester.pump();
      }
      expect(_localFocus(tester).hasPrimaryFocus, isTrue);
      expect(picker.opened, 0);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(picker.opened, 1);
      expect(tester.widget<AppChoiceTile>(_localProject).onPressed, isNull);
      picker.pending!.complete('/work/my-project');
      await tester.pump();
      await tester.pump();
      expect(find.text('my-project'), findsOneWidget);
      final submit = tester.widget<FilledButton>(
        find.byKey(const ValueKey('create-agent-submit')),
      );
      for (var i = 0; i < 8 && !submit.focusNode!.hasPrimaryFocus; i++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.tab);
        await tester.pump();
      }
      expect(submit.focusNode!.hasPrimaryFocus, isTrue);
      expect(app.launches, isEmpty);
      expect(find.text('Cancel'), findsNothing);
      expect(find.text('Back to Search'), findsNothing);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(app.launches.single.folder, '/work/my-project');
      expect(find.byType(AlertDialog), findsNothing);
      expect(app.input, isEmpty);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.pump();
      expect(app.input.single.bytes, [27, 91, 66]);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
    variant: const TargetPlatformVariant({
      TargetPlatform.macOS,
      TargetPlatform.linux,
    }),
  );

  for (final outcome in ['cancel', 'error']) {
    testWidgets('keyboard folder $outcome restores the chooser, not submit', (
      tester,
    ) async {
      final app = _FirstUseApp();
      app.machineStates['m']!.engines.replace(const [
        EngineAvailability(engine: 'claude', installed: true),
      ]);
      final oldPicker = FileSelectorPlatform.instance;
      final picker = _FolderPicker();
      FileSelectorPlatform.instance = picker;
      addTearDown(() => FileSelectorPlatform.instance = oldPicker);
      await mount(tester, app);
      await chord(tester, LogicalKeyboardKey.keyN);
      await _browseLocal(tester);
      await tester.pump();
      await tester.pump();
      expect(find.text('my-project'), findsOneWidget);
      final folder = _localFocus(tester);
      folder.requestFocus();
      await tester.pump();
      picker.pending = Completer<String?>();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(picker.opened, 2);
      if (outcome == 'error') {
        picker.pending!.completeError(StateError('Picker unavailable'));
      } else {
        picker.pending!.complete(null);
      }
      await tester.pump();
      await tester.pump();
      expect(folder.hasPrimaryFocus, isTrue);
      expect(find.text('my-project'), findsOneWidget);
      expect(app.launches, isEmpty);
      picker.pending = Completer<String?>();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(picker.opened, 3, reason: 'Enter retries browsing, not creation');
      expect(app.launches, isEmpty);
      picker.pending!.complete(null);
      await tester.pump();
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    });
  }

  testWidgets('fresh workspace reaches an agent with an installed default', (
    tester,
  ) async {
    final app = _FirstUseApp();
    app.machineStates['m']!.engines.replace(const [
      EngineAvailability(engine: 'claude', installed: false, installable: true),
      EngineAvailability(engine: 'codex', installed: true),
    ]);
    final oldPicker = FileSelectorPlatform.instance;
    final picker = _FolderPicker();
    FileSelectorPlatform.instance = picker;
    addTearDown(() => FileSelectorPlatform.instance = oldPicker);
    await mount(tester, app);

    expect(find.text('New Harness'), findsWidgets);
    expect(find.text('Machines'), findsNothing);
    expect(find.text('Projects'), findsNothing);
    expect(app.launches, isEmpty);
    expect(_startInput, findsOneWidget);
    expect(tester.widget<TextField>(_startInput).focusNode!.hasFocus, isTrue);
    await tester.tap(_newHarness);
    await tester.pump();
    final engine = tester.widget<AgentPicker>(find.byType(AgentPicker));
    expect(engine.value, 'codex');
    expect(find.byKey(const Key('new-agent-machine-field')), findsOneWidget);
    expect(
      tester.getTopLeft(agentBar).dy,
      lessThan(
        tester
            .getTopLeft(
              find.text(
                'Project. Start something new or choose an existing project.',
              ),
            )
            .dy,
      ),
    );
    expect(picker.opened, 0);
    await _browseLocal(tester);
    await tester.pump();
    expect(picker.opened, 1);
    expect(app.probes, 1);
    expect(find.text('my-project'), findsOneWidget);
    expect(app.launches, isEmpty);
    await tester.tap(find.byKey(const ValueKey('create-agent-submit')));
    await tester.pump();

    expect(app.launches, [
      (
        machine: 'm',
        engine: 'codex',
        folder: '/work/my-project',
        bypass: true,
      ),
    ]);
    expect(find.byType(TerminalView), findsOneWidget);
    expect(find.text('Your first workspace'), findsNothing);
    expect(app.input, isEmpty);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets('every empty page opens existing work through the same search', (
    tester,
  ) async {
    final app = _FirstUseApp();
    app.machineStates['m']!.agents = const [
      Agent(
        id: 'existing',
        name: 'My ongoing work',
        engine: 'codex',
        terminalAvailable: true,
      ),
    ];
    await mount(tester, app);
    expect(app.panes, isEmpty);
    expect(_startInput, findsOneWidget);
    expect(find.text('Go to an agent'), findsNothing);
    await tester.tap(_startInput);
    await tester.enterText(_startInput, 'My ongoing work');
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(app.panes.single.agentId, 'existing');
    final source = app.activeSwarm;
    final pane = app.panes.single;
    app.newSwarm();
    await tester.pump();
    await tester.pump();
    expect(_startInput, findsOneWidget);
    expect(_newHarness, findsOneWidget);
    expect(find.text('Go to an agent'), findsNothing);
    await tester.tap(_startInput);
    await tester.enterText(_startInput, 'My ongoing work');
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(app.panes.single, same(pane));
    expect(source.panes.single, same(pane));
    final used = app.activeSwarmId;
    await app.closeSwarm(used);
    app.newSwarm();
    await tester.pump();
    await tester.pump();
    expect(app.closedHistory, isNotEmpty);
    expect(_startInput, findsOneWidget);
    expect(app.launches, isEmpty);
    expect(find.text('Go to an agent'), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets(
    'folder selection reuses discovery and ignores repeated activation',
    (tester) async {
      final app = _FirstUseApp()..probe = Completer<void>();
      final oldPicker = FileSelectorPlatform.instance;
      final picker = _FolderPicker()..pending = Completer<String?>();
      FileSelectorPlatform.instance = picker;
      addTearDown(() => FileSelectorPlatform.instance = oldPicker);
      await mount(tester, app);

      await tester.tap(_newHarness);
      await tester.pump();
      expect(find.byType(AlertDialog), findsOneWidget);
      await _browseLocal(tester);
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await chord(tester, LogicalKeyboardKey.keyN);
      expect(picker.opened, 1);
      expect(app.probes, 1);
      expect(find.byType(AlertDialog), findsOneWidget);
      expect(app.launches, isEmpty);

      app.machineStates['m']!.engines.replace(const [
        EngineAvailability(engine: 'claude', installed: false),
        EngineAvailability(engine: 'codex', installed: true),
      ]);
      app.probe!.complete();
      await tester.pump();
      picker.pending!.complete('/work/chosen');
      await tester.pump();
      await tester.pump();
      expect(find.text('chosen'), findsOneWidget);
      expect(
        tester.widget<AgentPicker>(find.byType(AgentPicker)).value,
        'codex',
      );
      expect(app.probes, 1);
      expect(app.launches, isEmpty);
      expect(app.input, isEmpty);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'late folder completion cannot revive a disposed creation dialog',
    (tester) async {
      final app = _FirstUseApp();
      final oldPicker = FileSelectorPlatform.instance;
      final picker = _FolderPicker()..pending = Completer<String?>();
      FileSelectorPlatform.instance = picker;
      addTearDown(() => FileSelectorPlatform.instance = oldPicker);
      await mount(tester, app);
      await tester.tap(_newHarness);
      await tester.pump();
      await _browseLocal(tester);
      await tester.pump();
      expect(picker.opened, 1);
      await tester.pumpWidget(const SizedBox());
      picker.pending!.complete('/work/stale');
      await tester.pump();
      await tester.pump();
      expect(find.byType(AlertDialog), findsNothing);
      expect(app.allPanes, isEmpty);
      expect(app.launches, isEmpty);
      expect(app.input, isEmpty);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'a late probe uses an installed agent without overriding a choice',
    (tester) async {
      for (final chooseExplicitly in [false, true]) {
        final app = _FirstUseApp()..probe = Completer<void>();
        await mount(tester, app);
        await chord(tester, LogicalKeyboardKey.keyN);
        await tester.pump();
        if (chooseExplicitly) {
          await chooseAgent(tester, 'claude');
        }
        app.machineStates['m']!.engines.replace(const [
          EngineAvailability(engine: 'claude', installed: false),
          EngineAvailability(engine: 'codex', installed: true),
        ]);
        app.probe!.complete();
        await tester.pump();
        await tester.pump();
        expect(app.probes, 1);
        final engine = tester.widget<AgentPicker>(find.byType(AgentPicker));
        expect(engine.value, chooseExplicitly ? 'claude' : 'codex');
        expect(app.launches, isEmpty);
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      }
    },
  );
}
