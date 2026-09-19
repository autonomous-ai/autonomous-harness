// New Harness ▸ Advanced picks how far the agent may go without asking: Auto-approve by default, and
// each engine's own modes beside it. The machine is sent the mode, and the yes/no an older daemon reads.
import 'package:file_selector_platform_interface/file_selector_platform_interface.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/permission_modes.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/widgets/new_agent_dialog.dart';

import 'support/agent_picker.dart';

class _Folders extends FileSelectorPlatform {
  @override
  Future<String?> getDirectoryPath({
    String? initialDirectory,
    String? confirmButtonText,
  }) async => '/work/demo';
}

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
      'engine': engine,
      'mode': permissionMode,
      'bypass': bypassPermission,
    });
    return 'Test launch refused.';
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => FileSelectorPlatform.instance = _Folders());

  Future<_Notifier> open(
    WidgetTester tester, {
    String engine = 'claude',
  }) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1400, 1000);
    addTearDown(tester.view.reset);
    final notifier = _Notifier();
    addTearDown(notifier.dispose);
    const machine = Machine(
      machineId: 'machine-1',
      authMode: MachineAuthMode.remote,
      name: 'harness-remote-box',
    );
    final state = MachineState(machine)..localOnly = true;
    state.engines.replace(const [
      EngineAvailability(engine: 'claude', installed: true),
      EngineAvailability(engine: 'codex', installed: true),
      EngineAvailability(engine: 'pi', installed: true),
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
                initialEngine: engine,
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    final newProject = find.byKey(
      const ValueKey('new-agent-folder-newProject'),
    );
    await tester.ensureVisible(newProject);
    await tester.tap(newProject);
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byKey(const Key('new-agent-advanced')));
    await tester.tap(find.byKey(const Key('new-agent-advanced')));
    await tester.pumpAndSettle();
    return notifier;
  }

  final field = find.byKey(const Key('new-agent-permission-mode'));

  Future<void> pickMode(WidgetTester tester, String label) async {
    await tester.ensureVisible(field);
    await tester.tap(field);
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

  testWidgets('Auto-approve is the default', (tester) async {
    final app = await open(tester);
    expect(
      find.descendant(of: field, matching: find.text('Auto-approve')),
      findsOneWidget,
    );
    await create(tester);
    expect(app.launches.single, {
      'engine': 'claude',
      'mode': 'auto',
      'bypass': true,
    });
  });

  testWidgets('the menu says what each Claude Code mode does', (tester) async {
    await open(tester);
    await tester.ensureVisible(field);
    await tester.tap(field);
    await tester.pumpAndSettle();
    for (final mode in permissionModesOf('claude')) {
      expect(find.text(mode.label), findsWidgets);
      expect(find.text(mode.detail), findsOneWidget);
    }
  });

  testWidgets('Plan first is sent as a mode, and as no to an older machine', (
    tester,
  ) async {
    final app = await open(tester);
    await pickMode(tester, 'Plan first');
    expect(
      find.descendant(of: field, matching: find.text('Plan first')),
      findsOneWidget,
    );
    await create(tester);
    expect(app.launches.single, {
      'engine': 'claude',
      'mode': 'plan',
      'bypass': false,
    });
  });

  testWidgets('Skip all checks reads as yes to an older machine', (
    tester,
  ) async {
    final app = await open(tester);
    await pickMode(tester, 'Skip all checks');
    await create(tester);
    expect(app.launches.single, {
      'engine': 'claude',
      'mode': 'full',
      'bypass': true,
    });
  });

  testWidgets('Codex offers its own modes', (tester) async {
    final app = await open(tester, engine: 'codex');
    await pickMode(tester, 'Read only');
    await create(tester);
    expect(app.launches.single, {
      'engine': 'codex',
      'mode': 'readOnly',
      'bypass': false,
    });
  });

  testWidgets('a mode the next engine lacks falls back to its default', (
    tester,
  ) async {
    final app = await open(tester);
    await pickMode(tester, 'Plan first');
    await chooseAgent(tester, 'codex');
    await tester.pumpAndSettle();
    expect(
      find.descendant(of: field, matching: find.text('Auto-approve')),
      findsOneWidget,
    );
    await create(tester);
    expect(app.launches.single, {
      'engine': 'codex',
      'mode': 'auto',
      'bypass': true,
    });
  });

  testWidgets('a mode both engines have is kept across the switch', (
    tester,
  ) async {
    final app = await open(tester);
    await pickMode(tester, 'Ask first');
    await chooseAgent(tester, 'codex');
    await tester.pumpAndSettle();
    await create(tester);
    expect(app.launches.single, {
      'engine': 'codex',
      'mode': 'ask',
      'bypass': false,
    });
  });

  test('every engine with modes starts on Auto-approve and can ask', () {
    for (final MapEntry(key: engine, value: modes)
        in kEnginePermissionModes.entries) {
      expect(modes.first.id, kDefaultPermissionMode, reason: engine);
      expect(modes.map((mode) => mode.id), contains('ask'), reason: engine);
      expect(
        modes.map((mode) => mode.id).toSet(),
        hasLength(modes.length),
        reason: engine,
      );
    }
    expect(permissionModeApproves('auto'), isTrue);
    expect(permissionModeApproves('full'), isTrue);
    expect(permissionModeApproves('plan'), isFalse);
    expect(permissionModeApproves('ask'), isFalse);
  });
}
