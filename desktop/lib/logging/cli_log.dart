import 'log_file.dart';

/// Durable, append-only transcript of every CLI call this app makes, written per
/// day to `~/.harness/logs/cli-YYYYMMDD.log`.
///
/// Ported from Grid. "The CLI did something unexpected" is the single most
/// common shape of a fault here, because the app itself holds almost no logic.
///
/// Concurrent calls interleave in the file, so each line is tagged with a
/// per-call id (`#3`) to keep one command's output readable.
///
/// **A command line is logged, its environment is not.** A secret handed to a
/// child travels in its environment precisely so it stays out of argv; writing
/// the environment here would undo that and put a key on disk.
abstract interface class CliLog {
  /// Opens a section for one invocation. [command] is the display line
  /// (`harness link create`). Returns a handle to append output and close it.
  CliLogEntry begin(String command);
}

/// Handle to one in-flight invocation's transcript section.
abstract interface class CliLogEntry {
  /// Append one line of the command's output; [isError] tags stderr.
  void output(String line, {bool isError = false});

  /// Close the section with how the command ended. Idempotent — a second call is
  /// ignored so a cancelled stream and its exit code don't double-close.
  void end({int? exitCode, Duration? duration, String? error});
}

/// [CliLog] backed by a per-day file under `~/.harness/logs`.
class FileCliLog implements CliLog {
  FileCliLog(this._file);

  final DailyLogFile _file;
  int _seq = 0;

  @override
  CliLogEntry begin(String command) {
    final id = ++_seq;
    final start = DateTime.now();
    _file.append('[${logClock(start)}] #$id \$ $command');
    return _FileCliLogEntry(_file, id, start);
  }
}

class _FileCliLogEntry implements CliLogEntry {
  _FileCliLogEntry(this._file, this._id, this._start);

  final DailyLogFile _file;
  final int _id;
  final DateTime _start;
  bool _ended = false;

  @override
  void output(String line, {bool isError = false}) {
    if (_ended) return;
    // `!` gutter marks stderr so failures stand out; `|` for normal output.
    _file.append(
      '[${logClock(DateTime.now())}] #$_id ${isError ? '!' : '|'} $line',
    );
  }

  @override
  void end({int? exitCode, Duration? duration, String? error}) {
    if (_ended) return;
    _ended = true;
    final took = logDuration(duration ?? DateTime.now().difference(_start));
    final code = exitCode != null ? ' exit=$exitCode' : '';
    final err = error != null ? ' error: $error' : '';
    _file.append('[${logClock(DateTime.now())}] #$_id ← done$code ($took)$err');
  }
}

/// No-op [CliLog] — the default, so tests never touch `~/.harness/logs`.
class NoopCliLog implements CliLog {
  const NoopCliLog();

  @override
  CliLogEntry begin(String command) => const _NoopEntry();
}

class _NoopEntry implements CliLogEntry {
  const _NoopEntry();

  @override
  void output(String line, {bool isError = false}) {}

  @override
  void end({int? exitCode, Duration? duration, String? error}) {}
}

/// The CLI transcript sink. Muted until [installFileLogs] swaps in the file sink.
CliLog cliLog = const NoopCliLog();
