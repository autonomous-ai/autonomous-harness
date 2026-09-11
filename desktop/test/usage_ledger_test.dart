import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/usage/ledger/claude_ledger_scanner.dart';
import 'package:harness/usage/ledger/codex_ledger_scanner.dart';
import 'package:harness/usage/ledger/ledger_scanner.dart';
import 'package:harness/core/snapshot_store.dart';
import 'package:harness/usage/ledger/ledger_types.dart';
import 'package:harness/usage/ledger/model_pricing.dart';
import 'package:harness/usage/ledger/usage_ledger_store.dart';
import 'package:harness/usage/ledger/usage_overview.dart';

/// A recorded Claude assistant row, trimmed from a real transcript. The
/// `iterations` and `output_tokens_details` blocks are kept because both are
/// restatements of figures already counted, and dropping them from the fixture
/// would stop it pinning the thing it exists to pin.
String claudeRow({
  String sessionId = 's1',
  String timestamp = '2026-09-01T10:00:00.000Z',
  String messageId = 'msg_1',
  String requestId = 'req_1',
  int input = 2,
  int output = 741,
  int cacheRead = 24856,
  int cacheWrite = 17513,
  int cacheWrite1h = 17513,
  String model = 'claude-opus-5',
}) => jsonEncode({
  'type': 'assistant',
  'sessionId': sessionId,
  'timestamp': timestamp,
  'cwd': '/Users/x/project',
  'gitBranch': 'main',
  'requestId': requestId,
  'uuid': 'u-$messageId',
  'message': {
    'id': messageId,
    'model': model,
    'usage': {
      'input_tokens': input,
      'output_tokens': output,
      'cache_read_input_tokens': cacheRead,
      'cache_creation_input_tokens': cacheWrite,
      'output_tokens_details': {'thinking_tokens': 517},
      'cache_creation': {
        'ephemeral_1h_input_tokens': cacheWrite1h,
        'ephemeral_5m_input_tokens': cacheWrite - cacheWrite1h,
      },
      'iterations': [
        {'input_tokens': input, 'output_tokens': output},
      ],
    },
  },
});

String codexTokenCount({
  String timestamp = '2026-09-01T10:00:00.000Z',
  required int totalInput,
  required int totalCached,
  required int totalOutput,
  int? lastInput,
  int? lastCached,
  int? lastOutput,
}) => jsonEncode({
  'timestamp': timestamp,
  'type': 'event_msg',
  'payload': {
    'type': 'token_count',
    'info': {
      'total_token_usage': {
        'input_tokens': totalInput,
        'cached_input_tokens': totalCached,
        'output_tokens': totalOutput,
        'reasoning_output_tokens': 0,
        'total_tokens': totalInput + totalOutput,
      },
      if (lastInput != null)
        'last_token_usage': {
          'input_tokens': lastInput,
          'cached_input_tokens': lastCached ?? 0,
          'output_tokens': lastOutput ?? 0,
          'reasoning_output_tokens': 0,
          'total_tokens': lastInput + (lastOutput ?? 0),
        },
    },
  },
});

ScannedSource sourceOf(String path, List<LedgerEntry> entries) =>
    ScannedSource(path: path, mtimeMs: 1, size: 1, entries: entries);

LedgerEntry entryOf({
  LedgerProvider provider = LedgerProvider.claude,
  String sessionId = 's1',
  String timestamp = '2026-09-01T10:00:00.000Z',
  UsageTotals totals = const UsageTotals(freshInput: 100, output: 50),
  String? model = 'claude-opus-5',
  String? dedupeKey,
  double? costUsd,
}) => LedgerEntry(
  provider: provider,
  sessionId: sessionId,
  timestamp: DateTime.parse(timestamp),
  totals: totals,
  model: model,
  dedupeKey: dedupeKey,
  costUsd: costUsd,
);

class MemorySettings implements LocalKeyValueStore {
  final values = <String, String>{};

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async => values[key] = value;

  @override
  Future<void> delete(String key) async => values.remove(key);
}

