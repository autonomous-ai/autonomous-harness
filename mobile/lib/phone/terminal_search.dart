import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'phone_search_field.dart';
import 'phone_search_results.dart';

/// Search, opened in place over a terminal rather than pushed as a page.
///
/// ⚠️ **Not a route.** Pushing [PhoneSearchPage] slid a fresh screen in from the
/// right over a terminal that is still streaming underneath; opening in place
/// fades the search up over it instead, and closing fades it back down onto the
/// same screen, mid-stream.
///
/// It is opened from the floating Search button in the terminal's bottom-right
/// corner (`terminal_action_column.dart`), so it draws its whole self — field
/// and results — over an opaque page, rather than borrowing any of the header's.
///
/// ⚠️ **The search page's own bar, not a second one.** [PhoneSearchField] is one
/// bar with the way out inside it — a chevron at its leading edge — and no
/// Cancel beside it. This screen used to draw its own field with a Cancel, and
/// the two searches drifted apart; drawing the same widget keeps them one. The
/// system back gesture closes it too — see [TerminalSearchOverlay]'s [PopScope].
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
              PhoneSearchField(
                controller: _controller,
                focus: _focus,
                onChanged: (value) => setState(() => _query = value),
                onClear: () {
                  _controller.clear();
                  setState(() => _query = '');
                  // Clearing is a step back into browsing, not out of the
                  // search — the caret stays where the next query will go.
                  _focus.requestFocus();
                },
                onBack: _close,
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
