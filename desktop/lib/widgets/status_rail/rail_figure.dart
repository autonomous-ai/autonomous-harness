import 'package:flutter/material.dart';

/// What a status-rail panel hangs from: the link that places it under its
/// figure, and the key that says where that figure sits.
///
/// Both, because the link alone cannot answer whether the panel it places still
/// fits inside the window — see `RailPanel`.
typedef RailFigureAnchor = ({LayerLink link, GlobalKey key});

/// A fresh anchor. One per figure: a [LayerLink] can only be attached to a
/// single target, so figures cannot share.
RailFigureAnchor newRailFigureAnchor() => (link: LayerLink(), key: GlobalKey());

/// One figure on the status rail, and the panel it opens.
///
/// The regions touch: the gap between figures is each figure's own padding
/// rather than a spacer between them. A bare `SizedBox` would be dead ground —
/// the pointer crossing it belongs to nothing, so an open panel would close on
/// the way past and reopen on landing.
///
/// Generic over what a figure opens: the figure hands back whatever its panel
/// is looked up by.
class RailHoverTarget<T> extends StatelessWidget {
  const RailHoverTarget({
    super.key,
    required this.kind,
    required this.anchor,
    required this.semantics,
    required this.child,
    required this.onEnter,
    required this.onExit,
    this.enabled = true,
  });

  final T kind;
  final RailFigureAnchor anchor;
  final String semantics;
  final Widget child;
  final void Function(T) onEnter;
  final void Function(T) onExit;

  /// False while there is nothing to open — the figure is then still readable
  /// and simply inert.
  final bool enabled;

  /// Half the space between two figures. Each side owns its own half, so the
  /// two regions meet with nothing between them.
  static const double gap = 9;

  @override
  Widget build(BuildContext context) {
    return CompositedTransformTarget(
      link: anchor.link,
      child: KeyedSubtree(
        key: anchor.key,
        child: Semantics(
          label: semantics,
          child: MouseRegion(
            cursor: enabled
                ? SystemMouseCursors.click
                : SystemMouseCursors.basic,
            onEnter: enabled ? (_) => onEnter(kind) : null,
            onExit: enabled ? (_) => onExit(kind) : null,
            child: Padding(
              // Full height, so the pointer entering the rail anywhere over a
              // figure is already on it — a region inset from the strip's own
              // edges leaves a lane above and below that closes the panel.
              padding: const EdgeInsets.symmetric(horizontal: gap),
              // ⚠️ No `Center` here, and that is deliberate. It used to wrap
              // this child, and `Center` LOOSENS the width constraint on the
              // way through — the child could then take whatever it wanted and
              // hand the overflow up, which made every `Flexible` inside a
              // figure inert. The vertical centring it was here for is already
              // done by the rail's own `SizedBox(height: 26)` and the Row's
              // default cross-axis centre.
              child: child,
            ),
          ),
        ),
      ),
    );
  }
}
