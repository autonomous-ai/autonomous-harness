// A domain harness in the Create dialog: one tile, its base engine under
// Advanced, an install-first step on a machine that lacks it, and a create that
// names both the harness and the engine it runs on.
import 'dart:async';

import 'package:file_selector_platform_interface/file_selector_platform_interface.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/shared/widgets/app_menu.dart';
import 'package:harness/shared/widgets/app_select_field.dart';
import 'package:harness/widgets/new_agent_dialog.dart';

const _folder = '/work/air-monitor';

class _Folders extends FileSelectorPlatform {
  @override
  Future<String?> getDirectoryPath({
    String? initialDirectory,
    String? confirmButtonText,
  }) async => _folder;
}

const _circuit = DshEntry(
  id: 'autonomous/autonomous-circuit',
  name: 'Autonomous Circuit',
  engine: 'claude',
  description: 'Chat with AI → a board you can order',
  installed: false,
  viewer: true,
  tier: 2,
);

/// Stands in for the machine: the engine probe answers at once, the harness
/// catalog answers what the test seeded, and installs/creates are recorded.
class _Notifier extends AppNotifier {
  _Notifier()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );

  final installs = <String>[];
  final launches = <Map<String, Object?>>[];
  Completer<String?>? pendingInstall;
  int harnessProbes = 0;

  @override
  Future<void> probeEngines(String machineId, {bool force = false}) async {}

  /// When set, the machine answers `dsh_list` the way a CLI that predates
  /// harnesses does: with a refusal, and no catalog.
  String? probeRefusal;

  @override
  Future<void> probeDsh(String machineId, {bool force = false}) async {
    harnessProbes++;
    if (probeRefusal case final refusal?) {
      stateOf(machineId)!.dsh.error = refusal;
    }
  }

  @override
  Future<Map<String, dynamic>> listCodexProfiles(
    String machineId, {
    Set<String> observedPaths = const {},
  }) async => {'profiles': <dynamic>[]};

  @override
  Future<String?> installDsh(String machineId, String id) {
    installs.add(id);
    final machine = machineStates[machineId]!;
    machine.dsh.applyInstall(DshInstallProgress(id: id, phase: 'setup'));
    notifyListeners();
    final pending = pendingInstall;
    if (pending == null) {
      machine.dsh.replace([_circuit.copyWith(installed: true)]);
      return Future.value(null);
    }
    return pending.future.then((error) {
      if (error == null) {
        machine.dsh.replace([_circuit.copyWith(installed: true)]);
      }
      return error;
    });
  }

  @override
  Future<String?> createAgent(
    String machineId, {
    required String engine,
    required String folder,
    bool bypassPermission = false,
    String? codexHome,
    String? dsh,
    ProjectFolderRequest? projectFolder,
    String? swarmId,
    PaneSplitRequest? split,
    AgentCreationAttempt? attempt,
  }) async {
    launches.add({
      'machine': machineId,
      'engine': engine,
      'dsh': dsh,
      'folder': folder,
      'bypass': bypassPermission,
    });
    return 'Test launch refused.';
  }
}

extension on DshEntry {
  DshEntry copyWith({bool? installed}) => DshEntry(
    id: id,
    name: name,
    engine: engine,
    description: description,
    installed: installed ?? this.installed,
    viewer: viewer,
    tier: tier,
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => FileSelectorPlatform.instance = _Folders());

  const machine = Machine(
    machineId: 'machine-1',
    authMode: MachineAuthMode.remote,
    name: 'harness-remote-box',
  );

  Future<_Notifier> open(
    WidgetTester tester, {
    required void Function(MachineState state) seed,
  }) async {
    final notifier = _Notifier();
    addTearDown(notifier.dispose);
    final state = MachineState(machine)..localOnly = true;
    state.engines.replace(const [
      EngineAvailability(engine: 'claude', installed: true),
      EngineAvailability(engine: 'codex', installed: true),
    ]);
    seed(state);
    notifier.machineStates['machine-1'] = state;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () => showNewAgentDialog(
                context,
                notifier,
                'machine-1',
                source: 'machine_row',
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    // A new project needs no folder: the daemon prepares one. That keeps the
    // native folder panel out of these tests, which are about the harness.
    final newProject = find.byKey(
      const ValueKey('new-agent-folder-newProject'),
    );
    await tester.ensureVisible(newProject);
    await tester.tap(newProject);
    await tester.pumpAndSettle();
    return notifier;
  }

  /// The harnesses live in More, first after the three engines the tiles
  /// show; a chosen one is what the More tile then shows.
  Future<void> pick(WidgetTester tester, String label) async {
    await tester.ensureVisible(find.byKey(const Key('new-agent-engine-field')));
    await tester.tap(find.byKey(const Key('new-agent-engine-field')));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text(label).last);
    await tester.pumpAndSettle();
    await tester.tap(find.text(label).last);
    await tester.pumpAndSettle();
  }

