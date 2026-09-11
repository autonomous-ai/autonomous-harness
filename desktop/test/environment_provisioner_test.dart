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
    bool developerToolsPresent = true,
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
      if (shell.contains('brew install tmux')) {
        if (tmuxInstallExitCode == 0) await installTmux?.call();
        return result(
          tmuxInstallExitCode,
          stdout: tmuxInstallExitCode == 0 ? 'tmux installed' : '',
          stderr: tmuxInstallExitCode == 0 ? '' : 'Homebrew install failed',
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
      if (shell.contains('/usr/bin/xcrun --find clang')) {
        return developerToolsPresent
            ? result(0, stdout: '/usr/bin/clang')
            : result(1, stderr: 'unable to find utility clang');
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

  test('an unusable selected developer directory is shown as missing during pre-flight', () async {
    var terminalLaunches = 0;
    final calls = <String>[];
    final provisioner = EnvironmentProvisioner(
      harnessHome: scratch,
      isMacOS: true,
      isLinux: false,
      openTerminal: (_) async => terminalLaunches++,
      run: runner(
        developerToolsPresent: false,
        tmuxPresent: () => true,
        calls: calls,
      ),
    );

    final readiness = await provisioner.ensureReady(
      onProgress: (_) {},
      install: false,
    );

    expect(readiness.phase, EnvironmentSetupPhase.review);
    expect(readiness.systemReady, isFalse);
    expect(readiness.output.join('\n'), contains('xcrun --find clang'));
    expect(
      calls.any((line) => line.contains('/usr/bin/xcrun --find clang')),
      isTrue,
    );
    expect(terminalLaunches, 0);
  });

  test('automatic setup repairs or installs Apple developer tools in Terminal', () async {
    String? terminalScript;
    final calls = <String>[];
    final provisioner = EnvironmentProvisioner(
      harnessHome: scratch,
      isMacOS: true,
      isLinux: false,
      openTerminal: (path) async => terminalScript = path,
      run: runner(
        developerToolsPresent: false,
        tmuxPresent: () => false,
        calls: calls,
      ),
    );

    final readiness = await provisioner.ensureReady(
      onProgress: (_) {},
      install: true,
      mode: EnvironmentSetupMode.automatic,
    );

    expect(readiness.phase, EnvironmentSetupPhase.waitingForTerminal);
    expect(readiness.systemReady, isFalse);
    expect(readiness.homebrewReady, isTrue);
    expect(readiness.tmuxBinaryReady, isFalse);
    expect(terminalScript, isNotNull);
    expect(calls.where((line) => line.contains('install.sh')), isEmpty);
    final script = await File(terminalScript!).readAsString();
    expect(script, contains('/usr/bin/xcrun --find clang'));
    expect(
      script,
      contains(
        'sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer',
      ),
    );
    expect(script, contains('xcode-select --install'));
    expect(script, contains('did not become ready within 10 minutes'));
    expect(script, contains('if ! command -v tmux'));
    if (File('/bin/zsh').existsSync()) {
      expect(
        (await Process.run('/bin/zsh', ['-n', terminalScript!])).exitCode,
        0,
      );
    }
  });

  test(
    'macOS installs only missing tmux in-app when Homebrew is ready',
    () async {
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

      expect(readiness.isReady, isTrue);
      expect(readiness.homebrewReady, isTrue);
      expect(readiness.tmuxBinaryReady, isTrue);
      expect(terminalLaunches, 0);
      expect(
        calls.where((line) => line.contains('brew install tmux')),
        hasLength(1),
      );
      expect(readiness.output.join('\n'), contains('tmux installed'));
    },
  );

  test('a failed in-app tmux install retries visibly in Terminal', () async {
    await createManagedHarness();
    String? terminalScript;
    final calls = <String>[];
    final provisioner = EnvironmentProvisioner(
      harnessHome: scratch,
      isMacOS: true,
      isLinux: false,
      openTerminal: (path) async => terminalScript = path,
      run: runner(
        tmuxPresent: () => false,
        tmuxInstallExitCode: 7,
        calls: calls,
      ),
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
    expect(readiness.output.join('\n'), contains('exited 7'));
    expect(readiness.output.join('\n'), contains('Terminal opened to retry'));
  });

  test(
    'missing Homebrew still opens Terminal before installing tmux',
    () async {
      String? terminalScript;
      final calls = <String>[];
      final provisioner = EnvironmentProvisioner(
        harnessHome: scratch,
        isMacOS: true,
        isLinux: false,
        openTerminal: (path) async => terminalScript = path,
        run: runner(
          homebrewPresent: () => false,
          tmuxPresent: () => false,
          calls: calls,
        ),
      );

      final readiness = await provisioner.ensureReady(
        onProgress: (_) {},
        install: true,
        mode: EnvironmentSetupMode.automatic,
      );

      expect(readiness.phase, EnvironmentSetupPhase.waitingForTerminal);
      expect(readiness.homebrewReady, isFalse);
      expect(readiness.tmuxBinaryReady, isFalse);
      expect(terminalScript, isNotNull);
      expect(
        calls.where((line) => line.contains('brew install tmux')),
        isEmpty,
      );
      expect(readiness.output.join('\n'), contains('brew --version'));
    },
  );

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
    expect(
      (await Process.run('/bin/bash', ['-n', terminalScript!])).exitCode,
      0,
    );
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
      expect(readiness.systemReady, isTrue);
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
      expect(
        (await Process.run('/bin/bash', ['-n', terminalScript!])).exitCode,
        0,
      );
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
      expect(script, contains('apt_as_root install -y xclip tmux'));
      expect(
        script,
        contains('This window will close automatically in 5 seconds.'),
      );
      expect(script, contains('sleep 5'));
      expect(
        (await Process.run('/bin/bash', ['-n', terminalScript!])).exitCode,
        0,
      );
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
