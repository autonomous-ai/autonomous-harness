/// What Codex has spent on this computer, read out of its own rollout logs.
///
/// Codex appends JSON lines to `~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl`
/// and reports usage in `event_msg` records of type `token_count`.
///
/// ⚠️ **Codex reports CUMULATIVE totals, and Claude reports per-turn figures.**
/// That single difference is most of this file. A scanner that summed
/// `total_token_usage` across a session's records would bill a 40-turn session
/// forty times over — every record repeats everything before it. The billable
/// increment is `last_token_usage` where it exists, and the difference between
/// consecutive totals where it does not.
library;

import 'dart:convert';
import 'dart:io';

import 'ledger_scanner.dart';
import 'ledger_types.dart';

class CodexLedgerScanner implements LedgerScanner {
  CodexLedgerScanner({String? home, Map<String, String>? environment})
    : _environment = environment,
      _home = home ?? homeDirectory(environment);

  final String? _home;
  final Map<String, String>? _environment;

  @override
  LedgerProvider get provider => LedgerProvider.codex;

  /// `CODEX_HOME` first, because a machine that sets it means it. Falls back to
  /// `~/.codex`, and reads `archived_sessions/` beside `sessions/` so a session
  /// Codex has since filed away still counts — it was paid for either way.
  List<String> get roots {
    final env = _environment ?? Platform.environment;
    final codexHome = env['CODEX_HOME']?.trim();
    final base = codexHome != null && codexHome.isNotEmpty
        ? codexHome
        : (_home == null ? null : '$_home/.codex');
    if (base == null) return const [];
    return ['$base/sessions', '$base/archived_sessions'];
  }

  @override
  Future<LedgerScanResult> scan(Map<String, ScannedSource> previous) async {
    final roots = this.roots;
    if (roots.isEmpty) {
      return const LedgerScanResult.unavailable(
        'No home directory to read Codex sessions from',
      );
    }
    final files = await listJsonlFiles(roots);
    if (files.isEmpty) {
      return const LedgerScanResult.unavailable(
        'No Codex sessions on this computer',
      );
    }

    final sources = <ScannedSource>[];
    for (final file in files) {
      final FileStat stat;
      try {
        stat = await file.stat();
      } on FileSystemException {
        continue;
      }
      final cached = previous[file.path];
      if (cached != null && cached.matches(stat)) {
        sources.add(cached);
        continue;
      }
      sources.add(
        ScannedSource(
          path: file.path,
          mtimeMs: stat.modified.millisecondsSinceEpoch,
          size: stat.size,
          entries: await _parse(file),
        ),
      );
    }
    return LedgerScanResult(sources: sources);
  }

  Future<List<LedgerEntry>> _parse(File file) async {
    final context = CodexParseContext(
      sessionId: file.uri.pathSegments.last.replaceAll('.jsonl', ''),
    );
    final entries = <LedgerEntry>[];
    try {
      final lines = file
          .openRead()
          .transform(utf8.decoder)
          .transform(const LineSplitter());
      await for (final line in lines) {
        final entry = parseCodexLine(line, context);
        if (entry != null) entries.add(entry);
      }
    } on FileSystemException {
      return const [];
    }
    return entries;
  }
}

/// What a rollout file has told us so far.
///
/// Mutable and carried down the file because Codex names the model and the
/// working directory in `turn_context` records that arrive *before* the usage
/// they apply to. A parser that looked only at the usage record would price
/// every Codex token as an unknown model.
class CodexParseContext {
  CodexParseContext({required this.sessionId});

  String sessionId;
  String? sessionCwd;
  String? currentCwd;
  String? currentModel;

  /// The last cumulative reading, against which the next one is a delta.
  CodexRawUsage? previousTotals;
}

/// Codex's own five buckets, before normalisation.
class CodexRawUsage {
  const CodexRawUsage({
    required this.input,
    required this.cached,
    required this.output,
    required this.reasoning,
    required this.total,
  });

  /// ⚠️ **Cache-INCLUSIVE**, unlike everything downstream — see
  /// [UsageTotals.freshInput].
  final int input;
  final int cached;
  final int output;
  final int reasoning;
  final int total;

  int get magnitude => input + cached + output + reasoning;

  bool sameAs(CodexRawUsage other) =>
      input == other.input &&
      cached == other.cached &&
      output == other.output &&
      reasoning == other.reasoning;

