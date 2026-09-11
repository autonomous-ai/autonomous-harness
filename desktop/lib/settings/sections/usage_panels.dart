/// The pieces Settings ▸ Usage is built from.
///
/// Split out of `usage_section.dart` the way the debug and tracking panes split
/// their tiles out: the section owns the controller and the layout, and these
/// own how one figure looks. Every one of them is a pure function of what it is
/// handed — none reads a store — so the pane can be driven from a fixture.
library;

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../shared/theme/app_theme.dart';
import '../../stats/harness_stats.dart';
import '../../usage/ledger/ledger_types.dart';
import '../../usage/ledger/usage_overview.dart';

/// The app's own three counters, and the date they start from.
///
/// Orca's equivalent row is Agents spawned / Time agents worked / PRs created.
/// The third is turns here, because this app opens no pull requests — see
/// [HarnessStats] for why a card that could only ever read zero was not worth
/// keeping for the sake of matching.
class StatsSummaryCards extends StatelessWidget {
  const StatsSummaryCards({super.key, required this.summary});

  final StatsSummary summary;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    if (summary.isEmpty) {
      // "Nothing yet" and "0, 0, 0" read very differently: three zeroes look
      // like a broken counter, and this says what would make them move.
      return Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 22),
        decoration: BoxDecoration(
          color: AppSurface.recess,
          borderRadius: BorderRadius.circular(14),
        ),
        child: Center(
          child: Text(
            'Start your first agent to begin tracking.',
            style: TextStyle(fontSize: 12.5, color: AppPalette.textSecondary),
          ),
        ),
      );
    }

    final cards = [
      UsageStatCard(
        label: 'Agents spawned',
        value: '${summary.agentsSpawned}',
        icon: LucideIcons.bot300,
      ),
      UsageStatCard(
        label: 'Time agents worked',
        value: formatWorkedTime(summary.timeWorked),
        icon: LucideIcons.clock300,
      ),
      UsageStatCard(
        label: 'Turns',
        value: '${summary.turns}',
        icon: LucideIcons.messagesSquare300,
      ),
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        LayoutBuilder(
          builder: (context, constraints) {
            final columns = constraints.maxWidth < 420 ? 1 : 3;
            final width = (constraints.maxWidth - (columns - 1) * 10) / columns;
            return Wrap(
              spacing: 10,
              runSpacing: 10,
              children: [
                for (final card in cards) SizedBox(width: width, child: card),
              ],
            );
          },
        ),
        if (summary.firstEventAt case final since?) ...[
          const SizedBox(height: 8),
          Text(
            'Tracking since ${_trackingDate(since)}',
            style: TextStyle(fontSize: 11, color: AppPalette.textFaint),
          ),
        ],
      ],
    );
  }

  static String _trackingDate(DateTime at) {
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    return '${months[at.month - 1]} ${at.day}, ${at.year}';
  }
}

/// `4h 12m`, `3d 5h`, `18m` — a worked duration at a glance.
///
/// Days and hours past a day, hours and minutes past an hour, minutes below.
/// Never seconds: the smallest thing being summed is a turn, and a figure that
/// ticked every second would be the only moving thing on the screen.
String formatWorkedTime(Duration worked) {
  if (worked <= Duration.zero) return '0m';
  if (worked.inDays > 0) {
    return '${worked.inDays}d ${worked.inHours % 24}h';
  }
  if (worked.inHours > 0) {
    return '${worked.inHours}h ${worked.inMinutes % 60}m';
  }
  return '${worked.inMinutes}m';
}

/// One figure on a card.
class UsageStatCard extends StatelessWidget {
  const UsageStatCard({
    super.key,
    required this.label,
    required this.value,
    required this.icon,
    this.footnote,
  });

  final String label;
  final String value;
  final IconData icon;

  /// A qualifier under the figure — "a floor", "3 of 4 priced". Optional,
  /// because most figures need none and a card that always carried one would
  /// train the eye to skip it.
  final String? footnote;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 13),
      decoration: BoxDecoration(
        color: AppGlass.surfaceFill,
        borderRadius: BorderRadius.circular(14),
        boxShadow: AppGlass.cardShadow,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Icon(icon, size: 14, color: AppPalette.textFaint),
              const SizedBox(width: 7),
              Expanded(
                child: Text(
                  label,
                  style: TextStyle(
                    fontSize: 11.5,
                    color: AppPalette.textSecondary,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            value,
            style: TextStyle(
              fontSize: 20,
              fontWeight: FontWeight.w600,
              color: AppPalette.textPrimary,
              height: 1.1,
            ),
          ),
          if (footnote != null) ...[
            const SizedBox(height: 3),
            Text(
              footnote!,
              style: TextStyle(fontSize: 11, color: AppPalette.textFaint),
            ),
          ],
        ],
      ),
    );
  }
}

