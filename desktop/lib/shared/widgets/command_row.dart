import 'package:flutter/material.dart';

import '../../theme/app_theme.dart';
import '../theme/app_theme.dart' as grid;

/// A single-line shell command with a copy affordance: tap anywhere on the row to copy, the trailing
/// icon flips to a checkmark for a moment to confirm. Shared by any screen that hands the user a
/// command to run themselves (`harness_join_guide_screen.dart`, `environment_setup_screen.dart`).
class CommandRow extends StatelessWidget {
  final String command;
  final bool copied;
  final VoidCallback onCopy;

  const CommandRow({
    super.key,
    required this.command,
    required this.copied,
    required this.onCopy,
  });

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onCopy,
      borderRadius: BorderRadius.circular(grid.AppCard.insetRadius),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: AppColors.background,
          border: Border.all(color: AppColors.border),
          borderRadius: BorderRadius.circular(grid.AppCard.insetRadius),
        ),
        child: Row(
          children: [
            Text('\$ ', style: TextStyle(color: AppColors.mutedStrong)),
            Expanded(
              child: SelectableText(
                command,
                style: TextStyle(
                  color: AppColors.text,
                  fontFamily: AppFonts.mono,
                  fontSize: 13,
                ),
              ),
            ),
            Icon(
              copied ? Icons.check : Icons.copy,
              size: 16,
              color: copied ? AppColors.success : AppColors.mutedStrong,
            ),
          ],
        ),
      ),
    );
  }
}
