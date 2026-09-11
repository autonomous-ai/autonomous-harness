/// The three panels under a provider's figures: the daily chart, the two
/// breakdowns, and the recent sessions.
///
/// Ported from Orca's `ClaudeUsageDailyChart`, `UsageBreakdownSection` and
/// `UsageRecentSessionsTable`. Pure widgets — each is a function of what it is
/// handed, so the pane can be driven from a fixture.
library;

import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart';
import '../../usage/ledger/ledger_types.dart';
import '../../usage/ledger/usage_overview.dart';
import '../../usage/ledger/usage_report.dart';

/// How many days the bar chart shows. Ten, as Orca uses — enough to see a shape,
/// few enough that each bar keeps a readable label under it.
const _kChartDays = 10;

/// The colours the four token buckets keep, everywhere they are drawn.
///
/// Named once so the chart, its legend and the token-mix bar cannot drift into
/// three different keys for the same four things.
UsageBucketColours get usageBucketColours => (
  freshInput: AppPalette.accent,
  output: AppPalette.teal,
  cacheRead: AppPalette.online,
  cacheWrite: AppPalette.warn,
);

typedef UsageBucketColours = ({
  Color freshInput,
  Color output,
  Color cacheRead,
  Color cacheWrite,
});

/// Tokens by day, stacked by bucket.
class UsageDailyChart extends StatelessWidget {
  const UsageDailyChart({super.key, required this.days});

  /// Oldest first. Only the last [_kChartDays] are drawn.
  final List<LedgerDay> days;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final shown = days.length > _kChartDays
        ? days.sublist(days.length - _kChartDays)
        : days;
    // The tallest day sets the scale. Floored at 1 so an all-zero window cannot
    // divide by zero — every bar then draws empty, which is the truth.
    var peak = 1;
    for (final day in shown) {
      if (day.totals.total > peak) peak = day.totals.total;
    }
    final colours = usageBucketColours;

    return _Card(
      title: 'Daily usage',
      subtitle: 'Fresh input, output, cache read and cache write by day.',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            height: 170,
            child: shown.isEmpty
                ? Center(
                    child: Text(
                      'Nothing in this range.',
                      style: TextStyle(
                        fontSize: 12,
                        color: AppPalette.textFaint,
                      ),
                    ),
                  )
                : Row(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      for (final day in shown)
                        Expanded(
                          child: _Bar(day: day, peak: peak, colours: colours),
                        ),
                    ],
                  ),
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 14,
            runSpacing: 6,
            children: [
              _LegendDot(colour: colours.freshInput, label: 'Fresh input'),
              _LegendDot(colour: colours.output, label: 'Output'),
              _LegendDot(colour: colours.cacheRead, label: 'Cache read'),
              _LegendDot(colour: colours.cacheWrite, label: 'Cache write'),
            ],
          ),
        ],
      ),
    );
  }
}

class _Bar extends StatelessWidget {
  const _Bar({required this.day, required this.peak, required this.colours});

  final LedgerDay day;
  final int peak;
  final UsageBucketColours colours;

  @override
  Widget build(BuildContext context) {
    final total = day.totals.total;
    final segments = <({int tokens, Color colour})>[
      // Top-down, so the stack reads in the same order as the legend.
      (tokens: day.totals.cacheWrite, colour: colours.cacheWrite),
      (tokens: day.totals.cacheRead, colour: colours.cacheRead),
      (tokens: day.totals.output, colour: colours.output),
      (tokens: day.totals.freshInput, colour: colours.freshInput),
    ];

    return Tooltip(
      message:
          '${_dayLabel(day.day)}\n'
          '${formatTokens(total)} tokens'
          '${day.costUsd == null ? '' : '\n${formatCost(day.costUsd)}'}',
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 3),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            Text(
              total == 0 ? '' : formatTokens(total),
              style: TextStyle(fontSize: 9.5, color: AppPalette.textFaint),
            ),
            const SizedBox(height: 4),
            SizedBox(
              height: 118,
              child: Column(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  // `Flexible` per segment rather than a fixed height: the
                  // column is already bounded, so flex shares it in proportion
                  // and nothing has to be measured against the peak by hand.
                  for (final segment in segments)
                    if (segment.tokens > 0)
                      Flexible(
                        flex: segment.tokens,
                        child: Container(color: segment.colour),
                      ),
                  // The unused remainder of the tallest bar, so short days sit
                  // at the bottom instead of being stretched to full height.
                  if (peak > total)
                    Flexible(flex: peak - total, child: const SizedBox()),
                ],
              ),
            ),
            const SizedBox(height: 5),
            Text(
              _shortDay(day.day),
              style: TextStyle(fontSize: 9.5, color: AppPalette.textFaint),
            ),
          ],
        ),
      ),
    );
  }
}

class _LegendDot extends StatelessWidget {
  const _LegendDot({required this.colour, required this.label});

  final Color colour;
  final String label;

  @override
  Widget build(BuildContext context) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      Container(
        width: 8,
        height: 8,
        decoration: BoxDecoration(
          color: colour,
          borderRadius: BorderRadius.circular(2),
        ),
      ),
      const SizedBox(width: 6),
      Text(
        label,
        style: TextStyle(fontSize: 11.5, color: AppPalette.textSecondary),
      ),
    ],
  );
}

/// A ranked list — the top few models, or the top few projects.
class UsageBreakdownCard extends StatelessWidget {
  const UsageBreakdownCard({
    super.key,
    required this.title,
    required this.subtitle,
    required this.rows,
    this.limit = 5,
  });

  final String title;
  final String subtitle;

