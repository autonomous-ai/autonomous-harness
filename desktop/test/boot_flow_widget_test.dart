import 'dart:async';

import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/bootstrap/environment_provisioner.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/core/models.dart';
import 'package:harness/main.dart';
import 'package:harness/settings/config_store.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/update/desktop_updater.dart';
import 'package:harness/update/manual_update_check.dart';
import 'package:harness/widgets/update_notice.dart';
import 'package:harness/widgets/bootstrapping_screen.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:package_info_plus/package_info_plus.dart';

/// Builds an AppNotifier without touching persisted state or the network:
/// status is set directly, so bootstrap/login (which call platform
/// channels and the network) never run.
AppNotifier makeNotifier(AppStatus status) {
  final app = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
  );
  app.status = status;
  app.currentUser = const CurrentUserProfile(
    id: 'user-1',
    name: 'Diego',
    email: 'diego@autonomous.ai',
  );
  return app;
}

/// bootstrap() now asks the CLI (not AuthSession) whether this computer is signed in — this fake
/// avoids ever shelling out to a real `harness` binary from a unit test.
class _FakeCliLogin extends CliLogin {
  final bool loggedIn;
  _FakeCliLogin({this.loggedIn = false});

  @override
  Future<CliAuthStatus> checkStatus() async =>
      CliAuthStatus(loggedIn: loggedIn);
}

class _ControlledCliLogin extends CliLogin {
  final Completer<CliAuthStatus> status = Completer<CliAuthStatus>();

  @override
  Future<CliAuthStatus> checkStatus() => status.future;
}

class _BrokenConfigStore extends ConfigStore {
  var resetCalls = 0;

  @override
  Future<AppConfig> load() async => throw StateError('state file unavailable');

  @override
  Future<void> reset() async {
    resetCalls++;
  }
}

class _ReadyEnvironmentProvisioner extends EnvironmentProvisioner {
  bool called = false;
  _ReadyEnvironmentProvisioner() : super(isMacOS: true);

  @override
  Future<EnvironmentReadiness> ensureReady({
    required void Function(EnvironmentReadiness value) onProgress,
    EnvironmentReadiness? resumeFrom,
    bool install = true,
    EnvironmentSetupMode? mode,
  }) async {
    called = true;
    final ready = EnvironmentReadiness(
      steps: {
        for (final step in EnvironmentStep.values)
          step: EnvironmentStepStatus.ready,
      },
      systemReady: true,
    );
    onProgress(ready);
    return ready;
  }
}

/// Returns one scripted [EnvironmentReadiness] per call to `ensureReady`, and records the
/// `resumeFrom` each call was given — lets a test assert `recheckEnvironmentStep` passed the
/// current stuck state back in, and that a step already `ready` is never handed a fresh probe.
class _ScriptedEnvironmentProvisioner extends EnvironmentProvisioner {
  final List<EnvironmentReadiness> results;
  final List<List<EnvironmentReadiness>> progress;
  final List<EnvironmentReadiness?> resumeFromCalls = [];
  final List<bool> installCalls = [];
  var callCount = 0;
  _ScriptedEnvironmentProvisioner(this.results, {this.progress = const []})
    : super(isMacOS: true);

  @override
  Future<EnvironmentReadiness> ensureReady({
    required void Function(EnvironmentReadiness value) onProgress,
    EnvironmentReadiness? resumeFrom,
    bool install = true,
    EnvironmentSetupMode? mode,
  }) async {
    resumeFromCalls.add(resumeFrom);
    installCalls.add(install);
    final index = callCount < results.length ? callCount : results.length - 1;
    final result = results[index];
    if (index < progress.length) {
      for (final value in progress[index]) {
        onProgress(value);
      }
    }
    callCount++;
    onProgress(result);
    return result;
  }
}

