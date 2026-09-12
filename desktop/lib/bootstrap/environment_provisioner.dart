import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../core/harness_cli_runner.dart';

/// The CLI-only installer contract for callers that already own host setup.
/// Desktop verifies system tools, the active Linux clipboard helper and tmux
/// before reaching this command, then performs its own complete verification
/// again after Harness lands.
const String kHarnessDesktopInstallCommand =
    'curl -fsSL https://cdn.autonomous.ai/harness/cli/install.sh | '
    '/bin/sh -s -- --desktop';

const int _linuxClockSyncFailureExitCode = 31;
const int _linuxAptUpdateFailureExitCode = 32;
const int _linuxAptInstallFailureExitCode = 33;
const String _linuxClockRepairCommand =
    'if command -v chronyc >/dev/null 2>&1; then '
    'sudo chronyc makestep; else sudo timedatectl set-ntp true && '
    'sudo systemctl restart systemd-timesyncd; fi';

enum EnvironmentStep {
  clipboard,
  harness,
  tmux;

  /// Harness Desktop is only ready when every command in this list works.
  bool get isRequired => true;
}

enum EnvironmentSetupPhase {
  preflight,
  review,
  chooseMethod,
  installing,
  waitingForTerminal,
  verifying,
  ready,
  failed,
}

enum EnvironmentSetupMode { automatic, manual }

/// Identifies which host setup owns a visible Terminal handoff. Linux can wait
/// on base/clipboard packages even when tmux itself is already ready, so a
/// resumed failure must not always be attributed to the tmux row.
enum EnvironmentTerminalSetup { linuxHost, tmux }

class EnvironmentFailure {
  final EnvironmentStep? step;
  final String title;
  final String detail;
  final String? command;
  final int? exitCode;

  const EnvironmentFailure({
    this.step,
    required this.title,
    required this.detail,
    this.command,
    this.exitCode,
  });
}

enum EnvironmentStepStatus {
  pending,
  running,
  ready,
  needsTerminal,
  failed,

  /// This host has no native clipboard to prepare (for example, headless
  /// Linux). Unlike [unavailable], this is a satisfied, non-blocking state.
  notApplicable,

  /// The host does not support this dependency. All current steps are required,
  /// so this status remains blocking.
  unavailable,
}

class EnvironmentReadiness {
  final Map<EnvironmentStep, EnvironmentStepStatus> steps;
  final String? message;
  final List<String> output;
  final EnvironmentSetupPhase phase;
  final EnvironmentSetupMode? mode;
  final EnvironmentFailure? failure;
  final String? terminalLogPath;
  final String? terminalResultPath;
  final EnvironmentTerminalSetup? terminalSetup;
  final bool systemReady;
  final bool? homebrewReady;
  final bool? tmuxBinaryReady;
  final List<String> missingLinuxPackages;

  const EnvironmentReadiness({
    required this.steps,
    this.message,
    this.output = const [],
    this.phase = EnvironmentSetupPhase.preflight,
    this.mode,
    this.failure,
    this.terminalLogPath,
    this.terminalResultPath,
    this.terminalSetup,
    this.systemReady = false,
    this.homebrewReady,
    this.tmuxBinaryReady,
    this.missingLinuxPackages = const [],
  });

  factory EnvironmentReadiness.initial() => EnvironmentReadiness(
    steps: {
      for (final step in EnvironmentStep.values)
        step: EnvironmentStepStatus.pending,
    },
  );

  bool get isReady =>
      systemReady &&
      steps.values.every(
        (status) =>
            status == EnvironmentStepStatus.ready ||
            status == EnvironmentStepStatus.notApplicable,
      );

  bool get needsTerminal =>
      phase == EnvironmentSetupPhase.waitingForTerminal ||
      steps.values.any(
        (status) => status == EnvironmentStepStatus.needsTerminal,
      );

  EnvironmentReadiness copyWith({
    Map<EnvironmentStep, EnvironmentStepStatus>? steps,
    String? message,
    List<String>? output,
    EnvironmentSetupPhase? phase,
    EnvironmentSetupMode? mode,
    EnvironmentFailure? failure,
    String? terminalLogPath,
    String? terminalResultPath,
    EnvironmentTerminalSetup? terminalSetup,
    bool? systemReady,
    bool? homebrewReady,
    bool? tmuxBinaryReady,
    List<String>? missingLinuxPackages,
    bool clearFailure = false,
    bool clearTerminalHandoff = false,
  }) => EnvironmentReadiness(
    steps: steps ?? this.steps,
    message: message ?? this.message,
    output: output ?? this.output,
    phase: phase ?? this.phase,
    mode: mode ?? this.mode,
    failure: clearFailure ? null : failure ?? this.failure,
    terminalLogPath: clearTerminalHandoff
        ? null
        : terminalLogPath ?? this.terminalLogPath,
    terminalResultPath: clearTerminalHandoff
        ? null
        : terminalResultPath ?? this.terminalResultPath,
    terminalSetup: clearTerminalHandoff
        ? null
        : terminalSetup ?? this.terminalSetup,
    systemReady: systemReady ?? this.systemReady,
    homebrewReady: homebrewReady ?? this.homebrewReady,
    tmuxBinaryReady: tmuxBinaryReady ?? this.tmuxBinaryReady,
    missingLinuxPackages: missingLinuxPackages ?? this.missingLinuxPackages,
  );
}

typedef ProcessRunner = Future<ProcessResult> Function(
  String executable,
  List<String> arguments, {
  Map<String, String>? environment,
});

typedef TerminalLauncher = Future<void> Function(String scriptPath);

typedef ProcessStarter = Future<Process> Function(
  String executable,
  List<String> arguments, {
  Map<String, String>? environment,
});

/// The progress callback `ensureReady` builds for itself, named so the per-host paths below can be
/// separate methods rather than one very long function.
typedef EmitStep = void Function({
  EnvironmentStep? step,
  EnvironmentStepStatus? status,
  String? message,
  String? output,
});

Future<ProcessResult> _defaultRun(
  String executable,
  List<String> arguments, {
  Map<String, String>? environment,
}) => Process.run(executable, arguments, environment: environment);

Future<Process> _defaultStart(
  String executable,
  List<String> arguments, {
  Map<String, String>? environment,
}) => Process.start(executable, arguments, environment: environment);

/// macOS opens a real Terminal.app window. Linux has no single canonical
/// terminal, so this tries the Debian/Ubuntu `update-alternatives` target
/// first, then the two most common emulators, and gives up only if none of
/// them exist on the box.
Future<void> _defaultOpenTerminal(String scriptPath) async {
  if (Platform.isMacOS) {
    await Process.start('/usr/bin/open', ['-a', 'Terminal', scriptPath]);
    return;
  }
  final candidates = <List<String>>[
    ['x-terminal-emulator', '-e', scriptPath],
    ['gnome-terminal', '--', scriptPath],
    ['xterm', '-e', scriptPath],
  ];
  for (final candidate in candidates) {
    try {
      await Process.start(candidate.first, candidate.skip(1).toList());
      return;
    } on ProcessException {
      continue;
    }
  }
  throw StateError(
    'Could not find a terminal emulator to launch (tried x-terminal-emulator, '
    'gnome-terminal, xterm)',
  );
}

