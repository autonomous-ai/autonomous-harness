import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/bounded_process.dart';

class _FakeProcess implements Process {
  final stdoutController = StreamController<List<int>>();
  final stderrController = StreamController<List<int>>();
  final exit = Completer<int>();
  final signals = <ProcessSignal>[];

  @override
  Stream<List<int>> get stdout => stdoutController.stream;

  @override
  Stream<List<int>> get stderr => stderrController.stream;

  @override
  Future<int> get exitCode => exit.future;

  @override
  bool kill([ProcessSignal signal = ProcessSignal.sigterm]) {
    signals.add(signal);
    return true;
  }

  @override
  int get pid => 4242;

  @override
  IOSink get stdin => throw UnimplementedError();

  Future<void> closeStreams() async {
    await stdoutController.close();
    await stderrController.close();
  }
}

void main() {
  test('streams may close before the child exits', () async {
    final process = _FakeProcess();
    final running = runOwnedProcessBounded(
      executable: 'fake',
      arguments: const ['version'],
      startProcess: (executable, arguments, {environment}) async => process,
      timeout: const Duration(milliseconds: 100),
    );

    await Future<void>.delayed(Duration.zero);
    process.stdoutController.add(utf8.encode('9.9.9\n'));
    await process.closeStreams();
    await Future<void>.delayed(const Duration(milliseconds: 10));
    process.exit.complete(0);

    final result = await running.timeout(const Duration(milliseconds: 250));
    expect(result.exitCode, 0);
    expect(result.stdout, '9.9.9');
    expect(process.signals, isEmpty);
  });

  test('a child that never exits receives a termination request', () async {
    final process = _FakeProcess();
    addTearDown(process.closeStreams);

    final result = await runOwnedProcessBounded(
      executable: 'fake',
      arguments: const ['version'],
      startProcess: (executable, arguments, {environment}) async => process,
      timeout: const Duration(milliseconds: 20),
    ).timeout(const Duration(milliseconds: 250));

    expect(result.exitCode, 124);
    expect(process.signals, [ProcessSignal.sigkill]);
    expect(result.stderr, contains('timed out after'));
    expect(result.stderr, contains('process termination requested'));
  });

  test('an exited child cannot hang on streams that stay open', () async {
    final process = _FakeProcess();
    addTearDown(process.closeStreams);
    process.exit.complete(0);

    final result = await runOwnedProcessBounded(
      executable: 'fake',
      arguments: const ['version'],
      startProcess: (executable, arguments, {environment}) async => process,
      timeout: const Duration(milliseconds: 20),
    ).timeout(const Duration(milliseconds: 250));

    expect(result.exitCode, 124);
    expect(process.signals, [ProcessSignal.sigkill]);
    expect(result.stderr, contains('timed out after'));
  });
}
