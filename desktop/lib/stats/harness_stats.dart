/// How much work this app has done: agents started, turns taken, time spent.
///
/// Ported from Orca's `src/main/stats/` — same three cards, same "tracking
/// since" line, same balanced start/stop accounting for the clock.
///
/// **What it counts and what it does not.** These are the app's OWN events, not
/// a vendor's and not a file on disk: the ledger beside it (`usage/ledger/`)
/// reads what the agent CLIs wrote and counts tokens, and this counts what
/// Harness itself watched happen. So it needs no permission and has no enable
/// switch — an app may count what it did.
///
/// ⚠️ **Two deliberate differences from Orca.**
///
/// 1. **PRs are not a Harness concept**, so the third card is TURNS. Orca opens
///    pull requests from its worktrees and counts them; this app launches agents
///    on machines and never touches a forge. A card wired to a number that can
///    only ever be zero is worse than a card showing something true, and turns
///    fall out of the same event stream the clock already needs.
/// 2. **No event log is kept.** Orca persists up to 10,000 individual events
///    beside its aggregates, for per-repo breakdowns it does not yet draw. That
///    costs a ~900KB rewrite every few seconds on a busy session, so what is
///    persisted here is the aggregates alone. [firstEventAt] is the reason Orca
///    needed the log to be lossy-safe, and it is stored directly here for the
///    same reason: it is set once and never moves, so trimming can never drag
///    "tracking since" forward.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../core/snapshot_store.dart';
import '../core/test_run.dart';

/// How long to wait before writing after something happens.
///
/// Five seconds, as Orca uses: these events are infrequent and nothing on screen
/// waits for the write. A turn that starts and ends inside the window costs one
/// write rather than two.
const kStatsWriteDebounce = Duration(seconds: 5);

/// The format. Bumped when the persisted shape changes, which discards an older
/// snapshot rather than reading one that means something slightly different.
const _kStatsVersion = 1;

/// The three figures and the date under them.
@immutable
class StatsSummary {
  const StatsSummary({
    this.agentsSpawned = 0,
    this.turns = 0,
    this.timeWorked = Duration.zero,
    this.firstEventAt,
  });

  /// Agents this app has created. Counted at creation, not at first message —
  /// an agent that was launched and never spoken to was still launched.
  final int agentsSpawned;

  /// Turns started. One per time somebody set an agent working.
  final int turns;

  /// Time agents spent working, summed across every finished turn.
  final Duration timeWorked;

  /// When the first event landed, or null before any has.
  ///
  /// Set once and never moved, so the "Tracking since" line means what it says
  /// however much is later forgotten.
  final DateTime? firstEventAt;

  /// Nothing has happened yet — what the empty state keys on.
  bool get isEmpty => agentsSpawned == 0 && turns == 0;
}

class HarnessStats extends ChangeNotifier {
  HarnessStats({SnapshotStore? store})
    : _store = store ?? FileSnapshotStore('harness-stats');

  final SnapshotStore _store;

  int _agentsSpawned = 0;
  int _turns = 0;
  int _workedMs = 0;
  DateTime? _firstEventAt;

  /// Turns under way, keyed by whatever the caller uses to name one, mapped to
  /// when it started.
  ///
  /// In memory only. A turn still running when the app quits is closed out at
  /// [flush]; a turn still running when the app is KILLED is lost, which is the
  /// right trade — the alternative is persisting a start time that a crash would
  /// later turn into a multi-day "turn".
  final Map<String, DateTime> _live = {};

  Timer? _writeTimer;
  bool _disposed = false;

  StatsSummary get summary => StatsSummary(
    agentsSpawned: _agentsSpawned,
    turns: _turns,
    timeWorked: Duration(milliseconds: _workedMs),
    firstEventAt: _firstEventAt,
  );

  /// Read the counters back off disk. Never throws.
  Future<void> load() async {
    final contents = await _store.read();
    if (contents == null) return;
    try {
      final decoded = jsonDecode(contents);
      if (decoded is! Map<String, Object?>) return;
      if (decoded['version'] != _kStatsVersion) return;
      _agentsSpawned = _int(decoded['agentsSpawned']);
      _turns = _int(decoded['turns']);
      _workedMs = _int(decoded['workedMs']);
      final first = decoded['firstEventAt'];
      _firstEventAt = first is String ? DateTime.tryParse(first) : null;
    } on Object {
      // A snapshot we cannot read is one we do not have. Counting restarts
      // rather than refusing to open the screen.
      return;
    }
    _notify();
  }

  /// An agent was created.
  void onAgentSpawned({DateTime? at}) {
    _agentsSpawned++;
    _stamp(at);
    _schedule();
    _notify();
  }

  /// An agent started working. [key] must identify one turn — the same value has
  /// to come back to [onTurnEnded].
  ///
  /// A second start on a live key is ignored rather than restarting the clock:
  /// `turn_heartbeat` and a reconnect can both re-announce a turn already under
  /// way, and taking the later timestamp would quietly discard the time before
  /// it.
  void onTurnStarted(String key, {DateTime? at}) {
    if (_live.containsKey(key)) return;
    final now = at ?? DateTime.now();
    _live[key] = now;
    _turns++;
    _stamp(now);
    _schedule();
    _notify();
  }

  /// An agent stopped working.
  ///
  /// An unmatched end is dropped, exactly as Orca drops an unbalanced stop: the
  /// app reconnects to agents that were already running, so a `turn_ended` for a
  /// turn this process never saw start has no duration to contribute and
  /// inventing one would be worse than counting nothing.
  void onTurnEnded(String key, {DateTime? at}) {
    final startedAt = _live.remove(key);
    if (startedAt == null) return;
    final elapsed = (at ?? DateTime.now()).difference(startedAt);
    if (elapsed > Duration.zero) _workedMs += elapsed.inMilliseconds;
    _schedule();
    _notify();
  }

  /// Close out every live turn and write now.
  ///
  /// Idempotent, and safe to call on the quit path: the turns still running are
  /// ended at this moment, so their time is counted rather than lost.
  Future<void> flush() async {
    final now = DateTime.now();
    for (final key in _live.keys.toList()) {
      onTurnEnded(key, at: now);
    }
    _writeTimer?.cancel();
    _writeTimer = null;
    await _write();
  }

  void _stamp(DateTime? at) => _firstEventAt ??= at ?? DateTime.now();

  void _schedule() {
    // Never on a timer under test: a pending `Timer` is a `pumpAndSettle` that
    // never settles, and the write would reach a real `~/.harness` besides.
    if (kUnderTest || _disposed || _writeTimer != null) return;
    _writeTimer = Timer(kStatsWriteDebounce, () {
      _writeTimer = null;
      unawaited(_write());
    });
  }

  Future<void> _write() => _store.write(
    jsonEncode({
      'version': _kStatsVersion,
      'agentsSpawned': _agentsSpawned,
      'turns': _turns,
      'workedMs': _workedMs,
      'firstEventAt': _firstEventAt?.toIso8601String(),
    }),
  );

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _writeTimer?.cancel();
    _writeTimer = null;
    super.dispose();
  }

  static int _int(Object? value) =>
      value is num && value.isFinite && value > 0 ? value.toInt() : 0;
}

/// The app's own counters.
///
/// A singleton like `analytics` and `terminalFontStore`, for the same reason: the
/// call sites are `AppNotifier`'s event dispatcher and one settings pane, and
/// threading an instance from one to the other would mean handing a `Ref` to a
/// widget that has no other use for one.
final harnessStats = HarnessStats();
