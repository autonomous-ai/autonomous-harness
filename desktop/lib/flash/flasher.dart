import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../core/harness_cli_runner.dart';
import '../core/serial_port_lease.dart';

/// What a line of flasher output is.
///
/// The script prints a flat stream; the shape is carried by the prefix. `>> `
/// opens a step, an indented line details the step in progress, and anything on
/// stderr is trouble. Nothing here re-orders or drops a line — the raw log stays
/// the record, and this only decides what the UI emphasises.
enum FlashLineKind { step, detail, warning, error }

class FlashLine {
  final String text;
  final FlashLineKind kind;

  const FlashLine(this.text, this.kind);

  /// The step title without its `>> ` marker, for the step list.
  String get title => text.startsWith('>> ') ? text.substring(3) : text;
}

/// Outcome of a finished run.
class FlashResult {
  final int exitCode;
  final bool cancelled;

  const FlashResult({required this.exitCode, this.cancelled = false});

  bool get ok => exitCode == 0 && !cancelled;
}

/// What `--detect-only` found.
class FlashProbe {
  /// Ports the script recognised as an ESP32-S3.
  final List<String> ports;

  /// Set when it refused for a reason the user can act on.
  final String? problem;

  /// Everything it printed, kept for the log pane.
  final List<FlashLine> log;

  const FlashProbe({required this.ports, required this.log, this.problem});

  bool get found => ports.isNotEmpty;
}

/// Runs the published flasher through the installed `harness` CLI.
///
/// The app deliberately does NOT fetch or cache `flash-circle.sh` itself.
/// `harness flash` already owns which script to run and how to get it, and the
/// script owns every number that decides whether a board survives the write —
/// the chip, the app offset, the otadata region, the sha256 checks. A second
/// copy of any of that here is a bricked board the day the two disagree. This
/// class owns one thing: turning that command's output into something a window
/// can draw.
class Flasher {
  Flasher({this.startProcess = harnessCliStart});

  /// Overridden in tests.
  final Future<Process> Function(List<String> arguments) startProcess;

  Process? _running;
  bool _cancelled = false;

  bool get isRunning => _running != null;

  /// Looks for a plugged-in board without touching it.
  ///
  /// `--detect-only` returns before the script would stop the Harness daemon,
  /// so opening the dialog costs nothing: no daemon bounce, no write, no
  /// download.
  Future<FlashProbe> probe() async {
    final log = <FlashLine>[];
    final ports = <String>[];
    String? problem;

    final code = await _run(['flash', '--detect-only'], (line) {
      log.add(line);
      final text = line.text;
      const marker = '>> board: ';
      if (text.startsWith(marker)) {
        ports.add(text.substring(marker.length).trim());
      } else if (text.startsWith('more than one ESP32-S3')) {
        problem = 'more than one board is connected';
      } else if (text.contains('no permission')) {
        problem = 'no permission to open the serial port';
      }
    });

    if (code != 0 && problem == null) {
      problem = _errorFrom(log) ?? 'could not look for a board';
    }
    return FlashProbe(ports: ports, log: log, problem: problem);
  }

  /// Writes the latest release to [port], or to whatever the script picks.
  ///
  /// `--yes` is not optional. The script asks for confirmation on `/dev/tty`,
  /// and an app launched from Finder has none — without it the run dies with
  /// "not a terminal" before writing anything. The dialog's Flash button IS
  /// that confirmation.
  Future<FlashResult> flash({String? port, void Function(FlashLine)? onLine}) {
    final command = ['flash', '--yes'];
    if (port != null && port.isNotEmpty) command.addAll(['--port', port]);
    // Held for the WHOLE run, not just the write. The script stops the daemon itself and starts it
    // again at the end; between those two the port belongs to esptool, and the app's own daemon
    // supervisor — a five-second timer that restarts anything it finds missing — would otherwise take
    // it back and kill the flash a few tens of kilobytes in.
    return SerialPortLease.hold(() async {
      final code = await _run(command, (line) => onLine?.call(line));
      return FlashResult(exitCode: code, cancelled: _cancelled);
    });
  }

  /// Asks a running flash to stop, and lets it unwind.
  ///
  /// SIGTERM, never SIGKILL. The script arms
  /// `trap start_harness_after_flash EXIT INT TERM`, and that trap is the only
  /// thing that brings the Harness daemon back after the script stopped it to
  /// free the serial port. Killing it outright leaves the computer with no
  /// daemon and the dial dark — worse than never having flashed at all.
  void cancel() {
    final process = _running;
    if (process == null) return;
    _cancelled = true;
    process.kill(ProcessSignal.sigterm);
  }

  Future<int> _run(
    List<String> command,
    void Function(FlashLine) onLine,
  ) async {
    if (_running != null) throw StateError('a flash is already running');
    _cancelled = false;
    final process = await startProcess(command);
    _running = process;
    try {
      final pumps = <Future<void>>[
        _pump(process.stdout, onLine, stderr: false),
        _pump(process.stderr, onLine, stderr: true),
      ];
      final code = await process.exitCode;
      // Drain first: the last lines can still be in flight when the process
      // has already gone, and losing them loses the reason it failed.
      await Future.wait(pumps);
      return code;
    } finally {
      _running = null;
    }
  }

  Future<void> _pump(
    Stream<List<int>> source,
    void Function(FlashLine) onLine, {
    required bool stderr,
  }) {
    return source
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .forEach((raw) => onLine(classifyFlashLine(raw, stderr: stderr)));
  }

  static String? _errorFrom(List<FlashLine> log) {
    for (final line in log.reversed) {
      if (line.kind == FlashLineKind.error) {
        return line.text.replaceFirst(RegExp(r'^error:\s*'), '');
      }
    }
    return null;
  }
}

/// Decides what a raw output line is.
///
/// Pure, so the rule can be tested without spawning anything.
FlashLine classifyFlashLine(String raw, {required bool stderr}) {
  final text = raw.trimRight();
  if (text.startsWith('error:')) return FlashLine(text, FlashLineKind.error);
  if (text.startsWith('>> ')) return FlashLine(text, FlashLineKind.step);
  // Indented lines detail the running step. On stderr they are the script's
  // warnings — same shape, but they must not read as routine.
  if (stderr) return FlashLine(text, FlashLineKind.warning);
  return FlashLine(text, FlashLineKind.detail);
}

/// Starts `harness flash` with the managed runtime. [HarnessCliRunner] also
/// puts the legacy launcher directory on PATH for the child script, so the
/// flasher can stop and restart its daemon reliably without zsh.
Future<Process> harnessCliStart(List<String> arguments) =>
    HarnessCliRunner().start(arguments);