/// Prepares the only system dependencies required by the desktop transport.
///
/// Node lives beneath [harnessHome] rather than in Homebrew/nvm/PATH. The
/// CLI launcher is written against that exact binary, so launching Harness
/// from Finder and from Terminal has identical runtime behavior.
class EnvironmentProvisioner {
  final Directory harnessHome;
  final ProcessRunner _run;
  final ProcessStarter? _start;
  final TerminalLauncher _openTerminal;
  final bool _isMacOS;
  final bool _isLinux;
  final bool _isWindows;
  final bool _forceMissingAppleDeveloperTools;
  final Map<String, String> _platformEnvironment;

  EnvironmentProvisioner({
    Directory? harnessHome,
    ProcessRunner? run,
    ProcessStarter? start,
    TerminalLauncher? openTerminal,
    bool? isMacOS,
    bool? isLinux,
    bool? isWindows,
    bool? forceMissingAppleDeveloperTools,
    Map<String, String>? platformEnvironment,
  }) : harnessHome = harnessHome ?? Directory(_defaultHarnessHome()),
       _run = run ?? _defaultRun,
       _start = start ?? (run == null ? _defaultStart : null),
       _openTerminal = openTerminal ?? _defaultOpenTerminal,
       _isMacOS = isMacOS ?? Platform.isMacOS,
       _isLinux = isLinux ?? Platform.isLinux,
       _isWindows = isWindows ?? Platform.isWindows,
       _platformEnvironment = platformEnvironment ?? Platform.environment,
       _forceMissingAppleDeveloperTools =
           forceMissingAppleDeveloperTools ??
           const bool.fromEnvironment(
             'HARNESS_DESKTOP_FORCE_MISSING_APPLE_DEVELOPER_TOOLS',
           );

  /// HOME, then USERPROFILE. Windows sets only the latter, so a launch from Explorer used to throw
  /// out of this constructor before a single frame could render.
  static String? userHome() {
    final home = Platform.environment['HOME'];
    if (home != null && home.isNotEmpty) return home;
    final profile = Platform.environment['USERPROFILE'];
    if (profile != null && profile.isNotEmpty) return profile;
    return null;
  }

  static String _defaultHarnessHome() {
    final home = userHome();
    if (home == null) {
      throw StateError('Could not resolve the current user home directory');
    }
    return '$home${Platform.pathSeparator}.harness';
  }

