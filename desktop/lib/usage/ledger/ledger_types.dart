/// What the agent CLIs on THIS computer have spent, in one shape.
///
/// Not to be confused with `usage/usage_window.dart` beside it. That one asks
/// the vendors *how much of your rate limit is left* — a percentage, scoped to
/// an **account**, true no matter which machine burned it. This one reads the
/// logs those CLIs already wrote to this disk and counts **tokens**, scoped to
/// a **machine**, with a history behind it. Neither answers the other's
/// question, which is why both exist.
///
/// ⚠️ **Local only, and that is the decision rather than a gap.** Agents launched
/// through Harness run on remote machines and write their transcripts there;
/// nothing here reaches them. A ledger that silently mixed one machine's
/// sessions into another's totals would be worse than one that says whose
/// figures these are, so every surface names the computer it read.
library;

/// Which agent CLI a reading came from.
///
/// Three, because three write something countable on disk. The other engines
/// Harness can launch (copilot, grok, hermes, pi) either keep no local ledger or
/// keep one with no token figures in it, and a row that can only ever say
/// "unsupported" costs a glance and returns nothing — the same reason
/// [UsageProvider] lists only two.
enum LedgerProvider {
  claude('Claude', 'claude'),
  codex('Codex', 'codex'),
  opencode('OpenCode', 'opencode');

  const LedgerProvider(this.label, this.engineId);

  /// How the provider is named on screen.
  final String label;

  /// The engine id its agents run under — also how `EngineMark` finds the logo
  /// the machine rail already draws. Spelled out rather than taken from [name]
  /// because Dart would give `opencode` either way but the two are different
  /// facts, and only one of them is safe to rename.
  final String engineId;
}

/// One reading's tokens, in buckets that mean the same thing for all three.
///
/// ⚠️ **[freshInput] is cache-EXCLUSIVE everywhere here, and getting there costs
/// a subtraction for exactly one provider.** The vendors disagree: Claude's
/// `input_tokens` already excludes both cache buckets, and OpenCode's
/// `tokens_input` is likewise a peer of `tokens_cache_read` — but Codex's
/// `input_tokens` *includes* `cached_input_tokens`, so its scanner subtracts one
/// from the other before building this. Orca keeps the three record types apart
/// rather than normalising, on the grounds that a single shape pushes nullable
/// handling onto every consumer; that is the right call for a scanner that must
/// round-trip a provider's own file format, and the wrong one here, where the
/// only consumer is a panel that adds three providers into one figure. A panel
/// summing a mix of cache-inclusive and cache-exclusive inputs would overcount
/// Codex by however much it cached, which on a long session is most of it.
///
/// [output] INCLUDES reasoning tokens for every provider. They are billed at the
/// output rate, so carrying them as a fourth bucket would invite a caller to add
/// them again on top.
class UsageTotals {
  const UsageTotals({
    this.freshInput = 0,
    this.output = 0,
    this.cacheRead = 0,
    this.cacheWrite5m = 0,
    this.cacheWrite1h = 0,
    this.reasoning = 0,
  });

  /// Input the model actually read this turn, with cache hits taken out.
  final int freshInput;

  /// Everything generated, reasoning included.
  final int output;

  /// Input served from cache. Billed at roughly a tenth of [freshInput].
  final int cacheRead;

  /// Input written into the 5-minute cache. Billed at 1.25x base input.
  final int cacheWrite5m;

  /// Input written into the 1-hour cache. Billed at 2x base input.
  ///
  /// Kept apart from [cacheWrite5m] because the two TTLs are different prices
  /// off the same token count, and Claude is the only provider that reports the
  /// split. The others leave this zero, which is not a claim that they never
  /// write a long-lived cache — only that they never said.
  final int cacheWrite1h;

  /// The thinking part of [output], reported for its own sake.
  ///
  /// ⚠️ **A SUBSET of [output], never a bucket beside it** — which is why it is
  /// absent from [total] and from every mix that has to add to a whole. All
  /// three providers report it (`output_tokens_details.thinking_tokens`,
  /// `reasoning_output_tokens`, `tokens_reasoning`) and it is billed at the
  /// output rate, so adding it anywhere would charge the same thinking twice.
  /// It is carried because "how much of this was the model thinking" is a
  /// question the panel answers and nothing else can reconstruct.
  final int reasoning;