  bool isMonotonicAfter(CodexRawUsage previous) =>
      input >= previous.input &&
      cached >= previous.cached &&
      output >= previous.output &&
      reasoning >= previous.reasoning;

  CodexRawUsage minus(CodexRawUsage? previous) => CodexRawUsage(
    input: _clamp(input - (previous?.input ?? 0)),
    cached: _clamp(cached - (previous?.cached ?? 0)),
    output: _clamp(output - (previous?.output ?? 0)),
    reasoning: _clamp(reasoning - (previous?.reasoning ?? 0)),
    total: _clamp(total - (previous?.total ?? 0)),
  );

  CodexRawUsage plus(CodexRawUsage other) => CodexRawUsage(
    input: input + other.input,
    cached: cached + other.cached,
    output: output + other.output,
    reasoning: reasoning + other.reasoning,
    total: total + other.total,
  );

  /// Onto the shared shape: fresh input with the cache hits taken out.
  ///
  /// Clamped because the two figures come off the wire independently and a
  /// partial record can report more cached than input; a negative bucket would
  /// subtract from the machine's total.
  UsageTotals toTotals() => UsageTotals(
    freshInput: _clamp(input - cached),
    // Reasoning is billed at the output rate and Codex already counts it inside
    // `output_tokens`; adding it again would bill the same thinking twice. It is
    // carried separately as a subset.
    output: output,
    reasoning: reasoning,
    cacheRead: cached,
    // Codex reports `cache_write_input_tokens`, and it is deliberately dropped:
    // OpenAI's prompt caching writes for free, so a bucket here would show a
    // token count that is never billed and inflate every Codex total.
  );

  String get tuple => '$input,$cached,$output,$reasoning,$total';

  static int _clamp(int value) => value > 0 ? value : 0;
}

int _tokens(Object? value) =>
    value is num && value.isFinite && value > 0 ? value.toInt() : 0;

CodexRawUsage? _rawUsage(Object? value) {
  if (value is! Map<String, Object?>) return null;
  final input = _tokens(value['input_tokens']);
  final cached = _tokens(
    value['cached_input_tokens'] ?? value['cache_read_input_tokens'],
  );
  final output = _tokens(value['output_tokens']);
  final reasoning = _tokens(value['reasoning_output_tokens']);
  final total = _tokens(value['total_tokens']);
  return CodexRawUsage(
    input: input,
    cached: cached,
    output: output,
    reasoning: reasoning,
    // Legacy logs omit `total_tokens`. Reasoning is already inside output, so
    // input+output matches Codex pricing rather than counting it twice.
    total: total > 0 ? total : input + output,
  );
}

/// Whether a total that went BACKWARDS is a stale snapshot rather than a reset.
///
/// Codex rewrites its totals after a compaction or a resume, so a smaller figure
/// can mean either "the session restarted, count from here" or "this record is
/// an out-of-order echo of an earlier state". Ported from Orca's
/// `looksLikeStaleRegression`: a total still within 2% of the previous one, or
/// one that the last increment would carry back over it, is an echo — and an
/// echo must be dropped rather than treated as a new baseline, which would
/// re-bill everything after it.
bool _looksLikeStaleRegression(
  CodexRawUsage current,
  CodexRawUsage previous,
  CodexRawUsage last,
) {
  final previousTotal = previous.magnitude;
  final currentTotal = current.magnitude;
  final lastTotal = last.magnitude;
  if (previousTotal <= 0 || currentTotal <= 0 || lastTotal <= 0) return false;
  return currentTotal * 100 >= previousTotal * 98 ||
      currentTotal + lastTotal * 2 >= previousTotal;
}

/// The outcome of reading one `token_count` record.
sealed class CodexDelta {
  const CodexDelta();
}

/// A billable increment, plus the totals the next record is measured against.
class CodexIncrement extends CodexDelta {
  const CodexIncrement(this.delta, this.nextTotals);
  final CodexRawUsage delta;
  final CodexRawUsage? nextTotals;
}

/// The session restarted its count. Nothing to bill; just move the baseline.
class CodexBaseline extends CodexDelta {
  const CodexBaseline(this.nextTotals);
  final CodexRawUsage nextTotals;
}