  /// Checks the complete environment, and mutates it only when [install] is explicitly true.
  Future<EnvironmentReadiness> ensureReady({
    required void Function(EnvironmentReadiness value) onProgress,
    EnvironmentReadiness? resumeFrom,
    bool install = true,
    EnvironmentSetupMode? mode,
  }) async {
    final retryingFailedSetup =
        install && resumeFrom?.phase == EnvironmentSetupPhase.failed;
    var state = (resumeFrom ?? EnvironmentReadiness.initial()).copyWith(
      phase: install
          ? EnvironmentSetupPhase.installing
          : EnvironmentSetupPhase.preflight,
      mode: mode,
      clearFailure: true,
      clearTerminalHandoff: retryingFailedSetup,
    );
    void emit({
      EnvironmentStep? step,
      EnvironmentStepStatus? status,
      String? message,
      String? output,
      EnvironmentSetupPhase? phase,
      EnvironmentFailure? failure,
      String? terminalLogPath,
      String? terminalResultPath,
      EnvironmentTerminalSetup? terminalSetup,
      bool? systemReady,
      bool? homebrewReady,
      bool? tmuxBinaryReady,
      List<String>? missingLinuxPackages,
    }) {
      final next = Map<EnvironmentStep, EnvironmentStepStatus>.from(
        state.steps,
      );
      if (step != null && status != null) next[step] = status;
      final lines = [...state.output];
      if (output != null && output.trim().isNotEmpty) {
        if (output.startsWith('Terminal log:\n')) {
          lines.removeWhere((line) => line.startsWith('Terminal log:\n'));
        }
        lines.add(output.trim());
        if (lines.length > 200) lines.removeRange(0, lines.length - 200);
      }
      state = EnvironmentReadiness(
        steps: next,
        message: message ?? state.message,
        output: lines,
        phase: phase ?? state.phase,
        mode: mode ?? state.mode,
        failure: failure ?? state.failure,
        terminalLogPath: terminalLogPath ?? state.terminalLogPath,
        terminalResultPath: terminalResultPath ?? state.terminalResultPath,
        terminalSetup: terminalSetup ?? state.terminalSetup,
        systemReady: systemReady ?? state.systemReady,
        homebrewReady: homebrewReady ?? state.homebrewReady,
        tmuxBinaryReady: tmuxBinaryReady ?? state.tmuxBinaryReady,
        missingLinuxPackages:
            missingLinuxPackages ?? state.missingLinuxPackages,
      );
      onProgress(state);
    }

    final previousTerminalLog = state.terminalLogPath;
    var previousTerminalLogText = '';
    EnvironmentTerminalSetup? completedTerminalSetup;
    if (previousTerminalLog != null) {
      try {
        final text = await File(previousTerminalLog).readAsString();
        previousTerminalLogText = text;
        final snapshot = 'Terminal log:\n${text.trim()}';
        if (text.trim().isNotEmpty && !state.output.contains(snapshot)) {
          emit(output: snapshot);
        }
      } on FileSystemException {
        // The terminal may not have created its log yet.
      }
    }
    final previousTerminalResult = state.terminalResultPath;
    var terminalResultPending = false;
    if (previousTerminalResult != null) {
      if (!await File(previousTerminalResult).exists()) {
        terminalResultPending = true;
        // `terminal.exit` is a handoff hint, not the source of truth. Some
        // Linux terminal emulators keep the launched shell/window alive after
        // apt has already finished, and an interrupted EXIT trap can omit the
        // file entirely. Continue into the read-only command probes below so
        // the 5-second poll (and the user's Recheck button) can observe that
        // the host is actually ready instead of waiting forever for a file a
        // cold app launch does not need either.
        emit(
          message: state.message ?? 'Complete the visible prompts in Terminal.',
          phase: EnvironmentSetupPhase.waitingForTerminal,
        );
      }
      try {
        final exitCode = int.tryParse(
          (await File(previousTerminalResult).readAsString()).trim(),
        );
        if (exitCode != null && exitCode != 0) {
          final linuxHost =
              state.terminalSetup == EnvironmentTerminalSetup.linuxHost;
          final clipboardFailed =
              linuxHost &&
              state.steps[EnvironmentStep.clipboard] ==
                  EnvironmentStepStatus.needsTerminal;
          final tmuxFailed =
              state.steps[EnvironmentStep.tmux] ==
              EnvironmentStepStatus.needsTerminal;
          if (clipboardFailed) {
            emit(
              step: EnvironmentStep.clipboard,
              status: EnvironmentStepStatus.failed,
            );
          }
          if (tmuxFailed) {
            emit(
              step: EnvironmentStep.tmux,
              status: EnvironmentStepStatus.failed,
            );
          }
          final classifiedFailure = linuxHost
              ? _classifiedLinuxPackageFailure(
                  exitCode,
                  previousTerminalLogText,
                )
              : null;
          emit(
            step: linuxHost ? null : EnvironmentStep.tmux,
            status: linuxHost ? null : EnvironmentStepStatus.failed,
            message: 'The Terminal setup exited with code $exitCode.',
            phase: EnvironmentSetupPhase.failed,
            failure: EnvironmentFailure(
              step: !linuxHost
                  ? EnvironmentStep.tmux
                  : !state.systemReady
                  ? null
                  : clipboardFailed
                  ? EnvironmentStep.clipboard
                  : tmuxFailed
                  ? EnvironmentStep.tmux
                  : null,
              title:
                  classifiedFailure?.title ??
                  'System package installation failed',
              detail:
                  classifiedFailure?.detail ??
                  'Terminal exited with code $exitCode. Review the complete log below.',
              command:
                  classifiedFailure?.command ??
                  (linuxHost
                      ? await _linuxHostManualCommand()
                      : _manualCommandFor(EnvironmentStep.tmux)),
              exitCode: exitCode,
            ),
          );
          return state;
        }
        if (exitCode == 0) completedTerminalSetup = state.terminalSetup;
      } on FileSystemException {
        // The result can disappear between exists() and readAsString(). The
        // live dependency probes below remain the authoritative fallback.
      }
    }
    onProgress(state);

    if (!_isMacOS && !_isLinux) {
      if (_isWindows) {
        await _verifyWindows(emit);
        return state;
      }
      emit(
        step: EnvironmentStep.harness,
        status: EnvironmentStepStatus.failed,
        message: 'Automatic environment setup is currently available on macOS and Linux only.',
        phase: EnvironmentSetupPhase.failed,
      );
      return state;
    }

    try {
      var linuxMissingBasePackages = <String>[];
      String? linuxMissingClipboardPackage;
      EnvironmentFailure? systemFailure;
      if (_isMacOS) {
        systemFailure = await _systemPreflightFailure();
      } else {
        if (!await _hasWritableHome()) {
          systemFailure = const EnvironmentFailure(
            title: 'Home directory is not writable',
            detail: 'Harness needs to write ~/.harness and ~/.local/bin.',
          );
        } else {
          linuxMissingBasePackages = await _missingLinuxBasePackages();
          linuxMissingClipboardPackage = await _missingLinuxClipboardPackage();
        }
      }
      if (systemFailure != null) {
        emit(
          message: systemFailure.detail,
          phase: EnvironmentSetupPhase.failed,
          failure: systemFailure,
        );
        return state;
      }
      var systemReady = _isMacOS
          ? await _hasAppleDeveloperTools()
          : linuxMissingBasePackages.isEmpty;
      emit(
        systemReady: systemReady,
        missingLinuxPackages: _isLinux
            ? <String>[
                ...linuxMissingBasePackages,
                ?linuxMissingClipboardPackage,
              ]
            : const [],
        output: systemReady
            ? '✓ required system tools · writable home'
            : _isMacOS
            ? '✗ Apple developer tools · xcrun --find clang'
            : '✗ missing Linux base packages · ${linuxMissingBasePackages.join(', ')}',
      );

      final clipboardApplicable = _isLinux && _linuxClipboardCommand() != null;
      var clipboardReady =
          !clipboardApplicable || linuxMissingClipboardPackage == null;
      emit(
        step: EnvironmentStep.clipboard,
        status: clipboardApplicable
            ? clipboardReady
                  ? EnvironmentStepStatus.ready
                  : EnvironmentStepStatus.failed
            : EnvironmentStepStatus.notApplicable,
        message: clipboardApplicable
            ? clipboardReady
                  ? 'Native image clipboard is ready.'
                  : '$linuxMissingClipboardPackage is required for native image paste.'
            : _isLinux
            ? 'Native image clipboard is not applicable on a headless Linux host.'
            : null,
        output: clipboardApplicable
            ? clipboardReady
                  ? '✓ native image clipboard · ${_linuxClipboardCommand()}'
                  : '✗ native image clipboard · $linuxMissingClipboardPackage'
            : _isLinux
            ? '– native image clipboard N/A (headless)'
            : null,
      );

      final homebrewReady = !_isMacOS || await _hasHomebrew();
      var tmuxBinaryReady = await _hasTmux();
      var tmuxReady =
          tmuxBinaryReady && (!_isMacOS || (homebrewReady && systemReady));
      emit(
        step: EnvironmentStep.tmux,
        status: tmuxReady
            ? EnvironmentStepStatus.ready
            : EnvironmentStepStatus.failed,
        message: tmuxReady
            ? (_isMacOS ? 'Homebrew and tmux are ready.' : 'tmux is ready.')
            : _isMacOS && !systemReady
            ? 'Apple developer tools are required.'
            : _isMacOS && !homebrewReady
            ? 'Homebrew is required.'
            : 'tmux is required.',
        output: tmuxReady
            ? (_isMacOS ? '✓ Homebrew · tmux --version' : '✓ tmux --version')
            : _isMacOS && !systemReady
            ? '✗ Apple developer tools · xcrun --find clang'
            : _isMacOS && !homebrewReady
            ? '✗ Homebrew · brew --version'
            : '✗ tmux --version',
        homebrewReady: _isMacOS ? homebrewReady : null,
        tmuxBinaryReady: tmuxBinaryReady,
      );

      final harnessReady = await _hasHarness();
      emit(
        step: EnvironmentStep.harness,
        status: harnessReady
            ? EnvironmentStepStatus.ready
            : EnvironmentStepStatus.failed,
        message: harnessReady
            ? 'Harness CLI and managed Node are ready.'
            : 'Harness CLI or its managed Node runtime is missing.',
        output: harnessReady
            ? '✓ managed Node >= 20 · harness version'
            : '✗ managed Node >= 20 · harness version',
      );

      if (state.isReady) {
        emit(
          message: 'All required tools passed verification.',
          phase: EnvironmentSetupPhase.ready,
        );
        return state;
      }

      if (!install) {
        final linuxMissingPackages = <String>[
          ...linuxMissingBasePackages,
          ?linuxMissingClipboardPackage,
        ];
        if (terminalResultPending &&
            (!systemReady || !clipboardReady || !tmuxReady)) {
          emit(
            message:
                state.message ?? 'Complete the visible prompts in Terminal.',
            phase: EnvironmentSetupPhase.waitingForTerminal,
          );
          return state;
        }
        if (completedTerminalSetup == EnvironmentTerminalSetup.linuxHost &&
            (linuxMissingPackages.isNotEmpty || !tmuxBinaryReady)) {
          emit(
            message: 'The Linux host dependency install finished, but verification still found missing packages.',
            phase: EnvironmentSetupPhase.failed,
            failure: EnvironmentFailure(
              step: !systemReady
                  ? null
                  : linuxMissingClipboardPackage != null
                  ? EnvironmentStep.clipboard
                  : EnvironmentStep.tmux,
              title: 'Host dependency verification failed',
              detail:
                  'Still missing: ${[...linuxMissingPackages, if (!tmuxBinaryReady) 'tmux'].join(', ')}. Review the Terminal log, then retry when ready.',
              command: await _linuxHostManualCommand(),
            ),
          );
          return state;
        }
        emit(
          message: _isLinux && linuxMissingPackages.isNotEmpty
              ? 'Linux host packages required: ${linuxMissingPackages.join(', ')}.'
              : 'Review what Harness will install before continuing.',
          phase: EnvironmentSetupPhase.review,
        );
        return state;
      }

      // Strict dependency order: one host-package transaction (base tools,
      // tmux and the active clipboard helper) -> managed Node/Harness.
      if (_isLinux && (!systemReady || !clipboardReady || !tmuxBinaryReady)) {
        var packages = <String>{
          ...linuxMissingBasePackages,
          ?linuxMissingClipboardPackage,
          if (!tmuxBinaryReady) 'tmux',
        }.toList();
        if (!await _hasAptGet()) {
          final command = await _linuxHostManualCommand();
          emit(
            message: 'Automatic Linux package installation supports apt-based distributions only.',
            phase: EnvironmentSetupPhase.failed,
            failure: EnvironmentFailure(
              title: 'Unsupported Linux package manager',
              detail:
                  'Install ${packages.join(', ')} with this distribution\'s package manager, then recheck.',
              command: command,
            ),
          );
          return state;
        }

        ProcessResult? backgroundInstall;
        if (await _canInstallAptUnattended()) {
          if (linuxMissingClipboardPackage != null) {
            emit(
              step: EnvironmentStep.clipboard,
              status: EnvironmentStepStatus.running,
            );
          }
          emit(
            step: tmuxBinaryReady ? null : EnvironmentStep.tmux,
            status: tmuxBinaryReady ? null : EnvironmentStepStatus.running,
            message: 'Installing Linux system packages…',
          );
          try {
            backgroundInstall = await _shellStreaming(
              _linuxAptInstallCommand(packages, nonInteractiveSudo: true),
              onOutput: (line) => emit(
                message:
                    line.contains('Enabling automatic time synchronization')
                    ? 'Synchronizing the system clock before retrying Ubuntu packages…'
                    : null,
                output: line,
              ),
            );
          } catch (error) {
            emit(output: 'Background Linux package install failed: $error');
          }

          linuxMissingBasePackages = await _missingLinuxBasePackages();
          linuxMissingClipboardPackage = await _missingLinuxClipboardPackage();
          systemReady = linuxMissingBasePackages.isEmpty;
          clipboardReady =
              !clipboardApplicable || linuxMissingClipboardPackage == null;
          tmuxBinaryReady = await _hasTmux();
          tmuxReady = tmuxBinaryReady;
          emit(
            step: EnvironmentStep.clipboard,
            status: clipboardApplicable
                ? clipboardReady
                      ? EnvironmentStepStatus.ready
                      : EnvironmentStepStatus.failed
                : EnvironmentStepStatus.notApplicable,
            missingLinuxPackages: <String>[
              ...linuxMissingBasePackages,
              ?linuxMissingClipboardPackage,
            ],
            tmuxBinaryReady: tmuxBinaryReady,
          );
          final classifiedBackgroundFailure = backgroundInstall == null
              ? null
              : _classifiedLinuxPackageFailure(
                  backgroundInstall.exitCode,
                  _resultText(backgroundInstall),
                );
          if (classifiedBackgroundFailure != null) {
            if (!tmuxReady) {
              emit(
                step: EnvironmentStep.tmux,
                status: EnvironmentStepStatus.failed,
              );
            }
            emit(
              message: classifiedBackgroundFailure.detail,
              phase: EnvironmentSetupPhase.failed,
              systemReady: systemReady,
              failure: EnvironmentFailure(
                step: !systemReady
                    ? null
                    : !clipboardReady
                    ? EnvironmentStep.clipboard
                    : !tmuxReady
                    ? EnvironmentStep.tmux
                    : null,
                title: classifiedBackgroundFailure.title,
                detail: classifiedBackgroundFailure.detail,
                command: classifiedBackgroundFailure.command,
                exitCode: classifiedBackgroundFailure.exitCode,
              ),
            );
            return state;
          }
          if (systemReady && clipboardReady && tmuxReady) {
            emit(
              step: EnvironmentStep.tmux,
              status: EnvironmentStepStatus.ready,
              message: 'Linux system packages and tmux are ready.',
              output: '✓ Linux host dependencies installed and verified',
              systemReady: true,
              tmuxBinaryReady: true,
              missingLinuxPackages: const [],
            );
          } else {
            if (backgroundInstall != null) {
              emit(
                output: backgroundInstall.exitCode == 0
                    ? 'apt finished, but Linux host dependencies did not pass verification.'
                    : 'Background apt install exited ${backgroundInstall.exitCode}: '
                          '${_resultText(backgroundInstall)}',
              );
            }
            packages = <String>{
              ...linuxMissingBasePackages,
              ?linuxMissingClipboardPackage,
              if (!tmuxBinaryReady) 'tmux',
            }.toList();
          }
        }

        if (!systemReady || !clipboardReady || !tmuxReady) {
          final terminal = await _launchLinuxHostSetup(packages);
          if (linuxMissingClipboardPackage != null) {
            emit(
              step: EnvironmentStep.clipboard,
              status: EnvironmentStepStatus.needsTerminal,
            );
          }
          if (!tmuxReady) {
            emit(
              step: EnvironmentStep.tmux,
              status: EnvironmentStepStatus.needsTerminal,
            );
          }
          emit(
            message: 'Complete the visible Linux package prompts in Terminal. Harness never sees your password.',
            output: backgroundInstall == null
                ? 'Terminal opened to install Linux host dependencies.'
                : 'Background install was incomplete; Terminal opened to finish Linux host dependencies.',
            phase: EnvironmentSetupPhase.waitingForTerminal,
            terminalLogPath: terminal.log.path,
            terminalResultPath: terminal.result.path,
            terminalSetup: EnvironmentTerminalSetup.linuxHost,
            systemReady: systemReady,
          );
          return state;
        }
      }

      if (_isMacOS && systemReady && homebrewReady && !tmuxBinaryReady) {
        emit(
          step: EnvironmentStep.tmux,
          status: EnvironmentStepStatus.running,
          message: 'Installing tmux via Homebrew…',
        );
        ProcessResult? installResult;
        try {
          installResult = await _shellStreaming(
            'brew install tmux',
            onOutput: (line) => emit(output: line),
          );
        } catch (error) {
          emit(output: 'Background tmux install failed: $error');
        }
        tmuxReady = installResult?.exitCode == 0 && await _hasTmux();
        if (tmuxReady) {
          emit(
            step: EnvironmentStep.tmux,
            status: EnvironmentStepStatus.ready,
            message: 'Homebrew and tmux are ready.',
            output: '✓ tmux installed via Homebrew',
            homebrewReady: true,
            tmuxBinaryReady: true,
          );
        } else {
          if (installResult != null) {
            emit(
              output: installResult.exitCode == 0
                  ? 'Homebrew finished, but tmux did not pass verification.'
                  : 'Background tmux install exited ${installResult.exitCode}: '
                        '${_resultText(installResult)}',
            );
          }
          emit(
            step: EnvironmentStep.tmux,
            status: EnvironmentStepStatus.running,
            message: 'tmux needs attention in Terminal…',
          );
          final terminal = await _launchTmuxSetup();
          emit(
            step: EnvironmentStep.tmux,
            status: EnvironmentStepStatus.needsTerminal,
            message: 'Complete the visible Homebrew prompts in Terminal. Harness never sees your password.',
            output: 'Background install failed; Terminal opened to retry tmux.',
            phase: EnvironmentSetupPhase.waitingForTerminal,
            terminalLogPath: terminal.log.path,
            terminalResultPath: terminal.result.path,
            terminalSetup: EnvironmentTerminalSetup.tmux,
          );
          return state;
        }
      } else if (!tmuxReady) {
        emit(
          step: EnvironmentStep.tmux,
          status: EnvironmentStepStatus.running,
          message: 'Preparing tmux in a secure terminal…',
        );
        final terminal = await _launchTmuxSetup();
        emit(
          step: EnvironmentStep.tmux,
          status: EnvironmentStepStatus.needsTerminal,
          message: 'Complete any password or macOS prompts in Terminal. Harness never sees your password.',
          output: _isMacOS
              ? 'Terminal opened to install Homebrew and tmux.'
              : 'Terminal opened to install tmux.',
          phase: EnvironmentSetupPhase.waitingForTerminal,
          terminalLogPath: terminal.log.path,
          terminalResultPath: terminal.result.path,
          terminalSetup: EnvironmentTerminalSetup.tmux,
        );
        return state;
      }

      if (!harnessReady) {
        emit(
          step: EnvironmentStep.harness,
          status: EnvironmentStepStatus.running,
          message: 'Installing managed Node and Harness CLI…',
        );
        await _ensureHarness((line) => emit(output: line));
        emit(
          step: EnvironmentStep.harness,
          status: EnvironmentStepStatus.ready,
          output: '✓ Harness CLI ready',
        );
      }

      emit(
        message: 'Verifying every required command…',
        phase: EnvironmentSetupPhase.verifying,
      );
      if (_isLinux) {
        final missingBase = await _missingLinuxBasePackages();
        final missingClipboard = await _missingLinuxClipboardPackage();
        final writableHome = await _hasWritableHome();
        if (missingBase.isNotEmpty ||
            missingClipboard != null ||
            !writableHome) {
          if (missingClipboard != null) {
            emit(
              step: EnvironmentStep.clipboard,
              status: EnvironmentStepStatus.failed,
            );
          }
          emit(
            message:
                'Linux system dependencies did not pass final verification.',
            phase: EnvironmentSetupPhase.failed,
            systemReady: writableHome && missingBase.isEmpty,
            failure: EnvironmentFailure(
              title: 'Linux system verification failed',
              detail: !writableHome
                  ? 'The home directory is not writable.'
                  : 'Still missing packages: ${[...missingBase, ?missingClipboard].join(', ')}',
              command: await _linuxHostManualCommand(),
            ),
          );
          return state;
        }
      }
      final finalChecks = <EnvironmentStep, Future<bool> Function()>{
        EnvironmentStep.tmux: _isTmuxEnvironmentReady,
        EnvironmentStep.harness: _hasHarness,
      };
      for (final entry in finalChecks.entries) {
        if (!await entry.value()) {
          emit(step: entry.key, status: EnvironmentStepStatus.failed);
          throw StateError(
            '${entry.key.name} did not pass final version verification.',
          );
        }
      }
      emit(message: 'Environment ready.', phase: EnvironmentSetupPhase.ready);
      return state;
    } catch (error) {
      final failed =
          state.steps.entries
              .where((entry) => entry.value == EnvironmentStepStatus.running)
              .map((entry) => entry.key)
              .firstOrNull ??
          state.steps.entries
              .where((entry) => entry.value == EnvironmentStepStatus.failed)
              .map((entry) => entry.key)
              .firstOrNull;
      emit(
        step: failed,
        status: EnvironmentStepStatus.failed,
        message: 'Environment setup failed: $error',
        phase: EnvironmentSetupPhase.failed,
        failure: EnvironmentFailure(
          step: failed,
          title: 'Setup could not finish',
          detail: '$error',
          command: failed == null ? null : _manualCommandFor(failed),
        ),
      );
      return state;
    }
  }

