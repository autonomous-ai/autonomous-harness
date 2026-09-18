// The preflight panel's job is to be right about what the click will do. It has a settled answer
// for "the engine is here", for "it is missing and we will install it" and for "it is missing and
// we cannot" — and it used to have none for "we asked and the machine never told us", which it
// rounded off to "Ready to launch".
//
// That is not a rare corner. A machine on an older Harness CLI does not know `engines_probe`, and
// does not refuse it either — the frame goes out over the relay and nothing ever comes back, so the
// app waits out its 30s timeout and then knows nothing. Meanwhile the panel had already promised a
// launch, and the create failed at the far end with `exec: opencode: not found`.
import 'support/new_agent_project.dart';

import 'dart:async';

import 'package:file_selector_platform_interface/file_selector_platform_interface.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/shared/widgets/app_choice_picker.dart';
import 'package:harness/widgets/agent_picker.dart';
import 'package:harness/widgets/new_agent_dialog.dart';

import 'support/agent_picker.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const pickedFolder = '/Users/example/Downloads/20260907';
  setUp(() => FileSelectorPlatform.instance = _StubFileSelector(pickedFolder));

  const machine = Machine(
    machineId: 'machine-1',
    authMode: MachineAuthMode.remote,
    name: 'harness-remote-box',
  );

  /// Opens the dialog with the machine's engine answer already in the state the
  /// test is about, then picks a folder — nothing in the panel is settled until
  /// one is chosen, and every heading here is downstream of that.
  Future<AppNotifier> openWith(
    WidgetTester tester,
    void Function(MachineEngines engines) seed, {
    AppNotifier? app,
  }) async {
    final notifier =
        app ??
        AppNotifier(
          config: AppConfig.dev,
          authSession: AuthSession(),
          configStore: null,
        );
    addTearDown(notifier.dispose);
    final state = MachineState(machine)..localOnly = true;
    seed(state.engines);
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
    // 'Browse…' until a folder is chosen; 'Change' after.
    await browseNewAgentProject(tester);
    await tester.pumpAndSettle();
    return notifier;
  }

  testWidgets('a machine that never answered is not called ready', (
    tester,
  ) async {
    await openWith(
      tester,
      (engines) => engines.error = 'This machine could not report its engines',
    );

    // Failed checks remain distinct from a missing engine; creation can still
    // be attempted and troubleshooting stays in the optional details.
    expect(find.textContaining('Couldn’t check whether'), findsOneWidget);
    expect(
      find.textContaining('You can still try creating the harness.'),
      findsOneWidget,
    );
    expect(find.textContaining('uses an older Harness CLI'), findsNothing);
    await tester.ensureVisible(find.byKey(const Key('new-agent-advanced')));
    await tester.tap(find.byKey(const Key('new-agent-advanced')));
    await tester.pump();
    expect(
      find.textContaining('If harness-remote-box uses an older Harness CLI'),
      findsNothing,
    );
  });

  testWidgets('a machine that answered keeps its confident heading', (
    tester,
  ) async {
    await openWith(
      tester,
      (engines) => engines.replace(const [
        EngineAvailability(engine: 'claude', installed: true),
      ]),
    );

    // A machine that answered says nothing at all now. The old card printed
    // "Ready to launch" over every healthy launch, which is a line that tells
    // somebody the default is the default; the line below only appears when
    // there is something to say.
    expect(
      find.textContaining('Couldn’t check whether'),
      findsNothing,
      reason: 'a probe that landed is not a probe that failed',
    );
  });

  testWidgets('retry checks agents without losing choices or starting one', (
    tester,
  ) async {
    final app = _RetryNotifier();
    await openWith(
      tester,
      (engines) => engines.error = 'Check failed',
      app: app,
    );
    await chooseAgent(tester, 'codex');
    await tester.ensureVisible(find.byKey(const Key('new-agent-advanced')));
    await tester.tap(find.byKey(const Key('new-agent-advanced')));
    await tester.pumpAndSettle();
    await tester.ensureVisible(
      find.byKey(const Key('new-agent-permission-mode')),
    );
    await tester.tap(find.byKey(const Key('new-agent-permission-mode')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Ask first').last);
    await tester.pumpAndSettle();
    final retry = find.byKey(const Key('new-agent-retry-check'));
    await tester.ensureVisible(retry);
    final pending = app.pending['machine-1'] = Completer<void>();
    await tester.tap(retry);
    await tester.pump();
    expect(app.probes, ['machine-1', 'machine-1']);
    expect(tester.widget<TextButton>(retry).onPressed, isNull);
    expect(find.text('Checking…'), findsOneWidget);
    expect(app.launches, isEmpty);
    expect(find.textContaining('Reopen this dialog'), findsNothing);

    // A failed retry remains in the same form and is immediately retryable.
    pending.complete();
    await tester.pumpAndSettle();
    expect(tester.widget<TextButton>(retry).onPressed, isNotNull);
    final recovered = app.pending['machine-1'] = Completer<void>();
    await tester.tap(retry);
    await tester.pump();
    app.machineStates['machine-1']!.engines.replace(const [
      EngineAvailability(engine: 'claude', installed: true),
      EngineAvailability(
        engine: 'codex',
        installed: true,
        supportsCodexHome: true,
      ),
    ]);
    recovered.complete();
    await tester.pumpAndSettle();

    expect(find.byType(AlertDialog), findsOneWidget);
    expect(retry, findsNothing);
    expect(find.text('20260907'), findsOneWidget);
    expect(find.text(pickedFolder), findsNothing);
    expect(tester.widget<AgentPicker>(find.byType(AgentPicker)).value, 'codex');
    expect(app.profileChecks, ['machine-1']);
    expect(
      find.byKey(const Key('new-agent-codex-profile-field')),
      findsOneWidget,
    );
    expect(app.launches, isEmpty);
    await tester.tap(find.byKey(const ValueKey('create-agent-submit')));
    await tester.pump();
    expect(app.launches.single, {
      'machine': 'machine-1',
      'engine': 'codex',
      'folder': pickedFolder,
      // Auto-approve by default; Ask first was picked above, and the retry kept that choice.
      'bypass': false,
    });
    expect(tester.takeException(), isNull);
  });

  testWidgets('a retry for another machine cannot change the current choice', (
    tester,
  ) async {
    final app = _RetryNotifier();
    app.machineStates['machine-2'] = MachineState(
      const Machine(
        machineId: 'machine-2',
        authMode: MachineAuthMode.remote,
        name: 'Other computer',
      ),
    );
    await openWith(
      tester,
      (engines) => engines.error = 'Check failed',
      app: app,
    );
    final pending = app.pending['machine-1'] = Completer<void>();
    await tester.ensureVisible(find.byKey(const Key('new-agent-retry-check')));
    await tester.tap(find.byKey(const Key('new-agent-retry-check')));
    await tester.pump();
    await tester.pump();
    final otherMachine = find.byKey(
      const ValueKey('new-agent-machine-machine-2'),
    );
    await tester.ensureVisible(otherMachine);
    await tester.tap(otherMachine);
    await tester.pumpAndSettle();
    await chooseAgent(tester, 'codex');
    await tester.ensureVisible(find.byKey(const Key('new-agent-advanced')));
    await tester.tap(find.byKey(const Key('new-agent-advanced')));
    await tester.pumpAndSettle();
    expect(
      find.text('Checking whether Other computer supports Codex profiles…'),
      findsOneWidget,
    );
    app.machineStates['machine-1']!.engines.replace(const [
      EngineAvailability(engine: 'claude', installed: true),
    ]);
    pending.complete();
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<AppChoicePicker<String>>(
            find.byKey(const Key('new-agent-machine-field')),
          )
          .value,
      'machine-2',
    );
    expect(tester.widget<AgentPicker>(find.byType(AgentPicker)).value, 'codex');
    expect(find.text('20260907'), findsNothing);
    expect(app.launches, isEmpty);
    expect(tester.takeException(), isNull);
  });
}

