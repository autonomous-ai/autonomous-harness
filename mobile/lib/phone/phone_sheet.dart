import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

/// One action in a phone sheet.
class PhoneSheetAction {
  const PhoneSheetAction({
    required this.icon,
    required this.label,
    required this.onTap,
    this.destructive = false,
    this.value,
    this.valueColor,
    this.enabled = true,
  });

  final IconData icon;
  final String label;

  /// Run AFTER the sheet has closed — see [showPhoneSheet], which pops first and then calls this.
  /// A dialog opened from here would otherwise open behind the closing sheet.
  final VoidCallback onTap;

  final bool destructive;

  /// A quiet word at the end of the row — a machine's state, on a machine row.
  final String? value;

  /// The colour of [value]; the faint text colour when null.
  final Color? valueColor;

  /// False draws the row dimmed and leaves the sheet open on a tap: an offline machine is listed
  /// so its absence is not a mystery, not so it can be opened.
  final bool enabled;
}

/// A captioned run of rows in a phone sheet.
class PhoneSheetSection {
  PhoneSheetSection({
    required this.caption,
    required this.actions,
    this.maxVisible,
  });

  final String caption;
  final List<PhoneSheetAction> actions;

  /// Rows shown before an "N more" row that reveals the rest. Null shows everything.
  final int? maxVisible;

  bool _expanded = false;

  List<PhoneSheetAction> get visible {
    final max = maxVisible;
    if (_expanded || max == null || actions.length <= max) return actions;
    return actions.take(max).toList();
  }

  int get hiddenCount => actions.length - visible.length;

  void expand() => _expanded = true;
}

/// The `⋯` menu on a phone page: a title line and a column of actions.
///
/// The desktop reaches the same actions through a right-click menu, which a phone has no gesture
/// for. One sheet rather than a menu per page: the actions differ, the shape does not.
///
/// [sections] draws captioned groups after [actions]; an empty section is left out.
///
/// [titleDetail] is drawn under [titleParts] — the folder and branch, on an agent's sheet.
Future<void> showPhoneSheet(
  BuildContext context, {
  required String title,
  List<PhoneSheetAction> actions = const [],
  List<PhoneSheetSection> sections = const [],
  PhoneSheetAction? titleAction,
  List<String>? titleParts,
  Widget? titleDetail,
}) => showModalBottomSheet<void>(
  context: context,
  useRootNavigator: true,
  showDragHandle: true,
  backgroundColor: AppPalette.panelBg,
  builder: (sheetContext) => SafeArea(
    child: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: EdgeInsets.fromLTRB(20, 0, titleAction == null ? 20 : 8, 10),
          child: Row(
            children: [
              Expanded(
                child: titleParts == null
                    ? Text(
                        title,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: AppPalette.textSecondary,
                          fontSize: 13,
                        ),
                      )
                    : Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          _TitleParts(parts: titleParts),
                          if (titleDetail != null) ...[
                            const SizedBox(height: 3),
                            titleDetail,
                          ],
                        ],
                      ),
              ),
              // [titleAction]: an icon on the title line — for something that is not about the
              // subject of the sheet (Settings, on an agent's sheet), so it does not take a row
              // among the actions that are. Its label is the tooltip.
              if (titleAction != null)
                IconButton(
                  tooltip: titleAction.label,
                  icon: Icon(
                    titleAction.icon,
                    size: 20,
                    color: AppPalette.textSecondary,
                  ),
                  visualDensity: VisualDensity.compact,
                  onPressed: () {
                    Navigator.of(sheetContext).pop();
                    titleAction.onTap();
                  },
                ),
            ],
          ),
        ),
        // Scrolls once the rows outgrow the sheet — voice input's six languages do on a short phone —
        // and is laid out exactly like a plain column until then.
        Flexible(
          // Stateful only for [PhoneSheetSection.maxVisible]: "N more" opens the rest in place
          // rather than closing the sheet.
          child: StatefulBuilder(
            builder: (context, setSheetState) => ListView(
              shrinkWrap: true,
              padding: EdgeInsets.zero,
              children: [
                for (final action in actions)
                  _SheetRow(
                    action: action,
                    // Close first, then act: an action that opens a dialog or pushes a page must not
                    // do it underneath a sheet that is still animating out.
                    onTap: () {
                      Navigator.of(sheetContext).pop();
                      action.onTap();
                    },
                  ),
                for (final section in sections)
                  if (section.actions.isNotEmpty) ...[
                    Padding(
                      padding: const EdgeInsets.fromLTRB(20, 14, 20, 4),
                      child: Text(
                        section.caption.toUpperCase(),
                        style: TextStyle(
                          color: AppPalette.textFaint,
                          fontSize: 11.5,
                          fontWeight: FontWeight.w600,
                          letterSpacing: 0.6,
                        ),
                      ),
                    ),
                    for (final action in section.visible)
                      _SheetRow(
                        action: action,
                        onTap: () {
                          Navigator.of(sheetContext).pop();
                          action.onTap();
                        },
                      ),
                    if (section.hiddenCount > 0)
                      _SheetRow(
                        action: PhoneSheetAction(
                          icon: LucideIcons.ellipsis300,
                          label: '${section.hiddenCount} more',
                          onTap: () {},
                        ),
                        // Stays open: this row reveals, it does not act.
                        onTap: () => setSheetState(section.expand),
                      ),
                  ],
              ],
            ),
          ),
        ),
        const SizedBox(height: 8),
      ],
    ),
  ),
);

