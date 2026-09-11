/// One provider's ledger: whether it is switched on, what the last scan found,
/// and how little of the disk the next scan has to touch.
///
/// The three providers share this class the way Orca's three share
/// `UsageProviderStoreLifecycle`, and for the same reason: the scanners disagree
/// about everything except when to run and what to keep.
///
/// ⚠️ **Off is the resting state, and switching one on is the user's to do.**
/// Scanning reads transcripts nobody offered us — every prompt, path and branch
/// name a session touched sits in those files, and this feature wants only the
/// token counts. Nothing is read until somebody asks for it, which is why
/// [enabled] defaults false and [refresh] returns without looking when it is.
library;

import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../../core/harness_file_store.dart';
import '../../core/local_key_value_store.dart';
import '../../core/snapshot_store.dart';
import 'ledger_scanner.dart';
import 'ledger_types.dart';
import 'usage_overview.dart';

/// How long a scan's result stands before [refresh] will look again.
///
/// Five minutes because these files change only when an agent is mid-turn, and a
/// full rescan walks every transcript on the machine. A panel that rescanned on
/// every open would spend seconds of disk for figures that had not moved.
const kLedgerStaleAfter = Duration(minutes: 5);

/// The cache format. Bumped when the persisted shape changes, which discards
/// every older snapshot rather than trying to read one that means something
/// slightly different.
///
/// ⚠️ **A new field on [UsageTotals] IS a shape change, and forgetting to bump
/// this is NOT a self-healing mistake.** `reasoning` was added while this still
/// read 1: every cached source still matched its `{path, mtime, size}`
/// fingerprint, so 70 of 71 transcripts were served from the old snapshot with
/// the new field defaulted to zero, written back out carrying that zero, and the
/// panel reported 90.9k reasoning against a true 2.3M. Nothing would ever have
/// corrected it, because those fingerprints go on matching forever — only a
/// version bump discards the stale rows. `usage_ledger_test.dart` pins the
/// serialised key set so the next field cannot be added quietly.
const _kCacheVersion = 2;

class UsageLedgerStore extends ChangeNotifier {
  UsageLedgerStore({
    required this.scanner,
    LocalKeyValueStore? settings,
    SnapshotStore? snapshots,
  }) : _settings = settings ?? HarnessFileStore.shared,
       _snapshots =
           snapshots ??
           FileSnapshotStore('usage-ledger-${scanner.provider.name}');

  final LedgerScanner scanner;
  final LocalKeyValueStore _settings;
  final SnapshotStore _snapshots;

  LedgerProvider get provider => scanner.provider;

  // `late`, not plain initialisers: both need [provider], which is read off the
  // scanner the constructor was handed.
  late LedgerScanState _state = LedgerScanState(provider: provider);
  late ProviderLedger _ledger = ProviderLedger(provider: provider);

  /// The sources the last scan saw, keyed by path — what makes the next one
  /// incremental.
  Map<String, ScannedSource> _sources = const {};

  Future<void>? _inFlight;
  bool _disposed = false;

  LedgerScanState get state => _state;
  ProviderLedger get ledger => _ledger;

  String get _enabledKey => 'usageLedger.${provider.name}.enabled';

  /// Read the switch and the last snapshot back off disk.
  ///
  /// Never throws: a cache that cannot be read is a cache that is not there, and
  /// a panel that failed to open because last week's snapshot was truncated
  /// would be a worse bug than a rescan.
  Future<void> load() async {
    _state = LedgerScanState(provider: provider);
    _ledger = ProviderLedger(provider: provider);
    try {
      final enabled = await _settings.read(_enabledKey) == 'true';
      _state = _state.copyWith(enabled: enabled);
      if (enabled) await _loadCache();
    } on Object {
      // Fall through to the empty state this method already installed.
    }
    _notify();
  }

