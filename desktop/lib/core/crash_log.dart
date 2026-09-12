import 'dart:io';

import 'package:flutter/foundation.dart';

import '../logging/app_log.dart';
import 'harness_file_store.dart';
import 'test_run.dart';

/// Where a released build writes the errors nobody would otherwise see.
///
/// `debugPrint` and the default `FlutterError` handler both end at stderr, and
/// a `.app` launched from Finder has no stderr anyone reads. The practical
/// result is that every crash so far has reached us as a photograph of the
/// frozen pane — which says what the message was and nothing about where it
/// came from. A stack trace names the line; a screenshot cannot.
///
/// Everything here is best-effort and bounded. Diagnostics must never be the
/// reason something fails.
class CrashLog {
  static const _maxBytes = 256 * 1024;

  @visibleForTesting
  static File? testFile;

  static File get _file =>
      testFile ??
      File('${HarnessFileStore.defaultDirectoryPath()}/errors.log');

  static void record(Object error, StackTrace? stackTrace, {String? context}) {
    // Mirrored into the day's app log as well, and the two are not redundant:
    // errors.log answers "what threw" for all time, while the daily log puts the
    // same failure back among the lines that led to it. A crash whose stack
    // names a line still needs its ten preceding lines to be explicable.
    // FileAppLog's burst filter is what keeps a per-frame exception from
    // fsyncing the UI isolate to a halt; this file's own truncation is not
    // enough for that, which is why the mirror goes through appLog rather than
    // the other way round.
    appLog.failure(
      context ?? 'crash',
      'uncaught',
      error: error,
      stackTrace: stackTrace,
    );
    if (kUnderTest && testFile == null) return;
    try {
      final file = _file;
      // The directory may not exist yet, and the first run is exactly when this
      // matters: an error thrown while the environment is still being
      // provisioned lands before anything has written `~/.harness/desktop-app`.
      // Without this the whole crash log silently did nothing on a fresh
      // machine — the one machine whose crashes we most need the stack for.
      file.parent.createSync(recursive: true);
      // Truncate rather than rotate: this is read by a person looking into a
      // fault that just happened, so the RECENT end is the valuable end, and a
      // second file to manage buys nothing.
      if (file.existsSync() && file.lengthSync() > _maxBytes) {
        file.writeAsStringSync('');
      }
      final where = context == null ? '' : ' [$context]';
      file.writeAsStringSync(
        '${DateTime.now().toIso8601String()}$where $error\n'
        '${stackTrace ?? StackTrace.current}\n\n',
        mode: FileMode.append,
      );
    } catch (_) {
      // See above.
    }
  }

  /// Route the framework's own error channels here as well.
  ///
  /// Both are needed and they catch different things: [FlutterError.onError]
  /// covers build/layout/paint and anything reported through the framework,
  /// while [PlatformDispatcher.onError] is the last stop for errors escaping an
  /// async gap — which is most of this app, since terminal frames, sockets and
  /// timers all arrive that way.
  ///
  /// The default handler is still called, so nothing that used to be printed
  /// stops being printed; this only adds a copy that survives the session.
  static void install() {
    final previousFlutterError = FlutterError.onError;
    FlutterError.onError = (details) {
      record(details.exception, details.stack, context: 'flutter');
      previousFlutterError?.call(details);
    };

    final previousPlatformError = PlatformDispatcher.instance.onError;
    PlatformDispatcher.instance.onError = (error, stack) {
      record(error, stack, context: 'async');
      return previousPlatformError?.call(error, stack) ?? false;
    };
  }
}
