import 'dart:io';

import '../logging/cli_transcript.dart';

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
/// Behind that come the installed `~/.local/bin/harness` launcher and finally
/// bare `harness` on PATH, which cover a developer-managed install and the
/// window before the first provisioning run has finished.
class HarnessCliRunner {
  final Directory harnessHome;
  final Map<String, String> environment;
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

  HarnessCliRunner({
    Directory? harnessHome,
    Map<String, String>? environment,
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
  }) : environment = environment ?? Platform.environment,
       harnessHome = harnessHome ?? Directory(_defaultHarnessHome()),
       _runProcess = runProcess ?? Process.run,
       _startProcess = startProcess ?? Process.start;

  static String _defaultHarnessHome() {
    // HOME, then USERPROFILE: Windows sets only the latter, so a launch from Explorer threw here
    // before any UI existed to report it.
    final home = Platform.environment['HOME'];
    final profile = Platform.environment['USERPROFILE'];
    final resolved = home != null && home.isNotEmpty ? home : profile;
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

  Future<ProcessResult> run(List<String> arguments) async {
    final invocation = await resolve(arguments);
    return logProcessRun(
      _displayLine(arguments),
      () => _runProcess(
        invocation.executable,
        invocation.arguments,
        environment: invocation.environment,
      ),
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
      final runtimeRoot =
          '${_runtimeDirectory.absolute.path}${Platform.pathSeparator}';
      if (!raw.startsWith(runtimeRoot)) return null;
      final node = File(raw);
      return await node.exists() ? node : null;
    } on FileSystemException {
      return null;
    }
  }

  String? _home() {
    final home = environment['HOME'];
    if (home != null && home.isNotEmpty) return home;
    final profile = environment['USERPROFILE'];
    return profile != null && profile.isNotEmpty ? profile : null;
  }

  Map<String, String> _commandEnvironment() {
    final home = _home();
    final launcherDirectory = home == null || home.isEmpty
        ? null
        : '$home${Platform.pathSeparator}.local${Platform.pathSeparator}bin';
    final path = environment['PATH'] ?? '';
    // PATH is ';'-separated on Windows. Joining with ':' there does not just fail to prepend the
    // launcher directory — it welds it onto the first real entry and destroys that one too.
    final pathSeparator = Platform.isWindows ? ';' : ':';
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

enum HarnessCliSource { managed, launcher, path }

class HarnessCliInvocation {
  final String executable;
  final List<String> arguments;
  final Map<String, String> environment;
  final HarnessCliSource source;

  const HarnessCliInvocation({
    required this.executable,
    required this.arguments,
    required this.environment,
    required this.source,
  });
}