/// The last several weeks, one cell a day, shaded by how heavy the day was.
///
/// ⚠️ **Every day in the window gets a cell, including the empty ones** — see
/// [recentDays]. A grid drawn only from days with spend would pack a fortnight
/// of work into a solid row and hide that half of it was a weekend, which is
/// most of what somebody looks at this for.
class DailyIntensityGrid extends StatelessWidget {
  const DailyIntensityGrid({
    super.key,
    required this.days,
    required this.busiest,
  });

  final List<LedgerDay> days;

  /// The heaviest day in the window, which sets the scale and is named on the
  /// badge. Null when the window is empty, and then every cell draws at rest.
  final LedgerDay? busiest;

  /// Cells per row. Twenty-one so six weeks land in two clean rows of whole
  /// weeks rather than breaking mid-week wherever the width happens to run out.
  static const _columns = 21;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final peak = busiest?.totals.total ?? 0;

    return _PanelCard(
      title: 'Daily intensity',
      subtitle: 'Recent combined Claude, Codex and OpenCode token activity.',
      badge: busiest != null && busiest!.totals.total > 0
          ? 'Best: ${_shortDate(busiest!.day)}'
          : null,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          LayoutBuilder(
            builder: (context, constraints) {
              // Sized from the width rather than wrapped: every row has to hold
              // the same number of cells or the grid stops reading as weeks.
              const gap = 3.0;
              final cell =
                  (constraints.maxWidth - gap * (_columns - 1)) / _columns;
              return Wrap(
                spacing: gap,
                runSpacing: gap,
                children: [
                  for (final day in days)
                    Tooltip(
                      message:
                          '${_dayLabel(day.day)} — ${formatTokens(day.totals.total)} tokens'
                          '${day.costUsd == null ? '' : '\n${formatCost(day.costUsd)}'}',
                      child: _IntensityCell(
                        level: intensityBucket(day.totals.total, peak),
                        size: cell,
                      ),
                    ),
                ],
              );
            },
          ),
          const SizedBox(height: 12),
          // The scale, with the window's two ends on either side of it — the
          // legend and the date range are one line because they answer the same
          // question: what am I looking at, and over what.
          Row(
            children: [
              Text(
                days.isEmpty ? '' : _shortDate(days.first.day),
                style: TextStyle(fontSize: 11, color: AppPalette.textFaint),
              ),
              const Spacer(),
              Text(
                'Less',
                style: TextStyle(fontSize: 11, color: AppPalette.textFaint),
              ),
              const SizedBox(width: 6),
              for (var level = 0; level <= 4; level++) ...[
                _IntensityCell(level: level, size: 9),
                const SizedBox(width: 3),
              ],
              const SizedBox(width: 3),
              Text(
                'More',
                style: TextStyle(fontSize: 11, color: AppPalette.textFaint),
              ),
              const Spacer(),
              Text(
                days.isEmpty ? '' : _shortDate(days.last.day),
                style: TextStyle(fontSize: 11, color: AppPalette.textFaint),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// One square of the heatmap, at one of five steps.
class _IntensityCell extends StatelessWidget {
  const _IntensityCell({required this.level, required this.size});

  /// `0`–`4`, from [intensityBucket].
  final int level;
  final double size;

  @override
  Widget build(BuildContext context) {
    // Step 0 is the recess the empty grid is made of; the rest climb the accent.
    // Discrete steps rather than a ramp, because a heatmap is read by comparing
    // squares and a smooth gradient gives the eye nothing to compare.
    const alphas = [0.0, 0.22, 0.42, 0.66, 1.0];
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: level == 0
            ? AppSurface.recess
            : AppPalette.accent.withValues(alpha: alphas[level]),
        borderRadius: BorderRadius.circular(2),
      ),
    );
  }
}

/// Where the tokens went: fresh input, output, and everything cached.
///
/// Three segments rather than four, which is Orca's split and the right one for
/// a bar: cache reads and cache writes are both *cache*, and separating them
/// here would put two slivers side by side that nobody compares. The four-way
/// split still exists where it is useful — a provider's own detail pane.
class TokenMixBar extends StatelessWidget {
  const TokenMixBar({super.key, required this.totals});

  final UsageTotals totals;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final colours = usageMixColours;
    final slices = <({String label, int tokens, Color colour})>[
      (
        label: 'New input',
        tokens: totals.freshInput,
        colour: colours.freshInput,
      ),
      (label: 'Output', tokens: totals.output, colour: colours.output),
      (label: 'Cache', tokens: totals.cache, colour: colours.cache),
    ];
    final mixTotal = slices.fold(0, (sum, slice) => sum + slice.tokens);

    return _PanelCard(
      title: 'Token mix',
      subtitle:
          'Combined input, output and cache tokens across enabled '
          'providers.',
      // Reasoning is a SUBSET of output, so it cannot be a fourth slice — it
      // rides as a badge instead, which is exactly what it is: a note about one
      // of the three, not a fourth thing beside them.
      badge: totals.reasoning > 0
          ? '${formatTokens(totals.reasoning)} reasoning'
          : null,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(999),
            child: SizedBox(
              height: 10,
              child: mixTotal == 0
                  ? ColoredBox(color: AppSurface.recess)
                  : Row(
                      children: [
                        for (final slice in slices)
                          if (slice.tokens > 0)
                            Expanded(
                              flex: slice.tokens,
                              child: ColoredBox(color: slice.colour),
                            ),
                      ],
                    ),
            ),
          ),
          const SizedBox(height: 12),
          for (final slice in slices)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Row(
                children: [
                  Container(
                    width: 8,
                    height: 8,
                    decoration: BoxDecoration(
                      color: slice.colour,
                      borderRadius: BorderRadius.circular(4),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      '${slice.label}: ${formatTokens(slice.tokens)}',
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12,
                        color: AppPalette.textSecondary,
                      ),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

/// The colours the overview's three-way mix keeps.
///
/// Named once so the bar and its legend cannot drift apart. Distinct from
/// `usageBucketColours` in `usage_detail_panels.dart`, which is the FOUR-way
/// split a provider's own pane draws — two different groupings, two vocabularies.
UsageMixColours get usageMixColours => (
  freshInput: AppPalette.accent,
  output: AppPalette.teal,
  cache: AppPalette.online,
);

typedef UsageMixColours = ({Color freshInput, Color output, Color cache});

/// The frame the two overview panels share: a title, a subtitle, an optional
/// badge on the right, and a body.
class _PanelCard extends StatelessWidget {
  const _PanelCard({
    required this.title,
    required this.subtitle,
    required this.child,
    this.badge,
  });

  final String title;
  final String subtitle;
  final String? badge;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
      decoration: BoxDecoration(
        color: AppGlass.surfaceFill,
        borderRadius: BorderRadius.circular(14),
        boxShadow: AppGlass.cardShadow,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: Theme.of(context).textTheme.titleSmall),
                    const SizedBox(height: 2),
                    Text(
                      subtitle,
                      style: TextStyle(
                        fontSize: 11.5,
                        height: 1.35,
                        color: AppPalette.textSecondary,
                      ),
                    ),
                  ],
                ),
              ),
              if (badge case final label?) ...[
                const SizedBox(width: 8),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 3,
                  ),
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(7),
                    border: Border.all(color: AppPalette.divider),
                  ),
                  child: Text(
                    label,
                    style: TextStyle(
                      fontSize: 10.5,
                      height: 1.25,
                      color: AppPalette.textSecondary,
                    ),
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: 14),
          child,
        ],
      ),
    );
  }
}

