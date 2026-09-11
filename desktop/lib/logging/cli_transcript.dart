/// Records a child process into [cliLog] — the transcript both the daily file
/// and Settings ▸ Debug are built from.
///
/// One place, used by [HarnessCliRunner]: "the CLI did something unexpected"
/// is the most common shape of a fault here, since the app itself holds almost
/// no logic.
///
/// **A command line and its output are logged; its environment is not.** A
/// secret handed to a child belongs in its environment precisely so it stays
/// out of argv, and writing the environment here would undo that. What the
/// child *prints* can still carry one — `harness auth status --json` prints a
/// session — so every line goes through [redactSecretsInText] first.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'cli_log.dart';
import 'redact.dart';

/// Output lines kept per invocation. Enough to see what a command answered,
/// short of pasting a whole `--json` catalogue into the day's log.
const int _maxOutputLines = 40;

/// Longest single line kept. A base64 blob buries the lines either side of it.
const int _maxLineChars = 500;

/// Runs [call] as one logged invocation of [command].
///
/// [command] is the display line — `harness auth status --json` — not the real
/// argv, which for the managed tier is `<node> <cli.js> …` and reads as noise.
Future<ProcessResult> logProcessRun(
  String command,
  Future<ProcessResult> Function() call,
) async {
  final entry = cliLog.begin(redactSecretsInText(command));
  final started = DateTime.now();
  try {
    final result = await call();
    _writeOutput(entry, result);
    entry.end(
      exitCode: result.exitCode,
      duration: DateTime.now().difference(started),
    );
    return result;
  } on Object catch (error) {
    // A missing binary is a ProcessException, and it is the single most useful
    // line this log can hold — so it is recorded before it is rethrown.
    entry.end(error: '$error', duration: DateTime.now().difference(started));
    rethrow;
  }
}

/// Opens a section for a long-running child and closes it when the child exits.
///
/// Its output is not captured: the caller owns those streams (that is why it
/// asked for a [Process]), and a second listener would steal the bytes it is
/// reading. So a streamed command records that it started, and how it ended.
Future<Process> logProcessStart(
  String command,
  Future<Process> Function() call,
) async {
  final entry = cliLog.begin(redactSecretsInText(command));
  final started = DateTime.now();
  final Process process;
  try {
    process = await call();
  } on Object catch (error) {
    entry.end(error: '$error', duration: DateTime.now().difference(started));
    rethrow;
  }
  unawaited(
    process.exitCode
        .then(
          (code) => entry.end(
            exitCode: code,
            duration: DateTime.now().difference(started),
          ),
        )
        // The child's fate is the caller's business; this listener only reports
        // it, so its own failure must not become an unhandled error.
        .catchError(
          (Object error) => entry.end(
            error: '$error',
            duration: DateTime.now().difference(started),
          ),
        ),
  );
  return process;
}

/// Writes a finished command's stdout and stderr into its section, redacted,
/// clipped, and stderr tagged.
void _writeOutput(CliLogEntry entry, ProcessResult result) {
  var budget = _maxOutputLines;
  budget = _writeStream(entry, result.stdout, budget, isError: false);
  budget = _writeStream(entry, result.stderr, budget, isError: true);
}

int _writeStream(
  CliLogEntry entry,
  Object? stream,
  int budget, {
  required bool isError,
}) {
  if (budget <= 0) return budget;
  final text = stream is String ? stream : '${stream ?? ''}';
  final lines = const LineSplitter()
      .convert(redactSecretsInText(text))
      .where((line) => line.trim().isNotEmpty)
      .toList();
  for (final line in lines.take(budget)) {
    entry.output(
      line.length > _maxLineChars
          ? '${line.substring(0, _maxLineChars)}…'
          : line,
      isError: isError,
    );
  }
  final kept = lines.length < budget ? lines.length : budget;
  if (lines.length > kept) {
    entry.output(
      '… ${lines.length - kept} more lines not kept',
      isError: isError,
    );
  }
  return budget - kept;
}
