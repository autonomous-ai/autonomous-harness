import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../core/harness_cli_runner.dart';
import 'sign_in_client.dart';

class CliAuthStatus {
  final bool loggedIn;

  /// Signed in, but the CLI could not refresh the token just now (no network, SSO down). Still
  /// [loggedIn]: the session is on disk and the daemon runs on it; only the backend is out of reach.
  final bool offline;
  final String? computerId;
  final String? machineId;
  final String? autonomousEnv;

  const CliAuthStatus({
    required this.loggedIn,
    this.offline = false,
    this.computerId,
    this.machineId,
    this.autonomousEnv,
  });

  factory CliAuthStatus.fromJson(Map<String, dynamic> json) => CliAuthStatus(
    loggedIn: json['loggedIn'] == true,
    offline: json['offline'] == true,
    computerId: json['computerId'] as String?,
    machineId: json['machineId'] as String?,
    autonomousEnv: json['autonomousEnv'] as String?,
  );
}

/// Thrown when the `harness` CLI itself could not be run at all (the managed
/// runtime, installed launcher, and PATH are all unavailable) — distinct from
/// the CLI running fine and reporting "not signed in".
class CliNotAvailableException implements Exception {
  final String message;
  CliNotAvailableException(this.message);
  @override
  String toString() => message;
}

/// Talks to the local `harness` CLI for everything auth-related: whether this computer already has a
/// signed-in session, and driving `harness login --json`'s NDJSON event stream when it does not. The
/// CLI owns the SSO session end to end (`~/.harness/auth/session.json`) — this app never sees, stores,
/// or refreshes an access token itself.
class CliLogin implements SignInClient {
  final HarnessCliRunner _runner;
  Process? _activeProcess;
  int _loginRevision = 0;

  CliLogin({HarnessCliRunner? runner}) : _runner = runner ?? HarnessCliRunner();

  @override
  Future<CliAuthStatus> checkStatus() async {
    final result = await _run(['auth', 'status', '--json']);
    final line = _lastNonEmptyLine(result.stdout as String);
    if (line == null) {
      throw CliNotAvailableException(
        'Could not run the harness CLI (${(result.stderr as String).trim().isEmpty ? 'exit ${result.exitCode}' : (result.stderr as String).trim()}). '
        'Make sure it is installed and try again.',
      );
    }
    return CliAuthStatus.fromJson(jsonDecode(line) as Map<String, dynamic>);
  }

  /// Runs `harness login --force --json`. This is only ever reached from [LoginScreen], i.e. the app
  /// has already decided this computer is signed out — so a stale-but-present session file on disk
  /// must not short-circuit into a silent refresh attempt (`loginCommand`'s `readAuthSession() &&
  /// !force` branch), which just re-reports the same failure forever instead of opening a fresh SSO
  /// flow. Calls [onAuthorizeUrl] as soon as the CLI reports the SSO page to show, then resolves once
  /// the CLI's own loopback callback server completes the flow (or throws on failure/cancellation).
  /// The process is killed if [cancel] is called while this is in flight.
  @override
  Future<void> login({
    required void Function(String url) onAuthorizeUrl,
  }) async {
    // A cancelled spawn can finish after a replacement login has started.
    // Each process owns only its attempt, including its eventual cleanup.
    final revision = ++_loginRevision;
    final Process process;
    try {
      process = await _runner.start(['login', '--force', '--json']);
    } catch (error) {
      throw CliNotAvailableException('Could not run the harness CLI: $error');
    }
    if (revision != _loginRevision) {
      unawaited(process.stdout.drain<void>());
      unawaited(process.stderr.drain<void>());
      process.kill();
      throw StateError('Sign-in was cancelled.');
    }
    _activeProcess = process;
    // Drained unconditionally: an unread stderr pipe can fill its OS buffer and block the child
    // process from writing more output at all, which would otherwise look exactly like a hang here.
    process.stderr.drain<void>();
    try {
      final lines = process.stdout
          .transform(utf8.decoder)
          .transform(const LineSplitter());
      var gotResult = false;
      var success = false;
      String? message;
      await for (final raw in lines) {
        if (revision != _loginRevision) continue;
        final line = raw.trim();
        if (line.isEmpty) continue;
        Map<String, dynamic> json;
        try {
          json = jsonDecode(line) as Map<String, dynamic>;
        } catch (_) {
          continue;
        }
        switch (json['type']) {
          case 'authorize_url':
            final url = json['url'];
            if (url is String) onAuthorizeUrl(url);
          case 'result':
            gotResult = true;
            success = json['status'] == 'success';
            message = json['message'] as String?;
        }
      }
      final exitCode = await process.exitCode;
      if (revision != _loginRevision) {
        throw StateError('Sign-in was cancelled.');
      }
      if (!gotResult || !success) {
        throw StateError(
          message ??
              (exitCode != 0
                  ? 'Sign-in was cancelled.'
                  : 'Sign-in did not complete.'),
        );
      }
    } finally {
      if (identical(_activeProcess, process)) _activeProcess = null;
    }
  }

  /// Aborts this attempt even if its process has not finished starting yet —
  /// reached from the embedded sign-in webview's close button.
  @override
  void cancel() {
    ++_loginRevision;
    final process = _activeProcess;
    _activeProcess = null;
    process?.kill();
  }

  @override
  Future<void> logout() async {
    try {
      await _run(['logout']);
    } catch (_) {
      // Best-effort: local app state is cleared regardless by the caller.
    }
  }

  Future<ProcessResult> _run(List<String> arguments) async {
    try {
      return await _runner.run(arguments);
    } catch (error) {
      throw CliNotAvailableException('Could not run the harness CLI: $error');
    }
  }

  String? _lastNonEmptyLine(String stdout) {
    final lines = stdout.trim().split('\n').where((l) => l.trim().isNotEmpty);
    return lines.isEmpty ? null : lines.last.trim();
  }
}
