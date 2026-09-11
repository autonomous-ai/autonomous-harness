import 'dart:async';

import 'package:flutter/material.dart';

/// How fast the line travels once it starts, in logical pixels per second.
/// Slow enough to read a title as it passes, fast enough that a long one isn't
/// a wait.
const double _speed = 46;

/// The soft edge a line ends on rather than a hard vertical cut: the tail of a
/// still line that ran out of room, and — once it starts moving — the head
/// sliding out of view behind it.
///
/// One width for both, because a sidebar row swaps its resting label for a
/// travelling one the moment the pointer lands. Two values would make the tail
/// visibly change length under the pointer, which reads as the row twitching.
const double kEdgeFadeWidth = 20;

/// One line of text that reveals its own tail: given less room than it needs,
/// it slides left until the end of the string is in view, then stops there.
///
/// Built for the surfaces whose whole job is showing what a truncated row hid —
/// a chat's hover preview exists because the rail's own label dissolves before
/// the title is over.
/// Text that already fits is drawn plainly and never moves: motion here means
/// "there is more to read", so a line that animated without hiding anything
/// would be saying something untrue.
///
/// It travels once and rests at the end rather than looping: a marquee that
/// returns to the start asks you to keep watching, and this one is answering a
/// question you already asked by hovering.
class ScrollRevealText extends StatefulWidget {
  const ScrollRevealText({
    super.key,
    required this.text,
    required this.style,
    this.strutStyle,
    this.startDelay = const Duration(milliseconds: 520),
  });

  final String text;
  final TextStyle style;

  /// Carried through to both the measurement and the line itself, so swapping a
  /// plain [Text] for this one can't shift the baseline: a row that pins its
  /// label's metrics with a strut has to keep them while the label travels.
  final StrutStyle? strutStyle;

  /// The beat before the line starts moving — long enough to read the head of
  /// the title standing still, so the reveal feels like a continuation rather
  /// than something snatched away as you land on it.
  final Duration startDelay;

  @override
  State<ScrollRevealText> createState() => _ScrollRevealTextState();
}

class _ScrollRevealTextState extends State<ScrollRevealText>
    with SingleTickerProviderStateMixin {
  late final AnimationController _travel = AnimationController(vsync: this);
  Timer? _start;

  /// How far past its box the text runs, as last measured. Held so the schedule
  /// is only redone when the geometry genuinely changed — the measurement
  /// happens on every build, but the controller must not be reset by one.
  double _overflow = 0;

  @override
  void dispose() {
    _start?.cancel();
    _travel.dispose();
    super.dispose();
  }

  /// Restart the reveal for a newly measured [overflow]. Called after the
  /// frame, never during it: touching the controller drives listeners, and
  /// doing that mid-build is a rebuild inside a build.
  ///
  /// The mounted check is the price of that delay — a hovered row scrolled out
  /// of the rail is disposed between the build and the callback, and the
  /// controller it would reset is already gone.
  void _schedule(double overflow) {
    if (!mounted) return;
    if ((overflow - _overflow).abs() < 0.5) return;
    _overflow = overflow;
    _start?.cancel();
    _travel
      ..stop()
      ..value = 0;
    if (overflow <= 0.5) return;
    // Duration from distance, so a title one word too long and one twice the
    // width of its box travel at the same readable pace. Clamped at both ends:
    // a hair of overflow shouldn't be an imperceptible twitch, and a very long
    // title shouldn't hold you there for ten seconds.
    _travel.duration = Duration(
      milliseconds: (overflow / _speed * 1000).round().clamp(700, 4200),
    );
    _start = Timer(widget.startDelay, () {
      if (mounted) _travel.forward();
    });
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final painter = TextPainter(
          text: TextSpan(text: widget.text, style: widget.style),
          strutStyle: widget.strutStyle,
          maxLines: 1,
          textDirection: Directionality.of(context),
          textScaler: MediaQuery.textScalerOf(context),
        )..layout();
        final overflow = painter.width - constraints.maxWidth;
        WidgetsBinding.instance.addPostFrameCallback(
          (_) => _schedule(overflow),
        );

        if (overflow <= 0.5) {
          return Text(
            widget.text,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: widget.style,
            strutStyle: widget.strutStyle,
          );
        }

        // Its own measured height rather than whatever the parent offers: the
        // travelling line is positioned, so nothing inside can size the box,
        // and a Row would hand it an unbounded height to fill.
        return SizedBox(
          height: painter.height,
          child: AnimatedBuilder(
            animation: _travel,
            builder: (context, _) => ClipRect(
              child: ShaderMask(
                blendMode: BlendMode.dstIn,
                shaderCallback: (bounds) => _edgeFade(bounds, _travel.value),
                child: Stack(
                  children: [
                    Positioned(
                      left: -overflow * _travel.value,
                      top: 0,
                      bottom: 0,
                      // The +1 is the rounding slack between the painter's
                      // measurement and the laid-out line; without it the last
                      // glyph can clip by a hair at rest.
                      width: painter.width + 1,
                      child: Text(
                        widget.text,
                        maxLines: 1,
                        softWrap: false,
                        overflow: TextOverflow.clip,
                        style: widget.style,
                        strutStyle: widget.strutStyle,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

/// The mask over a travelling line: the head fades in as it starts to leave,
/// the tail's fade lifts as the end arrives. Both ramp over the first and last
/// slice of the travel, so at rest the line is a plain hard-edged string again.
Shader _edgeFade(Rect bounds, double t) {
  final w = bounds.width;
  if (w <= kEdgeFadeWidth * 2) {
    return const LinearGradient(colors: [Colors.white, Colors.white])
        .createShader(bounds);
  }
  final head = (t * 8).clamp(0.0, 1.0);
  final tail = ((1 - t) * 8).clamp(0.0, 1.0);
  final edge = kEdgeFadeWidth / w;
  return LinearGradient(
    stops: [0, edge, 1 - edge, 1],
    colors: [
      Colors.white.withValues(alpha: 1 - head),
      Colors.white,
      Colors.white,
      Colors.white.withValues(alpha: 1 - tail),
    ],
  ).createShader(bounds);
}

/// The mask over a line that is standing still: opaque until the last
/// [kEdgeFadeWidth] of its box, then out to nothing at the edge.
///
/// What a rail row wears instead of an ellipsis. "…" is a glyph that says
/// *there is more* — worth saying once, but in a list where nearly every title
/// is too long for the rail it becomes three dots at the end of every line and
/// stops being read at all. A line that dissolves says the same thing without
/// spending a character on it, and hands the tail back the ~12px the ellipsis
/// was standing in.
///
/// Only glyphs reaching into that last slice are touched, so a label that fits
/// is drawn plainly: the fade is never a claim that something was cut off.
Shader tailFade(Rect bounds) {
  final w = bounds.width;
  // A box narrower than the fade itself has nothing to ramp across, and
  // dissolving the whole label would be worse than a hard edge.
  if (w <= kEdgeFadeWidth) {
    return const LinearGradient(colors: [Colors.white, Colors.white])
        .createShader(bounds);
  }
  return LinearGradient(
    stops: [0, 1 - kEdgeFadeWidth / w, 1],
    colors: [Colors.white, Colors.white, Colors.white.withValues(alpha: 0)],
  ).createShader(bounds);
}
