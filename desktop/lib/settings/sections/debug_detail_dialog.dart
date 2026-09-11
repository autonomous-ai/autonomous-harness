import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../logging/log_file.dart';
import '../../logging/log_stream.dart';
import '../../shared/theme/app_theme.dart';
import '../../shared/widgets/app_dialog.dart';
import 'debug_log_tile.dart';

/// Everything the one-line row leaves out: the whole message, the error, a CLI
/// command's transcript, and the stack trace behind a crash.
///
/// A dialog rather than an expanding row, for the reason Grid's
/// `command_detail_dialog` gives: the list has to stay scannable, and one line
/// is exactly what cannot hold the two things a failure is usually about.
Future<void> showDebugDetailDialog(BuildContext context, LogEntry entry) {
  return showAppDialog<void>(
    context: context,
    builder: (context) => _DebugDetailDialog(entry: entry),
  );
}

class _DebugDetailDialog extends StatelessWidget {
  const _DebugDetailDialog({required this.entry});

  final LogEntry entry;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Dialog(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 720),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 16, 18, 10),
              child: Row(
                children: [
                  DebugStatusIcon(status: entry.status),
                  const SizedBox(width: 9),
                  Expanded(
                    child: Text(
                      '${entry.category} · ${debugEntryOutcome(entry)}',
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
                    _Block(text: entry.message),
                    if (entry.error != null) ...[
                      const SizedBox(height: 10),
                      _Caption('Error'),
                      _Block(text: entry.error!, danger: true),
                    ],
                    if (entry.command?.output.isNotEmpty ?? false) ...[
                      const SizedBox(height: 10),
                      _Caption(
                        entry.command!.clipped ? 'Output (clipped)' : 'Output',
                      ),
                      _Block(text: entry.command!.output.join('\n')),
                    ],
                    if (entry.stackTrace != null) ...[
                      const SizedBox(height: 10),
                      _Caption('Stack trace'),
                      _Block(text: entry.stackTrace!),
                    ],
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
                    onPressed: () => Clipboard.setData(
                      ClipboardData(text: debugEntryAsText(entry)),
                    ),
                    child: const Text('Copy'),
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
        ),
      ),
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

/// One selectable mono block, recessed against the dialog.
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
        // AppCard.inset, not the page's recess: this sits on a dialog. See
        // `labeled_field.dart` for why the two are not interchangeable.
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

/// One entry as the text the Copy button hands over — the shape the log file
/// holds it in, so a line pasted into a bug report matches the line somebody
/// will later grep for.
String debugEntryAsText(LogEntry entry) {
  final buffer = StringBuffer(
    '[${logStamp(entry.at)}] ${entry.level.name.toUpperCase()} '
    '${entry.category} ${entry.message}',
  );
  final command = entry.command;
  if (command != null && !command.running) {
    buffer.write(
      ' → ${command.failed ? 'FAILED' : 'ok'}'
      '${command.exitCode == null ? '' : ' exit=${command.exitCode}'}'
      '${command.duration == null ? '' : ' (${debugDuration(command.duration!)})'}',
    );
  }
  if (entry.error != null) buffer.write('\n  err=${entry.error}');
  if (command != null && command.output.isNotEmpty) {
    buffer.write('\n${command.output.join('\n')}');
    if (command.clipped) buffer.write('\n… output clipped');
  }
  if (entry.stackTrace != null) buffer.write('\n${entry.stackTrace}');
  return buffer.toString();
}
