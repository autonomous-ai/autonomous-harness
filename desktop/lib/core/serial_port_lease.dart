import 'dart:async';
import 'dart:io';

import 'harness_file_store.dart';

/// Held while something outside the daemon needs the dial's USB serial port to itself.
///
/// Exists because two parts of this app want that port and neither knew about the other. Flashing
/// runs `harness stop` first — a serial port on macOS is exclusive, so the daemon has to let go — and
/// then writes for the better part of a minute. Meanwhile the app supervises that same daemon on a
/// five-second timer and starts it again the moment it notices it is gone. The daemon comes up,
/// reopens the dial, and esptool loses the port mid-write: the flash dies a few tens of kilobytes in
/// with "No more data to read from the serial port", which reads like broken hardware and is not.
///
/// A counter rather than a boolean so overlapping holders cannot release each other's claim, and
/// [hold] releases in a `finally` so a thrown or cancelled flash cannot leave supervision switched
/// off for the rest of the session — which would be a worse bug than the one this fixes, and a
/// silent one.
abstract final class SerialPortLease {
  static int _holders = 0;

  /// True while the daemon must not be started, because it would take the port.
  static bool get held => _holders > 0;

  /// How long a flag left behind by a flash that could not clean up is believed.
  ///
  /// A write takes a couple of minutes; ten is generous and still bounded. Without a bound, a script
  /// killed with -9 would switch daemon supervision off for the rest of the machine's life — a worse
  /// fault than the one this prevents, and a silent one.
  static const _staleAfter = Duration(minutes: 10);

  /// Whether a flash started OUTSIDE this app is holding the port.
  ///
  /// The in-process counter only knows about flashes this app started. Someone running
  /// `harness flash` in a terminal while the app is open hits exactly the same collision — the app
  /// restarts the daemon underneath them and their flash dies — and that is the case that matters
  /// most, because it is how a device already in someone's hands gets updated.
  ///
  /// The flasher writes this file before it stops the daemon and removes it when it starts it again.
  static bool heldByAnotherProcess({Map<String, String>? environment}) {
    try {
      // Honours the same override the flasher script reads, so the two sides cannot end up looking
      // in different places.
      final env = environment ?? Platform.environment;
      final dir =
          env['HARNESS_FLASHER_CACHE'] ??
          HarnessFileStore.defaultDirectoryPath(
            environment: environment,
            name: 'flasher',
          );
      final file = File('$dir/flashing');
      if (!file.existsSync()) return false;
      final started = int.tryParse(file.readAsStringSync().trim());
      if (started == null) return false;
      final age = DateTime.now().difference(
        DateTime.fromMillisecondsSinceEpoch(started * 1000),
      );
      return !age.isNegative && age < _staleAfter;
    } catch (_) {
      // Unreadable is not "being flashed": failing open here only risks the collision this guards
      // against, while failing closed would strand the daemon on any filesystem hiccup.
      return false;
    }
  }

  static Future<T> hold<T>(Future<T> Function() action) async {
    _holders++;
    try {
      return await action();
    } finally {
      _holders--;
    }
  }
}
