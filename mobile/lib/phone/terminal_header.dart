import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

/// The terminal page's own header: a search bar across the row, with the page's
/// controls at its right end.
///
/// ⚠️ **Not [PhoneHeader], and the agent's name is not here.** The phone opens
/// straight into a terminal now, so this row is the only place search can live —
/// and a title beside a field leaves the field too narrow to read a hint in. The
/// name moved to the foot of the page, beside the engine mark, where it is
/// identity rather than chrome. See `terminal_foot_bar.dart`.
///
/// The bar is a button wearing a field's clothes: tapping it does not push
/// anything, it grows in place into the search screen — see
/// `terminal_search.dart`, which draws the same bar at the same geometry so the
/// two frames line up. That is what the measurements below are public for: the
/// expanded bar has to land on the pixels the collapsed one left.
///
/// ⚠️ **It leaves on a scroll, and its controls carry on without it.** The page
/// shrinks this row away as the terminal is scrolled forward, and the search
/// bar, `+` and `⋯` fly out of it to become floating buttons down the right
/// edge — see `terminal_header_floats.dart`. Nothing here knows about that; the
/// row is either laid out or it is not.
class TerminalHeader extends StatelessWidget {
  const TerminalHeader({
    super.key,
    required this.onSearch,
    this.trailing = const [],
    this.barHidden = false,
  });

  final VoidCallback onSearch;

  /// Whether the search overlay is drawing the bar instead of this row.
  ///
  /// ⚠️ **The bar still takes its space — it is only not PAINTED.** The overlay
  /// draws an identical field at these very pixels, and two of them stacked put
  /// one translucent rim over another: the border comes out darker than either
  /// alone, and the fill deepens, for the whole of the open. Keeping the layout
  /// and dropping the paint leaves this row doing what it still has to do —
  /// holding the trailing controls in place while they fade — without a second
  /// field showing through the first.
  final bool barHidden;

  /// The page's controls, right of the bar: `+`, `⋯`, and the reclaim button
  /// when the stream is read-only.
  final List<Widget> trailing;

  /// The bar's height, and with it the header's.
  static const double barHeight = 38;

  /// The row's padding, shared with the expanded bar. See the class note.
  static const double sideInset = 14;
  static const double topInset = 6;
  static const double bottomInset = 8;

  /// Inside the bar: the inset before the magnifier, and the magnifier itself.
  static const double barPadding = 10;
  static const double glyphSize = 16;

  /// The hint's type.
  static const double hintSize = 14;

  /// The gap between the bar and whatever sits right of it.
  ///
  /// ⚠️ Carried by the trailing controls themselves, not laid in this row. The
  /// page swaps those controls for a Cancel as search opens, and a gap sitting
  /// outside that swap would be points neither side accounts for — see
  /// `_TrailingSwap` in `terminal_page.dart`.
  static const double barGap = 6;

  /// What the bar says it will search.
  ///
  /// ⚠️ Names both kinds on purpose. The query spans agents AND machines, and
  /// the two tabs this screen replaced each answered half the question — a bare
  /// "Search" left somebody who remembers "that review thing" unsure whether
  /// this is where to look for it.
  static const String searchHint = 'Search agents and machines';

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        sideInset,
        topInset,
        sideInset,
        bottomInset,
      ),
      child: Row(
        children: [
          Expanded(
            child: Visibility(
              visible: !barHidden,
              // Keeps the box, drops the paint and the hit test. See [barHidden].
              maintainSize: true,
              maintainAnimation: true,
              maintainState: true,
              child: _SearchBar(onTap: onSearch),
            ),
          ),
          // ⚠️ **No gap of its own before these — see [barGap].** The page
          // swaps these controls for a Cancel of a different width, and sizes
          // the slot they share from one measurement. A spacer sitting outside
          // that slot is points the measurement does not know about, so the
          // search overlay's field — which is laid out from the same number —
          // would stop short of where this row's own does, by exactly six.
          ...trailing,
        ],
      ),
    );
  }
}

/// The field-shaped target. Opaque hit test so the whole bar answers, not just
/// the glyph and the words in it.
class _SearchBar extends StatelessWidget {
  const _SearchBar({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Semantics(
      button: true,
      label: TerminalHeader.searchHint,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Container(
          height: TerminalHeader.barHeight,
          padding: const EdgeInsets.symmetric(
            horizontal: TerminalHeader.barPadding,
          ),
          decoration: BoxDecoration(
            color: AppGlass.rowFill,
            borderRadius: BorderRadius.circular(AppCard.radius),
            border: Border.all(color: AppGlass.hair),
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
                child: Text(
                  TerminalHeader.searchHint,
                  maxLines: 1,
                  // ⚠️ Fades rather than ellipses. The hint names two things and
                  // the second one is what somebody is scanning for — a cut at
                  // "Search agents and mac…" reads as a bug, while a soft edge
                  // reads as a line that ran out of room.
                  overflow: TextOverflow.fade,
                  softWrap: false,
                  style: TextStyle(
                    color: AppPalette.textFaint,
                    fontSize: TerminalHeader.hintSize,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
