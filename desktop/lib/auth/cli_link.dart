import 'dart:convert';
import 'dart:io';

import '../core/harness_cli_runner.dart';

/// Result of `harness remote-password set --stdin --json` — sets (or replaces) this machine's
/// persistent remote password, the shared secret another machine's `harness link connect` PAKE
/// handshake authenticates against. The app never sees the password's cryptographic use, only
/// pipes it to the CLI on stdin, the same as typing it at a terminal prompt would.
class RemotePasswordSetResult {
  /// Null on success.
  final String? error;

  /// This machine's fingerprint after the password is set — shown so the user can verify it
  /// matches on the connecting side.
  final String? fingerprint;

  const RemotePasswordSetResult({this.error, this.fingerprint});
}

/// Result of `harness remote-password status --json`.
class RemotePasswordStatus {
  /// Null on success. A query failure, not "no password set" — that's [hasPassword] false.
  final String? error;
  final bool hasPassword;
  final String? fingerprint;
  final DateTime? setAt;

  const RemotePasswordStatus({
    this.error,
    this.hasPassword = false,
    this.fingerprint,
    this.setAt,
  });
}

/// Result of `harness link connect <machineId> --stdin --json` — the password-authenticated
/// replacement for the old token-based `import`.
class CliLinkConnectResult {
  /// Null on success.
  final String? error;

  /// The machineId the CLI actually linked — echoed back from its own success line. Null if
  /// [error] is set, or if the CLI's output didn't match the expected shape.
  final String? linkedMachineId;

  /// The linked machine's fingerprint, for the user to verify.
  final String? fingerprint;

  const CliLinkConnectResult({
    this.error,
    this.linkedMachineId,
    this.fingerprint,
  });
}

/// One row of `harness link list`.
class LinkedMachine {
  final String machineId;
  final String fingerprint;

  /// As printed by the CLI: `YYYY-MM-DD HH:MM`.
  final String linkedAt;

  const LinkedMachine({
    required this.machineId,
    required this.fingerprint,
    required this.linkedAt,
  });
}

class CliLinkListResult {
  /// Null on success (an empty list is success with zero rows, not an error).
  final String? error;
  final List<LinkedMachine> machines;

  const CliLinkListResult({this.error, this.machines = const []});
}

class CliLink {
  final HarnessCliRunner _runner;

  CliLink({HarnessCliRunner? runner}) : _runner = runner ?? HarnessCliRunner();
  static final _listRowPattern = RegExp(
    r'^\s*\d+\.\s+(\S+)\s+(\S+)\s+\(linked\s+([\d-]+\s[\d:]+)\)',
    multiLine: true,
  );

  /// Sets (or replaces) this machine's persistent remote password. Stays valid until changed —
  /// there is no expiry, unlike the old 7-day link tokens.
  Future<RemotePasswordSetResult> setRemotePassword(String password) async {
    final invocation = await _runStdinNdjson(
      ['remote-password', 'set', '--stdin', '--json'],
      password,
      label: 'harness remote-password set',
    );
    if (invocation.error != null) {
      return RemotePasswordSetResult(error: invocation.error);
    }
    final json = invocation.result!;
    if (json['ok'] == true) {
      return RemotePasswordSetResult(
        fingerprint: json['fingerprint'] as String?,
      );
    }
    return RemotePasswordSetResult(
      error: json['error'] as String? ?? 'harness remote-password set failed',
    );
  }

  /// Whether this machine currently has a remote password set, and its fingerprint/set time.
  Future<RemotePasswordStatus> remotePasswordStatus() async {
    final invocation = await _runJson([
      'remote-password',
      'status',
      '--json',
    ], label: 'harness remote-password status');
    if (invocation.error != null) {
      return RemotePasswordStatus(error: invocation.error);
    }
    final json = invocation.result!;
    final setAtMs = json['setAt'];
    return RemotePasswordStatus(
      hasPassword: json['hasPassword'] == true,
      fingerprint: json['fingerprint'] as String?,
      setAt: setAtMs is num
          ? DateTime.fromMillisecondsSinceEpoch(setAtMs.toInt())
          : null,
    );
  }

