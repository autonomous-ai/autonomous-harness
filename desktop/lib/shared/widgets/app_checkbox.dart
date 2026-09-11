import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// A square tick box that fills with the accent when it is on.
///
/// Material's [Checkbox] is unusable raw here for the same reason [IconButton]
/// is (see [AppIconButton]): the app defines no `checkboxTheme`, so a bare one
/// takes Material's defaults — and the loudest of those is an **ink overlay
/// that is a circle**, laid over a square box on hover, focus and press. A round
/// wash bleeding out past the corners of the thing it belongs to is the single
/// clearest tell that a control was never looked at; on macOS a checkbox has no
/// hover halo at all, it just deepens.
///
/// It also brings a 48px tap target, a 2px corner where this app's controls sit
/// at 4–8, and a resting rim from `colorScheme.onSurfaceVariant` that reads far
/// darker than any other unfilled surface here.
///
/// So: the app's own formula instead — [MouseRegion] + [AnimatedContainer] on
/// [AppMotion.hover], depth from fill (§1), and a hover state that stays inside
/// the box's own edges.
///
/// ⚠️ This draws the BOX only. The label beside it belongs to the caller, and
/// so does the tap target that covers both — a checkbox whose text is not
/// clickable is a smaller target than it looks, and every row in this app that
/// carries one wraps the pair in its own [GestureDetector].
class AppCheckbox extends StatelessWidget {
  const AppCheckbox({
    super.key,
    required this.value,
    required this.onChanged,
    this.hovered = false,
  });

  final bool value;
  final ValueChanged<bool>? onChanged;

  /// Whether the pointer is on the ROW this box belongs to.
  ///
  /// Passed in rather than sensed here, because the box is a 16px target inside
  /// a row that is the real one: a box that only warmed when the pointer was
  /// literally on it would stay cold through almost every hover the user
  /// actually performs.
  final bool hovered;

  /// Matches the cap height of the [AppControl.fontSize] label beside it, so
  /// the two sit on one line rather than the box floating above the text.
  static const double _box = 16;

  /// A step tighter than [AppControl.radius]. A checkbox reads as square — at
  /// the button's 8 on a 16px box the corners eat a quarter of each edge and it
  /// turns into a rounded chip.
  static const double _radius = 4;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final enabled = onChanged != null;

    return AnimatedContainer(
      duration: AppMotion.hover,
      curve: AppMotion.curve,
      width: _box,
      height: _box,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(_radius),
        // Ticked, the accent carries it. Unticked, it is a recessed well like
        // every other empty control surface in the app — a step lighter under
        // the pointer, which is the whole of the hover treatment.
        color: value
            ? (enabled ? AppPalette.accent : AppPalette.accentMuted)
            : (hovered && enabled ? AppSurface.recessHover : AppSurface.recess),
      ),
      child: AnimatedOpacity(
        duration: AppMotion.hover,
        curve: AppMotion.curve,
        opacity: value ? 1 : 0,
        child: const Icon(Icons.check_rounded, size: 12, color: Colors.white),
      ),
    );
  }
}
