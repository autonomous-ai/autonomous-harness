import 'package:flutter/foundation.dart';

import '../core/local_key_value_store.dart';

/// The dial on this desk, as the daemon last reported it over the local socket.
///
/// Three facts and nothing else: whether it is plugged in, which firmware it greeted with, and whether
/// an update is going over the cable right now. The daemon sends `dial_status` on every change and
/// once more the moment this window connects, so a window opened after the dial was plugged in is not
/// left believing there is none.
class DialStatus {
  const DialStatus({required this.attached, this.fw, this.updating});

  static const none = DialStatus(attached: false);

  final bool attached;

  /// The version it greeted with. Null until the first greeting — a dial can be on the wire before it
  /// has said which image it runs.
  final String? fw;

  /// The version on its way over the cable, or null. The one state that deserves its own word in the
  /// window, because it is the minute in which people unplug the thing.
  final String? updating;

  /// Read with `is`, never `as`: this crosses a socket, so its shape belongs to the other end.
  static DialStatus fromJson(Map<String, dynamic> json) => DialStatus(
    attached: json['attached'] == true,
    fw: json['fw'] is String && (json['fw'] as String).isNotEmpty
        ? json['fw'] as String
        : null,
    updating:
        json['updating'] is String && (json['updating'] as String).isNotEmpty
        ? json['updating'] as String
        : null,
  );
}

/// What the rail's device row needs: the live status, plus one remembered bit — has a dial EVER been
/// seen on this computer?
///
/// That bit is what separates "no device" from "unplugged". A person who has never owned one is
/// shown the way to get one; a person whose dial is in a drawer is told it is unplugged, and is not
/// sold a second one every time they look at the rail. It persists, because the drawer outlives the
/// app's process.
class DialState extends ChangeNotifier {
  DialState([this._storage]);

  static const _seenKey = 'dial_seen';

  final LocalKeyValueStore? _storage;

  DialStatus status = DialStatus.none;
  bool seen = false;

  Future<void> restore() async {
    try {
      seen = (await _storage?.read(_seenKey)) == '1';
    } catch (_) {
      seen =
          false; // a missing or unreadable file is a first run, not a failure
    }
    notifyListeners();
  }

  void apply(DialStatus next) {
    status = next;
    if (next.attached && !seen) {
      seen = true;
      // Never awaited: a write that fails costs one wrong word in the rail on the next launch, which
      // is a far smaller wrong than an exception thrown out of a socket frame.
      _storage?.write(_seenKey, '1').catchError((_) {});
    }
    notifyListeners();
  }
}
