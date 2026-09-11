import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../core/reveal_folder.dart';
import '../../logging/log_file.dart';
import '../../shared/theme/app_theme.dart';
import '../../shared/widgets/toolbar_pill.dart';

/// The strip above the Debug list: how much is held, and the two things you can
/// do with it — read the durable copy on disk, or drop what is in memory.
class DebugToolbar extends StatelessWidget {
  const DebugToolbar({super.key, required this.total, required this.onClear});

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
            '$total ${total == 1 ? 'entry' : 'entries'}',
            style: TextStyle(fontSize: 12.5, color: AppPalette.textSecondary),
          ),
        ),
        const _OpenLogsPill(),
        const SizedBox(width: 6),
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

/// Opens `~/.harness/logs` in the file manager.
///
/// The list is this session's, held in memory — the files on disk are what
/// survive a crash and what can be attached to a bug report. Without this a
/// user would have to be told a hidden path to type into Finder.
class _OpenLogsPill extends StatelessWidget {
  const _OpenLogsPill();

  Future<void> _open(BuildContext context) async {
    final messenger = ScaffoldMessenger.of(context);
    final directory = DailyLogFile.defaultDirectory.path;
    if (await revealFolder(directory)) return;
    // Nothing has been written on a fresh install, so the folder is simply not
    // there yet — which is worth saying, since "open" that does nothing reads
    // as a broken button.
    messenger.showSnackBar(
      SnackBar(content: Text('No logs to open yet — $directory')),
    );
  }

  @override
  Widget build(BuildContext context) {
    return ToolbarPill(
      onTap: () => unawaited(_open(context)),
      rimmed: true,
      child: const DebugPillLabel(
        icon: LucideIcons.folderOpen,
        label: 'Open logs',
        enabled: true,
      ),
    );
  }
}

/// A glyph and a word inside a [ToolbarPill], with the ink the pill's own state
/// calls for — shared so the two actions cannot drift apart.
class DebugPillLabel extends StatelessWidget {
  const DebugPillLabel({
    super.key,
    required this.icon,
    required this.label,
    required this.enabled,
  });

  final IconData icon;
  final String label;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final ink = ToolbarPill.tint(tinted: false, enabled: enabled);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 13, color: ink),
        const SizedBox(width: 6),
        Text(
          label,
          style: TextStyle(
            fontSize: 13,
            fontWeight: AppFont.medium,
            color: ink,
          ),
        ),
      ],
    );
  }
}