  Future<void> create(WidgetTester tester) async {
    await tester.ensureVisible(
      find.byKey(const ValueKey('create-agent-submit')),
    );
    await tester.tap(find.byKey(const ValueKey('create-agent-submit')));
    await tester.pump();
  }

  String engineField(WidgetTester tester) => tester
      .widget<AppSelectField<String>>(
        find.byKey(const Key('new-agent-engine-field')),
      )
      .value;

  testWidgets(
    'Circuit is one click, says what it runs on, and creates on its base engine',
    (tester) async {
      final app = await open(
        tester,
        seed: (state) =>
            state.dsh.replace([_circuit.copyWith(installed: true)]),
      );
      expect(
        app.harnessProbes,
        1,
        reason: 'asked once on open, so More is never stale',
      );
      await pick(tester, 'Autonomous Circuit');
      expect(app.harnessProbes, 2);
      expect(engineField(tester), 'autonomous/autonomous-circuit');
      // Chosen, it is what the More tile shows.
      expect(
        find.descendant(
          of: find.byKey(const Key('new-agent-engine-field')),
          matching: find.text('Autonomous Circuit'),
        ),
        findsOneWidget,
      );
      await tester.ensureVisible(find.byKey(const Key('new-agent-advanced')));
      await tester.tap(find.byKey(const Key('new-agent-advanced')));
      await tester.pumpAndSettle();
      // Its base engine's bypass flag is the one offered: a harness has no
      // flag of its own, and without the base's it would say "Managed by".
      await tester.ensureVisible(find.text('Bypass approvals'));
      expect(find.text('Bypass approvals'), findsOneWidget);
      expect(find.textContaining('Managed by'), findsNothing);

      await create(tester);
      expect(app.installs, isEmpty);
      expect(app.launches.single, {
        'machine': 'machine-1',
        'engine': 'claude',
        'dsh': 'autonomous/autonomous-circuit',
        'folder': '',
        'bypass': false,
      });
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'a harness the machine lacks is installed first, with its own words',
    (tester) async {
      final app = await open(
        tester,
        seed: (state) => state.dsh.replace([_circuit]),
      );
      app.pendingInstall = Completer<String?>();
      await pick(tester, 'Autonomous Circuit');
      // Quiet until Create: the install is a step of the create, not a warning.
      expect(find.textContaining('Installing'), findsNothing);
      await create(tester);
      expect(app.installs, ['autonomous/autonomous-circuit']);
      expect(
        app.launches,
        isEmpty,
        reason: 'no create until the install lands',
      );
      expect(find.text('Installing Autonomous Circuit…'), findsOneWidget);
      expect(
        find.textContaining('Setting up the toolchain…'),
        findsOneWidget,
        reason: 'the machine narrates the install through the status line',
      );
      app.pendingInstall!.complete(null);
      await tester.pump();
      await tester.pump();
      expect(app.launches.single['dsh'], 'autonomous/autonomous-circuit');
      expect(app.launches.single['engine'], 'claude');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('a failed install is a sentence and no create', (tester) async {
    final app = await open(
      tester,
      seed: (state) => state.dsh.replace([_circuit]),
    );
    app.pendingInstall = Completer<String?>();
    await pick(tester, 'Autonomous Circuit');
    await create(tester);
    app.pendingInstall!.complete('kicad-cli is not on harness-remote-box');
    await tester.pump();
    await tester.pump();
    expect(app.launches, isEmpty);
    expect(find.text('kicad-cli is not on harness-remote-box'), findsOneWidget);
    // Retryable: the button is back.
    expect(find.widgetWithText(FilledButton, 'Create'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'a machine that has not answered offers the tiles without a verdict',
    (tester) async {
      final app = await open(tester, seed: (_) {});
      await pick(tester, 'Autonomous Workshop');
      expect(engineField(tester), 'autonomous/autonomous-workshop');
      await tester.ensureVisible(find.byKey(const Key('new-agent-advanced')));
      await tester.tap(find.byKey(const Key('new-agent-advanced')));
      await tester.pumpAndSettle();
      await create(tester);
      // The machine never answered, so nothing can be called missing.
      expect(app.installs, isEmpty);
      expect(app.launches.single['engine'], 'codex');
      expect(app.launches.single['dsh'], 'autonomous/autonomous-workshop');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('a machine whose CLI predates harnesses is told to update', (
    tester,
  ) async {
    final app = await open(tester, seed: (_) {});
    app.probeRefusal = 'unknown request: dsh_list';
    await pick(tester, 'Autonomous Circuit');
    await create(tester);
    await tester.pump();
    expect(app.installs, isEmpty);
    expect(app.launches, isEmpty, reason: 'never a plain agent in silence');
    expect(
      find.text(
        'Update Harness CLI on harness-remote-box to create a Autonomous Circuit agent.',
      ),
      findsOneWidget,
    );
    expect(
      tester
          .widget<FilledButton>(
            find.byKey(const ValueKey('create-agent-submit')),
          )
          .onPressed,
      isNotNull,
      reason: 'An unsupported CLI must release the form for retry or another harness.',
    );
    await tester.ensureVisible(
      find.byKey(const ValueKey('new-agent-quick-claude')),
    );
    await tester.tap(find.byKey(const ValueKey('new-agent-quick-claude')));
    await tester.pumpAndSettle();
    await create(tester);
    expect(app.launches.single['engine'], 'claude');
    expect(app.launches.single['dsh'], isNull);
  });

  testWidgets('More lists the machine\'s harnesses before the engines', (
    tester,
  ) async {
    await open(
      tester,
      seed: (state) => state.dsh.replace([
        _circuit,
        const DshEntry(
          id: 'someone/robot-arm',
          name: 'Robot Arm',
          engine: 'codex',
        ),
      ]),
    );
    await tester.ensureVisible(find.byKey(const Key('new-agent-engine-field')));
    await tester.tap(find.byKey(const Key('new-agent-engine-field')));
    await tester.pumpAndSettle();
    // The three tiles already offered three coding engines; the eleven behind
    // them are more of the same, and the harnesses are what More is FOR.
    final rows = tester
        .widgetList<AppMenuItem>(find.byType(AppMenuItem))
        .map((row) => row.label)
        .toList();
    expect(rows.take(2), ['Autonomous Circuit', 'Robot Arm']);
    expect(rows.skip(2), contains('Cursor'));
    expect(find.text('Robot Arm'), findsWidgets);
    expect(find.text('on Codex'), findsNothing, reason: 'backend detail');
    await tester.tap(find.text('Robot Arm').last);
    await tester.pumpAndSettle();
    expect(engineField(tester), 'someone/robot-arm');
    await tester.ensureVisible(find.byKey(const Key('new-agent-advanced')));
    await tester.tap(find.byKey(const Key('new-agent-advanced')));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });

  testWidgets('More is searched by name, not scrolled through', (tester) async {
    await open(
      tester,
      seed: (state) => state.dsh.replace([
        _circuit,
        const DshEntry(
          id: 'someone/robot-arm',
          name: 'Robot Arm',
          engine: 'codex',
        ),
      ]),
    );
    await tester.ensureVisible(find.byKey(const Key('new-agent-engine-field')));
    await tester.tap(find.byKey(const Key('new-agent-engine-field')));
    await tester.pumpAndSettle();
    // Thirteen rows behind the three tiles — past the point where reading the
    // list beats typing at it.
    final filter = find.byKey(const Key('app-select-filter'));
    expect(filter, findsOneWidget);
    await tester.enterText(filter, 'robot');
    await tester.pumpAndSettle();
    expect(find.byType(AppMenuItem), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(engineField(tester), 'someone/robot-arm');
    expect(tester.takeException(), isNull);
  });
}
