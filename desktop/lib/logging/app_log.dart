import 'error_burst_filter.dart';
import 'log_file.dart';

/// Severity of an [AppLog] event, in ascending order.
enum AppLogLevel { debug, info, warn, error }

/// The app's own diagnostic logger — a durable, human-readable timeline written
/// to `~/.harness/logs/app-YYYYMMDD.log`.
///
/// Ported from Grid, with one change: Riverpod out, a singleton in. The call
/// sites here are `main`, `AppNotifier`, `WsConn` and the CLI runner, and most
/// were never handed a `Ref` — the same reasoning that made `analytics` a
/// singleton (see `analytics/analytics.dart`).
///
/// **Distinct from [CrashLog], and both are kept.** `CrashLog` answers "what
/// threw", in one file, forever, with a full stack; this answers "what was the
/// app *doing*", per day, pruned after two weeks. A crash whose stack names a
/// line still needs the ten lines before it to be explicable — that is what this
/// is for. `installFileLogs` wires errors into both.
///
/// [category] is a short, stable tag grouping related events — `app`
/// (lifecycle), `ws` (the socket this app lives on), `cli`, `api`, `flutter` —
/// so the timeline can be skimmed or filtered by concern.
abstract interface class AppLog {
  /// Append one structured event. [error]/[stackTrace] are included when present
  /// (the stack trace is indented on following lines).
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  });
}

/// Level-named conveniences over [AppLog.record], kept as extensions so every
/// [AppLog] implementation gets them for free without re-declaring the surface.
extension AppLogX on AppLog {
  void debug(String category, String message) =>
      record(AppLogLevel.debug, category, message);

  void info(String category, String message) =>
      record(AppLogLevel.info, category, message);

  void warn(String category, String message, {Object? error}) =>
      record(AppLogLevel.warn, category, message, error: error);

  void failure(
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) => record(
    AppLogLevel.error,
    category,
    message,
    error: error,
    stackTrace: stackTrace,
  );
}

/// [AppLog] backed by a per-day file under `~/.harness/logs`. Writes are
/// synchronous and flushed (see [DailyLogFile]); IO errors are swallowed.
class FileAppLog implements AppLog {
  FileAppLog(this._file, {ErrorBurstFilter? burst, DateTime Function()? clock})
    : _burst = burst ?? ErrorBurstFilter(),
      _clock = clock ?? DateTime.now;

  final DailyLogFile _file;

  /// Injected so the stamp this writes is a thing a test can assert, rather than
  /// a thing a test has to watch happen. Same reason [ErrorBurstFilter] takes one.
  final DateTime Function() _clock;

  /// Applied to ERROR only. An exception thrown from `build` or a frame callback
  /// repeats every frame, and each copy costs an fsync on the UI isolate — which
  /// is how a glitch becomes a hang. Lower levels are things this app chose to
  /// say once, so they are not filtered.
  final ErrorBurstFilter _burst;

  @override
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) {
    // The body is built WITHOUT the timestamp, and the stamp is put on last.
    // ErrorBurstFilter signs an error by its first line, so handing it a stamped
    // line would make every copy a different error the moment the clock ticked —
    // suppression would work inside one second and never report a count.
    final body = StringBuffer(
      '${_levelTag(level)} ${_categoryTag(category)} $message',
    );
    if (error != null) body.write('  err=$error');

    if (level != AppLogLevel.error) {
      _file.append('[${logStamp(_clock())}] $body');
      _appendStack(stackTrace);
      return;
    }
    final admitted = _burst.admit(body.toString());
    if (admitted == null) return;
    _file.append('[${logStamp(_clock())}] $admitted');
    _appendStack(stackTrace);
  }

  void _appendStack(StackTrace? stackTrace) {
    if (stackTrace == null) return;
    _file.append(
      stackTrace
          .toString()
          .trimRight()
          .split('\n')
          .map((l) => '    $l')
          .join('\n'),
    );
  }

  /// Five-wide upper-case level so message columns line up.
  static String _levelTag(AppLogLevel level) => switch (level) {
    AppLogLevel.debug => 'DEBUG',
    AppLogLevel.info => 'INFO ',
    AppLogLevel.warn => 'WARN ',
    AppLogLevel.error => 'ERROR',
  };

  /// Pad short categories to a common width for a readable second column.
  static String _categoryTag(String category) =>
      category.length >= 7 ? category : category.padRight(7);
}

/// No-op [AppLog]. The default, so a `flutter test` run never writes into a real
/// `~/.harness` — the same rule analytics follows, and for the same reason.
class NoopAppLog implements AppLog {
  const NoopAppLog();

  @override
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) {}
}

/// The app-log sink. Muted until [installFileLogs] swaps in the file sink.
AppLog appLog = const NoopAppLog();
