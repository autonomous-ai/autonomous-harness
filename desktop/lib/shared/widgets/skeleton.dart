import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import 'pulse.dart';

/// Placeholders for content whose *shape* is already known.
///
/// A skeleton beats a spinner when you know what is coming: the layout does
/// not jump when the data lands, and what the reader waits on reads as "your
/// rows are on their way" rather than "something is happening somewhere". The
/// converse holds too — shape unknown, use a spinner; do not invent one.
///
/// Four rules every skeleton in the app keeps, in order of how often they are
/// broken elsewhere:
///
/// 1. **The rhythm is an opacity breath, not a shimmer sweep.** [Pulse] owns
///    it; a light band wiping across a pane fights the app's quiet.
/// 2. **A placeholder wears the real content's metrics.** One pixel off and it
///    causes the very jump it exists to prevent — which is why [SkeletonText]
///    measures the line box of the style it stands in for instead of guessing.
/// 3. **A block fades towards its bottom** ([skeletonFade]), so it reads as
///    "more below" rather than a wall cut off mid-list.
/// 4. **Line widths differ.** Equal bars turn a cluster into one grey slab.
///
/// The fill is [AppSurface.recess] breathing up to [AppSurface.recessHover]:
/// a translucent *well*, not a solid. A skeleton sits on top of a card, so it
/// borrows the token for a hollow rather than the card's own fill — it has to
/// read as an absence — and an overlay rides any ground (page, card, dialog)
/// without being re-measured against it.
class Skeleton extends StatelessWidget {
  const Skeleton({
    super.key,
    this.width,
    this.height = 12,
    this.radius = 6,
    this.shape = BoxShape.rectangle,
  });

  /// A round placeholder — an avatar, a status dot.
  ///
  /// ⚠️ Only for slots that ARE round. A 10-radius badge wants a 10-radius
  /// [Skeleton], or the one detail that changes shape when data lands is the
  /// one the eye catches.
  const Skeleton.circle({super.key, required double size})
    : width = size,
      height = size,
      radius = 0,
      shape = BoxShape.circle;

  /// A line of text: the tighter radius the app's type scale wants.
  const Skeleton.text({super.key, this.width, this.height = 12})
    : radius = 4,
      shape = BoxShape.rectangle;

  /// Null stretches to the parent.
  final double? width;
  final double height;
  final double radius;
  final BoxShape shape;

  @override
  Widget build(BuildContext context) {
    // Tokens are getters against a global brightness; nothing here depends on
    // Theme.of, so the widget has to register for a flip itself.
    AppTheme.watch(context);
    final rest = AppSurface.recess;
    final peak = AppSurface.recessHover;
    return Pulse(
      // Stated, not inherited: [Pulse]'s bare default is the status LED's
      // blink, and a placeholder breathes faster than a light does.
      duration: const Duration(milliseconds: 1100),
      builder: (context, t, _) => Container(
        width: width,
        height: height,
        decoration: BoxDecoration(
          color: Color.lerp(rest, peak, t),
          borderRadius: shape == BoxShape.rectangle
              ? BorderRadius.circular(radius)
              : null,
          shape: shape,
        ),
      ),
    );
  }
}

/// A text line as a fraction of the row it sits in.
///
/// Fractions, not pixels, so a set of lines keeps its proportions in a 284px
/// menu and a 900px table alike. Needs a bounded width from its parent.
class SkeletonLine extends StatelessWidget {
  const SkeletonLine({super.key, this.widthFactor = 1, this.height = 12});

  final double widthFactor;
  final double height;

  @override
  Widget build(BuildContext context) => FractionallySizedBox(
    alignment: Alignment.centerLeft,
    widthFactor: widthFactor,
    child: Skeleton.text(height: height),
  );
}

/// A text line that occupies exactly the line box of [style].
///
/// The bar is drawn shorter than the line — text has ascenders and descenders
/// a solid block does not — but the box it reserves is measured from the
/// style with a real [TextPainter], under the ambient [DefaultTextStyle] and
/// text scaler. That is what makes a skeleton row and a real row the same
/// height whatever font the fallback chain lands on: read a height off the
/// code and you get the arithmetic, which [AppMenuRowMetrics] documents is
/// wrong by a fraction of a pixel per line.
///
/// Give it a [width] (pixels) or a [widthFactor] (share of a bounded parent);
/// with neither it fills the parent.
class SkeletonText extends StatelessWidget {
  const SkeletonText({
    super.key,
    required this.style,
    this.width,
    this.widthFactor,
    this.barHeight,
    this.strutStyle,
    this.alignment = Alignment.centerLeft,
  }) : assert(
         width == null || widthFactor == null,
         'Give a width or a widthFactor, not both',
       );

  /// The style of the text this stands in for. Only the metrics are read.
  final TextStyle style;

  /// Matched to the real text's strut when it pins one — a sidebar row's label
  /// does, and a skeleton measured without it lands a pixel short.
  final StrutStyle? strutStyle;

  final double? width;
  final double? widthFactor;

  /// Bar thickness. Defaults to roughly the x-height of [style], which is
  /// where the ink of a real line is densest.
  final double? barHeight;

  final AlignmentGeometry alignment;

