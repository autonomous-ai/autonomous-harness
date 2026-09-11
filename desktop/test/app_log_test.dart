// The log stack, ported from Grid. Everything here runs against a temp
// directory with an injected clock: a diagnostic that wrote into a real
// ~/.harness during `flutter test` would be the first thing to break trust in it.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/logging/app_log.dart';
import 'package:harness/logging/app_log_tail.dart';
import 'package:harness/logging/error_burst_filter.dart';
import 'package:harness/logging/log_file.dart';

void main() {
  late Directory dir;

  setUp(() => dir = Directory.systemTemp.createTempSync('harness-log-'));
  tearDown(() {
    if (dir.existsSync()) dir.deleteSync(recursive: true);
  });

  group('DailyLogFile', () {
    test('writes to a dated file and makes the directory on demand', () {
      final nested = Directory('${dir.path}/not/created/yet');
      final file = DailyLogFile(
        nested,
        'app',
        clock: () => DateTime(2026, 9, 7, 10, 30),
      );

      file.append('hello');

      expect(
        File('${nested.path}/app-20260907.log').readAsStringSync(),
        'hello\n',
      );
    });

    test('a new day opens a new file and leaves yesterday intact', () {
      var now = DateTime(2026, 9, 7);
      final file = DailyLogFile(dir, 'app', clock: () => now);

      file.append('monday');
      now = DateTime(2026, 9, 8);
      file.append('tuesday');

      expect(
        File('${dir.path}/app-20260907.log').readAsStringSync(),
        'monday\n',
      );
      expect(
        File('${dir.path}/app-20260908.log').readAsStringSync(),
        'tuesday\n',
      );
    });

    test('the day rollover prunes past retention, and only this base', () {
      File('${dir.path}/app-20260101.log').writeAsStringSync('ancient');
      File('${dir.path}/app-20260906.log').writeAsStringSync('recent');
      // A different base's old file is not this file's to delete.
      File('${dir.path}/cli-20260101.log').writeAsStringSync('other base');

      DailyLogFile(
        dir,
        'app',
        retentionDays: 14,
        clock: () => DateTime(2026, 9, 7),
      ).append('today');

      expect(File('${dir.path}/app-20260101.log').existsSync(), isFalse);
      expect(File('${dir.path}/app-20260906.log').existsSync(), isTrue);
      expect(File('${dir.path}/cli-20260101.log').existsSync(), isTrue);
    });

    test('an unwritable directory is swallowed, not thrown', () {
      // A path whose parent is a FILE cannot be created — the cheapest real IO
      // failure. Diagnostics must never be the reason something fails.
      final blocker = File('${dir.path}/blocker')..writeAsStringSync('x');
      final file = DailyLogFile(Directory('${blocker.path}/logs'), 'app');

      expect(() => file.append('anything'), returnsNormally);
    });
  });

  group('FileAppLog', () {
    test('writes level, category and message, and indents a stack trace', () {
      final at = DateTime(2026, 9, 7, 8, 5, 3);
      final sink = DailyLogFile(dir, 'app', clock: () => at);
      FileAppLog(sink, clock: () => at).record(
        AppLogLevel.warn,
        'ws',
        'socket closed',
        error: 'code 4404',
        stackTrace: StackTrace.fromString('#0 first\n#1 second'),
      );

      final text = sink.currentFile.readAsStringSync();
      expect(
        text,
        contains('[2026-09-07 08:05:03] WARN  ws      socket closed'),
      );
      expect(text, contains('err=code 4404'));
      expect(text, contains('    #0 first'));
      expect(text, contains('    #1 second'));
    });

    test('a repeating error is written once and then counted', () {
      // The failure this guards: an exception from build/paint repeats every
      // frame, and each copy costs an fsync on the UI isolate.
      var now = DateTime(2026, 9, 7, 8);
      final sink = DailyLogFile(dir, 'app', clock: () => now);
      final log = FileAppLog(
        sink,
        burst: ErrorBurstFilter(clock: () => now),
        clock: () => now,
      );

      for (var i = 0; i < 500; i++) {
        log.failure('flutter', 'the same assertion');
      }
      final duringBurst = '\n'
          .allMatches(sink.currentFile.readAsStringSync())
          .length;
      expect(duringBurst, 1, reason: '500 copies must not be 500 lines');

      now = now.add(const Duration(minutes: 1));
      log.failure('flutter', 'the same assertion');

      final text = sink.currentFile.readAsStringSync();
      expect(text, contains('[+499 identical since the last copy]'));
    });

    test('non-error levels are never suppressed', () {
      final at = DateTime(2026, 9, 7);
      final sink = DailyLogFile(dir, 'app', clock: () => at);
      final log = FileAppLog(sink, clock: () => at);

      for (var i = 0; i < 5; i++) {
        log.info('app', 'a thing this app chose to say');
      }

      expect('\n'.allMatches(sink.currentFile.readAsStringSync()).length, 5);
    });
  });

  group('recentErrorLines', () {
    const log = '''
[2026-09-07 08:00:00] INFO  app     launched
[2026-09-07 08:00:01] ERROR ws      first failure
    #0 a stack frame that must not be picked up
[2026-09-07 08:00:02] WARN  cli     a warning
[2026-09-07 08:00:03] ERROR api     second failure
''';

    test('keeps only ERROR lines, newest last, without their stacks', () {
      expect(recentErrorLines(log), [
        '[2026-09-07 08:00:01] ERROR ws      first failure',
        '[2026-09-07 08:00:03] ERROR api     second failure',
      ]);
    });

    test('keeps at most `keep`, taking the newest', () {
      expect(recentErrorLines(log, keep: 1), [
        '[2026-09-07 08:00:03] ERROR api     second failure',
      ]);
    });

    test('a very long line is clipped', () {
      final wide = '[2026-09-07 08:00:00] ERROR api     ${'x' * 400}';
      expect(recentErrorLines(wide, clip: 60).single.length, 61);
    });
  });
}
