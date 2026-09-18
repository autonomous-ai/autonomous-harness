import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'composing_keyboard.dart';
import 'phone_search_results.dart';
import 'terminal_header.dart';

/// Search, opened in place over a terminal rather than pushed as a page.
///
/// ⚠️ **Not a route, and that is the point of the whole file.** The bar sits in
/// the terminal's header, and pushing [PhoneSearchPage] slid a fresh screen in
/// from the right — the bar the finger had just touched went out of the frame
/// while an identical one arrived from off-screen. Opening in place leaves the
/// thing that was tapped exactly where it was.
///
/// ⚠️ **One bar, no Cancel — the search page's shape.** The way out is the
/// chevron at the field's leading edge, which the magnifier turns into as the
/// search opens, exactly where [PhoneSearchField] keeps its own. A Cancel beside
/// the bar was a second way out sitting next to the field's clear, and it cost
/// the field the width of a word.
///
/// ⚠️ **The field moves once, in one direction.** It starts on the header's own
/// bar, then widens over `+` and `⋯` as they fade (see `_TrailingFade` in
/// `terminal_page.dart`). An earlier Cancel widened the field and then narrowed
/// it again within the one gesture, which is felt as the row snapping about;
/// with nothing claiming the space back, that cannot happen. The system back
/// gesture closes it too — see [TerminalSearchOverlay]'s [PopScope].
///
/// ⚠️ **It must stay mounted only while searching.** The [TextField] inside
/// autofocuses, so a copy left built behind the terminal would keep the keyboard
/// and eat every keystroke the terminal is owed.
class TerminalSearchOverlay extends StatefulWidget {
  const TerminalSearchOverlay({
    super.key,
    required this.notifier,
    required this.animation,
    required this.onClose,
    required this.trailingExtent,
  });

  final AppNotifier notifier;

  /// How much of the header's row its trailing slot is holding: where the
  /// field starts from before it widens over that slot. See [_Bar].
  final double trailingExtent;

  /// The open/close animation the terminal page drives — 0 collapsed into the
  /// header bar, 1 filling the screen.
  ///
  /// Run by the page rather than here, because the page is what decides when
  /// this widget stops existing: the collapse has to finish before the overlay
  /// comes down, and a controller owned by a widget being unmounted cannot
  /// outlive itself to say so.
  final Animation<double> animation;

  final VoidCallback onClose;

  @override
  State<TerminalSearchOverlay> createState() => _TerminalSearchOverlayState();
}

class _TerminalSearchOverlayState extends State<TerminalSearchOverlay> {
  final _controller = TextEditingController();
  final _focus = FocusNode(debugLabel: 'Terminal search');
  String _query = '';

