/// Settings ▸ Usage — what this app has done, and what the agent CLIs on this
/// computer have spent.
///
/// Two halves, as Orca's Stats & Usage page has:
///
/// * **Stats** — the app's own counters (`stats/harness_stats.dart`). No
///   permission needed and no switch: an app may count what it did.
/// * **Usage analytics** — the token ledger (`usage/ledger/`), read out of the
///   agent CLIs' own logs. Off until switched on, per provider, because those
///   logs hold every prompt and path a session touched.
///
/// Its sibling readout on the status rail (`widgets/status_rail/usage_panel.dart`)
/// answers a third question — *how much of your rate limit is left* — which is
/// an account fact and a percentage. All three are true at once and none
/// substitutes for another.
///
/// ⚠️ **Every figure here is this computer's alone.** Agents launched onto a
/// remote machine write their transcripts there, and nothing in this pane
/// reaches them — which the subtitle says out loud, because a total that
/// silently excluded most of a team's work would be worse than no total.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../core/test_run.dart';
import '../../shared/theme/app_theme.dart';
import '../../shared/widgets/app_select_field.dart';
import '../../shared/widgets/section_scaffold.dart';
import '../../stats/harness_stats.dart';
import '../../usage/ledger/ledger_types.dart';
import '../../usage/ledger/usage_ledger_controller.dart';
import '../../usage/ledger/usage_overview.dart';
import '../../usage/ledger/usage_report.dart';
import 'usage_panels.dart';
import 'usage_provider_pane.dart';

/// What the overview opens on — the last 30 days, which is what Orca's default
/// range shows and therefore what a figure here can be compared against.
///
/// ⚠️ **Not all-time, and that is a considered default rather than a limitation.**
/// "Active days 33" over an unbounded history and "20" over the last month are
/// both true and answer different questions, and the one somebody opening this
/// screen means is almost always the recent one. All time is still a click away.
const _kDefaultOverviewRange = UsageRange.d30;

/// How many days the intensity grid draws — six weeks, whatever the range is.
///
/// Fixed rather than following the range, which is what Orca does and what the
/// strip is for: it is a *recent activity* band, and six weeks is enough to see
/// a rhythm — a fortnight off still reads as a gap instead of falling off the
/// edge.
///
/// ⚠️ **The days outside a narrower range are not stray data — they are EMPTY by
/// construction.** `overview.days` is already clipped to the chosen window, so
/// `recentDays` fills everything before it with blank cells. An earlier version
/// shrank the grid to the range on the theory that a cell might be read as part
/// of a total it was not in; there is no such cell, and shrinking only cost the
/// strip the context that makes a heatmap worth drawing.
const _kGridDayCount = 42;

/// Which lens the Usage analytics half is showing.
///
/// `null` is the overview — every provider added together. Named by absence
/// rather than by a fourth enum value so the per-provider cases stay exactly the
/// providers that exist.
typedef _Lens = LedgerProvider?;

class UsageSection extends StatefulWidget {
  const UsageSection({super.key, this.controller, this.stats});

  /// The ledger to draw. Defaults to one of its own; a test passes its own,
  /// which is also what keeps `flutter test` from reading a real `~/.claude`.
  final UsageLedgerController? controller;

  /// The app's own counters. Defaults to the singleton.
  final HarnessStats? stats;

  @override
  State<UsageSection> createState() => _UsageSectionState();
}

class _UsageSectionState extends State<UsageSection> {
  late final UsageLedgerController _controller =
      widget.controller ?? UsageLedgerController();

  /// True only for a controller this widget made, which is the only one it may
  /// dispose — an injected one outlives the pane that borrowed it.
  late final bool _ownsController = widget.controller == null;

  HarnessStats get _stats => widget.stats ?? harnessStats;

  _Lens _lens;

  /// The window the overview is read over. Held per screen, like the range on a
  /// provider's pane: it is what you are looking at now, not a setting.
  UsageRange _range = _kDefaultOverviewRange;

  @override
  void initState() {
    super.initState();
    // Not under test, for the reason `UsageController` does not poll there: this
    // walks every transcript under a real `~/.claude`, and a test run must
    // depend on neither the machine it lands on nor whoever was working on it.
    // A test that wants figures injects a controller already holding them.
    if (!kUnderTest) unawaited(_controller.load());
  }

  @override
  void dispose() {
    if (_ownsController) _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return SectionScaffold(
      title: 'Usage',
      subtitle:
          'What this app has done, and what the agent CLIs on this computer '
          'have spent. Agents running on other machines are not included, and '
          'nothing here is sent anywhere.',
      child: ListenableBuilder(
        // Both halves, so the stats cards move as agents start and stop while
        // the screen is open.
        listenable: Listenable.merge([_controller, _stats]),
        builder: (context, _) => _body(context),
      ),
    );
  }

