/// One provider's detail pane: eight figures, a range filter, and three panels.
///
/// Ported from Orca's `ClaudeUsagePane` / `CodexUsagePane` / `OpenCodeUsagePane`,
/// which are three near-identical files. One here, parameterised by provider —
/// the differences between them are all in the data layer (`usage_report.dart`),
/// and three copies of this layout would be three places to fix a spacing bug.
///
/// ⚠️ **The filter menu offers a RANGE and no scope**, unlike Orca's. See
/// `usage_report.dart` for why a "Harness only" lens over this computer's logs
/// would filter on a distinction this app does not have.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../shared/theme/app_theme.dart';
import '../../shared/widgets/app_select_field.dart';
import '../../usage/ledger/ledger_types.dart';
import '../../usage/ledger/usage_ledger_store.dart';
import '../../usage/ledger/usage_overview.dart';
import '../../usage/ledger/usage_report.dart';
import 'usage_detail_panels.dart';
import 'usage_panels.dart';

class UsageProviderPane extends StatefulWidget {
  const UsageProviderPane({super.key, required this.store});

  final UsageLedgerStore store;

  @override
  State<UsageProviderPane> createState() => _UsageProviderPaneState();
}

class _UsageProviderPaneState extends State<UsageProviderPane> {
  /// Held per pane rather than persisted: a range is what you are looking at
  /// right now, not a setting. Orca keeps it in its store; here it would be a
  /// third thing in `state.json` that decides what a screen says on open.
  UsageRange _range = UsageRange.d30;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final store = widget.store;
    final state = store.state;
    final provider = store.provider;

    if (!state.enabled) {
      return _DisabledCard(
        provider: provider,
        onEnable: () => unawaited(store.setEnabled(true)),
      );
    }

    final entries = entriesInRange(store.ledger, _range);
    final report = summarize(provider, _range, entries);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Header(
          provider: provider,
          state: state,
          range: _range,
          onRangeChanged: (range) => setState(() => _range = range),
          onRefresh: () => unawaited(store.refresh(force: true)),
          onDisable: () => unawaited(store.setEnabled(false)),
        ),
        const SizedBox(height: 12),
        if (state.status == LedgerStatus.unavailable ||
            state.status == LedgerStatus.failed)
          _Notice(message: state.message ?? 'No figures.')
        else if (!report.hasData)
          _Notice(message: 'No ${provider.label} usage in this range.')
        else ...[
          _Figures(report: report),
          const SizedBox(height: 8),
          Text(
            'Cache reuse rate is cache read tokens / (fresh input + cache read '
            'tokens).',
            style: TextStyle(fontSize: 11, color: AppPalette.textFaint),
          ),
          const SizedBox(height: 12),
          UsageDailyChart(
            days: dailyTotals(
              ProviderLedger(provider: provider, entries: entries),
            ),
          ),
          const SizedBox(height: 12),
          UsageBreakdownCard(
            title: 'By model',
            subtitle: 'Where the tokens went, heaviest first.',
            rows: breakdownByModel(provider, entries),
          ),
          const SizedBox(height: 12),
          UsageBreakdownCard(
            title: 'By project',
            subtitle: 'Grouped by the folder each session ran in.',
            rows: breakdownByProject(provider, entries),
          ),
          const SizedBox(height: 12),
          UsageSessionsTable(rows: recentSessions(provider, entries)),
        ],
      ],
    );
  }
}

/// The eight figures, in the order Orca prints them.
class _Figures extends StatelessWidget {
  const _Figures({required this.report});

  final UsageReport report;

