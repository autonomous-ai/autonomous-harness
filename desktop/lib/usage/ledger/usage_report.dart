/// One provider's ledger, cut to a date range and read every way the detail
/// pane draws it.
///
/// Ported from Orca's per-provider panes (`ClaudeUsagePane` and its siblings):
/// the same eight figures, the same two breakdowns, the same recent-sessions
/// table.
///
/// ⚠️ **There is no SCOPE filter here, and that is deliberate.** Orca offers
/// "Orca worktrees only" against "All local usage", because it owns the
/// worktrees its agents run in and can tell its own sessions from the rest. This
/// app owns no such boundary: agents launched through Harness run on OTHER
/// machines and write their transcripts there, so a "Harness only" lens over
/// this computer's logs would filter on a distinction that does not exist here
/// and would answer nearly zero. Everything local is counted, and the pane says
/// so rather than offering a switch with one honest position.
///
/// Pure, like `usage_overview.dart` beside it — every figure the pane prints is
/// decided here, and an arithmetic bug is invisible on screen.
library;

import 'ledger_types.dart';
import 'model_pricing.dart';
import 'usage_overview.dart';

/// How far back a detail pane looks.
enum UsageRange {
  d7('Last 7 days', 7),
  d30('Last 30 days', 30),
  d90('Last 90 days', 90),
  all('All time', null);

  const UsageRange(this.label, this.days);

  final String label;

  /// Null means no cutoff.
  final int? days;

  /// The oldest moment this range admits, or null for all time.
  ///
  /// Measured from local midnight rather than from the current instant, so "last
  /// 7 days" means seven calendar days and does not quietly drop this morning's
  /// work as the clock passes.
  DateTime? cutoff({DateTime? now}) {
    final days = this.days;
    if (days == null) return null;
    final today = now ?? DateTime.now();
    return DateTime(today.year, today.month, today.day - (days - 1));
  }
}

/// [ledger]'s entries within [range], oldest first.
List<LedgerEntry> entriesInRange(
  ProviderLedger ledger,
  UsageRange range, {
  DateTime? now,
}) {
  final cutoff = range.cutoff(now: now);
  if (cutoff == null) return ledger.entries;
  return [
    for (final entry in ledger.entries)
      if (!entry.timestamp.isBefore(cutoff)) entry,
  ];
}

/// [ledger] cut down to [range], with every figure recomputed.
///
/// Not a filtered view but a real ledger: the totals, the cost and the session
/// count all have to be re-derived, because none of them can be scaled down from
/// the full-history figure.
ProviderLedger clipLedger(
  ProviderLedger ledger,
  UsageRange range, {
  DateTime? now,
}) {
  if (range.days == null) return ledger;
  return ledgerFromEntries(
    ledger.provider,
    entriesInRange(ledger, range, now: now),
  );
}

/// The eight figures across the top of a provider's pane.
class UsageReport {
  const UsageReport({
    required this.provider,
    required this.range,
    this.totals = const UsageTotals(),
    this.sessions = 0,
    this.turns = 0,
    this.zeroCacheReadTurns = 0,
    this.costUsd,
    this.hasUnpricedModel = false,
  });

  final LedgerProvider provider;
  final UsageRange range;
  final UsageTotals totals;

  /// Distinct sessions in the range.
  final int sessions;

  /// Billable exchanges in the range.
  ///
  /// ⚠️ **A "turn" means a different thing per provider** and the label is kept
  /// vague on purpose: Claude bills per assistant turn, Codex per `token_count`
  /// event, OpenCode keeps one row per session — so for OpenCode this equals
  /// [sessions]. Orca hits the same wall and prints "events" for Codex and
  /// "turns" for Claude; the honest common noun is what the two share, which is
  /// an entry in the ledger.
  final int turns;

  /// Turns that read nothing from cache.
  ///
  /// The share of these is the number worth looking at: a high one means context
  /// is being rebuilt from scratch over and over, which is the expensive way to
  /// run an agent.
  final int zeroCacheReadTurns;

  final double? costUsd;
  final bool hasUnpricedModel;

  bool get hasData => turns > 0;

  /// Cache reads over everything that could have been a cache read.
  ///
  /// `cacheRead / (freshInput + cacheRead)` — the same definition Orca prints
  /// under its card, and the pane prints it too, because a rate with no formula
  /// beside it invites three different readings.
  ///
  /// **Null, not zero, when there was no input at all**: nothing cached and
  /// nothing read are different facts.
  double? get cacheReuseRate {
    final denominator = totals.freshInput + totals.cacheRead;
    if (denominator == 0) return null;
    return totals.cacheRead / denominator;
  }

  /// The share of turns that started cold, or null when there were no turns.
  double? get zeroCacheReadShare =>
      turns == 0 ? null : zeroCacheReadTurns / turns;
}

/// Read [entries] into the pane's headline figures.
UsageReport summarize(
  LedgerProvider provider,
  UsageRange range,
  List<LedgerEntry> entries,
) {
  var totals = const UsageTotals();
  final sessions = <String>{};
  var zeroCacheRead = 0;
  double? cost;
  var hasUnpriced = false;

  for (final entry in entries) {
    totals += entry.totals;
    sessions.add(entry.sessionId);
    if (entry.totals.cacheRead == 0) zeroCacheRead++;
    final entryCost =
        entry.costUsd ?? costOf(provider, entry.model, entry.totals);
    if (entryCost == null) {
      hasUnpriced = true;
    } else {
      cost = (cost ?? 0) + entryCost;
    }
  }

  return UsageReport(
    provider: provider,
    range: range,
    totals: totals,
    sessions: sessions.length,
    turns: entries.length,
    zeroCacheReadTurns: zeroCacheRead,
    costUsd: cost,
    hasUnpricedModel: hasUnpriced,
  );
}