class _FakeKeyValueStore implements LocalKeyValueStore {
  final Map<String, String> values = {};

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async {
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async => values.remove(key);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  // The Harness menu prints the running version. Without this the plugin
  // channel throws and the row renders a placeholder, which would make the
  // assertion below pass for the wrong reason.
  PackageInfo.setMockInitialValues(
    appName: 'Harness',
    packageName: 'ai.autonomous.harness',
    version: '1.0.0',
    buildNumber: '1',
    buildSignature: '',
  );

  test('local manual fixture boots without SSO or persisted state', () async {
    final app = AppNotifier(
      config: const AppConfig(apiBaseUrl: 'http://127.0.0.1:12345'),
      authSession: AuthSession(),
      localManualFixture: const LocalManualFixture(
        apiBaseUrl: 'http://127.0.0.1:12345',
        apiKey:
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        machineId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        machineName: 'local-manual',
        setupToken: 'ephemeral-setup-token',
      ),
    );

    await app.bootstrap();

    expect(app.status, AppStatus.authenticated);
    expect(app.config.apiBaseUrl, 'http://127.0.0.1:12345');
    expect(app.machines, hasLength(1));
    expect(app.machines.single.displayName, 'local-manual');
    expect(app.machines.single.authMode, MachineAuthMode.remote);
    expect(app.currentUser?.displayName, 'Local session');
  });

  test(
    'config-store failure falls back without resetting auth preferences',
    () async {
      final store = _BrokenConfigStore();
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: store,
        cliLogin: _FakeCliLogin(loggedIn: false),
        environmentProvisioner: _ReadyEnvironmentProvisioner(),
      );

      await app.bootstrap();

      expect(app.status, AppStatus.unauthenticated);
      expect(app.config.apiBaseUrl, ConfigStore.defaultBaseUrl);
      expect(app.autonomousEnv, 'prod');
      expect(store.resetCalls, 0);
    },
  );

