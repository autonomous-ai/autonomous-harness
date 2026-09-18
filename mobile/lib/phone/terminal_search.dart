import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'composing_keyboard.dart';
import 'phone_search_results.dart';

/// Search, opened in place over a terminal rather than pushed as a page.
///
/// ⚠️ **Not a route.** Pushing [PhoneSearchPage] slid a fresh screen in from the
/// right over a terminal that is still streaming underneath; opening in place
/// fades the search up over it instead, and Cancel fades it back down onto the
/// same screen, mid-stream.
///
/// It is opened from the floating Search button in the terminal's bottom-right
/// corner (`terminal_action_column.dart`), so it draws its whole self — field,
/// Cancel and results — over an opaque page, rather than borrowing any of the
/// header's.
///
/// The way out is Cancel. The system back gesture reaches it too — see
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
  });

  final AppNotifier notifier;

  /// The bar's height.
  static const double barHeight = 38;

  /// What the field says it will search.
  ///
  /// ⚠️ Names both kinds on purpose. The query spans agents AND machines, and a
  /// bare "Search" left somebody who remembers "that review thing" unsure
  /// whether this is where to look for it.
  static const String searchHint = 'Search agents and machines';

  /// The open/close animation the terminal page drives — 0 gone, 1 filling the
  /// screen.
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
      child: FadeTransition(
        opacity: widget.animation,
        child: ColoredBox(
          color: AppPalette.windowBg,
          child: Column(
            children: [
              _Bar(
                controller: _controller,
                focus: _focus,
                onChanged: (value) => setState(() => _query = value),
                onCancel: _close,
              ),
              Divider(height: 1, color: AppGlass.hair),
              // ⚠️ Handed the query and nothing else. Ranking lives inside it,
              // so this screen and [PhoneSearchPage] cannot drift into
              // returning different rows for the same words.
              Expanded(
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
            ],
          ),
        ),
      ),
    );
  }
}

/// The field, with Cancel at its right end.
class _Bar extends StatelessWidget {
  const _Bar({
    required this.controller,
    required this.focus,
    required this.onChanged,
    required this.onCancel,
  });

  final TextEditingController controller;
  final FocusNode focus;

  final ValueChanged<String> onChanged;

  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 6, 14, 8),
      child: Row(
        children: [
          Expanded(
            child: ListenableBuilder(
              listenable: focus,
              builder: (context, child) => AnimatedContainer(
                duration: AppMotion.hover,
                curve: AppMotion.curve,
                height: TerminalSearchOverlay.barHeight,
                padding: const EdgeInsets.symmetric(horizontal: 10),
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
                      builder: (context, color, _) =>
                          Icon(LucideIcons.search300, size: 16, color: color),
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
          _CancelButton(onTap: onCancel),
        ],
      ),
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
        hintText: TerminalSearchOverlay.searchHint,
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

/// The way out: the word, not a glyph. A second `×` beside the field's own
/// clear would be two ways out sitting together.
class _CancelButton extends StatelessWidget {
  const _CancelButton({required this.onTap});

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
          height: TerminalSearchOverlay.barHeight,
          child: Padding(
            padding: const EdgeInsets.only(left: 12, right: 2),
            child: Center(
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
    );
  }
}
