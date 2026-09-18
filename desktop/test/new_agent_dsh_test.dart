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
import 'package:harness/widgets/agent_picker.dart';
import 'package:harness/widgets/new_agent_dialog.dart';

import 'support/agent_picker.dart';

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
    required String? folder,
    bool bypassPermission = false,
    String? permissionMode,
    String? codexHome,
    String? dsh,
    String? prompt,
    String? name,
    String? agent,
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

  /// A harness is found by typing its name into the agent search, and taken
  /// by clicking its row.
  Future<void> pick(WidgetTester tester, String label) async {
    await openAgentSearch(tester);
    await tester.enterText(agentSearch, label);
    await tester.pumpAndSettle();
    await tester.tap(
      find
          .ancestor(of: find.text(label), matching: find.byType(ListTile))
          .first,
    );
    await tester.pumpAndSettle();
  }

  Future<void> create(WidgetTester tester) async {
    await tester.ensureVisible(
      find.byKey(const ValueKey('create-agent-submit')),
    );
    await tester.tap(find.byKey(const ValueKey('create-agent-submit')));
    await tester.pump();
  }

  String engineField(WidgetTester tester) =>
      tester.widget<AgentPicker>(find.byType(AgentPicker)).value;

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
        reason: 'asked once on open, so the agent search is never stale',
      );
      await pick(tester, 'Autonomous Circuit');
      expect(app.harnessProbes, 2);
      expect(engineField(tester), 'autonomous/autonomous-circuit');
      // Chosen, the bar shows it and the search is closed.
      expect(
        find.descendant(
          of: agentBar,
          matching: find.text('Autonomous Circuit'),
        ),
        findsOneWidget,
      );
      expect(agentSearch, findsNothing);
      await tester.ensureVisible(find.byKey(const Key('new-agent-advanced')));
      await tester.tap(find.byKey(const Key('new-agent-advanced')));
      await tester.pumpAndSettle();
      // Its base engine's bypass flag is the one offered: a harness has no
      // flag of its own, and without the base's it would say "Managed by".
      await tester.ensureVisible(find.text('Auto-approve'));
      expect(find.text('Auto-approve'), findsOneWidget);
      expect(find.textContaining('Managed by'), findsNothing);

      await create(tester);
      expect(app.installs, isEmpty);
      expect(app.launches.single, {
        'machine': 'machine-1',
        'engine': 'claude',
        'dsh': 'autonomous/autonomous-circuit',
        'folder': '',
        'bypass': true,
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
    expect(find.byKey(const ValueKey('create-agent-submit')), findsOneWidget);
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
        'Update Harness CLI on harness-remote-box to create a Autonomous Circuit harness.',
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
    await chooseAgent(tester, 'claude');
    await tester.pumpAndSettle();
    await create(tester);
    expect(app.launches.single['engine'], 'claude');
    expect(app.launches.single['dsh'], isNull);
  });

  testWidgets(
    'the agent search opens on what you have, and finds the rest by name',
    (tester) async {
      await open(
        tester,
        seed: (state) => state.dsh.replace([
          _circuit.copyWith(installed: true),
          const DshEntry(
            id: 'someone/robot-arm',
            name: 'Robot Arm',
            engine: 'codex',
          ),
        ]),
      );
      await openAgentSearch(tester);
      // Nothing typed: the choice, then what the machine has — Circuit, the
      // harness it installed, ahead of Codex, an engine it has, and the
      // terminal, which every machine has — then the familiar engines, and
      // the Store last. Robot Arm, which it lacks, is not listed.
      expect(agentRows(tester), [
        'claude',
        'autonomous/autonomous-circuit',
        'codex',
        'terminal',
        'opencode',
      ]);
      await tester.enterText(agentSearch, 'robot');
      await tester.pumpAndSettle();
      expect(agentRows(tester), ['someone/robot-arm']);
      expect(find.text('on Codex'), findsNothing, reason: 'backend detail');
      await tester.tap(
        find.byKey(const ValueKey('new-agent-agent-row-someone/robot-arm')),
      );
      await tester.pumpAndSettle();
      expect(engineField(tester), 'someone/robot-arm');
      expect(agentSearch, findsNothing, reason: 'a choice closes the search');
      // Chosen, it leads the list; what the machine has still follows.
      await openAgentSearch(tester);
      expect(agentRows(tester).take(3), [
        'someone/robot-arm',
        'autonomous/autonomous-circuit',
        'claude',
      ]);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.byKey(const Key('new-agent-advanced')));
      await tester.tap(find.byKey(const Key('new-agent-advanced')));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('an agent you created with lately comes before the rest', (
    tester,
  ) async {
    final app = await open(
      tester,
      seed: (state) => state.dsh.replace([_circuit.copyWith(installed: true)]),
    );
    // Hermes is not installed, so only having used it lists it this early.
    await app.agentPreference.remember('hermes');
    await openAgentSearch(tester);
    expect(agentRows(tester).take(3), [
      'claude',
      'hermes',
      'autonomous/autonomous-circuit',
    ]);
    expect(tester.takeException(), isNull);
  });

  testWidgets('the search takes a name, a category, and Return', (
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
    await openAgentSearch(tester);
    await tester.enterText(agentSearch, 'robot');
    await tester.pumpAndSettle();
    expect(agentRows(tester), ['someone/robot-arm']);
    // Return takes the highlighted row, the first match.
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(engineField(tester), 'someone/robot-arm');
    expect(agentSearch, findsNothing);
    // The words under a name count: "PCB" is what Circuit makes.
    await openAgentSearch(tester);
    await tester.enterText(agentSearch, 'pcb');
    await tester.pumpAndSettle();
    expect(agentRows(tester), ['autonomous/autonomous-circuit']);
    // Nothing matching says so.
    await tester.enterText(agentSearch, 'welding');
    await tester.pumpAndSettle();
    expect(agentRows(tester), isEmpty);
    expect(
      find.byKey(const Key('new-agent-agent-search-empty')),
      findsOneWidget,
    );
    // Escape closes the search and keeps the choice; the dialog stays.
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(agentSearch, findsNothing);
    expect(find.byType(AlertDialog), findsOneWidget);
    expect(engineField(tester), 'someone/robot-arm');
    expect(tester.takeException(), isNull);
  });
}