  /// Every bucket added up. What "total tokens" means on the panel.
  ///
  /// [reasoning] is deliberately absent — see its own note.
  int get total =>
      freshInput + output + cacheRead + cacheWrite5m + cacheWrite1h;

  /// Everything read from or written to a cache, which is how the overview's
  /// three-way mix groups them.
  int get cache => cacheRead + cacheWrite;

  /// Everything written into a cache, at either TTL.
  int get cacheWrite => cacheWrite5m + cacheWrite1h;

  bool get isEmpty => total == 0;

  UsageTotals operator +(UsageTotals other) => UsageTotals(
    freshInput: freshInput + other.freshInput,
    output: output + other.output,
    cacheRead: cacheRead + other.cacheRead,
    cacheWrite5m: cacheWrite5m + other.cacheWrite5m,
    cacheWrite1h: cacheWrite1h + other.cacheWrite1h,
    reasoning: reasoning + other.reasoning,
  );

  Map<String, Object?> toJson() => {
    'freshInput': freshInput,
    'output': output,
    'cacheRead': cacheRead,
    'cacheWrite5m': cacheWrite5m,
    'cacheWrite1h': cacheWrite1h,
    'reasoning': reasoning,
  };

  static UsageTotals fromJson(Map<String, Object?> json) => UsageTotals(
    freshInput: _int(json['freshInput']),
    output: _int(json['output']),
    cacheRead: _int(json['cacheRead']),
    cacheWrite5m: _int(json['cacheWrite5m']),
    cacheWrite1h: _int(json['cacheWrite1h']),
    reasoning: _int(json['reasoning']),
  );
}

/// One billable exchange, already attributed to a model and a moment.
///
/// The grain differs by provider — Claude bills per assistant turn, Codex per
/// `token_count` event, OpenCode per session — and that difference is left
/// alone rather than smoothed over. It only shows up in the session count, which
/// is why the panel counts *sessions* and never *turns*: a turn means three
/// different things here and a session means one.
class LedgerEntry {
  const LedgerEntry({
    required this.provider,
    required this.sessionId,
    required this.timestamp,
    required this.totals,
    this.model,
    this.directory,
    this.costUsd,
    this.dedupeKey,
  });

  final LedgerProvider provider;
  final String sessionId;
  final DateTime timestamp;
  final UsageTotals totals;

  /// Identity for the same exchange seen in two different files, or null when
  /// the provider gives nothing stable enough to match on.
  ///
  /// ⚠️ **Cross-SOURCE, which is a different job from the per-file collapse the
  /// Claude scanner does.** Resuming or forking a session copies rows into a new
  /// file: Codex duplicates its `token_count` records byte-for-byte, and Claude
  /// carries message and request ids across a fork even as it rewrites
  /// `sessionId`. Both would otherwise be counted once per file they appear in,
  /// so the aggregation drops a repeat regardless of which file it came from.
  /// Deliberately keyed on the record's own fields and never on the session id,
  /// which is the one thing a fork changes.
  final String? dedupeKey;

  /// The model as the provider named it, or null when the log never said.
  ///
  /// Null is what makes a cost unknown rather than zero — see [costUsd].
  final String? model;

  /// The working directory the session ran in, when the log carries one.
  final String? directory;

  /// What the provider itself said this cost, in USD.
  ///
  /// Set only for OpenCode, which keeps a `cost` column of its own. **Null is
  /// not zero**: for Claude and Codex nobody wrote a price down, so the ledger
  /// derives one from [model] and `model_pricing.dart`. A provider that says
  /// `0.0` — which is what OpenCode records for every session run on a Grid,
  /// since Grid inference is free — is making a measurement, and that must not
  /// render the same as never having been told.
  final double? costUsd;

  Map<String, Object?> toJson() => {
    'sessionId': sessionId,
    'timestamp': timestamp.toIso8601String(),
    'totals': totals.toJson(),
    if (model != null) 'model': model,
    if (directory != null) 'directory': directory,
    if (costUsd != null) 'costUsd': costUsd,
    if (dedupeKey != null) 'dedupeKey': dedupeKey,
  };