/// A title made of named parts — an agent, then its machine — one per line.
///
/// The first part reads as the title and the rest as quieter lines under it. A long name wraps, up to
/// two lines each, and only past that is it cut with `…` — so a pathological name cannot push the
/// actions off the sheet.
class _TitleParts extends StatelessWidget {
  const _TitleParts({required this.parts});

  final List<String> parts;

  @override
  Widget build(BuildContext context) => Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      for (var index = 0; index < parts.length; index++)
        Text(
          parts[index],
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: index == 0
              ? TextStyle(
                  color: AppPalette.textPrimary,
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                )
              : TextStyle(color: AppPalette.textSecondary, fontSize: 13),
        ),
    ],
  );
}

class _SheetRow extends StatelessWidget {
  const _SheetRow({required this.action, required this.onTap});

  final PhoneSheetAction action;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final color = !action.enabled
        ? AppPalette.textFaint
        : action.destructive
        ? AppPalette.dangerFill
        : AppPalette.textPrimary;
    final value = action.value;
    return InkWell(
      onTap: action.enabled ? onTap : null,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 13),
        child: Row(
          children: [
            Icon(action.icon, size: 20, color: color),
            const SizedBox(width: 14),
            Expanded(
              child: Text(
                action.label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: color,
                  fontSize: 16,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ),
            if (value != null) ...[
              const SizedBox(width: 12),
              Text(
                value,
                style: TextStyle(
                  color: action.valueColor ?? AppPalette.textFaint,
                  fontSize: 13,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// A yes/no question before something that cannot be undone — deleting an agent, unlinking a
/// machine. Returns true only if the destructive button was the one pressed.
Future<bool> confirmPhoneAction(
  BuildContext context, {
  required String title,
  required String message,
  required String confirmLabel,
}) async {
  final confirmed = await showDialog<bool>(
    context: context,
    useRootNavigator: true,
    builder: (dialogContext) => AlertDialog(
      backgroundColor: AppPalette.panelBg,
      title: Text(
        title,
        style: TextStyle(color: AppPalette.textPrimary, fontSize: 18),
      ),
      content: Text(
        message,
        style: TextStyle(color: AppPalette.textSecondary, fontSize: 14),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(dialogContext).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          style: FilledButton.styleFrom(backgroundColor: AppPalette.dangerFill),
          onPressed: () => Navigator.of(dialogContext).pop(true),
          child: Text(confirmLabel),
        ),
      ],
    ),
  );
  return confirmed ?? false;
}
