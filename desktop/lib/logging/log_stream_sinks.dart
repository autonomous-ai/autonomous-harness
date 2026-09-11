/// The sinks that put the app's log in two places at once: the daily files, and
/// the in-memory [LogStream] the Debug screen reads.
///
/// A mirror rather than a second stream. Every call site keeps writing to the
/// one `appLog`/`cliLog` it already writes to, so a line cannot reach the
/// screen without reaching the file — which is what makes "read it in Settings
/// ▸ Debug" and "send us the log" the same evidence.
library;

import 'app_log.dart';
import 'cli_log.dart';
import 'log_stream.dart';

/// Writes one event to each of [sinks], in order.
class FanoutAppLog implements AppLog {
  const FanoutAppLog(this.sinks);

  final List<AppLog> sinks;

  @override
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) {
    for (final sink in sinks) {
      sink.record(
        level,
        category,
        message,
        error: error,
        stackTrace: stackTrace,
      );
    }
  }
}

/// [AppLog] that appends to a [LogStream].
///
/// No burst filter, unlike [FileAppLog]: this costs no fsync, and an error
/// repeating every frame is itself the thing a developer opened this screen to
/// see. The ring bounds what it can cost.
class StreamAppLog implements AppLog {
  const StreamAppLog(this._stream);

  final LogStream _stream;

  @override
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) {
    _stream.add(
      level,
      category,
      message,
      error: error?.toString(),
      stackTrace: stackTrace?.toString(),
    );
  }
}

/// Opens one section on each of [sinks] and keeps them in step.
class FanoutCliLog implements CliLog {
  const FanoutCliLog(this.sinks);

  final List<CliLog> sinks;

  @override
  CliLogEntry begin(String command) =>
      _FanoutEntry([for (final sink in sinks) sink.begin(command)]);
}

class _FanoutEntry implements CliLogEntry {
  const _FanoutEntry(this._entries);

  final List<CliLogEntry> _entries;

  @override
  void output(String line, {bool isError = false}) {
    for (final entry in _entries) {
      entry.output(line, isError: isError);
    }
  }

  @override
  void end({int? exitCode, Duration? duration, String? error}) {
    for (final entry in _entries) {
      entry.end(exitCode: exitCode, duration: duration, error: error);
    }
  }
}

/// [CliLog] that turns each invocation into one [LogEntry] carrying its own
/// transcript — one row in the Debug list that grows, rather than a row per
/// line, which is what the file wants and a list does not.
class StreamCliLog implements CliLog {
  const StreamCliLog(this._stream);

  final LogStream _stream;

  @override
  CliLogEntry begin(String command) {
    final invocation = LogCommand();
    final id = _stream.add(
      AppLogLevel.info,
      'cli',
      command,
      command: invocation,
    );
    return _StreamEntry(_stream, id, DateTime.now());
  }
}

class _StreamEntry implements CliLogEntry {
  _StreamEntry(this._stream, this._id, this._start);

  final LogStream _stream;
  final int _id;
  final DateTime _start;

  @override
  void output(String line, {bool isError = false}) =>
      _stream.appendOutput(_id, line, isError: isError);

  @override
  void end({int? exitCode, Duration? duration, String? error}) =>
      _stream.finish(
        _id,
        exitCode: exitCode,
        duration: duration ?? DateTime.now().difference(_start),
        error: error,
      );
}
