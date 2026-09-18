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
/// while an identical one arrived from off-screen. Growing out of the bar keeps
/// the thing that was tapped on screen and expands it, which is what the gesture
/// says will happen.
///
/// The way out is Cancel beside the bar, which collapses it the way it came. The
/// system back gesture reaches it too — see [TerminalSearchOverlay]'s
/// [PopScope].
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
  });

  final AppNotifier notifier;

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
      child: Column(
        children: [
          // ⚠️ **The bar is NOT faded in over the header's own.** The two
          // are the same shape in the same place, so cross-fading them
          // looked like nothing happening at all — which is exactly what
          // this screen was reported as doing. It is opaque from frame one
          // and animates its WIDTH instead: Cancel opens out of the right
          // edge while `+` and `⋯` collapse behind it, and the field takes
          // the space. That is the move the tap promises.
          _Bar(
            controller: _controller,
            focus: _focus,
            animation: widget.animation,
            onChanged: (value) => setState(() => _query = value),
            onCancel: _close,
          ),
          // ⚠️ Fades AND rises, on the second half of the animation alone.
          // Rows arriving while the bar is still opening read as two things
          // at once; waiting until the bar is nearly home makes it one move
          // — the bar opens, the list comes up into it.
          Expanded(
            child: _Rise(
              animation: widget.animation,
              child: ColoredBox(
                color: AppPalette.windowBg,
                child: PhoneSearchResults(
                  notifier: widget.notifier,
                  query: _query,
                  // ⚠️ Nothing pops this search — opening an agent swaps
                  // the terminal underneath it instead — so tapping a row
                  // has to close it by hand. Without this the keyboard
                  // would still be up over an agent nobody asked to type
                  // into.
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

/// The field and the way out, on the row the collapsed bar came from.
///
/// ⚠️ **Exactly [TerminalHeader]'s geometry, and that is what sells the
/// expansion.** The two rows are drawn by different widgets but must land on the
/// same pixels: same height, same corner radius, same outer padding. Anything
/// off by a point makes the bar jump on the frame the overlay takes over.
class _Bar extends StatelessWidget {
  const _Bar({
    required this.controller,
    required this.focus,
    required this.animation,
    required this.onChanged,
    required this.onCancel,
  });

  final TextEditingController controller;
  final FocusNode focus;

  /// 0 collapsed into the header's bar, 1 open. Drives Cancel's width, which is
  /// what makes the field grow: the two share the row.
  final Animation<double> animation;

  final ValueChanged<String> onChanged;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return ColoredBox(
      color: AppPalette.windowBg,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          TerminalHeader.sideInset,
          TerminalHeader.topInset,
          TerminalHeader.sideInset,
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
                    // Focus is said once, by the rim of the box the field fills.
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
                    Icon(
                      LucideIcons.search300,
                      size: TerminalHeader.glyphSize,
                      color: AppPalette.textFaint,
                    ),
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
            ),
            // ⚠️ **Opens from zero width, and that IS the animation.** `+` and
            // `⋯` are gone while searching — they act on the agent underneath,
            // which is not what is on screen — so Cancel takes their column, and
            // the field widens into whatever Cancel has not claimed yet. Fading
            // one bar over another identical one showed nothing; a row whose
            // proportions move shows the tap landing.
            //
            // ⚠️ Rebuilt on every tick by this builder. The button reads
            // `animation.value` directly, and a stateless widget given an
            // Animation does not listen to it — the row would have snapped to its
            // open width on the first frame and shown nothing moving.
            AnimatedBuilder(
              animation: animation,
              builder: (context, _) =>
                  _CancelButton(animation: animation, onTap: onCancel),
            ),
          ],
        ),
      ),
    );
  }
}

/// The results, rising into place as the bar finishes opening.
///
/// A translation rather than a slide transition: [SlideTransition] moves by a
/// fraction of the child's own size, and this child is most of the screen — a
/// tenth of it is half a phone. A fixed number of points is what reads as the
/// list settling.
class _Rise extends StatelessWidget {
  const _Rise({required this.animation, required this.child});

  final Animation<double> animation;
  final Widget child;

  /// How far below its place the list starts. Far enough to be a move, near
  /// enough that nothing is ever seen sliding past the bar.
  static const double _drop = 18;

  @override
  Widget build(BuildContext context) {
    final curve = CurvedAnimation(
      parent: animation,
      curve: const Interval(0.35, 1, curve: Curves.easeOutCubic),
    );
    return AnimatedBuilder(
      animation: curve,
      builder: (context, child) => Opacity(
        opacity: curve.value,
        child: Transform.translate(
          offset: Offset(0, _drop * (1 - curve.value)),
          child: child,
        ),
      ),
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
/// ⚠️ **It opens by WIDTH, from nothing, and the field's growth is the other
/// side of that.** The two share the row, so every point Cancel takes is a point
/// the field gives up — which is what makes the bar look like it is expanding
/// out of the header rather than being replaced by a copy of itself.
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