  static LedgerEntry? fromJson(
    LedgerProvider provider,
    Map<String, Object?> json,
  ) {
    final timestamp = DateTime.tryParse('${json['timestamp']}');
    final sessionId = json['sessionId'];
    if (timestamp == null || sessionId is! String) return null;
    final totals = json['totals'];
    return LedgerEntry(
      provider: provider,
      sessionId: sessionId,
      timestamp: timestamp,
      totals: totals is Map<String, Object?>
          ? UsageTotals.fromJson(totals)
          : const UsageTotals(),
      model: json['model'] as String?,
      directory: json['directory'] as String?,
      costUsd: (json['costUsd'] as num?)?.toDouble(),
      dedupeKey: json['dedupeKey'] as String?,
    );
  }
}

/// One provider's whole reading: what the scan found, or why it found nothing.
class ProviderLedger {
  const ProviderLedger({
    required this.provider,
    this.entries = const [],
    this.totals = const UsageTotals(),
    this.costUsd,
    this.hasUnpricedModel = false,
    this.sessionCount = 0,
  });

  final LedgerProvider provider;

  /// Every entry the scan kept, oldest first.
  final List<LedgerEntry> entries;

  /// [entries] added up, precomputed because every surface wants it.
  final UsageTotals totals;

  /// The bill, in USD, for the entries that could be priced.
  ///
  /// Null when nothing here could be priced at all. When [hasUnpricedModel] is
  /// true this is a floor rather than a total — see `UsageOverview`.
  final double? costUsd;

  /// At least one entry names a model no price is known for, so [costUsd]
  /// undercounts.
  ///
  /// The panel says so out loud. A cost quietly missing a model is the failure
  /// this flag exists to make visible.
  final bool hasUnpricedModel;

  /// Distinct sessions behind [entries].
  final int sessionCount;

  bool get hasData => entries.isNotEmpty;
}

/// One day's spend for one provider, which is what the intensity grid draws.
class LedgerDay {
  const LedgerDay({required this.day, required this.totals, this.costUsd});

  /// Midnight local time. Local rather than UTC on purpose: somebody reading
  /// "yesterday" means the day they had, not the one Greenwich had.
  final DateTime day;
  final UsageTotals totals;
  final double? costUsd;
}

/// Why a provider's figures are, or are not, on screen.
///
/// [disabled] is the resting state and not a fault: scanning reads files the
/// user never offered us, so every provider stays off until it is switched on.
/// [unavailable] is kept apart from [failed] for the reason
/// `UsageStatus.signedOut` is kept apart from `UsageStatus.failed` — a machine
/// with no OpenCode installed will never be fixed by retrying, and offering a
/// Retry there fails identically forever.
enum LedgerStatus { disabled, scanning, ok, unavailable, failed }

/// Where one provider's scan stands.
class LedgerScanState {
  const LedgerScanState({
    required this.provider,
    this.status = LedgerStatus.disabled,
    this.enabled = false,
    this.lastScanAt,
    this.message,
  });

  final LedgerProvider provider;
  final LedgerStatus status;

  /// Whether the user has switched this provider on. Held apart from [status]
  /// because an enabled provider can still be [LedgerStatus.unavailable], and
  /// switching it off must not be mistaken for it having nothing to say.
  final bool enabled;

  /// When the last successful scan finished. Null until one has.
  final DateTime? lastScanAt;

  /// Why there are no figures — set for [LedgerStatus.unavailable] and
  /// [LedgerStatus.failed], null otherwise.
  final String? message;

  LedgerScanState copyWith({
    LedgerStatus? status,
    bool? enabled,
    DateTime? lastScanAt,
    String? message,
    bool clearMessage = false,
  }) => LedgerScanState(
    provider: provider,
    status: status ?? this.status,
    enabled: enabled ?? this.enabled,
    lastScanAt: lastScanAt ?? this.lastScanAt,
    message: clearMessage ? null : (message ?? this.message),
  );
}

int _int(Object? value) => value is num && value.isFinite ? value.toInt() : 0;
