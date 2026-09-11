import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// What a row is to the guide line running down a timeline beside it.
enum TimelineRole {
  /// The row carries a mark the line runs *through*. The trunk breaks around
  /// it, so the mark reads as a node threaded onto the line rather than as an
  /// icon the line happens to strike out.
  node,

  /// Something living under the row above. The trunk passes by and an arm
  /// reaches out to it.
  branch,

  /// Neither — the trunk simply crosses this band. What a step's opened payload
  /// sits beside: the line has to carry on past it to reach the next row, and
  /// there is no mark down there to break around.
  through,
}

/// The line that ties a run of rows into one thing.
///
/// Two surfaces draw one: the rail's projects and the chats inside them, and a
/// turn's steps between two passages of an agent's answer. Both are answering
/// the same question — *what is this stretch of rows, and where does it end?* —
/// and indentation alone answers it only while the whole group is on screen.
///
/// **Drawn per row rather than as one line behind the block**, so nothing here
/// has to know how tall a row is: each row paints the segment crossing its own
/// band, and [above]/[below] stitch those segments into one line. That is also
/// what lets a row in a lazy list draw its own share without the list having to
/// measure anything.
///
/// [trunkX] is the caller's, because the whole point is that the line runs
/// through the middle of something — a folder icon in the rail, a tool's glyph
/// in a step row — and only the caller knows where that sits.
class TimelineGuide extends StatelessWidget {
  const TimelineGuide({
    super.key,
    required this.role,
    required this.trunkX,
    required this.child,
    this.above = true,
    this.below = true,
    this.nodeGap = 13,
    this.armLength = 7,
  });

  final TimelineRole role;

  /// Where the trunk runs, from the child's left edge.
  final double trunkX;

  final Widget child;

  /// Whether the trunk arrives from the row above. False on the first row —
  /// a line dangling up towards a heading points at nothing.
  final bool above;

  /// Whether the trunk carries on into the row below. False on the last row,
  /// where the run ends and the line has to stop rather than run out into
  /// whatever follows it.
  final bool below;

  /// How wide a berth [TimelineRole.node] gives the mark it runs through.
  /// Enough to clear the glyph by a few pixels: any less and the line reads as
  /// striking it out.
  final double nodeGap;

  /// How far a [TimelineRole.branch]'s arm reaches out of the trunk. Stop it
  /// short of the row's own box — touching a hover fill makes the guide read as
  /// part of the row instead of as the thing holding it.
  final double armLength;

  @override
  Widget build(BuildContext context) {
    // Reads AppPalette.guide from inside a lazy list, where an ancestor's
    // rebuild never lands — watch here or the guide keeps the palette it was
    // first painted with.
    AppTheme.watch(context);
    return CustomPaint(
      // In front of the child, not behind it: a row's hover and selection fills
      // run its full width, and painting under them would swallow the two short
      // segments carrying the trunk past its mark on exactly the row the
      // pointer is on.
      foregroundPainter: _TimelinePainter(
        role: role,
        trunkX: trunkX,
        above: above,
        below: below,
        nodeGap: nodeGap,
        armLength: armLength,
        color: AppPalette.guide,
      ),
      child: child,
    );
  }
}

/// A hairline, like every other rule in the app. This is chrome about the rows,
/// not an entry among them.
const double _stroke = 1;

/// One row's share of the guide: the trunk crossing its band, broken around a
/// node's mark, plus the arm out to a nested row.
class _TimelinePainter extends CustomPainter {
  const _TimelinePainter({
    required this.role,
    required this.trunkX,
    required this.above,
    required this.below,
    required this.nodeGap,
    required this.armLength,
    required this.color,
  });

  final TimelineRole role;
  final double trunkX;
  final bool above;
  final bool below;
  final double nodeGap;
  final double armLength;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final line = Paint()
      ..color = color
      ..strokeWidth = _stroke;
    final centerY = size.height / 2;
    // A node breaks the line around its mark; everything else lets it run
    // straight through, which is also what turns the last branch's two segments
    // into one clean elbow.
    final gap = role == TimelineRole.node ? nodeGap : 0.0;

    if (above) {
      canvas.drawLine(Offset(trunkX, 0), Offset(trunkX, centerY - gap), line);
    }
    if (below) {
      canvas.drawLine(
        Offset(trunkX, centerY + gap),
        Offset(trunkX, size.height),
        line,
      );
    }
    if (role == TimelineRole.branch) {
      canvas.drawLine(
        Offset(trunkX, centerY),
        Offset(trunkX + armLength, centerY),
        line,
      );
    }
  }

  @override
  bool shouldRepaint(_TimelinePainter old) =>
      role != old.role ||
      trunkX != old.trunkX ||
      above != old.above ||
      below != old.below ||
      nodeGap != old.nodeGap ||
      armLength != old.armLength ||
      color != old.color;
}
