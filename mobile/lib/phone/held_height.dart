import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

/// Lays [child] out at the height it last had, for as long as [hold] is true.
///
/// For a box something else is about to cover: a keyboard raised FOR the cover
/// shrinks the page, and without this the content underneath re-lays out for a
/// keyboard it never asked for — and again, visibly, as the cover fades away and
/// the keyboard falls. Held, the child keeps its height and is clipped to the
/// space the page actually has, so nothing under the cover moves.
///
/// The height remembered is the last one laid out while not holding, taken in
/// layout rather than in build, so it is the height that was on screen.
class HeldHeight extends SingleChildRenderObjectWidget {
  const HeldHeight({super.key, required this.hold, required super.child});

  final bool hold;

  @override
  RenderObject createRenderObject(BuildContext context) =>
      RenderHeldHeight(hold);

  @override
  void updateRenderObject(BuildContext context, RenderHeldHeight renderObject) {
    renderObject.hold = hold;
  }
}

/// [HeldHeight]'s box: the child's last free height, clipped to the space given.
class RenderHeldHeight extends RenderProxyBox {
  RenderHeldHeight(this._hold);

  bool _hold;
  double? _height;
  final _clip = LayerHandle<ClipRectLayer>();

  set hold(bool value) {
    if (_hold == value) return;
    _hold = value;
    markNeedsLayout();
  }

  @override
  void performLayout() {
    final child = this.child!;
    final held = _hold ? _height : null;
    if (held == null) {
      child.layout(constraints, parentUsesSize: true);
      size = child.size;
      _height = size.height;
      return;
    }
    child.layout(
      BoxConstraints(
        minWidth: constraints.minWidth,
        maxWidth: constraints.maxWidth,
        minHeight: held,
        maxHeight: held,
      ),
      parentUsesSize: true,
    );
    size = constraints.constrain(Size(child.size.width, held));
  }

  @override
  void paint(PaintingContext context, Offset offset) {
    _clip.layer = context.pushClipRect(
      needsCompositing,
      offset,
      Offset.zero & size,
      super.paint,
      oldLayer: _clip.layer,
    );
  }

  @override
  void dispose() {
    _clip.layer = null;
    super.dispose();
  }
}