  test(
    'a legacy setup version never bypasses the live readiness probe',
    () async {
      final storage = _FakeKeyValueStore()
        ..values['environment_setup_version'] = '3';
      final provisioner = _ReadyEnvironmentProvisioner();
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: ConfigStore(storage: storage),
        cliLogin: _FakeCliLogin(loggedIn: false),
        environmentProvisioner: provisioner,
      );

      await app.bootstrap();

      expect(provisioner.called, isTrue);
      expect(app.environmentReadiness.isReady, isTrue);
      // Reached the login check rather than getting stuck on preparingEnvironment.
      expect(app.status, AppStatus.unauthenticated);
    },
  );

  test(
    'a successful readiness probe does not persist a setup version',
    () async {
      final storage = _FakeKeyValueStore();
      final provisioner = _ReadyEnvironmentProvisioner();
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: ConfigStore(storage: storage),
        cliLogin: _FakeCliLogin(loggedIn: false),
        environmentProvisioner: provisioner,
      );

      await app.bootstrap();

      expect(provisioner.called, isTrue);
      expect(storage.values['environment_setup_version'], isNull);
    },
  );

  test(
    'boot probes read-only and installs only after explicit confirmation',
    () async {
      final missing = EnvironmentReadiness(
        steps: {
          EnvironmentStep.harness: EnvironmentStepStatus.failed,
          EnvironmentStep.tmux: EnvironmentStepStatus.ready,
        },
        phase: EnvironmentSetupPhase.review,
      );
      final ready = EnvironmentReadiness(
        steps: {
          for (final step in EnvironmentStep.values)
            step: EnvironmentStepStatus.ready,
        },
        phase: EnvironmentSetupPhase.ready,
        mode: EnvironmentSetupMode.automatic,
        systemReady: true,
      );
      final provisioner = _ScriptedEnvironmentProvisioner([missing, ready]);
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: ConfigStore(storage: _FakeKeyValueStore()),
        cliLogin: _FakeCliLogin(loggedIn: false),
        environmentProvisioner: provisioner,
      );

      await app.bootstrap();
      expect(provisioner.installCalls, [isFalse]);
      expect(app.status, AppStatus.preparingEnvironment);

      app.selectEnvironmentSetupMode(EnvironmentSetupMode.automatic);
      final painted = <(AppStatus, EnvironmentSetupPhase)>[];
      app.addListener(
        () => painted.add((app.status, app.environmentReadiness.phase)),
      );
      await app.startEnvironmentSetup();
      expect(provisioner.installCalls, [isFalse, isTrue]);
      expect(app.status, AppStatus.unauthenticated);
      expect(app.environmentReadiness.phase, EnvironmentSetupPhase.ready);
      expect(
        painted,
        isNot(
          contains((
            AppStatus.preparingEnvironment,
            EnvironmentSetupPhase.ready,
          )),
        ),
      );
      app.dispose();
    },
  );

  test(
    'recheckEnvironmentStep succeeds and continues past environment setup',
    () async {
      final stuck = EnvironmentReadiness(
        steps: {
          EnvironmentStep.harness: EnvironmentStepStatus.ready,
          EnvironmentStep.tmux: EnvironmentStepStatus.needsTerminal,
        },
        phase: EnvironmentSetupPhase.waitingForTerminal,
        mode: EnvironmentSetupMode.automatic,
      );
      final ready = EnvironmentReadiness(
        steps: {
          for (final step in EnvironmentStep.values)
            step: EnvironmentStepStatus.ready,
        },
        systemReady: true,
      );
      final storage = _FakeKeyValueStore();
      final provisioner = _ScriptedEnvironmentProvisioner([stuck, ready]);
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: ConfigStore(storage: storage),
        cliLogin: _FakeCliLogin(loggedIn: false),
        environmentProvisioner: provisioner,
      );

      await app.bootstrap();
      expect(
        app.environmentReadiness.steps[EnvironmentStep.tmux],
        EnvironmentStepStatus.needsTerminal,
      );
      expect(app.status, AppStatus.preparingEnvironment);

      await app.recheckEnvironmentStep(EnvironmentStep.tmux);

      // The user's current (stuck) readiness was handed back in, not a fresh `initial()` — this is
      // what lets the provisioner skip the already-`ready` harness step during the recheck.
      expect(provisioner.resumeFromCalls.last, same(stuck));
      expect(app.environmentReadiness.isReady, isTrue);
      expect(app.status, AppStatus.unauthenticated);
      expect(storage.values['environment_setup_version'], isNull);
      expect(app.environmentRecheckPending, isFalse);
      app.dispose();
    },
  );

  test(
    'recheckEnvironmentStep still stuck keeps polling instead of advancing',
    () async {
      final stuck = EnvironmentReadiness(
        steps: {
          EnvironmentStep.harness: EnvironmentStepStatus.ready,
          EnvironmentStep.tmux: EnvironmentStepStatus.needsTerminal,
        },
        phase: EnvironmentSetupPhase.waitingForTerminal,
        mode: EnvironmentSetupMode.automatic,
      );
      final storage = _FakeKeyValueStore();
      final provisioner = _ScriptedEnvironmentProvisioner([stuck, stuck]);
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: ConfigStore(storage: storage),
        cliLogin: _FakeCliLogin(loggedIn: false),
        environmentProvisioner: provisioner,
      );

      await app.bootstrap();
      // Launch checks are read-only and do not start an install/poll loop.
      expect(app.environmentRecheckPending, isFalse);

      await app.recheckEnvironmentStep(EnvironmentStep.tmux);

      expect(app.status, AppStatus.preparingEnvironment);
      expect(app.environmentReadiness.isReady, isFalse);
      expect(storage.values['environment_setup_version'], isNull);
      // Rescheduled rather than given up on.
      expect(app.environmentRecheckPending, isTrue);
      app.dispose();
    },
  );

  test(
    'automatic Terminal polling keeps the waiting UI phase stable',
    () async {
      final waiting = EnvironmentReadiness(
        steps: {
          EnvironmentStep.harness: EnvironmentStepStatus.failed,
          EnvironmentStep.tmux: EnvironmentStepStatus.needsTerminal,
        },
        phase: EnvironmentSetupPhase.waitingForTerminal,
        mode: EnvironmentSetupMode.automatic,
        systemReady: true,
      );
      final probing = waiting.copyWith(phase: EnvironmentSetupPhase.preflight);
      final reviewed = waiting.copyWith(
        phase: EnvironmentSetupPhase.review,
        steps: {
          EnvironmentStep.harness: EnvironmentStepStatus.failed,
          EnvironmentStep.tmux: EnvironmentStepStatus.failed,
        },
      );
      final provisioner = _ScriptedEnvironmentProvisioner(
        [waiting, reviewed],
        progress: [
          const [],
          [probing, reviewed],
        ],
      );
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: ConfigStore(storage: _FakeKeyValueStore()),
        cliLogin: _FakeCliLogin(loggedIn: false),
        environmentProvisioner: provisioner,
      );
      await app.bootstrap();
      final paintedPhases = <EnvironmentSetupPhase>[];
      app.addListener(() => paintedPhases.add(app.environmentReadiness.phase));

      await app.recheckEnvironmentStep(EnvironmentStep.tmux);

      expect(paintedPhases, isNot(contains(EnvironmentSetupPhase.preflight)));
      expect(paintedPhases, isNot(contains(EnvironmentSetupPhase.review)));
      expect(
        app.environmentReadiness.phase,
        EnvironmentSetupPhase.waitingForTerminal,
      );
      expect(
        app.environmentReadiness.steps[EnvironmentStep.tmux],
        EnvironmentStepStatus.needsTerminal,
      );
      app.dispose();
    },
  );

  test(
    'Linux system-only Terminal waiting polls without starting another install',
    () async {
      final waiting = EnvironmentReadiness(
        steps: {
          EnvironmentStep.harness: EnvironmentStepStatus.failed,
          EnvironmentStep.tmux: EnvironmentStepStatus.ready,
        },
        phase: EnvironmentSetupPhase.waitingForTerminal,
        mode: EnvironmentSetupMode.automatic,
        terminalSetup: EnvironmentTerminalSetup.linuxHost,
        systemReady: false,
      );
      final provisioner = _ScriptedEnvironmentProvisioner([waiting, waiting]);
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: ConfigStore(storage: _FakeKeyValueStore()),
        cliLogin: _FakeCliLogin(loggedIn: false),
        environmentProvisioner: provisioner,
      );
      await app.bootstrap();

      await app.recheckEnvironmentStep(EnvironmentStep.tmux);

      expect(provisioner.installCalls, [false, false]);
      expect(
        app.environmentReadiness.terminalSetup,
        EnvironmentTerminalSetup.linuxHost,
      );
      expect(
        app.environmentReadiness.phase,
        EnvironmentSetupPhase.waitingForTerminal,
      );
      expect(app.environmentRecheckPending, isTrue);
      app.dispose();
    },
  );

  testWidgets('boot -> unauthenticated shows LoginScreen', (tester) async {
    final app = makeNotifier(AppStatus.unauthenticated);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [appStateProvider.overrideWithValue(app)],
        child: const DesktopApp(),
      ),
    );
    // `pump`, not `pumpAndSettle`: the sign-in screen's diagram and aurora
    // animate forever by design, so settling never arrives. See
    // `login_screen_test.dart` for the full note.
    await tester.pump(const Duration(milliseconds: 200));

    // The card leads with what the app does for you, not with its own name —
    // the wordmark left when the screen stopped being a logo over a button.
    expect(find.text('All your agents, on one screen'), findsOneWidget);
    expect(find.text('Sign in'), findsOneWidget);
    expect(find.byIcon(Icons.login), findsOneWidget);
  });

  testWidgets('bootstrapping shows branded startup screen (pre-login)', (
    tester,
  ) async {
    final app = makeNotifier(AppStatus.bootstrapping);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [appStateProvider.overrideWithValue(app)],
        child: const DesktopApp(),
      ),
    );
    await tester.pump();

    // RootShell renders the designed startup bridge while bootstrapping, not
    // LoginScreen. Keep this on the real RootShell so notifier wiring remains
    // covered as well as the standalone screen's presentation tests.
    expect(find.byType(BootstrappingScreen), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.text('Getting Harness ready'), findsOneWidget);
    expect(find.text('Opening Harness…'), findsOneWidget);
    expect(find.text('Sign in'), findsNothing);
  });

  testWidgets('live pre-flight has its own quiet screen', (tester) async {
    final app = makeNotifier(AppStatus.checkingEnvironment);
    app.environmentReadiness = EnvironmentReadiness.initial();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [appStateProvider.overrideWithValue(app)],
        child: const DesktopApp(),
      ),
    );
    await tester.pump();

    expect(find.text('Checking this computer'), findsOneWidget);
    expect(find.textContaining('read-only'), findsOneWidget);
    expect(find.text('ENVIRONMENT SETUP'), findsNothing);
    expect(find.text('Pre-flight check'), findsNothing);
  });

  testWidgets(
    'ready pre-flight is visible while auth resolves, then opens login',
    (tester) async {
      final cliLogin = _ControlledCliLogin();
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: ConfigStore(storage: _FakeKeyValueStore()),
        cliLogin: cliLogin,
        environmentProvisioner: _ReadyEnvironmentProvisioner(),
      );
      await tester.pumpWidget(
        ProviderScope(
          overrides: [appStateProvider.overrideWithValue(app)],
          child: const DesktopApp(),
        ),
      );

      final bootstrap = app.bootstrap();
      await tester.pump();
      await tester.pump();

      expect(app.status, AppStatus.checkingEnvironment);
      expect(find.text('Environment ready'), findsOneWidget);
      expect(find.text('Continue to sign in'), findsNothing);
      expect(find.text('ENVIRONMENT SETUP'), findsNothing);

      cliLogin.status.complete(const CliAuthStatus(loggedIn: false));
      await bootstrap;
      await tester.pump();

      expect(app.status, AppStatus.unauthenticated);
      expect(find.text('Sign in'), findsOneWidget);
      app.dispose();
    },
  );

  testWidgets(
    'environment setup exposes per-step guidance and a scoped recheck',
    (tester) async {
      final app = makeNotifier(AppStatus.preparingEnvironment);
      app.environmentReadiness = EnvironmentReadiness(
        steps: {
          EnvironmentStep.harness: EnvironmentStepStatus.ready,
          EnvironmentStep.tmux: EnvironmentStepStatus.needsTerminal,
        },
        message:
            'Complete the setup in the terminal window, then click Recheck.',
        phase: EnvironmentSetupPhase.waitingForTerminal,
        mode: EnvironmentSetupMode.automatic,
      );
      await tester.pumpWidget(
        ProviderScope(
          overrides: [appStateProvider.overrideWithValue(app)],
          child: const DesktopApp(),
        ),
      );
      await tester.pump();

      expect(find.text('Finish the secure Terminal step'), findsOneWidget);
      expect(find.text('Managed Node 20+ & Harness CLI'), findsOneWidget);
      expect(find.text('Recheck now'), findsOneWidget);
      expect(find.text('Harness cannot see your password'), findsOneWidget);
    },
  );

  testWidgets('environment wizard exposes automatic and manual setup paths', (
    tester,
  ) async {
    final app = makeNotifier(AppStatus.preparingEnvironment);
    app.environmentReadiness = EnvironmentReadiness(
      steps: {
        EnvironmentStep.harness: EnvironmentStepStatus.failed,
        EnvironmentStep.tmux: EnvironmentStepStatus.ready,
      },
      phase: EnvironmentSetupPhase.review,
    );
    await tester.pumpWidget(
      ProviderScope(
        overrides: [appStateProvider.overrideWithValue(app)],
        child: const DesktopApp(),
      ),
    );
    await tester.pump();

    expect(find.text('Here is exactly what is required'), findsOneWidget);
    expect(find.text('HOST DEPENDENCIES'), findsOneWidget);
    expect(find.text('HARNESS COMPONENTS'), findsOneWidget);
    expect(find.text('Final verification'), findsNothing);
    expect(find.text('Apple developer tools'), findsNothing);
    await tester.tap(find.text('Continue'));
    await tester.pump();

    expect(find.text('Automatic'), findsOneWidget);
    expect(find.text('Manual'), findsOneWidget);
    expect(find.text('Admin prompts stay in Terminal'), findsOneWidget);
    await tester.tap(find.text('Manual'));
    await tester.pump();

    expect(find.textContaining('/bin/sh -s -- --desktop'), findsOneWidget);
    expect(find.text('I ran these · Recheck'), findsOneWidget);
  });

  testWidgets('install plan and manual commands show only missing tools', (
    tester,
  ) async {
    final app = makeNotifier(AppStatus.preparingEnvironment);
    app.environmentReadiness = const EnvironmentReadiness(
      steps: {
        EnvironmentStep.clipboard: EnvironmentStepStatus.notApplicable,
        EnvironmentStep.harness: EnvironmentStepStatus.ready,
        EnvironmentStep.tmux: EnvironmentStepStatus.failed,
      },
      phase: EnvironmentSetupPhase.chooseMethod,
      mode: EnvironmentSetupMode.automatic,
      systemReady: true,
      homebrewReady: false,
      tmuxBinaryReady: false,
    );
    await tester.pumpWidget(
      ProviderScope(
        overrides: [appStateProvider.overrideWithValue(app)],
        child: const DesktopApp(),
      ),
    );
    await tester.pump();

    expect(find.text('Homebrew'), findsOneWidget);
    expect(find.text('tmux'), findsOneWidget);
    expect(find.text('Managed Node 20+ & Harness CLI'), findsNothing);
    expect(find.text('Install 2 tools'), findsOneWidget);
    expect(find.text('Admin prompts stay in Terminal'), findsOneWidget);

    await tester.tap(find.text('Manual'));
    await tester.pump();

    expect(find.text('1 · Homebrew'), findsOneWidget);
    expect(find.text('2 · tmux'), findsOneWidget);
    expect(
      find.textContaining('Homebrew/install/HEAD/install.sh'),
      findsOneWidget,
    );
    expect(find.textContaining('brew install tmux'), findsOneWidget);
    expect(find.textContaining('cdn.autonomous.ai'), findsNothing);
  });

  testWidgets('CLI-only install plan does not warn about admin prompts', (
    tester,
  ) async {
    final app = makeNotifier(AppStatus.preparingEnvironment);
    app.environmentReadiness = const EnvironmentReadiness(
      steps: {
        EnvironmentStep.clipboard: EnvironmentStepStatus.notApplicable,
        EnvironmentStep.harness: EnvironmentStepStatus.failed,
        EnvironmentStep.tmux: EnvironmentStepStatus.ready,
      },
      phase: EnvironmentSetupPhase.chooseMethod,
      mode: EnvironmentSetupMode.automatic,
      systemReady: true,
      homebrewReady: true,
      tmuxBinaryReady: true,
    );
    await tester.pumpWidget(
      ProviderScope(
        overrides: [appStateProvider.overrideWithValue(app)],
        child: const DesktopApp(),
      ),
    );
    await tester.pump();

    expect(find.text('Managed Node 20+ & Harness CLI'), findsOneWidget);
    expect(find.text('Homebrew'), findsNothing);
    expect(find.text('tmux'), findsNothing);
    expect(find.text('Install 1 tool'), findsOneWidget);
    expect(find.text('Admin prompts stay in Terminal'), findsNothing);
  });

  testWidgets('review marks unusable Apple developer tools as missing', (
    tester,
  ) async {
    final app = makeNotifier(AppStatus.preparingEnvironment);
    app.environmentReadiness = const EnvironmentReadiness(
      steps: {
        EnvironmentStep.harness: EnvironmentStepStatus.ready,
        EnvironmentStep.tmux: EnvironmentStepStatus.ready,
      },
      phase: EnvironmentSetupPhase.review,
      systemReady: false,
    );
    await tester.pumpWidget(
      ProviderScope(
        overrides: [appStateProvider.overrideWithValue(app)],
        child: const DesktopApp(),
      ),
    );
    await tester.pump();

    expect(find.text('System tools & writable home'), findsOneWidget);
    expect(find.text('Missing'), findsOneWidget);
  });

  testWidgets('RootShell rebuilds to LoginScreen when status flips after boot', (
    tester,
  ) async {
    // Regression: RootShell must listen to the AppNotifier, otherwise a status
    // change after the first build (e.g. bootstrap -> unauthenticated) never
    // rebuilds and the app sticks on the boot spinner.
    final app = makeNotifier(AppStatus.bootstrapping);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [appStateProvider.overrideWithValue(app)],
        child: const DesktopApp(),
      ),
    );
    await tester.pump();
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.text('Sign in'), findsNothing);

    app.status = AppStatus.unauthenticated;
    app.notifyListeners();
    await tester.pump();

    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(find.text('Sign in'), findsOneWidget);
  });

  testWidgets(
    'authenticated with no machines shows terminal rail + empty terminal',
    (tester) async {
      final app = makeNotifier(AppStatus.authenticated);
      await tester.pumpWidget(
        ProviderScope(
          overrides: [appStateProvider.overrideWithValue(app)],
          child: const DesktopApp(),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.text('Select an agent, or drag one in from the left.'),
        findsOneWidget,
      );
      expect(find.text('diego@autonomous.ai'), findsOneWidget);
      expect(find.byKey(const Key('account-menu-button')), findsOneWidget);
      expect(find.byIcon(LucideIcons.logOut300), findsNothing);
      // The rail is present. Not asserted on the filter field, which lives
      // behind the rail's search toggle, nor on the "Machines" heading it used
      // to check — a machine is a caption over its own agents now, so a caption
      // over the captions would be two headings deep. This case is "no
      // machines", and the rail's own answer to that is the thing to look for.
      expect(find.text('no remote machines'), findsOneWidget);

      await tester.tap(find.byKey(const Key('account-menu-button')));
      await tester.pumpAndSettle();

      expect(find.text('Diego'), findsOneWidget);
      expect(find.text('Sign out'), findsOneWidget);
      expect(find.byIcon(LucideIcons.logOut300), findsOneWidget);
      expect(find.text('Remote into another machine…'), findsOneWidget);

      // The running version is no longer a row in this menu: it moved to
      // Settings ▸ About when Settings became a screen, and
      // settings_screen_test is where it is asserted now. What this menu still
      // owes is the order — what you can add, then the way out.
      final linkY = tester
          .getTopLeft(find.byKey(const Key('link-a-machine-menu-item')))
          .dy;
      final signOutY = tester
          .getTopLeft(find.byKey(const Key('sign-out-menu-item')))
          .dy;
      expect(linkY, lessThan(signOutY));
    },
  );

  testWidgets('Settings sits directly above Sign out in the account menu', (
    tester,
  ) async {
    final app = makeNotifier(AppStatus.authenticated);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [appStateProvider.overrideWithValue(app)],
        child: const DesktopApp(),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('account-menu-button')));
    await tester.pumpAndSettle();

    expect(find.text('Settings'), findsOneWidget);

    final linkY = tester
        .getTopLeft(find.byKey(const Key('link-a-machine-menu-item')))
        .dy;
    final settingsY = tester
        .getTopLeft(find.byKey(const Key('settings-menu-item')))
        .dy;
    final signOutY = tester
        .getTopLeft(find.byKey(const Key('sign-out-menu-item')))
        .dy;
    expect(linkY, lessThan(settingsY));
    expect(settingsY, lessThan(signOutY));
  });

  testWidgets('available update is shown above the login screen', (
    tester,
  ) async {
    final app = makeNotifier(AppStatus.unauthenticated);
    app.availableUpdate = const UpdateInfo(
      version: '1.2.3',
      url: 'https://example.test/Harness-macos.zip',
      sha256:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      size: 1,
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [appStateProvider.overrideWithValue(app)],
        child: const DesktopApp(),
      ),
    );
    // Endless animation on the sign-in screen underneath; pump instead.
    await tester.pump(const Duration(milliseconds: 200));

    expect(find.text('Harness 1.2.3 is available'), findsOneWidget);
    expect(find.byKey(const Key('install-update-button')), findsOneWidget);
    expect(find.byKey(const Key('skip-update-button')), findsOneWidget);
  });

  testWidgets('manual update dialog can close without skipping the version', (
    tester,
  ) async {
    final app = makeNotifier(AppStatus.authenticated);
    await tester.pumpWidget(const MaterialApp(home: Placeholder()));

    final dialog = showUpdateCheckDialog(
      tester.element(find.byType(Placeholder)),
      app,
      const ManualUpdateCheck(
        update: UpdateInfo(
          version: '1.2.3',
          url: 'https://example.test/Harness-macos.zip',
          sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          size: 1,
        ),
        isSkipped: true,
      ),
    );
    await tester.pump();

    expect(find.byKey(const Key('close-update-dialog-button')), findsOneWidget);
    expect(find.text('Close'), findsOneWidget);

    await tester.tap(find.byKey(const Key('close-update-dialog-button')));
    await tester.pumpAndSettle();
    await dialog;

    expect(find.byKey(const Key('close-update-dialog-button')), findsNothing);
    app.dispose();
  });

  testWidgets('offline selected agent shows the Harness join guide', (
    tester,
  ) async {
    final app = makeNotifier(AppStatus.authenticated);
    const machine = Machine(
      machineId: 'offline-machine',
      apiKey: '',
      authMode: MachineAuthMode.remote,
      name: 'offline-mac',
      status: 'offline',
    );
    final state = MachineState(machine)
      ..localOnly = true
      ..nodeOnline = false
      ..activeAgentId = 'offline-agent'
      ..pendingOfflineAgentId = 'offline-agent'
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..agents = [
        Agent.fromJson({
          'id': 'offline-agent',
          'name': 'claude-session',
          'engine': 'claude',
          'terminal': {
            'runtimes': [
              {'backend': 'tmux', 'paneId': '%1'},
            ],
          },
        }),
      ];
    app.machines = [machine];
    app.machineStates[machine.machineId] = state;
    app.expandedMachines.add(machine.machineId);
    app.selectedMachineId = machine.machineId;
    await app.selectAgent(machine.machineId, 'offline-agent');

    await tester.pumpWidget(
      ProviderScope(
        overrides: [appStateProvider.overrideWithValue(app)],
        child: const DesktopApp(),
      ),
    );
    await tester.pump();

    expect(find.text('Harness is offline'), findsOneWidget);
    expect(find.text('harness start'), findsOneWidget);
    app.dispose();
  });

  testWidgets('unlinked remote with a pending agent shows the link form', (
    tester,
  ) async {
    final app = makeNotifier(AppStatus.authenticated);
    const machine = Machine(
      machineId: 'unlinked-machine',
      apiKey: '',
      authMode: MachineAuthMode.remote,
      name: 'remote-mac',
      status: 'online',
    );
    final state = MachineState(machine)
      ..nodeOnline = false
      ..needsLink = true
      ..activeAgentId = 'previous-agent'
      ..pendingOfflineAgentId = 'previous-agent'
      ..agentLoadStatus = AgentLoadStatus.needsLink
      ..agents = [
        Agent.fromJson({
          'id': 'previous-agent',
          'name': 'previous-session',
          'engine': 'claude',
          'terminal': {
            'runtimes': [
              {'backend': 'tmux', 'paneId': '%1'},
            ],
          },
        }),
      ];
    app.machines = [machine];
    app.machineStates[machine.machineId] = state;
    app.expandedMachines.add(machine.machineId);
    app.selectedMachineId = machine.machineId;
    await app.selectAgent(machine.machineId, 'previous-agent');

    await tester.pumpWidget(
      ProviderScope(
        overrides: [appStateProvider.overrideWithValue(app)],
        child: const DesktopApp(),
      ),
    );
    // The link screen now arrives as a popup (a post-frame callback pushes a showDialog route
    // with its own entrance transition), not a synchronous inline build — one pump() is no
    // longer enough to see it.
    await tester.pumpAndSettle();

    expect(find.text('Link this machine'), findsOneWidget);
    expect(
      find.text(
        "This computer isn't linked to remote-mac yet. Enter the remote password set "
        'on that machine to connect.',
      ),
      findsOneWidget,
    );
    expect(find.text('Harness is offline'), findsNothing);
    expect(find.text('harness start'), findsNothing);
    app.dispose();
  });

  testWidgets('clicking the link-required prompt opens the link screen', (
    tester,
  ) async {
    final app = makeNotifier(AppStatus.authenticated);
    const otherMachine = Machine(
      machineId: 'other-machine',
      apiKey: '',
      authMode: MachineAuthMode.remote,
      name: 'other-mac',
      status: 'online',
    );
    const machine = Machine(
      machineId: 'link-machine',
      apiKey: '',
      authMode: MachineAuthMode.remote,
      name: 'link-mac',
      status: 'online',
    );
    final state = MachineState(machine)
      ..nodeOnline = true
      ..needsLink = true
      ..agentLoadStatus = AgentLoadStatus.needsLink;
    final otherState = MachineState(otherMachine)
      ..nodeOnline = true
      ..agentLoadStatus = AgentLoadStatus.loaded;
    app.machines = [otherMachine, machine];
    app.machineStates[otherMachine.machineId] = otherState;
    app.machineStates[machine.machineId] = state;
    app.expandedMachines.add(otherMachine.machineId);
    app.expandedMachines.add(machine.machineId);
    app.selectedMachineId = otherMachine.machineId;

    await tester.pumpWidget(
      ProviderScope(
        overrides: [appStateProvider.overrideWithValue(app)],
        child: const DesktopApp(),
      ),
    );
    await tester.pump();
    expect(find.text('Link this machine'), findsNothing);

    await tester.tap(find.byKey(const ValueKey('link-required')));
    // Same popup-transition reasoning as above.
    await tester.pumpAndSettle();

    expect(find.text('Link this machine'), findsOneWidget);
    expect(
      find.text(
        "This computer isn't linked to link-mac yet. Enter the remote password set "
        'on that machine to connect.',
      ),
      findsOneWidget,
    );
    app.dispose();
  });

  testWidgets('clicking link-required while another terminal is focused opens '
      'the popup without opening a new pane', (tester) async {
    final app = makeNotifier(AppStatus.authenticated);
    const otherMachine = Machine(
      machineId: 'other-machine',
      apiKey: '',
      authMode: MachineAuthMode.remote,
      name: 'other-mac',
      status: 'online',
    );
    const machine = Machine(
      machineId: 'link-machine',
      apiKey: '',
      authMode: MachineAuthMode.remote,
      name: 'link-mac',
      status: 'online',
    );
    final otherState = MachineState(otherMachine)
      ..nodeOnline = true
      ..agentLoadStatus = AgentLoadStatus.loaded;
    final state = MachineState(machine)
      ..nodeOnline = true
      ..needsLink = true
      ..agentLoadStatus = AgentLoadStatus.needsLink;
    app.machines = [otherMachine, machine];
    app.machineStates[otherMachine.machineId] = otherState;
    app.machineStates[machine.machineId] = state;
    app.expandedMachines.add(otherMachine.machineId);
    app.expandedMachines.add(machine.machineId);

    // A terminal already open and FOCUSED on the other machine — this is what made
    // activeMachineState (which prefers focusedPane's session) resolve to the wrong
    // machine and made showMachinePane open a second, redundant "not linked" pane.
    final otherPane =
        TerminalPane(
            id: 1,
            machineId: otherMachine.machineId,
            agentId: 'other-agent',
          )
          ..session = TerminalSession(
            machineId: otherMachine.machineId,
            agentId: 'other-agent',
            agentName: 'other-agent',
            engineId: null,
            send: (_, _) async => true,
            sendBinary: (_) async => true,
          );
    app.panes.add(otherPane);
    app.focusedPaneId = otherPane.id;
    app.selectedMachineId = otherMachine.machineId;

    await tester.pumpWidget(
      ProviderScope(
        overrides: [appStateProvider.overrideWithValue(app)],
        child: const DesktopApp(),
      ),
    );
    await tester.pump();
    expect(find.text('Link this machine'), findsNothing);

    await tester.tap(find.byKey(const ValueKey('link-required')));
    await tester.pumpAndSettle();

    expect(find.text('Link this machine'), findsOneWidget);
    // No second pane was opened for the popup — just the one terminal pane that was
    // already there.
    expect(app.panes, hasLength(1));
    expect(
      find.text('link-mac is not linked to this computer yet.'),
      findsNothing,
    );
    app.dispose();
  });
}
