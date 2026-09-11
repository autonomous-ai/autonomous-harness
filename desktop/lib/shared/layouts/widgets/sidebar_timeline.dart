import 'package:flutter/material.dart';

import '../../widgets/timeline_guide.dart';
import 'sidebar_item.dart';

/// Where the trunk runs: dead centre of a project row's folder icon, so the
/// icons read as nodes threaded onto one line rather than as a list that
/// happens to have a rule beside it.
///
/// Derived from [SidebarItem.iconGutter] plus half an 18px glyph rather than
/// typed as `19`, so changing the rail's inset moves the guide with it instead
/// of leaving it pointing at nothing.
const double _trunkX = SidebarItem.iconGutter + 9;

/// How far the arm reaches out of the trunk towards a nested row.
///
/// A nested row's own box starts 28px in, so the arm stops 2px short of it:
/// touching the row's hover fill would make the guide read as part of the row
/// instead of as the thing holding it.
const double _armLength = 7;

/// How wide a berth the trunk gives a project's folder icon.
///
/// An 18px glyph centred in a 38px band leaves 10px clear at each end; 13
/// clears the glyph by 4px, which is what keeps the line from looking like it
/// is striking the icon out. What's left either side is ~6px of trunk — short,
/// but that is the point: enough to say the line passes behind the node.
const double _nodeGap = 13;

/// What a row is to the guide line running down the rail's Projects block.
///
/// The shared [TimelineRole] under the rail's own name: the transcript's step
/// list draws the same guide with the same three roles, and one enum is what
/// keeps a change to the line landing on both.
typedef SidebarTimelineRole = TimelineRole;

/// The guide line that ties the rail's projects and the chats inside them into
/// one tree.
///
/// The rail already says which chats belong to which project by indenting them,
/// but indentation alone goes quiet the moment a project's chats run long
/// enough that its folder row has scrolled away — the eye has nothing left to
/// follow back up. One continuous line through the whole block answers "what am
/// I still inside?" without the user having to scroll to find out.
///
/// The drawing itself is [TimelineGuide]; what lives here is the rail's own
/// geometry, which is derived from [SidebarItem]'s and belongs beside it.
class SidebarTimeline extends StatelessWidget {
  const SidebarTimeline({
    super.key,
    required this.role,
    required this.child,
    this.above = true,
    this.below = true,
  });

  final SidebarTimelineRole role;
  final Widget child;

  /// Whether the trunk arrives from the row above. False on the first project —
  /// a line dangling up towards the "Projects" header would point at nothing.
  final bool above;

  /// Whether the trunk carries on into the row below. False on the last row of
  /// the block, where the tree ends and the line has to stop rather than run
  /// out into the "Chats" section, which isn't part of this tree.
  final bool below;

  @override
  Widget build(BuildContext context) => TimelineGuide(
    role: role,
    trunkX: _trunkX,
    above: above,
    below: below,
    nodeGap: _nodeGap,
    armLength: _armLength,
    child: child,
  );
}
