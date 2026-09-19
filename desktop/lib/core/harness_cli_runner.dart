import 'host_platform.dart';

import 'dart:convert';
import 'dart:io';

import '../logging/cli_transcript.dart';
import 'backend_path.dart';
import 'bounded_process.dart';
import 'utf16_probe_encoding.dart';
import 'wsl_runtime.dart';

/// Runs the Harness CLI owned by this desktop app without depending on a
/// terminal shell, its rc files, or Finder's inherited PATH.
///
/// The normal path is the managed tier: `~/.harness/runtime/current-node` — a
/// private, checksum-verified Node that the `harness` installer provisions and
/// records — paired with the `~/.harness/cli/cli.js` bundle,
/// invoked as `<node> <cli.js> …` with no shell in between. Because both are
/// absolute paths beneath [harnessHome], launching Harness from Finder and from
/// Terminal have identical runtime behavior; PATH never enters into it.
///
/// On macOS and Linux, behind that come the installed
/// `~/.local/bin/harness` launcher and finally bare `harness` on PATH, which
/// cover a developer-managed install and the window before the first
/// provisioning run has finished.
///
/// ## Windows
///
/// **The CLI runs in WSL2.** Its managed runtime is published for
/// macOS and Linux only and its installer is a POSIX script, so a Windows host
/// runs the CLI inside a named development distro and Windows 11 forwards
/// loopback into it (see [WslRuntime]). This resolves to
/// `wsl.exe -d <distro> -- bash -lc 'exec "$HOME/.local/bin/harness" "$@"' …`
/// rather than to a native managed runtime, launcher, or bare name. The CLI's
/// only supported terminal backend is tmux, which is unavailable natively on
/// Windows, so a native executable answering `version` is not a usable desktop
/// backend.
///
/// **A bare `harness` must never be spawned on Windows.** CreateProcess
/// searches the CALLING EXECUTABLE'S OWN DIRECTORY before PATH, so a release
/// build named `harness.exe` asking for `harness` starts a copy of itself —
/// observed here as a spawn storm of a dozen app instances, each one running
/// the same provisioning probe that spawned the last. Windows resolution
/// therefore returns either an explicit `wsl.exe` invocation or a name that
/// cannot exist — a clean `ProcessException`, which every caller already treats
/// as \"the CLI is not there\".
class HarnessCliRunner {
  final Directory harnessHome;
  final Map<String, String> environment;

  /// How long one CLI command may take before the app stops waiting on it. Every command this app
  /// runs answers in well under a second (`auth status`, `link list`) or a few seconds (`start`
  /// spawning the daemon and waiting for its port). A `start` that had to reach a black-holed
  /// backend used to sit here for good — and the app sat on "Starting local service…" with it.
  final Duration runTimeout;
  static const defaultRunTimeout = Duration(seconds: 30);
  final Future<ProcessResult> Function(
    String executable,
    List<String> arguments, {
    Map<String, String>? environment,
  })
  _runProcess;
  final Future<Process> Function(
    String executable,
    List<String> arguments, {
    Map<String, String>? environment,
  })
  _startProcess;
  final WslRuntime _wsl;
  final bool _isWindows;
  final bool _requiresWindowsBundle;
  final Directory _windowsBundleDirectory;

  static const bool windowsBundledCli = bool.fromEnvironment(
    'WINDOWS_BUNDLED_CLI',
  );

  /// A name no install can produce. Spawning it fails as a `ProcessException`
  /// on the first call instead of starting this application again.
  static const String windowsMissingCliExecutable = 'harness-cli-not-installed';

  final Duration _wslProbeMissTtl;
  // Declared late so it can capture the injected clock from the constructor.
  late final MissTtlCache<WslHarnessProbe> _wslProbeCache = MissTtlCache<WslHarnessProbe>(
    ttl: _wslProbeMissTtl,
    now: _now,
  );
  final DateTime Function() _now;

