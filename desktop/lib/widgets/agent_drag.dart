import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../theme/app_theme.dart';

/// An agent in flight between the rail and the grid.
class AgentDragRef {
  const AgentDragRef({
    required this.machineId,
    required this.agentId,
    required this.name,
  });

  final String machineId;
  final String agentId;
  final String name;
}

/// A PANE in flight between two grid slots.
///
/// A type of its own rather than a flag on [AgentDragRef], because the two
/// drags mean opposite things at the same drop point: a rail row landing on a
/// tile REPLACES what that tile shows, a pane landing on it SWAPS the two.
/// `DragTarget<T>` already separates them by generic, so each target only ever
/// sees the payload it knows what to do with, and neither has to ask what kind
/// of drag is in flight.
class PaneDragRef {
  const PaneDragRef({required this.paneId});

  final int paneId;
}

/// Everything the header needs to drag its own pane: what to say it is, and
/// where to photograph it from.
///
/// The key is not part of [PaneDragRef] because that is the PAYLOAD — it
/// crosses to the drop target, where a key into the source tile means nothing.
class PaneDragHandle {
  const PaneDragHandle({required this.ref, required this.size});

  final PaneDragRef ref;

  /// The tile's size, so the ghost comes out the shape of the pane it carries.
  ///
  /// Passed IN from a LayoutBuilder rather than read off a render object: the
  /// header builds this during a build, and `RenderBox.size` throws there.
  final Size size;
}

/// Whether a rail row is currently being dragged, readable by the grid.

///
/// A [ValueNotifier] beside the widgets rather than a field on AppNotifier: it
/// describes a hand on a mouse for the length of one gesture, and nothing about
/// machines, agents or sessions. Putting it in the domain state would mean every
/// listener of that state rebuilding on mouse-down, and would outlive the
/// gesture in a place where later readers would reasonably expect it to mean
/// something.
///
/// The grid watches it to reveal the empty slot: an "add a tile" cell that is
/// always on screen would permanently halve a single terminal to advertise a
/// feature, so it appears when there is something to drop into it and goes away
/// again afterwards.
final agentDrag = ValueNotifier<AgentDragRef?>(null);

/// Whether a pane is currently being dragged by its header, readable by the grid.
///
/// Kept apart from [agentDrag] for the same reason [PaneDragRef] is a separate
/// type: the two drags are live at different times and the grid reveals
/// different things for each — an agent drag offers an empty slot to open into,
/// a pane drag offers the other tiles to trade places with.
final paneDragging = ValueNotifier<PaneDragRef?>(null);

/// The one way out of a tile, in the one place every tile puts it.
/// Hold this tile to its slot, or let it go.
///
/// Always present rather than revealed on hover: a control that only exists
/// while the pointer is over it cannot be found by someone who does not already
/// know it is there, and the whole point of the pin is to be reached for AFTER
/// the grid has rearranged itself once and annoyed them. Muted until it is on,
/// so the header of an unpinned tile stays quiet.
class PanePinButton extends StatelessWidget {
  const PanePinButton({
    super.key,
    required this.pinned,
    required this.onPressed,
  });

  final bool pinned;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Tooltip(
      message: pinned
          ? 'Pinned to this slot — click to release'
          : 'Pin to this slot',
      child: IconButton(
        onPressed: onPressed,
        icon: Icon(
          pinned ? Icons.push_pin : Icons.push_pin_outlined,
          size: 14,
          color: pinned ? AppColors.accent : AppColors.muted,
        ),
        splashRadius: 13,
        constraints: const BoxConstraints.tightFor(width: 26, height: 26),
        padding: EdgeInsets.zero,
        visualDensity: VisualDensity.compact,
      ),
    );
  }
}

class PaneCloseButton extends StatelessWidget {
  const PaneCloseButton({super.key, required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Tooltip(
      message: 'Close pane',
      child: IconButton(
        onPressed: onPressed,
        icon: Icon(Icons.close, size: 15, color: AppColors.muted),
        splashRadius: 13,
        constraints: const BoxConstraints.tightFor(width: 26, height: 26),
        padding: EdgeInsets.zero,
        visualDensity: VisualDensity.compact,
      ),
    );
  }
}
