import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/bootstrap/environment_provisioner.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/settings/config_store.dart';
import 'package:harness/state/app_state.dart';

class _FakeCliLogin extends CliLogin {
  @override
  Future<CliAuthStatus> checkStatus() async =>
      const CliAuthStatus(loggedIn: false);
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

class _ScriptedProvisioner extends EnvironmentProvisioner {
  final List<EnvironmentReadiness> results;
  final List<bool> installCalls = [];
  var callCount = 0;

  _ScriptedProvisioner(this.results) : super(isMacOS: true);

  @override
  Future<EnvironmentReadiness> ensureReady({
    required void Function(EnvironmentReadiness value) onProgress,
    EnvironmentReadiness? resumeFrom,
    bool install = true,
    EnvironmentSetupMode? mode,
  }) async {
    installCalls.add(install);
    final index = callCount < results.length ? callCount : results.length - 1;
    callCount++;
    onProgress(results[index]);
    return results[index];
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('automatic Terminal setup rechecks after five seconds', (
    tester,
  ) async {
    final review = EnvironmentReadiness(
      steps: {
        EnvironmentStep.clipboard: EnvironmentStepStatus.failed,
        EnvironmentStep.harness: EnvironmentStepStatus.failed,
        EnvironmentStep.tmux: EnvironmentStepStatus.failed,
      },
      phase: EnvironmentSetupPhase.review,
    );
    final waiting = review.copyWith(
      phase: EnvironmentSetupPhase.waitingForTerminal,
      mode: EnvironmentSetupMode.automatic,
      terminalResultPath: '/missing/terminal.exit',
      terminalSetup: EnvironmentTerminalSetup.linuxHost,
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
    final provisioner = _ScriptedProvisioner([review, waiting, ready]);
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: ConfigStore(storage: _FakeKeyValueStore()),
      cliLogin: _FakeCliLogin(),
      environmentProvisioner: provisioner,
    );

    await app.bootstrap();
    app.selectEnvironmentSetupMode(EnvironmentSetupMode.automatic);
    await app.startEnvironmentSetup();
    expect(app.environmentRecheckPending, isTrue);
    expect(app.status, AppStatus.preparingEnvironment);

    await tester.pump(const Duration(seconds: 5));
    await tester.pump();

    expect(provisioner.installCalls, [false, true, false]);
    expect(app.environmentReadiness.isReady, isTrue);
    expect(app.environmentRecheckPending, isFalse);
    expect(app.status, AppStatus.unauthenticated);
    app.dispose();
  });
}
