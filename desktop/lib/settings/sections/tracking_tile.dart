import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../analytics/analytics_log.dart';
import '../../logging/log_file.dart';
import '../../shared/theme/app_theme.dart';
import 'debug_log_tile.dart';
import 'tracking_detail_dialog.dart';

/// One tracked event in the Tracking list: what was tracked, how it ended, and
/// — on a click — the exact JSON it put on the wire.
///
/// Built to [DebugLogTile]'s shape rather than to Grid's `TrackingTile`: these
/// two lists sit one rail row apart, and a second card style for the second one
/// would read as two apps. Plain text rather than selectable, for the reason
/// that tile gives — a `SelectableText` eats the tap that opens the row, and
/// what it would let you copy is the summary, not the payload.
class TrackingTile extends StatefulWidget {
  const TrackingTile({super.key, required this.entry});

  final AnalyticsLogEntry entry;

  @override
  State<TrackingTile> createState() => _TrackingTileState();
}

class _TrackingTileState extends State<TrackingTile> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context); // a list item — must self-watch to follow flips.
    final entry = widget.entry;
    final summary = trackedSummaryLine(entry);
    final failed = entry.note != null && entry.note!.isNotEmpty;

    return Semantics(
      button: true,
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        onEnter: (_) => setState(() => _hovered = true),
        onExit: (_) => setState(() => _hovered = false),
        child: GestureDetector(
          onTap: () => showTrackingDetailDialog(context, entry),
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: _hovered ? AppPalette.cardBgHover : AppPalette.cardBg,
              borderRadius: BorderRadius.circular(AppCard.insetRadius),
            ),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 9, 10, 9),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      TrackingStatusIcon(status: entry.status),
                      const SizedBox(width: 9),
                      Expanded(
                        child: Text(
                          entry.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 12.5,
                            fontFamily: AppFont.mono,
                            fontFamilyFallback: AppFont.monoFallback,
                            color: AppPalette.textPrimary,
                          ),
                        ),
                      ),
                      const SizedBox(width: 10),
                      _Meta(entry: entry),
                      // Held open whether or not the cursor is here, so a row
                      // does not reflow the instant it is pointed at.
                      SizedBox(
                        width: 18,
                        child: _hovered
                            ? Icon(
                                LucideIcons.chevronRight,
                                size: 15,
                                color: AppPalette.textSecondary,
                              )
                            : null,
                      ),
                    ],
                  ),
                  if (summary.isNotEmpty) ...[
                    const SizedBox(height: 5),
                    Padding(
                      padding: const EdgeInsets.only(left: 24, right: 28),
                      child: Text(
                        summary,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 12,
                          height: 1.35,
                          fontFamily: AppFont.mono,
                          fontFamilyFallback: AppFont.monoFallback,
                          color: failed
                              ? debugDangerInk(context)
                              : AppPalette.textSecondary,
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Waiting / sent / refused / dropped, as one glyph. Shared with the detail
/// dialog so a row and the panel it opens cannot disagree.
class TrackingStatusIcon extends StatelessWidget {
  const TrackingStatusIcon({super.key, required this.status});

  final AnalyticsEventStatus status;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Icon(_glyph, size: 15, color: _ink(context));
  }

  IconData get _glyph => switch (status) {
    AnalyticsEventStatus.queued => LucideIcons.clock,
    AnalyticsEventStatus.sent => LucideIcons.circleCheck,
    AnalyticsEventStatus.refused => LucideIcons.circleAlert,
    // A slash, not an alert: nothing went wrong on the wire, the event simply
    // never reached it — a muted build, a full queue, a name we refused.
    AnalyticsEventStatus.dropped => LucideIcons.circleSlash,
  };

  Color _ink(BuildContext context) => switch (status) {
    AnalyticsEventStatus.queued => AppPalette.textFaint,
    AnalyticsEventStatus.sent => AppPalette.online,
    AnalyticsEventStatus.refused => debugDangerInk(context),
    // Warn, not danger: a dropped event is usually this build's own doing (no
    // key) rather than a fault, and red would cry wolf on every row.
    AnalyticsEventStatus.dropped => AppPalette.warn,
  };
}

/// The clock time and, once it has settled, how long it took.
class _Meta extends StatelessWidget {
  const _Meta({required this.entry});

  final AnalyticsLogEntry entry;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final style = TextStyle(
      fontSize: 11,
      fontFamily: AppFont.mono,
      fontFamilyFallback: AppFont.monoFallback,
      color: AppPalette.textFaint,
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Text(trackedStatusLabel(entry.status), style: style),
        const SizedBox(height: 2),
        Text(trackedOutcome(entry), style: style),
      ],
    );
  }
}

/// `12:04:33 · 118ms · 2 tries` — the clock, and whatever the entry knows about
/// how it ended. The attempt count appears only past one: a badge that is
/// always there stops being read, and a retry is the thing worth seeing.
String trackedOutcome(AnalyticsLogEntry entry) {
  final took = entry.took;
  return [
    logClock(entry.queuedAt),
    if (took != null) debugDuration(took),
    if (entry.attempts > 1) '${entry.attempts} tries',
  ].join(' · ');
}

/// The word for a status, as both the row and the detail panel say it.
String trackedStatusLabel(AnalyticsEventStatus status) => switch (status) {
  AnalyticsEventStatus.queued => 'Waiting',
  AnalyticsEventStatus.sent => 'Sent',
  AnalyticsEventStatus.refused => 'Refused',
  AnalyticsEventStatus.dropped => 'Dropped',
};

/// What the row says under the event name: why it failed if it did, else the
/// params it carried. The failure wins — a dropped event's params are not the
/// thing anyone opened this screen to read.
String trackedSummaryLine(AnalyticsLogEntry entry) {
  final note = entry.note;
  if (note != null && note.isNotEmpty) return note;
  return trackedParamsSummary(entry.params);
}

/// The params a call site passed, on one line:
/// `screen=settings_usage · source=rail`.
///
/// The row can only hold a line, and the line has to say *which* event this was
/// — `screen_view` on its own is thirty identical rows. The whole payload,
/// context and identity included, is a click away in the detail dialog.
String trackedParamsSummary(Map<String, Object?> params) =>
    params.entries.map((e) => '${e.key}=${e.value}').join(' · ');
