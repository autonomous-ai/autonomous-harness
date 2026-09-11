import 'app_log.dart';
import 'cli_log.dart';
import 'debug_surface.dart';
import 'log_file.dart';
import 'log_stream.dart';
import 'log_stream_sinks.dart';

/// Base names of the two per-day files under `~/.harness/logs`.
const String kAppLogBase = 'app';
const String kCliLogBase = 'cli';

/// Point [appLog] and [cliLog] at real files under `~/.harness/logs`, and — in
/// a build that has the Debug screen — at the in-memory [logStream] as well.
///
/// Called once from `main()`. Nothing else calls it, which is what keeps the
/// suite honest: both sinks default to their no-op, so `flutter test` cannot
/// write into a real Harness home no matter which code path it exercises — the
/// same rule analytics follows.
///
/// Deliberately not `async`: the first lines this app writes are the ones about
/// starting up, and awaiting a directory probe here would lose them.
void installFileLogs() {
  final directory = DailyLogFile.defaultDirectory;
  final file = FileAppLog(DailyLogFile(directory, kAppLogBase));
  final cli = FileCliLog(DailyLogFile(directory, kCliLogBase));
  if (!kDebugSurfaceEnabled) {
    appLog = file;
    cliLog = cli;
    return;
  }
  // The file first in both fan-outs: if the mirror ever throws, the durable
  // copy is already written.
  appLog = FanoutAppLog([file, StreamAppLog(logStream)]);
  cliLog = FanoutCliLog([cli, StreamCliLog(logStream)]);
}
