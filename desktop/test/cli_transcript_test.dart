// The CLI transcript: the app drives two CLIs, and "the CLI did something
// unexpected" is the most common shape of a fault here. What matters as much as
// recording it is that a session printed by `harness auth status --json` does
// not end up in a file with a fortnight's retention.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/harness_cli_runner.dart';
import 'package:harness/logging/cli_log.dart';
import 'package:harness/logging/log_stream.dart';
import 'package:harness/logging/log_stream_sinks.dart';

void main() {
  late LogStream stream;
  late CliLog previous;

  setUp(() {
    stream = LogStream();
    previous = cliLog;
    cliLog = StreamCliLog(stream);
  });
  tearDown(() => cliLog = previous);

  test(
    'a run is logged as the command a person reads, not its real argv',
    () async {
      final runner = HarnessCliRunner(
        harnessHome: Directory('/nonexistent/.harness'),
        environment: const {'HOME': '/nonexistent'},
        runProcess: (executable, arguments, {environment}) async =>
            ProcessResult(1, 0, 'signed in as dev@autonomous.ai', ''),
      );

      await runner.run(['auth', 'status', '--json']);

      final entry = stream.entries.single;
      expect(entry.message, 'harness auth status --json');
      expect(entry.category, 'cli');
      expect(entry.command!.exitCode, 0);
      expect(entry.command!.output, ['  signed in as dev@autonomous.ai']);
    },
  );

  test(
    'a token printed by the CLI is redacted before it is recorded',
    () async {
      final runner = HarnessCliRunner(
        harnessHome: Directory('/nonexistent/.harness'),
        environment: const {'HOME': '/nonexistent'},
        runProcess: (executable, arguments, {environment}) async =>
            ProcessResult(
              1,
              0,
              '{"session_token": "sess-THIS-MUST-NOT-BE-LOGGED", "email": "dev@x.ai"}',
              '',
            ),
      );

      await runner.run(['auth', 'status', '--json']);

      final output = stream.entries.single.command!.output.join('\n');
      expect(output, isNot(contains('THIS-MUST-NOT-BE-LOGGED')));
      expect(output, contains('<redacted>'));
      // The fields that make the line worth keeping survive.
      expect(output, contains('dev@x.ai'));
    },
  );

  test('a failed run records the exit code and the stderr behind it', () async {
    final runner = HarnessCliRunner(
      harnessHome: Directory('/nonexistent/.harness'),
      environment: const {'HOME': '/nonexistent'},
      runProcess: (executable, arguments, {environment}) async =>
          ProcessResult(1, 3, '', 'no such machine'),
    );

    await runner.run(['link', 'import', 'nope']);

    final entry = stream.entries.single;
    expect(entry.status, LogStatus.failed);
    expect(entry.command!.exitCode, 3);
    expect(entry.command!.output, ['! no such machine']);
  });

  test('a CLI that will not start is recorded, then rethrown', () async {
    final runner = HarnessCliRunner(
      harnessHome: Directory('/nonexistent/.harness'),
      environment: const {'HOME': '/nonexistent'},
      runProcess: (executable, arguments, {environment}) async =>
          throw const ProcessException('harness', [], 'No such file'),
    );

    await expectLater(runner.run(['start']), throwsA(isA<ProcessException>()));

    final entry = stream.entries.single;
    expect(entry.status, LogStatus.failed);
    expect(entry.command!.error, contains('No such file'));
  });
}
