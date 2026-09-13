import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/ws/local_cli_discovery.dart';

/// A daemon that answers whatever the test says, with the supervisor's callbacks captured so the
/// test can fire "it became ready" itself.
class _ScriptedDiscovery extends LocalCliDiscovery {
  _ScriptedDiscovery(this.answers) : super(config: AppConfig.dev);

  final List<LocalCliProbe> answers;
  int ensureCalls = 0;
  int superviseCalls = 0;
  void Function(LocalCliEndpoint endpoint)? onReady;
  void Function(LocalCliEndpoint endpoint)? onSnapshot;

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
    void Function(LocalCliEndpoint endpoint)? onSnapshot,
  }) {
    superviseCalls++;
    this.onReady = onReady;
    this.onSnapshot = onSnapshot;
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
  test('local folder snapshots refresh projects without leaking to peers or changing membership', () async {
    final discovery = _ScriptedDiscovery([LocalCliProbe.ready(_endpoint)]);
    final notifier = _Notifier(discovery);
    addTearDown(notifier.dispose);
    const oldAgent = Agent(id: 'shared-id', name: 'Existing agent');
    const wireProject = AgentProject(
      name: 'Reported repository',
      cwd: '/wire',
      remote: 'host/org/repo',
    );
    final local =
        MachineState(
            const Machine(
              machineId: 'local',
              name: 'Local',
              authMode: MachineAuthMode.remote,
            ),
          )
          ..localEndpoint = _endpoint
          ..agents = [
            oldAgent,
            const Agent(id: 'native', name: 'New daemon', project: wireProject),
          ];
    final peer = MachineState(
      const Machine(
        machineId: 'peer',
        name: 'Peer',
        authMode: MachineAuthMode.remote,
      ),
    )..agents = [oldAgent];
    notifier.machineStates.addAll({'local': local, 'peer': peer});
    await notifier.ensureCliDaemonReady();
    final swarm = notifier.activeSwarm;
    var notifications = 0;
    notifier.addListener(() => notifications++);
    LocalCliEndpoint snapshot(String computerId, String folder) =>
        LocalCliEndpoint(
          computerId: computerId,
          wsUri: _endpoint.wsUri,
          protocolVersion: 1,
          terminalProtocolVersion: 3,
          agentProjects: {
            'shared-id': AgentProject(name: folder, cwd: '/work/$folder'),
            'native': const AgentProject(name: 'Fallback', cwd: '/fallback'),
          },
        );
    final current = snapshot(_endpoint.computerId, 'Current project');
    discovery.onSnapshot!(current);
    expect(local.projectOf(oldAgent)!.name, 'Current project');
    expect(peer.projectOf(oldAgent), isNull);
    expect(local.projectOf(local.agents.last), wireProject);
    expect(swarmAgents(notifier, 'Current project').map((a) => a.machineId), [
      'local',
    ]);
    expect(
      swarmProjects(notifier, const [
        SavedSwarmProject(
          machineId: 'local',
          path: '/work/Current project',
          name: 'Saved folder',
        ),
      ]),
      hasLength(2),
    );
    discovery.onSnapshot!(current);
    discovery.onSnapshot!(snapshot('another-computer', 'Wrong project'));
    expect(notifications, 1);
    discovery.onSnapshot!(snapshot(_endpoint.computerId, 'Moved project'));
    expect(local.projectOf(oldAgent)!.name, 'Moved project');
    expect(notifications, 2);
    expect(notifier.activeSwarm, same(swarm));
    expect(notifier.swarms, hasLength(1));
    expect(notifier.panes, isEmpty);
    expect(notifier.refreshes, 0);
  });

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
