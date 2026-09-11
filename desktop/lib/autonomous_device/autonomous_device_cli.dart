import 'dart:async';
import 'dart:convert';

import '../core/harness_cli_runner.dart';
import '../core/test_run.dart';

/// Matches the original Harness core.normalizeCode without exposing the secret.
String normalizeAutonomousDeviceCode(String code) => code
    .toUpperCase()
    .replaceAll(RegExp(r'[\s\-·_]'), '')
    .replaceAll('I', '1')
    .replaceAll('L', '1')
    .replaceAll('O', '0')
    .replaceAll('U', 'V');

class AutonomousDeviceCliException implements Exception {
  const AutonomousDeviceCliException(this.code, this.message);
  final String code;
  final String message;
  String get userMessage => switch (code) {
    'CODE_MISMATCH' => 'That code did not match. Generate a new code on your Autonomous device, then try again.',
    'RATE_LIMITED' => 'Too many pairing attempts. Wait five minutes, then generate a new code on your Autonomous device and try again.',
    'EXPIRED' => 'The pairing code expired. Generate a new code on your Autonomous device, then try again.',
    _ => message,
  };
  bool get unsupported =>
      const {'NOT_FOUND', 'UNSUPPORTED', 'UNKNOWN_COMMAND'}.contains(code);
  @override
  String toString() => message;
}

/// The CLI owns credentials and Autonomous device trust. Pair codes remain in memory only.
class AutonomousDeviceCli {
  AutonomousDeviceCli({HarnessCliRunner? runner})
    : _runner = runner ?? HarnessCliRunner();
  final HarnessCliRunner _runner;

  Future<Map<String, dynamic>> status() => command('status');
  Future<Map<String, dynamic>> list() => command('list');
  Future<Map<String, dynamic>> discover() => command('discover');
  Future<Map<String, dynamic>> pair({
    required String code,
    required String deviceId,
  }) async {
    final normalized = normalizeAutonomousDeviceCode(code);
    if (!RegExp(r'^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$')
            .hasMatch(normalized) ||
        deviceId.isEmpty) {
      throw const AutonomousDeviceCliException(
        'BAD_REQUEST',
        'Enter the six-character code shown on your Autonomous device.',
      );
    }
    return command(
      'pair',
      arguments: ['--code-stdin', '--device', deviceId],
      secretStdin: normalized,
    );
  }

  Future<Map<String, dynamic>> revoke(String id) =>
      command('revoke', arguments: [id]);

  Future<Map<String, dynamic>> command(
    String operation, {
    List<String> arguments = const [],
    String? secretStdin,
  }) async {
    if (kUnderTest) {
      throw const AutonomousDeviceCliException(
        'TEST_DISABLED',
        'Inject a fake AutonomousDeviceCli in tests.',
      );
    }
    // start logs lifecycle only; run would persist the secret code in stdout.
    final process = await _runner.start([
      'autonomous-device',
      operation,
      ...arguments,
      '--json',
    ]);
    final stdout = process.stdout.transform(utf8.decoder).join();
    final stderr = process.stderr.transform(utf8.decoder).join();
    if (secretStdin != null) process.stdin.writeln(secretStdin);
    await process.stdin.close();
    final int exitCode;
    try {
      exitCode = await process.exitCode.timeout(
        Duration(seconds: operation == 'pair' ? 50 : 35),
      );
    } on TimeoutException {
      process.kill();
      // A timed-out mutation may have succeeded. Read state before retrying it.
      throw const AutonomousDeviceCliException(
        'TIMEOUT',
        'The command timed out. Refresh the Autonomous device status before trying again.',
      );
    }
    final output = await stdout;
    final errorOutput = await stderr;
    Map<String, dynamic>? result;
    for (final line in const LineSplitter().convert(output)) {
      try {
        final value = jsonDecode(line);
        if (value is Map<String, dynamic>) result = value;
      } on FormatException {
        /* Ignore CLI startup progress. */
      }
    }
    final error = result?['error'];
    if (error is Map) {
      throw AutonomousDeviceCliException(
        error['code']?.toString() ?? 'FAILED',
        error['message']?.toString() ?? 'The Autonomous device command failed.',
      );
    }
    if (exitCode != 0 || result == null) {
      final unsupported = RegExp(
        r'unknown command|unknown subcommand|unrecognized command',
        caseSensitive: false,
      ).hasMatch('$output\n$errorOutput');
      throw AutonomousDeviceCliException(
        unsupported ? 'UNKNOWN_COMMAND' : 'FAILED',
        unsupported ? 'This Harness CLI does not support Autonomous devices.' : 'The Autonomous device command failed. Check that Harness is running and the device is on the same network.',
      );
    }
    return result;
  }
}