String _dayLabel(DateTime day) =>
    '${day.year}-${_two(day.month)}-${_two(day.day)}';

/// `Aug 19` — how a date is named on a badge or under the grid.
String _shortDate(DateTime day) {
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return '${months[day.month - 1]} ${day.day}';
}

String _two(int value) => value.toString().padLeft(2, '0');

/// One provider's row: what it is, whether it is on, and what it has spent.
class ProviderUsageRow extends StatelessWidget {
  const ProviderUsageRow({
    super.key,
    required this.ledger,
    required this.state,
    required this.grandTotal,
    required this.onToggle,
  });

  final ProviderLedger ledger;
  final LedgerScanState state;

  /// Every provider's tokens added up, for this row's share bar. Zero draws an
  /// empty bar rather than dividing by it.
  final int grandTotal;

  final ValueChanged<bool> onToggle;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final share = grandTotal == 0 ? 0.0 : ledger.totals.total / grandTotal;
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 13),
      decoration: BoxDecoration(
        color: AppGlass.surfaceFill,
        borderRadius: BorderRadius.circular(14),
        boxShadow: AppGlass.cardShadow,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(
                ledger.provider.label,
                style: Theme.of(context).textTheme.titleSmall,
              ),
              const SizedBox(width: 8),
              _StatusPill(state: state),
              const Spacer(),
              TextButton(
                onPressed: () => onToggle(!state.enabled),
                style: TextButton.styleFrom(
                  minimumSize: const Size(0, 26),
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
                child: Text(
                  state.enabled ? 'Turn off' : 'Enable',
                  style: const TextStyle(fontSize: 12),
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          if (_detail() case final detail?)
            Text(
              detail,
              style: TextStyle(fontSize: 11.5, color: AppPalette.textSecondary),
            ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: Text(
                  '${formatTokens(ledger.totals.total)} tokens',
                  style: TextStyle(fontSize: 12, color: AppPalette.textPrimary),
                ),
              ),
              Text(
                formatCost(ledger.costUsd),
                style: TextStyle(
                  fontSize: 12,
                  color: AppPalette.textPrimary,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          ClipRRect(
            borderRadius: BorderRadius.circular(3),
            child: SizedBox(
              height: 5,
              child: Row(
                children: [
                  if (share > 0)
                    Expanded(
                      flex: (share * 1000).round(),
                      child: ColoredBox(color: AppPalette.accent),
                    ),
                  Expanded(
                    flex: (1000 - share * 1000).round().clamp(0, 1000),
                    child: ColoredBox(color: AppSurface.recess),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// The line under the name — the reason there are no figures where there are
  /// none, and what was found where there are.
  ///
  /// The message from an [LedgerStatus.unavailable] or [LedgerStatus.failed]
  /// scan is printed verbatim: the scanner already said why in a sentence, and
  /// re-wording it here would be a second place for that explanation to drift.
  ///
  /// Returns null when there is nothing worth saying — the status pill already
  /// carries "Off" / "Scanning", so repeating it here is noise.
  String? _detail() {
    if (!state.enabled) return null;
    return switch (state.status) {
      LedgerStatus.scanning => null,
      LedgerStatus.unavailable ||
      LedgerStatus.failed => state.message ?? 'No figures.',
      LedgerStatus.disabled => null,
      LedgerStatus.ok =>
        ledger.hasData
            ? '${ledger.sessionCount} '
                  '${ledger.sessionCount == 1 ? 'session' : 'sessions'}'
            : 'Nothing spent here yet.',
    };
  }
}

class _StatusPill extends StatelessWidget {
  const _StatusPill({required this.state});

  final LedgerScanState state;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final (label, color) = switch (state.enabled
        ? state.status
        : LedgerStatus.disabled) {
      LedgerStatus.ok => ('On', AppPalette.online),
      LedgerStatus.scanning => ('Scanning', AppPalette.accentOnSurface),
      LedgerStatus.unavailable => ('Not found', AppPalette.textFaint),
      LedgerStatus.failed => ('Failed', AppPalette.warn),
      LedgerStatus.disabled => ('Off', AppPalette.textFaint),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        label,
        style: TextStyle(fontSize: 10.5, color: color, height: 1.3),
      ),
    );
  }
}

/// The "nothing is switched on yet" card, and the three switches.
///
/// The buttons are the whole point of this state: the pane's resting condition
/// is that it reads nothing, and a screen that merely said so would leave
/// somebody hunting for the switch it is describing.
class UsageEmptyState extends StatelessWidget {
  const UsageEmptyState({super.key, required this.onEnable});

  final ValueChanged<LedgerProvider> onEnable;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 18),
      decoration: BoxDecoration(
        color: AppGlass.surfaceFill,
        borderRadius: BorderRadius.circular(14),
        boxShadow: AppGlass.cardShadow,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                LucideIcons.chartNoAxesColumn300,
                size: 15,
                color: AppPalette.textFaint,
              ),
              const SizedBox(width: 8),
              Text(
                'Start counting tokens',
                style: Theme.of(context).textTheme.titleSmall,
              ),
            ],
          ),
          const SizedBox(height: 6),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: Text(
              'Switch on a provider to read the logs its CLI already keeps on '
              'this computer, and build the token ledger from them. Nothing is '
              'read until you do, and nothing leaves this machine.',
              style: TextStyle(
                fontSize: 12.5,
                height: 1.45,
                color: AppPalette.textSecondary,
              ),
            ),
          ),
          const SizedBox(height: 14),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final provider in LedgerProvider.values)
                FilledButton(
                  onPressed: () => onEnable(provider),
                  style: FilledButton.styleFrom(
                    minimumSize: const Size(0, 30),
                    padding: const EdgeInsets.symmetric(horizontal: 14),
                  ),
                  child: Text(
                    'Enable ${provider.label}',
                    style: const TextStyle(fontSize: 12.5),
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }
}
