import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../logging/log_file.dart';
import '../../logging/log_stream.dart';
import '../../shared/theme/app_theme.dart';
import 'debug_detail_dialog.dart';

/// One entry in the Debug list: what happened, how it ended, and — on a click —
/// everything the line could not hold.
///
/// Ported from Grid's `LogTile`. The message is plain text rather than
/// selectable, for the reason Grid's comment gives: a `SelectableText` eats the
/// tap that opens the row, and the line it lets you copy is the truncated one.
/// Selecting and copying live in the dialog, where the whole transcript is.
class DebugLogTile extends StatefulWidget {
  const DebugLogTile({super.key, required this.entry});

  final LogEntry entry;

  @override
  State<DebugLogTile> createState() => _DebugLogTileState();
}

class _DebugLogTileState extends State<DebugLogTile> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context); // a list item — must self-watch to follow flips.
    final entry = widget.entry;
    return Semantics(
      button: true,
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        onEnter: (_) => setState(() => _hovered = true),
        onExit: (_) => setState(() => _hovered = false),
        child: GestureDetector(
          onTap: () => showDebugDetailDialog(context, entry),
          child: DecoratedBox(
            decoration: BoxDecoration(
              // The page's own quiet card, not `AppCard.inset`: these rows sit
              // on the settings pane, where the inset lands within a hair of
              // white and the tile disappears (the same trap `labeled_field`
              // documents for a field). A raised block per row would be worse
              // still — five hundred shadows for a list you scan.
              color: _hovered ? AppPalette.cardBgHover : AppPalette.cardBg,
              borderRadius: BorderRadius.circular(AppCard.insetRadius),
            ),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 9, 10, 9),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      DebugStatusIcon(status: entry.status),
                      const SizedBox(width: 9),
                      Expanded(
                        child: Text(
                          entry.message,
                          maxLines: 3,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 12.5,
                            height: 1.35,
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
                  if (entry.error != null) ...[
                    const SizedBox(height: 5),
                    Padding(
                      padding: const EdgeInsets.only(left: 25, right: 28),
                      child: Text(
                        entry.error!,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 12,
                          height: 1.35,
                          fontFamily: AppFont.mono,
                          fontFamilyFallback: AppFont.monoFallback,
                          color: debugDangerInk(context),
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

/// Running / ok / failed / warned / plain event, as one glyph. Shared with the
/// detail dialog so a row and the panel it opens cannot disagree.
class DebugStatusIcon extends StatelessWidget {
  const DebugStatusIcon({super.key, required this.status});

  final LogStatus status;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return switch (status) {
      LogStatus.running => SizedBox(
        width: 15,
        height: 15,
        child: Padding(
          padding: const EdgeInsets.all(1.5),
          child: CircularProgressIndicator(
            strokeWidth: 1.6,
            color: AppPalette.textFaint,
          ),
        ),
      ),
      LogStatus.ok => Icon(
        LucideIcons.circleCheck,
        size: 15,
        color: AppPalette.online,
      ),
      LogStatus.failed => Icon(
        LucideIcons.circleAlert,
        size: 15,
        color: debugDangerInk(context),
      ),
      LogStatus.warned => Icon(
        LucideIcons.triangleAlert,
        size: 15,
        color: AppPalette.warn,
      ),
      // An ordinary line the app chose to write. A dot, not a tick: it did not
      // succeed at anything, it happened.
      LogStatus.event => Icon(
        LucideIcons.dot,
        size: 15,
        color: AppPalette.textFaint,
      ),
    };
  }
}

/// The category, the clock time, and how it ended — the trailing column.
class _Meta extends StatelessWidget {
  const _Meta({required this.entry});

  final LogEntry entry;

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
        Text(entry.category, style: style),
        const SizedBox(height: 2),
        Text(debugEntryOutcome(entry), style: style),
      ],
    );
  }
}

/// `12:04:33 · 118ms · exit 0` — the clock, and whatever the entry knows about
/// how it ended.
String debugEntryOutcome(LogEntry entry) {
  final time = logClock(entry.at);
  final command = entry.command;
  if (command == null) return time;
  if (command.running) return '$time · running…';
  final took = command.duration == null
      ? ''
      : ' · ${debugDuration(command.duration!)}';
  final code = command.exitCode == null ? '' : ' · exit ${command.exitCode}';
  return '$time$took$code';
}

/// A command's duration at the resolution it actually has: most CLI calls here
/// finish in tens of milliseconds, and [logDuration]'s seconds print every one
/// of them as `0s`.
String debugDuration(Duration duration) => duration.inMilliseconds < 1000
    ? '${duration.inMilliseconds}ms'
    : logDuration(duration);

/// The danger *ink*, which is not `colorScheme.error` in dark.
///
/// The same value and the same reason as `AppIconButton`'s: a red tuned as a
/// fill is too dark to read as text on a dark surface.
Color debugDangerInk(BuildContext context) =>
    AppTheme.pick(Theme.of(context).colorScheme.error, const Color(0xFFFF8A80));
