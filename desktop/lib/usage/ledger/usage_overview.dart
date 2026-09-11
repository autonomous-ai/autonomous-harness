/// Turning scanned entries into the figures the panel prints.
///
/// Pure on purpose — no disk, no clock beyond what it is handed — because this
/// is where every claim the panel makes is actually decided, and an arithmetic
/// bug here is invisible on screen. `test/usage_ledger_test.dart` drives these
/// directly.
library;

import 'ledger_types.dart';
import 'ledger_scanner.dart';
import 'model_pricing.dart';

/// One provider's entries, deduplicated, totalled and priced.
///
/// [sources] may hold the same exchange twice — see [LedgerEntry.dedupeKey] for
/// why resuming a session copies records into a second file — so the first stop
/// is dropping repeats. An entry with no dedupe key is always kept: no key means
/// the provider gave nothing stable to match on, and guessing that two such
/// entries are the same exchange would silently delete real spend.
ProviderLedger buildProviderLedger(
  LedgerProvider provider,
  Iterable<ScannedSource> sources,
) {
  final seen = <String>{};
  final entries = <LedgerEntry>[];
  for (final source in sources) {
    for (final entry in source.entries) {
      final key = entry.dedupeKey;
      if (key != null && !seen.add(key)) continue;
      entries.add(entry);
    }
  }
  entries.sort((a, b) => a.timestamp.compareTo(b.timestamp));
  return ledgerFromEntries(provider, entries);
}

/// The same totalling over entries that are already deduplicated and sorted.
///
/// Split out of [buildProviderLedger] so a date-range view can reuse the exact
/// arithmetic rather than growing a second copy of it — a clipped ledger that
/// summed its cost differently from the full one would be a bug nobody could
/// see, since both figures look plausible on their own.
ProviderLedger ledgerFromEntries(
  LedgerProvider provider,
  List<LedgerEntry> entries,
) {
  var totals = const UsageTotals();
  final sessions = <String>{};
  double? cost;
  var hasUnpriced = false;
  for (final entry in entries) {
    totals += entry.totals;
    sessions.add(entry.sessionId);
    // The provider's own figure wins where there is one; otherwise the model
    // name is priced. A model nothing prices leaves the running total alone and
    // raises the flag — see `ProviderLedger.hasUnpricedModel`.
    final entryCost =
        entry.costUsd ?? costOf(provider, entry.model, entry.totals);
    if (entryCost == null) {
      hasUnpriced = true;
    } else {
      cost = (cost ?? 0) + entryCost;
    }
  }

  return ProviderLedger(
    provider: provider,
    entries: entries,
    totals: totals,
    costUsd: cost,
    hasUnpricedModel: hasUnpriced,
    sessionCount: sessions.length,
  );
}

/// One provider's entries collapsed to one row per local day, oldest first.
List<LedgerDay> dailyTotals(ProviderLedger ledger) {
  final byDay = <DateTime, List<LedgerEntry>>{};
  for (final entry in ledger.entries) {
    // Local midnight, not UTC: somebody reading "yesterday" means the day they
    // had, not the one Greenwich had.
    final day = DateTime(
      entry.timestamp.year,
      entry.timestamp.month,
      entry.timestamp.day,
    );
    (byDay[day] ??= []).add(entry);
  }
  final days = byDay.keys.toList()..sort();
  return [
    for (final day in days)
      () {
        var totals = const UsageTotals();
        double? cost;
        for (final entry in byDay[day]!) {
          totals += entry.totals;
          final entryCost =
              entry.costUsd ??
              costOf(ledger.provider, entry.model, entry.totals);
          if (entryCost != null) cost = (cost ?? 0) + entryCost;
        }
        return LedgerDay(day: day, totals: totals, costUsd: cost);
      }(),
  ];
}

/// Every provider added together — what the four cards at the top of the panel
/// read from.
class UsageOverview {
  const UsageOverview({
    required this.providers,
    required this.totals,
    required this.days,
    this.costUsd,
    this.hasUnpricedModel = false,
    this.sessionCount = 0,
    this.enabledCount = 0,
    this.lastScanAt,
  });

  /// How many providers the user has switched on.
  ///
  /// Held rather than derived: a provider can be on and still have nothing to
  /// show — mid-scan, or with the CLI not installed — so "how many are on" and
  /// "how many answered" are different questions. Conflating them is what makes
  /// an empty panel unreadable.
  final int enabledCount;

  /// Every provider's ledger, in a stable order, enabled or not.
  final List<ProviderLedger> providers;

  final UsageTotals totals;

  /// One row per local day that had any spend at all, oldest first.
  final List<LedgerDay> days;

  /// The bill across every provider that could be priced.
  ///
  /// **A floor, not a total, when [hasUnpricedModel] is true.** The panel says
  /// so beside the figure rather than rounding the doubt away.
  final double? costUsd;

  final bool hasUnpricedModel;
  final int sessionCount;

