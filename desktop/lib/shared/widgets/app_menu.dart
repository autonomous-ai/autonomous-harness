import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../theme/app_theme.dart';

/// The measurements one [AppMenuItem] is built from.
///
/// TWO sizes exist in this app, deliberately, and the distinction is worth
/// stating because two sizes is otherwise exactly the drift this file was
/// written to end:
///
///   [compact] — a CONTEXT menu. A short list of actions on the thing you just
///   right-clicked or pressed ⋯ on: the machine and agent menus, the account
///   menu. macOS sets these tight, and they are read in a glance.
///
///   [roomy] — a PICKER's list. The menu IS the control: it is the only place
///   the choices are ever shown, it is read down rather than glanced at, and it
///   is often long enough to scroll. macOS gives a popup button's list more room
///   than a context menu for the same reason.
///
/// A third size would be drift. Reach for one of these two.
@immutable
class AppMenuRowMetrics {
  const AppMenuRowMetrics({
    required this.fontSize,
    required this.noteSize,
    required this.iconSize,
    required this.padding,
    required this.extent,
  });

  final double fontSize;
  final double noteSize;
  final double iconSize;
  final EdgeInsets padding;

  /// The height a row of this size actually lays out at.
  ///
  /// ⚠️ MEASURED, not derived, and the difference has already cost a bug. Adding
  /// the paddings up for [compact] gives 33.6; a laid-out row measures 34.0,
  /// because the line box rounds up to the font's own metrics rather than taking
  /// `fontSize × height` literally. Over seven rows that 0.4 became 2.8 — enough
  /// to overflow a panel sized from the arithmetic and hang a scrollbar on it.
  ///
  /// `app_select_field_test.dart` measures a real row against this to 0.1, so a
  /// padding that moves without this moving fails a test rather than quietly
  /// mis-sizing every panel.
  final double extent;

  /// What a row with a [AppMenuItem.detail] line lays out at instead.
  ///
  /// [extent] plus the second line's own box — [noteSize] × 1.25, rounded up
  /// the same way a line box rounds, plus the 2px that separates the two lines.
  /// Stated rather than derived at the call site for the same reason [extent]
  /// is: a panel sized by arithmetic that disagrees with the layout by half a
  /// pixel per row wears a scrollbar it does not need.
  double get detailExtent => extent + noteSize * 1.25 + 2;

  /// A context menu's row: the macOS control scale.
  static const compact = AppMenuRowMetrics(
    fontSize: 13,
    noteSize: 11.5,
    iconSize: 16,
    padding: EdgeInsets.symmetric(horizontal: 9, vertical: 8),
    extent: 34,
  );

  /// A picker's row — one step up on every axis at once, which is the only way
  /// to change a platform convention without breaking the proportions inside it.
  static const roomy = AppMenuRowMetrics(
    fontSize: 14,
    noteSize: 12.5,
    iconSize: 18,
    padding: EdgeInsets.symmetric(horizontal: 11, vertical: 10),
    extent: 40,
  );
}

/// The height one [AppMenuItem] occupies.
///
/// Stated so a caller that has to SIZE a panel — see [AppSelectField] — can do
/// the arithmetic up front instead of discovering at runtime that its list
/// overflows by a few pixels and wears a scrollbar for no reason.
///
/// ⚠️ MEASURED, not derived, and the difference matters. Adding the paddings up
///
///   outer 1 × 2 = 2  ·  inner 8 × 2 = 16  ·  line 13 × 1.2 = 15.6   → 33.6
///
/// gives 33.6, which is WRONG: a laid-out row measures 34.0, because the line
/// box rounds up to the font's own metrics rather than taking `fontSize ×
/// height` literally. Over seven rows that 0.4 becomes 2.8 — the width of the
/// mistake that put a scrollbar on the engine picker in the first place.
///
/// `app_select_field_test.dart` measures a real row against this to 0.1, so if
/// a padding moves and this does not, a test says so.
const double kMenuRowExtent = 34.0;
// (kept as the compact row's extent; see AppMenuRowMetrics.compact.extent)

/// One row in an [AppMenu] panel.
///
/// The panel itself is no longer built here: it lives on [AppMenu] in
/// `app_theme.dart`, and `menuTheme` hands it to every `MenuAnchor` in the app,
/// so a menu that passes no style gets the same surface as one that does. The
/// hand-written `appMenuStyle()` this file used to export was the second of four
/// disagreeing recipes — see that class.
///
/// Hand-rolled rather than a [MenuItemButton] because the app has no
/// `menuButtonTheme`, so a bare one takes Material's M3 defaults and lands
/// wrong on four counts at once: radius 0, 14pt text, a grey 8% hover, and a
/// ripple every other menu here has turned off.
///
/// Stateful for its own hover: the glyph has to climb to [AppPalette.textPrimary]
/// under the pointer. An icon that stays dim while the cursor sits on it reads
/// as decoration, and nothing above this row tracks hover per-row to do it.
class AppMenuItem extends StatefulWidget {
  const AppMenuItem({
    super.key,
    this.icon,
    required this.label,
    required this.onPressed,
    this.danger = false,
    this.selected = false,
    this.note,
    this.detail,
    this.leading,
    this.trailing,
    this.metrics = AppMenuRowMetrics.compact,
  });

  /// The leading glyph. Null for a row in a list that PICKS one of several — the
  /// slot is still reserved, so labels line up whether a row is ticked or not.
  final IconData? icon;
  final String label;

  /// A quieter qualifier after the label — a face name beside "System". Set
  /// apart by ink rather than by a separator character, so it reads as an aside
  /// instead of as part of the name.
  final String? note;