/// A scanner that returns whatever it is told to, and counts how often it was
/// asked — which is how the staleness and the enable gate are observed.
class FakeScanner implements LedgerScanner {
  FakeScanner(this.provider, this.result);

  @override
  final LedgerProvider provider;

  LedgerScanResult result;
  int scans = 0;
  Map<String, ScannedSource> lastPrevious = const {};

  @override
  Future<LedgerScanResult> scan(Map<String, ScannedSource> previous) async {
    scans++;
    lastPrevious = previous;
    return result;
  }
}

void main() {
  group('Claude transcript parsing', () {
    test('reads every bucket and splits the cache write by TTL', () {
      final turn = parseClaudeLine(claudeRow(), 'fallback')!;

      expect(turn.sessionId, 's1');
      expect(turn.model, 'claude-opus-5');
      expect(turn.totals.freshInput, 2);
      // 741, not 741 + 517: `output_tokens` already contains the thinking
      // tokens that `output_tokens_details` restates.
      expect(turn.totals.output, 741);
      expect(turn.totals.cacheRead, 24856);
      expect(turn.totals.cacheWrite1h, 17513);
      expect(turn.totals.cacheWrite5m, 0);
      expect(turn.totals.total, 2 + 741 + 24856 + 17513);
    });

    test('falls back to the filename when a row names no session', () {
      final row = jsonDecode(claudeRow()) as Map<String, Object?>;
      row.remove('sessionId');
      final turn = parseClaudeLine(jsonEncode(row), 'from-filename')!;
      expect(turn.sessionId, 'from-filename');
    });

    test('skips rows that are not assistant turns or carry no usage', () {
      expect(parseClaudeLine('{"type":"user","message":{}}', 's'), isNull);
      expect(parseClaudeLine('not json at all', 's'), isNull);
      expect(
        parseClaudeLine(
          claudeRow(input: 0, output: 0, cacheRead: 0, cacheWrite: 0),
          's',
        ),
        isNull,
      );
    });

    test(
      'a fork keeps the message and request ids, so the key survives it',
      () {
        final original = parseClaudeLine(claudeRow(sessionId: 'a'), 'f')!;
        final forked = parseClaudeLine(claudeRow(sessionId: 'b'), 'f')!;
        // Different sessions, same exchange — which is exactly the case that
        // would otherwise be billed twice.
        expect(original.sessionId, isNot(forked.sessionId));
        expect(original.dedupeKey, forked.dedupeKey);
      },
    );
  });

  group('Codex delta resolution', () {
    test('bills the increment, not the cumulative total', () {
      final context = CodexParseContext(sessionId: 's1');
      final first = parseCodexLine(
        codexTokenCount(
          totalInput: 1000,
          totalCached: 800,
          totalOutput: 100,
          lastInput: 1000,
          lastCached: 800,
          lastOutput: 100,
        ),
        context,
      )!;
      final second = parseCodexLine(
        codexTokenCount(
          timestamp: '2026-09-01T10:05:00.000Z',
          totalInput: 3000,
          totalCached: 2500,
          totalOutput: 300,
          lastInput: 2000,
          lastCached: 1700,
          lastOutput: 200,
        ),
        context,
      )!;

      // The second record's totals restate the first; billing them would
      // charge 3000 input for 2000 of work.
      expect(second.totals.freshInput, 2000 - 1700);
      expect(second.totals.cacheRead, 1700);
      expect(second.totals.output, 200);
      expect(first.totals.freshInput, 1000 - 800);
    });

    test('subtracts cached input, because Codex counts it inside input', () {
      final context = CodexParseContext(sessionId: 's1');
      final entry = parseCodexLine(
        codexTokenCount(
          totalInput: 16827,
          totalCached: 13056,
          totalOutput: 134,
        ),
        context,
      )!;
      expect(entry.totals.freshInput, 16827 - 13056);
      expect(entry.totals.cacheRead, 13056);
    });

    test('a repeated total bills nothing', () {
      final context = CodexParseContext(sessionId: 's1');
      final line = codexTokenCount(
        totalInput: 1000,
        totalCached: 0,
        totalOutput: 100,
      );
      expect(parseCodexLine(line, context), isNotNull);
      expect(parseCodexLine(line, context), isNull);
    });

    test('a null info is a rate-limit update, not a malformed record', () {
      final context = CodexParseContext(sessionId: 's1');
      final line = jsonEncode({
        'timestamp': '2026-09-01T10:00:00.000Z',
        'type': 'event_msg',
        'payload': {'type': 'token_count', 'info': null},
      });
      expect(parseCodexLine(line, context), isNull);
    });

    test('takes the model from the turn_context that precedes the usage', () {
      final context = CodexParseContext(sessionId: 's1');
      parseCodexLine(
        jsonEncode({
          'timestamp': '2026-09-01T09:59:00.000Z',
          'type': 'turn_context',
          'payload': {'cwd': '/w', 'model': 'gpt-5.3-codex'},
        }),
        context,
      );
      final entry = parseCodexLine(
        codexTokenCount(totalInput: 100, totalCached: 0, totalOutput: 10),
        context,
      )!;
      expect(entry.model, 'gpt-5.3-codex');
      expect(entry.directory, '/w');
    });

    test('the dedupe key ignores the session, which a resume rewrites', () {
      final a = CodexParseContext(sessionId: 'original');
      final b = CodexParseContext(sessionId: 'resumed-copy');
      final line = codexTokenCount(
        totalInput: 500,
        totalCached: 0,
        totalOutput: 50,
      );
      expect(
        parseCodexLine(line, a)!.dedupeKey,
        parseCodexLine(line, b)!.dedupeKey,
      );
    });

    test(
      'a stale regression is dropped rather than taken as a new baseline',
      () {
        final previous = const CodexRawUsage(
          input: 10000,
          cached: 0,
          output: 1000,
          reasoning: 0,
          total: 11000,
        );
        // An echo of an earlier state: still within 2% of what we already had.
        final echo = const CodexRawUsage(
          input: 9900,
          cached: 0,
          output: 990,
          reasoning: 0,
          total: 10890,
        );
        final last = const CodexRawUsage(
          input: 100,
          cached: 0,
          output: 10,
          reasoning: 0,
          total: 110,
        );
        expect(resolveCodexDelta(echo, last, previous), isNull);
      },
    );
  });

  group('pricing', () {
    test('prices a known model off its buckets', () {
      final cost = costOf(
        LedgerProvider.claude,
        'claude-opus-5',
        const UsageTotals(freshInput: 1000000, output: 1000000),
      );
      // $5 per million in, $25 per million out.
      expect(cost, closeTo(30, 0.0001));
    });

    test('an unknown model is null, never zero', () {
      expect(
        costOf(
          LedgerProvider.claude,
          'some-model-nobody-listed',
          const UsageTotals(freshInput: 1000000),
        ),
        isNull,
      );
    });

    test('matches dated and thinking variants onto their family', () {
      expect(normalizeClaudeModel('claude-opus-5-20260101'), 'claude-opus-5');
      expect(
        normalizeClaudeModel('claude-opus-4.6-thinking'),
        'claude-opus-4-6',
      );
      expect(
        normalizeClaudeModel('claude-3-5-sonnet-20241022'),
        'claude-sonnet-3-5',
      );
    });

    test('strips a reasoning tier before pricing a Codex model', () {
      expect(normalizeCodexModel('gpt-5.3-codex-high'), 'gpt-5.3-codex');
      expect(
        normalizeCodexModel('gpt-5.1-codex-max-xhigh'),
        'gpt-5.1-codex-max',
      );
      expect(normalizeCodexModel('gpt-5.6'), 'gpt-5.6-sol');
    });

    test('bills the long-context tier above the threshold', () {
      final flat = costOf(
        LedgerProvider.claude,
        'claude-sonnet-5',
        const UsageTotals(freshInput: 400000),
      );
      final tiered = costOf(
        LedgerProvider.claude,
        'claude-sonnet-4-5',
        const UsageTotals(freshInput: 400000),
      );
      // Sonnet 5 bills its whole window flat; 4.5 doubles past 200k.
      expect(flat, closeTo(0.8, 0.0001));
      expect(tiered, closeTo((200000 * 3 + 200000 * 6) / 1000000, 0.0001));
    });

    test('OpenCode is never priced here — it carries its own cost', () {
      expect(
        costOf(
          LedgerProvider.opencode,
          'anything',
          const UsageTotals(freshInput: 1000000),
        ),
        isNull,
      );
    });
  });

  group('persisted shape', () {
    test(
      'the serialised keys are pinned, so a new field cannot slip through',
      () {
        // ⚠️ **If this fails you added a field to `UsageTotals`.** Update the list
        // AND bump `_kCacheVersion` in `usage_ledger_store.dart` — a cached source
        // still matches its {path, mtime, size} fingerprint after the shape
        // changes, so without the bump every old entry is served back with the new
        // field defaulted and re-saved that way, forever. That is exactly how
        // `reasoning` came to report 90.9k against a true 2.3M.
        expect(const UsageTotals().toJson().keys.toSet(), {
          'freshInput',
          'output',
          'cacheRead',
          'cacheWrite5m',
          'cacheWrite1h',
          'reasoning',
        });
      },
    );

    test('an entry round-trips every field it carries', () {
      final original = entryOf(
        dedupeKey: 'k',
        costUsd: 1.25,
        totals: const UsageTotals(
          freshInput: 1,
          output: 2,
          cacheRead: 3,
          cacheWrite5m: 4,
          cacheWrite1h: 5,
          reasoning: 6,
        ),
      );
      final restored = LedgerEntry.fromJson(
        LedgerProvider.claude,
        original.toJson(),
      )!;

      expect(restored.totals.freshInput, 1);
      expect(restored.totals.output, 2);
      expect(restored.totals.cacheRead, 3);
      expect(restored.totals.cacheWrite5m, 4);
      expect(restored.totals.cacheWrite1h, 5);
      expect(restored.totals.reasoning, 6);
      expect(restored.costUsd, 1.25);
      expect(restored.dedupeKey, 'k');
      expect(restored.sessionId, original.sessionId);
    });

    test('reasoning is a subset of output, never a bucket beside it', () {
      const totals = UsageTotals(freshInput: 10, output: 40, reasoning: 30);
      // 50, not 80: the thinking is already inside `output` and is billed at
      // the output rate, so counting it again would charge it twice.
      expect(totals.total, 50);
      expect(totals.cache, 0);
    });

    test('a stale snapshot is discarded rather than half-read', () async {
      final settings = MemorySettings()
        ..values['usageLedger.claude.enabled'] = 'true';
      final stale = MemorySnapshotStore(
        jsonEncode({
          'version': 1,
          'provider': 'claude',
          'sources': [
            sourceOf('a.jsonl', [entryOf(dedupeKey: 'a')]).toJson(),
          ],
        }),
      );
      final store = UsageLedgerStore(
        scanner: FakeScanner(LedgerProvider.claude, const LedgerScanResult()),
        settings: settings,
        snapshots: stale,
      );
      addTearDown(store.dispose);
      await store.load();

      expect(
        store.ledger.hasData,
        isFalse,
        reason: 'an older format is dropped, not read with fields defaulted',
      );
    });
  });

  group('aggregation', () {
    test('drops an exchange seen in two files', () {
      final ledger = buildProviderLedger(LedgerProvider.claude, [
        sourceOf('a.jsonl', [entryOf(dedupeKey: 'k1')]),
        sourceOf('b.jsonl', [entryOf(sessionId: 'forked', dedupeKey: 'k1')]),
      ]);
      expect(ledger.entries, hasLength(1));
      expect(ledger.totals.freshInput, 100);
    });

    test('keeps entries that offer no key rather than guessing', () {
      final ledger = buildProviderLedger(LedgerProvider.claude, [
        sourceOf('a.jsonl', [entryOf(), entryOf()]),
      ]);
      expect(ledger.entries, hasLength(2));
    });

    test('an unpriced model raises the flag and leaves the total a floor', () {
      final ledger = buildProviderLedger(LedgerProvider.claude, [
        sourceOf('a.jsonl', [
          entryOf(dedupeKey: 'a'),
          entryOf(dedupeKey: 'b', model: 'unknown-model'),
        ]),
      ]);
      expect(ledger.hasUnpricedModel, isTrue);
      expect(ledger.costUsd, isNotNull);
    });

    test("a provider's own zero cost is kept, not treated as unpriced", () {
      final ledger = buildProviderLedger(LedgerProvider.opencode, [
        sourceOf('db', [
          entryOf(
            provider: LedgerProvider.opencode,
            model: 'autonomous-ai/Qwen3.8-27B',
            costUsd: 0,
            dedupeKey: 'x',
          ),
        ]),
      ]);
      // Grid inference is free; that is a measurement and must survive.
      expect(ledger.costUsd, 0);
      expect(ledger.hasUnpricedModel, isFalse);
    });

    test('counts distinct sessions, not entries', () {
      final ledger = buildProviderLedger(LedgerProvider.claude, [
        sourceOf('a.jsonl', [
          entryOf(sessionId: 's1', dedupeKey: 'a'),
          entryOf(sessionId: 's1', dedupeKey: 'b'),
          entryOf(sessionId: 's2', dedupeKey: 'c'),
        ]),
      ]);
      expect(ledger.sessionCount, 2);
    });

    test('groups days by local midnight', () {
      final ledger = buildProviderLedger(LedgerProvider.claude, [
        sourceOf('a.jsonl', [
          entryOf(timestamp: '2026-09-01T01:00:00', dedupeKey: 'a'),
          entryOf(timestamp: '2026-09-01T23:00:00', dedupeKey: 'b'),
          entryOf(timestamp: '2026-09-02T01:00:00', dedupeKey: 'c'),
        ]),
      ]);
      final days = dailyTotals(ledger);
      expect(days, hasLength(2));
      expect(days.first.totals.freshInput, 200);
    });

    test('cache share is null on an empty ledger and a ratio otherwise', () {
      final empty = buildOverview(ledgers: const [], enabledCount: 0);
      expect(empty.cacheShare, isNull);

      final ledger = buildProviderLedger(LedgerProvider.claude, [
        sourceOf('a.jsonl', [
          entryOf(
            dedupeKey: 'a',
            totals: const UsageTotals(freshInput: 250, cacheRead: 750),
          ),
        ]),
      ]);
      final overview = buildOverview(ledgers: [ledger], enabledCount: 1);
      expect(overview.cacheShare, closeTo(0.75, 0.0001));
    });

    test('recentDays fills the gaps so a quiet day is visible', () {
      final days = [
        LedgerDay(
          day: DateTime(2026, 9, 8),
          totals: const UsageTotals(freshInput: 10),
        ),
      ];
      final recent = recentDays(days, 3, now: DateTime(2026, 9, 8, 15));
      expect(recent, hasLength(3));
      expect(recent.first.day, DateTime(2026, 9, 6));
      expect(recent.first.totals.total, 0);
      expect(recent.last.totals.freshInput, 10);
    });
  });

  group('formatting', () {
    test('shortens token counts, billions included', () {
      expect(formatTokens(912), '912');
      expect(formatTokens(48300), '48.3k');
      expect(formatTokens(1200000), '1.2M');
      // The tier that matters: a heavy month of Claude Code runs to thousands
      // of millions, and `3652.0M` is unreadable at a glance.
      expect(formatTokens(3200000000), '3.2B');
    });

    test('intensity is five steps, with zero reserved for a quiet day', () {
      expect(intensityBucket(0, 100), 0);
      expect(intensityBucket(10, 100), 1);
      expect(intensityBucket(25, 100), 1);
      expect(intensityBucket(26, 100), 2);
      expect(intensityBucket(60, 100), 3);
      expect(intensityBucket(100, 100), 4);
      // Nothing anywhere in the window: every cell rests rather than dividing
      // by a peak of zero.
      expect(intensityBucket(0, 0), 0);
    });

    test('a sub-cent bill does not round to free, and null reads n/a', () {
      expect(formatCost(null), 'n/a');
      expect(formatCost(0.0004), '\$0.0004');
      expect(formatCost(12.5), '\$12.50');
    });
  });

  group('store lifecycle', () {
    late MemorySnapshotStore snapshots;

    setUp(() => snapshots = MemorySnapshotStore());

    UsageLedgerStore storeWith(
      FakeScanner scanner,
      MemorySettings settings, {
      MemorySnapshotStore? cache,
    }) => UsageLedgerStore(
      scanner: scanner,
      settings: settings,
      snapshots: cache ?? snapshots,
    );

    test('a disabled provider is never scanned', () async {
      final scanner = FakeScanner(
        LedgerProvider.claude,
        const LedgerScanResult(),
      );
      final store = storeWith(scanner, MemorySettings());
      await store.load();
      await store.refresh(force: true);
      expect(scanner.scans, 0);
      expect(store.state.status, LedgerStatus.disabled);
    });

    test('enabling scans, and the result persists across a reload', () async {
      final settings = MemorySettings();
      final scanner = FakeScanner(
        LedgerProvider.claude,
        LedgerScanResult(
          sources: [
            sourceOf('a.jsonl', [entryOf(dedupeKey: 'a')]),
          ],
        ),
      );
      final store = storeWith(scanner, settings);
      await store.load();
      await store.setEnabled(true);

      expect(scanner.scans, 1);
      expect(store.state.status, LedgerStatus.ok);
      expect(store.ledger.totals.freshInput, 100);

      // A second store over the same disk starts where the first left off,
      // which is what stops every launch re-walking the transcripts.
      final reopened = storeWith(
        FakeScanner(LedgerProvider.claude, const LedgerScanResult()),
        settings,
      );
      await reopened.load();
      expect(reopened.state.enabled, isTrue);
      expect(reopened.ledger.totals.freshInput, 100);
    });

    test('a fresh result is not rescanned, and force overrides that', () async {
      final scanner = FakeScanner(
        LedgerProvider.claude,
        const LedgerScanResult(),
      );
      final store = storeWith(scanner, MemorySettings());
      await store.load();
      await store.setEnabled(true);
      expect(scanner.scans, 1);

      await store.refresh();
      expect(scanner.scans, 1, reason: 'still inside kLedgerStaleAfter');

      await store.refresh(force: true);
      expect(scanner.scans, 2);
    });

    test('the previous sources are handed to the next scan', () async {
      final scanner = FakeScanner(
        LedgerProvider.claude,
        LedgerScanResult(
          sources: [
            sourceOf('a.jsonl', [entryOf(dedupeKey: 'a')]),
          ],
        ),
      );
      final store = storeWith(scanner, MemorySettings());
      await store.load();
      await store.setEnabled(true);
      await store.refresh(force: true);
      expect(scanner.lastPrevious.keys, ['a.jsonl']);
    });

    test('switching off clears the snapshot from memory and disk', () async {
      final scanner = FakeScanner(
        LedgerProvider.claude,
        LedgerScanResult(
          sources: [
            sourceOf('a.jsonl', [entryOf(dedupeKey: 'a')]),
          ],
        ),
      );
      final store = storeWith(scanner, MemorySettings());
      await store.load();
      await store.setEnabled(true);
      expect(snapshots.isEmpty, isFalse);

      await store.setEnabled(false);
      expect(store.ledger.hasData, isFalse);
      expect(snapshots.isEmpty, isTrue);
    });

    test('an unavailable provider keeps no stale totals', () async {
      final scanner = FakeScanner(
        LedgerProvider.opencode,
        LedgerScanResult(
          sources: [
            sourceOf('db', [
              entryOf(provider: LedgerProvider.opencode, dedupeKey: 'a'),
            ]),
          ],
        ),
      );
      final store = storeWith(scanner, MemorySettings());
      await store.load();
      await store.setEnabled(true);
      expect(store.ledger.hasData, isTrue);

      scanner.result = const LedgerScanResult.unavailable('No OpenCode here');
      await store.refresh(force: true);

      expect(store.state.status, LedgerStatus.unavailable);
      expect(store.state.message, 'No OpenCode here');
      expect(store.ledger.hasData, isFalse);
    });
  });
}
