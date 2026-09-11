/// The three provider stores as one thing the panel can listen to.
///
/// Thin on purpose: every decision worth testing lives in `usage_overview.dart`
/// (the arithmetic) or `usage_ledger_store.dart` (the lifecycle). This owns only
/// the fan-out — one listener per store, one notification out — so a widget does
/// not have to hold three `ListenableBuilder`s and re-derive the overview in
/// each of them.
///
/// ⚠️ **Nothing here polls.** `UsageController` beside it runs a 60-second timer
/// because a rate limit moves on its own; a ledger moves only when an agent
/// writes to this disk, and a full rescan walks every transcript on the machine.
/// So this scans when the panel opens and when somebody asks — and
/// `kLedgerStaleAfter` keeps even that from re-walking the disk on every visit.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/local_key_value_store.dart';
import 'claude_ledger_scanner.dart';
import 'codex_ledger_scanner.dart';
import 'ledger_types.dart';
import 'opencode_ledger_scanner.dart';
import 'usage_ledger_store.dart';
import 'usage_overview.dart';
import 'usage_report.dart';

class UsageLedgerController extends ChangeNotifier {
  UsageLedgerController({
    List<UsageLedgerStore>? stores,
    LocalKeyValueStore? settings,
  }) : stores =
           stores ??
           [
             UsageLedgerStore(
               scanner: ClaudeLedgerScanner(),
               settings: settings,
             ),
             UsageLedgerStore(
               scanner: CodexLedgerScanner(),
               settings: settings,
             ),
             UsageLedgerStore(
               scanner: OpenCodeLedgerScanner(),
               settings: settings,
             ),
           ] {
    for (final store in this.stores) {
      store.addListener(_onStoreChanged);
    }
  }

  /// In the order the panel lists them, which is the order they were added to
  /// the app rather than anything the data decides — a list that reordered
  /// itself as the totals moved would be unreadable.
  final List<UsageLedgerStore> stores;

  bool _loaded = false;

  /// Whether [load] has finished. Before it has, the panel knows nothing — not
  /// even which providers are switched on — and draws its skeleton rather than
  /// an empty state that would be a claim.
  bool get loaded => _loaded;

  UsageLedgerStore storeFor(LedgerProvider provider) =>
      stores.firstWhere((store) => store.provider == provider);

  /// Read every switch and snapshot off disk, then rescan whatever is on.
  ///
  /// The reads run together because one store's disk has nothing to say about
  /// another's, and three sequential `~/.harness` reads is three chances to make
  /// the panel wait.
  Future<void> load() async {
    await Future.wait([for (final store in stores) store.load()]);
    _loaded = true;
    notifyListeners();
    await refresh();
  }

  /// Rescan every enabled provider. A disabled one returns immediately.
  Future<void> refresh({bool force = false}) =>
      Future.wait([for (final store in stores) store.refresh(force: force)]);

  /// True while any provider is mid-scan — what the refresh button spins on.
  bool get isScanning =>
      stores.any((store) => store.state.status == LedgerStatus.scanning);

  List<LedgerScanState> get scanStates => [
    for (final store in stores) store.state,
  ];

  /// Every provider folded into the figures the panel prints, over [range].
  ///
  /// The range is applied here rather than at scan time, so changing it redraws
  /// from what is already in memory instead of re-walking the disk — the scan is
  /// the expensive half and it does not depend on the window being looked at.
  UsageOverview overviewFor(UsageRange range, {DateTime? now}) => buildOverview(
    ledgers: [
      for (final store in stores) clipLedger(store.ledger, range, now: now),
    ],
    enabledCount: stores.where((store) => store.state.enabled).length,
    lastScanAt: _lastScanAt,
  );

  /// The most recent scan across the providers.
  ///
  /// The newest rather than the oldest: the line it feeds says when these
  /// figures were last brought up to date, and a provider switched on an hour
  /// ago that has not changed since should not make a scan from a moment ago
  /// read as stale.
  DateTime? get _lastScanAt {
    DateTime? latest;
    for (final store in stores) {
      final at = store.state.lastScanAt;
      if (at == null) continue;
      if (latest == null || at.isAfter(latest)) latest = at;
    }
    return latest;
  }

  void _onStoreChanged() => notifyListeners();

  @override
  void dispose() {
    for (final store in stores) {
      store.removeListener(_onStoreChanged);
      store.dispose();
    }
    super.dispose();
  }
}