  HarnessCliRunner({
    Directory? harnessHome,
    Map<String, String>? environment,
    this.runTimeout = defaultRunTimeout,
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
    WslRuntime? wslRuntime,
    Duration? wslProbeMissTtl,
    DateTime Function()? now,
    bool? isWindows,
    bool? requiresWindowsBundle,
    Directory? windowsBundleDirectory,
  }) : environment = environment ?? Platform.environment,
       harnessHome = harnessHome ?? Directory(_defaultHarnessHome()),
       _wsl = wslRuntime ?? WslRuntime(runProcess: runProcess),
       _wslProbeMissTtl = wslProbeMissTtl ?? const Duration(seconds: 5),
       _now = now ?? DateTime.now,
       _isWindows = isWindows ?? Platform.isWindows,
       _requiresWindowsBundle = requiresWindowsBundle ?? windowsBundledCli,
       _windowsBundleDirectory =
           windowsBundleDirectory ??
           Directory(
             '${File(Platform.resolvedExecutable).parent.path}'
             '${Platform.pathSeparator}harness-cli',
           ),
       _runProcess = runProcess ?? Process.run,
       _startProcess = startProcess ?? Process.start;

  static String _defaultHarnessHome() {
    final resolved = resolveHomeDirectory(Platform.environment) ?? containerHome;
    if (resolved == null || resolved.isEmpty) {
      throw StateError('Could not resolve the current user home directory');
    }
    return '$resolved${Platform.pathSeparator}.harness';
  }

  Directory get _runtimeDirectory =>
      Directory('${harnessHome.path}${Platform.pathSeparator}runtime');

  File get _currentNodeFile =>
      File('${_runtimeDirectory.path}${Platform.pathSeparator}current-node');

  File get _cliFile => File(
    '${harnessHome.path}${Platform.pathSeparator}cli${Platform.pathSeparator}cli.js',
  );

  /// Builds the direct invocation used by [run] and [start]. Public for
  /// focused tests and diagnostics; callers should generally call [run].
  Future<HarnessCliInvocation> resolve(List<String> arguments) async {
    // Windows has one supported runtime: the CLI and tmux in WSL2. Check it
    // before looking at host-side managed files left by an old prototype;
    // those files can answer `version` but cannot start this tmux-only daemon.
    if (_isWindows) return _resolveWindows(arguments);

    final node = await _managedNode();
    if (node != null && await _cliFile.exists()) {
      return HarnessCliInvocation(
        executable: node.path,
        arguments: [_cliFile.path, ...arguments],
        environment: _commandEnvironment(),
        source: HarnessCliSource.managed,
      );
    }

    final home = _home();
    if (home != null && home.isNotEmpty) {
      final launcher = File(
        '$home${Platform.pathSeparator}.local${Platform.pathSeparator}bin${Platform.pathSeparator}harness',
      );
      if (await launcher.exists()) {
        return HarnessCliInvocation(
          executable: launcher.path,
          arguments: arguments,
          environment: _commandEnvironment(),
          source: HarnessCliSource.launcher,
        );
      }
    }

    return HarnessCliInvocation(
      executable: 'harness',
      arguments: arguments,
      environment: _commandEnvironment(),
      source: HarnessCliSource.path,
    );
  }

  /// Windows resolution: the CLI inside WSL2, then the failing name that keeps
  /// this application from spawning itself when no supported runtime exists.
  Future<HarnessCliInvocation> _resolveWindows(List<String> arguments) async {
    if (_requiresWindowsBundle) await _validateWindowsBundle();
    final probe = await _wslHarness();
    if (probe != null && probe.found) {
      return HarnessCliInvocation(
        executable: WslRuntime.executable,
        arguments: _requiresWindowsBundle
            ? _wsl.bundledCliArguments(
                probe,
                _windowsBundleDirectory.path,
                arguments,
              )
            : _wsl.cliArguments(probe, arguments),
        environment: _commandEnvironment(),
        source: HarnessCliSource.wsl,
        wslDistro: probe.distro,
      );
    }

    return HarnessCliInvocation(
      executable: windowsMissingCliExecutable,
      arguments: arguments,
      environment: _commandEnvironment(),
      source: HarnessCliSource.path,
    );
  }

