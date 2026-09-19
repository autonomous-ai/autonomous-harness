import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/analytics/analytics.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/bootstrap/environment_provisioner.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:harness/ws/ws_conn.dart';

class _Api extends ApiClient {
  _Api() : super(config: AppConfig.dev, session: AuthSession());
  final profiles = <Completer<Map<String, dynamic>?>>[];
  final lists = <Completer<List<Machine>>>[];

  @override
  Future<Map<String, dynamic>?> me() {
    final result = Completer<Map<String, dynamic>?>();
    profiles.add(result);
    return result.future;
  }

  @override
  Future<List<Machine>> machines() {
    final result = Completer<List<Machine>>();
    lists.add(result);
    return result.future;
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

class _Environment extends EnvironmentProvisioner {
  @override
  Future<EnvironmentReadiness> ensureReady({
    required void Function(EnvironmentReadiness value) onProgress,
    EnvironmentReadiness? resumeFrom,
    bool install = true,
    EnvironmentSetupMode? mode,
  }) async {
    expect(install, isFalse);
    final ready = EnvironmentReadiness(
      steps: {
        for (final step in EnvironmentStep.values)
          step: EnvironmentStepStatus.ready,
      },
      phase: EnvironmentSetupPhase.ready,
    );
    onProgress(ready);
    return ready;
  }
}

class _Discovery extends LocalCliDiscovery {
  _Discovery() : super(config: AppConfig.dev);
  @override
  Future<String?> computerId() async => null;
  @override
  Future<LocalCliEndpoint?> discover({String? expectedComputerId}) async =>
      null;
}

class _Connection extends WsConn {
  _Connection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'fixture',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  Completer<Map<String, dynamic>>? agents;
  Completer<Map<String, dynamic>>? capabilities;
  final requests = <String>[];

  @override
  Future<void> waitUntilReady({required Duration timeout}) async {}

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    requests.add(type);
    return switch (type) {
      'agents_list' => await agents?.future ?? _agents,
      'terminal_capabilities' => await capabilities?.future ?? _capabilities,
      _ => throw StateError('Unexpected fixture request: $type'),
    };
  }
}

class _App extends AppNotifier {
  _App(_Api api, _Connection connection)
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        cliLogin: _Cli(),
        environmentProvisioner: _Environment(),
        localCliDiscovery: _Discovery(),
        connectionForTest: (_) => connection,
      ) {
    this.api = api;
  }
  int daemonChecks = 0;
  Completer<void>? daemon;
  @override
  Future<void> ensureCliDaemonReady() async {
    daemonChecks++;
    await daemon?.future;
  }
}

const _machine = Machine(
  machineId: 'fixture',
  name: 'Test computer',
  authMode: MachineAuthMode.remote,
  status: 'online',
);

const _agents = {
  'agents': [
    {'id': 'synthetic-agent', 'name': 'Synthetic task', 'engine': 'codex'},
  ],
};
const _capabilities = {
  'protocolVersion': 3,
  'backend': 'tmux',
  'available': true,
};

Map<String, dynamic> _profile(String id) => {
  'user': {'id': id, 'email': '$id@example.invalid'},
};

