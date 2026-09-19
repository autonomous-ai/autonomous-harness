import 'dart:convert';
import 'dart:io';

import 'bounded_process.dart';
import 'utf16_probe_encoding.dart';

/// The loopback port the Harness CLI daemon owns. Kept here only for the
/// documentation comment below; the app reads the real address from AppConfig.
///
/// ## Why Windows runs the CLI inside WSL2
///
/// The CLI is a Node bundle whose managed runtime is published for `darwin-*`
/// and `linux-*` only (see RELEASE.md), its installer is a POSIX shell script
/// piping into `/bin/sh`, and every agent terminal it opens is a tmux pane. None
/// of that exists on a stock Windows install, and none of it is worth
/// reimplementing beside the one implementation the CLI already ships.
///
/// WSL2 gives the Windows app the same runtime the Linux desktop app gets, and
/// Windows 11 forwards `127.0.0.1` from the Windows side into the default
/// distro, so the app's REST and WebSocket traffic reaches the daemon with no
/// configuration — the only thing this file has to do is RUN the CLI, which is
/// what `wsl.exe` is for.
///
/// The desktop app itself stays native: this is the CLI/agent runtime, not the
/// UI. A Windows host with no WSL2 distro is an unmet prerequisite, and every
/// caller here reports the exact command that fixes it rather than pretending
/// the environment is ready.
class WslRuntime {
  final Future<ProcessResult> Function(
    String executable,
    List<String> arguments, {
    Map<String, String>? environment,
  })
  _runProcess;

  /// Starting a process, separate from running one, because the install streams
  /// its output. Injectable so a test can drive the install path without
  /// spawning a real `wsl.exe`.
  final Future<Process> Function(
    String executable,
    List<String> arguments, {
    Map<String, String>? environment,
  })
  _startProcess;

  WslRuntime({
    Future<ProcessResult> Function(
      String executable,
      List<String> arguments, {
      Map<String, String>? environment,
    })?
    runProcess,
    Future<Process> Function(
      String executable,
      List<String> arguments, {
      Map<String, String>? environment,
    })?
    startProcess,
    Duration? probeTimeout,
  }) : _runProcess = runProcess ?? Process.run,
       _startProcess = startProcess ?? Process.start,
       // A hung `wsl.exe` — a distro stuck in boot, a probe waiting on the WSL
       // service — must fail in bounded time. Every probe below goes through
       // [_runBounded], which requests termination of the child it started.
       _probeTimeout = probeTimeout ?? const Duration(seconds: 20),
       _injected = runProcess != null || startProcess != null;

  /// Whether the process hooks were injected (tests) rather than defaulted.
  ///
  /// An injected runner is the caller's own seam: a unit test hands over a
  /// synchronous fake and expects it to be used as-is, so [_runBounded] delegates
  /// to it instead of trying to start and kill a real child. Production — no
  /// injection — gets the bounded, killable path.
  final bool _injected;
  final Duration _probeTimeout;

  /// Runs [arguments] with a deadline and requests child termination on expiry.
  ///
  /// `Process.run` cannot be killed, so a timeout on it would leave the process
  /// running and the caller holding a future that never lands. This starts the
  /// process itself, collects its output, and on expiry requests termination and
  /// reports exit code 124 — the same convention the shell uses.
  Future<ProcessResult> _runBounded(
    List<String> arguments, {
    Duration? timeout,
    void Function(String line)? onOutput,
  }) async {
    if (_injected && _runProcess != Process.run) {
      return _runProcess(executable, arguments);
    }
    final effective = timeout ?? _probeTimeout;
    return runOwnedProcessBounded(
      executable: executable,
      arguments: arguments,
      startProcess: _startProcess,
      timeout: effective,
      outputEncoding: const Utf16LeProbeEncoding(),
      stripNulls: true,
      onOutput: onOutput,
    );
  }

  static const String executable = 'wsl.exe';

  /// Enables WSL2 and installs a distro. Needs an elevated shell and a reboot,
  /// which is why the app can only name it.
  static const String enableWslCommand = 'wsl --install -d Ubuntu';

  static const String cliInstallUrl =
      'https://cdn.autonomous.ai/harness/cli/install.sh';