class _RetryNotifier extends AppNotifier {
  _RetryNotifier()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );

  final pending = <String, Completer<void>>{};
  final probes = <String>[];
  final profileChecks = <String>[];
  final launches = <Map<String, Object>>[];

  @override
  Future<void> probeEngines(String machineId, {bool force = false}) {
    final engines = machineStates[machineId]!.engines;
    if (engines.inFlight != null) return engines.inFlight!;
    probes.add(machineId);
    final reply = pending[machineId];
    if (reply == null) return Future.value();
    final work = reply.future.whenComplete(() {
      engines.inFlight = null;
      notifyListeners();
    });
    engines.inFlight = work;
    notifyListeners();
    return work;
  }

  @override
  Future<Map<String, dynamic>> listCodexProfiles(
    String machineId, {
    Set<String> observedPaths = const {},
  }) async {
    profileChecks.add(machineId);
    return {'profiles': <dynamic>[]};
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
    launches.add({
      'machine': machineId,
      'engine': engine,
      'folder': folder!,
      'bypass': bypassPermission,
    });
    return 'Test launch refused.';
  }
}

class _StubFileSelector extends FileSelectorPlatform {
  _StubFileSelector(this.path);

  final String path;

  @override
  Future<String?> getDirectoryPath({
    String? initialDirectory,
    String? confirmButtonText,
  }) async => path;
}
