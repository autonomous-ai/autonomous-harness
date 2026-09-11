/// Where the agent CLIs keep the tokens their usage endpoints want.
///
/// This app reads them; it never writes them and never refreshes them. One
/// sign-in per machine, owned by the CLI that made it. A second copy here
/// would be a second thing to expire and to disagree about.
///
/// **Nothing in this file may be logged.** Every value it returns is a bearer
/// token; the CLI transcript exists precisely so secrets stay out of argv, and
/// a `print` here would undo that. Callers get the token and nothing else —
/// no wrapper carrying it into an error message.
library;

import 'dart:convert';
import 'dart:io';

/// A token, and when it stops working.
class UsageToken {
  const UsageToken({required this.accessToken, this.expiresAt});

  final String accessToken;

  /// When the token expires, when the store said so. Null means unknown, which
  /// is treated as "try it" rather than "assume dead" — the endpoint answering
  /// 401 is a better authority than a clock we may be reading wrong.
  final DateTime? expiresAt;

  /// Already dead, so the request can be skipped and reported as a sign-in
  /// rather than spent as a round trip that will fail.
  bool get isExpired {
    final at = expiresAt;
    return at != null && at.isBefore(DateTime.now());
  }
}

/// Reads the tokens the usage endpoints need, from wherever each CLI put them.
class UsageCredentials {
  const UsageCredentials({this.home, this.runProcess});

  /// Overridden by tests. Null means this machine's real home.
  final String? home;

  /// Overridden by tests so nothing shells out to the real `security`.
  final Future<ProcessResult> Function(String, List<String>)? runProcess;

  String? get _home => home ?? Platform.environment['HOME'];

  /// Claude Code's OAuth token.
  ///
  /// macOS keeps it in the login Keychain and Linux in a file, so both are
  /// tried in that order — and the file is tried on macOS too, because a
  /// Keychain that will not answer (a locked login chain, a Finder launch with
  /// no authorization) is a state, not the end of the road.
  Future<UsageToken?> claude() async {
    final fromKeychain = await _readKeychain();
    final token =
        _parseClaude(fromKeychain) ??
        _parseClaude(_readFile('.claude/.credentials.json'));
    return token;
  }

  /// Codex's OAuth token, written by `codex login`.
  Future<UsageToken?> codex() async {
    final raw = _readFile('.codex/auth.json');
    if (raw == null) return null;
    final decoded = _decode(raw);
    final tokens = decoded?['tokens'];
    if (tokens is! Map) return null;
    final access = tokens['access_token'];
    if (access is! String || access.isEmpty) return null;
    return UsageToken(accessToken: access);
  }

  /// The account id Codex's backend scopes the reading to.
  Future<String?> codexAccountId() async {
    final decoded = _decode(_readFile('.codex/auth.json'));
    final tokens = decoded?['tokens'];
    if (tokens is! Map) return null;
    final id = tokens['account_id'];
    return id is String && id.isNotEmpty ? id : null;
  }

  /// The account Claude Code is signed in as: `oauthAccount.accountUuid` in
  /// `~/.claude.json`, which is where it records who it is on every platform.
  /// The token store — Keychain or `.credentials.json` — does not carry it.
  Future<String?> claudeAccountId() async {
    final profile = _decode(_readFile('.claude.json'))?['oauthAccount'];
    if (profile is! Map) return null;
    final id = profile['accountUuid'];
    return id is String && id.isNotEmpty ? id : null;
  }

  UsageToken? _parseClaude(String? raw) {
    if (raw == null) return null;
    final oauth = _decode(raw)?['claudeAiOauth'];
    if (oauth is! Map) return null;
    final access = oauth['accessToken'];
    if (access is! String || access.isEmpty) return null;
    final expires = oauth['expiresAt'];
    return UsageToken(
      accessToken: access,
      expiresAt: expires is num
          ? DateTime.fromMillisecondsSinceEpoch(expires.round())
          : null,
    );
  }

  Map<String, Object?>? _decode(String? raw) {
    if (raw == null) return null;
    try {
      final decoded = jsonDecode(raw);
      return decoded is Map<String, Object?> ? decoded : null;
    } on FormatException {
      // A half-written credentials file is not news: the CLI that owns it is
      // mid-refresh, and the next poll a minute from now will read it whole.
      return null;
    }
  }

  String? _readFile(String relative) {
    final home = _home;
    if (home == null) return null;
    final file = File('$home${Platform.pathSeparator}$relative');
    if (!file.existsSync()) return null;
    try {
      return file.readAsStringSync();
    } on FileSystemException {
      return null;
    }
  }

  /// The macOS Keychain item Claude Code writes.
  ///
  /// `security` is used rather than a plugin because the item is a plain
  /// generic password and this is one read on a timer — a native channel would
  /// be a second thing to keep in step across two platforms for it.
  Future<String?> _readKeychain() async {
    if (!Platform.isMacOS) return null;
    final run = runProcess ?? Process.run;
    try {
      final result = await run('security', const [
        'find-generic-password',
        '-s',
        'Claude Code-credentials',
        '-w',
      ]);
      if (result.exitCode != 0) return null;
      final out = result.stdout;
      return out is String && out.trim().isNotEmpty ? out.trim() : null;
    } on ProcessException {
      return null;
    }
  }
}
