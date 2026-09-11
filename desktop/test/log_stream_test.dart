// The in-memory mirror behind Settings ▸ Debug. It has to hold the same lines
// the files hold — and hold them without growing without bound, since it lives
// for as long as the app does.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/logging/app_log.dart';
import 'package:harness/logging/cli_log.dart';
import 'package:harness/logging/log_stream.dart';
import 'package:harness/logging/log_stream_sinks.dart';

void main() {
  group('LogStream', () {
    test('keeps entries newest first', () {
      final stream = LogStream();

      stream.add(AppLogLevel.info, 'app', 'first');
      stream.add(AppLogLevel.info, 'app', 'second');

      expect(stream.entries.map((e) => e.message), ['second', 'first']);
    });

    test('drops the oldest past its cap', () {
      final stream = LogStream(maxEntries: 3);

      for (var i = 0; i < 5; i++) {
        stream.add(AppLogLevel.info, 'ws', 'frame $i');
      }

      expect(stream.entries.length, 3);
      expect(stream.entries.map((e) => e.message), [
        'frame 4',
        'frame 3',
        'frame 2',
      ]);
    });

    test('a command collects its output and its exit code', () {
      final stream = LogStream();
      final id = stream.add(
        AppLogLevel.info,
        'cli',
        'harness auth status --json',
        command: LogCommand(),
      );

      stream.appendOutput(id, 'signed in');
      stream.appendOutput(id, 'a warning', isError: true);
      stream.finish(id, exitCode: 0, duration: const Duration(seconds: 1));

      final entry = stream.entries.single;
      expect(entry.status, LogStatus.ok);
      expect(entry.command!.output, ['  signed in', '! a warning']);
      expect(entry.command!.duration, const Duration(seconds: 1));
    });

    test(
      'a non-zero exit raises the entry to error, so the Failed lens has it',
      () {
        final stream = LogStream();
        final id = stream.add(
          AppLogLevel.info,
          'cli',
          'harness link create',
          command: LogCommand(),
        );

        stream.finish(id, exitCode: 2);

        expect(stream.entries.single.status, LogStatus.failed);
        expect(stream.entries.single.level, AppLogLevel.error);
      },
    );

    test('output past the cap is dropped and said out loud', () {
      final stream = LogStream(maxOutputLines: 2);
      final id = stream.add(
        AppLogLevel.info,
        'cli',
        'harness update',
        command: LogCommand(),
      );

      for (var i = 0; i < 5; i++) {
        stream.appendOutput(id, 'line $i');
      }

      expect(stream.entries.single.command!.output.length, 2);
      expect(stream.entries.single.command!.clipped, isTrue);
    });

    test('a finished command is not reopened by a late line', () {
      final stream = LogStream();
      final id = stream.add(
        AppLogLevel.info,
        'cli',
        'harness start',
        command: LogCommand(),
      );
      stream.finish(id, exitCode: 0);

      stream.appendOutput(id, 'too late');
      stream.finish(id, exitCode: 9);

      expect(stream.entries.single.command!.output, isEmpty);
      expect(stream.entries.single.command!.exitCode, 0);
    });

    test('notifies once per microtask, however many lines arrived', () async {
      final stream = LogStream();
      var notifications = 0;
      stream.addListener(() => notifications++);

      for (var i = 0; i < 10; i++) {
        stream.add(AppLogLevel.debug, 'ws', 'frame $i');
      }
      await Future<void>.delayed(Duration.zero);

      expect(notifications, 1);
    });

    test(
      'clear empties it, and does nothing when it is already empty',
      () async {
        final stream = LogStream();
        var notifications = 0;
        stream.addListener(() => notifications++);

        stream.clear();
        await Future<void>.delayed(Duration.zero);
        expect(notifications, 0);

        stream.add(AppLogLevel.info, 'app', 'launched');
        stream.clear();
        await Future<void>.delayed(Duration.zero);
        expect(stream.entries, isEmpty);
      },
    );
  });

  group('the mirroring sinks', () {
    test('an app-log line reaches every sink', () {
      final stream = LogStream();
      final recorder = _RecordingAppLog();
      final log = FanoutAppLog([recorder, StreamAppLog(stream)]);

      log.failure(
        'ws',
        'socket died',
        error: StateError('boom'),
        stackTrace: StackTrace.fromString('frame one'),
      );

      expect(recorder.messages, ['socket died']);
      final entry = stream.entries.single;
      expect(entry.category, 'ws');
      expect(entry.level, AppLogLevel.error);
      expect(entry.error, contains('boom'));
      expect(entry.stackTrace, 'frame one');
      expect(entry.status, LogStatus.failed);
    });

    test('a CLI section reaches every sink, and becomes one row here', () {
      final stream = LogStream();
      final recorder = _RecordingCliLog();
      final log = FanoutCliLog([recorder, StreamCliLog(stream)]);

      final entry = log.begin('harness link list');
      entry.output('two links');
      entry.end(exitCode: 0, duration: const Duration(milliseconds: 40));

      expect(recorder.commands, ['harness link list']);
      expect(recorder.lines, ['two links']);
      expect(stream.entries.length, 1);
      expect(stream.entries.single.message, 'harness link list');
      expect(stream.entries.single.command!.running, isFalse);
    });
  });
}

class _RecordingAppLog implements AppLog {
  final List<String> messages = [];

  @override
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) => messages.add(message);
}

class _RecordingCliLog implements CliLog {
  final List<String> commands = [];
  final List<String> lines = [];

  @override
  CliLogEntry begin(String command) {
    commands.add(command);
    return _RecordingEntry(lines);
  }
}

class _RecordingEntry implements CliLogEntry {
  _RecordingEntry(this._lines);

  final List<String> _lines;

  @override
  void output(String line, {bool isError = false}) => _lines.add(line);

  @override
  void end({int? exitCode, Duration? duration, String? error}) {}
}
