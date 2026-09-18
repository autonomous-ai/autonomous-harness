import 'package:flutter/foundation.dart';

/// The keyboard flags a free-text field on a phone needs for the keyboard's
/// input method to compose — Vietnamese Telex, a CJK candidate window.
///
/// On a phone the software keyboard IS the input method, and the two switches a
/// query field instinctively turns off are what take its pre-edit buffer away:
/// iOS maps `autocorrect: false` onto `UITextAutocorrectionTypeNo`, the same
/// machinery its Telex conversion rides on, and Android maps
/// `enableSuggestions: false` onto `TYPE_TEXT_FLAG_NO_SUGGESTIONS`. With either
/// set, `thoiwf tieets` reached search as raw letters instead of `thời tiết`.
///
/// The same policy the terminal's input keeps (see `custom_text_edit.dart` in
/// `third_party/xterm`). ⚠️ The price is on iOS: it has no finer switch, so
/// autocorrection is on there and may rewrite a word at the space bar — the
/// keyboard offers the original back. Android keeps autocorrect off.
abstract final class ComposingKeyboard {
  static bool get autocorrect => defaultTargetPlatform == TargetPlatform.iOS;

  static const enableSuggestions = true;
}