  /// Clears this machine's remote password, revoking remote access for anyone who knew it. Null
  /// on success.
  Future<String?> clearRemotePassword() async {
    final invocation = await _runJson([
      'remote-password',
      'clear',
      '--json',
    ], label: 'harness remote-password clear');
    if (invocation.error != null) return invocation.error;
    final json = invocation.result!;
    if (json['ok'] == true) return null;
    return json['error'] as String? ?? 'harness remote-password clear failed';
  }

  /// Connects to [machineId] using the password set with `setRemotePassword` on THAT machine —
  /// the password-authenticated replacement for the old token `import`. [onProgress], if given,
  /// is called with each stage name the CLI reports (`connecting`, `deriving_key`, `exchanging`,
  /// `verifying`) as the handshake proceeds; best-effort UI feedback only, never required for
  /// correctness. [displayName], when given, is how the CLI's error messages name the machine —
  /// otherwise they show the raw [machineId], which is all a terminal user would have.
  Future<CliLinkConnectResult> connect(
    String machineId,
    String password, {
    void Function(String stage)? onProgress,
    String? displayName,
  }) async {
    final invocation = await _runStdinNdjson(
      [
        'link',
        'connect',
        machineId,
        '--stdin',
        '--json',
        if (displayName != null && displayName.isNotEmpty)
          '--name=$displayName',
      ],
      password,
      label: 'harness link connect',
      onLine: (json) {
        final stage = json['stage'];
        if (stage is String) onProgress?.call(stage);
      },
    );
    if (invocation.error != null) {
      return CliLinkConnectResult(error: invocation.error);
    }
    final json = invocation.result!;
    if (json['ok'] == true) {
      return CliLinkConnectResult(
        linkedMachineId: json['machineId'] as String? ?? machineId,
        fingerprint: json['fingerprint'] as String?,
      );
    }
    // `message` is the CLI's human sentence for the code (what it prints without --json); `error`
    // is the bare code and only a fallback for a CLI too old to send one.
    return CliLinkConnectResult(
      error:
          json['message'] as String? ??
          json['error'] as String? ??
          'harness link connect failed',
    );
  }

  /// Machines this one currently trusts (CLI-to-CLI, not the browser-pairing list).
  Future<CliLinkListResult> list() async {
    final response = await _run(['link', 'list']);
    if (response.error != null) {
      return CliLinkListResult(error: response.error);
    }
    final result = response.result!;
    final stdoutText = (result.stdout as String).trim();
    if (result.exitCode != 0) {
      return CliLinkListResult(
        error: _errorMessage(result, stdoutText, 'harness link list'),
      );
    }
    return CliLinkListResult(
      machines: [
        for (final m in _listRowPattern.allMatches(stdoutText))
          LinkedMachine(
            machineId: m.group(1)!,
            fingerprint: m.group(2)!,
            linkedAt: m.group(3)!,
          ),
      ],
    );
  }

  /// Removes a linked machine's trust pin. Null on success.
  Future<String?> unlink(String machineId) async {
    final response = await _run(['link', 'unlink', machineId]);
    if (response.error != null) return response.error;
    final result = response.result!;
    if (result.exitCode == 0) return null;
    return _errorMessage(
      result,
      (result.stdout as String).trim(),
      'harness link unlink',
    );
  }

  String _errorMessage(
    ProcessResult result,
    String stdoutText,
    String command,
  ) {
    final stderrText = (result.stderr as String).trim();
    final message = stderrText.isNotEmpty ? stderrText : stdoutText;
    return message.isEmpty
        ? '$command failed (exit ${result.exitCode})'
        : message;
  }