  /// Heaviest first, as `breakdownByModel` and `breakdownByProject` return them.
  final List<BreakdownRow> rows;
  final int limit;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final shown = rows.take(limit).toList();
    return _Card(
      title: title,
      subtitle: subtitle,
      child: shown.isEmpty
          ? Text(
              'Nothing in this range.',
              style: TextStyle(fontSize: 12, color: AppPalette.textFaint),
            )
          : Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (final row in shown) ...[
                  Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Expanded(
                              child: Text(
                                row.label,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  fontSize: 12.5,
                                  color: AppPalette.textPrimary,
                                ),
                              ),
                            ),
                            const SizedBox(width: 10),
                            Text(
                              formatTokens(row.tokens),
                              style: TextStyle(
                                fontSize: 12.5,
                                color: AppPalette.textSecondary,
                                fontFeatures: const [
                                  FontFeature.tabularFigures(),
                                ],
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 2),
                        Text(
                          _rowDetail(row),
                          style: TextStyle(
                            fontSize: 11,
                            color: AppPalette.textFaint,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ],
            ),
    );
  }

  static String _rowDetail(BreakdownRow row) {
    final parts = <String>[
      '${row.sessions} ${row.sessions == 1 ? 'session' : 'sessions'}',
      '${row.turns} ${row.turns == 1 ? 'turn' : 'turns'}',
      if (row.costUsd != null) formatCost(row.costUsd),
    ];
    return parts.join(' · ');
  }
}

/// The most recent sessions, newest first.
class UsageSessionsTable extends StatelessWidget {
  const UsageSessionsTable({super.key, required this.rows});

  final List<SessionRow> rows;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return _Card(
      title: 'Recent sessions',
      subtitle: 'The latest sessions this provider recorded on this computer.',
      child: rows.isEmpty
          ? Text(
              'Nothing in this range.',
              style: TextStyle(fontSize: 12, color: AppPalette.textFaint),
            )
          // A table is the one thing on this pane that can genuinely outgrow
          // its column, so it brings its own horizontal scroll rather than
          // letting the pane's body overflow.
          //
          // ⚠️ **The width is stated, not stretched.** Inside a horizontal
          // scroll view the incoming width is UNBOUNDED, so a
          // `CrossAxisAlignment.stretch` here asks its rows to be infinitely
          // wide and the layout throws. The columns already know how wide they
          // are; summing them is the only honest width this table has.
          : SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: SizedBox(
                width: _sessionTableWidth,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _SessionHeaderRow(),
                    for (final row in rows) _SessionRowTile(row: row),
                  ],
                ),
              ),
            ),
    );
  }
}

/// The table's own width — the columns added up. See [UsageSessionsTable] for
/// why it cannot simply stretch.
double get _sessionTableWidth =>
    _kSessionColumns.fold(0, (total, column) => total + column.width);

const _kSessionColumns = <({String label, double width, bool numeric})>[
  (label: 'Last active', width: 116, numeric: false),
  (label: 'Project', width: 132, numeric: false),
  (label: 'Model', width: 168, numeric: false),
  (label: 'Turns', width: 54, numeric: true),
  (label: 'Tokens', width: 74, numeric: true),
  (label: 'Cost', width: 74, numeric: true),
];

class _SessionHeaderRow extends StatelessWidget {
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 6),
    child: Row(
      children: [
        for (final column in _kSessionColumns)
          SizedBox(
            width: column.width,
            child: Text(
              column.label,
              textAlign: column.numeric ? TextAlign.right : TextAlign.left,
              style: TextStyle(fontSize: 11, color: AppPalette.textFaint),
            ),
          ),
      ],
    ),
  );
}

class _SessionRowTile extends StatelessWidget {
  const _SessionRowTile({required this.row});

  final SessionRow row;

  @override
  Widget build(BuildContext context) {
    final cells = <String>[
      _sessionTime(row.lastActiveAt),
      row.project,
      row.model ?? 'Unknown',
      '${row.turns}',
      formatTokens(row.totals.total),
      formatCost(row.costUsd),
    ];
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        children: [
          for (var i = 0; i < _kSessionColumns.length; i++)
            SizedBox(
              width: _kSessionColumns[i].width,
              child: Text(
                cells[i],
                overflow: TextOverflow.ellipsis,
                textAlign: _kSessionColumns[i].numeric
                    ? TextAlign.right
                    : TextAlign.left,
                style: TextStyle(
                  fontSize: 12,
                  color: i == 1
                      ? AppPalette.textPrimary
                      : AppPalette.textSecondary,
                  fontFeatures: _kSessionColumns[i].numeric
                      ? const [FontFeature.tabularFigures()]
                      : null,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// The frame every panel here wears.
class _Card extends StatelessWidget {
  const _Card({
    required this.title,
    required this.subtitle,
    required this.child,
  });

  final String title;
  final String subtitle;
  final Widget child;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
    decoration: BoxDecoration(
      color: AppGlass.surfaceFill,
      borderRadius: BorderRadius.circular(14),
      boxShadow: AppGlass.cardShadow,
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, style: Theme.of(context).textTheme.titleSmall),
        const SizedBox(height: 2),
        Text(
          subtitle,
          style: TextStyle(fontSize: 11.5, color: AppPalette.textSecondary),
        ),
        const SizedBox(height: 12),
        child,
      ],
    ),
  );
}

String _dayLabel(DateTime day) =>
    '${day.year}-${_two(day.month)}-${_two(day.day)}';

String _shortDay(DateTime day) => '${_two(day.month)}-${_two(day.day)}';

String _sessionTime(DateTime at) =>
    '${_two(at.month)}-${_two(at.day)} ${_two(at.hour)}:${_two(at.minute)}';

String _two(int value) => value.toString().padLeft(2, '0');