Future<void> _tick() => Future<void>.delayed(Duration.zero);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late _Api api;
  late _App app;
  late _Connection connection;
  var disposed = false;
  void disposeApp() {
    if (disposed) return;
    disposed = true;
    app.dispose();
  }

  setUp(() {
    disposed = false;
    api = _Api();
    connection = _Connection();
    app = _App(api, connection);
    analyticsAccount.clear();
  });
  tearDown(() {
    disposeApp();
    analyticsAccount.clear();
  });

  for (final signingIn in [false, true]) {
    test(
      '${signingIn ? 'sign-in' : 'launch'} loads agents while profile is pending',
      () async {
        var finished = false;
        var sawWorkspace = false;
        app.addListener(() {
          if (app.status == AppStatus.authenticated) sawWorkspace = true;
        });
        final start = (signingIn ? app.login() : app.bootstrap()).then(
          (_) => finished = true,
        );
        await Future<void>.delayed(Duration.zero);
        final startedMachinesBeforeProfile = api.lists.isNotEmpty;
        if (api.lists.isNotEmpty) api.lists.single.complete([_machine]);
        await Future<void>.delayed(Duration.zero);
        final machine = app.machineStates['fixture'];
        final agentsBeforeProfile = machine?.agents.length ?? 0;
        final capabilitiesBeforeProfile = machine?.terminalCapabilityAvailable;
        final finishedBeforeProfile = finished;
        final workspaceBeforeProfile = sawWorkspace;
        api.profiles.single.complete(null);
        await Future<void>.delayed(Duration.zero);
        for (final list in api.lists.where((c) => !c.isCompleted)) {
          list.complete([_machine]);
        }
        await start;
        await Future<void>.delayed(Duration.zero);
        expect(app.daemonChecks, 1);
        expect(startedMachinesBeforeProfile, isTrue);
        expect(agentsBeforeProfile, 1);
        expect(capabilitiesBeforeProfile, isTrue);
        expect(workspaceBeforeProfile, isTrue);
        expect(finishedBeforeProfile, isTrue);
      },
    );
  }

  test('refresh recovery does not wait for the account profile', () async {
    app.status = AppStatus.authenticated;
    var finished = false;
    final refresh = app.retryMachines().then((_) => finished = true);
    await Future<void>.delayed(Duration.zero);
    final started = api.lists.isNotEmpty;
    if (started) api.lists.single.complete([]);
    await Future<void>.delayed(Duration.zero);
    final finishedBeforeProfile = finished;
    api.profiles.single.complete(null);
    await Future<void>.delayed(Duration.zero);
    for (final list in api.lists.where((c) => !c.isCompleted)) {
      list.complete([]);
    }
    await refresh;
    expect(started, isTrue);
    expect(finishedBeforeProfile, isTrue);
    expect(app.machinesRefreshing, isFalse);
  });

  testWidgets(
    'startup recovers a backend timeout even while the daemon stays ready',
    (tester) async {
      final start = app.bootstrap();
      await tester.pump();
      api.profiles.single.complete(_profile('current'));
      api.lists.single.completeError(
        ApiException('Backend unreachable', status: 502),
      );
      await tester.pump();
      await start;
      expect(app.lastError, contains('Backend unreachable'));

      await tester.pump(const Duration(milliseconds: 1999));
      expect(api.lists, hasLength(1));
      await tester.pump(const Duration(milliseconds: 1));
      expect(api.lists, hasLength(2));
      // Manual retry joins the automatic request rather than duplicating it.
      final joined = app.retryMachines();
      await tester.pump(const Duration(seconds: 30));
      expect(api.lists, hasLength(2));
      api.lists.last.complete([_machine]);
      await tester.pump();
      await joined;
      expect(app.lastError, isNull);
      expect(app.machineStates['fixture']!.agents, hasLength(1));
      expect(app.daemonChecks, 2);
      await tester.pump(const Duration(seconds: 35));
      // Invitation discovery continues after recovery without probing the daemon again.
      // Its pending poll is coalesced across subsequent ticks.
      expect(api.lists, hasLength(3));
      api.lists.last.complete([_machine]);
      await tester.pump();
      expect(app.daemonChecks, 2);
      disposeApp();
    },
  );

  testWidgets(
    'invitation discovery recovers from network failures without losing machines',
    (tester) async {
      final start = app.bootstrap();
      await tester.pump();
      api.profiles.single.complete(_profile('current'));
      api.lists.single.complete([_machine]);
      await tester.pump();
      await start;

      await tester.pump(const Duration(seconds: 15));
      expect(api.lists, hasLength(2));
      api.lists.last.completeError(
        ApiException('Backend unreachable', status: 502),
      );
      await tester.pump();
      expect(tester.takeException(), isNull);
      expect(app.machines.map((m) => m.machineId), ['fixture']);
      expect(app.lastError, isNull);

      await tester.pump(const Duration(seconds: 2));
      expect(api.lists, hasLength(3));
      // Discovery must not duplicate a recovery request that is still pending.
      await tester.pump(const Duration(seconds: 30));
      expect(api.lists, hasLength(3));
      api.lists.last.complete([_machine]);
      await tester.pump();
      expect(app.machinesRefreshing, isFalse);
      await tester.pump(const Duration(seconds: 15));
      expect(api.lists, hasLength(4));
      api.lists.last.complete([_machine]);
      await tester.pump();
      disposeApp();
    },
  );

  testWidgets(
    'machine recovery backs off and keeps a dismissed error dismissed',
    (tester) async {
      app.status = AppStatus.authenticated;
      final first = app.retryMachines();
      await tester.pump();
      api.profiles.single.complete(_profile('current'));
      api.lists.single.completeError(
        ApiException('Backend timeout', status: 504),
      );
      await tester.pump();
      await first;
      app.dismissError();
      await tester.pump(const Duration(seconds: 2));
      expect(api.lists, hasLength(2));
      api.lists.last.completeError(
        ApiException('Still unavailable', status: 503),
      );
      await tester.pump();
      expect(app.lastError, isNull);
      await tester.pump(const Duration(seconds: 3));
      expect(api.lists, hasLength(2));
      await tester.pump(const Duration(seconds: 1));
      expect(api.lists, hasLength(3));
      api.lists.last.complete([]);
      await tester.pump();
      expect(app.lastError, isNull);
      disposeApp();
    },
  );

  testWidgets('machine recovery stops on an authentication refusal', (
    tester,
  ) async {
    app.status = AppStatus.authenticated;
    final first = app.retryMachines();
    await tester.pump();
    api.profiles.single.complete(_profile('current'));
    api.lists.single.completeError(
      ApiException('Backend unreachable', status: 502),
    );
    await tester.pump();
    await first;
    await tester.pump(const Duration(seconds: 2));
    api.lists.last.completeError(ApiException('Sign in again', status: 401));
    await tester.pump();
    expect(app.lastError, contains('Sign in again'));
    await tester.pump(const Duration(minutes: 2));
    expect(api.lists, hasLength(2));
    disposeApp();
  });

  for (final closeApp in [false, true]) {
    testWidgets(
      '${closeApp ? 'dispose' : 'sign-out'} cancels pending machine recovery',
      (tester) async {
        app.status = AppStatus.authenticated;
        final first = app.retryMachines();
        await tester.pump();
        api.profiles.single.complete(_profile('current'));
        api.lists.single.completeError(
          ApiException('Backend unreachable', status: 502),
        );
        await tester.pump();
        await first;
        if (closeApp) {
          disposeApp();
        } else {
          final logout = app.logout();
          await tester.pump();
          await logout;
        }
        await tester.pump(const Duration(minutes: 2));
        expect(api.lists, hasLength(1));
        disposeApp();
      },
    );
  }

  test('a late profile response cannot restore a signed-out account', () async {
    final start = app.login();
    await Future<void>.delayed(Duration.zero);
    await app.logout();
    api.profiles.single.complete(_profile('old-account'));
    await Future<void>.delayed(Duration.zero);
    for (final list in api.lists.where((c) => !c.isCompleted)) {
      list.complete([_machine]);
    }
    await start;
    expect(app.status, AppStatus.unauthenticated);
    expect(app.currentUser, isNull);
    expect(analyticsAccount.current.id, isNull);
    expect(app.machines, isEmpty);
    expect(connection.requests, isEmpty);
  });

  test(
    'a late profile publishes account details without reloading agents',
    () async {
      final start = app.login();
      await _tick();
      api.lists.single.complete([_machine]);
      await start;
      await _tick();
      expect(app.currentUser, isNull);
      expect(app.machineStates['fixture']!.agents, hasLength(1));
      var profileNotifications = 0;
      app.addListener(() {
        if (app.currentUser != null) profileNotifications++;
      });
      api.profiles.single.complete(_profile('current'));
      await _tick();
      expect(profileNotifications, 1);
      expect(app.currentUser!.id, 'current');
      expect(analyticsAccount.current.id, 'current');
      expect(api.lists, hasLength(1));
      expect(
        connection.requests.where((r) => r == 'agents_list'),
        hasLength(1),
      );
    },
  );

  test(
    'repeated refreshes share a pending profile and retry a failed one',
    () async {
      app.status = AppStatus.authenticated;
      for (var i = 0; i < 2; i++) {
        final refresh = app.retryMachines();
        await _tick();
        expect(api.profiles, hasLength(1));
        api.lists[i].complete([]);
        await refresh;
      }
      api.profiles.single.completeError(StateError('Profile unavailable'));
      await _tick();
      expect(app.currentUser, isNull);
      expect(app.lastError, isNull);
      final recovery = app.retryMachines();
      await _tick();
      expect(api.profiles, hasLength(2));
      api.profiles.last.complete(_profile('recovered'));
      api.lists.last.complete([]);
      await recovery;
      await _tick();
      expect(app.currentUser!.id, 'recovered');
    },
  );

  test(
    'old sign-in completion cannot replace a new account or its loading state',
    () async {
      final oldLogin = app.login();
      await _tick();
      await app.logout();
      final newLogin = app.login();
      await _tick();
      expect(api.profiles, hasLength(2));
      expect(api.lists, hasLength(2));
      api.profiles.first.complete(_profile('old'));
      api.lists.first.complete([_machine]);
      await oldLogin;
      expect(app.signingIn, isTrue);
      expect(app.machinesLoading, isTrue);
      expect(app.currentUser, isNull);
      expect(app.machines, isEmpty);
      api.profiles.last.complete(_profile('new'));
      api.lists.last.complete([]);
      await newLogin;
      await _tick();
      expect(app.currentUser!.id, 'new');
      expect(analyticsAccount.current.id, 'new');
      expect(app.signingIn, isFalse);
      expect(app.machinesLoading, isFalse);
    },
  );

  test(
    'signing out during daemon readiness prevents workspace loading',
    () async {
      app.daemon = Completer<void>();
      final start = app.login();
      await _tick();
      expect(app.daemonChecks, 1);
      await app.logout();
      app.daemon!.complete();
      await start;
      expect(app.status, AppStatus.unauthenticated);
      expect(api.profiles, isEmpty);
      expect(api.lists, isEmpty);
    },
  );

  test(
    'closing the app discards pending profile and machine responses',
    () async {
      final start = app.login();
      await _tick();
      disposeApp();
      api.profiles.single.complete(_profile('closed'));
      api.lists.single.complete([_machine]);
      await start;
      await _tick();
      expect(app.currentUser, isNull);
      expect(app.machines, isEmpty);
      expect(analyticsAccount.current.id, isNull);
      expect(connection.requests, isEmpty);
    },
  );

  test(
    'closing the app during refresh does not publish its completion',
    () async {
      app.status = AppStatus.authenticated;
      final refresh = app.retryMachines();
      await _tick();
      disposeApp();
      api.profiles.single.complete(null);
      api.lists.single.complete([_machine]);
      await refresh;
      expect(app.machines, isEmpty);
      expect(app.machinesRefreshing, isFalse);
      expect(connection.requests, isEmpty);
    },
  );

  for (final closeApp in [false, true]) {
    for (final request in ['agents_list', 'terminal_capabilities']) {
      test(
        '${closeApp ? 'close' : 'sign-out'} discards a late $request reply',
        () async {
          final pending = Completer<Map<String, dynamic>>();
          if (request == 'agents_list') {
            connection.agents = pending;
            connection.capabilities = Completer<Map<String, dynamic>>();
          } else {
            connection.capabilities = pending;
          }
          final start = app.login();
          await _tick();
          api.profiles.single.complete(null);
          api.lists.single.complete([_machine]);
          await start;
          await _tick();
          expect(connection.requests, contains(request));
          final machine = app.machineStates['fixture']!;
          final load = machine.agentsLoadInFlight!;
          if (closeApp) {
            disposeApp();
          } else {
            await app.logout();
          }
          pending.complete(request == 'agents_list' ? _agents : _capabilities);
          if (request == 'agents_list') {
            connection.capabilities!.complete(_capabilities);
          }
          await load;
          await _tick();
          expect(machine.terminalCapabilityLoaded, isFalse);
          expect(app.panes, isEmpty);
          if (request == 'agents_list') {
            expect(machine.agents, isEmpty);
            expect(connection.requests, hasLength(2));
          }
        },
      );
    }
  }
}
