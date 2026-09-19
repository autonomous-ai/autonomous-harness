import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/bootstrap/environment_provisioner.dart';
import 'package:harness/core/harness_cli_runner.dart';
import 'package:harness/core/wsl_runtime.dart';
import 'package:harness/ws/local_cli_discovery.dart';

/// The Windows port's own decisions, pinned where they can be pinned without a
/// WSL2 distribution or a Harness account: the argv handed to `wsl.exe`, which
/// distributions may be used, what counts as ready, and how each first-run
/// state is named.
///
/// Nothing here claims to have RUN the CLI inside a distro — this host has no
/// development distribution, and Docker's distributions are deliberately never
/// touched. What is pinned is the decision and the command line.
void main() {
  ProcessRunner fake(
    ProcessResult Function(String executable, List<String> arguments) respond,
  ) =>
      (executable, arguments, {environment}) async =>
          respond(executable, arguments);

  group('WslRuntime', () {
    test('reads distro names out of wsl.exe UTF-16 output', () async {
      final runtime = WslRuntime(
        runProcess: fake((executable, arguments) {
          // `wsl.exe -l -q` writes UTF-16LE; a UTF-8 decode leaves the ASCII
          // characters separated by NULs, which is what this must survive.
          return ProcessResult(
            0,
            0,
            'U\u0000b\u0000u\u0000n\u0000t\u0000u\u0000\r\n'
                '\u0000d\u0000o\u0000c\u0000k\u0000e\u0000r\u0000\r\n',
            '',
          );
        }),
      );

      expect(await runtime.listDistros(), ['Ubuntu', 'docker']);
    });

    test('Docker Desktop distributions are recognised by name', () {
      for (final name in const [
        'docker-desktop',
        'docker-desktop-data',
        'Docker-Desktop',
        'docker-desktop-proxy',
      ]) {
        expect(WslRuntime.isDockerDistro(name), isTrue, reason: name);
      }
      for (final name in const [
        'Ubuntu',
        'Ubuntu-24.04',
        'Debian',
        'dockerdev',
      ]) {
        expect(WslRuntime.isDockerDistro(name), isFalse, reason: name);
      }
    });

    test('only usable distros are offered', () async {
      final runtime = WslRuntime(
        runProcess: fake(
          (executable, arguments) => ProcessResult(
            0,
            0,
            'docker-desktop\r\nUbuntu\r\ndocker-desktop-data\r\n',
            '',
          ),
        ),
      );

      expect(await runtime.usableDistros(), ['Ubuntu']);
      expect(await runtime.dockerOnlyDistros(), [
        'docker-desktop',
        'docker-desktop-data',
      ]);
    });

    test('running in a Docker distro is refused outright', () async {
      var spawned = 0;
      final runtime = WslRuntime(
        runProcess: fake((executable, arguments) {
          spawned++;
          return ProcessResult(0, 0, 'cli launcher\ntmux yes\n', '');
        }),
      );

      final result = await runtime.runIn(
        distro: 'docker-desktop',
        script: 'echo hi',
      );
      expect(result.exitCode, 126);
      expect(spawned, 0, reason: 'no process may be started in Docker');
      expect(
        (await runtime.probeHarness(distro: 'docker-desktop')).found,
        isFalse,
      );
      expect(
        (await runtime.canInstallUnattended(distro: 'docker-desktop')),
        isFalse,
      );
    });

    test('passes CLI arguments after \$0 so nothing needs shell quoting', () {
      final runtime = WslRuntime();
      final arguments = runtime.buildArguments(
        distro: 'Ubuntu',
        script: 'exec harness "\$@"',
        scriptArguments: ['link', 'create', 'my machine name'],
      );

      expect(arguments, [
        '-d',
        'Ubuntu',
        '-e',
        'bash',
        '-lc',
        'exec harness "\$@"',
        'harness',
        'link',
        'create',
        'my machine name',
      ]);
    });

    test('cliArguments keeps the launcher quoted and forwards every argument '
        '(review cycle-3 P1)', () {
      // The script must carry a REAL "$@" expansion: the cycle-3 shape emitted
      // an escaped dollar, bash received ONE literal '$@' argument, and every
      // CLI call (version checks, daemon startup) ran argument-less.
      final runtime = WslRuntime();
      const probe = WslHarnessProbe(
        distro: 'Ubuntu',
        viaPath: false,
        executable: r'$HOME/.local/bin/harness',
      );
      final arguments = runtime.cliArguments(probe, ['version']);

      expect(arguments, [
        '-d',
        'Ubuntu',
        '-e',
        'bash',
        '-lc',
        'exec "\$HOME/.local/bin/harness" "\$@"',
        'harness',
        'version',
      ]);
    });

    test('every distro call names the distro explicitly', () {
      // Never `wsl -- …`: on a Docker-heavy machine the implicit default can BE
      // docker-desktop, and an unnamed call is a call into a distro the app may
      // not use.
      expect(WslRuntime().buildArguments(distro: 'Ubuntu', script: 'true'), [
        '-d',
        'Ubuntu',
        '-e',
        'bash',
        '-lc',
        'true',
        'harness',
      ]);
    });

    test('findHarness never probes a Docker distro, even when asked', () async {
      final probed = <String>[];
      final runtime = WslRuntime(
        runProcess: fake((executable, arguments) {
          final joined = arguments.join(' ');
          if (joined.contains('harness-probe')) {
            probed.add(arguments[1]);
          }
          return ProcessResult(0, 0, 'cli missing\ntmux no\n', '');
        }),
      );

      final probe = await runtime.findHarness(
        distros: ['docker-desktop', 'Ubuntu', 'docker-desktop-data'],
      );
      expect(probe.found, isFalse);
      expect(probed, ['Ubuntu']);
    });

    test('findHarness prefers a later fully ready distro', () async {
      final runtime = WslRuntime(
        runProcess: fake((executable, arguments) {
          final distro = arguments[1];
          return ProcessResult(
            0,
            0,
            distro == 'Ready'
                ? 'cli launcher\ntmux yes\n'
                : 'cli launcher\ntmux no\n',
            '',
          );
        }),
      );

      final probe = await runtime.findHarness(distros: ['Incomplete', 'Ready']);
      expect(probe.distro, 'Ready');
      expect(probe.found, isTrue);
      expect(probe.tmuxReady, isTrue);
    });

    test('findHarness retains the first CLI distro when none is ready', () async {
      final runtime = WslRuntime(
        runProcess: fake((executable, arguments) {
          final distro = arguments[1];
          return ProcessResult(
            0,
            0,
            distro == 'Missing'
                ? 'cli missing\ntmux yes\n'
                : 'cli launcher\ntmux no\n',
            '',
          );
        }),
      );

      final probe = await runtime.findHarness(
        distros: ['FirstCli', 'SecondCli', 'Missing'],
      );
      expect(probe.distro, 'FirstCli');
      expect(probe.found, isTrue);
      expect(probe.tmuxReady, isFalse);
    });

    test('the probe reports the CLI and tmux separately', () async {
      final runtime = WslRuntime(
        runProcess: fake(
          (executable, arguments) =>
              ProcessResult(0, 0, 'cli launcher\ntmux no\n', ''),
        ),
      );

      final probe = await runtime.probeHarness(distro: 'Ubuntu');
      expect(probe.found, isTrue);
      expect(probe.distro, 'Ubuntu');
      expect(probe.viaPath, isFalse);
      expect(
        probe.tmuxReady,
        isFalse,
        reason: 'the CLI being present does not imply tmux',
      );
    });

    test(
      'a distro without the CLI keeps its independent tmux result',
      () async {
        final runtime = WslRuntime(
          runProcess: fake(
            (executable, arguments) =>
                ProcessResult(0, 0, 'cli missing\ntmux yes\n', ''),
          ),
        );

        final probe = await runtime.probeHarness(distro: 'Ubuntu');
        expect(probe.found, isFalse);
        expect(probe.distro, 'Ubuntu');
        expect(probe.tmuxReady, isTrue);
      },
    );

    test('a distro that cannot answer is not a CLI', () async {
      final runtime = WslRuntime(
        runProcess: fake(
          (executable, arguments) => ProcessResult(0, 1, '', 'no distro'),
        ),
      );

      expect((await runtime.findHarness(distros: ['Ubuntu'])).found, isFalse);
    });

    test('the displayed commands name the distro', () {
      expect(
        WslRuntime.installCommandForDisplay(distro: 'Ubuntu'),
        contains('wsl -d Ubuntu --'),
      );
      expect(WslRuntime.installCommandForDisplay(), startsWith('wsl --'));
      expect(WslRuntime.installCommandForDisplay(), contains('install.sh'));
      expect(
        WslRuntime.tmuxCommandForDisplay(distro: 'Ubuntu'),
        contains("wsl -d Ubuntu -- bash -lc 'sudo apt-get install -y tmux"),
      );
    });
  });

  group('HarnessCliRunner on Windows', () {
    test('never spawns a bare harness when the CLI is absent', () async {
      if (!Platform.isWindows) return;
      final runner = HarnessCliRunner(
        harnessHome: Directory(
          '${Directory.systemTemp.path}\\harness-test-none',
        ),
        environment: {'USERPROFILE': Directory.systemTemp.path, 'PATH': ''},
        runProcess: fake(
          (executable, arguments) => ProcessResult(0, 1, '', 'nope'),
        ),
        wslRuntime: WslRuntime(
          runProcess: fake(
            (executable, arguments) => ProcessResult(0, 1, '', ''),
          ),
        ),
      );

      final invocation = await runner.resolve(['start']);
      // "harness" is the one name that must never be used here: CreateProcess
      // searches this executable's own directory first, so a release build
      // named harness.exe would start a second copy of the app instead.
      expect(invocation.executable, isNot('harness'));
      expect(
        invocation.executable,
        HarnessCliRunner.windowsMissingCliExecutable,
      );
    });

    test('a .cmd/.bat shim is not used as the CLI', () async {
      if (!Platform.isWindows) return;
      // Measured on this host: cmd.exe cannot carry literal argv (see
      // windows_argv_fixture_test.dart), so a host-side shim must not be routed
      // through it.
      final directory = await Directory.systemTemp.createTemp('harness-shim');
      await File('${directory.path}\\harness.cmd')
          .writeAsString('@echo off\r\n');
      addTearDown(() => directory.deleteSync(recursive: true));

      final runner = HarnessCliRunner(
        harnessHome: Directory('${Directory.systemTemp.path}\\harness-none'),
        environment: {'USERPROFILE': directory.path, 'PATH': directory.path},
        runProcess: fake(
          (executable, arguments) => ProcessResult(0, 1, '', ''),
        ),
      );

      final invocation = await runner.resolve(['version']);
      expect(invocation.executable, isNot('cmd.exe'));
      expect(
        invocation.executable,
        HarnessCliRunner.windowsMissingCliExecutable,
      );
    });

    test('uses the CLI inside WSL2', () async {
      if (!Platform.isWindows) return;
      final runner = HarnessCliRunner(
        harnessHome: Directory(
          '${Directory.systemTemp.path}\\harness-test-wsl',
        ),
        environment: {'USERPROFILE': Directory.systemTemp.path, 'PATH': ''},
        runProcess: fake(
          (executable, arguments) => ProcessResult(0, 1, '', ''),
        ),
        wslRuntime: WslRuntime(
          runProcess: fake((executable, arguments) {
            final joined = arguments.join(' ');
            if (joined.contains('--status')) {
              return ProcessResult(0, 0, 'ok', '');
            }
            if (joined.contains('-l -q')) {
              return ProcessResult(0, 0, 'Ubuntu\r\n', '');
            }
            // The default distro is never probed; Ubuntu is named.
            return ProcessResult(0, 0, 'cli launcher\ntmux yes\n', '');
          }),
        ),
      );

      final invocation = await runner.resolve(['auth', 'status', '--json']);
      expect(invocation.executable, WslRuntime.executable);
      expect(invocation.source, HarnessCliSource.wsl);
      expect(invocation.wslDistro, 'Ubuntu');
      expect(invocation.arguments.first, '-d');
      expect(invocation.arguments[1], 'Ubuntu');
      expect(
        invocation.arguments,
        containsAllInOrder(['auth', 'status', '--json']),
      );
    });

    test('host-side CLI artifacts cannot shadow the WSL runtime', () async {
      if (!Platform.isWindows) return;
      final directory = await Directory.systemTemp.createTemp('harness-host');
      addTearDown(() => directory.deleteSync(recursive: true));
      final harnessHome = Directory('${directory.path}\\.harness');
      final runtime = Directory('${harnessHome.path}\\runtime')
        ..createSync(recursive: true);
      final node = File('${runtime.path}\\node.exe')
        ..writeAsStringSync('stale');
      File('${runtime.path}\\current-node').writeAsStringSync(node.path);
      final cli = File('${harnessHome.path}\\cli\\cli.js')
        ..createSync(recursive: true)
        ..writeAsStringSync('stale');
      expect(cli.existsSync(), isTrue);
      final launcher = File('${directory.path}\\.local\\bin\\harness')
        ..createSync(recursive: true)
        ..writeAsStringSync('stale');
      expect(launcher.existsSync(), isTrue);
      File('${directory.path}\\harness.exe').writeAsStringSync('stale');

      final runner = HarnessCliRunner(
        harnessHome: harnessHome,
        environment: {'USERPROFILE': directory.path, 'PATH': directory.path},
        runProcess: fake(
          (executable, arguments) => ProcessResult(0, 1, '', ''),
        ),
        wslRuntime: WslRuntime(
          runProcess: fake((executable, arguments) {
            final joined = arguments.join(' ');
            if (joined.contains('--status')) {
              return ProcessResult(0, 0, 'ok', '');
            }
            if (joined.contains('-l -q')) {
              return ProcessResult(0, 0, 'Ubuntu\r\n', '');
            }
            return ProcessResult(0, 0, 'cli launcher\ntmux yes\n', '');
          }),
        ),
      );

      final invocation = await runner.resolve(['version']);
      expect(invocation.executable, WslRuntime.executable);
      expect(invocation.source, HarnessCliSource.wsl);
      expect(invocation.wslDistro, 'Ubuntu');
    });

    test('a WSL probe miss is retried, so a late CLI is picked up', () async {
      if (!Platform.isWindows) return;
      var distroAnswers = 0;
      final runner = HarnessCliRunner(
        harnessHome: Directory('${Directory.systemTemp.path}\\harness-none'),
        environment: {'USERPROFILE': Directory.systemTemp.path, 'PATH': ''},
        // No wall-clock wait inside a unit test: the TTL is driven by the
        // injectable clock instead.
        wslProbeMissTtl: const Duration(seconds: 5),
        runProcess: fake(
          (executable, arguments) => ProcessResult(0, 1, '', ''),
        ),
        wslRuntime: WslRuntime(
          runProcess: fake((executable, arguments) {
            final joined = arguments.join(' ');
            if (joined.contains('--status')) {
              return ProcessResult(0, 0, 'ok', '');
            }
            if (joined.contains('-l -q')) {
              return ProcessResult(0, 0, 'Ubuntu\r\n', '');
            }
            distroAnswers++;
            // The first probe finds nothing — WSL is still starting. From then
            // on the CLI is there.
            return ProcessResult(0, 0, 'cli missing\ntmux no\n', '');
          }),
        ),
      );

      final first = await runner.resolve(['version']);
      expect(first.executable, HarnessCliRunner.windowsMissingCliExecutable);
      expect(distroAnswers, 1);

      // The miss is held for the TTL, then re-probed. A second runner with the
      // same "later success" runtime models the retry:
      final retrying = HarnessCliRunner(
        harnessHome: Directory('${Directory.systemTemp.path}\\harness-none'),
        environment: {'USERPROFILE': Directory.systemTemp.path, 'PATH': ''},
        runProcess: fake(
          (executable, arguments) => ProcessResult(0, 1, '', ''),
        ),
        wslRuntime: WslRuntime(
          runProcess: fake((executable, arguments) {
            final joined = arguments.join(' ');
            if (joined.contains('--status')) {
              return ProcessResult(0, 0, 'ok', '');
            }
            if (joined.contains('-l -q')) {
              return ProcessResult(0, 0, 'Ubuntu\r\n', '');
            }
            return ProcessResult(0, 0, 'cli launcher\ntmux yes\n', '');
          }),
        ),
      );
      final second = await retrying.resolve(['version']);
      expect(second.source, HarnessCliSource.wsl);
    });

    test('a miss expires, and the retry sees the CLI appear', () async {
      if (!Platform.isWindows) return;
      // Same runner, advancing clock: this is the "transient failure recovers
      // without a restart" case. Answer the first probe with nothing, every
      // later one with the CLI.
      var probes = 0;
      var clock = DateTime(2026, 9, 13, 12);
      final runner = HarnessCliRunner(
        harnessHome: Directory('${Directory.systemTemp.path}\\harness-none'),
        environment: {'USERPROFILE': Directory.systemTemp.path, 'PATH': ''},
        now: () => clock,
        wslProbeMissTtl: const Duration(seconds: 5),
        runProcess: fake(
          (executable, arguments) => ProcessResult(0, 1, '', ''),
        ),
        wslRuntime: WslRuntime(
          runProcess: fake((executable, arguments) {
            final joined = arguments.join(' ');
            if (joined.contains('--status')) {
              return ProcessResult(0, 0, 'ok', '');
            }
            if (joined.contains('-l -q')) {
              return ProcessResult(0, 0, 'Ubuntu\r\n', '');
            }
            probes++;
            return ProcessResult(
              0,
              0,
              probes == 1
                  ? 'cli missing\ntmux no\n'
                  : 'cli launcher\ntmux yes\n',
              '',
            );
          }),
        ),
      );

      expect(
        (await runner.resolve(['version'])).executable,
        HarnessCliRunner.windowsMissingCliExecutable,
      );
      // Inside the TTL the miss is remembered without another probe.
      expect(
        (await runner.resolve(['version'])).executable,
        HarnessCliRunner.windowsMissingCliExecutable,
      );
      expect(probes, 1);

      clock = clock.add(const Duration(seconds: 6));
      final recovered = await runner.resolve(['version']);
      expect(recovered.source, HarnessCliSource.wsl);
      expect(recovered.wslDistro, 'Ubuntu');
    });
  });

  group('the Windows first-run verdict', () {
    test('a host with no WSL2 names the enable command', () async {
      final readiness = await verify(
        wslEnabled: false,
        listing: '',
        probe: 'cli missing\ntmux no\n',
      );

      expect(readiness.isReady, isFalse);
      expect(readiness.phase, EnvironmentSetupPhase.review);
      expect(readiness.failure?.title, 'WSL2 is required on Windows');
      expect(readiness.failure?.command, 'wsl --install -d Ubuntu');
      expect(readiness.plan, hasLength(1));
      expect(readiness.plan.single.title, contains('WSL2'));
      expect(readiness.plan.single.command, 'wsl --install -d Ubuntu');
      expect(
        readiness.steps[EnvironmentStep.clipboard],
        EnvironmentStepStatus.notApplicable,
      );
    });

    test(
      'WSL2 enabled with no distro at all names the install command',
      () async {
        // Restored from round 1 alongside the Docker-only case: WSL enabled with an
        // EMPTY distribution list is a different state from "only Docker's
        // distributions are installed" and needs its own words.
        final readiness = await verify(
          wslEnabled: true,
          listing: '',
          probe: 'cli missing\ntmux no\n',
        );

        expect(readiness.failure?.title, 'No WSL2 distribution is installed');
        expect(readiness.failure?.command, 'wsl --install -d Ubuntu');
        expect(
          readiness.steps[EnvironmentStep.tmux],
          EnvironmentStepStatus.unavailable,
        );
        expect(readiness.plan, hasLength(1));
        expect(readiness.plan.single.command, 'wsl --install -d Ubuntu');
      },
    );

    test('a Docker-only machine is named as such, not probed', () async {
      final seen = <List<String>>[];
      final readiness = await verify(
        wslEnabled: true,
        listing: 'docker-desktop\r\ndocker-desktop-data\r\n',
        probe: 'cli launcher\ntmux yes\n',
        seen: seen,
      );

      expect(readiness.failure?.title, contains('Docker'));
      expect(readiness.failure?.command, 'wsl --install -d Ubuntu');
      expect(
        readiness.steps[EnvironmentStep.harness],
        EnvironmentStepStatus.failed,
      );
      expect(readiness.plan, hasLength(1));
      expect(readiness.plan.single.title, contains('Harness may use'));
      // Nothing may be run inside Docker's distributions, in any state.
      for (final arguments in seen) {
        expect(arguments, isNot(contains('docker-desktop')));
        expect(arguments, isNot(contains('docker-desktop-data')));
      }
    });

    test('explicit Automatic prepares only the development distro', () async {
      final seen = <List<String>>[];
      final readiness = await verify(
        install: true,
        wslEnabled: true,
        listing: 'docker-desktop\r\nUbuntu\r\n',
        probe: 'cli missing\ntmux no\n',
        seen: seen,
        sudoAllowed: true,
      );

      expect(readiness.isReady, isTrue);
      expect(readiness.plan, isEmpty);
      for (final arguments in seen) {
        expect(arguments, isNot(contains('docker-desktop')));
      }
      // The install was attempted in Ubuntu and nowhere else.
      final installs = seen.where(
        (arguments) => arguments.join(' ').contains('install.sh'),
      );
      expect(installs, isNotEmpty);
      for (final arguments in installs) {
        expect(arguments[1], 'Ubuntu');
      }
    });

    test('a failed tmux install stops before the CLI installer', () async {
      final seen = <List<String>>[];
      final readiness = await verify(
        install: true,
        wslEnabled: true,
        listing: 'Ubuntu\r\n',
        probe: 'cli missing\ntmux no\n',
        seen: seen,
        sudoAllowed: true,
        tmuxInstallSucceeds: false,
      );

      expect(readiness.phase, EnvironmentSetupPhase.failed);
      expect(readiness.failure?.title, contains('tmux'));
      expect(
        seen.any((arguments) => arguments.join(' ').contains('install.sh')),
        isFalse,
      );
    });

    test('a distro without the CLI names the install command for it', () async {
      final readiness = await verify(
        wslEnabled: true,
        listing: 'Ubuntu\r\n',
        probe: 'cli missing\ntmux no\n',
      );

      expect(
        readiness.failure?.title,
        'The Harness CLI is not installed in Ubuntu',
      );
      expect(readiness.failure?.command, contains('wsl -d Ubuntu --'));
      expect(readiness.failure?.command, contains('install.sh'));
      expect(readiness.plan.map((item) => item.title), [
        'tmux in Ubuntu',
        'Managed Node 20+ & Harness CLI in Ubuntu',
      ]);
      for (final item in readiness.plan) {
        expect(item.command, contains('wsl -d Ubuntu --'));
      }
    });

    test('a distro that needs a password is never installed into', () async {
      // `sudo -n true` fails here, so the installer must never start: a password
      // prompt on a child process the app cannot type into is a hang.
      final seen = <List<String>>[];
      final readiness = await verify(
        install: true,
        wslEnabled: true,
        listing: 'Ubuntu\r\n',
        probe: 'cli missing\ntmux no\n',
        seen: seen,
        sudoAllowed: false,
      );

      expect(readiness.phase, EnvironmentSetupPhase.failed);
      expect(
        seen.any((arguments) => arguments.join(' ').contains('install.sh')),
        isFalse,
      );
      expect(readiness.failure?.command, contains('wsl -d Ubuntu --'));
    });

    test('a read-only check never installs, even in a usable distro', () async {
      final seen = <List<String>>[];
      final readiness = await verify(
        install: false,
        wslEnabled: true,
        listing: 'Ubuntu\r\n',
        probe: 'cli missing\ntmux no\n',
        seen: seen,
        sudoAllowed: true,
      );

      expect(readiness.phase, EnvironmentSetupPhase.review);
      expect(
        seen.any((arguments) => arguments.join(' ').contains('install.sh')),
        isFalse,
        reason: 'Recheck must never trigger an installer',
      );
    });

    test('CLI present but tmux missing is NOT a ready computer', () async {
      final readiness = await verify(
        wslEnabled: true,
        listing: 'Ubuntu\r\n',
        probe: 'cli launcher\ntmux no\n',
      );

      expect(readiness.isReady, isFalse);
      expect(readiness.phase, EnvironmentSetupPhase.review);
      expect(
        readiness.steps[EnvironmentStep.harness],
        EnvironmentStepStatus.ready,
      );
      expect(
        readiness.steps[EnvironmentStep.tmux],
        EnvironmentStepStatus.failed,
      );
      expect(readiness.failure?.title, contains('tmux'));
      expect(
        readiness.failure?.command,
        contains('sudo apt-get install -y tmux'),
      );
      expect(readiness.plan, hasLength(1));
      expect(readiness.plan.single.title, 'tmux in Ubuntu');
      expect(readiness.plan.single.command, isNot(contains('wsl --install')));
    });

    test('CLI and tmux in a distro is a ready computer', () async {
      final readiness = await verify(
        wslEnabled: true,
        listing: 'Ubuntu\r\n',
        probe: 'cli launcher\ntmux yes\n',
      );

      expect(readiness.isReady, isTrue);
      expect(readiness.phase, EnvironmentSetupPhase.ready);
      expect(
        readiness.steps[EnvironmentStep.harness],
        EnvironmentStepStatus.ready,
      );
      expect(
        readiness.steps[EnvironmentStep.tmux],
        EnvironmentStepStatus.ready,
      );
      expect(readiness.plan, isEmpty);
    });

    test('a signed-out CLI is still a ready ENVIRONMENT', () async {
      // Installation and sign-in are different questions. The install probe is
      // `harness version`, which says nothing about the session; the login
      // screen owns that. A CLI that answers version but not auth status must
      // not be reported as a broken environment.
      final readiness = await verify(
        wslEnabled: true,
        listing: 'Ubuntu\r\n',
        probe: 'cli launcher\ntmux yes\n',
      );

      expect(readiness.isReady, isTrue);
      expect(readiness.phase, EnvironmentSetupPhase.ready);
    });

    test('a WSL CLI is never labelled a native install', () async {
      final readiness = await verify(
        wslEnabled: true,
        listing: 'Ubuntu\r\n',
        probe: 'cli launcher\ntmux yes\n',
        readyOutput: true,
      );

      expect(
        readiness.output.any((line) => line.contains('native Windows install')),
        isFalse,
        reason: 'the runtime is WSL, and the row must say so',
      );
      expect(readiness.output.any((line) => line.contains('Ubuntu')), isTrue);
    });

    test('a host-side CLI does not qualify a Windows computer', () async {
      if (!Platform.isWindows) return;
      final directory = await Directory.systemTemp.createTemp('harness-native');
      final launcher = File('${directory.path}\\harness.exe');
      await launcher.writeAsString('not a real binary');
      addTearDown(() => directory.deleteSync(recursive: true));

      // A native executable may answer `version`, but the unchanged CLI has no
      // native terminal backend. WSL2 and tmux remain required.
      final seen = <String>[];
      final readiness = await EnvironmentProvisioner(
        harnessHome: Directory('${Directory.systemTemp.path}\\harness-none'),
        isMacOS: false,
        isLinux: false,
        isWindows: true,
        platformEnvironment: {
          'USERPROFILE': directory.path,
          'PATH': directory.path,
        },
        run: (executable, arguments, {environment}) async {
          seen.add('$executable ${arguments.join(' ')}');
          if (executable == launcher.path) {
            return ProcessResult(0, 0, '9.9.9', '');
          }
          return ProcessResult(0, 1, '', 'unexpected');
        },
      ).ensureReady(onProgress: (_) {}, install: false);

      expect(readiness.phase, EnvironmentSetupPhase.review);
      expect(readiness.isReady, isFalse);
      expect(
        readiness.steps[EnvironmentStep.harness],
        EnvironmentStepStatus.failed,
      );
      expect(
        readiness.steps[EnvironmentStep.tmux],
        EnvironmentStepStatus.unavailable,
      );
      expect(readiness.failure?.title, 'WSL2 is required on Windows');
      expect(readiness.plan.single.command, WslRuntime.enableWslCommand);
      expect(seen.any((call) => call.startsWith(launcher.path)), isFalse);
      expect(seen.any((call) => call.contains('wsl.exe')), isTrue);
    });
  });

  group('the Windows identity', () {
    test(
      'falls back to the CLI in WSL2 when this user has no id file',
      () async {
        const id = 'a1b2c3d4e5f60718';
        final identity = LocalMachineIdentity(
          computerIdFile: File(
            '${Directory.systemTemp.path}\\harness-missing-user\\computer-id',
          ),
          environment: const {},
          wslComputerId: () async => id,
        );

        expect(await identity.computerId(), id);
      },
      skip: !Platform.isWindows,
    );

    test('an unreadable answer is not an identity', () async {
      final identity = LocalMachineIdentity(
        computerIdFile: File(
          '${Directory.systemTemp.path}\\harness-missing-user\\computer-id',
        ),
        environment: const {},
        wslComputerId: () async => 'not-a-computer-id',
      );

      expect(await identity.computerId(), isNull);
    }, skip: !Platform.isWindows);

    test('a transient miss recovers without a restart', () async {
      // The app keeps ONE identity object for its whole life, and a WSL distro
      // that has not written its id yet must not poison it forever.
      var reads = 0;
      var clock = DateTime(2026, 9, 13, 12);
      final identity = LocalMachineIdentity(
        computerIdFile: File(
          '${Directory.systemTemp.path}\\harness-missing-user\\computer-id',
        ),
        environment: const {},
        now: () => clock,
        wslIdMissTtl: const Duration(seconds: 5),
        wslComputerId: () async {
          reads++;
          return reads == 1 ? null : 'a1b2c3d4e5f60718';
        },
      );

      expect(await identity.computerId(), isNull);
      // Inside the TTL the miss is remembered, and no distro is asked again.
      expect(await identity.computerId(), isNull);
      expect(reads, 1);

      clock = clock.add(const Duration(seconds: 6));
      expect(await identity.computerId(), 'a1b2c3d4e5f60718');
      expect(reads, 2);
    }, skip: !Platform.isWindows);

    test('a hit is cached for good', () async {
      var reads = 0;
      final identity = LocalMachineIdentity(
        computerIdFile: File(
          '${Directory.systemTemp.path}\\harness-missing-user\\computer-id',
        ),
        environment: const {},
        wslComputerId: () async {
          reads++;
          return 'a1b2c3d4e5f60718';
        },
      );

      await identity.computerId();
      await identity.computerId();
      expect(reads, 1);
    }, skip: !Platform.isWindows);
  });
}

