import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/core/harness_cli_runner.dart';

class _Runner extends HarnessCliRunner {
  final starts = <Completer<Process>>[];
  @override
  Future<Process> start(List<String> arguments) {
    expect(arguments, ['login', '--force', '--json']);
    final start = Completer<Process>();
    starts.add(start);
    return start.future;
  }
}

class _Process implements Process {
  final output = StreamController<List<int>>();
  final errors = StreamController<List<int>>();
  final ended = Completer<int>();
  var kills = 0;
  void emit(Map<String, dynamic> event) =>
      output.add(utf8.encode('${jsonEncode(event)}\n'));
  void finish() {
    unawaited(output.close());
    unawaited(errors.close());
    if (!ended.isCompleted) ended.complete(0);
  }

  @override
  Stream<List<int>> get stdout => output.stream;
  @override
  Stream<List<int>> get stderr => errors.stream;
  @override
  Future<int> get exitCode => ended.future;
  @override
  bool kill([ProcessSignal signal = ProcessSignal.sigterm]) {
    kills++;
    // A signalled process need not exit synchronously. Tests explicitly finish
    // it later, including after a replacement sign-in has already started.
    return true;
  }

  @override
  int get pid => 1;
  @override
  IOSink get stdin => throw UnimplementedError();
}

void main() {
  test(
    'cancel while the CLI starts ignores its late URL and stops that process',
    () async {
      final runner = _Runner();
      final cli = CliLogin(runner: runner);
      final urls = <String>[];
      final login = cli.login(onAuthorizeUrl: urls.add);
      final result = expectLater(login, throwsStateError);
      cli.cancel();
      final process = _Process();
      process.emit({
        'type': 'authorize_url',
        'url': 'https://auth.example/old',
      });
      process.emit({'type': 'result', 'status': 'success'});
      runner.starts.single.complete(process);
      process.finish();
      await result;
      expect(process.kills, 1);
      expect(urls, isEmpty);
    },
  );

  test(
    'a cancelled process cannot clear or complete its replacement',
    () async {
      final runner = _Runner();
      final cli = CliLogin(runner: runner);
      final urls = <String>[];
      final first = cli.login(onAuthorizeUrl: urls.add);
      final firstResult = expectLater(first, throwsStateError);
      final old = _Process();
      runner.starts.first.complete(old);
      await Future<void>.delayed(Duration.zero);
      cli.cancel();
      final second = cli.login(onAuthorizeUrl: urls.add);
      final secondResult = expectLater(second, throwsStateError);
      final current = _Process();
      runner.starts.last.complete(current);
      await Future<void>.delayed(Duration.zero);
      old.emit({'type': 'authorize_url', 'url': 'https://auth.example/old'});
      old.emit({'type': 'result', 'status': 'success'});
      old.finish();
      await firstResult;
      expect(urls, isEmpty);
      cli.cancel();
      expect(current.kills, 1);
      current.finish();
      await secondResult;
    },
  );

  test(
    'successful CLI sign-in still publishes its URL and completes',
    () async {
      final runner = _Runner();
      final cli = CliLogin(runner: runner);
      final urls = <String>[];
      final login = cli.login(onAuthorizeUrl: urls.add);
      final process = _Process();
      runner.starts.single.complete(process);
      process.emit({
        'type': 'authorize_url',
        'url': 'https://auth.example/current',
      });
      process.emit({'type': 'result', 'status': 'success'});
      process.finish();
      await login;
      cli.cancel();
      expect(urls, ['https://auth.example/current']);
      expect(process.kills, 0);
    },
  );

  group('CliAuthStatus.fromJson', () {
    test('parses a full logged-in payload', () {
      final status = CliAuthStatus.fromJson({
        'loggedIn': true,
        'computerId': 'a' * 32,
        'machineId': 'm_123',
        'autonomousEnv': 'prod',
        'expiresAt': 1234567890,
      });
      expect(status.loggedIn, isTrue);
      expect(status.computerId, 'a' * 32);
      expect(status.machineId, 'm_123');
      expect(status.autonomousEnv, 'prod');
    });

    test('reads the CLI\'s offline flag: signed in, backend out of reach', () {
      final status = CliAuthStatus.fromJson({
        'loggedIn': true,
        'offline': true,
        'machineId': 'm_123',
      });
      expect(status.loggedIn, isTrue);
      expect(status.offline, isTrue);
      expect(CliAuthStatus.fromJson({'loggedIn': true}).offline, isFalse);
    });

    test('parses a logged-out payload with no other fields', () {
      final status = CliAuthStatus.fromJson({'loggedIn': false});
      expect(status.loggedIn, isFalse);
      expect(status.computerId, isNull);
      expect(status.machineId, isNull);
      expect(status.autonomousEnv, isNull);
    });

    test('treats a missing/non-true loggedIn field as logged out', () {
      expect(CliAuthStatus.fromJson({}).loggedIn, isFalse);
      expect(CliAuthStatus.fromJson({'loggedIn': 'true'}).loggedIn, isFalse);
    });
  });
}
