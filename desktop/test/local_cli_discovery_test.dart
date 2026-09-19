import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/harness_cli_runner.dart';
import 'package:harness/core/models.dart';
import 'package:harness/ws/local_cli_discovery.dart';

void main() {
  HttpServer? server;
  late Directory scratch;

  setUp(() async {
    scratch = await Directory.systemTemp.createTemp('local-cli-discovery-');
  });

  tearDown(() async {
    await server?.close(force: true);
    server = null;
    // Windows holds a deleted-but-open handle briefly after socket-backed
    // probes and timed-out connects; a first delete can lose that race.
    // Retry a few times, then leave the directory for the OS temp cleaner
    // rather than failing the test that just ran.
    for (var attempt = 0; attempt < 5; attempt++) {
      try {
        if (await scratch.exists()) await scratch.delete(recursive: true);
        return;
      } on FileSystemException {
        await Future<void>.delayed(const Duration(milliseconds: 50));
      }
    }
  });

  test('uses the stable Harness computer id path', () {
    final path = LocalMachineIdentity.defaultComputerIdPath(
      environment: {'HOME': '/Users/tester'},
    );
    expect(path, '/Users/tester/.harness/computer-id');
  }, skip: Platform.isWindows);

  test('selected WSL identity ignores a stale host identity', () async {
    final identityFile = File('${scratch.path}/computer-id');
    var reads = 0;
    final identity = LocalMachineIdentity(
      computerIdFile: identityFile,
      environment: const {},
      wslComputerId: () async {
        reads++;
        return '0123456789abcdef0123456789abcdef';
      },
    );
    final discovery = LocalCliDiscovery(
      config: AppConfig.dev,
      identity: identity,
    );
    expect(await discovery.computerId(), '0123456789abcdef0123456789abcdef');
    expect(await discovery.usesWslCli(), isTrue);
    expect(reads, 1);
    // A host-side file from an old native prototype is not the selected
    // daemon's identity and must not change its filesystem decision.
    identityFile.writeAsStringSync('fedcba9876543210fedcba9876543210');
    expect(await discovery.computerId(), '0123456789abcdef0123456789abcdef');
    expect(await discovery.usesWslCli(), isTrue);
    expect(reads, 1);
  }, skip: !Platform.isWindows);

  test('a WSL miss never adopts a stale or pinned host identity', () async {
    final staleId = 'fedcba9876543210fedcba9876543210';
    final identityFile = File('${scratch.path}/computer-id')
      ..writeAsStringSync(staleId);
    for (final environment in [
      <String, String>{},
      {'ADAPTER_COMPUTER_ID': staleId},
    ]) {
      final identity = LocalMachineIdentity(
        computerIdFile: identityFile,
        environment: environment,
        wslSelected: () async => false,
      );
      expect(await identity.computerId(), isNull);
      expect(identity.usesWsl, isFalse);
    }
  }, skip: !Platform.isWindows);

  test('a pinned id retains the selected WSL filesystem', () async {
    var idReads = 0;
    final identity = LocalMachineIdentity(
      computerIdFile: File('${scratch.path}/computer-id'),
      environment: const {
        'ADAPTER_COMPUTER_ID': '0123456789abcdef0123456789abcdef',
      },
      wslSelected: () async => true,
      wslComputerId: () async {
        idReads++;
        return 'fedcba9876543210fedcba9876543210';
      },
    );
    final discovery = LocalCliDiscovery(
      config: AppConfig.dev,
      identity: identity,
    );

    expect(await discovery.computerId(), '0123456789abcdef0123456789abcdef');
    expect(await discovery.usesWslCli(), isTrue);
    expect(idReads, 0, reason: 'the explicit id does not need a second read');
  }, skip: !Platform.isWindows);

  test('discovers only an exact-computer loopback endpoint', () async {
    const computerId = '0123456789abcdef0123456789abcdef';
    final identityFile = File('${scratch.path}/computer-id')
      ..writeAsStringSync('$computerId\n');
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server!.listen((request) async {
      request.response.headers.contentType = ContentType.json;
      request.response.write(
        jsonEncode({
          'computerId': computerId,
          'localWs': {
            'path': '/api/local-ws',
            'protocolVersion': 1,
            'terminalProtocolVersion': 3,
            'e2ee': false,
          },
        }),
      );
      await request.response.close();
    });
    final endpoint = await LocalCliDiscovery(
      config: AppConfig(
        apiBaseUrl: 'https://harness-api.autonomous.ai',
        localCliBaseUrl: 'http://127.0.0.1:${server!.port}',
      ),
      identity: LocalMachineIdentity(computerIdFile: identityFile),
    ).discover();
    expect(endpoint?.computerId, computerId);
    expect(
      endpoint?.wsUri.toString(),
      'ws://127.0.0.1:${server!.port}/api/local-ws',
    );
  });

  test(
    'waits while a new CLI is still performing initial terminal discovery',
    () async {
      const computerId = '0123456789abcdef0123456789abcdef';
      final identityFile = File('${scratch.path}/computer-id')
        ..writeAsStringSync(computerId);
      server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server!.listen((request) async {
        request.response.headers.contentType = ContentType.json;
        request.response.write(
          jsonEncode({
            'computerId': computerId,
            'discoveryReady': false,
            'localWs': {
              'path': '/api/local-ws',
              'protocolVersion': 1,
              'terminalProtocolVersion': 3,
              'e2ee': false,
            },
          }),
        );
        await request.response.close();
      });

      final endpoint = await LocalCliDiscovery(
        config: AppConfig(
          apiBaseUrl: 'https://harness-api.autonomous.ai',
          localCliBaseUrl: 'http://127.0.0.1:${server!.port}',
        ),
        identity: LocalMachineIdentity(computerIdFile: identityFile),
      ).discover();

      expect(endpoint, isNull);
    },
  );

  test('rejects non-loopback and mismatched status endpoints', () async {
    const computerId = 'abcdef0123456789abcdef0123456789';
    final identityFile = File('${scratch.path}/computer-id')
      ..writeAsStringSync(computerId);
    final nonLoopback = await LocalCliDiscovery(
      config: const AppConfig(
        apiBaseUrl: 'https://harness-api.autonomous.ai',
        localCliBaseUrl: 'http://example.com:18473',
      ),
      identity: LocalMachineIdentity(computerIdFile: identityFile),
    ).discover();
    expect(nonLoopback, isNull);

    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server!.listen((request) async {
      request.response.headers.contentType = ContentType.json;
      request.response.write(
        jsonEncode({
          'computerId': 'fedcba9876543210fedcba9876543210',
          'localWs': {
            'path': '/api/local-ws',
            'protocolVersion': 1,
            'terminalProtocolVersion': 3,
            'e2ee': false,
          },
        }),
      );
      await request.response.close();
    });
    final mismatch = await LocalCliDiscovery(
      config: AppConfig(
        apiBaseUrl: 'https://harness-api.autonomous.ai',
        localCliBaseUrl: 'http://127.0.0.1:${server!.port}',
      ),
      identity: LocalMachineIdentity(computerIdFile: identityFile),
    ).discover();
    expect(mismatch, isNull);
  });

  test('does not accept missing or malformed computer id files', () async {
    final missing = await LocalMachineIdentity(
      computerIdFile: File('${scratch.path}/missing'),
    ).computerId();
    final malformedFile = File('${scratch.path}/malformed')
      ..writeAsStringSync('not-a-computer-id');
    final malformed = await LocalMachineIdentity(computerIdFile: malformedFile)
        .computerId();
    expect(missing, isNull);
    expect(malformed, isNull);
  });

  test('honors a pinned CLI computer id before the local file', () async {
    const computerId = '0123456789abcdef0123456789abcdef';
    final identity = LocalMachineIdentity(
      computerIdFile: File('${scratch.path}/missing'),
      environment: {'ADAPTER_COMPUTER_ID': computerId},
    );
    expect(await identity.computerId(), computerId);
  });

  Map<String, dynamic> readyStatus(
    String computerId, {
    Map<String, dynamic> extra = const {},
  }) => {
    'computerId': computerId,
    'pid': 4242,
    'version': '9.9.9',
    'localWs': {
      'path': '/api/local-ws',
      'protocolVersion': 1,
      'terminalProtocolVersion': 3,
      'e2ee': false,
    },
    ...extra,
  };

  Future<HttpServer> serveStatus(
    int port,
    Map<String, dynamic> Function() body,
  ) async {
    final s = await HttpServer.bind(InternetAddress.loopbackIPv4, port);
    s.listen((request) async {
      request.response.headers.contentType = ContentType.json;
      request.response.write(jsonEncode(body()));
      await request.response.close();
    });
    return s;
  }

  /// A loopback port nothing listens on right now — but that a test can bind later.
  Future<int> freePort() async {
    final probe = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final port = probe.port;
    await probe.close(force: true);
    return port;
  }

  LocalCliDiscovery discoveryFor(
    int port,
    File identityFile, {
    Future<void> Function()? spawnCommand,
  }) => LocalCliDiscovery(
    config: AppConfig(
      apiBaseUrl: 'https://harness-api.autonomous.ai',
      localCliBaseUrl: 'http://127.0.0.1:$port',
    ),
    // Windows can take longer than the production 400ms to surface a
    // refusal on a closed loopback port — the probe then spends the whole
    // default timeout learning what macOS learns in under a millisecond,
    // and the supervisor's millisecond-scale test windows never see a
    // spawn. A loopback connect that has not answered in 40ms is DOWN for
    // the purposes of these tests; live daemons answer in single digits.
    dio: Dio(
      BaseOptions(
        connectTimeout: const Duration(milliseconds: 40),
        receiveTimeout: const Duration(milliseconds: 40),
        sendTimeout: const Duration(milliseconds: 40),
      ),
    ),
    identity: LocalMachineIdentity(computerIdFile: identityFile),
    spawnCommand: spawnCommand,
  );

  test(
    'reads real working folders from older local status snapshots',
    () async {
      const computerId = '0123456789abcdef0123456789abcdef';
      final identityFile = File('${scratch.path}/computer-id')
        ..writeAsStringSync(computerId);
      server = await serveStatus(
        await freePort(),
        () => {
          ...readyStatus(computerId),
          'sessions': [
            {'id': 'first', 'cwd': '~/work/project/'},
            {'id': 'same', 'cwd': '${scratch.path}/work/project'},
            {'id': 'missing'},
            {'id': 'relative', 'cwd': 'work/project'},
            {'id': 'other-user', 'cwd': '~other/work'},
            {'id': 'control', 'cwd': '/work/\u0000bad'},
            {'id': '', 'cwd': '/work/ignored'},
          ],
        },
      );
      final endpoint = await LocalCliDiscovery(
        config: AppConfig(
          apiBaseUrl: 'https://fixture.invalid',
          localCliBaseUrl: 'http://127.0.0.1:${server!.port}',
        ),
        identity: LocalMachineIdentity(
          computerIdFile: identityFile,
          environment: {'HOME': scratch.path},
        ),
      ).discover();
      final projects = endpoint!.agentProjects;
      expect(projects.keys, ['first', 'same']);
      expect(projects['first']!.cwd, '${scratch.path}/work/project');
      expect(projects['first']!.name, 'project');
      expect(projects['first'], projects['same']);
      expect(projects['first']!.remote, isNull);
      expect(projects['first']!.branch, isNull);
    },
    skip: Platform.isWindows,
  );

  /**
   * Review cycle-6 P2: the daemon may run inside WSL2 while the GUI runs on Windows, and its
   * session cwds are POSIX paths. The old code validated them with Platform.isWindows rules,
   * so the drive/UNC regex dropped every real WSL project folder. With the identity reporting
   * a WSL CLI, `/home/...` and `/mnt/c/...` cwds must publish as agent projects.
   */
  test(
    'keeps POSIX project folders from a WSL daemon on a Windows GUI host',
    () async {
      const computerId = '0123456789abcdef0123456789abcdef';
      final identityFile = File('${scratch.path}/computer-id')
        ..writeAsStringSync(computerId);
      server = await serveStatus(
        await freePort(),
        () => {
          ...readyStatus(computerId),
          'sessions': [
            {'id': 'agent', 'cwd': '/home/user/project'},
            {'id': 'drivemount', 'cwd': '/mnt/c/Users/user/project/'},
            {'id': 'windowsnative', 'cwd': r'C:\work\project'},
            // Dot segments resolve textually in the daemon's dialect — never through host
            // File/Uri normalization, which on Windows would mangle the POSIX text
            // (review cycle-7, P2).
            {'id': 'dotted', 'cwd': '/mnt/c/Users/user/../user/project/./src'},
          ],
        },
      );
      final endpoint = await LocalCliDiscovery(
        config: AppConfig(
          apiBaseUrl: 'https://fixture.invalid',
          localCliBaseUrl: 'http://127.0.0.1:${server!.port}',
        ),
        identity: LocalMachineIdentity(
          computerIdFile: identityFile,
          environment: const {},
          // A reader both selects WSL and answers the id, so `probe()` gets past
          // its identity gate exactly like a real WSL daemon does.
          wslComputerId: () async => computerId,
        ),
      ).discover();
      final projects = endpoint!.agentProjects;
      expect(projects.keys, ['agent', 'drivemount', 'dotted']);
      expect(projects['agent']!.cwd, '/home/user/project');
      expect(projects['agent']!.name, 'project');
      // A trailing separator in the status is trimmed, not doubled.
      expect(projects['drivemount']!.cwd, '/mnt/c/Users/user/project');
      expect(projects['drivemount']!.name, 'project');
      expect(projects['dotted']!.cwd, '/mnt/c/Users/user/project/src');
      expect(projects['dotted']!.name, 'src');
    },
    skip: !Platform.isWindows,
  );

  /**
   * Bug-hunt P2: a POSIX (WSL) daemon's `~/project` was expanded with the
   * Windows GUI's own home. `C:\Users\me` failed the POSIX absolute check and
   * silently dropped the row; an MSYS-inherited `HOME=/c/Users/me` passed it
   * and registered a cwd that names nothing inside the distro. A tilde is
   * expanded only with a genuinely POSIX home, and otherwise kept verbatim —
   * the daemon's own shell resolves it.
   */
  test(
    'a WSL daemon tilde cwd is expanded only with a POSIX home, kept verbatim otherwise',
    () async {
      const computerId = '0123456789abcdef0123456789abcdef';
      final identityFile = File('${scratch.path}/computer-id')
        ..writeAsStringSync(computerId);
      server = await serveStatus(
        await freePort(),
        () => {
          ...readyStatus(computerId),
          'sessions': [
            {'id': 'tilde', 'cwd': '~/work/project'},
          ],
        },
      );
      Future<AgentProject?> tildeProjectWith(String? home) async {
        final endpoint = await LocalCliDiscovery(
          config: AppConfig(
            apiBaseUrl: 'https://fixture.invalid',
            localCliBaseUrl: 'http://127.0.0.1:${server!.port}',
          ),
          identity: LocalMachineIdentity(
            computerIdFile: identityFile,
            environment: home == null ? const {} : {'HOME': home},
            // A reader both selects WSL and answers the id, so `probe()` gets
            // past its identity gate exactly like a real WSL daemon does.
            wslComputerId: () async => computerId,
          ),
        ).discover();
        return endpoint!.agentProjects['tilde'];
      }

      final windowsHome = await tildeProjectWith(r'C:\Users\me');
      expect(windowsHome!.cwd, '~/work/project',
          reason: 'the Windows USERPROFILE must not stand in for the distro home');
      expect(windowsHome.name, 'project');
      final msysHome = await tildeProjectWith('/c/Users/me');
      expect(msysHome!.cwd, '~/work/project',
          reason: 'an MSYS HOME must not fabricate a distro path');
      final posixHome = await tildeProjectWith('/home/me');
      expect(posixHome!.cwd, '/home/me/work/project');
      final noHome = await tildeProjectWith(null);
      expect(noHome!.cwd, '~/work/project');
    },
    skip: !Platform.isWindows,
  );

  test(
    'supervision publishes changing folders without reconnecting or spawning',
    () async {
      const computerId = '0123456789abcdef0123456789abcdef';
      final identityFile = File('${scratch.path}/computer-id')
        ..writeAsStringSync(computerId);
      var cwd = '${scratch.path}/before';
      server = await serveStatus(
        await freePort(),
        () => {
          ...readyStatus(computerId),
          'sessions': [
            {'id': 'agent', 'cwd': cwd},
          ],
        },
      );
      var readyCount = 0;
      final before = Completer<void>();
      final after = Completer<void>();
      final discovery = discoveryFor(
        server!.port,
        identityFile,
        spawnCommand: () async => fail('A ready daemon must not be restarted'),
      );
      final timer = discovery.startSupervising(
        checkInterval: const Duration(milliseconds: 20),
        onReady: (_) => readyCount++,
        onSnapshot: (endpoint) {
          final name = endpoint.agentProjects['agent']?.name;
          if (name == 'before' && !before.isCompleted) before.complete();
          if (name == 'after' && !after.isCompleted) after.complete();
        },
      );
      addTearDown(timer.cancel);
      await before.future.timeout(const Duration(seconds: 3));
      cwd = '${scratch.path}/after';
      await after.future.timeout(const Duration(seconds: 3));
      expect(readyCount, 1);
    },
  );

  group('probe', () {
    const computerId = '0123456789abcdef0123456789abcdef';
    late File identityFile;
    setUp(() {
      identityFile = File('${scratch.path}/computer-id')
        ..writeAsStringSync(computerId);
    });

    test(
      'a refused port is DOWN — the one state where spawning helps',
      () async {
        final probe = await discoveryFor(
          await freePort(),
          identityFile,
        ).probe();
        expect(probe.state, LocalCliProbeState.down);
        expect(probe.alive, isFalse);
        expect(probe.endpoint, isNull);
      },
    );

    test('an error status is NOT READY — something owns the port', () async {
      server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server!.listen((request) async {
        request.response.statusCode = HttpStatus.serviceUnavailable;
        await request.response.close();
      });
      final probe = await discoveryFor(server!.port, identityFile).probe();
      expect(probe.state, LocalCliProbeState.notReady);
      expect(probe.alive, isTrue);
      expect(probe.reason, contains('503'));
    });

    test(
      'a daemon with no backend link is READY, and says the backend is offline',
      () async {
        // Readiness is the loopback's: a daemon that cannot reach the backend still serves every
        // agent on this computer. `connected:false` used to hold the app on "Starting local
        // service…" for 45s and then an error strip, with tmux and the agents right there.
        server = await serveStatus(
          0,
          () => readyStatus(
            computerId,
            extra: {'connected': false, 'machineId': 'm' * 32},
          ),
        );
        final probe = await discoveryFor(server!.port, identityFile).probe();
        expect(probe.state, LocalCliProbeState.ready);
        expect(probe.endpoint!.backendOnline, isFalse);
        expect(probe.endpoint!.machineId, 'm' * 32);
        expect(probe.pid, 4242);
        expect(probe.version, '9.9.9');
      },
    );

    test(
      'discover() still hands back the endpoint while the backend is down',
      () async {
        // `discover()` is what the machine refresh applies to this computer's row. When it returned
        // null on `connected:false`, `_applyLocalTransport` read that as "the CLI is offline" and put
        // the LOCAL terminal into localOffline — a daemon that lost its cloud link took the terminal
        // on the same desk down with it.
        server = await serveStatus(
          0,
          () => readyStatus(computerId, extra: {'connected': false}),
        );
        final endpoint = await discoveryFor(
          server!.port,
          identityFile,
        ).discover(expectedComputerId: computerId);
        expect(endpoint, isNotNull);
        expect(endpoint!.backendOnline, isFalse);
      },
    );

    test(
      'a daemon that reports no `connected` (older CLI) counts as online',
      () async {
        server = await serveStatus(0, () => readyStatus(computerId));
        final probe = await discoveryFor(server!.port, identityFile).probe();
        expect(probe.state, LocalCliProbeState.ready);
        expect(probe.endpoint!.backendOnline, isTrue);
        expect(probe.endpoint!.machineId, isNull);
      },
    );

    test(
      'a daemon still scanning for agents is NOT READY, and says so',
      () async {
        server = await serveStatus(
          0,
          () => readyStatus(computerId, extra: {'discoveryReady': false}),
        );
        final probe = await discoveryFor(server!.port, identityFile).probe();
        expect(probe.state, LocalCliProbeState.notReady);
        expect(probe.reason, 'still scanning for agents');
        expect(probe.pid, 4242);
        expect(probe.version, '9.9.9');
        expect(probe.endpoint, isNull);
      },
    );

    test('a daemon still scanning for agents is NOT READY', () async {
      server = await serveStatus(
        0,
        () => readyStatus(computerId, extra: {'discoveryReady': false}),
      );
      final probe = await discoveryFor(server!.port, identityFile).probe();
      expect(probe.state, LocalCliProbeState.notReady);
      expect(probe.reason, 'still scanning for agents');
    });

    test('a daemon for another computer is NOT READY, not down', () async {
      server = await serveStatus(
        0,
        () => readyStatus('fedcba9876543210fedcba9876543210'),
      );
      final probe = await discoveryFor(server!.port, identityFile).probe();
      expect(probe.state, LocalCliProbeState.notReady);
      expect(probe.reason, 'a daemon for a different computer');
    });

    test('a full status is READY with the endpoint', () async {
      server = await serveStatus(0, () => readyStatus(computerId));
      final probe = await discoveryFor(server!.port, identityFile).probe();
      expect(probe.state, LocalCliProbeState.ready);
      expect(probe.endpoint?.computerId, computerId);
      expect(
        probe.endpoint?.wsUri.toString(),
        'ws://127.0.0.1:${server!.port}/api/local-ws',
      );
      expect(probe.pid, 4242);
    });
  });

  test('ensureRunning returns the endpoint immediately when the daemon is already up, '
      'never needing to spawn `harness start`', () async {
    const computerId = '0123456789abcdef0123456789abcdef';
    final identityFile = File('${scratch.path}/computer-id')
      ..writeAsStringSync(computerId);
    server = await serveStatus(0, () => readyStatus(computerId));
    var spawned = false;
    final probe = await discoveryFor(
      server!.port,
      identityFile,
      spawnCommand: () async {
        spawned = true;
      },
    ).ensureRunning();
    expect(probe.state, LocalCliProbeState.ready);
    expect(probe.endpoint?.computerId, computerId);
    expect(spawned, isFalse);
  });

  test('ensureRunning waits for a daemon that answers but is not ready, without spawning', () async {
    const computerId = '0123456789abcdef0123456789abcdef';
    final identityFile = File('${scratch.path}/computer-id')
      ..writeAsStringSync(computerId);
    var scanned = false;
    server = await serveStatus(
      0,
      () => readyStatus(computerId, extra: {'discoveryReady': scanned}),
    );
    var spawned = false;
    final discovery = discoveryFor(
      server!.port,
      identityFile,
      spawnCommand: () async {
        spawned = true;
      },
    );
    Future.delayed(const Duration(milliseconds: 700), () => scanned = true);
    final probe = await discovery.ensureRunning(
      readyTimeout: const Duration(seconds: 5),
    );
    expect(probe.state, LocalCliProbeState.ready);
    expect(spawned, isFalse, reason: 'a running daemon is never spawned over');
  });

  test('ensureRunning gives up on a daemon that never becomes ready and says which state it is in', () async {
    const computerId = '0123456789abcdef0123456789abcdef';
    final identityFile = File('${scratch.path}/computer-id')
      ..writeAsStringSync(computerId);
    server = await serveStatus(
      0,
      () => readyStatus(computerId, extra: {'discoveryReady': false}),
    );
    var spawned = false;
    final probe = await discoveryFor(
      server!.port,
      identityFile,
      spawnCommand: () async {
        spawned = true;
      },
    ).ensureRunning(readyTimeout: const Duration(milliseconds: 600));
    expect(probe.state, LocalCliProbeState.notReady);
    expect(probe.reason, 'still scanning for agents');
    expect(spawned, isFalse);
  });

  test('ensureRunning spawns once when the port is quiet and returns ready once the daemon binds', () async {
    const computerId = '0123456789abcdef0123456789abcdef';
    final identityFile = File('${scratch.path}/computer-id')
      ..writeAsStringSync(computerId);
    final port = await freePort();
    var spawnCount = 0;
    final discovery = discoveryFor(
      port,
      identityFile,
      spawnCommand: () async {
        spawnCount++;
        server = await serveStatus(
          port,
          () => readyStatus(computerId),
        ); // "harness start" binds the port
      },
    );
    final probe = await discovery.ensureRunning(
      timeout: const Duration(seconds: 3),
    );
    expect(probe.state, LocalCliProbeState.ready);
    expect(spawnCount, 1);
  });

  test('runHarnessStart treats a non-zero exit as a failed spawn', () async {
    final failing = HarnessCliRunner(
      isWindows: false,
      runProcess: (exe, args, {environment}) async =>
          ProcessResult(1, 1, '', 'daemon spawn lock is held'),
    );
    await expectLater(
      runHarnessStart(failing),
      throwsA(isA<ProcessException>()),
    );
    final fine = HarnessCliRunner(
      isWindows: false,
      runProcess: (exe, args, {environment}) async =>
          ProcessResult(1, 0, 'already running', ''),
    );
    await runHarnessStart(fine);
  });

  test('inSpawnSlot is :10–:20 of every minute, clear of the CLI update slot at :45', () {
    DateTime at(int second) => DateTime(2026, 9, 15, 10, 0, second);
    expect(inSpawnSlot(at(9)), isFalse);
    expect(inSpawnSlot(at(10)), isTrue);
    expect(inSpawnSlot(at(15)), isTrue);
    expect(inSpawnSlot(at(19)), isTrue);
    expect(inSpawnSlot(at(20)), isFalse);
    expect(inSpawnSlot(at(45)), isFalse);
    expect(inSpawnSlot(at(0), second: 5, window: 10), isTrue);
  });

  test('startSupervising holds a spawn outside the slot and takes it on the first tick inside', () async {
    const computerId = '0123456789abcdef0123456789abcdef';
    final identityFile = File('${scratch.path}/computer-id')
      ..writeAsStringSync(computerId);
    final port = await freePort();
    var spawnCount = 0;
    var slotOpen = false;
    final discovery = discoveryFor(
      port,
      identityFile,
      spawnCommand: () async {
        spawnCount++;
        server = await serveStatus(port, () => readyStatus(computerId));
      },
    );

    final timer = discovery.startSupervising(
      checkInterval: const Duration(milliseconds: 20),
      graceStep: const Duration(milliseconds: 10),
      graceWindow: const Duration(milliseconds: 100),
      initialBackoff: const Duration(milliseconds: 200),
      maxBackoff: const Duration(milliseconds: 200),
      spawnAllowedAt: (_) => slotOpen,
    );
    addTearDown(timer.cancel);

    // Down for many ticks, but the slot is shut: nothing is spawned, and nothing is backed off
    // either — the moment the slot opens the spawn is immediate.
    await Future.delayed(const Duration(milliseconds: 200));
    expect(spawnCount, 0);
    slotOpen = true;
    await Future.delayed(const Duration(milliseconds: 60));
    expect(spawnCount, 1);
    expect(server, isNotNull);
  });

  test('startSupervising spawns harness start while down, and stops once discovery succeeds', () async {
    const computerId = '0123456789abcdef0123456789abcdef';
    final identityFile = File('${scratch.path}/computer-id')
      ..writeAsStringSync(computerId);
    final port = await freePort();
    var spawnCount = 0;
    final readies = <LocalCliEndpoint>[];
    final discovery = discoveryFor(
      port,
      identityFile,
      spawnCommand: () async {
        spawnCount++;
        server = await serveStatus(
          port,
          () => readyStatus(computerId),
        ); // simulate `harness start` succeeding
      },
    );

    final timer = discovery.startSupervising(
      checkInterval: const Duration(milliseconds: 20),
      graceStep: const Duration(milliseconds: 10),
      graceWindow: const Duration(milliseconds: 100),
      initialBackoff: const Duration(milliseconds: 200),
      maxBackoff: const Duration(milliseconds: 200),
      onReady: readies.add,
    );
    addTearDown(timer.cancel);

    // Two down-probes must land before the spawn (spawnAfter: 2); on a host
    // whose closed-port connects do not refuse instantly each probe can cost
    // its whole timeout, so the window is sized for two full probes plus the
    // spawn, not for macOS-class instant refusals.
    await Future.delayed(const Duration(milliseconds: 400));
    expect(spawnCount, 1);
    expect(server, isNotNull);

    // Discovery now succeeds on every tick — no further spawn should ever happen, and the
    // transition into ready was reported exactly once.
    await Future.delayed(const Duration(milliseconds: 200));
    expect(spawnCount, 1);
    expect(readies, hasLength(1));
    expect(readies.single.computerId, computerId);
  });

  test(
    'startSupervising reports the backend link on every change, not every tick',
    () async {
      const computerId = '0123456789abcdef0123456789abcdef';
      final identityFile = File('${scratch.path}/computer-id')
        ..writeAsStringSync(computerId);
      var connected = false;
      server = await serveStatus(
        0,
        () => readyStatus(computerId, extra: {'connected': connected}),
      );
      final seen = <bool>[];
      final timer = discoveryFor(server!.port, identityFile).startSupervising(
        checkInterval: const Duration(milliseconds: 20),
        onBackendOnline: seen.add,
      );
      addTearDown(timer.cancel);

      await Future.delayed(const Duration(milliseconds: 120));
      expect(seen, [false], reason: 'offline at first sight, said once');
      connected = true;
      await Future.delayed(const Duration(milliseconds: 120));
      expect(seen, [false, true], reason: 'the reconnect, said once');
    },
  );

  test(
    'startSupervising never spawns over a daemon that answers but is not ready',
    () async {
      const computerId = '0123456789abcdef0123456789abcdef';
      final identityFile = File('${scratch.path}/computer-id')
        ..writeAsStringSync(computerId);
      // The state a daemon sits in for the length of its startup scan.
      server = await serveStatus(
        0,
        () => readyStatus(computerId, extra: {'discoveryReady': false}),
      );
      var spawnCount = 0;
      final discovery = discoveryFor(
        server!.port,
        identityFile,
        spawnCommand: () async {
          spawnCount++;
        },
      );

      final timer = discovery.startSupervising(
        checkInterval: const Duration(milliseconds: 20),
        graceStep: const Duration(milliseconds: 10),
        graceWindow: const Duration(milliseconds: 50),
        initialBackoff: const Duration(milliseconds: 20),
        maxBackoff: const Duration(milliseconds: 20),
        stillSignedIn: () async => true,
      );
      addTearDown(timer.cancel);

      await Future.delayed(const Duration(milliseconds: 400));
      expect(
        spawnCount,
        0,
        reason: 'it is running; a second one can only fail on the port',
      );
    },
  );

  test('startSupervising waits for more than one quiet tick before spawning into an update gap', () async {
    const computerId = '0123456789abcdef0123456789abcdef';
    final identityFile = File('${scratch.path}/computer-id')
      ..writeAsStringSync(computerId);
    // The port goes quiet — the old daemon closed it, the new one is about to bind — then answers
    // again. That is a handoff, not a crash, and must not cost a spawn. `spawnAfter: 3` against a
    // gap of ~1.5 ticks: however the gap lands on the tick phase, at most two ticks can see it.
    final port = await freePort();
    server = await serveStatus(port, () => readyStatus(computerId));
    var spawnCount = 0;
    final discovery = discoveryFor(
      port,
      identityFile,
      spawnCommand: () async {
        spawnCount++;
      },
    );

    final timer = discovery.startSupervising(
      checkInterval: const Duration(milliseconds: 20),
      graceStep: const Duration(milliseconds: 10),
      graceWindow: const Duration(milliseconds: 50),
      initialBackoff: const Duration(milliseconds: 20),
      maxBackoff: const Duration(milliseconds: 20),
      spawnAfter: 3,
      stillSignedIn: () async => true,
    );
    addTearDown(timer.cancel);

    await Future.delayed(const Duration(milliseconds: 60));
    await server!.close(force: true);
    server = null;
    await Future.delayed(const Duration(milliseconds: 30)); // the gap
    server = await serveStatus(port, () => readyStatus(computerId));
    await Future.delayed(const Duration(milliseconds: 150));
    expect(spawnCount, 0, reason: 'a short gap is a handoff, not a crash');

    // Quiet for good: now it is down, and the spawn is the fix.
    await server!.close(force: true);
    server = null;
    await Future.delayed(const Duration(milliseconds: 250));
    expect(spawnCount, greaterThan(0));
  });

  test('startSupervising backs off between failed spawn attempts instead of spawning every tick', () async {
    const computerId = '0123456789abcdef0123456789abcdef';
    final identityFile = File('${scratch.path}/computer-id')
      ..writeAsStringSync(computerId);
    // A port nothing listens on — every discover() fails fast (connection refused), so the daemon
    // never comes up no matter how many times spawnCommand "runs" it.
    final probe = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final closedPort = probe.port;
    await probe.close(force: true);

    var spawnCount = 0;
    final discovery = LocalCliDiscovery(
      config: AppConfig(
        apiBaseUrl: 'https://harness-api.autonomous.ai',
        localCliBaseUrl: 'http://127.0.0.1:$closedPort',
      ),
      // Same fast probe timeouts as discoveryFor: a closed loopback port
      // must read as DOWN inside these millisecond-scale test windows on
      // every host, not just the ones that refuse instantly.
      dio: Dio(
        BaseOptions(
          connectTimeout: const Duration(milliseconds: 40),
          receiveTimeout: const Duration(milliseconds: 40),
          sendTimeout: const Duration(milliseconds: 40),
        ),
      ),
      identity: LocalMachineIdentity(computerIdFile: identityFile),
      spawnCommand: () async {
        spawnCount++;
      },
    );

    final timer = discovery.startSupervising(
      checkInterval: const Duration(milliseconds: 20),
      graceStep: const Duration(milliseconds: 10),
      graceWindow: const Duration(milliseconds: 50),
      initialBackoff: const Duration(milliseconds: 150),
      maxBackoff: const Duration(milliseconds: 150),
    );
    addTearDown(timer.cancel);

    await Future.delayed(const Duration(milliseconds: 500));
    // Without backoff, ~500ms / 20ms checkInterval would spawn on nearly every tick (~25 times).
    // With backoff (each failed attempt costs ~50ms grace window + a 150ms floor before the next),
    // attempts are bounded to roughly 500 / 200 ≈ 2-3.
    expect(spawnCount, greaterThan(0));
    expect(spawnCount, lessThan(6));
  });

  // The bug this closes: a daemon that signed ITSELF out (its machine was deleted from another
  // machine) exits, and the supervisor respawned it forever — every replacement starting without a
  // session and exiting again, silently, for the app's whole lifetime.
  test(
    'startSupervising stops respawning once the CLI reports it is signed out',
    () async {
      const computerId = '0123456789abcdef0123456789abcdef';
      final identityFile = File('${scratch.path}/computer-id')
        ..writeAsStringSync(computerId);
      final probe = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final closedPort = probe.port;
      await probe.close(force: true);

      var spawnCount = 0;
      var signedOutCalls = 0;
      final discovery = LocalCliDiscovery(
        config: AppConfig(
          apiBaseUrl: 'https://harness-api.autonomous.ai',
          localCliBaseUrl: 'http://127.0.0.1:$closedPort',
        ),
        // Same fast probe timeouts as discoveryFor: a closed loopback port
        // must read as DOWN inside these millisecond-scale test windows on
        // every host, not just the ones that refuse instantly.
        dio: Dio(
          BaseOptions(
            connectTimeout: const Duration(milliseconds: 40),
            receiveTimeout: const Duration(milliseconds: 40),
            sendTimeout: const Duration(milliseconds: 40),
          ),
        ),
        identity: LocalMachineIdentity(computerIdFile: identityFile),
        spawnCommand: () async {
          spawnCount++;
        },
      );

      final timer = discovery.startSupervising(
        checkInterval: const Duration(milliseconds: 20),
        graceStep: const Duration(milliseconds: 10),
        graceWindow: const Duration(milliseconds: 50),
        initialBackoff: const Duration(milliseconds: 20),
        maxBackoff: const Duration(milliseconds: 20),
        stillSignedIn: () async => false,
        onSignedOut: () => signedOutCalls++,
      );
      addTearDown(timer.cancel);

      await Future.delayed(const Duration(milliseconds: 300));

      expect(
        spawnCount,
        0,
        reason: 'a signed-out daemon must never be respawned',
      );
      expect(signedOutCalls, 1, reason: 'the caller is told exactly once');
      expect(timer.isActive, isFalse, reason: 'supervision stops for good');
    },
  );

  test(
    'startSupervising keeps respawning while the CLI is still signed in',
    () async {
      const computerId = '0123456789abcdef0123456789abcdef';
      final identityFile = File('${scratch.path}/computer-id')
        ..writeAsStringSync(computerId);
      final probe = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final closedPort = probe.port;
      await probe.close(force: true);

      var spawnCount = 0;
      var signedOutCalls = 0;
      final discovery = LocalCliDiscovery(
        config: AppConfig(
          apiBaseUrl: 'https://harness-api.autonomous.ai',
          localCliBaseUrl: 'http://127.0.0.1:$closedPort',
        ),
        // Same fast probe timeouts as discoveryFor: a closed loopback port
        // must read as DOWN inside these millisecond-scale test windows on
        // every host, not just the ones that refuse instantly.
        dio: Dio(
          BaseOptions(
            connectTimeout: const Duration(milliseconds: 40),
            receiveTimeout: const Duration(milliseconds: 40),
            sendTimeout: const Duration(milliseconds: 40),
          ),
        ),
        identity: LocalMachineIdentity(computerIdFile: identityFile),
        spawnCommand: () async {
          spawnCount++;
        },
      );

      final timer = discovery.startSupervising(
        checkInterval: const Duration(milliseconds: 20),
        graceStep: const Duration(milliseconds: 10),
        graceWindow: const Duration(milliseconds: 50),
        initialBackoff: const Duration(milliseconds: 20),
        maxBackoff: const Duration(milliseconds: 20),
        stillSignedIn: () async => true,
        onSignedOut: () => signedOutCalls++,
      );
      addTearDown(timer.cancel);

      await Future.delayed(const Duration(milliseconds: 300));

      // A daemon that merely crashed, or was stopped by hand, must still be brought back.
      expect(spawnCount, greaterThan(0));
      expect(signedOutCalls, 0);
      expect(timer.isActive, isTrue);
    },
  );
}
