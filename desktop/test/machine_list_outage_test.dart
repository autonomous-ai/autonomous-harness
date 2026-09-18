// A backend outage must not take this computer's own machine down with it.
//
// The machine list is a cloud read; the local CLI endpoint is a loopback probe. They used to be awaited
// in that order, so a cloud timeout threw before the probe's answer was applied — `usesLocalTransport`
// went false and `_connectMachine` skipped the LOCAL machine, while relayed machines, which never
// consult the probe, kept streaming. "Local terminal dead, relayed terminal fine" was the symptom.
import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:harness/ws/ws_conn.dart';

const _computerId = 'aabbccddeeff0011';

class _Api extends ApiClient {
  _Api() : super(config: AppConfig.dev, session: AuthSession());
  final lists = <Completer<List<Machine>>>[];

  /// What the real client reads off the daemon's `stale` marker.
  bool nextIsStale = false;

  @override
  Future<Map<String, dynamic>?> me() async => null;

  @override
  Future<List<Machine>> machines() {
    final result = Completer<List<Machine>>();
    lists.add(result);
    return result.future.then((value) {
      lastMachinesStale = nextIsStale;
      return value;
    });
  }
}

class _Cli extends CliLogin {
  @override
  Future<CliAuthStatus> checkStatus() async =>
      const CliAuthStatus(loggedIn: true);
  @override
  Future<void> login({void Function(String url)? onAuthorizeUrl}) async {}
  @override
  Future<void> logout() async {}
}

/// A daemon that is up and answering on loopback, whatever the cloud is doing.
class _Discovery extends LocalCliDiscovery {
  _Discovery() : super(config: AppConfig.dev);

  /// What the daemon says about its own backend link. The real probe reads `/api/status.connected`.
  bool backendOnline = true;

  @override
  Future<String?> computerId() async => _computerId;
  @override
  Future<LocalCliEndpoint?> discover({String? expectedComputerId}) async =>
      LocalCliEndpoint(
        computerId: _computerId,
        wsUri: Uri.parse('ws://127.0.0.1:18473/ws'),
        protocolVersion: localWsProtocolVersion,
        terminalProtocolVersion: 1,
        machineId: 'local-machine',
        backendOnline: backendOnline,
      );
}

class _Connection extends WsConn {
  _Connection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'local-machine',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  @override
  Future<void> waitUntilReady({required Duration timeout}) async {}
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async => const {'agents': []};
}

class _App extends AppNotifier {
  _App(_Api api, _Connection connection, this.discovery)
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        cliLogin: _Cli(),
        localCliDiscovery: discovery,
        connectionForTest: (_) => connection,
      ) {
    this.api = api;
  }
  final _Discovery discovery;
  @override
  Future<void> ensureCliDaemonReady() async {}
}

const _localMachine = Machine(
  machineId: 'local-machine',
  name: 'This computer',
  computerId: _computerId,
  authMode: MachineAuthMode.remote,
  status: 'online',
);

Future<void> _tick() => Future.delayed(Duration.zero);