  Widget _body(BuildContext context) {
    final overview = _controller.overviewFor(_range);
    final states = {
      for (final state in _controller.scanStates) state.provider: state,
    };

    return ListView(
      padding: EdgeInsets.zero,
      children: [
        StatsSummaryCards(summary: _stats.summary),
        const SizedBox(height: 20),
        _AnalyticsHeader(
          lens: _lens,
          onLensChanged: (lens) => setState(() => _lens = lens),
        ),
        const SizedBox(height: 12),
        if (_lens case final provider?)
          UsageProviderPane(store: _controller.storeFor(provider))
        else ...[
          // One card around the whole overview, as Orca draws it: the heading,
          // the four figures and the two panels are one answer, and the panels
          // inside it are the parts of that answer rather than peers of it.
          _OverviewCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _OverviewHeader(
                  overview: overview,
                  range: _range,
                  isScanning: _controller.isScanning,
                  onRangeChanged: (range) => setState(() => _range = range),
                  onRefresh: overview.enabledCount == 0
                      ? null
                      : () => unawaited(_controller.refresh(force: true)),
                ),
                const SizedBox(height: 14),
                if (overview.enabledCount == 0)
                  UsageEmptyState(onEnable: _enable)
                else ...[
                  _cards(overview),
                  if (overview.hasAnyData) ...[
                    const SizedBox(height: 12),
                    _PanelPair(
                      intensity: DailyIntensityGrid(
                        days: recentDays(overview.days, _kGridDayCount),
                        busiest: overview.bestDay,
                      ),
                      mix: TokenMixBar(totals: overview.totals),
                    ),
                  ],
                ],
              ],
            ),
          ),
          const SizedBox(height: 18),
          _ProvidersHeading(overview: overview),
          const SizedBox(height: 10),
          for (final ledger in overview.providers) ...[
            ProviderUsageRow(
              ledger: ledger,
              state:
                  states[ledger.provider] ??
                  LedgerScanState(provider: ledger.provider),
              grandTotal: overview.totals.total,
              onToggle: (enabled) => _toggle(ledger.provider, enabled),
            ),
            const SizedBox(height: 8),
          ],
        ],
      ],
    );
  }

  Widget _cards(UsageOverview overview) {
    final cards = [
      UsageStatCard(
        label: 'Total tokens',
        value: formatTokens(overview.totals.total),
        icon: LucideIcons.sparkles300,
      ),
      UsageStatCard(
        label: 'Est. cost',
        value: formatCost(overview.costUsd),
        icon: LucideIcons.coins300,
      ),
      UsageStatCard(
        label: 'Active days',
        value: '${overview.activeDays}',
        icon: LucideIcons.calendarDays300,
      ),
      UsageStatCard(
        label: 'Cache share',
        value: overview.cacheShare == null
            ? 'n/a'
            : '${(overview.cacheShare! * 100).round()}%',
        icon: LucideIcons.database300,
      ),
    ];
    return LayoutBuilder(
      builder: (context, constraints) {
        // All four across where there is room, as Orca lays them out — the four
        // headline figures are read together, and stacking them into two rows
        // makes the pair below look like a continuation of the same list.
        final columns = constraints.maxWidth < 380
            ? 1
            : constraints.maxWidth < 680
            ? 2
            : 4;
        final width = (constraints.maxWidth - (columns - 1) * 10) / columns;
        return Wrap(
          spacing: 10,
          runSpacing: 10,
          children: [
            for (final card in cards) SizedBox(width: width, child: card),
          ],
        );
      },
    );
  }

  void _enable(LedgerProvider provider) =>
      unawaited(_controller.storeFor(provider).setEnabled(true));

  void _toggle(LedgerProvider provider, bool enabled) =>
      unawaited(_controller.storeFor(provider).setEnabled(enabled));
}

/// The recessed frame the whole overview sits in.
///
/// A recess rather than a raised card, because the panels INSIDE it are raised:
/// two lifted surfaces stacked on each other read as one flat slab, and the
/// point of the frame is that those two belong to this heading.
class _OverviewCard extends StatelessWidget {
  const _OverviewCard({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 13, 14, 15),
      decoration: BoxDecoration(
        color: AppSurface.recess,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppPalette.divider),
      ),
      child: child,
    );
  }
}