  /// The CLI's own installer, run inside the distro. `--desktop` is the same
  /// flag the macOS/Linux first-run path passes (see
  /// [kHarnessDesktopInstallCommand]).
  static const String cliInstallCommand =
      'curl -fsSL $cliInstallUrl | /bin/sh -s -- --desktop';

  /// The launcher the installer writes, and the reason a Finder-style launch
  /// works without PATH.
  static const String _managedLauncher = '\$HOME/.local/bin/harness';

  /// Answers whether `wsl.exe` exists and WSL is installed.
  ///
  /// `wsl.exe --status` exits non-zero on a machine where the optional Windows
  /// feature was never enabled, which is the only case the app has to tell
  /// apart from "the distro exists but has no CLI".
  Future<bool> available() async {
    try {
      final result = await _run(['--status']);
      return result.exitCode == 0;
    } on ProcessException {
      // wsl.exe is not present at all — the feature is off or the store
      // version was removed.
      return false;
    }
  }

  /// Docker Desktop's own WSL distributions.
  ///
  /// They are real distros — `wsl -l -q` lists them and `wsl -d docker-desktop`
  /// answers — but they exist to host the Docker engine, are not a general
  /// development environment, and installing the CLI into one would put a login
  /// and a tmux server inside a distribution the user does not own. They are
  /// excluded from every probe and from every install.
  static bool isDockerDistro(String name) {
    final normalized = name.trim().toLowerCase();
    return normalized == 'docker-desktop' ||
        normalized == 'docker-desktop-data' ||
        normalized.startsWith('docker-desktop-');
  }

  /// Distributions the app is willing to USE: everything WSL has, minus
  /// Docker's own. Named, never the implicit default — see [findHarness].
  Future<List<String>> usableDistros() async =>
      (await listDistros()).where((name) => !isDockerDistro(name)).toList();

  /// Docker's distributions, for the setup screen's copy: "WSL2 answers, but
  /// only Docker's distributions are installed" is a different problem from
  /// "WSL2 has no distribution" and needs different words.
  Future<List<String>> dockerOnlyDistros() async =>
      (await listDistros()).where(isDockerDistro).toList();

  /// Installed distro names, in `wsl -l -q` order (the default distro first,
  /// as WSL lists it).
  ///
  /// `wsl.exe` writes UTF-16LE ("wide" console output). Production decodes at
  /// the BYTE level: [Utf16LeProbeEncoding] sniffs the NUL-alternation in the
  /// raw stream before any lossy decode can happen. The old path let the
  /// strict UTF-8 stream codec run first, so a non-ASCII distro name (é, ü,
  /// 任) failed or corrupted inside the decoder and the swallowed stream error
  /// yielded an EMPTY inventory while `wsl.exe` exited 0 (review cycle-2, P2).
  ///
  /// The string-level look below is only the compatibility layer for the
  /// injected [_runProcess] seam, whose fakes hand back an already-decoded
  /// Dart string (a latin1 round-trip of the wide bytes) and never reach the
  /// stream codec.
  Future<List<String>> listDistros() async {
    try {
      final result = await _run(['-l', '-q']);
      if (result.exitCode != 0) return const [];
      final rawText = '${result.stdout}';
      final text = _looksUtf16LeString(rawText)
          ? _decodeUtf16LeString(rawText)
          : rawText.replaceAll('\u0000', '');
      return text
          .replaceAll('\u0000', '')
          .replaceAll('\ufeff', '')
          .replaceAll('\r\n', '\n')
          .replaceAll('\r', '\n')
          .split('\n')
          .map((line) => line.trim())
          .where((name) => name.isNotEmpty)
          .toList();
    } on ProcessException {
      return const [];
    }
  }

  /// String-level wide-output sniff for the injected seam, where the bytes have
  /// already been latin1-round-tripped: each code unit IS one raw byte, so the
  /// sniff re-encodes and defers to the byte-level census. The census and the
  /// CRLF-run discriminator are the only wide evidence here — a leading
  /// BOM-shaped pair (U+00FF U+00FE) is NOT decisive, unlike at the byte level
  /// (review cycle-5, P2): on this seam a genuine wide BOM never survives these
  /// two code units, so the pair can only be plain text and must not be
  /// re-decoded into mojibake.
  static bool _looksUtf16LeString(String s) {
    // Production has already decoded the byte stream. Non-Latin-1 code units
    // cannot be a byte-mapped string from the injected compatibility seam.
    if (s.codeUnits.any((unit) => unit > 0xff)) return false;
    return Utf16LeProbeDecoder.looksUtf16Le(
      latin1.encode(s),
      bomIsDecisive: false,
    );
  }