  Future<_CliInvocation> _run(List<String> arguments) async {
    try {
      return _CliInvocation(result: await _runner.run(arguments));
    } on ProcessException catch (error) {
      return _CliInvocation(
        error: 'Could not run the Harness CLI: ${error.message}',
      );
    }
  }

  /// One-shot NDJSON invocation (no stdin) — spawns [arguments], runs to completion, and returns
  /// the last valid JSON line decoded (a one-shot `--json` command prints exactly one such line —
  /// `{"ok":true,...}` / `{"ok":false,"error":...}`, or a bare status object with no `ok` key for
  /// commands like `remote-password status` that always succeed if they ran at all), or an error
  /// if the CLI could not be run or never produced a JSON line.
  Future<_ResultInvocation> _runJson(
    List<String> arguments, {
    required String label,
  }) async {
    final response = await _run(arguments);
    if (response.error != null) return _ResultInvocation(error: response.error);
    final result = response.result!;
    final stdoutText = result.stdout as String;
    Map<String, dynamic>? resultJson;
    for (final raw in stdoutText.split('\n')) {
      final line = raw.trim();
      if (line.isEmpty) continue;
      Map<String, dynamic> json;
      try {
        json = jsonDecode(line) as Map<String, dynamic>;
      } catch (_) {
        continue;
      }
      resultJson = json;
    }
    if (resultJson == null) {
      return _ResultInvocation(
        error: _errorMessage(result, stdoutText.trim(), label),
      );
    }
    return _ResultInvocation(result: resultJson);
  }

  /// Streaming NDJSON invocation with piped stdin — spawns [arguments], writes [stdinLine]
  /// followed by a newline, closes stdin, then streams NDJSON off stdout: a line carrying a
  /// `stage` key is a progress event and goes to [onLine]; every other valid JSON line is a
  /// candidate final result (the last one wins — `link connect`/`remote-password set` print
  /// exactly one such line, `{"ok":true,...}` or `{"ok":false,"error":...}`). Mirrors
  /// `CliLogin.login()`'s NDJSON-over-stdout parsing style, plus the stdin write this app's other
  /// CLI invocations don't need.
  Future<_ResultInvocation> _runStdinNdjson(
    List<String> arguments,
    String stdinLine, {
    required String label,
    void Function(Map<String, dynamic> json)? onLine,
  }) async {
    final Process process;
    try {
      process = await _runner.start(arguments);
    } on ProcessException catch (error) {
      return _ResultInvocation(
        error: 'Could not run the Harness CLI: ${error.message}',
      );
    }
    // Drained unconditionally: an unread stderr pipe can fill its OS buffer and block the child
    // process from writing more output at all, which would otherwise look exactly like a hang.
    process.stderr.drain<void>();
    process.stdin.writeln(stdinLine);
    await process.stdin.close();
    Map<String, dynamic>? resultJson;
    final lines = process.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter());
    await for (final raw in lines) {
      final line = raw.trim();
      if (line.isEmpty) continue;
      Map<String, dynamic> json;
      try {
        json = jsonDecode(line) as Map<String, dynamic>;
      } catch (_) {
        continue;
      }
      if (json.containsKey('stage')) {
        onLine?.call(json);
      } else {
        resultJson = json;
      }
    }
    final exitCode = await process.exitCode;
    if (resultJson == null) {
      return _ResultInvocation(
        error: exitCode != 0
            ? '$label failed (exit $exitCode)'
            : '$label produced no result',
      );
    }
    return _ResultInvocation(result: resultJson);
  }
}

class _CliInvocation {
  final ProcessResult? result;
  final String? error;

  const _CliInvocation({this.result, this.error})
    : assert((result == null) != (error == null));
}

class _ResultInvocation {
  final Map<String, dynamic>? result;
  final String? error;

  const _ResultInvocation({this.result, this.error})
    : assert((result == null) != (error == null));
}
