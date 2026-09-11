// The preflight panel's job is to be right about what the click will do. It has a settled answer
// for "the engine is here", for "it is missing and we will install it" and for "it is missing and
// we cannot" — and it used to have none for "we asked and the machine never told us", which it
// rounded off to "Ready to launch".
//
// That is not a rare corner. A machine on an older Harness CLI does not know `engines_probe`, and
// does not refuse it either — the frame goes out over the relay and nothing ever comes back, so the
// app waits out its 30s timeout and then knows nothing. Meanwhile the panel had already promised a
// launch, and the create failed at the far end with `exec: opencode: not found`.
import 'package:file_selector_platform_interface/file_selector_platform_interface.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/new_agent_dialog.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const pickedFolder = '/Users/macbook/Downloads/20260907';
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
    void Function(MachineEngines engines) seed,
  ) async {
    final notifier = AppNotifier(
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
    await tester.tap(find.text('Browse…'));
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

    // "Ready to launch" is gone with the summary card, and so is the promise it
    // was making. What survives is the half that could not be said anywhere
    // else: that this machine was never reached.
    expect(
      find.textContaining('did not say which engines it has'),
      findsOneWidget,
    );
    // The way out is named, and so is what happens if it is ignored — the
    // create still runs, and a missing engine surfaces only as its failure.
    expect(
      find.textContaining('did not say which engines it has'),
      findsOneWidget,
    );
    expect(
      find.textContaining('will only show up when it fails'),
      findsOneWidget,
    );
    expect(
      find.textContaining('Updating the Harness CLI on harness-remote-box'),
      findsOneWidget,
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
      find.textContaining('did not say which engines it has'),
      findsNothing,
      reason: 'a probe that landed is not a probe that failed',
    );
  });
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
