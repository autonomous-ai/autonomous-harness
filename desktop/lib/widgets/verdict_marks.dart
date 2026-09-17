// The one status a harness's verdict puts in the viewer pane's title: ready,
// or what stands in the way, or where the work is. One mark, each new state
// replacing the last — a status, not a history.
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../core/models.dart';
import '../theme/app_theme.dart';

/// Ready wins; then errors; then the phase under way; then warnings; then the
/// last phase that happened; then a plain "Checked". The colour says which.
///
/// While the agent is mid-turn the verdict is the LAST check, not this one: a
/// fresh workspace's template reads "Ready" before the agent has done anything.
/// So a working agent shows the phase it declares under way, or "Working", and
/// the last verdict moves to the tooltip.
class VerdictStatus extends StatelessWidget {
  const VerdictStatus({super.key, required this.verdict, this.working = false});

  final AgentVerdict verdict;
  final bool working;

  static String _count(int n, String noun) =>
      '$n ${n == 1 ? noun : '${noun}s'}';

  @override
  Widget build(BuildContext context) {
    final active = verdict.activePhase;
    final last = verdict.currentPhase;
    final (icon, color, label, weight) = working
        ? (
            LucideIcons.loaderCircle,
            AppColors.text,
            active?.name ?? 'Working',
            FontWeight.w600,
          )
        : verdict.ready
        ? (LucideIcons.circleCheck, AppColors.success, 'Ready', FontWeight.w700)
        : verdict.errors > 0
        ? (
            LucideIcons.circleX,
            AppColors.danger,
            _count(verdict.errors, 'error'),
            FontWeight.w600,
          )
        : active != null
        ? (LucideIcons.circleDot, AppColors.text, active.name, FontWeight.w700)
        : verdict.warnings > 0
        ? (
            LucideIcons.triangleAlert,
            AppColors.warning,
            _count(verdict.warnings, 'warning'),
            FontWeight.w600,
          )
        : last != null
        ? (
            last.state == AgentPhaseState.failed
                ? LucideIcons.x
                : LucideIcons.check,
            last.state == AgentPhaseState.failed
                ? AppColors.danger
                : AppColors.success,
            last.name,
            FontWeight.w500,
          )
        : (
            LucideIcons.circleDashed,
            AppColors.mutedStrong,
            'Checked',
            FontWeight.w500,
          );
    return Tooltip(
      message: working
          ? 'The agent is working${verdict.summary == null ? '' : ' · last check: ${verdict.summary}'}'
          : verdict.summary ?? label,
      waitDuration: const Duration(milliseconds: 500),
      child: Semantics(
        label: 'Status: $label',
        child: Row(
          key: const ValueKey('pane-status'),
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 12, color: color),
            const SizedBox(width: 4),
            Flexible(
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: color,
                  fontFamily: AppFonts.sans,
                  fontSize: 12,
                  fontWeight: weight,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
