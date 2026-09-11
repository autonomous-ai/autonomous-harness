import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../theme/app_theme.dart';

/// A quiet caption over a run of rail rows, with an optional `+` beside it.
///
/// Micro-type — 11pt, faint — because it names a group rather than competing
/// with the rows under it. Both halves of the sidebar use it, which is the
/// point: "Projects" in Home and "Projects" in Code list entirely different
/// things, and the one thing they must not differ on is how a rail heading
/// looks.
class RailSectionHeader extends StatelessWidget {
  const RailSectionHeader({
    super.key,
    required this.label,
    this.onTap,
    this.tooltip,
    this.onAdd,
    this.addTooltip,
  });

  final String label;

  /// What tapping the label does. Null leaves it as plain text — a heading that
  /// looks tappable and isn't is worse than one that never offered.
  final VoidCallback? onTap;
  final String? tooltip;

  /// The `+` at the right end. Null draws none.
  final VoidCallback? onAdd;
  final String? addTooltip;

  @override
  Widget build(BuildContext context) {
    // Reads AppPalette tokens — follow theme flips.
    AppTheme.watch(context);
    final text = Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Text(
        label,
        style: TextStyle(
          color: AppPalette.textFaint,
          fontSize: 11,
          fontWeight: AppFont.medium,
          letterSpacing: 0.2,
        ),
      ),
    );
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 12, 2, 2),
      child: Row(
        children: [
          Expanded(
            child: onTap == null
                ? text
                : Tooltip(
                    message: tooltip ?? '',
                    child: InkWell(onTap: onTap, child: text),
                  ),
          ),
          if (onAdd != null)
            IconButton(
              tooltip: addTooltip,
              iconSize: 18,
              visualDensity: VisualDensity.compact,
              constraints: const BoxConstraints.tightFor(width: 26, height: 26),
              padding: EdgeInsets.zero,
              color: AppPalette.textSecondary,
              icon: const Icon(LucideIcons.plus300),
              onPressed: onAdd,
            ),
        ],
      ),
    );
  }
}
