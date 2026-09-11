import 'package:flutter/foundation.dart';

import '../../core/harness_file_store.dart';
import '../../core/local_key_value_store.dart';
import 'app_theme.dart';

/// How the app's own type is set on this Mac: which face, and how big.
///
/// Deliberately NOT the terminal's type. The terminal renders a grid a remote
/// program draws into, so it keeps its own face and its own size in
/// [TerminalFontStore], reached from Settings ▸ Terminal — and the app's UI
/// scale is fenced out of it at five seams (see the notes in
/// `terminal_panel.dart` and `terminal_composer.dart`, and the regression test
/// in `test/terminal_ui_scale_isolation_test.dart`).
@immutable
class AppearancePrefs {
  const AppearancePrefs({this.uiFamily, this.uiSize = uiSizeDefault});

  /// The face the app's chrome is set in. `null` means the system font, which is
  /// what [AppFont.sans] falls back to.
  ///
  /// Never the empty string. CoreText resolves `''` to nothing at all and the
  /// text simply disappears, so "use the system font" is represented by the
  /// absence of a value at every layer — here, and as a deleted key on disk.
  final String? uiFamily;

  /// The base size everything else is measured against, in logical pixels.
  final double uiSize;

  /// The size the app was drawn at. [AppFont.uiScale] is this over that, so at
  /// 14 the scale is exactly 1 and every control keeps the geometry the design
  /// system specifies.
  static const double uiSizeDefault = AppFont.uiSizeDefault;

  /// ⚠️ Not a matter of taste. A control here is a fixed-height box built for a
  /// 13pt label — [AppControl.height] 32, [AppControl.heightField] 36 — and past
  /// roughly ±35% the label stops fitting the box it sits in.
  static const double uiSizeMin = 11;
  static const double uiSizeMax = 19;

  /// [uiFamily] is nullable and `copyWith` cannot express "unset" with
  /// `?? this.x`, so going back to the system font needs its own flag. Without
  /// one, choosing System silently does nothing.
  AppearancePrefs copyWith({
    String? uiFamily,
    double? uiSize,
    bool clearUiFamily = false,
  }) => AppearancePrefs(
    uiFamily: clearUiFamily ? null : (uiFamily ?? this.uiFamily),
    uiSize: uiSize ?? this.uiSize,
  );

  @override
  bool operator ==(Object other) =>
      other is AppearancePrefs &&
      other.uiFamily == uiFamily &&
      other.uiSize == uiSize;

  @override
  int get hashCode => Object.hash(uiFamily, uiSize);
}

/// The user's appearance choices, remembered across launches.
///
/// Same shape as [TerminalFontStore]: a [ValueNotifier]
/// singleton over [HarnessFileStore], loaded once by `loadPersistedSettings()`
/// before the first frame. Not a Riverpod provider — `MaterialApp` is built
/// above every provider scope in this app, and these values have to resolve
/// before there is a scope at all.
class AppearancePrefsStore extends ValueNotifier<AppearancePrefs> {
  AppearancePrefsStore({LocalKeyValueStore? storage})
    : _storage = storage ?? HarnessFileStore.shared,
      super(const AppearancePrefs());

  static const _familyKey = 'app_ui_font_family';
  static const _sizeKey = 'app_ui_font_size';

  final LocalKeyValueStore _storage;

  /// Read the saved choices, if there are any.
  ///
  /// Tolerant by design: a missing, truncated or hand-edited file lands on the
  /// defaults rather than throwing. Someone who opened `state.json` in an editor
  /// should get a plain-looking app, not an app that refuses to start.
  Future<void> load() async {
    try {
      final family = await _storage.read(_familyKey);
      final size = await _storage.read(_sizeKey);
      value = AppearancePrefs(
        uiFamily: _familyFrom(family),
        uiSize: _sizeFrom(size),
      );
    } catch (_) {
      value = const AppearancePrefs();
    }
  }

  /// Choose a face, or pass `null` for the system font.
  Future<void> setUiFamily(String? family) async {
    final next = _familyFrom(family);
    if (next == value.uiFamily) return;
    value = value.copyWith(uiFamily: next, clearUiFamily: next == null);
    try {
      if (next == null) {
        // Deleted, not written as ''. See [AppearancePrefs.uiFamily].
        await _storage.delete(_familyKey);
      } else {
        await _storage.write(_familyKey, next);
      }
    } catch (_) {
      // Kept for this run; a failed write costs the choice at next launch.
    }
  }

  /// Set the base size. Values outside the range snap to the nearest end rather
  /// than being rejected, so a caller never has to pre-validate.
  Future<void> setUiSize(double size) async {
    final next = _clampSize(size);
    if (next == value.uiSize) return;
    // The notifier moves first and the write is awaited after, so the window
    // repaints on the click rather than on the disk.
    value = value.copyWith(uiSize: next);
    try {
      await _storage.write(_sizeKey, next.toString());
    } catch (_) {
      // See above.
    }
  }

  /// Back to the shipped defaults.
  Future<void> reset() async {
    value = const AppearancePrefs();
    try {
      await _storage.delete(_familyKey);
      await _storage.delete(_sizeKey);
    } catch (_) {
      // See above.
    }
  }

  /// ⚠️ Empty and blank strings become `null`, not a family name. CoreText
  /// resolves `''` to no face at all, and the app renders no text — a failure
  /// with no error attached to it.
  static String? _familyFrom(String? raw) {
    final trimmed = raw?.trim();
    return (trimmed == null || trimmed.isEmpty) ? null : trimmed;
  }

  static double _sizeFrom(String? raw) {
    final parsed = double.tryParse(raw ?? '');
    return parsed == null ? AppearancePrefs.uiSizeDefault : _clampSize(parsed);
  }

  /// ⚠️ The `isFinite` guard has to come BEFORE the clamp, not after.
  /// `double.tryParse('NaN')` succeeds, and `double.nan.clamp(11, 19)` returns
  /// 19 — so a hand-edited file saying `NaN` would silently pin the whole app at
  /// maximum size instead of falling back to the default.
  static double _clampSize(double size) => !size.isFinite
      ? AppearancePrefs.uiSizeDefault
      : size.clamp(AppearancePrefs.uiSizeMin, AppearancePrefs.uiSizeMax);
}

/// The one instance the app reads.
///
/// Here rather than beside `main()` for the same reason `terminalFontStore` is:
/// the widgets that change these values would otherwise have to reach up into
/// the app entrypoint, dragging `runApp` and every screen into anything that
/// renders them — tests included.
final appearancePrefsStore = AppearancePrefsStore();