  /// A mark at the row's far end, after [note] — a state the row has rather
  /// than a word about it.
  ///
  /// For a fact that repeats down a list, where the same short phrase on every
  /// other row turns the column into noise the eye has to re-read. A glyph is
  /// scanned once. Give it a [Tooltip]: a mark carries no meaning to a reader
  /// meeting it for the first time, and there is nowhere else in a menu row to
  /// put the sentence.
  final Widget? trailing;

  /// A quiet SECOND LINE under the label, for a row whose label alone does not
  /// say what picking it does — "Most tokens read in the last 24h" under
  /// "Input tokens", "That, plus…" under a role.
  ///
  /// Distinct from [note], which sits *beside* the label and qualifies the same
  /// noun ("System — SF Pro"). A sentence cannot go there: a menu is as wide as
  /// its button, and the qualifier would arrive clipped to its first three
  /// words. So this row grows a line instead of the panel growing a column.
  ///
  /// It makes the row taller, which is why a caller that has to SIZE a panel
  /// asks [AppMenuRowMetrics.detailExtent] rather than [AppMenuRowMetrics.extent].
  final String? detail;

  /// A mark that belongs to the ROW's subject rather than to its action — an
  /// engine's logo, say. It gets a slot of its own AFTER the tick's, so the tick
  /// still has somewhere to go and a picked row's label does not shift sideways
  /// from an unpicked one's.
  final Widget? leading;

  /// Which of the two row sizes this is. Defaults to a context menu's; a picker
  /// passes [AppMenuRowMetrics.roomy].
  final AppMenuRowMetrics metrics;

  /// This row is the current choice.
  ///
  /// Marked THREE ways, never by one: an accent wash, a heavier label, and a
  /// tick in the leading slot. Colour alone fails anyone who cannot separate
  /// these two greys, and a tick alone is easy to miss in a long list.
  final bool selected;

  final VoidCallback onPressed;

  /// Tints the row red and gives it a red hover wash — for the row that
  /// destroys something.
  final bool danger;

  @override
  State<AppMenuItem> createState() => _AppMenuItemState();
}

class _AppMenuItemState extends State<AppMenuItem> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    // Lives in the MenuAnchor's overlay, so it watches for itself.
    AppTheme.watch(context);
    final error = Theme.of(context).colorScheme.error;
    // A danger row is already red at rest, so it deepens rather than climbs.
    final tint = widget.danger
        ? error
        : (_hovered || widget.selected
              ? AppPalette.textPrimary
              : AppPalette.textSecondary);
    // The tick takes the leading slot when this row is the choice; otherwise the
    // row's own glyph does, and a row with neither keeps the slot EMPTY.
    //
    // ⚠️ Empty means an empty box, not `Icons.check_box_outline_blank`. That
    // glyph draws a real outlined square — which turns a pick-one menu into what
    // reads as a checkbox list, and puts a border somewhere §1 does not allow
    // one. It shipped that way once; this comment is why it will not again.
    final glyph = widget.selected ? LucideIcons.check300 : widget.icon;

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(8),
        child: InkWell(
          onTap: widget.onPressed,
          onHover: (hovered) => setState(() => _hovered = hovered),
          borderRadius: BorderRadius.circular(8),
          hoverColor: widget.danger
              ? error.withValues(alpha: 0.09)
              : AppSurface.hoverFill,
          splashFactory: NoSplash.splashFactory,
          child: Ink(
            decoration: BoxDecoration(
              color: widget.selected
                  ? AppSurface.accentWash
                  : Colors.transparent,
              borderRadius: BorderRadius.circular(8),
            ),
            padding: widget.metrics.padding,
            child: Row(
              children: [
                // Fixed slot: these glyphs differ in width, and without it every
                // label would start at a slightly different column — and a
                // ticked row would sit a few pixels off an unticked one.
                SizedBox(
                  width: widget.metrics.iconSize,
                  child: glyph == null
                      ? null
                      : Icon(glyph, size: widget.metrics.iconSize, color: tint),
                ),
                const SizedBox(width: 9),
                if (widget.leading != null) ...[
                  SizedBox(
                    width: widget.metrics.iconSize,
                    child: Center(child: widget.leading),
                  ),
                  const SizedBox(width: 9),
                ],
                Flexible(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        widget.label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: widget.danger ? error : AppPalette.textPrimary,
                          fontFamily: AppFont.sans,
                          fontFamilyFallback: AppFont.sansFallback,
                          fontSize: widget.metrics.fontSize,
                          height: 1.2,
                          fontWeight: widget.selected
                              ? AppFont.semibold
                              : AppFont.medium,
                        ),
                      ),
                      if (widget.detail case final detail?) ...[
                        const SizedBox(height: 2),
                        Text(
                          detail,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: AppPalette.textSecondary,
                            fontFamily: AppFont.sans,
                            fontFamilyFallback: AppFont.sansFallback,
                            fontSize: widget.metrics.noteSize,
                            height: 1.25,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
                if (widget.note != null) ...[
                  const SizedBox(width: 8),
                  Flexible(
                    child: Text(
                      widget.note!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: AppPalette.textFaint,
                        fontFamily: AppFont.sans,
                        fontFamilyFallback: AppFont.sansFallback,
                        fontSize: widget.metrics.noteSize,
                        height: 1.2,
                      ),
                    ),
                  ),
                ],
                if (widget.trailing != null) ...[
                  const SizedBox(width: 8),
                  widget.trailing!,
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The rule that sets a destructive row apart from the ordinary ones.
class AppMenuDivider extends StatelessWidget {
  const AppMenuDivider({super.key});

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 5),
      child: Divider(height: 1, thickness: 1, color: AppPalette.divider),
    );
  }
}
