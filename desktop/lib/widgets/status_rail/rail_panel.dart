import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart';
import 'rail_figure.dart';

/// The panel behind one figure on the status rail.
///
/// Anchored under its own figure rather than the rail as a whole, so it points
/// at the number it belongs to. The frame only: placement, the shared surface,
/// and the hover plumbing that keeps it open while the pointer crosses from the
/// figure to it. What goes inside is the caller's.
class RailPanel extends StatelessWidget {
  const RailPanel({
    super.key,
    required this.anchor,
    required this.tapGroupId,
    required this.onEnter,
    required this.onExit,
    required this.width,
    required this.child,
  });

  /// The figure this panel hangs from. Its link places the panel; its key says
  /// where on screen that is, which is what decides whether the panel still
  /// fits (see [_slide]).
  final RailFigureAnchor anchor;

  /// Shared with the rail so a click inside the panel isn't the "click outside"
  /// that dismisses a pinned one — the panel lives in an overlay, outside the
  /// rail's own subtree.
  final Object tapGroupId;

  final VoidCallback onEnter;
  final VoidCallback onExit;

  final double width;
  final Widget child;

  /// The surface's own padding, undone on the left so the panel's text sits
  /// under the figure's text rather than being inset from it by a rim's width.
  static const double _inset = 13;

  /// How close to the window's edge the panel may come once it has had to move
  /// to stay on screen.
  static const double _edgeMargin = 10;

  @override
  Widget build(BuildContext context) {
    final windowWidth = MediaQuery.sizeOf(context).width;
    // Never wider than the window it opens over — a clamp that only bites on a
    // window narrower than any the app can be resized to, but the slide below
    // needs a width it can trust.
    final panelWidth = math.min(width, windowWidth - _edgeMargin * 2);
    return Positioned(
      width: panelWidth,
      child: CompositedTransformFollower(
        link: anchor.link,
        // Upward: the rail is the window's bottom edge, so a panel dropped
        // below its anchor would open off the window.
        targetAnchor: Alignment.topLeft,
        followerAnchor: Alignment.bottomLeft,
        offset: Offset(-_inset + _slide(windowWidth, panelWidth), -8),
        child: MouseRegion(
          onEnter: (_) => onEnter(),
          onExit: (_) => onExit(),
          child: TapRegion(
            groupId: tapGroupId,
            child: _Entrance(child: RailPanelSurface(child: child)),
          ),
        ),
      ),
    );
  }

  /// How far the panel has to slide sideways to stay inside the window — zero,
  /// the usual case, when it already fits where its figure puts it.
  ///
  /// The figures sit at the rail's RIGHT end, so a panel hung from the left of
  /// its figure and grown rightwards runs off the window's edge. Sliding beats
  /// re-anchoring to the figure's right edge, which would park the panel well
  /// left of the number it belongs to even when there was room to sit under it.
  double _slide(double windowWidth, double panelWidth) {
    final box = anchor.key.currentContext?.findRenderObject() as RenderBox?;
    if (box == null || !box.hasSize) return 0;
    final left = box.localToGlobal(Offset.zero).dx - _inset;
    final limit = windowWidth - panelWidth - _edgeMargin;
    return left.clamp(_edgeMargin, math.max(_edgeMargin, limit)) - left;
  }
}

/// The glass box a rail panel is drawn on.
class RailPanelSurface extends StatelessWidget {
  const RailPanelSurface({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Material(
      type: MaterialType.transparency,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: AppGlass.surfaceFill,
          borderRadius: BorderRadius.circular(AppCard.radius),
          border: Border.all(color: AppGlass.hair),
          boxShadow: AppGlass.shadow,
        ),
        child: Padding(
          padding: const EdgeInsets.all(RailPanel._inset),
          child: child,
        ),
      ),
    );
  }
}

/// The panel arriving: a short fade while it settles the last few pixels up from
/// the rail it hangs off.
///
/// Six pixels and 160ms, which is under the threshold at which a movement reads
/// as *travel* — the panel should look like it was already there and is coming
/// into focus, not like it flew in. These open on hover, so whatever this costs
/// is paid every time the pointer crosses a figure.
///
/// Only on the way in. There is no exit animation because there is nothing to
/// animate: [OverlayPortal] takes the panel out of the tree the moment it hides,
/// and holding it there to fade would keep a dead popover over the transcript.
///
/// Runs once per mount, so swapping figures under an open panel replaces the
/// contents in place without re-playing this.
class _Entrance extends StatelessWidget {
  const _Entrance({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    // Reduce Motion means no motion, not less of it — the fade goes too, since
    // an opacity ramp is the part that reads as movement on a surface this size.
    final instant = MediaQuery.disableAnimationsOf(context);
    return TweenAnimationBuilder<double>(
      tween: Tween<double>(begin: 0, end: 1),
      duration: instant ? Duration.zero : AppMotion.swap,
      curve: AppMotion.curve,
      builder: (context, t, child) => Opacity(
        opacity: t,
        child: Transform.translate(
          // Positive, so it rises into place: the panel travels *away* from the
          // rail it opens off, and a fall would read as arriving from the wrong
          // side of its own anchor.
          offset: Offset(0, (1 - t) * 6),
          child: child,
        ),
      ),
      child: child,
    );
  }
}
