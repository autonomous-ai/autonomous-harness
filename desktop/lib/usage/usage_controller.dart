import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/test_run.dart';
import 'claude_usage_source.dart';
import 'codex_usage_source.dart';
import 'usage_accounts.dart';
import 'usage_source.dart';
import 'usage_window.dart';

/// What each agent account has spent, kept current for the status rail.
///
/// Polling, because neither vendor pushes,
/// and neither figure moves fast enough to be worth a socket. A minute is also
/// the granularity the countdowns are printed at, so a faster poll would redraw
/// the same minute.
///
/// **The last good reading stays on screen through a failed refresh** — a
/// strip that blanked whenever a network hiccup landed would be worse than one
/// that quietly went [stale]. The sources are
/// read in parallel because one being slow says nothing about the other.
class UsageController extends ChangeNotifier {
  UsageController({
    List<UsageSource>? sources,
    this.remote,
    this.interval = const Duration(seconds: 60),
    bool autoStart = true,
  }) : _sources = sources ?? [ClaudeUsageSource(), CodexUsageSource()] {
    for (final source in _sources) {
      _readings[source.provider] = ProviderUsage.loading(source.provider);
    }
    // Never on its own under test: a periodic timer stops `pumpAndSettle`
    // ever settling, and these sources shell out and open sockets. A test that
    // wants a cycle asks for one with [refresh], or starts the timer itself.
    if (autoStart && !kUnderTest) start();
  }

  final List<UsageSource> _sources;

  /// Asks every connected remote machine what ITS accounts have spent
  /// (`AppNotifier.readRemoteUsage`). Null reads this computer only — every
  /// test, and anything that has no machines to ask.
  final Future<List<MachineUsage>> Function()? remote;

  List<MachineUsage> _remote = const [];
  int _remoteRequest = 0;

  /// How often to ask again.
  final Duration interval;

  final Map<UsageProvider, ProviderUsage> _readings = {};

  Timer? _timer;
  bool _disposed = false;
  int _request = 0;

  /// A cycle has been asked for and none has landed yet.
  ///
  /// Both halves matter. It is false before [start], because a controller
  /// nobody has started is not *waiting* for anything — and a rail that drew a
  /// skeleton for it would be promising an answer that was never coming. It is
  /// false again after the first cycle lands, so a later refresh keeps the
  /// figures already on screen rather than replacing them with skeletons once
  /// a minute.
  bool get loading => _started && !_landed;

  bool _started = false;
  bool _landed = false;

  /// The last cycle failed for every provider and what is on screen is older
  /// than it looks.
  bool stale = false;

  /// Every provider's reading, in the order the sources were given.
  List<ProviderUsage> get readings => [
    for (final source in _sources) _readings[source.provider]!,
  ];

  /// The providers with figures worth printing on the rail.
  List<ProviderUsage> get answered => [
    for (final reading in readings)
      if (reading.hasFigures) reading,
  ];

  /// One figure per ACCOUNT, this computer's first — see [groupUsageAccounts].
  ///
  /// [readings] stays this computer's alone; this is the grouped view.
  List<UsageAccount> get accounts => groupUsageAccounts(readings, _remote);

  /// Whether the rail has anything at all to say — figures, or a reason there
  /// are none. False only before the first cycle resolves.
  bool get hasAnswer => readings.any((r) => r.status != UsageStatus.loading);

  void start() {
    if (_disposed || _timer != null) return;
    _started = true;
    unawaited(refresh());
    _timer = Timer.periodic(interval, (_) => unawaited(refresh()));
  }

  /// This computer's accounts and every remote machine's, asked at once — and
  /// landing apart. A remote machine is a relay round trip away and may never
  /// answer at all (see `AppNotifier.readRemoteUsage`), so it must not hold up
  /// figures this computer already has. Each half notifies when it lands;
  /// the future completes when both have.
  Future<void> refresh() async {
    await Future.wait([_refreshLocal(), _refreshRemote()]);
  }

  Future<void> _refreshRemote() async {
    final ask = remote;
    if (ask == null) return;
    final request = ++_remoteRequest;
    final List<MachineUsage> answers;
    try {
      answers = await ask();
    } catch (_) {
      // Keep the last good answer, the same rule the local half follows.
      return;
    }
    // A slower, older answer must not overwrite a newer one.
    if (_disposed || request != _remoteRequest) return;
    _remote = answers;
    notifyListeners();
  }

  Future<void> _refreshLocal() async {
    _started = true;
    final request = ++_request;
    final results = await Future.wait(_sources.map((s) => s.read()));
    // A refresh that finished after a newer one started is thrown away: its
    // figures are the older truth, and writing them would make the rail count
    // backwards.
    if (_disposed || request != _request) return;
    for (final result in results) {
      _readings[result.provider] = result;
    }
    _landed = true;
    stale = results.every((r) => r.status == UsageStatus.failed);
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _timer = null;
    super.dispose();
  }
}
