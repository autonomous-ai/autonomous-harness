// A terminal in the Create dialog: the last row of the agent list, always had,
// no task or permission mode, a Home tile in place of New project and no Git —
// and a create that names the terminal engine with no folder at all (the daemon
// opens it at home) or with the folder that was picked.
import 'dart:async';

import 'package:file_selector_platform_interface/file_selector_platform_interface.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/widgets/agent_picker.dart';
import 'package:harness/widgets/engine_identity.dart';
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

/// Stands in for the machine: probes answer at once, creates are recorded.
class _Notifier extends AppNotifier {
  _Notifier()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );

  final launches = <Map<String, Object?>>[];

  @override
  Future<void> probeEngines(String machineId, {bool force = false}) async {}

  @override
  Future<void> probeDsh(String machineId, {bool force = false}) async {}

  @override
  Future<Map<String, dynamic>> listCodexProfiles(
    String machineId, {
    Set<String> observedPaths = const {},
  }) async => {'profiles': <dynamic>[]};

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
      'folder': folder,
      'project': projectFolder?.payload,
      'prompt': prompt,
      'permissionMode': permissionMode,
      'bypass': bypassPermission,
    });
    return 'Test launch refused.';
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => FileSelectorPlatform.instance = _Folders());

  const machine = Machine(
    machineId: 'machine-1',
    authMode: MachineAuthMode.remote,
    name: 'harness-remote-box',
  );

  Future<_Notifier> open(WidgetTester tester) async {
    // Wide enough for the agent search to show its preview beside the rows.
    tester.view.physicalSize = const Size(1400, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final notifier = _Notifier();
    addTearDown(notifier.dispose);
    final state = MachineState(machine)..localOnly = true;
    state.engines.replace(const [
      EngineAvailability(engine: 'claude', installed: true),
    ]);
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
    return notifier;
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
    'the terminal is listed with what the machine has, and never needs installing',
    (tester) async {
      await open(tester);
      await openAgentSearch(tester);
      final rows = agentRows(tester);
      expect(
        rows.where((id) => id == kTerminalEngine).length,
        1,
        reason: 'listed once, among what the machine has',
      );
      expect(
        rows.indexOf(kTerminalEngine),
        lessThan(rows.indexOf('opencode')),
        reason: 'every machine has a shell: it comes before the engines this one lacks',
      );
      expect(
        rows.indexOf(kTerminalEngine),
        greaterThan(rows.indexOf('claude')),
      );
      await tester.enterText(agentSearch, 'Terminal');
      await tester.pumpAndSettle();
      // The preview of the top match says the shell is simply there.
      expect(find.text('Your shell on harness-remote-box'), findsOneWidget);
      expect(find.textContaining('Installs on'), findsNothing);
      expect(find.textContaining('Not installed'), findsNothing);
      await tester.tap(
        find.byKey(const ValueKey('new-agent-agent-row-terminal')),
      );
      await tester.pumpAndSettle();
      expect(engineField(tester), kTerminalEngine);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'a terminal has no task or permission mode, opens at home by default, and creates as one',
    (tester) async {
      final app = await open(tester);
      await chooseAgent(tester, kTerminalEngine);
      await tester.pumpAndSettle();
      // Home in place of New project; a terminal does not clone, so no Git.
      expect(find.text('Home'), findsOneWidget);
      expect(find.text('New project'), findsNothing);
      expect(find.byKey(const Key('new-agent-project-git')), findsNothing);
      // Nothing to tell it first, and no mode to pick.
      expect(
        find.textContaining('A terminal opens straight on your shell'),
        findsOneWidget,
      );
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('new-agent-task')))
            .enabled,
        isFalse,
      );
      expect(find.byKey(const Key('new-agent-permission-mode')), findsNothing);

      await create(tester);
      expect(app.launches.single, {
        'machine': 'machine-1',
        'engine': kTerminalEngine,
        'folder': null,
        'project': null,
        'prompt': null,
        'permissionMode': null,
        'bypass': false,
      });
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('a terminal opens in the folder that was picked', (tester) async {
    final app = await open(tester);
    await chooseAgent(tester, kTerminalEngine);
    await tester.pumpAndSettle();
    final browse = find.byKey(const Key('new-agent-project-browse'));
    await tester.ensureVisible(browse);
    await tester.tap(browse);
    await tester.pumpAndSettle();
    await create(tester);
    expect(app.launches.single['engine'], kTerminalEngine);
    expect(app.launches.single['folder'], _folder);
    expect(app.launches.single['project'], isNull);
  });

  testWidgets(
    'switching to a terminal from a Git project falls back to Home; switching back restores the tiles',
    (tester) async {
      await open(tester);
      // A Git project for an agent, then the terminal: it cannot clone.
      final git = find.byKey(const Key('new-agent-project-git'));
      await tester.ensureVisible(git);
      expect(git, findsOneWidget);
      await chooseAgent(tester, kTerminalEngine);
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('new-agent-project-git')), findsNothing);
      expect(find.text('Home'), findsOneWidget);
      await chooseAgent(tester, 'claude');
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('new-agent-project-git')), findsOneWidget);
      expect(find.text('New project'), findsOneWidget);
      expect(find.text('Home'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );
}