  /// Windows gets a VERIFY pass rather than the install pass above.
  ///
  /// Every installer this class drives is a POSIX shell script — `install.sh` piped into `/bin/sh`,
  /// a `zsh`/`bash` login shell for each probe, `brew`, `apt-get` — and none of it exists here. So
  /// instead of refusing to boot a Windows box that is in fact provisioned, this checks what is
  /// actually on it and names the command for whatever is missing. Windows packaging remains out
  /// of scope for this release.
  Future<void> _verifyWindows(EmitStep emit) async {
    emit(
      step: EnvironmentStep.clipboard,
      status: EnvironmentStepStatus.notApplicable,
    );
    emit(
      step: EnvironmentStep.harness,
      status: EnvironmentStepStatus.running,
      message: 'Checking the Harness CLI…',
    );
    var harnessReady = false;
    try {
      final runner = HarnessCliRunner(
        harnessHome: harnessHome,
        runProcess: _run,
      );
      final status = await runner.run(['auth', 'status', '--json']);
      harnessReady =
          status.exitCode == 0 && (status.stdout as String).trim().isNotEmpty;
    } on ProcessException {
      harnessReady = false;
    } on StateError {
      // No managed node/cli.js pair recorded under ~/.harness yet.
      harnessReady = false;
    }
    if (!harnessReady) {
      emit(
        step: EnvironmentStep.harness,
        status: EnvironmentStepStatus.failed,
        message:
            'The Harness CLI is not installed for this user. There is no Windows installer yet — '
            'from a checkout of the CLI run: npm install && npm run bundle && '
            'bash scripts/install-cli.sh — then click Recheck.',
      );
      return;
    }
    emit(
      step: EnvironmentStep.harness,
      status: EnvironmentStepStatus.ready,
      output: 'Harness CLI ready',
    );

    emit(
      step: EnvironmentStep.tmux,
      status: EnvironmentStepStatus.unavailable,
      output:
          'tmux does not exist on Windows — terminals come from Herdr instead.',
    );
  }

