/// Turning a WS frame into one log line, with credentials removed.
///
/// This exists because the frames worth logging are the ones most likely to
/// carry secrets — a key, a token, a session — and a blind `payload.toString()`
/// would write one to `~/.harness/logs`, where it outlives whatever it was
/// minted for.
///
/// The rule is a DENYLIST on key names rather than an allowlist on purpose. An
/// allowlist would silently drop the next field somebody adds — and the whole
/// value of this log is seeing fields nobody thought to anticipate. The cost is
/// that a new secret must be named here; [_secretKey] is deliberately broad for
/// that reason, and [redactValue] is exported so a test can pin it.
library;

/// Key names whose value must never reach the log. Broad on purpose: matching a
/// field that was not secret costs one unreadable line, missing one that was
/// costs a credential on disk.
final RegExp _secretKey = RegExp(
  r'key|token|secret|password|passphrase|credential|auth|bearer|cookie|session',
  caseSensitive: false,
);

/// Values longer than this are clipped — a log line is read by a person, and a
/// base64 blob buries the fields either side of it.
const int _maxValue = 120;

/// One frame payload as a log line: `{engine: codex, apiKey: <redacted>}`.
///
/// The cap is generous because of what these lines are for. An `agent_create`
/// reply carries a whole `Agent` — id, name, engine, session, status, cwd — and
/// a tighter cap reads better but would cut off the last field in it, which is
/// as likely as any to be the one somebody is reading the log to find. Individual values are
/// still clipped at [_maxValue], so one blob cannot eat the budget.
String summariseForLog(Object? value, {int maxLength = 1200}) {
  final text = redactValue(value);
  return text.length <= maxLength ? text : '${text.substring(0, maxLength)}…';
}

/// [value] rendered for a log, with any entry whose KEY looks secret replaced.
///
/// Recurses into maps and lists so a secret nested a level or two down is
/// caught too.
String redactValue(Object? value) {
  if (value == null) return 'null';
  if (value is Map) {
    final parts = <String>[];
    for (final entry in value.entries) {
      final key = '${entry.key}';
      parts.add(
        _secretKey.hasMatch(key)
            ? '$key: <redacted>'
            : '$key: ${redactValue(entry.value)}',
      );
    }
    return '{${parts.join(', ')}}';
  }
  if (value is List) {
    // Length, not contents: a list in a frame is a batch (agents, models,
    // frames) and printing it whole turns one line into a page.
    return '[${value.length} item${value.length == 1 ? '' : 's'}]';
  }
  final text = '$value';
  return text.length <= _maxValue ? text : '${text.substring(0, _maxValue)}…';
}

/// Anything in free-form CLI output that could be a secret, blanked.
///
/// [redactValue] above works on a decoded frame, where a secret is identified
/// by its KEY. A CLI's stdout has no keys: `harness auth status --json` prints
/// a session, and it goes into the transcript `cliLog` keeps. This is the same denylist idea applied to text — ported from
/// Grid's `redactLogSecrets` (`features/feedback/logic/log_bundle.dart`), so a
/// log line means the same thing in both products. Keep the two in step.
///
/// Conservative on purpose: it would rather blank a harmless high-entropy
/// string than write a live token to a file with a fortnight's retention.
String redactSecretsInText(String input) {
  var out = input;
  for (final rule in _textRedactions) {
    out = out.replaceAllMapped(rule.pattern, rule.replace);
  }
  return out;
}

typedef _Redaction = ({RegExp pattern, String Function(Match) replace});

final List<_Redaction> _textRedactions = [
  // `Bearer <token>` — the shape auth takes if it ever lands in output.
  (
    pattern: RegExp(r'(Bearer\s+)[A-Za-z0-9._\-]{8,}', caseSensitive: false),
    replace: (m) => '${m[1]}<redacted>',
  ),
  // Vendor keys with a well-known prefix (OpenAI `sk-…`, Anthropic `sk-ant-…`).
  (
    pattern: RegExp(r'\bsk-[A-Za-z0-9_\-]{8,}'),
    replace: (_) => 'sk-<redacted>',
  ),
  // `"session_token": "…"`, `key = …`, `password=…` — the value after any
  // secret-named field, however it is punctuated.
  (
    pattern: RegExp(
      '''(["']?\\b\\w*(?:token|secret|password|passphrase|credential|api[_-]?key)\\w*\\b["']?\\s*[:=]\\s*["']?)([^\\s"',}]{6,})''',
      caseSensitive: false,
    ),
    replace: (m) => '${m[1]}<redacted>',
  ),
  // A `?…token=…` or `?…key=…` inside a logged URL.
  (
    pattern: RegExp(
      r'([?&][^=\s&]*(?:token|key|secret|sig|signature)[^=\s&]*=)[^\s&]+',
      caseSensitive: false,
    ),
    replace: (m) => '${m[1]}<redacted>',
  ),
];
