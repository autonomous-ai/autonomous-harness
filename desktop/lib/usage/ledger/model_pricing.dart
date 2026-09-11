/// What a model costs, so a token count can become a bill.
///
/// Claude and Codex write token counts to disk and no prices, so the money on
/// the panel is derived here. OpenCode is the exception and never reaches this
/// file: it keeps a `cost` column of its own, and a figure the provider computed
/// beats one we inferred.
///
/// Ported from Orca's `claude-model-pricing.ts` and `codex-model-pricing.ts`,
/// tables and normalisers both. ⚠️ **Keep the three in step.** These are list
/// prices in USD per million tokens, copied by hand from a source that changes
/// without warning; a stale row here is a wrong number on screen with nothing to
/// flag it. A model that matches nothing is deliberately left [unpriced] rather
/// than guessed at, and the panel says so — see `ProviderLedger.hasUnpricedModel`.
library;

import '../../usage/ledger/ledger_types.dart';

/// USD per million tokens, per bucket.
///
/// The `above` fields are the long-context tier: past [thresholdTokens] in a
/// bucket, the remainder of that bucket bills at the higher rate. Only a few
/// models have one, and for the rest the tier fields are null and every token
/// bills flat.
class ClaudePricing {
  const ClaudePricing({
    required this.input,
    required this.output,
    required this.cacheRead,
    required this.cacheWrite,
    required this.cacheWrite1h,
    this.thresholdTokens,
    this.inputAbove,
    this.outputAbove,
    this.cacheReadAbove,
    this.cacheWriteAbove,
    this.cacheWrite1hAbove,
  });

  final double input;
  final double output;
  final double cacheRead;

  /// 5-minute TTL cache write — 1.25x base input.
  final double cacheWrite;

  /// 1-hour TTL cache write — 2x base input.
  final double cacheWrite1h;

  final int? thresholdTokens;
  final double? inputAbove;
  final double? outputAbove;
  final double? cacheReadAbove;
  final double? cacheWriteAbove;
  final double? cacheWrite1hAbove;
}

const _kLongContextThreshold = 200000;

// Sonnet 4.5's long-context tier, one const per bucket. Sonnet 5 deliberately
// has none — it bills its full 1M window flat.
//
// Six separate constants rather than one record: a record's fields cannot be
// read inside a `const` expression, and these are used to build const pricing
// rows.
const _kSonnetAboveInput = 6.0;
const _kSonnetAboveOutput = 22.5;
const _kSonnetAboveCacheRead = 0.6;
const _kSonnetAboveCacheWrite = 7.5;
const _kSonnetAboveCacheWrite1h = 12.0;

const _kClaudePricing = <String, ClaudePricing>{
  'claude-fable-5': ClaudePricing(
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite: 12.5,
    cacheWrite1h: 20,
  ),
  'claude-opus-5': ClaudePricing(
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    cacheWrite1h: 10,
  ),
  // $2/$10 needs no date dimension — it launched as introductory pricing through
  // 2026-08-31 but is now the standard price; the 2026-09-01 rise was cancelled.
  'claude-sonnet-5': ClaudePricing(
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    cacheWrite1h: 4,
  ),
  'claude-opus-4-8': ClaudePricing(
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    cacheWrite1h: 10,
  ),
  'claude-opus-4-7': ClaudePricing(
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    cacheWrite1h: 10,
  ),
  'claude-opus-4-6': ClaudePricing(
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    cacheWrite1h: 10,
  ),
  'claude-opus-4-5': ClaudePricing(
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    cacheWrite1h: 10,
  ),
  'claude-opus-4-1': ClaudePricing(
    input: 15,
    output: 75,
    cacheRead: 1.5,
    cacheWrite: 18.75,
    cacheWrite1h: 30,
  ),
  'claude-opus-4': ClaudePricing(
    input: 15,
    output: 75,
    cacheRead: 1.5,
    cacheWrite: 18.75,
    cacheWrite1h: 30,
  ),
  // Claude 4.6 and later keep standard rates across the full 1M context window.
  'claude-sonnet-4-6': ClaudePricing(
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    cacheWrite1h: 6,
  ),
  'claude-sonnet-4-5': ClaudePricing(
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    cacheWrite1h: 6,
    thresholdTokens: _kLongContextThreshold,
    inputAbove: _kSonnetAboveInput,
    outputAbove: _kSonnetAboveOutput,
    cacheReadAbove: _kSonnetAboveCacheRead,
    cacheWriteAbove: _kSonnetAboveCacheWrite,
    cacheWrite1hAbove: _kSonnetAboveCacheWrite1h,
  ),
  'claude-sonnet-4': ClaudePricing(
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    cacheWrite1h: 6,
    thresholdTokens: _kLongContextThreshold,
    inputAbove: _kSonnetAboveInput,
    outputAbove: _kSonnetAboveOutput,
    cacheReadAbove: _kSonnetAboveCacheRead,
    cacheWriteAbove: _kSonnetAboveCacheWrite,
    cacheWrite1hAbove: _kSonnetAboveCacheWrite1h,
  ),
  'claude-sonnet-3-7': ClaudePricing(
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    cacheWrite1h: 6,
  ),
  'claude-sonnet-3-5': ClaudePricing(
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    cacheWrite1h: 6,
  ),
  'claude-haiku-4-5': ClaudePricing(
    input: 1,
    output: 5,
    cacheRead: 0.1,
    cacheWrite: 1.25,
    cacheWrite1h: 2,
  ),
  'claude-haiku-3-5': ClaudePricing(
    input: 0.8,
    output: 4,
    cacheRead: 0.08,
    cacheWrite: 1,
    cacheWrite1h: 1.6,
  ),
  'claude-haiku-3': ClaudePricing(
    input: 0.25,
    output: 1.25,
    cacheRead: 0.03,
    cacheWrite: 0.3,
    cacheWrite1h: 0.5,
  ),
};

