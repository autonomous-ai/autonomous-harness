import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../../state/app_state.dart';
import '../../usage/usage_controller.dart';
import 'key_hints.dart';
import 'usage_rail.dart';

/// The strip along the bottom of the window: what the agent accounts have
/// spent, and the keys that mean something right now.
///
/// It exists because the top of the window is where the things you *press*
/// live — the rail, the panes, the menus — and none of these figures is a call
/// to action. **The top is what you press, the bottom is what you know.**
///
/// Full-bleed, under the machine rail as well as the panes, so the window
/// closes on one unbroken line. A strip that started after the rail would put a
/// step in the bottom edge and read as part of the pane rather than the window.
class StatusRail extends StatefulWidget {
  const StatusRail({super.key, required this.notifier, this.usage});

  /// Read by [KeyHints] for where the keyboard is, and by the usage panel for
  /// what the sidebar calls this computer.
  final AppNotifier notifier;

  /// The agent accounts' rate limits.
  ///
  /// Handed down by the shell, which owns it so that folding the sidebar —
  /// which unmounts this strip — does not restart the poll. Null only in a test
  /// that wants the rail on its own, where the rail makes — and disposes — one
  /// for itself.
  final UsageController? usage;

  /// Tall enough for an 11.5pt figure with a hit target around it, short enough
  /// to stay furniture.
  static const double height = 26;

  @override
  State<StatusRail> createState() => _StatusRailState();
}

class _StatusRailState extends State<StatusRail> {
  late final UsageController _usage = widget.usage ?? UsageController();

  @override
  void dispose() {
    if (widget.usage == null) _usage.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    // NO FILL, NO RULE — the strip is its text and nothing else. The rail above
    // it and every pane are floating cards on the gradient field, and a flat
    // slab laid across the bottom of the window would be the one surface that
    // did not belong to anything.
    return SizedBox(
      height: StatusRail.height,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: Row(
          children: [
            Expanded(
              child: UsageRail(usage: _usage, notifier: widget.notifier),
            ),
            // The keys had nowhere to live that was not a modal. See [KeyHints]
            // for why a strip beats a sheet for the ones nobody knows to go
            // looking for.
            KeyHints(notifier: widget.notifier),
          ],
        ),
      ),
    );
  }
}
