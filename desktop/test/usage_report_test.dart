// The per-provider detail figures. Every number the detail pane prints is
// decided here, and an arithmetic bug in it is invisible on screen — which is
// what these tests exist for.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/usage/ledger/ledger_types.dart';
import 'package:harness/usage/ledger/usage_report.dart';

LedgerEntry entry({
  LedgerProvider provider = LedgerProvider.claude,
  String sessionId = 's1',
  required DateTime at,
  UsageTotals totals = const UsageTotals(freshInput: 100, output: 50),
  String? model = 'claude-opus-5',
  String? directory,
  double? costUsd,
}) => LedgerEntry(
  provider: provider,
  sessionId: sessionId,
  timestamp: at,
  totals: totals,
  model: model,
  directory: directory,
  costUsd: costUsd,
);

ProviderLedger ledgerOf(List<LedgerEntry> entries) => ProviderLedger(
  provider: LedgerProvider.claude,
  entries: entries..sort((a, b) => a.timestamp.compareTo(b.timestamp)),
);

void main() {
  final now = DateTime(2026, 9, 8, 15);

  group('range', () {
    test('counts calendar days, so this morning is never cut off', () {
      // 7 days ending today means the window opens on the 2nd, not 7×24h back
      // from 15:00 — which would have dropped everything before 15:00 on the 2nd.
      expect(UsageRange.d7.cutoff(now: now), DateTime(2026, 9, 2));
      expect(UsageRange.d30.cutoff(now: now), DateTime(2026, 8, 10));
      expect(UsageRange.all.cutoff(now: now), isNull);
    });

    test('keeps what is inside and drops what is not', () {
      final ledger = ledgerOf([
        entry(at: DateTime(2026, 9, 8, 9), sessionId: 'today'),
        entry(at: DateTime(2026, 9, 2, 0, 1), sessionId: 'edge'),
        entry(at: DateTime(2026, 9, 1, 23), sessionId: 'outside'),
      ]);

      final kept = entriesInRange(ledger, UsageRange.d7, now: now);
      expect(kept.map((e) => e.sessionId), ['edge', 'today']);

      expect(entriesInRange(ledger, UsageRange.all, now: now), hasLength(3));
    });
  });

  group('summary', () {
    test('adds the buckets, counts sessions apart from turns', () {
      final entries = [
        entry(at: now, sessionId: 'a'),
        entry(at: now, sessionId: 'a'),
        entry(at: now, sessionId: 'b'),
      ];
      final report = summarize(LedgerProvider.claude, UsageRange.all, entries);

      expect(report.turns, 3);
      expect(report.sessions, 2);
      expect(report.totals.freshInput, 300);
      expect(report.hasData, isTrue);
    });

    test('cache reuse rate is reads over reads plus fresh input', () {
      final report = summarize(LedgerProvider.claude, UsageRange.all, [
        entry(
          at: now,
          totals: const UsageTotals(freshInput: 250, cacheRead: 750),
        ),
      ]);
      expect(report.cacheReuseRate, closeTo(0.75, 0.0001));
    });

    test('a rate with no input at all is null, not zero', () {
      final report = summarize(LedgerProvider.claude, UsageRange.all, const []);
      expect(report.cacheReuseRate, isNull);
      expect(report.zeroCacheReadShare, isNull);
      expect(report.hasData, isFalse);
    });

    test('counts the turns that read nothing from cache', () {
      final report = summarize(LedgerProvider.claude, UsageRange.all, [
        entry(at: now, totals: const UsageTotals(freshInput: 10)),
        entry(at: now, totals: const UsageTotals(freshInput: 10)),
        entry(
          at: now,
          totals: const UsageTotals(freshInput: 10, cacheRead: 90),
        ),
        entry(
          at: now,
          totals: const UsageTotals(freshInput: 10, cacheRead: 90),
        ),
      ]);
      expect(report.zeroCacheReadTurns, 2);
      expect(report.zeroCacheReadShare, closeTo(0.5, 0.0001));
    });

    test('an unpriced model leaves the cost a floor and says so', () {
      final report = summarize(LedgerProvider.claude, UsageRange.all, [
        entry(at: now),
        entry(at: now, model: 'a-grid-model-nobody-prices'),
      ]);
      expect(report.hasUnpricedModel, isTrue);
      expect(report.costUsd, isNotNull);
    });
  });

  group('breakdowns', () {
    test('models rank heaviest first', () {
      final rows = breakdownByModel(LedgerProvider.claude, [
        entry(at: now, model: 'small', totals: const UsageTotals(output: 10)),
        entry(at: now, model: 'big', totals: const UsageTotals(output: 900)),
        entry(at: now, model: 'small', totals: const UsageTotals(output: 20)),
      ]);

      expect(rows.map((r) => r.label), ['big', 'small']);
      expect(rows.first.tokens, 900);
      expect(rows.last.tokens, 30);
      expect(rows.last.turns, 2);
    });

    test('an unnamed model is a row, not a dropped entry', () {
      final rows = breakdownByModel(LedgerProvider.claude, [
        entry(at: now, model: null),
      ]);
      expect(rows.single.label, 'Unknown model');
    });

    test('projects group on the folder leaf, not the whole path', () {
      final rows = breakdownByProject(LedgerProvider.claude, [
        entry(at: now, directory: '/Users/me/work/grid'),
        entry(at: now, directory: '/Users/me/other/grid'),
        entry(at: now, directory: '/Users/me/work/harness'),
      ]);
      // Two entries land on `grid` — the leaf is what a person calls the
      // project, and a column of absolute home paths is unreadable.
      final grid = rows.firstWhere((r) => r.label == 'grid');
      expect(grid.turns, 2);
      expect(rows.map((r) => r.label), containsAll(['grid', 'harness']));
    });

    test('an entry with no directory still lands somewhere', () {
      final rows = breakdownByProject(LedgerProvider.claude, [
        entry(at: now, directory: null),
      ]);
      expect(rows.single.label, 'Unknown project');
    });
  });

  group('recent sessions', () {
    test('newest first, with each session folded into one row', () {
      final rows = recentSessions(LedgerProvider.claude, [
        entry(at: DateTime(2026, 9, 1), sessionId: 'old'),
        entry(at: DateTime(2026, 9, 8, 9), sessionId: 'new'),
        entry(at: DateTime(2026, 9, 8, 10), sessionId: 'new'),
      ]);

      expect(rows.map((r) => r.sessionId), ['new', 'old']);
      expect(rows.first.turns, 2);
      expect(rows.first.lastActiveAt, DateTime(2026, 9, 8, 10));
      expect(rows.first.totals.freshInput, 200);
    });

    test('a session names the model it finished on', () {
      final rows = recentSessions(LedgerProvider.claude, [
        entry(at: DateTime(2026, 9, 8, 9), sessionId: 's', model: 'first'),
        entry(at: DateTime(2026, 9, 8, 11), sessionId: 's', model: 'last'),
      ]);
      expect(rows.single.model, 'last');
    });

    test('a session with no directory shows a dash, not an empty cell', () {
      final rows = recentSessions(LedgerProvider.claude, [
        entry(at: now, directory: null),
      ]);
      expect(rows.single.project, '—');
    });

    test('honours the limit', () {
      final rows = recentSessions(LedgerProvider.claude, [
        for (var i = 0; i < 20; i++)
          entry(at: DateTime(2026, 9, 8, i % 24), sessionId: 's$i'),
      ], limit: 5);
      expect(rows, hasLength(5));
    });
  });
}