  /// Re-pack a latin1-round-tripped UTF-16LE string: each code unit is a raw
  /// byte, so the byte-level decode applies, including BOM stripping.
  static String _decodeUtf16LeString(String s) {
    return Utf16LeProbeDecoder.decodeUtf16LeBytes(latin1.encode(s));
  }

  Future<ProcessResult> _run(List<String> arguments) => _runBounded(arguments);

  /// Runs [command] with the distro's login shell, the way `harness` is used
  /// from a terminal. Arguments travel after `$0` so nothing has to be quoted:
  /// a machine name or an agent name with a space in it must not become two
  /// argv entries, and `bash -lc 'script' name arg…` is exactly that contract.
  ///
  /// The command is delivered with `wsl -e`, NOT `wsl --`. `--` hands the
  /// remainder to the distro's default shell for a second round of parsing,
  /// which eats the quoting around the `-c` script and then EXPANDS the
  /// script's `$0`/`$@` references itself: observed as `harness version`
  /// running with zero arguments — every CLI call degraded to the help banner,
  /// with exit 0, while every injected-fake test passed. `-e` executes the
  /// named command directly (CreateProcess-style argv passthrough), so the
  /// script and its `$0`-trailing arguments reach bash exactly as listed.
  ///
  /// [distro] is REQUIRED and must be a named, usable distribution. The app
  /// never runs anything in the implicit default distro: on a Docker-heavy
  /// machine the default can BE `docker-desktop`, and "no `-d`" would silently
  /// point every probe — and an install — at the one distribution that must not
  /// be touched.
  List<String> buildArguments({
    required String distro,
    required String script,
    List<String> scriptArguments = const [],
    String scriptName = 'harness',
  }) => [
    '-d',
    distro,
    '-e',
    'bash',
    '-lc',
    script,
    scriptName,
    ...scriptArguments,
  ];

  /// Looks for the CLI in every USABLE distro, by name.
  ///
  /// Docker's distributions are skipped entirely, and no probe ever uses the
  /// implicit default. A machine whose CLI lives in a second distro still works;
  /// a Docker-only machine reports "not found" and names that as the problem.
  Future<WslHarnessProbe> findHarness({List<String>? distros}) async {
    final names = distros ?? await usableDistros();
    WslHarnessProbe? firstFound;
    WslHarnessProbe? firstMissing;
    for (final distro in names) {
      if (isDockerDistro(distro)) continue;
      final probe = await probeHarness(distro: distro);
      if (probe.found) {
        if (probe.tmuxReady) return probe;
        firstFound ??= probe;
      } else {
        firstMissing ??= probe;
      }
    }
    return firstFound ?? firstMissing ?? const WslHarnessProbe.notFound();
  }

  /// Looks for the CLI in one distro, run exactly as the app would run it, and
  /// reports the terminal backend in the same breath.
  ///
  /// tmux is required for every terminal session and is NOT implied by the CLI
  /// being present — a distro can have the CLI and no tmux, which is a real
  /// state the app must name rather than report "ready".
  Future<WslHarnessProbe> probeHarness({required String distro}) async {
    if (isDockerDistro(distro)) return const WslHarnessProbe.notFound();
    final result = await runIn(
      distro: distro,
      script:
          'if [ -x "$_managedLauncher" ]; then echo "cli launcher"; '
          'elif command -v harness >/dev/null 2>&1; then echo "cli path"; '
          'else echo "cli missing"; fi; '
          'if command -v tmux >/dev/null 2>&1 && tmux -V >/dev/null 2>&1; '
          'then echo "tmux yes"; else echo "tmux no"; fi',
      scriptName: 'harness-probe',
    );
    if (result.exitCode != 0) {
      return WslHarnessProbe(distro: distro, found: false);
    }
    final answer = '${result.stdout}';
    final tmuxReady = answer.contains('tmux yes');
    if (answer.contains('cli launcher')) {
      return WslHarnessProbe(
        distro: distro,
        viaPath: false,
        executable: _managedLauncher,
        tmuxReady: tmuxReady,
      );
    }
    if (answer.contains('cli path')) {
      return WslHarnessProbe(
        distro: distro,
        viaPath: true,
        executable: 'harness',
        tmuxReady: tmuxReady,
      );
    }
    return WslHarnessProbe(distro: distro, found: false, tmuxReady: tmuxReady);
  }