/// The heatmap and the token mix, side by side where there is room.
///
/// The grid takes the wider share: it holds six weeks of cells and goes
/// unreadable first as the column narrows, while the mix is three rows of text
/// that survive almost any width. Below the breakpoint they stack, because two
/// half-width columns of this content are worse than one of each.
class _PanelPair extends StatelessWidget {
  const _PanelPair({required this.intensity, required this.mix});

  final Widget intensity;
  final Widget mix;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      if (constraints.maxWidth < 680) {
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [intensity, const SizedBox(height: 12), mix],
        );
      }
      return Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(flex: 12, child: intensity),
          const SizedBox(width: 12),
          Expanded(flex: 8, child: mix),
        ],
      );
    },
  );
}

/// The "Usage analytics" caption and the lens picker beside it.
class _AnalyticsHeader extends StatelessWidget {
  const _AnalyticsHeader({required this.lens, required this.onLensChanged});

  final _Lens lens;
  final ValueChanged<_Lens> onLensChanged;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Row(
      children: [
        Expanded(
          child: Text(
            'Usage analytics',
            style: Theme.of(context).textTheme.titleSmall,
          ),
        ),
        AppSelectField<_Lens>(
          value: lens,
          width: 168,
          options: [
            const SelectOption<_Lens>(value: null, label: 'Overview'),
            for (final provider in LedgerProvider.values)
              SelectOption<_Lens>(value: provider, label: provider.label),
          ],
          onChanged: onLensChanged,
        ),
      ],
    );
  }
}

class _OverviewHeader extends StatelessWidget {
  const _OverviewHeader({
    required this.overview,
    required this.range,
    required this.isScanning,
    required this.onRangeChanged,
    required this.onRefresh,
  });

  final UsageOverview overview;
  final UsageRange range;
  final ValueChanged<UsageRange> onRangeChanged;
  final bool isScanning;

  /// Null when no provider is on — a refresh with nothing to read is a control
  /// that does nothing, and one that stays visible and dead says why better than
  /// one that vanishes.
  final VoidCallback? onRefresh;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Usage overview',
                style: Theme.of(context).textTheme.titleSmall,
              ),
              const SizedBox(height: 2),
              Text(
                _updatedLine(),
                style: TextStyle(
                  fontSize: 11.5,
                  color: AppPalette.textSecondary,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(width: 12),
        // The same control a provider's pane carries, so the two ranges are
        // plainly the same kind of thing rather than one screen having a window
        // and the other a hidden constant.
        AppSelectField<UsageRange>(
          value: range,
          width: 150,
          options: [
            for (final option in UsageRange.values)
              SelectOption(value: option, label: option.label),
          ],
          onChanged: onRangeChanged,
        ),
        const SizedBox(width: 4),
        IconButton(
          onPressed: isScanning ? null : onRefresh,
          iconSize: 15,
          visualDensity: VisualDensity.compact,
          tooltip: 'Rescan the local logs',
          icon: Icon(
            LucideIcons.refreshCw300,
            color: onRefresh == null
                ? AppPalette.textFaint
                : AppPalette.textSecondary,
          ),
        ),
      ],
    );
  }

  String _updatedLine() {
    if (overview.enabledCount == 0) return 'Nothing is being read yet.';
    final at = overview.lastScanAt;
    if (at == null) return 'Not scanned yet.';
    return '${range.label} · updated ${_stamp(at)}';
  }

  /// `9/8/2026, 5:32 PM` — the date as well as the clock, because a snapshot
  /// restored from disk can be days old and a bare `17:32` would read as today.
  static String _stamp(DateTime at) {
    final hour12 = at.hour % 12 == 0 ? 12 : at.hour % 12;
    final minute = at.minute.toString().padLeft(2, '0');
    return '${at.month}/${at.day}/${at.year}, '
        '$hour12:$minute ${at.hour < 12 ? 'AM' : 'PM'}';
  }
}

class _ProvidersHeading extends StatelessWidget {
  const _ProvidersHeading({required this.overview});

  final UsageOverview overview;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Providers', style: Theme.of(context).textTheme.titleSmall),
              const SizedBox(height: 2),
              Text(
                // Two different counts on purpose: a provider can be on and have
                // nothing to show, and collapsing the two is what makes an empty
                // panel impossible to read.
                '${overview.enabledCount} enabled · '
                '${overview.dataProviderCount} with data',
                style: TextStyle(
                  fontSize: 11.5,
                  color: AppPalette.textSecondary,
                ),
              ),
            ],
          ),
        ),
        Text(
          '${overview.sessionCount} '
          '${overview.sessionCount == 1 ? 'session' : 'sessions'}',
          style: TextStyle(fontSize: 11.5, color: AppPalette.textFaint),
        ),
      ],
    );
  }
}