/// One row of a breakdown — by model, or by project.
class BreakdownRow {
  const BreakdownRow({
    required this.label,
    required this.tokens,
    required this.sessions,
    required this.turns,
    this.costUsd,
    this.hasUnpricedModel = false,
  });

  final String label;
  final int tokens;
  final int sessions;
  final int turns;
  final double? costUsd;
  final bool hasUnpricedModel;
}

/// Which side of an entry a breakdown groups on.
typedef _KeyOf = String? Function(LedgerEntry entry);

List<BreakdownRow> _breakdown(
  LedgerProvider provider,
  List<LedgerEntry> entries,
  _KeyOf keyOf,
  String unknownLabel,
) {
  final tokens = <String, int>{};
  final sessions = <String, Set<String>>{};
  final turns = <String, int>{};
  final costs = <String, double?>{};
  final unpriced = <String, bool>{};

  for (final entry in entries) {
    final key = keyOf(entry) ?? unknownLabel;
    tokens[key] = (tokens[key] ?? 0) + entry.totals.total;
    (sessions[key] ??= <String>{}).add(entry.sessionId);
    turns[key] = (turns[key] ?? 0) + 1;
    final entryCost =
        entry.costUsd ?? costOf(provider, entry.model, entry.totals);
    if (entryCost == null) {
      unpriced[key] = true;
    } else {
      costs[key] = (costs[key] ?? 0) + entryCost;
    }
  }

  final rows = [
    for (final key in tokens.keys)
      BreakdownRow(
        label: key,
        tokens: tokens[key]!,
        sessions: sessions[key]!.length,
        turns: turns[key]!,
        costUsd: costs[key],
        hasUnpricedModel: unpriced[key] ?? false,
      ),
  ];
  // Heaviest first — a breakdown is read to find where it went.
  rows.sort((a, b) => b.tokens.compareTo(a.tokens));
  return rows;
}

List<BreakdownRow> breakdownByModel(
  LedgerProvider provider,
  List<LedgerEntry> entries,
) => _breakdown(provider, entries, (entry) => entry.model, 'Unknown model');

/// Grouped by the last path segment of the working directory.
///
/// The leaf rather than the whole path: `/Users/me/work/grid` and
/// `/Users/me/scratch/grid` are two projects and read as one word, and a column
/// of absolute home paths is unreadable at this width. The full path is not lost
/// — it is on the session rows.
List<BreakdownRow> breakdownByProject(
  LedgerProvider provider,
  List<LedgerEntry> entries,
) => _breakdown(provider, entries, (entry) {
  final directory = entry.directory;
  if (directory == null || directory.isEmpty) return null;
  final segments = directory.split('/').where((s) => s.isNotEmpty).toList();
  return segments.isEmpty ? null : segments.last;
}, 'Unknown project');

/// One row of the recent-sessions table.
class SessionRow {
  const SessionRow({
    required this.sessionId,
    required this.lastActiveAt,
    required this.project,
    required this.model,
    required this.totals,
    required this.turns,
    this.costUsd,
  });

  final String sessionId;
  final DateTime lastActiveAt;

  /// The working directory as shown — the leaf, or a dash when unknown.
  final String project;

  /// The model this session used, or null when the log never named one. When a
  /// session used more than one, the last one wins: it is what a person means
  /// by "what was I running".
  final String? model;

  final UsageTotals totals;
  final int turns;
  final double? costUsd;
}

/// The most recently active sessions, newest first.
List<SessionRow> recentSessions(
  LedgerProvider provider,
  List<LedgerEntry> entries, {
  int limit = 8,
}) {
  final lastActive = <String, DateTime>{};
  final totals = <String, UsageTotals>{};
  final turns = <String, int>{};
  final models = <String, String?>{};
  final directories = <String, String?>{};
  final costs = <String, double?>{};

  for (final entry in entries) {
    final id = entry.sessionId;
    final at = lastActive[id];
    if (at == null || entry.timestamp.isAfter(at)) {
      lastActive[id] = entry.timestamp;
      // Last writer wins for both, so the row describes how the session ENDED
      // rather than how it opened — an agent moved onto another model mid-way
      // is most usefully filed under the one it finished on.
      if (entry.model != null) models[id] = entry.model;
      if (entry.directory != null) directories[id] = entry.directory;
    }
    models.putIfAbsent(id, () => entry.model);
    directories.putIfAbsent(id, () => entry.directory);
    totals[id] = (totals[id] ?? const UsageTotals()) + entry.totals;
    turns[id] = (turns[id] ?? 0) + 1;
    final entryCost =
        entry.costUsd ?? costOf(provider, entry.model, entry.totals);
    if (entryCost != null) costs[id] = (costs[id] ?? 0) + entryCost;
  }

  final ids = lastActive.keys.toList()
    ..sort((a, b) => lastActive[b]!.compareTo(lastActive[a]!));

  return [
    for (final id in ids.take(limit))
      SessionRow(
        sessionId: id,
        lastActiveAt: lastActive[id]!,
        project: _leaf(directories[id]) ?? '—',
        model: models[id],
        totals: totals[id] ?? const UsageTotals(),
        turns: turns[id] ?? 0,
        costUsd: costs[id],
      ),
  ];
}

String? _leaf(String? directory) {
  if (directory == null || directory.isEmpty) return null;
  final segments = directory.split('/').where((s) => s.isNotEmpty).toList();
  return segments.isEmpty ? null : segments.last;
}
