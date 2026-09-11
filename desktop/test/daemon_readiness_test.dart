import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/local_cli_discovery.dart';

/// A daemon that answers whatever the test says, with the supervisor's callbacks captured so the
/// test can fire "it became ready" itself.
class _ScriptedDiscovery extends LocalCliDiscovery {
  _ScriptedDiscovery(this.answers) : super(config: AppConfig.dev);

  final List<LocalCliProbe> answers;
  int ensureCalls = 0;
  int superviseCalls = 0;
  void Function(LocalCliEndpoint endpoint)? onReady;

  @override
  Future<LocalCliProbe> ensureRunning({
    Duration timeout = const Duration(seconds: 15),
    Duration readyTimeout = LocalCliDiscovery.defaultReadyTimeout,
  }) async {
    ensureCalls++;
    return answers.length > 1 ? answers.removeAt(0) : answers.single;
  }

  @override
  Timer startSupervising({
    Duration checkInterval = const Duration(seconds: 5),
    Duration graceStep = const Duration(milliseconds: 500),
    Duration graceWindow = const Duration(seconds: 5),
    Duration initialBackoff = const Duration(seconds: 2),
    Duration maxBackoff = const Duration(seconds: 30),
    int spawnAfter = 2,
    Future<bool> Function()? stillSignedIn,
    void Function()? onSignedOut,
    void Function(LocalCliEndpoint endpoint)? onReady,
  }) {
    superviseCalls++;
    this.onReady = onReady;
    return Timer(const Duration(days: 1), () {});
  }
}

class _SignedInCli extends CliLogin {
  @override
  Future<CliAuthStatus> checkStatus() async => CliAuthStatus(loggedIn: true);
}

/// Stops at the machine list: this test is about the daemon gate, not what comes after it.
class _Notifier extends AppNotifier {
  int refreshes = 0;
  _Notifier(LocalCliDiscovery discovery)
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        localCliDiscovery: discovery,
        cliLogin: _SignedInCli(),
      ) {
    // Already known, so the retry path does not go looking for it over the
    // network — this test is about the daemon gate, not the profile.
    currentUser = const CurrentUserProfile(
      id: 'user-1',
      name: 'Tester',
      email: 'tester@example.com',
    );
  }

  @override
  Future<void> refreshMachines() async {
    refreshes++;
  }
}

final _endpoint = LocalCliEndpoint(
  computerId: '0123456789abcdef0123456789abcdef',
  wsUri: Uri.parse('ws://127.0.0.1:18473/api/local-ws'),
  protocolVersion: 1,
  terminalProtocolVersion: 3,
);

void main() {
  test('a daemon that answers but is still connecting is reported as such, and supervised', () async {
    final discovery = _ScriptedDiscovery([
      const LocalCliProbe.notReady(
        'not connected to the backend yet',
        version: '9.9.9',
      ),
    ]);
    final notifier = _Notifier(discovery);
    addTearDown(notifier.dispose);

    await expectLater(
      notifier.ensureCliDaemonReady(),
      throwsA(
        isA<StateError>().having(
          (e) => e.message,
          'message',
          allOf(
            contains('Harness is running (v9.9.9)'),
            contains('not connected to the backend yet'),
          ),
        ),
      ),
    );
    // Not "did not start" — that sends people to run `harness start` against a daemon that is up.
    expect(
      discovery.superviseCalls,
      1,
      reason: 'the supervisor is what turns this into a recovery',
    );
  });

  test('a daemon nobody answers for is still "did not start"', () async {
    final discovery = _ScriptedDiscovery([
      const LocalCliProbe.down('connection refused'),
    ]);
    final notifier = _Notifier(discovery);
    addTearDown(notifier.dispose);

    await expectLater(
      notifier.ensureCliDaemonReady(),
      throwsA(
        isA<StateError>().having(
          (e) => e.message,
          'message',
          contains('did not start'),
        ),
      ),
    );
    expect(discovery.superviseCalls, 0);
  });

  test('the supervisor reporting ready after a not-ready boot retries the machines without a click', () async {
    final discovery = _ScriptedDiscovery([
      const LocalCliProbe.notReady('not connected to the backend yet'),
      LocalCliProbe.ready(_endpoint),
    ]);
    final notifier = _Notifier(discovery)..status = AppStatus.authenticated;
    addTearDown(notifier.dispose);

    // The boot path: the gate throws, the error strip shows, supervision is on.
    await notifier.retryMachines();
    expect(
      notifier.lastError,
      contains('has not connected to the backend yet'),
    );
    expect(notifier.lastErrorRetryable, isTrue);
    expect(notifier.refreshes, 0);
    expect(discovery.onReady, isNotNull);

    // …and the daemon finishes its handshake. The callback fires the retry
    // without awaiting it; `retryMachines` hands back that same in-flight run.
    discovery.onReady!(_endpoint);
    await notifier.retryMachines();

    expect(notifier.lastError, isNull);
    expect(notifier.refreshes, 1);
    expect(discovery.ensureCalls, 2);
    expect(
      discovery.superviseCalls,
      1,
      reason: 'one supervisor for the app, not one per attempt',
    );
  });
}
