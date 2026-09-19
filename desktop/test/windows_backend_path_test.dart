import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/bootstrap/environment_provisioner.dart';
import 'package:harness/core/backend_path.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/app_shell.dart';
import 'package:harness/state/app_state.dart';

/// The GUI-filesystem boundary: what path the app hands its CLI, and what the
/// Recheck button actually does.
///
/// On Windows the CLI usually runs inside WSL2. The app reaches its daemon over
/// loopback, so the machine IS this computer — but its filesystem is not the
/// GUI's, and `C:\work\project` is not a Linux cwd. These tests pin the split
/// between connectivity and filesystem, the conversions that bridge it, the
/// refusal where no honest conversion exists, and that Recheck only PROBES.
void main() {
  AppNotifier appWithMachine(
    String machineId, {
    required bool local,
    bool cliInWsl = false,
    String? distro,
  }) {
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    final machine = Machine(
      machineId: machineId,
      authMode: local ? MachineAuthMode.self : MachineAuthMode.remote,
      name: 'this-pc',
    );
    app.machineStates[machineId] = MachineState(machine)..localOnly = local;
    app.debugSetLocalCliInWsl(cliInWsl);
    app.debugLocalCliWslDistro = distro;
    return app;
  }

  group('BackendPath', () {
    test(
      'a forward-slash network share is refused before POSIX conversion',
      () {
        expect(
          BackendPath.toBackend('//server/share/project', backendIsWsl: true),
          isNull,
        );
      },
    );

    test('a POSIX path is already backend-native', () {
      expect(
        BackendPath.toBackend('/home/ana/project', backendIsWsl: true),
        '/home/ana/project',
      );
      expect(
        BackendPath.toBackend('~/project', backendIsWsl: true),
        '~/project',
      );
    });

    test('a Windows drive path becomes the WSL mount', () {
      expect(
        BackendPath.toBackend(r'C:\work\project', backendIsWsl: true),
        '/mnt/c/work/project',
      );
      expect(
        BackendPath.toBackend('C:/work/My Project', backendIsWsl: true),
        '/mnt/c/work/My Project',
      );
      expect(BackendPath.toBackend(r'D:\', backendIsWsl: true), '/mnt/d');
    });

    test('a WSL UNC path maps into the distribution root', () {
      expect(
        BackendPath.toBackend(
          r'\\wsl.localhost\Ubuntu\home\ana\project',
          backendIsWsl: true,
          distro: 'Ubuntu',
        ),
        '/home/ana/project',
      );
      expect(
        BackendPath.toBackend(
          r'\\wsl$\Ubuntu\home\ana',
          backendIsWsl: true,
          distro: 'Ubuntu',
        ),
        '/home/ana',
      );
    });

    test('a UNC path for ANOTHER distribution is refused', () {
      expect(
        BackendPath.toBackend(
          r'\\wsl.localhost\Debian\home\ana',
          backendIsWsl: true,
          distro: 'Ubuntu',
        ),
        isNull,
      );
      expect(
        BackendPath.toBackend(
          r'\\wsl.localhost\Ubuntu\home\ana',
          backendIsWsl: true,
        ),
        isNull,
        reason: 'A distribution path requires an identified matching backend',
      );
    });

    test('a network share or a bare relative path is refused', () {
      expect(
        BackendPath.toBackend(
          r'\\server\share\project',
          backendIsWsl: true,
          distro: 'Ubuntu',
        ),
        isNull,
      );
      expect(
        BackendPath.toBackend('relative/folder', backendIsWsl: true),
        isNull,
      );
      expect(BackendPath.toBackend('   ', backendIsWsl: true), isNull);
    });

    test('when the backend shares the GUI filesystem nothing is rewritten', () {
      expect(
        BackendPath.toBackend(r'C:\work\project', backendIsWsl: false),
        r'C:\work\project',
      );
      expect(
        BackendPath.toBackend('/home/ana/project', backendIsWsl: false),
        '/home/ana/project',
      );
    });
  });

  group('the GUI-filesystem split', () {
    test('a Windows GUI with a WSL CLI shares no filesystem', () {
      if (!Platform.isWindows) {
        markTestSkipped(
          'Windows-only case: the split exists because the GUI runs on Windows',
        );
        return;
      }
      final app = appWithMachine(
        'm1',
        local: true,
        cliInWsl: true,
        distro: 'Ubuntu',
      );
      expect(app.machineSharesGuiFilesystem('m1'), isFalse);
    }, skip: !Platform.isWindows);

    test('a native CLI on Windows does share it', () {
      if (!Platform.isWindows) {
        markTestSkipped('Windows-only case');
        return;
      }
      final app = appWithMachine('m1', local: true);
      expect(app.machineSharesGuiFilesystem('m1'), isTrue);
    }, skip: !Platform.isWindows);

    test('a remote machine never does', () {
      final app = appWithMachine('m2', local: false);
      expect(app.machineSharesGuiFilesystem('m2'), isFalse);
    });

    test('the agent cwd is converted for a WSL-backed local machine', () {
      if (!Platform.isWindows) {
        markTestSkipped('Windows-only case');
        return;
      }
      final app = appWithMachine(
        'm1',
        local: true,
        cliInWsl: true,
        distro: 'Ubuntu',
      );
      expect(app.backendFolderFor('m1', r'C:\work\project'), (
        path: '/mnt/c/work/project',
        error: null,
      ));
      expect(app.backendFolderFor('m1', '/home/ana/project'), (
        path: '/home/ana/project',
        error: null,
      ));
    }, skip: !Platform.isWindows);

    test('an untranslatable path is REFUSED with a sentence', () {
      if (!Platform.isWindows) {
        markTestSkipped('Windows-only case');
        return;
      }
      final app = appWithMachine(
        'm1',
        local: true,
        cliInWsl: true,
        distro: 'Ubuntu',
      );
      final resolved = app.backendFolderFor('m1', r'\\server\share\project');
      expect(resolved.path, isNull);
      expect(resolved.error, contains('WSL2'));
      expect(resolved.error, contains('Ubuntu'));
    }, skip: !Platform.isWindows);

    test('a machine that shares the filesystem is untouched', () {
      final app = appWithMachine('m2', local: false);
      expect(app.backendFolderFor('m2', r'C:\work\project'), (
        path: r'C:\work\project',
        error: null,
      ));
    });
  });

  group('the Recheck button', () {
    testWidgets('tapping Recheck runs a READ-ONLY check, never an install', (
      tester,
    ) async {
      final recorder = _RecordingProvisioner(
        const EnvironmentReadiness(
          windowsHost: true,
          steps: {
            EnvironmentStep.clipboard: EnvironmentStepStatus.notApplicable,
            EnvironmentStep.harness: EnvironmentStepStatus.failed,
            EnvironmentStep.tmux: EnvironmentStepStatus.unavailable,
          },
          phase: EnvironmentSetupPhase.failed,
        ),
      );
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        environmentProvisioner: recorder,
        cliLogin: _SignedOutLogin(),
      );
      app.status = AppStatus.preparingEnvironment;
      app.currentUser = const CurrentUserProfile(
        id: 'user-1',
        name: 'Diego',
        email: 'diego@autonomous.ai',
      );
      app.environmentReadiness = const EnvironmentReadiness(
        windowsHost: true,
        steps: {
          EnvironmentStep.clipboard: EnvironmentStepStatus.notApplicable,
          EnvironmentStep.harness: EnvironmentStepStatus.failed,
          EnvironmentStep.tmux: EnvironmentStepStatus.unavailable,
        },
        phase: EnvironmentSetupPhase.failed,
        failure: EnvironmentFailure(
          title: 'WSL2 is required on Windows',
          detail: 'Install WSL2, reboot, then click Recheck.',
          command: 'wsl --install -d Ubuntu',
        ),
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [appStateProvider.overrideWithValue(app)],
          child: HarnessApp(authenticatedScreen: (_) => const SizedBox.shrink()),
        ),
      );
      await tester.pump();

      await tester.tap(find.text('Recheck'));
      await tester.pump();

      expect(
        recorder.installFlags,
        isNotEmpty,
        reason: 'the screen must actually call the provisioner',
      );
      expect(
        recorder.installFlags,
        everyElement(isFalse),
        reason: 'a button labelled Recheck must never start an installer',
      );
      expect(recorder.terminalsOpened, 0);
    });

    testWidgets('a Docker-only failure recovers on Recheck once WSL is fixed', (
      tester,
    ) async {
      // The same screen, a provisioner that now finds a ready computer: the
      // state must move to Ready without an app restart.
      final recorder = _RecordingProvisioner(
        const EnvironmentReadiness(
          windowsHost: true,
          steps: {
            EnvironmentStep.clipboard: EnvironmentStepStatus.notApplicable,
            EnvironmentStep.harness: EnvironmentStepStatus.ready,
            EnvironmentStep.tmux: EnvironmentStepStatus.ready,
          },
          phase: EnvironmentSetupPhase.ready,
          message: 'All required tools passed verification.',
        ),
      );
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        environmentProvisioner: recorder,
        cliLogin: _SignedOutLogin(),
      );
      app.status = AppStatus.preparingEnvironment;
      app.currentUser = const CurrentUserProfile(
        id: 'user-1',
        name: 'Diego',
        email: 'diego@autonomous.ai',
      );
      app.environmentReadiness = const EnvironmentReadiness(
        windowsHost: true,
        steps: {
          EnvironmentStep.harness: EnvironmentStepStatus.failed,
          EnvironmentStep.tmux: EnvironmentStepStatus.unavailable,
        },
        phase: EnvironmentSetupPhase.failed,
        failure: EnvironmentFailure(
          title: 'Only Docker’s WSL distributions are installed',
          detail: 'Install a distribution Harness may use, then click Recheck.',
          command: 'wsl --install -d Ubuntu',
        ),
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [appStateProvider.overrideWithValue(app)],
          child: HarnessApp(authenticatedScreen: (_) => const SizedBox.shrink()),
        ),
      );
      await tester.pump();

      await tester.tap(find.text('Recheck'));
      await tester.pump();
      await tester.pump();

      expect(recorder.installFlags, everyElement(isFalse));
      expect(app.environmentReadiness.isReady, isTrue);
      expect(app.status, AppStatus.unauthenticated);
    });
  });
}

/// A provisioner that records whether it was asked to INSTALL, and answers with
/// a fixed readiness. It never opens a terminal and never spawns anything.
class _RecordingProvisioner extends EnvironmentProvisioner {
  final EnvironmentReadiness result;
  final List<bool> installFlags = [];
  int terminalsOpened = 0;

  _RecordingProvisioner(this.result)
    : super(
        run: (executable, arguments, {environment}) async =>
            ProcessResult(0, 1, '', 'no process may run in this test'),
        openTerminal: (script) async {},
      );

  @override
  Future<EnvironmentReadiness> ensureReady({
    required void Function(EnvironmentReadiness value) onProgress,
    EnvironmentReadiness? resumeFrom,
    bool install = true,
    EnvironmentSetupMode? mode,
  }) async {
    installFlags.add(install);
    if (install) terminalsOpened++;
    onProgress(result);
    return result;
  }
}

class _SignedOutLogin extends CliLogin {
  @override
  Future<CliAuthStatus> checkStatus() async =>
      const CliAuthStatus(loggedIn: false);
}