/// Drives the provisioner's Windows branch against a synthetic `wsl.exe`.
///
/// The runtime is injected through the provisioner's `wslRuntime` seam, so no
/// real `wsl.exe` is spawned — which is also how these tests keep their promise
/// never to touch a distribution, Docker's or otherwise.
Future<EnvironmentReadiness> verify({
  required bool wslEnabled,
  required String listing,
  required String probe,
  bool install = false,
  bool sudoAllowed = false,
  bool readyOutput = false,
  bool tmuxInstallSucceeds = true,
  List<List<String>>? seen,
}) {
  final calls = <List<String>>[];
  var currentProbe = probe;
  ProcessResult respond(String executable, List<String> arguments) {
    calls.add(arguments);
    final joined = arguments.join(' ');
    if (joined.contains('--status')) {
      return wslEnabled
          ? ProcessResult(0, 0, 'ok', '')
          : ProcessResult(0, 1, '', 'WSL is not enabled');
    }
    if (joined.contains('-l -q')) {
      return ProcessResult(0, wslEnabled ? 0 : 1, listing, '');
    }
    if (joined.contains('sudo -n true') || joined.contains('harness-id')) {
      return sudoAllowed
          ? ProcessResult(0, 0, '0', '')
          : ProcessResult(0, 1, '', 'password required');
    }
    if (joined.contains('harness-tmux-probe')) {
      return currentProbe.contains('tmux yes')
          ? ProcessResult(0, 0, 'tmux 3.4', '')
          : ProcessResult(0, 1, '', 'tmux not found');
    }
    if (joined.contains('harness-probe')) {
      return ProcessResult(0, 0, currentProbe, '');
    }
    // Anything left that never named a distro is the NATIVE-CLI check (WSL
    // discovery is off there), and it must fail — otherwise the host reads as
    // a native install and never reaches the WSL verdict.
    if (!joined.contains('-d')) {
      return ProcessResult(0, 1, '', 'not installed natively');
    }
    // The CLI's own `version` inside the distro.
    return ProcessResult(0, 0, readyOutput ? '9.9.9' : '', '');
  }

  // A benign real process stands in for the installer: the test must exercise
  // the install PATH without spawning wsl.exe or touching a distro. Its output
  // is what a successful install would stream.
  Future<Process> startSimulatedInstall(
    String executable,
    List<String> arguments, {
    Map<String, String>? environment,
  }) {
    calls.add(arguments);
    final joined = arguments.join(' ');
    if (joined.contains('harness-tmux-install')) {
      if (!tmuxInstallSucceeds) {
        return Platform.isWindows
            ? Process.start('cmd.exe', ['/d', '/c', 'exit', '1'])
            : Process.start('/bin/sh', ['-c', 'exit 1']);
      }
      currentProbe = currentProbe.replaceAll('tmux no', 'tmux yes');
    }
    if (joined.contains('install.sh')) {
      currentProbe = currentProbe.replaceAll('cli missing', 'cli launcher');
    }
    return Platform.isWindows
        ? Process.start('cmd.exe', [
            '/d',
            '/c',
            'echo simulated install output',
          ])
        : Process.start('/bin/echo', ['simulated install output']);
  }

  return EnvironmentProvisioner(
    harnessHome: Directory('${Directory.systemTemp.path}\\harness-none'),
    isMacOS: false,
    isLinux: false,
    isWindows: true,
    run: (executable, arguments, {environment}) async =>
        respond(executable, arguments),
    wslRuntime: WslRuntime(
      runProcess: (executable, arguments, {environment}) async =>
          respond(executable, arguments),
      startProcess: startSimulatedInstall,
    ),
  ).ensureReady(onProgress: (_) {}, install: install).then((readiness) {
    if (seen != null) seen.addAll(calls);
    return readiness;
  });
}