/// What to bill for a `token_count` record, or null when the answer is nothing.
///
/// Ported from Orca's `resolveCodexUsageDelta`, whose ordering matters: the
/// `last_token_usage` payload is the billable increment and the totals are only
/// the baseline, because totals are mutable snapshots after a compaction.
CodexDelta? resolveCodexDelta(
  CodexRawUsage? total,
  CodexRawUsage? last,
  CodexRawUsage? previous,
) {
  if (total != null && last != null && previous != null) {
    if (total.sameAs(previous)) return null;
    if (!total.isMonotonicAfter(previous) &&
        _looksLikeStaleRegression(total, previous, last)) {
      return null;
    }
    return CodexIncrement(last, total);
  }
  if (total != null && last != null) return CodexIncrement(last, total);
  if (total != null && previous != null) {
    if (total.sameAs(previous)) return null;
    if (!total.isMonotonicAfter(previous)) return CodexBaseline(total);
    return CodexIncrement(total.minus(previous), total);
  }
  if (total != null) return CodexIncrement(total, total);
  if (last != null && previous != null) {
    return CodexIncrement(last, previous.plus(last));
  }
  if (last != null) return CodexIncrement(last, null);
  return null;
}

/// One rollout line as a ledger entry, or null when it carries no billable
/// usage. Advances [context] as a side effect.
LedgerEntry? parseCodexLine(String line, CodexParseContext context) {
  final Object? decoded;
  try {
    decoded = jsonDecode(line);
  } on FormatException {
    return null;
  }
  if (decoded is! Map<String, Object?>) return null;
  final payload = decoded['payload'];
  if (payload is! Map<String, Object?>) return null;

  switch (decoded['type']) {
    case 'session_meta':
      final id = payload['id'];
      if (id is String && id.isNotEmpty) context.sessionId = id;
      context.sessionCwd = payload['cwd'] as String?;
      context.currentCwd ??= context.sessionCwd;
      return null;
    case 'turn_context':
      context.currentCwd =
          (payload['cwd'] as String?) ??
          context.currentCwd ??
          context.sessionCwd;
      context.currentModel = _model(payload) ?? context.currentModel;
      return null;
    case 'event_msg':
      break;
    default:
      return null;
  }

  if (payload['type'] != 'token_count') return null;
  final timestamp = DateTime.tryParse('${decoded['timestamp']}');
  if (timestamp == null) return null;

  final info = payload['info'];
  // Codex emits `token_count` snapshots with a null `info` purely to carry a
  // rate-limit update. Treating those as malformed would make an active session
  // look flaky and raise scan errors for a perfectly valid log.
  if (info is! Map<String, Object?>) return null;

  final total = _rawUsage(info['total_token_usage']);
  final last = _rawUsage(info['last_token_usage']);
  final resolved = resolveCodexDelta(total, last, context.previousTotals);
  if (resolved == null) return null;
  if (resolved is CodexBaseline) {
    context.previousTotals = resolved.nextTotals;
    return null;
  }

  final increment = resolved as CodexIncrement;
  context.previousTotals = increment.nextTotals;
  final totals = increment.delta.toTotals();
  if (totals.isEmpty) return null;

  return LedgerEntry(
    provider: LedgerProvider.codex,
    sessionId: context.sessionId,
    timestamp: timestamp,
    totals: totals,
    model: _model(payload) ?? context.currentModel,
    directory: context.currentCwd ?? context.sessionCwd,
    // Keyed on the record's OWN fields — timestamp plus both usage tuples — and
    // never on the session id, because resuming copies these records verbatim
    // into a new rollout file while rewriting `session_meta.id`. Keying on the
    // session would let the copy through as a second charge.
    dedupeKey:
        '${decoded['timestamp']}|${total?.tuple ?? ''}|${last?.tuple ?? ''}',
  );
}

/// The model named on a record, wherever this Codex version chose to put it.
String? _model(Map<String, Object?> record) {
  for (final key in ['model', 'model_name']) {
    final value = record[key];
    if (value is String && value.isNotEmpty) return value;
  }
  final info = record['info'];
  if (info is Map<String, Object?>) {
    for (final key in ['model', 'model_name']) {
      final value = info[key];
      if (value is String && value.isNotEmpty) return value;
    }
    final metadata = info['metadata'];
    if (metadata is Map<String, Object?>) {
      final value = metadata['model'];
      if (value is String && value.isNotEmpty) return value;
    }
  }
  final metadata = record['metadata'];
  if (metadata is Map<String, Object?>) {
    final value = metadata['model'];
    if (value is String && value.isNotEmpty) return value;
  }
  return null;
}
