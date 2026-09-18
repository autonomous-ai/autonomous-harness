import 'dart:convert';
import 'dart:typed_data';

import '../core/harness_file_store.dart';
import '../core/local_key_value_store.dart';
import '../e2ee/bytes.dart';
import '../e2ee/keys.dart';

/// A machine this device linked to by its remote password, and the identity it pinned for it — the
/// same shape as the harness CLI's `machinePeers.json` rows.
class MachinePeer {
  const MachinePeer({
    required this.machineId,
    required this.pub,
    required this.linkedAt,
    this.label = '',
  });

  final String machineId;
  final Uint8List pub;
  final String label;
  final DateTime linkedAt;

  /// Null for a row that is not one — a damaged file loses that row, not every link.
  static MachinePeer? tryParse(Object? json) {
    if (json is! Map) return null;
    final machineId = json['machineId'], pub = json['pub'];
    final linkedAt = json['linkedAt'], label = json['label'];
    if (machineId is! String || pub is! String || linkedAt is! int) return null;
    try {
      return MachinePeer(
        machineId: machineId,
        pub: b64d(pub),
        label: label is String ? label : '',
        linkedAt: DateTime.fromMillisecondsSinceEpoch(linkedAt),
      );
    } on FormatException {
      return null;
    }
  }

  Map<String, Object> toJson() => {
    'machineId': machineId,
    'pub': b64e(pub),
    'label': label,
    'linkedAt': linkedAt.millisecondsSinceEpoch,
  };
}

/// This device's E2EE identity and the machines it has linked — what the harness CLI keeps under
/// its `e2e/` directory, kept here where there is no CLI.
///
/// TODO(security): the identity seed lives in the state file — 0600 on a desktop, the app sandbox
/// on iOS — the protection the CLI gives its own and less than Keychain/DPAPI would. Moving it
/// into the platform keystore is a follow-up.
class ViewerKeyStore {
  ViewerKeyStore({LocalKeyValueStore? storage})
    : _storage = storage ?? HarnessFileStore.shared;

  final LocalKeyValueStore _storage;
  Future<E2eeIdentity>? _identity;

  /// The linked machines, held after the first read — the same treatment
  /// [identity] has always had, and for a sharper reason.
  ///
  /// [peers] is on the dial path: every connection, and every RECONNECT, asks
  /// for the peer before it opens a socket (`viewerRelayCodecs`). Uncached, a
  /// phone waking to four machines that each redial takes four exclusive locks
  /// on `state.json` and four full parses of it — in series, because the store
  /// queues them — while the screen says "Connecting to your machine…".
  ///
  /// Every write goes through [_write], which replaces this, so the cache cannot
  /// outlive a link or an unlink. It is per-instance and the app builds one
  /// store (`ViewerServices`), so there is no second copy to go stale.
  Future<List<MachinePeer>>? _peers;

  static const _seedKey = 'viewer_e2ee_identity_seed';
  static const _peersKey = 'viewer_e2ee_machine_peers';

  /// Minted on first use and kept: every linked machine has pinned it.
  Future<E2eeIdentity> identity() => _identity ??= _loadOrMintIdentity();

  Future<E2eeIdentity> _loadOrMintIdentity() async {
    final stored = await _storage.read(_seedKey);
    if (stored != null) return E2eeIdentity.fromSeed(b64d(stored));
    final minted = await E2eeIdentity.generate();
    await _storage.write(_seedKey, b64e(minted.seed));
    return minted;
  }

  /// Newest link first. Read once and held — see [_peers].
  Future<List<MachinePeer>> peers() => _peers ??= _readPeers();

  Future<List<MachinePeer>> _readPeers() async {
    final raw = await _storage.read(_peersKey);
    if (raw == null) return const [];
    final Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } on FormatException {
      return const [];
    }
    if (decoded is! List) return const [];
    return decoded.map(MachinePeer.tryParse).whereType<MachinePeer>().toList()
      ..sort((a, b) => b.linkedAt.compareTo(a.linkedAt));
  }

  Future<MachinePeer?> peer(String machineId) async {
    for (final peer in await peers()) {
      if (peer.machineId == machineId) return peer;
    }
    return null;
  }

  Future<void> pin(String machineId, List<int> pub, {String label = ''}) async {
    await _write([
      for (final peer in await peers())
        if (peer.machineId != machineId) peer,
      MachinePeer(
        machineId: machineId,
        pub: Uint8List.fromList(pub),
        label: label,
        linkedAt: DateTime.now(),
      ),
    ]);
  }

  /// False when [machineId] was not linked.
  Future<bool> unlink(String machineId) async {
    final current = await peers();
    final remaining = current.where((peer) => peer.machineId != machineId).toList();
    if (remaining.length == current.length) return false;
    await _write(remaining);
    return true;
  }

  /// The one path that changes the peer list, so the one place the cache is
  /// replaced.
  ///
  /// ⚠️ The cache is dropped BEFORE the write and reseeded only once it lands.
  /// Seeding first would publish a list that a failed write never persisted, and
  /// this app would then dial a machine it believes it linked until it was
  /// relaunched. Dropping first costs at most one re-read on the next dial; both
  /// orders keep [peers] sorted, because the reseeded list is sorted here the
  /// same way [_readPeers] sorts the file.
  Future<void> _write(List<MachinePeer> peers) async {
    _peers = null;
    await _storage.write(
      _peersKey,
      jsonEncode([for (final peer in peers) peer.toJson()]),
    );
    final sorted = [...peers]
      ..sort((a, b) => b.linkedAt.compareTo(a.linkedAt));
    _peers = Future.value(sorted);
  }
}
