import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/harness_file_store.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/core/snapshot_store.dart';
import 'package:harness/core/startup.dart';
import 'package:harness/shared/theme/appearance_prefs_store.dart';
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/stats/harness_stats.dart';
import 'package:harness/terminal/terminal_font_store.dart';
import 'package:harness/terminal/terminal_theme_store.dart';
import 'package:harness/terminal/terminal_typography.dart';

class _GatedSettings extends Fake implements BatchLocalKeyValueStore {
  final ready = Completer<Map<String, String?>>();
  final requests = <Set<String>>[];

  @override
  Future<Map<String, String?>> readMany(Iterable<String> keys) {
    requests.add(keys.toSet());
    return ready.future;
  }
}

class _GatedSnapshot extends Fake implements SnapshotStore {
  final ready = Completer<String?>();
  var requested = false;

  @override
  Future<String?> read() {
    requested = true;
    return ready.future;
  }
}

void main() {
  late Directory dir;
  late HarnessFileStore storage;
  late FileSnapshotStore statsStorage;
  late TerminalFontStore font;
  late TerminalThemeStore scheme;
  late AppearancePrefsStore appearance;
  late HarnessStats stats;

  setUp(() async {
    dir = await Directory.systemTemp.createTemp('harness-startup-');
    storage = HarnessFileStore(directory: Directory('${dir.path}/settings'));
    statsStorage = FileSnapshotStore('stats', directory: dir);
    font = TerminalFontStore(storage: storage);
    scheme = TerminalThemeStore(storage: storage);
    appearance = AppearancePrefsStore(storage: storage);
    stats = HarnessStats(store: statsStorage);
  });

  tearDown(() async {
    font.dispose();
    scheme.dispose();
    appearance.dispose();
    stats.dispose();
    await dir.delete(recursive: true);
  });

  test('a relaunch restores appearance and counters before returning', () async {
    // Every store, including stats, uses only this test's temporary directory.
    // Write through the real setters so the persisted formats are exercised.
    await font.setFamily(TerminalFontChoice.menlo);
    await font.setSize(17);
    await scheme.set(TerminalThemeChoice.tango);
    await appearance.setUiFamily('Helvetica Neue');
    await appearance.setUiSize(16);
    await appearance.setPalette(HarnessPalette.forest);
    final at = DateTime.utc(2026, 9, 13);
    stats.onAgentSpawned(at: at);
    stats.onTurnStarted('synthetic-agent', at: at);
    stats.onTurnEnded(
      'synthetic-agent',
      at: at.add(const Duration(minutes: 2)),
    );
    await stats.flush();

    final reopened = HarnessFileStore(directory: storage.directory);
    final nextFont = TerminalFontStore(storage: reopened);
    final nextScheme = TerminalThemeStore(storage: reopened);
    final nextAppearance = AppearancePrefsStore(storage: reopened);
    final nextStats = HarnessStats(
      store: FileSnapshotStore('stats', directory: dir),
    );
    addTearDown(nextFont.dispose);
    addTearDown(nextScheme.dispose);
    addTearDown(nextAppearance.dispose);
    addTearDown(nextStats.dispose);
    await loadPersistedSettings(
      terminalFont: nextFont,
      terminalTheme: nextScheme,
      appearance: nextAppearance,
      stats: nextStats,
    );

    expect(nextFont.family, TerminalFontChoice.menlo);
    expect(nextFont.size, 17);
    expect(nextScheme.value, TerminalThemeChoice.tango);
    expect(
      nextAppearance.value,
      const AppearancePrefs(
        uiFamily: 'Helvetica Neue',
        uiSize: 16,
        palette: HarnessPalette.forest,
      ),
    );
    expect(nextStats.summary.agentsSpawned, 1);
    expect(nextStats.summary.turns, 1);
    expect(nextStats.summary.timeWorked, const Duration(minutes: 2));
    expect(nextStats.summary.firstEventAt, at);
  });

  test('a first launch restores defaults from empty isolated stores', () async {
    await loadPersistedSettings(
      terminalFont: font,
      terminalTheme: scheme,
      appearance: appearance,
      stats: stats,
    );
    expect(font.family, TerminalFontChoice.defaultForPlatform);
    expect(font.size, terminalFontSize);
    expect(scheme.value, TerminalThemeChoice.fallback);
    expect(appearance.value, const AppearancePrefs());
    expect(stats.summary.isEmpty, isTrue);
    expect(await storage.stateFile.exists(), isFalse);
    expect(await statsStorage.file.exists(), isFalse);
  });

  test(
    'independent loads overlap but readiness waits for every store',
    () async {
      final fontStorage = _GatedSettings();
      final schemeStorage = _GatedSettings();
      final appearanceStorage = _GatedSettings();
      final counters = _GatedSnapshot();
      final font = TerminalFontStore(storage: fontStorage);
      final scheme = TerminalThemeStore(storage: schemeStorage);
      final appearance = AppearancePrefsStore(storage: appearanceStorage);
      final stats = HarnessStats(store: counters);
      addTearDown(font.dispose);
      addTearDown(scheme.dispose);
      addTearDown(appearance.dispose);
      addTearDown(stats.dispose);
      var finished = false;
      final loading = loadPersistedSettings(
        terminalFont: font,
        terminalTheme: scheme,
        appearance: appearance,
        stats: stats,
      ).then((_) => finished = true);

      expect(fontStorage.requests, [
        {'terminal_font_family', 'terminal_font_size'},
      ]);
      expect(schemeStorage.requests, [
        {'terminal_theme'},
      ]);
      expect(appearanceStorage.requests, [
        // The appearance batch reads the start-background preference too;
        // the POSIX baseline predates that key.
        {
          'app_ui_font_family',
          'app_ui_font_size',
          'app_color_palette',
          'harness_start_background',
        },
      ]);
      expect(counters.requested, isTrue);
      expect(finished, isFalse);
      appearanceStorage.ready.complete({
        'app_ui_font_family': null,
        'app_ui_font_size': '18',
        'app_color_palette': 'midnight',
      });
      await Future<void>.delayed(Duration.zero);
      expect(appearance.value.uiSize, 18);
      expect(appearance.value.palette, HarnessPalette.midnight);
      expect(finished, isFalse);

      fontStorage.ready.complete({
        'terminal_font_family': 'menlo',
        'terminal_font_size': '17',
      });
      await Future<void>.delayed(Duration.zero);
      expect(font.family, TerminalFontChoice.menlo);
      expect(font.size, 17);
      expect(finished, isFalse);

      schemeStorage.ready.complete({'terminal_theme': 'tango'});
      await Future<void>.delayed(Duration.zero);
      expect(scheme.value, TerminalThemeChoice.tango);
      expect(
        finished,
        isFalse,
        reason: 'Counters must precede new agent events',
      );

      counters.ready.complete(jsonEncode({'version': 1, 'agentsSpawned': 12}));
      await loading;
      expect(finished, isTrue);
      stats.onAgentSpawned();
      expect(stats.summary.agentsSpawned, 13);
    },
  );

  test('failed appearance reads still wait for saved counters', () async {
    final broken = _GatedSettings();
    final counters = _GatedSnapshot();
    final font = TerminalFontStore(storage: broken);
    final scheme = TerminalThemeStore(storage: broken);
    final appearance = AppearancePrefsStore(storage: broken);
    final stats = HarnessStats(store: counters);
    addTearDown(font.dispose);
    addTearDown(scheme.dispose);
    addTearDown(appearance.dispose);
    addTearDown(stats.dispose);
    var finished = false;
    final loading = loadPersistedSettings(
      terminalFont: font,
      terminalTheme: scheme,
      appearance: appearance,
      stats: stats,
    ).then((_) => finished = true);
    broken.ready.completeError(const FileSystemException('unreadable'));
    await Future<void>.delayed(Duration.zero);
    expect(finished, isFalse);
    expect(font.family, TerminalFontChoice.defaultForPlatform);
    expect(scheme.value, TerminalThemeChoice.fallback);
    expect(appearance.value, const AppearancePrefs());
    counters.ready.complete(jsonEncode({'version': 1, 'agentsSpawned': 5}));
    await loading;
    expect(stats.summary.agentsSpawned, 5);
  });
}
