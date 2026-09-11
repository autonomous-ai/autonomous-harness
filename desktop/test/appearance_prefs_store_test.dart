import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/appearance_prefs_store.dart';

/// An in-memory store that can be told to fail, so the recovery paths are
/// exercised rather than assumed. Same shape as the one in
/// `theme_mode_store_test.dart` and `terminal_font_store_test.dart`.
class _FakeStore implements LocalKeyValueStore {
  final Map<String, String> values = {};
  bool broken = false;

  @override
  Future<String?> read(String key) async {
    if (broken) throw StateError('unreadable');
    return values[key];
  }

  @override
  Future<void> write(String key, String value) async {
    if (broken) throw StateError('unwritable');
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    if (broken) throw StateError('undeletable');
    values.remove(key);
  }
}

void main() {
  group('defaults', () {
    test('a first launch is the system font at the size the app was drawn', () {
      const prefs = AppearancePrefs();
      expect(prefs.uiFamily, isNull);
      expect(prefs.uiSize, 14);
      // The whole point of the default: scale is exactly 1, so every control
      // keeps the geometry the design system specifies.
      expect(prefs.uiSize / grid.AppFont.uiSizeDefault, 1.0);
    });

    test('an empty store loads the defaults', () async {
      final store = AppearancePrefsStore(storage: _FakeStore());
      await store.load();
      expect(store.value, const AppearancePrefs());
    });
  });

  group('the system font is an ABSENT key, never an empty string', () {
    test('choosing it deletes rather than writes', () async {
      final storage = _FakeStore();
      final store = AppearancePrefsStore(storage: storage);

      await store.setUiFamily('Helvetica Neue');
      expect(storage.values['app_ui_font_family'], 'Helvetica Neue');

      await store.setUiFamily(null);
      expect(storage.values.containsKey('app_ui_font_family'), isFalse);
      expect(store.value.uiFamily, isNull);
    });

    test('a blank family reads back as the system font', () async {
      final storage = _FakeStore()..values['app_ui_font_family'] = '   ';
      final store = AppearancePrefsStore(storage: storage);
      await store.load();
      // CoreText resolves '' to no face at all and the text vanishes, so a
      // blank has to mean "system", not "a font named nothing".
      expect(store.value.uiFamily, isNull);
    });
  });

  group('size', () {
    test('is clamped to the range a fixed-height control can hold', () async {
      final store = AppearancePrefsStore(storage: _FakeStore());
      await store.setUiSize(40);
      expect(store.value.uiSize, 19);
      await store.setUiSize(2);
      expect(store.value.uiSize, 11);
    });

    test(
      'a hand-edited NaN falls back to the default, not to the maximum',
      () async {
        // The guard this covers: `double.tryParse('NaN')` succeeds, and
        // `double.nan.clamp(11, 19)` returns 19 — so an isFinite check placed
        // AFTER the clamp would silently pin the app at maximum size.
        final storage = _FakeStore()..values['app_ui_font_size'] = 'NaN';
        final store = AppearancePrefsStore(storage: storage);
        await store.load();
        expect(store.value.uiSize, 14);

        storage.values['app_ui_font_size'] = 'Infinity';
        await store.load();
        expect(store.value.uiSize, 14);
      },
    );

    test('unparseable text falls back to the default', () async {
      final storage = _FakeStore()..values['app_ui_font_size'] = 'big';
      final store = AppearancePrefsStore(storage: storage);
      await store.load();
      expect(store.value.uiSize, 14);
    });

    test('round-trips through storage', () async {
      final storage = _FakeStore();
      final store = AppearancePrefsStore(storage: storage);
      await store.setUiSize(17);

      final reopened = AppearancePrefsStore(storage: storage);
      await reopened.load();
      expect(reopened.value.uiSize, 17);
    });
  });

  group('a broken disk costs the choice, never the app', () {
    test('load lands on the defaults', () async {
      final store = AppearancePrefsStore(storage: _FakeStore()..broken = true);
      await store.load();
      expect(store.value, const AppearancePrefs());
    });

    test('a failed write still moves the value for this run', () async {
      final storage = _FakeStore();
      final store = AppearancePrefsStore(storage: storage);
      storage.broken = true;
      await store.setUiSize(19);
      // The window has to repaint on the click, not on the disk.
      expect(store.value.uiSize, 19);
    });
  });

  group('copyWith can express "back to the system font"', () {
    test('the clear flag unsets, where `?? this.x` cannot', () {
      const chosen = AppearancePrefs(uiFamily: 'Menlo', uiSize: 16);
      expect(chosen.copyWith(clearUiFamily: true).uiFamily, isNull);
      // …and keeps the rest.
      expect(chosen.copyWith(clearUiFamily: true).uiSize, 16);
      // Without the flag, passing null is indistinguishable from passing
      // nothing — which is the bug the flag exists to prevent.
      expect(chosen.copyWith(uiFamily: null).uiFamily, 'Menlo');
    });
  });

  group('the size reaches the theme', () {
    tearDown(grid.AppFont.reset);

    test('a chosen size resizes every control box in the app', () {
      double controlHeight() => grid
          .buildAppTheme(brightness: Brightness.dark)
          .inputDecorationTheme
          .constraints!
          .minHeight;

      expect(controlHeight(), 36);

      grid.AppTheme.fonts.apply(
        uiScale: 19 / grid.AppFont.uiSizeDefault,
        codeSize: grid.AppFont.codeSize,
      );
      // Proof the wiring in `main.dart` has something to act on: `buildAppTheme`
      // bakes `AppControl.heightFieldScaled` into a plain number, so this is
      // what a UI-size change actually moves.
      expect(controlHeight(), closeTo(36 * 19 / 14, 0.001));
    });

    test('apply reports whether anything actually moved', () {
      expect(
        grid.AppFont.apply(uiScale: 1.2, codeSize: grid.AppFont.codeSize),
        isTrue,
      );
      expect(
        grid.AppFont.apply(uiScale: 1.2, codeSize: grid.AppFont.codeSize),
        isFalse,
        reason: 'setting the same value twice must not dirty the tree',
      );
    });
  });
}