  Future<EnvironmentFailure?> _systemPreflightFailure() async {
    final tools = _isMacOS
        ? 'command -v sh zsh bash curl tar sed awk shasum >/dev/null'
        : 'command -v sh bash curl tar sed awk sha256sum >/dev/null';
    final base = await _shell(tools);
    if (base.exitCode != 0) {
      return EnvironmentFailure(
        title: 'Required system tools are missing',
        detail: _resultText(base).isEmpty
            ? 'Harness needs curl, tar, sed, awk, checksum tools and a POSIX shell.'
            : _resultText(base),
        command: _isMacOS
            ? 'xcode-select --install'
            : 'sudo apt-get install -y bash curl tar sed gawk coreutils',
      );
    }
    if (!await _hasWritableHome()) {
      return const EnvironmentFailure(
        title: 'Home directory is not writable',
        detail: 'Harness needs to write ~/.harness and ~/.local/bin.',
      );
    }
    return null;
  }

  Future<bool> _hasWritableHome() async {
    final writable = await _shell('test -w "\$HOME"');
    return writable.exitCode == 0;
  }

  /// Base packages the desktop needs before it can hand host setup to the
  /// CLI-only installer. Native clipboard support is reported separately so
  /// the UI can explain it without creating a second install transaction.
  Future<List<String>> _missingLinuxBasePackages() async {
    if (!_isLinux) return const [];
    const commandPackages = <String, String>{
      'sh': 'dash',
      'bash': 'bash',
      'curl': 'curl',
      'tar': 'tar',
      'sed': 'sed',
      'awk': 'gawk',
      'sha256sum': 'coreutils',
    };
    final missing = <String>[];
    for (final entry in commandPackages.entries) {
      final probe = await _shell('command -v ${entry.key} >/dev/null 2>&1');
      if (probe.exitCode != 0) missing.add(entry.value);
    }
    return missing.toSet().toList();
  }