  Future<void> _loadCache() async {
    final contents = await _snapshots.read();
    if (contents == null) return;
    final Object? decoded;
    try {
      decoded = jsonDecode(contents);
    } on Object {
      return;
    }
    if (decoded is! Map<String, Object?>) return;
    if (decoded['version'] != _kCacheVersion) return;

    final sources = decoded['sources'];
    if (sources is! List) return;
    final restored = <String, ScannedSource>{};
    for (final raw in sources) {
      if (raw is! Map<String, Object?>) continue;
      final source = ScannedSource.fromJson(provider, raw);
      if (source != null) restored[source.path] = source;
    }
    _sources = restored;
    _ledger = buildProviderLedger(provider, _sources.values);
    final scannedAt = DateTime.tryParse('${decoded['lastScanAt']}');
    _state = _state.copyWith(
      status: _ledger.hasData ? LedgerStatus.ok : _state.status,
      lastScanAt: scannedAt,
    );
  }

  /// Switch this provider on or off.
  ///
  /// Switching off drops the snapshot from memory AND from disk. Keeping it
  /// would mean a provider the user turned off still had its transcripts
  /// summarised in a file on their machine, which is not what "off" reads as.
  Future<void> setEnabled(bool enabled) async {
    if (_state.enabled == enabled) return;
    _state = _state.copyWith(
      enabled: enabled,
      status: enabled ? LedgerStatus.scanning : LedgerStatus.disabled,
      clearMessage: true,
    );
    _notify();
    try {
      await _settings.write(_enabledKey, '$enabled');
    } on Object {
      // A switch that could not be persisted still holds for this session; the
      // alternative is refusing an action the user can see took effect.
    }
    if (!enabled) {
      _sources = const {};
      _ledger = ProviderLedger(provider: provider);
      _state = _state.copyWith(status: LedgerStatus.disabled, lastScanAt: null);
      await _snapshots.clear();
      _notify();
      return;
    }
    await refresh(force: true);
  }

  /// Rescan if the last result has gone stale, or [force] regardless.
  ///
  /// Concurrent calls share one scan rather than queueing a second walk of the
  /// same disk.
  Future<void> refresh({bool force = false}) {
    if (!_state.enabled) return Future.value();
    final lastScanAt = _state.lastScanAt;
    if (!force &&
        lastScanAt != null &&
        DateTime.now().difference(lastScanAt) < kLedgerStaleAfter) {
      return Future.value();
    }
    return _inFlight ??= _run().whenComplete(() => _inFlight = null);
  }

  Future<void> _run() async {
    _state = _state.copyWith(status: LedgerStatus.scanning, clearMessage: true);
    _notify();

    LedgerScanResult result;
    try {
      result = await scanner.scan(_sources);
    } on Object catch (error) {
      _state = _state.copyWith(
        status: LedgerStatus.failed,
        message: 'Could not read ${provider.label} usage: $error',
      );
      _notify();
      return;
    }
    if (_disposed) return;

    if (result.status != LedgerStatus.ok) {
      // The sources are dropped with the result: a provider that has become
      // unavailable must not keep showing the totals from when it was not.
      _sources = const {};
      _ledger = ProviderLedger(provider: provider);
      _state = _state.copyWith(
        status: result.status,
        message: result.message,
        clearMessage: result.message == null,
      );
      _notify();
      return;
    }

    _sources = {for (final source in result.sources) source.path: source};
    _ledger = buildProviderLedger(provider, _sources.values);
    _state = _state.copyWith(
      status: LedgerStatus.ok,
      lastScanAt: DateTime.now(),
      clearMessage: true,
    );
    _notify();
    await _writeCache();
  }

  Future<void> _writeCache() => _snapshots.write(
    jsonEncode({
      'version': _kCacheVersion,
      'provider': provider.name,
      'lastScanAt': _state.lastScanAt?.toIso8601String(),
      'sources': [for (final source in _sources.values) source.toJson()],
    }),
  );

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