  @override
  Widget build(BuildContext context) {
    final totals = report.totals;
    final cards = <Widget>[
      UsageStatCard(
        label: 'Fresh input',
        value: formatTokens(totals.freshInput),
        icon: LucideIcons.sparkles300,
      ),
      UsageStatCard(
        label: 'Output',
        value: formatTokens(totals.output),
        icon: LucideIcons.activity300,
      ),
      UsageStatCard(
        label: 'Cache read',
        value: formatTokens(totals.cacheRead),
        icon: LucideIcons.database300,
      ),
      UsageStatCard(
        label: 'Cache write',
        value: formatTokens(totals.cacheWrite),
        icon: LucideIcons.waypoints300,
      ),
      UsageStatCard(
        label: 'Cache reuse rate',
        value: _percent(report.cacheReuseRate),
        icon: LucideIcons.gauge300,
      ),
      UsageStatCard(
        label: 'Cold turns',
        value: _percent(report.zeroCacheReadShare),
        icon: LucideIcons.snowflake300,
        footnote: 'read nothing from cache',
      ),
      UsageStatCard(
        label: 'Sessions / turns',
        value: '${report.sessions} / ${report.turns}',
        icon: LucideIcons.folderKanban300,
      ),
      UsageStatCard(
        label: 'Est. cost',
        value: formatCost(report.costUsd),
        icon: LucideIcons.coins300,
      ),
    ];

    return LayoutBuilder(
      builder: (context, constraints) {
        final columns = constraints.maxWidth < 420 ? 2 : 4;
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

  static String _percent(double? value) =>
      value == null ? 'n/a' : '${(value * 100).round()}%';
}

class _Header extends StatelessWidget {
  const _Header({
    required this.provider,
    required this.state,
    required this.range,
    required this.onRangeChanged,
    required this.onRefresh,
    required this.onDisable,
  });

  final LedgerProvider provider;
  final LedgerScanState state;
  final UsageRange range;
  final ValueChanged<UsageRange> onRangeChanged;
  final VoidCallback onRefresh;
  final VoidCallback onDisable;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final scanning = state.status == LedgerStatus.scanning;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '${provider.label} usage',
                style: Theme.of(context).textTheme.titleSmall,
              ),
              const SizedBox(height: 2),
              Text(
                // The range is named here as well as in the picker, because the
                // figures below mean nothing without it and the picker is a
                // control the eye skips.
                'All local ${provider.label} usage · ${range.label}',
                style: TextStyle(
                  fontSize: 11.5,
                  color: AppPalette.textSecondary,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(width: 12),
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
          onPressed: scanning ? null : onRefresh,
          iconSize: 15,
          visualDensity: VisualDensity.compact,
          tooltip: 'Rescan the local logs',
          icon: Icon(LucideIcons.refreshCw300, color: AppPalette.textSecondary),
        ),
        IconButton(
          onPressed: onDisable,
          iconSize: 15,
          visualDensity: VisualDensity.compact,
          tooltip: 'Stop reading ${provider.label}',
          icon: Icon(LucideIcons.power300, color: AppPalette.textSecondary),
        ),
      ],
    );
  }
}

/// The card a switched-off provider shows in its own tab.
class _DisabledCard extends StatelessWidget {
  const _DisabledCard({required this.provider, required this.onEnable});

  final LedgerProvider provider;
  final VoidCallback onEnable;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
      decoration: BoxDecoration(
        color: AppGlass.surfaceFill,
        borderRadius: BorderRadius.circular(14),
        boxShadow: AppGlass.cardShadow,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '${provider.label} usage',
            style: Theme.of(context).textTheme.titleSmall,
          ),
          const SizedBox(height: 6),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: Text(
              'Reads the logs the ${provider.label} CLI already keeps on this '
              'computer to show token, model and session figures. Nothing is '
              'read until you switch it on.',
              style: TextStyle(
                fontSize: 12.5,
                height: 1.45,
                color: AppPalette.textSecondary,
              ),
            ),
          ),
          const SizedBox(height: 14),
          FilledButton(
            onPressed: onEnable,
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
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 16),
      decoration: BoxDecoration(
        color: AppSurface.recess,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        message,
        style: TextStyle(fontSize: 12.5, color: AppPalette.textSecondary),
      ),
    );
  }
}