  Future<void> _validateWindowsBundle() async {
    final cli = File(
      '${_windowsBundleDirectory.path}${Platform.pathSeparator}cli.js',
    );
    final notify = File(
      '${_windowsBundleDirectory.path}${Platform.pathSeparator}notify.mjs',
    );
    for (final file in [cli, notify]) {
      try {
        if (!await file.exists() || await file.length() == 0) {
          throw StateError(
            'Packaged Harness CLI is missing or empty: ${file.path}',
          );
        }
      } on FileSystemException catch (error) {
        throw StateError(
          'Packaged Harness CLI cannot be read: ${file.path} ($error)',
        );
      }
    }
  }

  /// The CLI inside WSL2.
  ///
  /// A probe that found NOTHING is retried after [_wslProbeMissTtl]: "no distro
  /// answered yet" is often transient (WSL is still starting, a distro was just
  /// installed, `wsl --install` finished between two polls), and caching that
  /// miss for the life of the runner is what used to force a restart before the
  /// app could see a CLI that had just appeared. A hit is cached for good.
  Future<WslHarnessProbe?> _wslHarness() {
    return _wslProbeCache.read(() async {
      try {
        final probe = await _wsl.findHarness();
        return probe.found ? probe : null;
      } on ProcessException {
        return null;
      }
    });
  }

  WslHarnessProbe? get wslProbe => _wslProbeCache.value;

  Future<ProcessResult> run(List<String> arguments) async {
    // The bound covers the WHOLE attempt, not just the command: on Windows the
    // resolution itself probes WSL, and a probe that never answers must end the
    // wait exactly like a command that never finishes.
    Future<ProcessResult> attempt() async {
      final invocation = await resolve(arguments);
      return _runProcess(
        invocation.executable,
        invocation.arguments,
        environment: invocation.environment,
      );
    }

    return logProcessRun(
      _displayLine(arguments),
      () => attempt()
          .timeout(
            runTimeout,
            // The child is not killed — `Process.run` gives no handle to it, and a stuck `start` is the
            // CLI's own lock's business. What ends here is the app's wait, as an error it can show.
            onTimeout: () => throw ProcessException(
              'harness',
              arguments,
              'did not finish within ${runTimeout.inSeconds}s',
            ),
          )
          .then(_decodeWideBanner),
    );
  }

  /// wsl.exe writes its OWN failure banners (no WSL feature, a bad `-d` name, a
  /// distro that will not start) as UTF-16LE on redirected handles, while the
  /// CLI inside the distro writes UTF-8. A banner decoded as UTF-8 arrives
  /// NUL-riddled — and that is the recovery key: a string carrying NUL code
  /// units is re-checked by the UTF-16LE probe decoder and re-decoded when it
  /// really is wide. Non-ASCII banners the UTF-8 decode half-swallowed
  /// (U+FFFD replacement units) cannot be re-encoded, and are left as decoded.
  static ProcessResult _decodeWideBanner(ProcessResult result) {
    String fix(String text) {
      if (!text.contains('\u0000')) return text;
      final List<int> bytes;
      try {
        bytes = latin1.encode(text);
      } on ArgumentError {
        return text;
      }
      return Utf16LeProbeDecoder.looksUtf16Le(bytes)
          ? Utf16LeProbeDecoder.decodeUtf16LeBytes(bytes)
          : text;
    }

    return ProcessResult(
      result.pid,
      result.exitCode,
      fix(result.stdout),
      fix(result.stderr),
    );
  }

  /// Runs the CLI with a deadline and requests child termination when it expires.
  ///
  /// [run] cannot do this: `Process.run` gives no handle to kill, so a `harness`
  /// that never answers — a distro still booting, a CLI blocking on its own
  /// startup — left the first-run check waiting forever. On the managed and WSL
  /// paths that is a real child of ours, so termination is requested (exit code
  /// 124, the shell's timeout convention) rather than leaving an unbounded wait.
  ///
  /// An injected process hook (a test's fake) is used as-is: it is the caller's
  /// seam, and there is no real child to stop.
  Future<ProcessResult> runBounded(
    List<String> arguments, {
    Duration timeout = const Duration(seconds: 30),
  }) async {
    final invocation = await resolve(arguments);
    if (_runProcess != Process.run) {
      return logProcessRun(
        _displayLine(arguments),
        () => _runProcess(
          invocation.executable,
          invocation.arguments,
          environment: invocation.environment,
        ),
      );
    }
    return logProcessRun(
      _displayLine(arguments),
      () => runOwnedProcessBounded(
        executable: invocation.executable,
        arguments: invocation.arguments,
        startProcess: _startProcess,
        timeout: timeout,
        environment: invocation.environment,
      ).then(_decodeWideBanner),
    );
  }