  /// Clipboard selection intentionally matches osClipboard.ts: Wayland wins
  /// when both display variables exist, X11 is the fallback, and a headless
  /// machine has no native clipboard requirement to satisfy.
  Future<String?> _missingLinuxClipboardPackage() async {
    if (!_isLinux) return null;
    final clipboardCommand = _linuxClipboardCommand();
    final clipboardPackage = _linuxClipboardPackage();
    if (clipboardCommand != null && clipboardPackage != null) {
      final probe = await _shell(
        'command -v $clipboardCommand >/dev/null 2>&1',
      );
      if (probe.exitCode != 0) return clipboardPackage;
    }
    return null;
  }

  Future<List<String>> _missingLinuxHostPackages() async {
    final packages = <String>{...await _missingLinuxBasePackages()};
    final clipboard = await _missingLinuxClipboardPackage();
    if (clipboard != null) packages.add(clipboard);
    return packages.toList();
  }

  String? _linuxClipboardCommand() {
    if (!_isLinux) return null;
    if ((_platformEnvironment['WAYLAND_DISPLAY'] ?? '').isNotEmpty) {
      return 'wl-copy';
    }
    if ((_platformEnvironment['DISPLAY'] ?? '').isNotEmpty) return 'xclip';
    return null;
  }

  String? _linuxClipboardPackage() => switch (_linuxClipboardCommand()) {
    'wl-copy' => 'wl-clipboard',
    'xclip' => 'xclip',
    _ => null,
  };

  Future<bool> _hasAptGet() async {
    final result = await _shell('command -v apt-get >/dev/null 2>&1');
    return result.exitCode == 0;
  }

  Future<bool> _canInstallAptUnattended() async {
    final user = await _shell('id -u');
    if (user.exitCode == 0 && '${user.stdout}'.trim() == '0') return true;
    final sudo = await _shell(
      'command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1',
    );
    return sudo.exitCode == 0;
  }

  bool _isLinuxClockSkewOutput(String output) {
    final normalized = output.toLowerCase();
    return normalized.contains('is not valid yet') ||
        normalized.contains('certificate is not yet valid');
  }

  EnvironmentFailure? _classifiedLinuxPackageFailure(
    int exitCode,
    String output,
  ) {
    if (exitCode == _linuxClockSyncFailureExitCode ||
        _isLinuxClockSkewOutput(output)) {
      return const EnvironmentFailure(
        title: 'System clock could not be synchronized',
        detail: 'Ubuntu reports that repository metadata is in the future relative to this computer. Enable automatic time synchronization, confirm the clock is correct, then retry.',
        command: _linuxClockRepairCommand,
        exitCode: _linuxClockSyncFailureExitCode,
      );
    }
    if (exitCode == _linuxAptUpdateFailureExitCode) {
      return const EnvironmentFailure(
        title: 'Package repository refresh failed',
        detail: 'Ubuntu could not refresh its package indexes, so Harness stopped instead of retrying with stale package data.',
        command: 'sudo apt-get update',
        exitCode: _linuxAptUpdateFailureExitCode,
      );
    }
    return null;
  }

  String _linuxAptInstallCommand(
    List<String> packages, {
    required bool nonInteractiveSudo,
  }) {
    final names = packages.toSet().join(' ');
    final sudoFlag = nonInteractiveSudo ? '-n ' : '';
    return '''set -o pipefail
export LC_ALL=C
run_as_root() {
  if [ "\$(id -u)" -eq 0 ]; then
    "\$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo $sudoFlag"\$@"
  else
    echo 'Installing Linux system packages needs root access, but sudo is unavailable.' >&2
    return 126
  fi
}
apt_as_root() {
  run_as_root env DEBIAN_FRONTEND=noninteractive apt-get "\$@"
}
repair_system_clock() {
  if command -v chronyc >/dev/null 2>&1; then
    echo 'Repository metadata is ahead of this computer. Enabling automatic time synchronization with chrony…'
    run_as_root chronyc online >/dev/null 2>&1 || true
    run_as_root chronyc burst 4/4 >/dev/null 2>&1 || true
    clock_attempt=0
    while :; do
      chrony_tracking="\$(chronyc tracking 2>/dev/null || true)"
      if printf '%s\n' "\$chrony_tracking" | grep -Eq 'Leap status[[:space:]]*:[[:space:]]*Normal'; then
        if run_as_root chronyc makestep; then
          echo 'System clock stepped with chrony.'
          return 0
        fi
        echo 'chrony has a synchronized source but could not step the system clock.' >&2
        break
      fi
      clock_attempt=\$((clock_attempt + 1))
      if [ "\$clock_attempt" -ge 15 ]; then
        echo 'chrony did not obtain a synchronized source within 30 seconds.' >&2
        break
      fi
      sleep 2
    done
  fi
  if ! command -v timedatectl >/dev/null 2>&1; then
    echo 'System clock is behind repository metadata, but no usable time synchronization service was found.' >&2
    return $_linuxClockSyncFailureExitCode
  fi
  echo 'Repository metadata is ahead of this computer. Enabling automatic time synchronization…'
  run_as_root timedatectl set-ntp true || return $_linuxClockSyncFailureExitCode
  if command -v systemctl >/dev/null 2>&1; then
    run_as_root systemctl restart systemd-timesyncd >/dev/null 2>&1 || true
  fi
  clock_attempt=0
  while [ "\$(timedatectl show -p NTPSynchronized --value 2>/dev/null || true)" != 'yes' ]; do
    clock_attempt=\$((clock_attempt + 1))
    if [ "\$clock_attempt" -ge 15 ]; then
      echo 'Automatic time synchronization did not become ready within 30 seconds.' >&2
      return $_linuxClockSyncFailureExitCode
    fi
    sleep 2
  done
  echo 'System clock synchronized.'
}
refresh_package_indexes() {
  apt_update_log="\${TMPDIR:-/tmp}/harness-apt-update-\$\$.log"
  if apt_as_root update 2>&1 | tee "\$apt_update_log"; then
    rm -f "\$apt_update_log"
    return 0
  fi
  if grep -Eiq 'is not valid yet|certificate is not yet valid' "\$apt_update_log"; then
    rm -f "\$apt_update_log"
    if ! repair_system_clock; then
      echo 'System clock could not be synchronized automatically.' >&2
      return $_linuxClockSyncFailureExitCode
    fi
    if ! apt_as_root update; then
      echo 'Package repository refresh still failed after clock synchronization.' >&2
      return $_linuxAptUpdateFailureExitCode
    fi
    return 0
  fi
  rm -f "\$apt_update_log"
  echo 'Package repository refresh failed. Harness will not retry with stale package indexes.' >&2
  return $_linuxAptUpdateFailureExitCode
}
install_linux_packages() {
  apt_as_root install -y $names && return 0
  echo 'Refreshing package indexes before retrying…'
  refresh_package_indexes || return \$?
  if ! apt_as_root install -y $names; then
    echo 'Package installation still failed after a successful repository refresh.' >&2
    return $_linuxAptInstallFailureExitCode
  fi
}
if install_linux_packages; then
  :
else
  install_status=\$?
  exit "\$install_status"
fi''';
  }

