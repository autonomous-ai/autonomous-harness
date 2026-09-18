import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'composing_keyboard.dart';

/// The search page's whole header: one bar, with the way out inside it.
///
/// Drawn here rather than through [PhoneHeader]: the page has no title. The
/// field IS the header, because nothing else on the screen is worth the 32pt
/// line a large title would take from the results.
///
/// The way back is a chevron at the bar's leading edge rather than a "Cancel"
/// beside it. The word cost the field a fifth of the screen's width to say what
/// the edge swipe, Android's back button and the chevron every other page wears
/// already say; the chevron takes the place of the magnifier, which the hint
/// text made redundant.
class PhoneSearchField extends StatelessWidget {
  const PhoneSearchField({
    super.key,
    required this.controller,
    required this.focus,
    required this.onChanged,
    required this.onClear,
    this.onBack,
    this.autofocus = true,
  });

  final TextEditingController controller;
  final FocusNode focus;
  final ValueChanged<String> onChanged;
  final VoidCallback onClear;

  /// The chevron inside the bar. Null leaves it out, for a field that is not the
  /// page's whole header — [AgentsListPage] has a [PhoneHeader] of its own above
  /// it, whose back band is the way out, and a second chevron under the first
  /// would be two ways back stacked one over the other.
  final VoidCallback? onBack;

  /// Whether the field takes the keyboard as it appears.
  ///
  /// True on [PhoneSearchPage], which exists only to be typed into. False where
  /// the field sits over a list worth reading first: raising the keyboard there
  /// would bury half of what the person opened the screen to look at.
  final bool autofocus;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
      // The rim lives on the BOX, never on the TextField inside it — see the
      // decoration below for why the field draws no border of its own. Listening
      // to the node here is what lets the box carry the focus state instead.
      child: ListenableBuilder(
        listenable: focus,
        builder: (context, child) => AnimatedContainer(
          duration: AppMotion.hover,
          curve: AppMotion.curve,
          height: 44,
          padding: const EdgeInsets.only(right: 12),
          decoration: BoxDecoration(
            color: AppGlass.rowFill,
            borderRadius: BorderRadius.circular(AppCard.radius),
            // Focus is said once, by the rim of the box the field fills. The
            // accent is the same one the caret already uses, so the two read as
            // one state rather than as two decorations.
            border: Border.all(
              color: focus.hasFocus
                  ? AppPalette.accentOnSurface
                  : AppGlass.hair,
            ),
          ),
          child: child,
        ),
        child: Row(
          children: [
            if (onBack != null)
              _BackButton(onTap: onBack!)
            else
              // The chevron's place, so the text starts on the same vertical
              // whether or not the bar carries one.
              const SizedBox(width: 14),
            Expanded(
              child: _QueryInput(
                controller: controller,
                focus: focus,
                onChanged: onChanged,
                autofocus: autofocus,
              ),
            ),
            _ClearButton(controller: controller, onTap: onClear),
          ],
        ),
      ),
    );
  }
}

/// The bar's full height and a thumb's width, not the glyph's: the chevron sits
/// against the bar's rounded edge, where a miss is the easiest to make.
class _BackButton extends StatelessWidget {
  const _BackButton({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Semantics(
      button: true,
      label: 'Back',
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: SizedBox(
          width: 40,
          height: 44,
          child: Icon(
            LucideIcons.chevronLeft300,
            size: 22,
            color: AppPalette.textPrimary,
          ),
        ),
      ),
    );
  }
}

class _QueryInput extends StatelessWidget {
  const _QueryInput({
    required this.controller,
    required this.focus,
    required this.onChanged,
    required this.autofocus,
  });

  final TextEditingController controller;
  final FocusNode focus;
  final ValueChanged<String> onChanged;
  final bool autofocus;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return TextField(
      controller: controller,
      focusNode: focus,
      autofocus: autofocus,
      onChanged: onChanged,
      // The list is already filtered by the time a key is released; there is
      // nothing left for the return key to submit, so it stays a plain "done"
      // that drops the keyboard and leaves the results up.
      textInputAction: TextInputAction.search,
      onSubmitted: (_) => focus.unfocus(),
      // Composing stays on — or Telex types `thoi tiet` for `thời tiết`. See
      // [ComposingKeyboard]; with autocorrect on, iOS would also start curling
      // quotes and joining dashes, which a query means literally.
      autocorrect: ComposingKeyboard.autocorrect,
      enableSuggestions: ComposingKeyboard.enableSuggestions,
      smartDashesType: SmartDashesType.disabled,
      smartQuotesType: SmartQuotesType.disabled,
      // Agent names are ids as often as sentences — `Dijkstra-visualization.html`
      // — and a capital forced onto the first letter of one is a wrong query.
      textCapitalization: TextCapitalization.none,
      // With the decoration's padding zeroed below, the field is exactly one line
      // tall inside a 44pt box; this is what centres that line on the chevron
      // beside it instead of letting it sit on the box's top edge.
      textAlignVertical: TextAlignVertical.center,
      style: TextStyle(color: AppPalette.textPrimary, fontSize: 16),
      cursorColor: AppPalette.accentOnSurface,
      decoration: InputDecoration(
        isDense: true,
        // ⚠️ **Every** border state, not just `border`.
        //
        // `border` alone is the wrong half of the fix: it is the fallback, and
        // the app's `inputDecorationTheme` fills the named states in —
        // `focusedBorder` is a 1.5px accent outline at [AppControl.radius] (8).
        // This box is [AppCard.radius] (12), so focusing drew a second, tighter
        // blue rectangle INSIDE the rim. Naming each state is what keeps the
        // theme from reaching past `border`.
        border: InputBorder.none,
        enabledBorder: InputBorder.none,
        focusedBorder: InputBorder.none,
        errorBorder: InputBorder.none,
        focusedErrorBorder: InputBorder.none,
        disabledBorder: InputBorder.none,
        // The theme also fills these, and both would draw on top of the box: a
        // `surfaceContainerHighest` fill over the rim's own, and Material's
        // phone-sized padding over the 44pt height set above.
        filled: false,
        contentPadding: EdgeInsets.zero,
        constraints: const BoxConstraints(),
        hintText: 'Search agents',
        hintStyle: TextStyle(color: AppPalette.textFaint, fontSize: 16),
      ),
    );
  }
}

/// Only once there is something to clear: a button that does nothing on an
/// empty field is a button people learn to skip.
class _ClearButton extends StatelessWidget {
  const _ClearButton({required this.controller, required this.onTap});

  final TextEditingController controller;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return ValueListenableBuilder(
      valueListenable: controller,
      builder: (context, value, _) => value.text.isEmpty
          ? const SizedBox.shrink()
          : Semantics(
              button: true,
              label: 'Clear',
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: onTap,
                child: Padding(
                  // Padding, not size: the glyph stays small while the target
                  // reaches a thumb.
                  padding: const EdgeInsets.only(left: 8),
                  child: Icon(
                    LucideIcons.circleX300,
                    size: 18,
                    color: AppPalette.textFaint,
                  ),
                ),
              ),
            ),
    );
  }
}
