import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../analytics/analytics_log.dart';
import '../../analytics/analytics_sink.dart';
import '../../shared/theme/app_theme.dart';
import '../../shared/widgets/empty_state.dart';
import '../../shared/widgets/section_scaffold.dart';
import '../../shared/widgets/toolbar_pill.dart';
import 'debug_filter_bar.dart';
import 'debug_toolbar.dart';
import 'tracking_stream_card.dart';
import 'tracking_tile.dart';

/// The lens the list is filtered to. Waiting and Failed are separate: an event
/// still queued is the network's problem, a refused one is ours.
enum _EventFilter { all, sent, waiting, failed }

extension on _EventFilter {
  String get label => switch (this) {
    _EventFilter.all => 'All',
    _EventFilter.sent => 'Sent',
    _EventFilter.waiting => 'Waiting',
    _EventFilter.failed => 'Failed',
  };

  bool matches(AnalyticsLogEntry entry) => switch (this) {
    _EventFilter.all => true,
    _EventFilter.sent => entry.status == AnalyticsEventStatus.sent,
    _EventFilter.waiting => entry.status == AnalyticsEventStatus.queued,
    _EventFilter.failed =>
      entry.status == AnalyticsEventStatus.refused ||
          entry.status == AnalyticsEventStatus.dropped,
  };
}

/// Settings ▸ Tracking — every analytics event this app reports, newest first,
/// with the exact JSON behind each one.
///
/// Ported from Grid's Tracking tab
/// (`features/debug/presentation/tracking_view.dart`). Settings ▸ Debug beside
/// it answers "what did this app ask the CLI and the grid for"; this answers the
/// question analytics always raises and normally cannot: *did that event
/// actually leave, and what was in it?* Without it, an event that was never
/// sent, sent with a missing field, or refused by the server looks exactly like
/// an event that landed — the app is silent either way, by design.
///
/// Only reachable where [kDebugSurfaceEnabled] is — see `settings_section.dart`
/// — and only fed there either, since the buffer behind it is memory a shipped
/// session should not spend.
class TrackingSection extends StatefulWidget {
  const TrackingSection({super.key, this.log, this.probe});

  /// The buffer to show. Defaults to the app's own; a test passes its own.
  final AnalyticsLogStream? log;

  /// How the header card resolves the stream — injected in tests, which must
  /// not read a real `~/.harness`.
  final AnalyticsStreamStatus Function()? probe;

  @override
  State<TrackingSection> createState() => _TrackingSectionState();
}

class _TrackingSectionState extends State<TrackingSection> {
  _EventFilter _filter = _EventFilter.all;

  AnalyticsLogStream get _log => widget.log ?? analyticsLog;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return SectionScaffold(
      title: 'Tracking',
      subtitle:
          'Every analytics event this app reports, and where it goes. Held in '
          'memory for this session only — nothing here is written to disk.',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Outside the builder below: where the stream points has nothing to
          // do with what it has carried, and a card that re-read on every event
          // would be a second thing on the screen moving.
          TrackingStreamCard(probe: widget.probe ?? probeAnalyticsStatus),
          const SizedBox(height: 14),
          Expanded(
            child: ListenableBuilder(
              listenable: _log,
              builder: (context, _) {
                final entries = _log.entries;
                final visible = [
                  for (final entry in entries)
                    if (_filter.matches(entry)) entry,
                ];
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _Toolbar(total: entries.length, onClear: _log.clear),
                    const SizedBox(height: 10),
                    DebugFilterBar(
                      lenses: [
                        for (final filter in _EventFilter.values)
                          DebugLens(
                            label: filter.label,
                            count: entries.where(filter.matches).length,
                            selected: filter == _filter,
                            onTap: () => setState(() => _filter = filter),
                            danger: filter == _EventFilter.failed,
                            hideWhenEmpty: filter == _EventFilter.failed,
                          ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    Expanded(child: _list(entries.isEmpty, visible)),
                  ],
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget _list(bool nothingTracked, List<AnalyticsLogEntry> visible) {
    if (visible.isNotEmpty) {
      return ListView.separated(
        itemCount: visible.length,
        separatorBuilder: (_, _) => const SizedBox(height: 6),
        itemBuilder: (context, i) => TrackingTile(entry: visible[i]),
      );
    }
    // Nothing tracked yet and "the filter hid it all" are two different
    // stories, so the lenses stay above and the user has a way back out.
    if (nothingTracked) {
      return const EmptyState(
        icon: LucideIcons.activity300,
        title: 'No events yet',
        message:
            'Move around the app — opening a screen or creating an agent '
            'reports an event, and each one shows up here with what it sent.',
      );
    }
    return const EmptyState.noMatches(message: 'No event matches this filter.');
  }
}

/// The strip above the list: how much is held, and the one thing you can do
/// with it.
///
/// No "Open logs" beside Clear, unlike [DebugToolbar]: this buffer has no file
/// behind it, and a button pointing at `~/.harness/logs` would promise a
/// durable copy of these events that does not exist.
class _Toolbar extends StatelessWidget {
  const _Toolbar({required this.total, required this.onClear});

  /// Everything captured this session, not the filtered view — this is the
  /// buffer's fill level, not the list's length.
  final int total;

  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Row(
      children: [
        Expanded(
          child: Text(
            '$total ${total == 1 ? 'event' : 'events'}',
            style: TextStyle(fontSize: 12.5, color: AppPalette.textSecondary),
          ),
        ),
        ToolbarPill(
          // Visible and dead when there is nothing to clear, rather than gone:
          // a control that disappears takes its own explanation with it.
          onTap: total == 0 ? null : onClear,
          rimmed: true,
          child: DebugPillLabel(
            icon: LucideIcons.trash2,
            label: 'Clear',
            enabled: total != 0,
          ),
        ),
      ],
    );
  }
}