  Future<String> _linuxHostManualCommand() async {
    final packages = <String>{
      ...await _missingLinuxHostPackages(),
      if (!await _hasTmux()) 'tmux',
    }.join(' ');
    if (packages.isEmpty) return 'Recheck Linux system dependencies.';
    if (!await _hasAptGet()) {
      return 'Install with your distribution package manager: $packages';
    }
    return 'sudo apt-get install -y $packages';
  }

  Future<bool> _hasHarness() async {
    final currentNode = File('${harnessHome.path}/runtime/current-node');
    if (!await currentNode.exists()) return false;
    final nodePath = (await currentNode.readAsString()).trim();
    if (nodePath.isEmpty || !File(nodePath).existsSync()) return false;
    final runtimeRoot = '${harnessHome.absolute.path}/runtime/';
    if (!File(nodePath).absolute.path.startsWith(runtimeRoot)) return false;
    final node = await _run(nodePath, ['--version']);
    if (node.exitCode != 0) return false;
    final match = RegExp(r'^v?(\d+)').firstMatch('${node.stdout}'.trim());
    if (match == null || int.parse(match.group(1)!) < 20) return false;
    try {
      final cli = File('${harnessHome.path}/cli/cli.js');
      if (!await cli.exists()) return false;
      final version = await _run(nodePath, [cli.path, 'version']);
      return version.exitCode == 0;
    } on ProcessException {
      return false;
    } on StateError {
      return false;
    }
  }

  Future<void> _ensureHarness(void Function(String line) onOutput) async {
    final runner = HarnessCliRunner(harnessHome: harnessHome, runProcess: _run);
    if (await _hasHarness()) return;
    // No interpreter is named here. install.sh provisions the same
    // checksum-verified Node under `~/.harness/runtime` when the computer has
    // none, records it in `current-node`, and bakes its absolute path into the
    // `~/.local/bin/harness` launcher — which is what makes a Finder launch,
    // where PATH is launchd's bare `/usr/bin:/bin:/usr/sbin:/sbin`, still find
    // a Node. Doing it there rather than here keeps ONE implementation of that,
    // shared with everyone who installs the CLI from a terminal.
    final install = await _shellStreaming(
      // Served off the CDN-fronted public bucket (autonomous-code: apps/web/scripts/cli-install.sh,
      // published with `make upload-cli-install-sh`), not by the web app. The old web-app URL,
      // https://harness.autonomous.ai/cli/install.sh, still redirects here, but pointing at the CDN
      // URL directly avoids that extra hop.
      // A stale URL is worse here than anywhere else: a 404 piped into bash still exits 0 (measured),
      // so the `install.exitCode != 0` check below would pass and the failure would only surface as
      // the confusing "CLI did not start after installation" a few lines further down.
      'set -e; $kHarnessDesktopInstallCommand',
      onOutput: onOutput,
    );
    if (install.exitCode != 0) {
      throw StateError(
        'Harness installer exited ${install.exitCode}: ${_resultText(install)}',
      );
    }
    final verified = await runner.run(['version']);
    if (verified.exitCode != 0 || !await _hasHarness()) {
      throw StateError(
        'Harness CLI verification exited ${verified.exitCode}: ${_resultText(verified)}',
      );
    }
  }

  Future<({File log, File result})> _launchLinuxHostSetup(
    List<String> packages,
  ) => _launchTerminalSetup(linuxPackages: packages);

  Future<({File log, File result})> _launchTmuxSetup() =>
      _launchTerminalSetup();

  Future<({File log, File result})> _launchTerminalSetup({
    List<String> linuxPackages = const [],
  }) async {
    // Package-manager installs can ask for a password. Always hand them to a
    // visible OS terminal instead of guessing whether this particular run will
    // prompt in a headless Process.run child.
    final script = await _writeTerminalBootstrapScript(
      linuxPackages: linuxPackages,
    );
    await _openTerminal(script.path);
    return (
      log: File('${script.parent.path}/terminal.log'),
      result: File('${script.parent.path}/terminal.exit'),
    );
  }

  Future<bool> _hasTmux() async {
    final result = await _shell('command -v tmux >/dev/null && tmux -V');
    return result.exitCode == 0;
  }

  Future<bool> _hasHomebrew() async {
    final result = await _shell('command -v brew >/dev/null && brew --version');
    return result.exitCode == 0;
  }

  Future<bool> _isTmuxEnvironmentReady() async {
    if (_isMacOS && !await _hasAppleDeveloperTools()) return false;
    if (_isMacOS && !await _hasHomebrew()) return false;
    return _hasTmux();
  }

  /// `xcode-select -p` only proves that a path was selected. It also succeeds
  /// for an incomplete or moved Command Line Tools directory. Resolve a tool
  /// through xcrun so pre-flight reflects whether Homebrew can actually use
  /// the selected Apple toolchain.
  Future<bool> _hasAppleDeveloperTools() async {
    if (_forceMissingAppleDeveloperTools) return false;
    final result = await _shell(
      'command -v /usr/bin/xcrun >/dev/null 2>&1 && '
      '/usr/bin/xcrun --find clang >/dev/null 2>&1',
    );
    return result.exitCode == 0;
  }

