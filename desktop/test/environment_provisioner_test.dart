import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/bootstrap/environment_provisioner.dart';

ProcessResult result(int exitCode, {String stdout = '', String stderr = ''}) =>
    ProcessResult(1, exitCode, stdout, stderr);

void main() {
  late Directory scratch;
  late File managedNode;

  setUp(() async {
    scratch = await Directory.systemTemp.createTemp('harness-env-test-');
    managedNode = File('${scratch.path}/runtime/node-v20/bin/node');
  });

  tearDown(() async {
    if (await scratch.exists()) await scratch.delete(recursive: true);
  });

  /**
   * Review cycle-6 P1: with no usable distribution, the setup steps must not offer a
   * default-targeting install command — an unnamed `wsl -- bash -lc …` runs in the implicit
   * default, which is exactly the excluded docker-desktop when that is the only distro. The
   * no-distro steps must name Ubuntu, the distribution they tell the person to install.
   */
  test('windowsSetupSteps names a real distro when no usable distribution exists', () {
    for (final dockerOnly in [
      <String>[],
      <String>['docker-desktop'],
      <String>['docker-desktop', 'docker-desktop-data'],
    ]) {
      for (final wslAvailable in [true, false]) {
        final steps = EnvironmentProvisioner.windowsSetupSteps(
          wslAvailable: wslAvailable,
          usable: const [],
          dockerOnly: dockerOnly,
        );
        for (final step in steps) {
          expect(
            step.command,
            isNot(RegExp(r'(^|\s)wsl\s+--')),
            reason: 'wslAvailable=$wslAvailable dockerOnly=$dockerOnly: '
                '"${step.title}" offered a default-targeting command',
          );
        }
      }
    }
    // With a usable distribution the step names it.
    final named = EnvironmentProvisioner.windowsSetupSteps(
      wslAvailable: true,
      usable: const ['Ubuntu-24.04'],
      dockerOnly: const [],
    );
    expect(named.single.command, contains('-d Ubuntu-24.04'));
  });

  Future<void> createManagedHarness() async {
    await managedNode.parent.create(recursive: true);
    await managedNode.writeAsString('node');
    await File('${scratch.path}/runtime/current-node')
        .writeAsString(managedNode.path);
    final cli = File('${scratch.path}/cli/cli.js');
    await cli.parent.create(recursive: true);
    await cli.writeAsString('cli');
  }

  ProcessRunner runner({
    required bool Function() tmuxPresent,
    bool Function()? homebrewPresent,
    bool Function()? xclipPresent,
    bool Function()? wlCopyPresent,
    bool aptPresent = true,
    bool runAsRoot = false,
    bool passwordlessSudo = false,
    Set<String> missingCommands = const {},
    Future<void> Function()? installTmux,
    Future<void> Function(List<String> packages)? installLinuxPackages,
    Future<void> Function()? installHarness,
    List<String>? calls,
    int tmuxInstallExitCode = 0,
    int linuxInstallExitCode = 0,
    String linuxInstallStderr = 'apt install failed',
  }) {
    return (executable, arguments, {environment}) async {
      final command = '$executable ${arguments.join(' ')}';
      calls?.add(command);
      final shell = arguments.isNotEmpty ? arguments.last : '';
      for (final missing in missingCommands) {
        if (shell.contains('command -v $missing ')) return result(1);
      }
      // `for c in a b c; do command -v "$c" …` — the all-of-these probe.
      final loop = RegExp(r'for c in ([^;]+); do command -v').firstMatch(shell);
      if (loop != null) {
        final names = loop.group(1)!.trim().split(' ');
        return names.any(missingCommands.contains) ? result(1) : result(0);
      }
      if (shell.contains('apt_as_root install -y')) {
        final packages = <String>[
          for (final package in [
            'dash',
            'bash',
            'curl',
            'tar',
            'sed',
            'gawk',
            'coreutils',
            'tmux',
            'procps',
            'xclip',
            'wl-clipboard',
          ])
            if (RegExp('(?:^| )${RegExp.escape(package)}(?: |;|\$)')
                .hasMatch(shell))
              package,
        ];
        if (linuxInstallExitCode == 0) {
          await installLinuxPackages?.call(packages);
        }
        return result(
          linuxInstallExitCode,
          stdout: linuxInstallExitCode == 0
              ? 'apt installed ${packages.join(' ')}'
              : '',
          stderr: linuxInstallExitCode == 0 ? '' : linuxInstallStderr,
        );
      }
      // The installer's host half: the one in-app step that obtains tmux on macOS.
      if (shell.contains('install.sh | /bin/sh -s -- --host')) {
        if (tmuxInstallExitCode == 0) await installTmux?.call();
        return result(
          tmuxInstallExitCode,
          stdout: tmuxInstallExitCode == 0 ? '✓ tmux ready (tmux 3.7c)' : '',
          stderr: tmuxInstallExitCode == 0 ? '' : 'tmux install failed',
        );
      }
      if (shell.contains('command -v brew')) {
        return (homebrewPresent?.call() ?? true)
            ? result(0, stdout: 'Homebrew 4.0')
            : result(1);
      }
      if (shell.contains('command -v tmux')) {
        return tmuxPresent() ? result(0, stdout: 'tmux 3.4') : result(1);
      }
      if (shell.contains('command -v wl-copy')) {
        return (wlCopyPresent?.call() ?? true) ? result(0) : result(1);
      }
      if (shell.contains('command -v xclip')) {
        return (xclipPresent?.call() ?? true) ? result(0) : result(1);
      }
      if (shell.contains('command -v apt-get')) {
        return aptPresent ? result(0) : result(1);
      }
      if (shell.endsWith('id -u')) {
        return result(0, stdout: runAsRoot ? '0' : '1000');
      }
      if (shell.contains('sudo -n true')) {
        return passwordlessSudo ? result(0) : result(1);
      }
      if (shell.contains('cdn.autonomous.ai/harness/cli/install.sh')) {
        await installHarness?.call();
        return result(0, stdout: 'Harness installed');
      }
      if (executable == managedNode.path &&
          arguments.length == 1 &&
          arguments.first == '--version') {
        return result(0, stdout: 'v20.18.0');
      }
      if (executable == managedNode.path && arguments.contains('version')) {
        return result(0, stdout: 'harness 1.2.3');
      }
      // System tools, writable HOME and chmod.
      return result(0);
    };
  }

  test(
    'launch pre-flight is read-only when required tools are missing',
    () async {
      var terminalLaunches = 0;
      final calls = <String>[];
      final provisioner = EnvironmentProvisioner(
        harnessHome: scratch,
        isMacOS: true,
        isLinux: false,
        openTerminal: (_) async => terminalLaunches++,
        run: runner(tmuxPresent: () => false, calls: calls),
      );

      final readiness = await provisioner.ensureReady(
        onProgress: (_) {},
        install: false,
      );

      expect(readiness.isReady, isFalse);
      expect(readiness.phase, EnvironmentSetupPhase.review);
      expect(terminalLaunches, 0);
      expect(calls.where((line) => line.contains('install.sh')), isEmpty);
    },
  );

  // The macOS ladder: tmux, else one in-app installer step that uses the
  // Homebrew already here or downloads the managed build. Nothing here ever
  // needs a Terminal window, Xcode, or a password.
  test('a computer with tmux is ready without Homebrew', () async {
    // Homebrew is how tmux MIGHT have got here, not how it runs — a `brew
    // install` from last year keeps working after Homebrew itself broke.
    var terminalLaunches = 0;
    final calls = <String>[];
    final provisioner = EnvironmentProvisioner(
      harnessHome: scratch,
      isMacOS: true,
      isLinux: false,
      openTerminal: (_) async => terminalLaunches++,
      run: runner(
        homebrewPresent: () => false,
        tmuxPresent: () => true,
        installHarness: createManagedHarness,
        calls: calls,
      ),
    );

    final readiness = await provisioner.ensureReady(
      onProgress: (_) {},
      install: true,
      mode: EnvironmentSetupMode.automatic,
    );

    expect(readiness.isReady, isTrue, reason: readiness.output.join('\n'));
    expect(readiness.steps[EnvironmentStep.tmux], EnvironmentStepStatus.ready);
    expect(readiness.plan, isEmpty);
    expect(calls.any((line) => line.contains('brew --version')), isFalse);
    expect(calls.any((line) => line.contains('--host')), isFalse);
    expect(terminalLaunches, 0);
  });

  test('without tmux the plan is one in-app step, worded by whether Homebrew is here', () async {
    for (final homebrew in [true, false]) {
      final calls = <String>[];
      final provisioner = EnvironmentProvisioner(
        harnessHome: scratch,
        isMacOS: true,
        isLinux: false,
        run: runner(
          homebrewPresent: () => homebrew,
          tmuxPresent: () => false,
          calls: calls,
        ),
      );

      final readiness = await provisioner.ensureReady(
        onProgress: (_) {},
        install: false,
      );

      expect(readiness.phase, EnvironmentSetupPhase.review);
      expect(readiness.plan.map((item) => item.title), [
        'tmux',
        'Managed Node 20+ & Harness CLI',
      ]);
      expect(readiness.plan.first.requiresTerminal, isFalse);
      expect(readiness.plan.first.command, kHarnessHostSetupCommand);
      expect(
        readiness.plan.first.detail,
        homebrew ? contains('Homebrew') : contains('~/.harness/runtime'),
      );
      expect(
        readiness.output.join('\n'),
        homebrew
            ? contains('✓ brew --version')
            : contains('managed tmux download'),
      );
      expect(calls.any((line) => line.contains('xcrun')), isFalse);
      expect(calls.any((line) => line.contains('--host')), isFalse);
    }
  });

  test('automatic setup obtains tmux in-app through the installer, never in Terminal', () async {
    await createManagedHarness();
    var tmuxPresent = false;
    var terminalLaunches = 0;
    final calls = <String>[];
    final provisioner = EnvironmentProvisioner(
      harnessHome: scratch,
      isMacOS: true,
      isLinux: false,
      openTerminal: (_) async => terminalLaunches++,
      run: runner(
        homebrewPresent: () => false,
        tmuxPresent: () => tmuxPresent,
        installTmux: () async => tmuxPresent = true,
        calls: calls,
      ),
    );

    final readiness = await provisioner.ensureReady(
      onProgress: (_) {},
      install: true,
      mode: EnvironmentSetupMode.automatic,
    );

    expect(readiness.isReady, isTrue, reason: readiness.output.join('\n'));
    expect(readiness.plan, isEmpty);
    expect(terminalLaunches, 0);
    expect(calls.where((line) => line.contains('--host')), hasLength(1));
    expect(calls.any((line) => line.contains('brew install')), isFalse);
    expect(readiness.output.join('\n'), contains('tmux ready (tmux 3.7c)'));
  });

  test('a failed in-app tmux install fails the step with the installer as the manual command', () async {
    await createManagedHarness();
    var terminalLaunches = 0;
    final provisioner = EnvironmentProvisioner(
      harnessHome: scratch,
      isMacOS: true,
      isLinux: false,
      openTerminal: (_) async => terminalLaunches++,
      run: runner(tmuxPresent: () => false, tmuxInstallExitCode: 22),
    );

    final readiness = await provisioner.ensureReady(
      onProgress: (_) {},
      install: true,
      mode: EnvironmentSetupMode.automatic,
    );

    expect(readiness.phase, EnvironmentSetupPhase.failed);
    expect(readiness.steps[EnvironmentStep.tmux], EnvironmentStepStatus.failed);
    expect(readiness.failure?.step, EnvironmentStep.tmux);
    expect(readiness.failure?.exitCode, 22);
    expect(readiness.failure?.command, contains(kHarnessHostSetupCommand));
    expect(readiness.failure?.detail, contains('exited 22'));
    expect(terminalLaunches, 0);
  });

  test('automatic setup installs Harness, then verifies', () async {
    final calls = <String>[];
    final provisioner = EnvironmentProvisioner(
      harnessHome: scratch,
      isMacOS: true,
      isLinux: false,
      run: runner(
        tmuxPresent: () => true,
        installHarness: createManagedHarness,
        calls: calls,
      ),
    );

    final readiness = await provisioner.ensureReady(
      onProgress: (_) {},
      install: true,
      mode: EnvironmentSetupMode.automatic,
    );

    final harnessInstall = calls.indexWhere(
      (line) => line.contains('cdn.autonomous.ai/harness/cli/install.sh'),
    );
    expect(readiness.isReady, isTrue);
    expect(readiness.phase, EnvironmentSetupPhase.ready);
    expect(harnessInstall, greaterThan(-1));
    expect(calls[harnessInstall], contains('/bin/sh -s -- --desktop'));
  });

  test('missing tmux opens a real terminal before the CLI installer', () async {
    String? terminalScript;
    final calls = <String>[];
    final provisioner = EnvironmentProvisioner(
      harnessHome: scratch,
      isMacOS: false,
      isLinux: true,
      openTerminal: (path) async => terminalScript = path,
      run: runner(tmuxPresent: () => false, calls: calls),
    );

    final readiness = await provisioner.ensureReady(
      onProgress: (_) {},
      install: true,
      mode: EnvironmentSetupMode.automatic,
    );

    expect(readiness.phase, EnvironmentSetupPhase.waitingForTerminal);
    expect(
      readiness.steps[EnvironmentStep.tmux],
      EnvironmentStepStatus.needsTerminal,
    );
    expect(terminalScript, isNotNull);
    expect(calls.where((line) => line.contains('install.sh')), isEmpty);
    final script = await File(terminalScript!).readAsString();
    expect(script, contains('apt_as_root install -y tmux'));
    expect(script, contains('if [ "\$(id -u)" -eq 0 ]'));
    expect(script, contains('terminal.log'));
    expect(script, contains('tmux -V'));
    // `bash -n` needs a POSIX host; the generated script is Linux shell, and
    // this check can only run where that shell exists.
    if (!Platform.isWindows) {
      expect(
        (await Process.run('/bin/bash', ['-n', terminalScript!])).exitCode,
        0,
      );
    }
  });

  test(
    'X11 with tmux ready still opens Terminal when xclip needs sudo',
    () async {
      await createManagedHarness();
      String? terminalScript;
      final provisioner = EnvironmentProvisioner(
        harnessHome: scratch,
        isMacOS: false,
        isLinux: true,
        platformEnvironment: const {'DISPLAY': ':0'},
        openTerminal: (path) async => terminalScript = path,
        run: runner(tmuxPresent: () => true, xclipPresent: () => false),
      );

      final readiness = await provisioner.ensureReady(
        onProgress: (_) {},
        install: true,
        mode: EnvironmentSetupMode.automatic,
      );

      expect(readiness.phase, EnvironmentSetupPhase.waitingForTerminal);
      expect(
        readiness.steps[EnvironmentStep.tmux],
        EnvironmentStepStatus.ready,
      );
      expect(
        readiness.steps[EnvironmentStep.clipboard],
        EnvironmentStepStatus.needsTerminal,
      );
      expect(readiness.terminalSetup, EnvironmentTerminalSetup.linuxHost);
      expect(terminalScript, isNotNull);
      final script = await File(terminalScript!).readAsString();
      expect(script, contains('apt_as_root install -y xclip'));
      expect(script, isNot(contains('apt_as_root install -y tmux')));
      expect(script, contains('chronyc tracking'));
      expect(script, contains('chronyc makestep'));
      expect(script, contains('timedatectl set-ntp true'));
      expect(script, contains('NTPSynchronized'));
      expect(
        script.indexOf('chronyc makestep'),
        lessThan(script.indexOf('timedatectl set-ntp true')),
      );
      expect(script, isNot(contains('apt_as_root update || true')));
      // `bash -n` needs a POSIX host; the generated script is Linux shell, and
      // this check can only run where that shell exists.
      if (!Platform.isWindows) {
        expect(
          (await Process.run('/bin/bash', ['-n', terminalScript!])).exitCode,
          0,
        );
      }
    },
  );

  test('Wayland installs wl-clipboard in-app with passwordless sudo', () async {
    await createManagedHarness();
    var wlCopyPresent = false;
    var terminalLaunches = 0;
    final calls = <String>[];
    final provisioner = EnvironmentProvisioner(
      harnessHome: scratch,
      isMacOS: false,
      isLinux: true,
      platformEnvironment: const {'WAYLAND_DISPLAY': 'wayland-0'},
      openTerminal: (_) async => terminalLaunches++,
      run: runner(
        tmuxPresent: () => true,
        wlCopyPresent: () => wlCopyPresent,
        passwordlessSudo: true,
        installLinuxPackages: (packages) async {
          if (packages.contains('wl-clipboard')) wlCopyPresent = true;
        },
        calls: calls,
      ),
    );

    final readiness = await provisioner.ensureReady(
      onProgress: (_) {},
      install: true,
      mode: EnvironmentSetupMode.automatic,
    );

    expect(readiness.isReady, isTrue);
    expect(
      readiness.steps[EnvironmentStep.clipboard],
      EnvironmentStepStatus.ready,
    );
    expect(terminalLaunches, 0);
    final install = calls.singleWhere(
      (line) => line.contains('apt_as_root install -y'),
    );
    expect(install, contains('wl-clipboard'));
    expect(install, isNot(contains(' xclip')));
    expect(readiness.output.join('\n'), contains('installed and verified'));
  });

  test('failed background apt falls back to a visible Terminal', () async {
    await createManagedHarness();
    String? terminalScript;
    final provisioner = EnvironmentProvisioner(
      harnessHome: scratch,
      isMacOS: false,
      isLinux: true,
      platformEnvironment: const {'DISPLAY': ':0'},
      openTerminal: (path) async => terminalScript = path,
      run: runner(
        tmuxPresent: () => true,
        xclipPresent: () => false,
        passwordlessSudo: true,
        linuxInstallExitCode: 7,
      ),
    );

    final readiness = await provisioner.ensureReady(
      onProgress: (_) {},
      install: true,
      mode: EnvironmentSetupMode.automatic,
    );

    expect(readiness.phase, EnvironmentSetupPhase.waitingForTerminal);
    expect(terminalScript, isNotNull);
    expect(readiness.output.join('\n'), contains('exited 7'));
    expect(readiness.output.join('\n'), contains('Terminal opened'));
  });

  test('failed automatic clock sync stops with actionable guidance', () async {
    await createManagedHarness();
    var terminalLaunches = 0;
    final provisioner = EnvironmentProvisioner(
      harnessHome: scratch,
      isMacOS: false,
      isLinux: true,
      platformEnvironment: const {'DISPLAY': ':0'},
      openTerminal: (_) async => terminalLaunches++,
      run: runner(
        tmuxPresent: () => true,
        xclipPresent: () => false,
        passwordlessSudo: true,
        linuxInstallExitCode: 31,
        linuxInstallStderr: 'Automatic time synchronization did not become ready within 30 seconds.',
      ),
    );

    final readiness = await provisioner.ensureReady(
      onProgress: (_) {},
      install: true,
      mode: EnvironmentSetupMode.automatic,
    );

    expect(readiness.phase, EnvironmentSetupPhase.failed);
    expect(readiness.failure?.title, contains('clock'));
    expect(readiness.failure?.command, contains('chronyc makestep'));
    expect(readiness.failure?.command, contains('timedatectl set-ntp true'));
    expect(terminalLaunches, 0);
  });

  test('failed apt refresh does not retry with stale indexes', () async {
    await createManagedHarness();
    var terminalLaunches = 0;
    final provisioner = EnvironmentProvisioner(
      harnessHome: scratch,
      isMacOS: false,
      isLinux: true,
      platformEnvironment: const {'DISPLAY': ':0'},
      openTerminal: (_) async => terminalLaunches++,
      run: runner(
        tmuxPresent: () => true,
        xclipPresent: () => false,
        passwordlessSudo: true,
        linuxInstallExitCode: 32,
        linuxInstallStderr: 'Package repository refresh failed.',
      ),
    );

    final readiness = await provisioner.ensureReady(
      onProgress: (_) {},
      install: true,
      mode: EnvironmentSetupMode.automatic,
    );

    expect(readiness.phase, EnvironmentSetupPhase.failed);
    expect(readiness.failure?.title, contains('repository refresh'));
    expect(readiness.failure?.command, 'sudo apt-get update');
    expect(terminalLaunches, 0);
  });

  test('non-apt Linux returns package-manager guidance', () async {
    await createManagedHarness();
    var terminalLaunches = 0;
    final provisioner = EnvironmentProvisioner(
      harnessHome: scratch,
      isMacOS: false,
      isLinux: true,
      platformEnvironment: const {'DISPLAY': ':0'},
      openTerminal: (_) async => terminalLaunches++,
      run: runner(
        tmuxPresent: () => true,
        xclipPresent: () => false,
        aptPresent: false,
      ),
    );

    final readiness = await provisioner.ensureReady(
      onProgress: (_) {},
      install: true,
      mode: EnvironmentSetupMode.automatic,
    );

    expect(readiness.phase, EnvironmentSetupPhase.failed);
    expect(terminalLaunches, 0);
    expect(readiness.failure?.title, contains('package manager'));
    expect(readiness.failure?.detail, contains('xclip'));
    expect(
      readiness.failure?.command,
      contains('distribution package manager'),
    );
  });

  test('Wayland wins when both Linux display variables exist', () async {
    await createManagedHarness();
    final calls = <String>[];
    final provisioner = EnvironmentProvisioner(
      harnessHome: scratch,
      isMacOS: false,
      isLinux: true,
      platformEnvironment: const {
        'WAYLAND_DISPLAY': 'wayland-0',
        'DISPLAY': ':0',
      },
      run: runner(
        tmuxPresent: () => true,
        wlCopyPresent: () => true,
        xclipPresent: () => false,
        calls: calls,
      ),
    );

    final readiness = await provisioner.ensureReady(
      onProgress: (_) {},
      install: false,
    );

    expect(readiness.isReady, isTrue);
    expect(
      readiness.steps[EnvironmentStep.clipboard],
      EnvironmentStepStatus.ready,
    );
    expect(calls.any((line) => line.contains('command -v wl-copy')), isTrue);
    expect(calls.any((line) => line.contains('command -v xclip')), isFalse);
  });

  test('headless Linux does not require an OS clipboard helper', () async {
    await createManagedHarness();
    final calls = <String>[];
    final provisioner = EnvironmentProvisioner(
      harnessHome: scratch,
      isMacOS: false,
      isLinux: true,
      platformEnvironment: const {},
      run: runner(
        tmuxPresent: () => true,
        xclipPresent: () => false,
        wlCopyPresent: () => false,
        calls: calls,
      ),
    );

    final readiness = await provisioner.ensureReady(
      onProgress: (_) {},
      install: false,
    );

    expect(readiness.isReady, isTrue);
    expect(
      readiness.steps[EnvironmentStep.clipboard],
      EnvironmentStepStatus.notApplicable,
    );
    expect(calls.any((line) => line.contains('command -v xclip')), isFalse);
    expect(calls.any((line) => line.contains('command -v wl-copy')), isFalse);
  });

  test('a running Linux Terminal setup is not opened a second time', () async {
    await createManagedHarness();
    var launches = 0;
    final provisioner = EnvironmentProvisioner(
      harnessHome: scratch,
      isMacOS: false,
      isLinux: true,
      platformEnvironment: const {'DISPLAY': ':0'},
      openTerminal: (_) async => launches++,
      run: runner(tmuxPresent: () => true, xclipPresent: () => false),
    );
    final waiting = await provisioner.ensureReady(
      onProgress: (_) {},
      install: true,
      mode: EnvironmentSetupMode.automatic,
    );

    final polled = await provisioner.ensureReady(
      onProgress: (_) {},
      resumeFrom: waiting,
      install: false,
      mode: EnvironmentSetupMode.automatic,
    );

    expect(launches, 1);
    expect(polled.phase, EnvironmentSetupPhase.waitingForTerminal);
    expect(polled.terminalSetup, EnvironmentTerminalSetup.linuxHost);
  });

  test(
    'a Terminal poll trusts live Linux probes when terminal.exit is absent',
    () async {
      await createManagedHarness();
      var launches = 0;
      var tmuxPresent = false;
      var xclipPresent = false;
      final provisioner = EnvironmentProvisioner(
        harnessHome: scratch,
        isMacOS: false,
        isLinux: true,
        platformEnvironment: const {'DISPLAY': ':0'},
        openTerminal: (_) async => launches++,
        run: runner(
          tmuxPresent: () => tmuxPresent,
          xclipPresent: () => xclipPresent,
        ),
      );
      final waiting = await provisioner.ensureReady(
        onProgress: (_) {},
        install: true,
        mode: EnvironmentSetupMode.automatic,
      );
      expect(await File(waiting.terminalResultPath!).exists(), isFalse);

      // The visible terminal completed the actual installation, but its EXIT
      // handoff file was never produced (for example because the terminal
      // profile keeps the launched command alive).
      tmuxPresent = true;
      xclipPresent = true;
      final rechecked = await provisioner.ensureReady(
        onProgress: (_) {},
        resumeFrom: waiting,
        install: false,
        mode: EnvironmentSetupMode.automatic,
      );

      expect(launches, 1);
      expect(rechecked.isReady, isTrue);
      expect(rechecked.phase, EnvironmentSetupPhase.ready);
    },
  );

  test('a completed host transaction that still misses clipboard fails without reopening Terminal', () async {
    await createManagedHarness();
    var launches = 0;
    final provisioner = EnvironmentProvisioner(
      harnessHome: scratch,
      isMacOS: false,
      isLinux: true,
      platformEnvironment: const {'DISPLAY': ':0'},
      openTerminal: (_) async => launches++,
      run: runner(tmuxPresent: () => true, xclipPresent: () => false),
    );
    final waiting = await provisioner.ensureReady(
      onProgress: (_) {},
      install: true,
      mode: EnvironmentSetupMode.automatic,
    );
    await File(waiting.terminalResultPath!).writeAsString('0\n');

    final rechecked = await provisioner.ensureReady(
      onProgress: (_) {},
      resumeFrom: waiting,
      install: false,
      mode: EnvironmentSetupMode.automatic,
    );

    expect(launches, 1);
    expect(rechecked.phase, EnvironmentSetupPhase.failed);
    expect(rechecked.failure?.title, contains('verification failed'));
    expect(rechecked.failure?.detail, contains('xclip'));
  });

  test(
    'missing tmux and X11 clipboard share one Terminal transaction',
    () async {
      await createManagedHarness();
      var launches = 0;
      String? terminalScript;
      final provisioner = EnvironmentProvisioner(
        harnessHome: scratch,
        isMacOS: false,
        isLinux: true,
        platformEnvironment: const {'DISPLAY': ':0'},
        openTerminal: (path) async {
          launches++;
          terminalScript = path;
        },
        run: runner(tmuxPresent: () => false, xclipPresent: () => false),
      );

      final readiness = await provisioner.ensureReady(
        onProgress: (_) {},
        install: true,
        mode: EnvironmentSetupMode.automatic,
      );

      expect(launches, 1);
      expect(readiness.phase, EnvironmentSetupPhase.waitingForTerminal);
      expect(
        readiness.steps[EnvironmentStep.tmux],
        EnvironmentStepStatus.needsTerminal,
      );
      expect(
        readiness.steps[EnvironmentStep.clipboard],
        EnvironmentStepStatus.needsTerminal,
      );
      final script = await File(terminalScript!).readAsString();
      expect(script, contains('apt_as_root install -y tmux xclip'));
      expect(
        script,
        contains('This window will close automatically in 5 seconds.'),
      );
      expect(script, contains('sleep 5'));
      // `bash -n` needs a POSIX host; the generated script is Linux shell, and
      // this check can only run where that shell exists.
      if (!Platform.isWindows) {
        expect(
          (await Process.run('/bin/bash', ['-n', terminalScript!])).exitCode,
          0,
        );
      }
    },
  );

  test('a Linux computer that runs tmux, ps and Harness is ready whatever else it lacks', () async {
    // curl, tar and the rest download the runtime; with the runtime here they
    // are not asked about, and neither is apt.
    await createManagedHarness();
    final calls = <String>[];
    final provisioner = EnvironmentProvisioner(
      harnessHome: scratch,
      isMacOS: false,
      isLinux: true,
      platformEnvironment: const {},
      run: runner(
        tmuxPresent: () => true,
        aptPresent: false,
        missingCommands: const {'curl', 'tar', 'sed', 'awk', 'sha256sum'},
        calls: calls,
      ),
    );

    final readiness = await provisioner.ensureReady(
      onProgress: (_) {},
      install: false,
    );

    expect(readiness.isReady, isTrue, reason: readiness.output.join('\n'));
    expect(readiness.plan, isEmpty);
    expect(calls.any((line) => line.contains('command -v curl ')), isFalse);
    expect(calls.any((line) => line.contains('for c in tar')), isFalse);
    expect(calls.any((line) => line.contains('command -v apt-get')), isFalse);
  });

  test('a missing ps joins tmux in the one apt transaction', () async {
    await createManagedHarness();
    final provisioner = EnvironmentProvisioner(
      harnessHome: scratch,
      isMacOS: false,
      isLinux: true,
      platformEnvironment: const {},
      run: runner(tmuxPresent: () => false, missingCommands: const {'ps'}),
    );

    final readiness = await provisioner.ensureReady(
      onProgress: (_) {},
      install: false,
    );

    expect(readiness.steps[EnvironmentStep.tmux], EnvironmentStepStatus.failed);
    expect(readiness.plan.single.packages, ['tmux', 'procps']);
    expect(readiness.plan.single.requiresTerminal, isTrue);
    expect(readiness.output.join('\n'), contains('✗ ps'));
  });

  test(
    'curl is added to the transaction only because Harness must be downloaded',
    () async {
      final calls = <String>[];
      final provisioner = EnvironmentProvisioner(
        harnessHome: scratch,
        isMacOS: false,
        isLinux: true,
        platformEnvironment: const {},
        run: runner(
          tmuxPresent: () => true,
          missingCommands: const {'curl'},
          calls: calls,
        ),
      );

      final readiness = await provisioner.ensureReady(
        onProgress: (_) {},
        install: false,
      );

      expect(
        readiness.steps[EnvironmentStep.tmux],
        EnvironmentStepStatus.ready,
      );
      expect(readiness.plan.map((item) => item.title), [
        'Linux host dependencies',
        'Managed Node 20+ & Harness CLI',
      ]);
      expect(readiness.plan.first.packages, ['curl']);
      expect(readiness.plan.first.step, EnvironmentStep.harness);
      // One probe for the lot; the per-tool probes run only when it fails.
      expect(
        calls.where((line) => line.contains('for c in tar')),
        hasLength(1),
      );
      expect(calls.any((line) => line.contains('command -v tar ')), isFalse);
    },
  );

  test('missing Linux base tools are installed before Harness', () async {
    var tmuxPresent = true;
    var curlPresent = false;
    var harnessInstalled = false;
    final missing = <String>{'curl'};
    final calls = <String>[];
    final provisioner = EnvironmentProvisioner(
      harnessHome: scratch,
      isMacOS: false,
      isLinux: true,
      platformEnvironment: const {},
      run: runner(
        tmuxPresent: () => tmuxPresent,
        runAsRoot: true,
        missingCommands: missing,
        installLinuxPackages: (packages) async {
          if (packages.contains('curl')) {
            curlPresent = true;
            missing.remove('curl');
          }
        },
        installHarness: () async {
          harnessInstalled = true;
          await createManagedHarness();
        },
        calls: calls,
      ),
    );

    final readiness = await provisioner.ensureReady(
      onProgress: (_) {},
      install: true,
      mode: EnvironmentSetupMode.automatic,
    );

    expect(curlPresent, isTrue);
    expect(harnessInstalled, isTrue);
    expect(readiness.isReady, isTrue);
    final apt = calls.indexWhere(
      (line) => line.contains('apt_as_root install -y'),
    );
    final harness = calls.indexWhere(
      (line) => line.contains('cdn.autonomous.ai/harness/cli/install.sh'),
    );
    expect(apt, greaterThan(-1));
    expect(harness, greaterThan(apt));
  });

  test(
    'a failed admin Terminal run surfaces its exit code and full log',
    () async {
      var launches = 0;
      final provisioner = EnvironmentProvisioner(
        harnessHome: scratch,
        isMacOS: false,
        isLinux: true,
        openTerminal: (_) async => launches++,
        run: runner(tmuxPresent: () => false),
      );
      final waiting = await provisioner.ensureReady(
        onProgress: (_) {},
        install: true,
        mode: EnvironmentSetupMode.automatic,
      );
      await File(waiting.terminalLogPath!).writeAsString('apt: package failed');
      await File(waiting.terminalResultPath!).writeAsString('42\n');

      final failed = await provisioner.ensureReady(
        onProgress: (_) {},
        resumeFrom: waiting,
        install: false,
        mode: EnvironmentSetupMode.automatic,
      );

      expect(failed.phase, EnvironmentSetupPhase.failed);
      expect(failed.failure?.exitCode, 42);
      expect(failed.output.join('\n'), contains('apt: package failed'));
      expect(launches, 1, reason: 'a polling probe must not reopen Terminal');
    },
  );

  test(
    'an apt future-release error is reported as system clock skew',
    () async {
      var launches = 0;
      final provisioner = EnvironmentProvisioner(
        harnessHome: scratch,
        isMacOS: false,
        isLinux: true,
        openTerminal: (_) async => launches++,
        run: runner(tmuxPresent: () => false),
      );
      final waiting = await provisioner.ensureReady(
        onProgress: (_) {},
        install: true,
        mode: EnvironmentSetupMode.automatic,
      );
      await File(waiting.terminalLogPath!).writeAsString(
        'E: Release file for http://archive.ubuntu.com/InRelease is not valid yet '
        '(invalid for another 1d 7h).',
      );
      await File(waiting.terminalResultPath!).writeAsString('100\n');

      final failed = await provisioner.ensureReady(
        onProgress: (_) {},
        resumeFrom: waiting,
        install: false,
        mode: EnvironmentSetupMode.automatic,
      );

      expect(failed.phase, EnvironmentSetupPhase.failed);
      expect(failed.failure?.title, contains('clock'));
      expect(failed.failure?.command, contains('chronyc makestep'));
      expect(failed.failure?.command, contains('timedatectl set-ntp true'));
      expect(failed.output.join('\n'), contains('is not valid yet'));
      expect(launches, 1);
    },
  );

  test(
    'explicit Retry clears the failed Terminal result and opens one new run',
    () async {
      var launches = 0;
      final provisioner = EnvironmentProvisioner(
        harnessHome: scratch,
        isMacOS: false,
        isLinux: true,
        openTerminal: (_) async => launches++,
        run: runner(tmuxPresent: () => false),
      );
      final waiting = await provisioner.ensureReady(
        onProgress: (_) {},
        install: true,
        mode: EnvironmentSetupMode.automatic,
      );
      await File(waiting.terminalResultPath!).writeAsString('100\n');
      final failed = await provisioner.ensureReady(
        onProgress: (_) {},
        resumeFrom: waiting,
        install: false,
        mode: EnvironmentSetupMode.automatic,
      );

      final retried = await provisioner.ensureReady(
        onProgress: (_) {},
        resumeFrom: failed,
        install: true,
        mode: EnvironmentSetupMode.automatic,
      );

      expect(launches, 2);
      expect(retried.phase, EnvironmentSetupPhase.waitingForTerminal);
      expect(retried.terminalResultPath, isNot(waiting.terminalResultPath));
    },
  );

  test(
    'a fully prepared machine passes a fresh read-only launch probe',
    () async {
      await createManagedHarness();
      final calls = <String>[];
      final provisioner = EnvironmentProvisioner(
        harnessHome: scratch,
        isMacOS: true,
        isLinux: false,
        run: runner(tmuxPresent: () => true, calls: calls),
      );

      final readiness = await provisioner.ensureReady(
        onProgress: (_) {},
        install: false,
      );

      expect(readiness.isReady, isTrue);
      expect(readiness.phase, EnvironmentSetupPhase.ready);
      expect(calls.where((line) => line.contains('install.sh')), isEmpty);
    },
  );
}