  @override
  void dispose() {
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  /// ⚠️ Drops the keyboard BEFORE handing back, so the terminal underneath does
  /// not inherit an inset that belongs to this field. The page's own keyboard
  /// tracking reads the inset, not the focus, and would otherwise come back
  /// believing the terminal had raised it.
  void _close() {
    _focus.unfocus();
    widget.onClose();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return PopScope(
      // Back closes the search instead of leaving the agent — the terminal is
      // still underneath, and this is what is covering it.
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _close();
      },
      // ⚠️ No [ListenableBuilder] around this any more. [PhoneSearchResults]
      // watches the notifier itself — and its recall store with it — so a
      // second listener here would rebuild the field on every agent-list tick
      // for nothing.
      child: Column(
        children: [
          // ⚠️ **The bar never fades in.** It lands exactly on the header's
          // own, which hides its picture of a field while this real one is up,
          // and then only widens — see [_Bar].
          //
          // ⚠️ Transparent, and that is what lets the fade be seen. This row
          // sits directly over the header, so a fill here would cover `+` and
          // `⋯` stepping aside for the field.
          _Bar(
            controller: _controller,
            focus: _focus,
            animation: widget.animation,
            onChanged: (value) => setState(() => _query = value),
            onBack: _close,
            trailingExtent: widget.trailingExtent,
          ),
          // ⚠️ Fades on the back half of the animation alone. The header's
          // controls are still stepping aside over the front half, and rows
          // arriving under them is two things happening at once.
          Expanded(
            child: _FadeIn(
              animation: widget.animation,
              child: ColoredBox(
                color: AppPalette.windowBg,
                // ⚠️ Handed the query and nothing else. Ranking lives inside
                // it now, so this screen and [PhoneSearchPage] cannot drift
                // into returning different rows for the same words.
                child: PhoneSearchResults(
                  notifier: widget.notifier,
                  query: _query,
                  // ⚠️ Nothing pops this search — opening an agent swaps the
                  // terminal underneath it instead — so tapping a row has to
                  // close it by hand. Without this the keyboard would still be
                  // up over an agent nobody asked to type into.
                  onOpen: _close,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The real field, drawn over the header's picture of one.
///
/// ⚠️ **It starts on exactly [TerminalHeader]'s geometry.** The header draws a
/// tappable box that only looks like a field; this draws the [TextField] that
/// replaces it, and the header hides its own for as long as this is up (see
/// `barHidden`). On the first frame the two must land on the same pixels — same
/// height, same corner radius, same outer padding, same right edge — or the bar
/// jumps as the overlay takes over.
///
/// From there it only widens: its right edge travels from the header's
/// trailing slot to the header's own inset while `+` and `⋯` fade out of the
/// way, so the open search is one bar across the row, as on the search page.
class _Bar extends StatelessWidget {
  const _Bar({
    required this.controller,
    required this.focus,
    required this.animation,
    required this.onChanged,
    required this.onBack,
    required this.trailingExtent,
  });

  final TextEditingController controller;
  final FocusNode focus;

  /// 0 sitting on the header's bar, 1 across the whole row.
  final Animation<double> animation;

  final ValueChanged<String> onChanged;

  /// Closes the search — the chevron at the field's leading edge.
  final VoidCallback onBack;

  /// How much of the row the header's trailing slot is holding, so this field
  /// starts exactly where the header's picture of it ends.
  ///
  /// ⚠️ Measured by the header rather than guessed at here. The slot's width
  /// depends on which controls the page is showing — `+` comes and goes with the
  /// machine's readiness, reclaim with the stream — and a field that assumed a
  /// fixed number of them would start short of, or over, the header's own.
  final double trailingExtent;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    // ⚠️ **No fill of its own.** The real header is directly underneath and is
    // already opaque — [_TerminalPageState] reveals it before opening this — so
    // this row only has to draw the field. Filling it would cover `+` and `⋯`
    // fading out of the field's way.
    return AnimatedBuilder(
      animation: animation,
      builder: (context, field) => Padding(
        padding: EdgeInsets.fromLTRB(
          TerminalHeader.sideInset,
          TerminalHeader.topInset,
          // The header's own inset, plus whatever of its trailing slot the
          // field has not yet taken over.
          TerminalHeader.sideInset + trailingExtent * (1 - animation.value),
          TerminalHeader.bottomInset,
        ),
        child: field,
      ),
      // ⚠️ **The field rides through as the builder's child.** Only the inset
      // above changes per frame; the [TextField] holds the input connection and
      // is not rebuilt for it.
      child: ListenableBuilder(
        listenable: focus,
        builder: (context, child) => AnimatedContainer(
          duration: AppMotion.hover,
          curve: AppMotion.curve,
          height: TerminalHeader.barHeight,
          padding: const EdgeInsets.symmetric(
            horizontal: TerminalHeader.barPadding,
          ),
          decoration: BoxDecoration(
            color: AppGlass.rowFill,
            borderRadius: BorderRadius.circular(AppCard.radius),
            // Focus is said once, by the rim of the box the field fills. The
            // accent is the same one the caret already uses.
            border: Border.all(
              color: focus.hasFocus
                  ? AppPalette.accentOnSurface
                  : AppGlass.hair,
            ),
          ),
          child: child,
        ),
        // ⚠️ **Everything that does NOT change with focus stays here.** The
        // [TextField] especially: it holds the input connection, and rebuilding
        // it on every focus tick is work on the one widget that can least
        // afford it.
        child: Row(
          children: [
            _BackGlyph(animation: animation, onTap: onBack),
            const SizedBox(width: 8),
            Expanded(
              child: _Input(
                controller: controller,
                focus: focus,
                onChanged: onChanged,
              ),
            ),
            _ClearButton(
              controller: controller,
              onTap: () {
                controller.clear();
                onChanged('');
                // Clearing is a step back into browsing, not out of the
                // search — the caret stays where the next query will go.
                focus.requestFocus();
              },
            ),
          ],
        ),
      ),
    );
  }
}

/// The field's leading glyph: the header's magnifier, turning into the chevron
/// that closes the search as it opens.
///
/// ⚠️ **The magnifier's own footprint, and a thumb's reach.** Both glyphs are
/// drawn in [TerminalHeader.glyphSize] on the spot the header's magnifier holds,
/// so the hint beside them does not shift as one becomes the other;
/// [TouchTarget] takes the tap to 44pt without moving either.
class _BackGlyph extends StatelessWidget {
  const _BackGlyph({required this.animation, required this.onTap});

  final Animation<double> animation;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Semantics(
      button: true,
      label: 'Close search',
      child: TouchTarget(
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: onTap,
          child: SizedBox.square(
            dimension: TerminalHeader.glyphSize,
            child: AnimatedBuilder(
              animation: animation,
              builder: (context, _) => Stack(
                alignment: Alignment.center,
                children: [
                  Opacity(
                    opacity: 1 - animation.value,
                    child: Icon(
                      LucideIcons.search300,
                      size: TerminalHeader.glyphSize,
                      color: AppPalette.textFaint,
                    ),
                  ),
                  Opacity(
                    opacity: animation.value,
                    child: Icon(
                      LucideIcons.chevronLeft,
                      size: TerminalHeader.glyphSize,
                      color: AppPalette.textPrimary,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The results, fading in under the bar.
///
/// ⚠️ **A fade alone, and it was once a rise too.** It used to
/// translate 18pt as it faded, which belonged to a screen whose bar was also
/// growing: one move explaining another. Now that the bar holds still, a list
/// sliding under it was the only thing on screen that moved, and it read as the
/// results being nudged rather than as the terminal being replaced.
///
/// ⚠️ On the back half of the animation only. The header's controls are still
/// trading places over the first half, and rows arriving under them makes two
/// things happen at once; waiting lets the eye finish one before the next.
class _FadeIn extends StatelessWidget {
  const _FadeIn({required this.animation, required this.child});

  final Animation<double> animation;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final curve = CurvedAnimation(
      parent: animation,
      curve: const Interval(0.35, 1, curve: Curves.easeInOut),
    );
    return AnimatedBuilder(
      animation: curve,
      builder: (context, child) => Opacity(opacity: curve.value, child: child),
      child: child,
    );
  }
}

class _Input extends StatelessWidget {
  const _Input({
    required this.controller,
    required this.focus,
    required this.onChanged,
  });

  final TextEditingController controller;
  final FocusNode focus;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return TextField(
      controller: controller,
      focusNode: focus,
      // The whole point of expanding rather than pushing: the keyboard comes up
      // on the bar that was tapped, without a screen sliding across first.
      autofocus: true,
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
      textAlignVertical: TextAlignVertical.center,
      style: TextStyle(color: AppPalette.textPrimary, fontSize: 14),
      cursorColor: AppPalette.accentOnSurface,
      decoration: InputDecoration(
        isDense: true,
        // ⚠️ **Every** border state, not just `border`. The app's
        // `inputDecorationTheme` fills the named states in, and its
        // `focusedBorder` is an accent outline at a tighter radius than this box
        // — which drew a second rectangle INSIDE the rim. Naming each state is
        // what keeps the theme from reaching past `border`.
        border: InputBorder.none,
        enabledBorder: InputBorder.none,
        focusedBorder: InputBorder.none,
        errorBorder: InputBorder.none,
        focusedErrorBorder: InputBorder.none,
        disabledBorder: InputBorder.none,
        // The theme also fills these, and both would draw over the box: a fill
        // over the rim's own, and Material's phone-sized padding over the height
        // set above.
        filled: false,
        contentPadding: EdgeInsets.zero,
        constraints: const BoxConstraints(),
        hintText: TerminalHeader.searchHint,
        hintStyle: TextStyle(color: AppPalette.textFaint, fontSize: 14),
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
              // The padding alone left a 24x16 target; [TouchTarget] takes it
              // to a thumb's without moving the field beside it.
              child: TouchTarget(
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: onTap,
                  child: Padding(
                    padding: const EdgeInsets.only(left: 8),
                    child: Icon(
                      LucideIcons.circleX300,
                      size: 16,
                      color: AppPalette.textFaint,
                    ),
                  ),
                ),
              ),
            ),
    );
  }
}
