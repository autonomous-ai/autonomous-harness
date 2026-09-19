import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/bootstrap/environment_provisioner.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/app_shell.dart';
import 'package:harness/state/app_state.dart';

/// The Windows setup screen's STATES, rendered.
///
/// A process count and a renderer log say the app started; they say nothing
/// about whether the screen a user actually sees is honest. These render the
/// screen for each first-run state the Windows port can be in and assert the
/// words and the buttons — including that the failed state's button is a
/// READ-ONLY Recheck, not an installer.
///
/// The readiness objects here are built by hand rather than produced by the
/// provisioner: `windows_runtime_test.dart` covers what the provisioner
/// DECIDES, and this file covers how those decisions look.
void main() {
  AppNotifier notifierReady(EnvironmentReadiness readiness) {
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    app.status = AppStatus.preparingEnvironment;
    app.currentUser = const CurrentUserProfile(
      id: 'user-1',
      name: 'Diego',
      email: 'diego@autonomous.ai',
    );
    app.environmentReadiness = readiness;
    return app;
  }

  Future<void> pumpScreen(
    WidgetTester tester,
    EnvironmentReadiness state,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [appStateProvider.overrideWithValue(notifierReady(state))],
        child: HarnessApp(authenticatedScreen: (_) => const SizedBox.shrink()),
      ),
    );
    await tester.pump();
  }

  testWidgets('a failed Windows check offers Recheck, never Retry-install', (
    tester,
  ) async {
    await pumpScreen(
      tester,
      const EnvironmentReadiness(
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
      ),
    );

    expect(find.text('WSL2 is required on Windows'), findsOneWidget);
    expect(find.text('wsl --install -d Ubuntu'), findsOneWidget);
    // The button must NOT be the one that starts an installer.
    expect(find.text('Recheck'), findsOneWidget);
    expect(find.text('Retry'), findsNothing);
    expect(find.text('Switch to Manual'), findsOneWidget);
  });

  testWidgets('the Docker-only state says which distros are excluded', (
    tester,
  ) async {
    await pumpScreen(
      tester,
      const EnvironmentReadiness(
        windowsHost: true,
        steps: {
          EnvironmentStep.harness: EnvironmentStepStatus.failed,
          EnvironmentStep.tmux: EnvironmentStepStatus.unavailable,
        },
        phase: EnvironmentSetupPhase.failed,
        failure: EnvironmentFailure(
          title: 'Only Docker’s WSL distributions are installed',
          detail:
              'WSL2 answers, but the only distributions on this machine '
              '(docker-desktop) belong to Docker Desktop.',
          command: 'wsl --install -d Ubuntu',
        ),
      ),
    );

    expect(
      find.text('Only Docker’s WSL distributions are installed'),
      findsOneWidget,
    );
    expect(find.textContaining('docker-desktop'), findsWidgets);
    expect(find.text('Recheck'), findsOneWidget);
  });

  testWidgets('a tmux-less distro names tmux and the command that fixes it', (
    tester,
  ) async {
    await pumpScreen(
      tester,
      const EnvironmentReadiness(
        windowsHost: true,
        steps: {
          EnvironmentStep.harness: EnvironmentStepStatus.ready,
          EnvironmentStep.tmux: EnvironmentStepStatus.failed,
        },
        phase: EnvironmentSetupPhase.failed,
        failure: EnvironmentFailure(
          step: EnvironmentStep.tmux,
          title: 'tmux is missing in Ubuntu',
          detail: 'The Harness CLI is installed in Ubuntu, but tmux is not.',
          command: "wsl -d Ubuntu -- bash -lc 'sudo apt-get install -y tmux && tmux -V'",
        ),
      ),
    );

    expect(find.text('tmux is missing in Ubuntu'), findsOneWidget);
    expect(find.textContaining('sudo apt-get install -y tmux'), findsOneWidget);
    // The CLI row is Ready while the backend row is Missing: two different
    // facts, not one verdict. (`Missing` appears more than once — the host row
    // is missing here too.)
    expect(find.text('Ready'), findsOneWidget);
    expect(find.text('Missing'), findsWidgets);
  });

  testWidgets('a ready WSL computer says so and continues', (tester) async {
    await pumpScreen(
      tester,
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

    expect(find.text('This computer is ready'), findsOneWidget);
    expect(find.text('Continue to sign in'), findsOneWidget);
  });

  testWidgets('the review uses the provisioner plan for manual WSL setup', (
    tester,
  ) async {
    await pumpScreen(
      tester,
      EnvironmentReadiness(
        windowsHost: true,
        steps: {
          EnvironmentStep.harness: EnvironmentStepStatus.failed,
          EnvironmentStep.tmux: EnvironmentStepStatus.unavailable,
        },
        phase: EnvironmentSetupPhase.review,
        plan: [EnvironmentPlanItem.windowsWslPrerequisite(dockerOnly: false)],
      ),
    );

    expect(find.text('Get this computer ready'), findsOneWidget);
    expect(find.text('Install 1 tool'), findsOneWidget);
    await tester.tap(find.text('Manual setup'));
    await tester.pump();
    expect(find.text('Check again'), findsOneWidget);
    expect(find.textContaining('wsl --install -d Ubuntu'), findsWidgets);
  });
}
