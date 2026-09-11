import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_link.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/link_machine_screen.dart';

class _FakeCliLink implements CliLink {
  final Future<CliLinkConnectResult> Function(String machineId, String password)
  onConnect;
  _FakeCliLink(this.onConnect);

  @override
  Future<CliLinkConnectResult> connect(
    String machineId,
    String password, {
    void Function(String stage)? onProgress,
    String? displayName,
  }) => onConnect(machineId, password);

  @override
  Future<RemotePasswordSetResult> setRemotePassword(String password) async =>
      const RemotePasswordSetResult();

  @override
  Future<RemotePasswordStatus> remotePasswordStatus() async =>
      const RemotePasswordStatus(hasPassword: false);

  @override
  Future<String?> clearRemotePassword() async => null;

  @override
  Future<CliLinkListResult> list() async => const CliLinkListResult();

  @override
  Future<String?> unlink(String machineId) async => null;
}

void main() {
  const machine = Machine(
    machineId: 'remote-1',
    apiKey: '',
    authMode: MachineAuthMode.remote,
    name: 'remote-mac',
    status: 'online',
  );

  AppNotifier notifierFor(_FakeCliLink cliLink) {
    final notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      cliLink: cliLink,
    );
    notifier.machines = [machine];
    notifier.machineStates[machine.machineId] = MachineState(machine)
      ..needsLink = true
      ..agentLoadStatus = AgentLoadStatus.needsLink;
    return notifier;
  }

  testWidgets('shows a clear password prompt for the target machine', (
    tester,
  ) async {
    final notifier = notifierFor(
      _FakeCliLink((_, _) async => const CliLinkConnectResult()),
    );
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: LinkMachineScreen(
            notifier: notifier,
            machineState: notifier.machineStates[machine.machineId]!,
          ),
        ),
      ),
    );

    expect(find.text('Link this machine'), findsOneWidget);
    expect(
      find.text(
        "This computer isn't linked to remote-mac yet. Enter the remote password set "
        'on that machine to connect.',
      ),
      findsOneWidget,
    );
    expect(
      find.byKey(const Key('remote-password-connect-field')),
      findsOneWidget,
    );
    expect(find.text('Remote password for remote-mac'), findsOneWidget);
    expect(find.text('Link machine'), findsOneWidget);
    expect(
      find.text(
        'Your previous agent will reconnect automatically after linking.',
      ),
      findsOneWidget,
    );
    expect(find.text('Machine ID: remote-1'), findsNothing);

    await tester.tap(find.byKey(const Key('link-troubleshooting-details')));
    await tester.pump();
    expect(find.text('Machine ID: remote-1'), findsOneWidget);

    // Close sits bottom-right as a text button, matching every other dialog in the app —
    // not a floating top-right × icon.
    expect(find.text('Close'), findsOneWidget);
    notifier.dispose();
  });

  testWidgets('tapping Close dismisses the link prompt', (tester) async {
    final notifier = notifierFor(
      _FakeCliLink((_, _) async => const CliLinkConnectResult()),
    );
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: LinkMachineScreen(
            notifier: notifier,
            machineState: notifier.machineStates[machine.machineId]!,
          ),
        ),
      ),
    );

    expect(notifier.isLinkPromptDismissed(machine.machineId), isFalse);
    await tester.tap(find.text('Close'));
    await tester.pump();
    expect(notifier.isLinkPromptDismissed(machine.machineId), isTrue);
    notifier.dispose();
  });

  testWidgets(
    'submitting a password calls connectWithPassword and clears needsLink on success',
    (tester) async {
      String? connectedPassword;
      final notifier = notifierFor(
        _FakeCliLink((machineId, password) async {
          connectedPassword = password;
          return CliLinkConnectResult(linkedMachineId: machineId);
        }),
      );
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: LinkMachineScreen(
              notifier: notifier,
              machineState: notifier.machineStates[machine.machineId]!,
            ),
          ),
        ),
      );

      await tester.enterText(
        find.byKey(const Key('remote-password-connect-field')),
        'correct horse battery staple',
      );
      await tester.tap(find.byKey(const Key('remote-password-connect-button')));
      await tester.pumpAndSettle();

      expect(connectedPassword, 'correct horse battery staple');
      expect(notifier.machineStates[machine.machineId]!.needsLink, isFalse);
      notifier.dispose();
    },
  );

  testWidgets('shows the CLI error inline and keeps needsLink on failure', (
    tester,
  ) async {
    final notifier = notifierFor(
      _FakeCliLink(
        (_, _) async => const CliLinkConnectResult(error: 'Incorrect password'),
      ),
    );
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: LinkMachineScreen(
            notifier: notifier,
            machineState: notifier.machineStates[machine.machineId]!,
          ),
        ),
      ),
    );

    await tester.enterText(
      find.byKey(const Key('remote-password-connect-field')),
      'wrong-password',
    );
    await tester.tap(find.byKey(const Key('remote-password-connect-button')));
    await tester.pumpAndSettle();

    expect(find.text('Incorrect password'), findsOneWidget);
    expect(notifier.machineStates[machine.machineId]!.needsLink, isTrue);
    notifier.dispose();
  });
}