  /// The height of one line of [style] under [context]'s text settings.
  static double lineHeight(
    BuildContext context,
    TextStyle style, {
    StrutStyle? strutStyle,
  }) {
    final resolved = DefaultTextStyle.of(context).style.merge(style);
    final painter = TextPainter(
      text: TextSpan(text: 'X', style: resolved),
      strutStyle: strutStyle,
      textDirection: Directionality.maybeOf(context) ?? TextDirection.ltr,
      textScaler: MediaQuery.textScalerOf(context),
      maxLines: 1,
    )..layout();
    final height = painter.height;
    painter.dispose();
    return height;
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final height = lineHeight(context, style, strutStyle: strutStyle);
    final fontSize =
        style.fontSize ?? DefaultTextStyle.of(context).style.fontSize ?? 14;
    final bar = barHeight ?? (fontSize * 0.72).roundToDouble().clamp(6.0, 16.0);
    Widget line = Skeleton.text(width: width, height: bar);
    if (width == null) {
      line = FractionallySizedBox(
        alignment: alignment,
        widthFactor: widthFactor ?? 1,
        child: line,
      );
    }
    return SizedBox(
      height: height,
      width: width,
      child: Align(alignment: alignment, child: line),
    );
  }
}

/// How faint row `i` of `rows` should be.
///
/// The default (0.65) is for a long list pane; a short menu or popover uses
/// the gentler [light] so three rows do not end at a whisper.
double skeletonFade(int i, int rows, {double depth = 0.65}) =>
    rows <= 0 ? 1 : 1 - (i / rows) * depth;

/// The gentler fade for a block that is capped short — a menu, a popover.
const double skeletonFadeLight = 0.5;

/// One list row: a round or square leading slot and two lines of unequal
/// width (0.42 / 0.68), the shape of most "icon + name + summary" rows.
///
/// Wear the real row's surface and padding around this — a bare skeleton
/// list draws grey bars with no home on the page ground, and the cards then
/// *appear* when data lands, which is exactly the shift a skeleton exists to
/// prevent.
class SkeletonListTile extends StatelessWidget {
  const SkeletonListTile({
    super.key,
    this.leading = 30,
    this.leadingRadius,
    this.subtitle = true,
    this.titleFactor = 0.42,
    this.subtitleFactor = 0.68,
    this.padding = const EdgeInsets.symmetric(vertical: 8),
  });

  /// Size of the leading slot; 0 for none.
  final double leading;

  /// Null draws a circle; a value draws a rounded square with that radius —
  /// match the real badge.
  final double? leadingRadius;

  final bool subtitle;
  final double titleFactor;
  final double subtitleFactor;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) => Padding(
    padding: padding,
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (leading > 0) ...[
          leadingRadius == null
              ? Skeleton.circle(size: leading)
              : Skeleton(
                  width: leading,
                  height: leading,
                  radius: leadingRadius!,
                ),
          const SizedBox(width: 12),
        ],
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              SkeletonLine(widthFactor: titleFactor, height: 13),
              if (subtitle) ...[
                const SizedBox(height: 6),
                SkeletonLine(widthFactor: subtitleFactor, height: 11),
              ],
            ],
          ),
        ),
      ],
    ),
  );
}

/// A column of [rows] placeholders, already faded towards the bottom and
/// deaf to the pointer.
///
/// [itemBuilder] gets the row index and builds its shape; the default is a
/// [SkeletonListTile]. Pick [rows] from what it replaces, not from habit: a
/// long list pane wants 5–7, a capped block (dialog, popover) wants 3 — a
/// skeleton *taller* than the list it stands in for causes an upward jump,
/// which is worse than a downward one.
class SkeletonList extends StatelessWidget {
  const SkeletonList({
    super.key,
    this.rows = 5,
    this.itemBuilder,
    this.fadeDepth = 0.65,
    this.padding = EdgeInsets.zero,
    this.semanticsLabel = 'Loading',
  });

  final int rows;
  final IndexedWidgetBuilder? itemBuilder;
  final double fadeDepth;
  final EdgeInsetsGeometry padding;
  final String semanticsLabel;

  @override
  Widget build(BuildContext context) => SkeletonBlock(
    semanticsLabel: semanticsLabel,
    // A scroll view that cannot scroll: it is the one container that neither
    // overflows a short pane (an `Expanded` on a small window) nor demands a
    // bounded height (a dialog that shrink-wraps its content).
    child: SingleChildScrollView(
      physics: const NeverScrollableScrollPhysics(),
      padding: padding,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 0; i < rows; i++)
            Opacity(
              opacity: skeletonFade(i, rows, depth: fadeDepth),
              child: itemBuilder?.call(context, i) ?? const SkeletonListTile(),
            ),
        ],
      ),
    ),
  );
}

/// What every composite skeleton is wrapped in: no pointer, no hover, one
/// semantics node that says "loading".
///
/// A placeholder that scrolls under the cursor or lights up on hover reads
/// as real content, and a screen reader walking twelve empty bars learns
/// nothing it could not learn from one label.
class SkeletonBlock extends StatelessWidget {
  const SkeletonBlock({
    super.key,
    required this.child,
    this.semanticsLabel = 'Loading',
  });

  final Widget child;
  final String semanticsLabel;

  @override
  Widget build(BuildContext context) => Semantics(
    label: semanticsLabel,
    liveRegion: false,
    container: true,
    child: ExcludeSemantics(
      child: IgnorePointer(
        child: MouseRegion(cursor: SystemMouseCursors.basic, child: child),
      ),
    ),
  );
}
