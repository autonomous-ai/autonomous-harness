import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_link.dart';
import 'package:harness/core/config.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/link_machine_dialog.dart';

class _FakeCliLink implements CliLink {
  final RemotePasswordStatus statusResult;
  final RemotePasswordSetResult setResult;
  final String? clearError;
  _FakeCliLink({
    this.statusResult = const RemotePasswordStatus(hasPassword: false),
    this.setResult = const RemotePasswordSetResult(),
    this.clearError,
  });

  @override
  Future<RemotePasswordSetResult> setRemotePassword(String password) async =>
      setResult;

  @override
  Future<RemotePasswordStatus> remotePasswordStatus() async => statusResult;

  @override
  Future<String?> clearRemotePassword() async => clearError;

  @override
  Future<CliLinkConnectResult> connect(
    String machineId,
    String password, {
    void Function(String stage)? onProgress,
    String? displayName,
  }) async => const CliLinkConnectResult();

  @override
  Future<CliLinkListResult> list() async => const CliLinkListResult();

  @override
  Future<String?> unlink(String machineId) async => null;
}

Future<void> _pumpDialog(WidgetTester tester, AppNotifier notifier) async {
  // The password form (two fields + actions) is taller than the old single-button generate
  // flow — give the test surface enough room that every control renders on-screen and can
  // actually be hit-tested, rather than relying on scrolling it into view.
  tester.view.physicalSize = const Size(900 * 2, 1000 * 2);
  tester.view.devicePixelRatio = 2;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => ElevatedButton(
            onPressed: () => showLinkMachineDialog(context, notifier),
            child: const Text('open'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}

void main() {
  AppNotifier notifier({_FakeCliLink? cliLink}) => AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
    cliLink: cliLink ?? _FakeCliLink(),
  );

  testWidgets(
    'shows the password form when no password is set yet, pointing at the sidebar',
    (tester) async {
      final appNotifier = notifier();
      await _pumpDialog(tester, appNotifier);

      expect(find.text('Link another machine'), findsOneWidget);
      expect(find.text('Let another machine control this one'), findsOneWidget);
      expect(
        find.text('Set a remote password for this machine below.'),
        findsOneWidget,
      );
      expect(find.byKey(const Key('remote-password-field')), findsOneWidget);
      expect(
        find.byKey(const Key('remote-password-confirm-field')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('remote-password-set-button')),
        findsOneWidget,
      );

      // The paste-to-link card moved to LinkMachineScreen — it must not be duplicated here.
      expect(
        find.byKey(const Key('remote-password-connect-field')),
        findsNothing,
      );
      expect(
        find.byKey(const Key('remote-password-connect-button')),
        findsNothing,
      );
      appNotifier.dispose();
    },
  );

  testWidgets(
    'setting a password shows the fingerprint summary and Change/Clear',
    (tester) async {
      final appNotifier = notifier(
        cliLink: _FakeCliLink(
          setResult: const RemotePasswordSetResult(
            fingerprint: '1535·C035·9474·FE9D',
          ),
        ),
      );
      await _pumpDialog(tester, appNotifier);

      await tester.enterText(
        find.byKey(const Key('remote-password-field')),
        'correct horse battery staple',
      );
      await tester.enterText(
        find.byKey(const Key('remote-password-confirm-field')),
        'correct horse battery staple',
      );
      await tester.tap(find.byKey(const Key('remote-password-set-button')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('remote-password-field')), findsNothing);
      expect(find.text('Remote password is set'), findsOneWidget);
      expect(find.text('1535·C035·9474·FE9D'), findsOneWidget);
      expect(
        find.byKey(const Key('remote-password-change-button')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('remote-password-clear-button')),
        findsOneWidget,
      );
      appNotifier.dispose();
    },
  );

  testWidgets(
    'mismatched passwords show an inline error and do not call setRemotePassword',
    (tester) async {
      final appNotifier = notifier();
      await _pumpDialog(tester, appNotifier);

      await tester.enterText(
        find.byKey(const Key('remote-password-field')),
        'password-one',
      );
      await tester.enterText(
        find.byKey(const Key('remote-password-confirm-field')),
        'password-two',
      );
      await tester.tap(find.byKey(const Key('remote-password-set-button')));
      await tester.pumpAndSettle();

      expect(find.text('Passwords do not match'), findsOneWidget);
      expect(find.byKey(const Key('remote-password-field')), findsOneWidget);
      appNotifier.dispose();
    },
  );

  testWidgets('an already-set password loads straight into the summary view', (
    tester,
  ) async {
    final appNotifier = notifier(
      cliLink: _FakeCliLink(
        statusResult: const RemotePasswordStatus(
          hasPassword: true,
          fingerprint: 'AAAA·BBBB·CCCC·DDDD',
        ),
      ),
    );
    await _pumpDialog(tester, appNotifier);

    expect(find.text('Remote password is set'), findsOneWidget);
    expect(find.text('AAAA·BBBB·CCCC·DDDD'), findsOneWidget);
    expect(find.byKey(const Key('remote-password-field')), findsNothing);
    appNotifier.dispose();
  });

  testWidgets(
    'clearing asks for confirmation and shows the CLI error on failure',
    (tester) async {
      final appNotifier = notifier(
        cliLink: _FakeCliLink(
          statusResult: const RemotePasswordStatus(
            hasPassword: true,
            fingerprint: 'AAAA·BBBB·CCCC·DDDD',
          ),
          clearError: 'Could not run the Harness CLI: not found',
        ),
      );
      await _pumpDialog(tester, appNotifier);

      await tester.tap(find.byKey(const Key('remote-password-clear-button')));
      await tester.pumpAndSettle();

      // Destructive action: a confirm dialog, not an immediate clear.
      expect(find.text('Clear remote password'), findsOneWidget);
      await tester.tap(
        find.byKey(const Key('remote-password-clear-confirm-button')),
      );
      await tester.pumpAndSettle();

      expect(
        find.text('Could not run the Harness CLI: not found'),
        findsOneWidget,
      );
      // Still set — the clear failed, so the summary (not the form) should still show.
      expect(find.text('Remote password is set'), findsOneWidget);
      appNotifier.dispose();
    },
  );
}
