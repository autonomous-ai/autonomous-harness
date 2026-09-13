import 'dart:convert';

import '../core/harness_file_store.dart';
import '../core/local_key_value_store.dart';
import 'pane_preset.dart';
import 'terminal_pane.dart';
import 'swarm.dart';

/// Remembers which agents were on screen, so reopening the app returns to the
/// desk it was left on rather than to whatever happens to load first.
///
/// Only the intent is stored — machine and agent ids. Sizes, sessions and
/// stream ids are all facts about a particular run and would be lies by the
/// next one.
class PaneLayoutStore {
  PaneLayoutStore({LocalKeyValueStore? storage})
    : _storage = storage ?? HarnessFileStore.shared;

  static const _key = 'terminal_pane_layout';

  /// Chosen shapes, by tile count. A SECOND key rather than a field on the
  /// layout entries: the two answer different questions — which agents were
  /// open, and what shape the grid was in — and the entry schema above already
  /// refuses anything it does not recognise, so widening it would make an old
  /// build drop a new build's whole layout rather than just the part it cannot
  /// use.
  ///
  /// A third key, `terminal_pane_splits`, is written by older builds and no
  /// longer read: dividers were draggable and their positions were remembered.
  /// Nothing deletes it — a downgrade would want it back, and a few hundred
  /// bytes of dead JSON costs less than a file this build has to migrate.
  static const _presetsKey = 'terminal_pane_presets';

  /// The ceiling on tiles, enforced on the way IN as well as out: a file written
  /// by a future build that allows more must not make this one try to open
  /// terminals it has nowhere to put.
  ///
  /// Nine, because ⌘1–⌘9 already addresses that many and a tenth would have no
  /// key. It is a CEILING, not a target — how many actually fit is decided by
  /// the window, since every terminal has a floor of 40 columns and 12 rows
  /// that both this app and the daemon enforce. On a 1280px window with the
  /// rail open that is about three columns; on a 2560px display, six.
  static const maxPanes = 9;

  final LocalKeyValueStore _storage;
  LocalKeyValueStore get storage => _storage;

  /// Failure is silent and lands on an empty layout, which is exactly the
  /// first-run state. A corrupt state file is a reason to open the app the way
  /// a new user sees it, not a reason to refuse to start.
  Future<List<PaneLayoutEntry>> load() async {
    try {
      final raw = await _storage.read(_key);
      if (raw == null || raw.isEmpty) return const [];
      final decoded = jsonDecode(raw);
      if (decoded is! List) return const [];
      final entries = <PaneLayoutEntry>[];
      for (final item in decoded) {
        final entry = PaneLayoutEntry.fromJson(item);
        // One agent cannot be in two tiles: the daemon keeps a single
        // controller per agent, so a duplicate would take its own twin over the
        // moment both opened. Dropping it here means a hand-edited or
        // downgraded file cannot produce that fight.
        if (entry == null ||
            entries.any(
              (existing) =>
                  existing.machineId == entry.machineId &&
                  existing.agentId == entry.agentId,
            )) {
          continue;
        }
        entries.add(entry);
        if (entries.length == maxPanes) break;
      }
      return entries;
    } catch (_) {
      return const [];
    }
  }

  /// A failed write costs the layout at the next launch, which is a far smaller
  /// wrong than an exception thrown out of a pane close.

  /// Chosen shapes, by tile count. An id this build does not know is dropped —
  /// a shape it cannot draw is worse than the default it can.
  Future<Map<int, PanePreset>> loadPresets() async {
    try {
      final raw = await _storage.read(_presetsKey);
      if (raw == null || raw.isEmpty) return const {};
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return const {};
      final out = <int, PanePreset>{};
      for (final entry in decoded.entries) {
        final count = int.tryParse(entry.key.toString());
        if (count == null || count < 2 || count > maxPanes) continue;
        final preset = PanePreset.byId(entry.value?.toString());
        if (preset == null) continue;
        if (!PanePreset.forCount(count).contains(preset)) continue;
        out[count] = preset;
      }
      return out;
    } catch (_) {
      return const {};
    }
  }

  Future<void> savePresets(Map<int, PanePreset> presets) async {
    try {
      await _storage.write(
        _presetsKey,
        jsonEncode({
          for (final entry in presets.entries) '${entry.key}': entry.value.id,
        }),
      );
    } catch (_) {
      // Kept in memory for this run; see above.
    }
  }

  Future<Map<String, dynamic>?> loadSwarms() async {
    try {
      final value = await _storage.read('swarm_layout_v1');
      if (value == null) return null;
      final decoded = jsonDecode(value);
      if (decoded is! Map<String, dynamic> ||
          decoded['version'] != 1 ||
          decoded['swarms'] is! List) {
        return null;
      }
      return decoded;
    } catch (_) {
      return null;
    }
  }

  Future<void> saveSwarms(
    List<Swarm> swarms,
    String activeId,
    int nextWallpaper,
  ) async {
    try {
      await _storage.write(
        'swarm_layout_v1',
        jsonEncode({
          'version': 1,
          'activeId': activeId,
          'nextWallpaper': nextWallpaper,
          'swarms': swarms.map((s) => s.toJson()).toList(),
        }),
      );
    } catch (_) {
      // Keep the current desk usable when storage is unavailable.
    }
  }

  Future<void> save(List<PaneLayoutEntry> entries) async {
    try {
      final capped = entries.take(maxPanes).map((e) => e.toJson()).toList();
      await _storage.write(_key, jsonEncode(capped));
    } catch (_) {
      // Kept in memory for this run; see above.
    }
  }
}