  /// Runs a shell script inside one named, usable distro.
  ///
  /// Docker's distributions are refused here too, so no caller can reach one by
  /// accident even if it passes the name explicitly.
  Future<ProcessResult> runIn({
    required String distro,
    required String script,
    List<String> scriptArguments = const [],
    String scriptName = 'harness',
  }) async {
    if (isDockerDistro(distro)) {
      return _refuseDocker(distro);
    }
    final arguments = buildArguments(
      distro: distro,
      script: script,
      scriptArguments: scriptArguments,
      scriptName: scriptName,
    );
    return _runBounded(arguments);
  }

  /// A Docker Desktop pseudo-distro can never run the CLI's tmux backend; every
  /// entry point refuses it uniformly with the same exit-code-126 result.
  ProcessResult _refuseDocker(String distro) => ProcessResult(
    0,
    126,
    '',
    'refused: $distro is a Docker Desktop distribution',
  );

  /// The CLI, as a command the app can spawn.
  ///
  /// The executable itself is expanded inside a QUOTED position: the managed
  /// launcher is `"$HOME/.local/bin/harness"`, and a Linux home with a space
  /// in it passed the quoted probe but SPLIT at execution when the expansion
  /// was bare (review cycle-2, P2). `"\$@"` stays quoted throughout.
  List<String> cliArguments(WslHarnessProbe probe, List<String> arguments) =>
      buildArguments(
        distro: probe.distro!,
        script: 'exec "${probe.executable}" "\$@"',
        scriptArguments: arguments,
      );

  /// Runs a Windows-hosted packaged CLI with the managed Linux Node in the
  /// selected distro. The host path is positional argv, then [wslpath] converts
  /// it without a shell interpolation round, so spaces and quotes stay data.
  /// Update controls are exported here because a Windows process environment is
  /// not inherited by a WSL Linux process.
  List<String> bundledCliArguments(
    WslHarnessProbe probe,
    String windowsBundleDirectory,
    List<String> arguments,
  ) => buildArguments(
    distro: probe.distro!,
    script: r'''
bundle_dir="$(wslpath -u -- "$1")" || { echo "Harness packaged CLI path is not accessible in WSL" >&2; exit 126; }
node_file="$HOME/.harness/runtime/current-node"
[ -s "$node_file" ] || { echo "Harness managed Node is missing in WSL: $node_file" >&2; exit 126; }
IFS= read -r node < "$node_file"
[ -n "$node" ] && [ -x "$node" ] || { echo "Harness managed Node is invalid in WSL: $node" >&2; exit 126; }
[ -s "$bundle_dir/cli.js" ] && [ -s "$bundle_dir/notify.mjs" ] || { echo "Harness packaged CLI bundle is missing or empty in WSL: $bundle_dir" >&2; exit 126; }
export ADAPTER_UPDATE_DISABLE=true
export ADAPTER_CLI_DIR="$bundle_dir"
shift
exec "$node" "$bundle_dir/cli.js" "$@"
''',
    scriptName: 'harness-bundled',
    scriptArguments: [windowsBundleDirectory, ...arguments],
  );

  /// This computer's identity, read from the CLI that owns the daemon.
  ///
  /// The Windows side has no `~/.harness/computer-id` when the CLI runs in a
  /// distro — the CLI writes it in ITS home. The daemon advertises that same id
  /// on its control port, so reading it from the distro is what lets
  /// `LocalCliDiscovery` match the two instead of refusing every connection.
  Future<String?> computerId({required String distro}) async {
    final result = await runIn(
      distro: distro,
      script: r'cat "$HOME/.harness/computer-id" 2>/dev/null',
      scriptName: 'harness-computer-id',
    );
    if (result.exitCode != 0) return null;
    final id = '${result.stdout}'.trim();
    return id.isEmpty ? null : id;
  }

