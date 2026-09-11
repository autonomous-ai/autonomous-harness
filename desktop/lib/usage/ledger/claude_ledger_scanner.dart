/// What Claude Code has spent on this computer, read out of its own transcripts.
///
/// Claude Code appends one JSON object per line to
/// `~/.claude/projects/<slug>/<session>.jsonl` as it works, and every assistant
/// turn carries a `message.usage` block. Nothing is asked of Anthropic here —
/// the file is already on disk, written by the CLI for its own resume feature.
library;

import 'dart:convert';
import 'dart:io';

import 'ledger_scanner.dart';
import 'ledger_types.dart';

class ClaudeLedgerScanner implements LedgerScanner {
  ClaudeLedgerScanner({String? home, this.environment})
    : _home = home ?? homeDirectory(environment);

  final String? _home;
  final Map<String, String>? environment;

  @override
  LedgerProvider get provider => LedgerProvider.claude;

  /// Both roots Claude Code has used. `transcripts/` is the older layout and is
  /// still on long-lived machines; reading only `projects/` would quietly drop
  /// every session from before the move.
  List<String> get roots => [
    if (_home != null) ...[
      '$_home/.claude/projects',
      '$_home/.claude/transcripts',
    ],
  ];

  @override
  Future<LedgerScanResult> scan(Map<String, ScannedSource> previous) async {
    if (_home == null) {
      return const LedgerScanResult.unavailable(
        'No home directory to read Claude transcripts from',
      );
    }
    final files = await listJsonlFiles(roots);
    if (files.isEmpty) {
      return const LedgerScanResult.unavailable(
        'No Claude Code transcripts on this computer',
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
    // The session id the transcript is named after, for the rows that omit it.
    final fallbackSessionId = file.uri.pathSegments.last.replaceAll(
      '.jsonl',
      '',
    );
    final turns = <ClaudeTurn>[];
    try {
      final lines = file
          .openRead()
          .transform(utf8.decoder)
          .transform(const LineSplitter());
      await for (final line in lines) {
        final turn = parseClaudeLine(line, fallbackSessionId);
        if (turn != null) turns.add(turn);
      }
    } on FileSystemException {
      return const [];
    }
    return _dedupe(turns);
  }

  /// Claude Code streams repeated assistant rows carrying the same message and
  /// request ids, and a later row can hold a more complete usage block than the
  /// one before it. Collapse them onto the first occurrence, taking the largest
  /// figure seen for each bucket.
  ///
  /// The key prefers `messageId:requestId` because a fork rewrites `sessionId`
  /// but keeps both of those — so a resumed session's copied rows still collapse
  /// onto the originals instead of doubling the bill.
  List<LedgerEntry> _dedupe(List<ClaudeTurn> turns) {
    final indexByKey = <String, int>{};
    final kept = <ClaudeTurn>[];
    for (final turn in turns) {
      final key = turn.dedupeKey;
      if (key != null) {
        final existing = indexByKey[key];
        if (existing != null) {
          kept[existing] = kept[existing].mergedWith(turn);
          continue;
        }
        indexByKey[key] = kept.length;
      }
      kept.add(turn);
    }
    return [
      for (final turn in kept)
        if (!turn.totals.isEmpty)
          LedgerEntry(
            provider: LedgerProvider.claude,
            sessionId: turn.sessionId,
            timestamp: turn.timestamp,
            totals: turn.totals,
            model: turn.model,
            directory: turn.directory,
            // Carried onward as well as used here: a fork copies these rows into
            // a second transcript, and only the aggregation sees both files.
            dedupeKey: turn.dedupeKey,
          ),
    ];
  }
}

/// One assistant row, before duplicates are collapsed.
class ClaudeTurn {
  const ClaudeTurn({
    required this.sessionId,
    required this.timestamp,
    required this.totals,
    this.model,
    this.directory,
    this.dedupeKey,
  });

  final String sessionId;
  final DateTime timestamp;
  final UsageTotals totals;
  final String? model;
  final String? directory;
  final String? dedupeKey;

  ClaudeTurn mergedWith(ClaudeTurn other) => ClaudeTurn(
    sessionId: sessionId,
    timestamp: timestamp,
    model: model ?? other.model,
    directory: directory ?? other.directory,
    dedupeKey: dedupeKey,
    totals: UsageTotals(
      freshInput: _max(totals.freshInput, other.totals.freshInput),
      output: _max(totals.output, other.totals.output),
      cacheRead: _max(totals.cacheRead, other.totals.cacheRead),
      cacheWrite5m: _max(totals.cacheWrite5m, other.totals.cacheWrite5m),
      cacheWrite1h: _max(totals.cacheWrite1h, other.totals.cacheWrite1h),
      reasoning: _max(totals.reasoning, other.totals.reasoning),
    ),
  );
}

int _max(int a, int b) => a > b ? a : b;

int _tokens(Object? value) =>
    value is num && value.isFinite && value > 0 ? value.toInt() : 0;

/// The thinking share of an assistant turn's output, when the row reports one.
int _reasoning(Object? details) =>
    details is Map<String, Object?> ? _tokens(details['thinking_tokens']) : 0;

/// A necessary condition for `type == "assistant"`, checked before the parse.
///
/// Transcripts interleave user and tool-result rows that routinely embed whole
/// files, and `jsonDecode` on those is most of what a scan would cost. Sound for
/// anything a standard JSON encoder wrote: it escapes quotes, backslashes and
/// control characters, never ASCII letters, so a decoded `assistant` can only
/// come from a line that spells it literally. Over-admits freely — the real
/// `type` check below stays authoritative.
bool _mayBeAssistant(String line) => line.contains('assistant');

/// One transcript line as a turn, or null when it carries no usage.
///
/// Exposed for the test that pins the buckets against a real recorded row.
ClaudeTurn? parseClaudeLine(String line, String fallbackSessionId) {
  if (!_mayBeAssistant(line)) return null;
  final Object? decoded;
  try {
    decoded = jsonDecode(line);
  } on FormatException {
    return null;
  }
  if (decoded is! Map<String, Object?>) return null;
  if (decoded['type'] != 'assistant') return null;

  final timestamp = DateTime.tryParse('${decoded['timestamp']}');
  if (timestamp == null) return null;
  final sessionId = decoded['sessionId'];

  final message = decoded['message'];
  final usage = message is Map<String, Object?> ? message['usage'] : null;
  if (usage is! Map<String, Object?>) return null;

  final cacheCreation = usage['cache_creation'];
  final cacheWriteTotal = _tokens(usage['cache_creation_input_tokens']);
  // Clamped to the total so the implied 5m remainder can never go negative on a
  // partial row.
  final write1h = cacheCreation is Map<String, Object?>
      ? _max(
          0,
          _tokens(cacheCreation['ephemeral_1h_input_tokens'])
              .clamp(0, cacheWriteTotal),
        )
      : 0;

  final totals = UsageTotals(
    // Claude's `input_tokens` already excludes both cache buckets, so it is the
    // fresh figure with no arithmetic — see `UsageTotals.freshInput`.
    freshInput: _tokens(usage['input_tokens']),
    // `output_tokens` already includes `output_tokens_details.thinking_tokens`;
    // adding those would bill the same reasoning twice. They are reported
    // separately below, as a subset.
    output: _tokens(usage['output_tokens']),
    cacheRead: _tokens(usage['cache_read_input_tokens']),
    cacheWrite5m: cacheWriteTotal - write1h,
    cacheWrite1h: write1h,
    reasoning: _reasoning(usage['output_tokens_details']),
  );
  if (totals.isEmpty) return null;

  return ClaudeTurn(
    sessionId: sessionId is String && sessionId.isNotEmpty
        ? sessionId
        : fallbackSessionId,
    timestamp: timestamp,
    totals: totals,
    model: message is Map<String, Object?> ? message['model'] as String? : null,
    directory: decoded['cwd'] as String?,
    dedupeKey: _dedupeKey(decoded, message),
  );
}

String? _dedupeKey(Map<String, Object?> row, Object? message) {
  final messageId = message is Map<String, Object?>
      ? (message['id'] as String?)?.trim()
      : null;
  final requestId = (row['requestId'] as String?)?.trim();
  if (messageId != null && messageId.isNotEmpty) {
    if (requestId != null && requestId.isNotEmpty) {
      return '$messageId:$requestId';
    }
    return 'msg:$messageId';
  }
  final uuid = (row['uuid'] as String?)?.trim();
  if (uuid != null && uuid.isNotEmpty) return 'uuid:$uuid';
  return null;
}