  /// The most recent successful scan across the providers, for the "Updated …"
  /// line. Null before any provider has scanned.
  final DateTime? lastScanAt;

  /// Days with any spend on them. What the "Active days" card counts.
  int get activeDays => days.length;

  /// How much of the input was served from cache, 0–1, or null when there was no
  /// input at all.
  ///
  /// **Null rather than zero on an empty ledger**: a cache share of 0% is a
  /// measurement — nothing was cached — and having spent nothing yet is not
  /// that. The card prints `n/a`.
  double? get cacheShare {
    final read = totals.cacheRead;
    final fresh = totals.freshInput;
    if (read + fresh == 0) return null;
    return read / (read + fresh);
  }

  /// The heaviest day, for the intensity grid's scale. Null when there are none.
  LedgerDay? get bestDay {
    if (days.isEmpty) return null;
    return days.reduce((a, b) => b.totals.total > a.totals.total ? b : a);
  }

  int get dataProviderCount => providers.where((p) => p.hasData).length;
  bool get hasAnyData => providers.any((p) => p.hasData);
}

/// Fold every provider's ledger into one overview.
UsageOverview buildOverview({
  required List<ProviderLedger> ledgers,
  required int enabledCount,
  DateTime? lastScanAt,
}) {
  var totals = const UsageTotals();
  double? cost;
  var hasUnpriced = false;
  var sessions = 0;
  final byDay = <DateTime, LedgerDay>{};

  for (final ledger in ledgers) {
    totals += ledger.totals;
    sessions += ledger.sessionCount;
    if (ledger.hasUnpricedModel) hasUnpriced = true;
    if (ledger.costUsd != null) cost = (cost ?? 0) + ledger.costUsd!;
    for (final day in dailyTotals(ledger)) {
      final existing = byDay[day.day];
      byDay[day.day] = existing == null
          ? day
          : LedgerDay(
              day: day.day,
              totals: existing.totals + day.totals,
              costUsd: existing.costUsd == null && day.costUsd == null
                  ? null
                  : (existing.costUsd ?? 0) + (day.costUsd ?? 0),
            );
    }
  }

  final days = byDay.keys.toList()..sort();
  return UsageOverview(
    providers: ledgers,
    totals: totals,
    days: [for (final day in days) byDay[day]!],
    costUsd: cost,
    hasUnpricedModel: hasUnpriced,
    sessionCount: sessions,
    enabledCount: enabledCount,
    lastScanAt: lastScanAt,
  );
}

/// The last [count] days ending today, including the empty ones.
///
/// The gaps are the point: an intensity grid drawn only from days that had spend
/// would pack a fortnight of work into a row and hide that half of it was a
/// weekend.
List<LedgerDay> recentDays(List<LedgerDay> days, int count, {DateTime? now}) {
  final today = now ?? DateTime.now();
  final end = DateTime(today.year, today.month, today.day);
  final byDay = {for (final day in days) day.day: day};
  return [
    for (var i = count - 1; i >= 0; i--)
      () {
        final day = DateTime(end.year, end.month, end.day - i);
        return byDay[day] ?? LedgerDay(day: day, totals: const UsageTotals());
      }(),
  ];
}

/// `3.2B`, `1.2M`, `48.3k`, `912` — a token count at a glance.
///
/// ⚠️ **Billions are a real tier here, not a theoretical one.** A single heavy
/// month of Claude Code runs to thousands of millions, and `3652.0M` is a figure
/// nobody can read at a glance — which is the whole job of this function. Orca's
/// `formatUsageTokens` breaks at the same three thresholds, down to the
/// lowercase `k`.
String formatTokens(int tokens) {
  if (tokens >= 1000000000) {
    return '${(tokens / 1000000000).toStringAsFixed(1)}B';
  }
  if (tokens >= 1000000) {
    return '${(tokens / 1000000).toStringAsFixed(1)}M';
  }
  if (tokens >= 1000) {
    return '${(tokens / 1000).toStringAsFixed(1)}k';
  }
  return '$tokens';
}

/// How dark a day's cell is drawn, `0`–`4`.
///
/// Five buckets rather than a continuous alpha, as Orca does: a heatmap is read
/// by comparing squares to each other, and a smooth ramp gives the eye no steps
/// to compare. `0` is reserved for a day with nothing on it, so "quiet" and
/// "barely busy" can never render the same.
int intensityBucket(int tokens, int peak) {
  if (tokens <= 0 || peak <= 0) return 0;
  final ratio = tokens / peak;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

/// A bill in USD, or `n/a` when nothing could be priced.
///
/// Sub-cent amounts keep four decimals rather than rounding to `$0.00`, which
/// would read as free — the exact mistake the nullable cost exists to avoid.
String formatCost(double? cost) {
  if (cost == null) return 'n/a';
  if (cost > 0 && cost < 0.01) return '\$${cost.toStringAsFixed(4)}';
  return '\$${cost.toStringAsFixed(2)}';
}
