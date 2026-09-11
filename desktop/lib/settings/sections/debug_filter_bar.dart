import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart';
import '../../shared/widgets/toolbar_pill.dart';

/// One lens in a [DebugFilterBar]: what it is called, how many rows it holds,
/// and what selecting it does.
///
/// Ported from Grid (`features/debug/presentation/debug_filter_bar.dart`) with
/// its `PillChoice` swapped for this app's [ToolbarPill] — the same control the
/// node dashboard's toolbar uses, rather than a second pill shape that would
/// drift from it.
class DebugLens {
  const DebugLens({
    required this.label,
    required this.count,
    required this.selected,
    required this.onTap,
    this.danger = false,
    this.hideWhenEmpty = false,
  });

  final String label;

  /// Live count, shown as a dimmer trailing figure so "is anything red?" is
  /// answered before the list below is even read.
  final int count;

  final bool selected;
  final VoidCallback onTap;

  /// Tints the count red once it is non-zero — for the failure lens.
  final bool danger;

  /// Drop this lens while its count is zero. An always-there "Failed 0" pill
  /// trains the eye to ignore it; it comes back the moment something fails, and
  /// never vanishes from under a user who has it selected.
  final bool hideWhenEmpty;
}

/// The row of lenses above the Debug list.
class DebugFilterBar extends StatelessWidget {
  const DebugFilterBar({super.key, required this.lenses});

  final List<DebugLens> lenses;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    // Wrap, not Row: the categories are whatever the session logged, and a
    // narrow window has to drop one to a second line rather than overflow.
    return Wrap(
      spacing: 6,
      runSpacing: 6,
      children: [
        for (final lens in lenses)
          if (!lens.hideWhenEmpty || lens.count > 0 || lens.selected)
            ToolbarPill(
              onTap: lens.onTap,
              tinted: lens.selected,
              rimmed: !lens.selected,
              child: _LensLabel(lens: lens),
            ),
      ],
    );
  }
}

/// A pill's text plus a dimmer trailing count — the count reads as metadata,
/// not as part of the label.
class _LensLabel extends StatelessWidget {
  const _LensLabel({required this.lens});

  final DebugLens lens;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final ink = ToolbarPill.tint(tinted: lens.selected, enabled: true);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          lens.label,
          style: TextStyle(
            fontSize: 13,
            fontWeight: AppFont.medium,
            color: ink,
          ),
        ),
        const SizedBox(width: 6),
        Text(
          '${lens.count}',
          style: TextStyle(
            fontSize: 12.5,
            fontWeight: AppFont.medium,
            color: lens.selected
                ? ink
                : lens.danger && lens.count > 0
                ? AppPalette.dangerFill
                : AppPalette.textFaint,
            fontFeatures: const [FontFeature.tabularFigures()],
          ),
        ),
      ],
    );
  }
}