void main() {
  late _Api api;
  late _App app;
  // Some tests deliberately end with the recovery timer armed; the binding checks for pending timers
  // when the BODY ends, so those dispose themselves and tell tearDown not to do it twice.
  var disposedEarly = false;

  setUp(() {
    disposedEarly = false;
    api = _Api();
    app = _App(api, _Connection(), _Discovery());
    app.status = AppStatus.authenticated;
    // The state a running session is in: this computer's machine, already known to be local.
    app.machines = [_localMachine];
    app.machineStates['local-machine'] = MachineState(_localMachine)
      ..localOnly = true;
  });

  tearDown(() {
    if (!disposedEarly) app.dispose();
  });

  test('a failed machine list still applies the loopback endpoint to the local machine', () async {
    final refresh = app.refreshMachines();
    await _tick();
    api.lists.single.completeError(
      ApiException('Could not reach the Harness backend', status: 502),
    );
    await expectLater(refresh, throwsA(isA<ApiException>()));
    await _tick();

    final local = app.machineStates['local-machine']!;
    // The probe answered, so this machine can still be reached over loopback — which is exactly what
    // `_connectMachine` gates the local machine on.
    expect(local.localEndpoint, isNotNull);
    expect(local.usesLocalTransport, isTrue);
    expect(local.transportMode, isNot(MachineTransportMode.cloudE2ee));
  });

  test(
    'the daemon losing its cloud link leaves the local terminal alone',
    () async {
      // The exact report: "cloud reconnecting…" on the daemon, and the desktop's LOCAL terminal went
      // offline too. The 15s list refresh failed, and the loopback probe — which used to refuse a
      // daemon with no backend — handed back nothing, so this computer's row was marked offline.
      app.discovery.backendOnline = false;
      final local = app.machineStates['local-machine']!
        ..connectionStatus = ConnectionStatus.connected
        ..nodeOnline = true;

      final refresh = app.refreshMachines();
      await _tick();
      api.lists.single.completeError(
        ApiException('Could not reach the Harness backend', status: 502),
      );
      await expectLater(refresh, throwsA(isA<ApiException>()));
      await _tick();

      expect(app.backendOnline, isFalse);
      expect(local.localEndpoint, isNotNull);
      expect(local.transportMode, MachineTransportMode.localPlaintext);
      expect(local.nodeOnline, isTrue, reason: 'the daemon is right here');
      expect(app.machineListError, isNull);
    },
  );

  test('the machine list failure is reported on its own signal', () async {
    // Through `retryMachines`, the entry point a user or the recovery timer actually uses — that is
    // where the failure is turned into a reportable error.
    final retry = app.retryMachines();
    await _tick();
    api.lists.single.completeError(ApiException('boom', status: 502));
    await retry;

    // The pane affordance keys off this, not off the shared `lastError` slot, which agent-launch
    // failures also write and `dismissError()` clears.
    expect(app.machineListError, isNotNull);
    expect(app.lastErrorRetryable, isTrue);
  });

  test(
    'a successful list still resolves the local endpoint as before',
    () async {
      final refresh = app.refreshMachines();
      await _tick();
      api.lists.single.complete([_localMachine]);
      await refresh;
      await _tick();

      final local = app.machineStates['local-machine']!;
      expect(local.localOnly, isTrue);
      expect(local.localEndpoint, isNotNull);
      expect(app.machineListError, isNull);
    },
  );

  test(
    'a cached answer is not the end of the job: it keeps recovering',
    () async {
      // The daemon answers 200 from its own cache when the backend is unreachable. Treating that as a
      // clean success would stop the retry and leave the app on stale rows until somebody pressed reload.
      api.nextIsStale = true;
      final retry = app.retryMachines();
      await _tick();
      api.lists.single.complete([_localMachine]);
      await retry;
      await _tick();

      expect(app.machinesAreStale, isTrue);
      expect(app.machines, isNotEmpty); // usable rows, so no blocking error
      expect(app.machineListError, isNull);
      // Still trying: a timer is armed, which is what converges once the backend returns.
      expect(app.machineRecoveryPending, isTrue);

      app.dispose();
      disposedEarly = true;
    },
  );

  test('offline with nothing cached: this computer stands in from the daemon, quietly', () async {
    // The first run on a computer that cannot reach the backend — no cache for the daemon to serve,
    // so the list is a plain 502 — and the state the app knows nothing yet. The daemon knows the one
    // machine it serves; that is enough to work locally, and it is not an error to shout about.
    app.machines = [];
    app.machineStates.clear();
    app.discovery.backendOnline = false;

    final retry = app.retryMachines();
    await _tick();
    api.lists.single.completeError(
      ApiException('Could not reach the Harness backend', status: 502),
    );
    await retry;
    await _tick();

    expect(app.backendOnline, isFalse);
    final local = app.machineStates['local-machine'];
    expect(local, isNotNull, reason: 'built from /api/status.machineId');
    expect(local!.localOnly, isTrue);
    expect(local.usesLocalTransport, isTrue);
    expect(local.transportMode, isNot(MachineTransportMode.cloudE2ee));
    expect(app.machines.map((m) => m.machineId), ['local-machine']);
    expect(
      app.machinesAreStale,
      isTrue,
      reason: 'the rail says "offline copy"',
    );
    expect(app.machineListError, isNull, reason: 'offline is not an outage');
    expect(app.lastError, isNull);

    // The backend is back and lists the real row: same id, so it updates in place — one machine,
    // still local, now with the backend's name.
    app.discovery.backendOnline = true;
    final again = app.retryMachines();
    await _tick();
    api.lists.last.complete([_localMachine]);
    await again;
    await _tick();

    expect(app.machines.map((m) => m.name), ['This computer']);
    expect(app.machineStates['local-machine']!.localOnly, isTrue);
    expect(app.machinesAreStale, isFalse);

    app.dispose();
    disposedEarly = true;
  });

  test('a fresh answer ends the job', () async {
    api.nextIsStale = false;
    final retry = app.retryMachines();
    await _tick();
    api.lists.single.complete([_localMachine]);
    await retry;
    await _tick();

    expect(app.machinesAreStale, isFalse);
    expect(app.machineRecoveryPending, isFalse);
  });
}
