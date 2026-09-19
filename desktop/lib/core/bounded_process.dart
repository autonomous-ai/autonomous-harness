// Bounded owned child-process runner, independent of WSL.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

typedef OwnedProcessStarter = Future<Process> Function(
  String executable,
  List<String> arguments, {
  Map<String, String>? environment,
});

/// Starts one owned child, captures both output streams from the moment they
/// are attached, and applies one deadline to exit and stream completion.
///
/// Capturing the completion futures before waiting for [Process.exitCode] is
/// deliberate. A short-lived child may close both streams before it exits; an
/// `asFuture` installed afterward never sees those done events. Conversely, a
/// child may exit while an inherited stream handle remains open. The same
/// deadline bounds that drain as well, so neither ordering can hold startup
/// open forever.
Future<ProcessResult> runOwnedProcessBounded({
  required String executable,
  required List<String> arguments,
  required OwnedProcessStarter startProcess,
  required Duration timeout,
  Map<String, String>? environment,
  Encoding outputEncoding = utf8,
  bool stripNulls = false,
  void Function(String line)? onOutput,
}) async {
  final Process process;
  try {
    process = await startProcess(
      executable,
      arguments,
      environment: environment,
    );
  } on ProcessException catch (error) {
    return ProcessResult(0, 127, '', error.message);
  }

  final stdoutLines = <String>[];
  final stderrLines = <String>[];
  final stdoutDone = Completer<void>();
  final stderrDone = Completer<void>();

  String clean(String line) =>
      stripNulls ? line.replaceAll('\u0000', '') : line;

  void complete(Completer<void> done) {
    if (!done.isCompleted) done.complete();
  }

  final stdoutSubscription = process.stdout
      .transform(outputEncoding.decoder)
      .transform(const LineSplitter())
      .listen(
        (line) {
          final value = clean(line);
          stdoutLines.add(value);
          if (value.trim().isNotEmpty) onOutput?.call(value);
        },
        onError: (Object error) {
          // A failure READING this stream is recorded on its own side: callers
          // surface stderrLines as the child's error output, and a stdout
          // transport error is not something the child said.
          stdoutLines.add('failed to read process stdout: $error');
          complete(stdoutDone);
        },
        onDone: () => complete(stdoutDone),
      );
  final stderrSubscription = process.stderr
      .transform(outputEncoding.decoder)
      .transform(const LineSplitter())
      .listen(
        (line) => stderrLines.add(clean(line)),
        onError: (Object error) {
          stderrLines.add('failed to read process stderr: $error');
          complete(stderrDone);
        },
        onDone: () => complete(stderrDone),
      );

  var timedOut = false;
  var terminationRequested = false;
  int exitCode;
  try {
    final completed = await Future.wait<Object?>([
      process.exitCode,
      stdoutDone.future,
      stderrDone.future,
    ]).timeout(timeout);
    exitCode = completed.first! as int;
  } on TimeoutException {
    timedOut = true;
    terminationRequested = process.kill(ProcessSignal.sigkill);
    // Cancellation is cleanup after the deadline, not another wait that may
    // itself be held by a broken stream implementation.
    unawaited(stdoutSubscription.cancel());
    unawaited(stderrSubscription.cancel());
    exitCode = 124;
  }

  if (timedOut) {
    stderrLines.add(
      terminationRequested
          ? 'timed out after $timeout; process termination requested'
          : 'timed out after $timeout; process could not be terminated',
    );
  }
  return ProcessResult(
    process.pid,
    exitCode,
    stdoutLines.join('\n'),
    stderrLines.join('\n').trim(),
  );
}