  Future<Process> start(List<String> arguments) async {
    final invocation = await resolve(arguments);
    return logProcessStart(
      _displayLine(arguments),
      () => _startProcess(
        invocation.executable,
        invocation.arguments,
        environment: invocation.environment,
      ),
    );
  }

  /// The invocation as a person reads it — `harness auth status --json`.
  ///
  /// The [arguments] this was asked for, never [HarnessCliInvocation.arguments]:
  /// on the managed tier the real argv is `<node> <cli.js> …`, two absolute
  /// paths of noise in front of the only part that says what ran.
  static String _displayLine(List<String> arguments) =>
      'harness ${arguments.join(' ')}';

  Future<File?> _managedNode() async {
    try {
      final raw = (await _currentNodeFile.readAsString()).trim();
      if (raw.isEmpty) return null;
      // Windows accepts both separators, so `current-node` written with
      // forward slashes (or a home built with them) must not be rejected by
      // a comparison that assumes backslashes. Normalize both sides to the
      // host separator before the containment check; the file itself is
      // still opened with the path as written. This is the HOST's filesystem
      // reality, not the resolution tier — Platform, not _isWindows.
      String normalize(String path) =>
          Platform.isWindows ? path.replaceAll('/', Platform.pathSeparator) : path;
      final root = normalize(_runtimeDirectory.absolute.path);
      final rootWithSeparator = root.endsWith(Platform.pathSeparator)
          ? root
          : '$root${Platform.pathSeparator}';
      if (!normalize(raw).startsWith(rootWithSeparator)) return null;
      final node = File(raw);
      return await node.exists() ? node : null;
    } on FileSystemException {
      return null;
    }
  }

  String? _home() => resolveHomeDirectory(environment);

  Map<String, String> _commandEnvironment() {
    final home = _home();
    final launcherDirectory = home == null || home.isEmpty
        ? null
        : '$home${Platform.pathSeparator}.local${Platform.pathSeparator}bin';
    final path = environment['PATH'] ?? '';
    // PATH is ';'-separated on Windows. Joining with ':' there does not just fail to prepend the
    // launcher directory — it welds it onto the first real entry and destroys that one too.
    final pathSeparator = _isWindows ? ';' : ':';
    final commandEnvironment = <String, String>{
      ...environment,
      if (launcherDirectory != null)
        'PATH': path.isEmpty
            ? launcherDirectory
            : '$launcherDirectory$pathSeparator$path',
    };
    final configuredLocale =
        commandEnvironment['LC_ALL'] ??
        commandEnvironment['LC_CTYPE'] ??
        commandEnvironment['LANG'];
    if ((Platform.isMacOS || Platform.isLinux) &&
        (configuredLocale == null ||
            !RegExp(
              r'utf-?8',
              caseSensitive: false,
            ).hasMatch(configuredLocale))) {
      commandEnvironment['LC_ALL'] = 'C.UTF-8';
    }
    return commandEnvironment;
  }


}

enum HarnessCliSource { managed, launcher, path, wsl }

class HarnessCliInvocation {
  final String executable;
  final List<String> arguments;
  final Map<String, String> environment;
  final HarnessCliSource source;

  /// The WSL2 distro the CLI was found in, when [source] is
  /// [HarnessCliSource.wsl]. Null means the default distro.
  final String? wslDistro;

  const HarnessCliInvocation({
    required this.executable,
    required this.arguments,
    required this.environment,
    required this.source,
    this.wslDistro,
  });
}
