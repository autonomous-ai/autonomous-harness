import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../analytics/analytics_log.dart';
import '../../logging/log_file.dart';
import '../../shared/theme/app_theme.dart';
import '../../shared/widgets/app_dialog.dart';
import 'debug_log_tile.dart';
import 'tracking_tile.dart';

/// The exact JSON one tracked event put on the wire, opened by clicking its row.
///
/// The row shows what the *call site* passed; this shows what actually left the
/// app — context, identity and params merged, in the envelope the server reads.
/// That difference is the whole reason this dialog exists: a field the call site
/// set and the payload doesn't carry is a bug you cannot see from the list.
Future<void> showTrackingDetailDialog(
  BuildContext context,
  AnalyticsLogEntry entry,
) {
  return showAppDialog<void>(
    context: context,
    builder: (context) => _TrackingDetailDialog(entry: entry),
  );
}

class _TrackingDetailDialog extends StatelessWidget {
  const _TrackingDetailDialog({required this.entry});

  final AnalyticsLogEntry entry;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Dialog(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 720),
        // The entry mutates in place as the queue retries and settles it, so a
        // panel built once would keep saying "Waiting" long after it landed.
        child: ListenableBuilder(
          listenable: analyticsLog,
          builder: (context, _) => _Body(entry: entry),
        ),
      ),
    );
  }
}

class _Body extends StatelessWidget {
  const _Body({required this.entry});

  final AnalyticsLogEntry entry;

  @override
  Widget build(BuildContext context) {
    final payload = entry.payload;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(18, 16, 18, 10),
          child: Row(
            children: [
              TrackingStatusIcon(status: entry.status),
              const SizedBox(width: 9),
              Expanded(
                child: Text(
                  '${entry.name} · ${trackedOutcome(entry)}',
                  style: TextStyle(
                    color: AppPalette.textSecondary,
                    fontSize: 12.5,
                    fontFamily: AppFont.mono,
                    fontFamilyFallback: AppFont.monoFallback,
                  ),
                ),
              ),
            ],
          ),
        ),
        Flexible(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(18, 0, 18, 16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _Caption('Outcome'),
                _Block(
                  text: [
                    trackedStatusLabel(entry.status),
                    ?entry.note,
                  ].join(' — '),
                  danger: entry.status == AnalyticsEventStatus.refused,
                ),
                const SizedBox(height: 10),
                _Caption('Tracked'),
                _Block(text: logStamp(entry.queuedAt)),
                const SizedBox(height: 10),
                // What the call site passed, kept apart from the payload: the
                // gap between the two is the bug this dialog is opened to find.
                _Caption('Params the call site passed'),
                _Block(
                  text: entry.params.isEmpty
                      ? 'none'
                      : trackedParamsSummary(entry.params),
                ),
                const SizedBox(height: 10),
                _Caption(payload == null ? 'Payload' : 'Payload as sent'),
                _Block(
                  text:
                      payload ??
                      'Nothing has gone over the wire for this event yet.',
                ),
              ],
            ),
          ),
        ),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.fromLTRB(18, 10, 18, 10),
          decoration: BoxDecoration(
            border: Border(top: BorderSide(color: AppGlass.hair)),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              TextButton(
                // The payload alone, not the panel: what gets pasted into a
                // backend thread is the body the server was handed.
                onPressed: payload == null
                    ? null
                    : () => Clipboard.setData(ClipboardData(text: payload)),
                child: const Text('Copy payload'),
              ),
              const SizedBox(width: 4),
              TextButton(
                onPressed: () => Navigator.of(context).pop(),
                child: const Text('Close'),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// A caption over one block of the panel.
class _Caption extends StatelessWidget {
  const _Caption(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 5),
      child: Text(
        text,
        style: TextStyle(
          fontSize: 11.5,
          fontWeight: AppFont.medium,
          color: AppPalette.textFaint,
        ),
      ),
    );
  }
}

/// One selectable mono block, recessed against the dialog. The same block
/// `debug_detail_dialog.dart` draws — the two panels are read the same way.
class _Block extends StatelessWidget {
  const _Block({required this.text, this.danger = false});

  final String text;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: AppCard.inset,
        borderRadius: BorderRadius.circular(AppCard.insetRadius),
      ),
      child: SelectableText(
        text,
        style: TextStyle(
          fontSize: 12,
          height: 1.45,
          fontFamily: AppFont.mono,
          fontFamilyFallback: AppFont.monoFallback,
          color: danger ? debugDangerInk(context) : AppPalette.textPrimary,
        ),
      ),
    );
  }
}