const _kClaudeAliases = <String, String>{
  'model_placeholder_m26': 'claude-opus-4-6',
  'model_placeholder_m35': 'claude-sonnet-4-6',
  'claude-opus-4.8': 'claude-opus-4-8',
  'claude-opus-4.6': 'claude-opus-4-6',
  'claude-sonnet-4.6': 'claude-sonnet-4-6',
  'claude-opus-4.8-thinking': 'claude-opus-4-8',
  'claude-opus-4.6-thinking': 'claude-opus-4-6',
  'claude-sonnet-4.6-thinking': 'claude-sonnet-4-6',
  'claude-opus-4-8-thinking': 'claude-opus-4-8',
  'claude-opus-4-6-thinking': 'claude-opus-4-6',
  'claude-sonnet-4-6-thinking': 'claude-sonnet-4-6',
};

bool _hasVersion(String model, String family, String version) {
  final normalized = model.replaceAll('.', '-');
  return RegExp('$family-$version(?:\$|[^0-9])').hasMatch(normalized);
}

bool _isLegacyBaseOpus4(String model) {
  final normalized = model.replaceAll('.', '-');
  return RegExp(r'opus-4(?:$|-thinking$|-20\d{6}(?:-thinking)?$|@20\d{6}$)')
      .hasMatch(normalized);
}

/// The pricing key a Claude model id maps to, or null when none does.
String? normalizeClaudeModel(String? model) {
  if (model == null) return null;
  final lower = model.toLowerCase().trim().replaceFirst(
    RegExp(r'^anthropic[/:]'),
    '',
  );
  if (lower.isEmpty) return null;
  final alias = _kClaudeAliases[lower];
  if (alias != null) return alias;

  if (_hasVersion(lower, 'fable', '5')) return 'claude-fable-5';
  if (_hasVersion(lower, 'opus', '5')) return 'claude-opus-5';
  if (_hasVersion(lower, 'opus', '4-8')) return 'claude-opus-4-8';
  if (_hasVersion(lower, 'opus', '4-7')) return 'claude-opus-4-7';
  if (_hasVersion(lower, 'opus', '4-6')) return 'claude-opus-4-6';
  if (_hasVersion(lower, 'opus', '4-5')) return 'claude-opus-4-5';
  if (_hasVersion(lower, 'opus', '4-1')) return 'claude-opus-4-1';
  if (_isLegacyBaseOpus4(lower)) return 'claude-opus-4';
  // New Opus 4 point releases share the current low Opus pricing; don't overbill
  // an unknown future id as legacy Opus 4.
  if (lower.contains('opus-4')) return 'claude-opus-4-8';

  if (_hasVersion(lower, 'sonnet', '5')) return 'claude-sonnet-5';
  if (_hasVersion(lower, 'sonnet', '4-6')) return 'claude-sonnet-4-6';
  if (_hasVersion(lower, 'sonnet', '4-5')) return 'claude-sonnet-4-5';
  if (lower.contains('sonnet-4')) return 'claude-sonnet-4-6';
  if (lower.contains('sonnet-3-7') || lower.contains('sonnet-3.7')) {
    return 'claude-sonnet-3-7';
  }
  // Legacy version-first ids like `claude-3-5-sonnet-20241022` are still in
  // historical transcripts read off disk; match them so their cost is not
  // silently dropped.
  if (lower.contains('sonnet-3-5') ||
      lower.contains('sonnet-3.5') ||
      lower.contains('3-5-sonnet') ||
      lower.contains('3.5-sonnet')) {
    return 'claude-sonnet-3-5';
  }
  if (lower.contains('haiku-4-5')) return 'claude-haiku-4-5';
  if (lower.contains('haiku-3-5') ||
      lower.contains('haiku-3.5') ||
      lower.contains('3-5-haiku') ||
      lower.contains('3.5-haiku')) {
    return 'claude-haiku-3-5';
  }
  if (lower.contains('haiku-3')) return 'claude-haiku-3';
  return null;
}

