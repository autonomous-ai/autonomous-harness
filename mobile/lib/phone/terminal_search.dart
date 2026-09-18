import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/state/app_state.dart';

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
/// ⚠️ **Nothing here moves, and that took two tries to get right.** The bar
/// first grew into the screen, then merely widened as Cancel opened beside it;
/// both widened the field and then narrowed it again within the one gesture,
/// which is felt as the row snapping about. The field is now laid out once, at
/// one width, for the whole of the open. What changes is the header's trailing
/// end, which cross-fades `+` and `⋯` for Cancel — see `_TrailingSwap` in
/// `terminal_page.dart` — and the results, which fade up underneath.
///
/// The way out is that Cancel. The system back gesture reaches it too — see
/// [TerminalSearchOverlay]'s [PopScope].
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

  /// How much of the header's row its trailing slot is holding — the Cancel the
  /// header swaps in as this opens. The field stops there; see [_Bar].
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
          // ⚠️ **The bar neither fades in nor changes size.** It lands exactly
          // on the header's own, which hides its picture of a field while this
          // real one is up. Nothing about this row moves: the whole transition
          // is the header trading `+` and `⋯` for Cancel beside it — see
          // `_TrailingSwap` in `terminal_page.dart`.
          //
          // ⚠️ Transparent, and that is what lets the swap be seen. This row
          // sits directly over the header, so a fill here would cover the very
          // controls whose exchange IS the animation.
          _Bar(
            controller: _controller,
            focus: _focus,
            onChanged: (value) => setState(() => _query = value),
            trailingExtent: widget.trailingExtent,
          ),
          // ⚠️ Fades on the back half of the animation alone. The header's
          // controls are still trading places over the front half, and rows
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
/// ⚠️ **Exactly [TerminalHeader]'s geometry, and that is the whole job.** The
/// header draws a tappable box that only looks like a field; this draws the
/// [TextField] that replaces it, and the header hides its own for as long as
/// this is up (see `barHidden`). The two must land on the same pixels — same
/// height, same corner radius, same outer padding, same right edge — or the bar
/// jumps on the frame the overlay takes over.
///
/// ⚠️ It takes no animation. Nothing in this row moves: the field is laid out
/// once at one width, and the only thing that changes across the open is which
/// control the header paints at its trailing end. See `_TrailingSwap` in
/// `terminal_page.dart`.
class _Bar extends StatelessWidget {
  const _Bar({
    required this.controller,
    required this.focus,
    required this.onChanged,
    required this.trailingExtent,
  });

  final TextEditingController controller;
  final FocusNode focus;

  final ValueChanged<String> onChanged;

