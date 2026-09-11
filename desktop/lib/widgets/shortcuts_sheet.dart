import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shortcuts/shortcuts_list.dart';

/// The ⌘/ sheet — [ShortcutsList] in a dialog.
///
/// The list itself is shared with Settings ▸ Keyboard shortcuts, so the two can
/// never disagree about what a key does.
Future<void> showShortcutsSheet(BuildContext context) {
  return showAppDialog<void>(
    context: context,
    builder: (context) => const _ShortcutsSheet(),
  );
}

class _ShortcutsSheet extends StatelessWidget {
  const _ShortcutsSheet();

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Dialog(
      // No backgroundColor, no shape: `dialogTheme` supplies both, at
      // AppGlass.surfaceFill and AppCard.radius (12). The rim this used to
      // carry is gone with them — §1 allows exactly one border in the app and
      // it belongs to the menu panel, not to a dialog.
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 17, 18, 4),
              child: Text(
                'Keyboard shortcuts',
                style: TextStyle(
                  color: grid.AppPalette.textPrimary,
                  fontSize: 15,
                  fontWeight: grid.AppFont.semibold,
                ),
              ),
            ),
            Flexible(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(18, 8, 18, 16),
                child: const ShortcutsList(),
              ),
            ),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.fromLTRB(18, 12, 18, 12),
              decoration: BoxDecoration(
                border: Border(top: BorderSide(color: grid.AppGlass.hair)),
              ),
              child: Align(
                alignment: Alignment.centerRight,
                child: TextButton(
                  onPressed: () => Navigator.of(context).pop(),
                  child: const Text('Close'),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