/// One bucket's bill, split across its long-context threshold when it has one.
double _tiered(int tokens, double base, double? above, int? threshold) {
  if (threshold == null || above == null) return tokens * base;
  final below = tokens < threshold ? tokens : threshold;
  final over = tokens - below;
  return below * base + (over > 0 ? over : 0) * above;
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/// USD per million tokens for an OpenAI model, with its long-context tier.
///
/// Simpler than [ClaudePricing] because Codex reports no cache-write bucket at
/// all: it bills fresh input, cached input and output, and nothing else.
class CodexPricing {
  const CodexPricing({
    required this.input,
    required this.cachedInput,
    required this.output,
    this.thresholdTokens,
    this.inputAbove,
    this.cachedInputAbove,
    this.outputAbove,
  });

  final double input;
  final double cachedInput;
  final double output;
  final int? thresholdTokens;
  final double? inputAbove;
  final double? cachedInputAbove;
  final double? outputAbove;
}

const _kCodexLongContextThreshold = 272000;

const _kCodexPricing = <String, CodexPricing>{
  'gpt-5': CodexPricing(input: 1.25, cachedInput: 0.125, output: 10),
  'gpt-5.1': CodexPricing(input: 1.25, cachedInput: 0.125, output: 10),
  'gpt-5.1-codex': CodexPricing(input: 1.25, cachedInput: 0.125, output: 10),
  'gpt-5.1-codex-max': CodexPricing(
    input: 1.25,
    cachedInput: 0.125,
    output: 10,
  ),
  'gpt-5.2': CodexPricing(input: 1.75, cachedInput: 0.175, output: 14),
  'gpt-5.2-codex': CodexPricing(input: 1.75, cachedInput: 0.175, output: 14),
  'gpt-5.3': CodexPricing(input: 1.75, cachedInput: 0.175, output: 14),
  'gpt-5.3-codex': CodexPricing(input: 1.75, cachedInput: 0.175, output: 14),
  'gpt-5.3-codex-spark': CodexPricing(
    input: 1.75,
    cachedInput: 0.175,
    output: 14,
  ),
  'gpt-5.4-mini': CodexPricing(input: 0.75, cachedInput: 0.075, output: 4.5),
  'gpt-5.4-nano': CodexPricing(input: 0.2, cachedInput: 0.02, output: 1.25),
  'gpt-5.4-pro': CodexPricing(
    input: 30,
    cachedInput: 30,
    output: 180,
    thresholdTokens: _kCodexLongContextThreshold,
    inputAbove: 60,
    cachedInputAbove: 60,
    outputAbove: 270,
  ),
  'gpt-5.4': CodexPricing(
    input: 2.5,
    cachedInput: 0.25,
    output: 15,
    thresholdTokens: _kCodexLongContextThreshold,
    inputAbove: 5,
    cachedInputAbove: 0.5,
    outputAbove: 22.5,
  ),
  'gpt-5.5-pro': CodexPricing(
    input: 30,
    cachedInput: 30,
    output: 180,
    thresholdTokens: _kCodexLongContextThreshold,
    inputAbove: 60,
    cachedInputAbove: 60,
    outputAbove: 270,
  ),
  'gpt-5.5': CodexPricing(
    input: 5,
    cachedInput: 0.5,
    output: 30,
    thresholdTokens: _kCodexLongContextThreshold,
    inputAbove: 10,
    cachedInputAbove: 1,
    outputAbove: 45,
  ),
  'gpt-5.6-sol': CodexPricing(
    input: 5,
    cachedInput: 0.5,
    output: 30,
    thresholdTokens: _kCodexLongContextThreshold,
    inputAbove: 10,
    cachedInputAbove: 1,
    outputAbove: 45,
  ),
  'gpt-5.6-terra': CodexPricing(
    input: 2.5,
    cachedInput: 0.25,
    output: 15,
    thresholdTokens: _kCodexLongContextThreshold,
    inputAbove: 5,
    cachedInputAbove: 0.5,
    outputAbove: 22.5,
  ),
  'gpt-5.6-luna': CodexPricing(
    input: 1,
    cachedInput: 0.1,
    output: 6,
    thresholdTokens: _kCodexLongContextThreshold,
    inputAbove: 2,
    cachedInputAbove: 0.2,
    outputAbove: 9,
  ),
};

/// Reasoning-effort suffixes Codex appends to a model id. They change how much
/// the model thinks, never what a token costs, so they come off before pricing.
const _kReasoningTiers = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'auto',
  'none',
];