  /// How much of the row the header's trailing slot is holding, so this field
  /// stops exactly where the header's picture of it does.
  ///
  /// ⚠️ Measured by the header rather than guessed at here. The slot's width
  /// depends on which controls the page is showing — `+` comes and goes with the
  /// machine's readiness, reclaim with the stream — and a field that assumed a
  /// fixed number of them would overhang Cancel by the difference.
  final double trailingExtent;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    // ⚠️ **No fill of its own.** The real header is directly underneath and is
    // already opaque — [_TerminalPageState] reveals it before opening this — so
    // this row only has to draw the field. Filling it would cover the `+` and
    // `⋯` whose fade into Cancel is the transition.
    return Padding(
      padding: EdgeInsets.fromLTRB(
        TerminalHeader.sideInset,
        TerminalHeader.topInset,
        // ⚠️ The header's own inset PLUS whatever its trailing slot is holding.
        // The field ends where the header's picture of it ends; the controls
        // beyond are the header's to draw, and this must not reach over them.
        TerminalHeader.sideInset + trailingExtent,
        TerminalHeader.bottomInset,
      ),
      child: Row(
        children: [
          Expanded(
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
                  // Focus is said by the rim of the box the field fills, and by
                  // the magnifier inside it — see the icon below.
                  border: Border.all(
                    color: focus.hasFocus
                        ? AppPalette.accentOnSurface
                        : AppGlass.hair,
                  ),
                ),
                child: Row(
                  children: [
                    // ⚠️ **Inside the builder, not the child passed through
                    // it.** The glyph lifts with focus, so it has to be rebuilt
                    // when focus changes; left in the `child` it would be built
                    // once and keep its resting ink for good.
                    //
                    // It climbs to the same accent the rim and the caret
                    // already use, over the same beat as the rim, so the three
                    // read as one state arriving rather than as three
                    // decorations each doing their own thing.
                    TweenAnimationBuilder<Color?>(
                      duration: AppMotion.hover,
                      curve: AppMotion.curve,
                      // ⚠️ [begin] is the RESTING ink, not left null. A null
                      // begin lerps from null on the first build, which hands
                      // the icon a null colour for that frame — it falls back
                      // to the theme's default ink, and the glyph flashes a
                      // colour it never otherwise wears. The field autofocuses,
                      // so that first build is on screen every time search
                      // opens; starting from rest also makes the very first
                      // climb an animation rather than a jump.
                      tween: ColorTween(
                        begin: AppPalette.textFaint,
                        end: focus.hasFocus
                            ? AppPalette.accentOnSurface
                            : AppPalette.textFaint,
                      ),
                      builder: (context, color, _) => Icon(
                        LucideIcons.search300,
                        size: TerminalHeader.glyphSize,
                        color: color,
                      ),
                    ),
                    const SizedBox(width: 8),
                    // The field and its clear, built once and passed through:
                    // neither depends on focus, and the field in particular must
                    // not be rebuilt from a focus tick — see below.
                    Expanded(child: child!),
                  ],
                ),
              ),
              // ⚠️ **Everything that does NOT change with focus stays here.**
              // The [TextField] especially: it holds the input connection, and
              // rebuilding it on every focus tick is work on the one widget
              // that can least afford it.
              child: Row(
                children: [
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
          ),
          // ⚠️ **Cancel is NOT here — it belongs to the header, and must.** It
          // once opened out of this row from zero width, which widened the field
          // as it grew and then narrowed it again as the word claimed its place:
          // two layout changes in opposite directions inside one tap, felt as
          // the row snapping about. The header now cross-fades its `+` and `⋯`
          // for Cancel inside a slot of one fixed width — see `_TrailingSwap` in
          // `terminal_page.dart` — so the field is laid out once and never
          // moves. This row draws the field and nothing else.
        ],
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
      autocorrect: false,
      enableSuggestions: false,
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

/// The word, not a glyph. This is the one control on the row that leaves, and a
/// second `×` beside the field's own would be two ways out sitting together.
///
/// ⚠️ **Superseded — Cancel is drawn by the header now.** It opened by WIDTH
/// from nothing, taking its points off the field beside it, so the field widened
/// while this grew and narrowed again as it settled. Two layout changes in
/// opposite directions inside one tap read as the row snapping about, which is
/// what replaced it: `_CancelSearchButton` in `terminal_page.dart` draws at a
/// fixed size and arrives on a cross-fade, leaving the field still.
///
/// Kept for the geometry, should a width-opening control ever be wanted here.
// ignore: unused_element
class _CancelButton extends StatelessWidget {
  const _CancelButton({required this.animation, required this.onTap});

  final Animation<double> animation;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Semantics(
      button: true,
      label: 'Cancel search',
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: SizedBox(
          height: TerminalHeader.barHeight,
          // ⚠️ Align + a widthFactor, not an animated `width`. The label must
          // not reflow while the box narrows — a "Cancel" wrapping to "Canc /
          // el" for four frames is what a `SizedBox(width: …)` around text
          // does. This clips it instead, from the left, so the word slides out
          // from behind the field's right edge.
          child: ClipRect(
            child: Align(
              alignment: Alignment.centerRight,
              widthFactor: animation.value,
              child: Padding(
                padding: const EdgeInsets.only(left: 12, right: 2),
                child: Center(
                  child: Opacity(
                    // The word itself catches up late, so it is legible the
                    // moment there is room for it rather than smearing in.
                    opacity: Curves.easeIn.transform(animation.value),
                    child: Text(
                      'Cancel',
                      maxLines: 1,
                      softWrap: false,
                      style: TextStyle(
                        color: AppPalette.accentOnSurface,
                        fontSize: 14,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
