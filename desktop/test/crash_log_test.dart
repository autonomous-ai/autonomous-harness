import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/crash_log.dart';

void main() {
  test('an error reaches the log with its stack', () {
    final directory = Directory.systemTemp.createTempSync('harness-v2-crash-test-');
    final file = File('${directory.path}/errors.log');
    CrashLog.testFile = file;
    addTearDown(() { CrashLog.testFile = null; directory.deleteSync(recursive: true); });

    CrashLog.record(
      TypeError(),
      StackTrace.fromString(
        '#0 someFrame (package:harness/somewhere.dart:1:2)',
      ),
      context: 'renderer',
    );

    expect(file.existsSync(), isTrue);
    final text = file.readAsStringSync();
    expect(text, contains('[renderer]'));
    expect(
      text,
      contains('someFrame'),
      reason: 'the stack is the whole point — a message alone names no line',
    );
    file.deleteSync();
  });

  test('installing keeps the handler that was already there', () {
    var previousRan = false;
    FlutterError.onError = (_) => previousRan = true;
    CrashLog.install();

    FlutterError.onError!(FlutterErrorDetails(exception: StateError('boom')));

    expect(
      previousRan,
      isTrue,
      reason: 'adding a copy must not silence what already printed',
    );
  });
}
