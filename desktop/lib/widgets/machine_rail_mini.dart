import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'window_chrome.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../state/app_state.dart';
import 'account_footer.dart';

/// The rail, folded.
///
/// It is a narrow column rather than nothing at all, and that is the whole
/// point: the control that folds the rail has to still be there to unfold it.
/// Hiding the rail outright would leave the button that did it nowhere on
/// screen, and the only way back would be a shortcut nobody was told about.
///
/// What survives the fold is what still means something at this width — the way
/// back, and who you are signed in as. A machine's name does not fit in 72px,
/// and a truncated one says less than no name at all.
class MachineRailMini extends StatelessWidget {
  const MachineRailMini({
    super.key,
    required this.notifier,
    required this.onExpand,
  });

  final AppNotifier notifier;
  final VoidCallback onExpand;

  /// The same width Grid's folded rail uses, so the two apps fold to the same
  /// shape on a desk where both are open.
  static const double width = 72;
  static const double _headerHeight = 46;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    // No fill: the fold draws the surface — see MachineRail for why.
    return SizedBox(
      width: width,
      child: Column(
        children: [
          // Same inset and drag handle as the wide rail's head, for the same
          // reason: the traffic lights float over this corner.
          WindowDragArea(
            child: SizedBox(
              height: _headerHeight,
              child: Center(
                child: AppIconButton(
                  icon: LucideIcons.panelLeft300,
                  size: 18,
                  tooltip: 'Expand sidebar  ⌘\\',
                  onPressed: onExpand,
                ),
              ),
            ),
          ),
          const Spacer(),
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: AccountFooter(notifier: notifier, compact: true),
          ),
        ],
      ),
    );
  }
}