String? _stripParenthesizedTier(String model) {
  final match = RegExp(r'^(.*)\(([^()]*)\)$').firstMatch(model);
  if (match == null) return model;
  final tier = match.group(2)!.trim().toLowerCase();
  // A parenthesised something-else is not a tier we know how to drop, and
  // pricing a model we misread is worse than pricing nothing.
  if (!_kReasoningTiers.contains(tier)) return null;
  return match.group(1);
}

String _stripDashTiers(String model) {
  var current = model;
  for (var i = 0; i < 4; i++) {
    final suffix = _kReasoningTiers
        .where((tier) => current.endsWith('-$tier'))
        .firstOrNull;
    if (suffix == null) return current;
    current = current.substring(0, current.length - suffix.length - 1);
  }
  return current;
}

/// The pricing key a Codex model id maps to, or null when none does.
String? normalizeCodexModel(String? model) {
  if (model == null) return null;
  final stripped = _stripParenthesizedTier(model.toLowerCase().trim());
  if (stripped == null || stripped.isEmpty) return null;
  final normalized = _stripDashTiers(stripped);

  if (normalized == 'gpt-5' || normalized == 'gpt-5-codex') return 'gpt-5';

  // Longest-first, so `gpt-5.1-codex-max` is not swallowed by `gpt-5.1-codex`.
  const ordered = [
    'gpt-5.1-codex-max',
    'gpt-5.1-codex',
    'gpt-5.1',
    'gpt-5.2-codex',
    'gpt-5.2',
    'gpt-5.3-codex-spark',
    'gpt-5.3-codex',
    'gpt-5.3',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
    'gpt-5.4-pro',
    'gpt-5.4',
    'gpt-5.5-pro',
    'gpt-5.5',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
  ];
  for (final key in ordered) {
    if (normalized == key || normalized.startsWith('$key-')) return key;
  }
  // OpenAI routes the bare `gpt-5.6` alias to Sol. Matched exactly — a
  // `gpt-5.6-` prefix match would swallow the tier ids above and any future
  // cheaper variant.
  if (normalized == 'gpt-5.6') return 'gpt-5.6-sol';
  return null;
}

// ---------------------------------------------------------------------------
// The one entry point
// ---------------------------------------------------------------------------

/// What [totals] cost on [model], or null when the model is not priced here.
///
/// **Null is not zero.** A caller that turned an unknown model into `$0.00`
/// would show a total that is confidently wrong, and nothing on screen would
/// say a model was missed — which is precisely why this returns null and
/// `ProviderLedger.hasUnpricedModel` exists to carry the fact upward.
///
/// [LedgerProvider.opencode] always returns null: OpenCode records its own cost
/// and never needs a price inferred. Reaching here with it is a caller bug, not
/// a missing table.
double? costOf(LedgerProvider provider, String? model, UsageTotals totals) {
  switch (provider) {
    case LedgerProvider.claude:
      final pricing = _kClaudePricing[normalizeClaudeModel(model)];
      if (pricing == null) return null;
      final t = pricing.thresholdTokens;
      return (_tiered(totals.freshInput, pricing.input, pricing.inputAbove, t) +
              _tiered(totals.output, pricing.output, pricing.outputAbove, t) +
              _tiered(
                totals.cacheRead,
                pricing.cacheRead,
                pricing.cacheReadAbove,
                t,
              ) +
              _tiered(
                totals.cacheWrite5m,
                pricing.cacheWrite,
                pricing.cacheWriteAbove,
                t,
              ) +
              _tiered(
                totals.cacheWrite1h,
                pricing.cacheWrite1h,
                pricing.cacheWrite1hAbove,
                t,
              )) /
          1000000;
    case LedgerProvider.codex:
      final pricing = _kCodexPricing[normalizeCodexModel(model)];
      if (pricing == null) return null;
      final t = pricing.thresholdTokens;
      return (_tiered(totals.freshInput, pricing.input, pricing.inputAbove, t) +
              _tiered(
                totals.cacheRead,
                pricing.cachedInput,
                pricing.cachedInputAbove,
                t,
              ) +
              _tiered(totals.output, pricing.output, pricing.outputAbove, t)) /
          1000000;
    case LedgerProvider.opencode:
      return null;
  }
}