  Future<File> _writeTerminalBootstrapScript({
    List<String> linuxPackages = const [],
  }) async {
    final directory = Directory(
      '${harnessHome.path}/desktop-app-v2/setup-runs/${DateTime.now().millisecondsSinceEpoch}',
    );
    await directory.create(recursive: true);
    await _run('/bin/chmod', ['700', directory.path]);
    if (_isMacOS) {
      final script = File('${directory.path}/install-tmux.command');
      await script.writeAsString('''#!/bin/zsh
set -e
umask 077
LOG_FILE="${directory.path}/terminal.log"
RESULT_FILE="${directory.path}/terminal.exit"
exec > >(tee -a "\$LOG_FILE") 2>&1
finish() {
  status=\$?
  printf '%s\\n' "\$status" > "\$RESULT_FILE"
  if [ "\$status" -ne 0 ]; then
    echo
    echo 'System setup failed. Review the error above, then return to Harness.'
    read -r '?Press Enter to close this window…' || true
  fi
  return "\$status"
}
trap finish EXIT
apple_developer_tools_ready() {
  /usr/bin/xcrun --find clang >/dev/null 2>&1
}
if ! apple_developer_tools_ready; then
  if [ -x /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild ]; then
    echo 'Xcode is installed but is not the active developer directory.'
    echo 'macOS may ask for your password to select it.'
    sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
  else
    echo 'Apple developer tools are missing. Installing Command Line Tools; finish the macOS dialog to continue.'
    xcode-select --install || true
  fi
  attempts=0
  until apple_developer_tools_ready; do
    attempts=\$((attempts + 1))
    if [ "\$attempts" -ge 200 ]; then
      echo 'Apple developer tools did not become ready within 10 minutes.' >&2
      echo 'Finish the macOS installer, then retry setup.' >&2
      exit 12
    fi
    sleep 3
  done
fi
if ! command -v brew >/dev/null 2>&1; then
  echo 'Installing Homebrew (macOS may ask for your password)…'
  /bin/bash -c "\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
eval "\$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
if ! command -v tmux >/dev/null 2>&1; then
  brew install tmux
fi
echo 'tmux is ready. Return to Harness.'
''', flush: true);
      await _run('/bin/chmod', ['700', script.path]);
      return script;
    }
    final packageList = linuxPackages.isEmpty
        ? const ['tmux']
        : linuxPackages.toSet().toList();
    final packages = packageList.join(' ');
    const packageCommands = <String, String>{
      'dash': 'sh',
      'bash': 'bash',
      'curl': 'curl',
      'tar': 'tar',
      'sed': 'sed',
      'gawk': 'awk',
      'coreutils': 'sha256sum',
      'tmux': 'tmux',
      'xclip': 'xclip',
      'wl-clipboard': 'wl-copy',
    };
    final verification = packageList
        .map((package) => packageCommands[package])
        .whereType<String>()
        .map(
          (command) => command == 'tmux'
              ? 'command -v tmux >/dev/null 2>&1 && tmux -V'
              : 'command -v $command >/dev/null 2>&1',
        )
        .join('\n');
    final aptInstallCommand = _linuxAptInstallCommand(
      packageList,
      nonInteractiveSudo: false,
    );
    final script = File('${directory.path}/install-linux-dependencies.sh');
    await script.writeAsString('''#!/bin/bash
set -eu
umask 077
LOG_FILE="${directory.path}/terminal.log"
RESULT_FILE="${directory.path}/terminal.exit"
exec > >(tee -a "\$LOG_FILE") 2>&1

finish() {
  status=\$?
  printf '%s\\n' "\$status" > "\$RESULT_FILE"
  if [ "\$status" -ne 0 ]; then
    echo
    echo 'Linux package installation failed. Review the error above, then try again.'
    read -r -p 'Press Enter to close this window…' || true
  fi
  return "\$status"
}
trap finish EXIT

if command -v apt-get >/dev/null 2>&1; then
  echo 'Installing Linux host dependencies (you may be asked for your password)…'
  $aptInstallCommand
  $verification
  echo 'Installed packages: $packages'
  echo 'Linux host dependencies are ready. This window will close automatically in 5 seconds.'
  sleep 5
else
  echo 'Automatic Linux package installation only supports apt-based distributions (Ubuntu/Debian).'
  echo 'Install these packages with your distribution package manager: $packages'
  exit 1
fi
''', flush: true);
    await _run('/bin/chmod', ['700', script.path]);
    return script;
  }

  Future<ProcessResult> _shell(
    String command, {
    Map<String, String>? environment,
    Duration? timeout,
  }) {
    final run = _run(_isMacOS ? '/bin/zsh' : '/bin/bash', [
      '-l',
      '-c',
      // The Homebrew prefixes are named rather than trusted to be on PATH:
      // `-l` is a LOGIN shell but not an interactive one, so it reads
      // `~/.zprofile` and never `~/.zshrc`
      // — which is where `brew shellenv` sits on plenty of machines. A Finder
      // launch then starts from launchd's bare `/usr/bin:/bin:/usr/sbin:/sbin`
      // and this probe reports tmux missing on a computer that has it, then
      // "installs" it through whichever `brew` it can see. Measured: an Apple
      // Silicon Mac with both Homebrews picked up Intel `/usr/local/bin/brew`
      // and built openssl@3 from source under Rosetta, holding the boot open
      // on "Checking tmux…" for as long as that took. Apple Silicon first, so
      // a machine with both never installs through the Intel one. The CLI
      // closed the same gap in `lib/tmuxOnPath.ts`.
      'export PATH="\$HOME/.local/bin${_isMacOS ? ':/opt/homebrew/bin:/usr/local/bin' : ''}:\$PATH"; $command',
    ], environment: environment);
    if (timeout == null) return run;
    // The child keeps running — Process.run gives us no handle to kill. That is
    // the intent: a slow install finishes in the background and the next launch
    // finds it, while this one stops waiting.
    return run.timeout(
      timeout,
      onTimeout: () => ProcessResult(0, 124, '', 'timed out after $timeout'),
    );
  }

  Future<ProcessResult> _shellStreaming(
    String command, {
    required void Function(String line) onOutput,
    Duration? timeout,
  }) async {
    final shell = _isMacOS ? '/bin/zsh' : '/bin/bash';
    final wrapped =
        'export PATH="\$HOME/.local/bin${_isMacOS ? ':/opt/homebrew/bin:/usr/local/bin' : ''}:\$PATH"; $command';
    if (_start == null) {
      final result = await _shell(command, timeout: timeout);
      for (final line in '${result.stdout}\n${result.stderr}'.split('\n')) {
        if (line.trim().isNotEmpty) onOutput(line);
      }
      return result;
    }

    final process = await _start(shell, ['-l', '-c', wrapped]);
    final stdoutLines = <String>[];
    final stderrLines = <String>[];
    final stdoutSubscription = process.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen((line) {
          stdoutLines.add(line);
          onOutput(line);
        });
    final stderrSubscription = process.stderr
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen((line) {
          stderrLines.add(line);
          onOutput(line);
        });
    final stdoutDone = stdoutSubscription.asFuture<void>();
    final stderrDone = stderrSubscription.asFuture<void>();
    var timedOut = false;
    final exit = timeout == null
        ? await process.exitCode
        : await process.exitCode.timeout(
            timeout,
            onTimeout: () {
              timedOut = true;
              process.kill();
              return 124;
            },
          );
    if (timedOut) {
      await stdoutSubscription.cancel();
      await stderrSubscription.cancel();
    } else {
      await Future.wait([stdoutDone, stderrDone]);
    }
    return ProcessResult(
      process.pid,
      exit,
      stdoutLines.join('\n'),
      stderrLines.join('\n'),
    );
  }

  String _manualCommandFor(EnvironmentStep step) => switch (step) {
    EnvironmentStep.clipboard =>
      'sudo apt-get install -y ${_linuxClipboardPackage() ?? 'xclip or wl-clipboard'}',
    EnvironmentStep.tmux =>
      _isMacOS
          ? 'brew install tmux && tmux -V'
          : 'sudo apt-get install -y tmux && tmux -V',
    EnvironmentStep.harness =>
      '$kHarnessDesktopInstallCommand && harness version',
  };

  String _resultText(ProcessResult result) {
    final text = '${result.stderr}\n${result.stdout}'.trim();
    return text.length <= 700 ? text : text.substring(text.length - 700);
  }
}

extension on Iterable<EnvironmentStep> {
  EnvironmentStep? get firstOrNull => isEmpty ? null : first;
}