  /// Whether tmux is installed in [distro] — the terminal backend every session
  /// needs, asked separately because "the CLI is there" does not imply it.
  Future<bool> hasTmux({required String distro}) async {
    final result = await runIn(
      distro: distro,
      script: 'command -v tmux >/dev/null 2>&1 && tmux -V >/dev/null 2>&1',
      scriptName: 'harness-tmux-probe',
    );
    return result.exitCode == 0;
  }

  /// Whether explicit Automatic setup can run without waiting on a password
  /// prompt inside [distro].
  Future<bool> canInstallUnattended({required String distro}) async {
    final result = await runIn(
      distro: distro,
      script: 'id -u',
      scriptName: 'harness-id',
    );
    if (result.exitCode == 0 && '${result.stdout}'.trim() == '0') return true;
    final sudo = await runIn(
      distro: distro,
      script: 'command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1',
      scriptName: 'harness-sudo-probe',
    );
    return sudo.exitCode == 0;
  }

  /// Installs the WSL terminal backend after [canInstallUnattended] has proved
  /// the selected distro will not stop for a password prompt.
  Future<ProcessResult> installTmux({
    required String distro,
    void Function(String line)? onOutput,
    Duration timeout = const Duration(minutes: 5),
  }) {
    if (isDockerDistro(distro)) return Future.value(_refuseDocker(distro));
    return runOwnedProcessBounded(
      executable: executable,
      arguments: buildArguments(
        distro: distro,
        script:
            'if [ "\$(id -u)" -eq 0 ]; then '
            'apt-get install -y tmux; else sudo -n apt-get install -y tmux; fi '
            '&& tmux -V',
        scriptName: 'harness-tmux-install',
      ),
      startProcess: _startProcess,
      timeout: timeout,
      outputEncoding: const SystemEncoding(),
      stripNulls: true,
      onOutput: onOutput,
    );
  }

  /// Installs managed Node and the CLI after host/tmux setup has completed.
  Future<ProcessResult> installHarness({
    required String distro,
    void Function(String line)? onOutput,
    Duration timeout = const Duration(minutes: 10),
  }) {
    if (isDockerDistro(distro)) return Future.value(_refuseDocker(distro));
    return runOwnedProcessBounded(
      executable: executable,
      arguments: buildArguments(
        distro: distro,
        script: 'set -e; $cliInstallCommand',
        scriptName: 'harness-install',
      ),
      startProcess: _startProcess,
      timeout: timeout,
      outputEncoding: const SystemEncoding(),
      stripNulls: true,
      onOutput: onOutput,
    );
  }

  /// The command a person would type, spelled for a Windows shell so it can be
  /// copied out of the app and run in Windows Terminal.
  static String installCommandForDisplay({String? distro}) {
    final target = distro == null ? '' : '-d $distro ';
    return 'wsl $target-- bash -lc "$cliInstallCommand"';
  }

  /// Installing tmux into a distro that already has the CLI but no backend.
  static String tmuxCommandForDisplay({required String distro}) =>
      "wsl -d $distro -- bash -lc 'sudo apt-get install -y tmux && tmux -V'";
}

/// What one look for the CLI inside WSL found.
///
/// [distro] names the distribution that was probed, including when its CLI is
/// missing. It is null only when no usable distribution was available. This
/// lets provisioning target the selected distro and preserve its independent
/// tmux result without ever falling through to WSL's implicit default.
class WslHarnessProbe {
  final String? distro;
  final bool viaPath;
  final String executable;
  final bool found;
  final bool tmuxReady;

  const WslHarnessProbe({
    required this.distro,
    this.viaPath = false,
    this.executable = 'harness',
    this.found = true,
    this.tmuxReady = false,
  });

  const WslHarnessProbe.notFound()
    : distro = null,
      viaPath = false,
      executable = 'harness',
      found = false,
      tmuxReady = false;

  /// The distro name a person reads, for a row on the setup screen.
  String get distroLabel => distro ?? 'no usable WSL distro';
}
