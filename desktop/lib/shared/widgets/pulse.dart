import 'package:flutter/material.dart';

/// The app's one "still alive" rhythm.
///
/// `t` runs 0 → 1 → 0 forever on an ease-in-out curve; [builder] turns it
/// into whatever the caller is breathing — a skeleton's fill, a dot's alpha.
/// This widget owns the *timing* and nothing about the *shape*, which is what
/// lets every long-running thing in the app beat at the same tempo instead of
/// each pane hand-rolling its own `AnimationController`. That animation had
/// been written three separate times (the status LED, the login mark, the
/// model pill) and only two honoured Reduce Motion — the same heartbeat at
/// three tempos, one of them still moving for someone who had asked it to
/// stop.
///
/// Two decisions live here so no call site has to remember them:
///
/// - **Reduce Motion stops the beat at the peak (`t = 1`), not the middle.**
///   A block frozen at 40% opacity reads as *disabled*, which is the opposite
///   of what a placeholder means.
/// - **The [RepaintBoundary] is inside.** Everything built on this is
///   long-running by definition, and the shell keeps rail, bar and pane in one
///   layer — without the boundary a breathing skeleton in the sidebar repaints
///   the terminal beside it sixty times a second.
class Pulse extends StatefulWidget {
  const Pulse({
    super.key,
    required this.builder,
    this.duration = const Duration(milliseconds: 1600),
    this.curve = Curves.easeInOut,
    this.child,
  });

  /// Called with `t` in `[0, 1]`. [child] is passed through untouched so a
  /// subtree that does not depend on `t` is built once.
  final Widget Function(BuildContext context, double t, Widget? child) builder;

  /// One half of the cycle — rest to peak. The whole breath is twice this.
  ///
  /// 1600ms is the status LED's blink, which is what the bare default serves.
  /// A skeleton asks for 1100 explicitly; slower reads as calmer, and the two
  /// are different instruments rather than one drifting.
  final Duration duration;

  final Curve curve;
  final Widget? child;

  @override
  State<Pulse> createState() => _PulseState();
}

class _PulseState extends State<Pulse> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: widget.duration,
  );
  late final Animation<double> _t = CurvedAnimation(
    parent: _controller,
    curve: widget.curve,
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.disableAnimationsOf(context)) {
      _controller
        ..stop()
        ..value = 1;
    } else if (!_controller.isAnimating) {
      _controller.repeat(reverse: true);
    }
  }

  @override
  void didUpdateWidget(covariant Pulse oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.duration != widget.duration) {
      _controller.duration = widget.duration;
      if (_controller.isAnimating) _controller.repeat(reverse: true);
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => RepaintBoundary(
    child: AnimatedBuilder(
      animation: _t,
      child: widget.child,
      builder: (context, child) => widget.builder(context, _t.value, child),
    ),
  );
}

/// A soft-glowing dot that blinks to signal "live" — the status LED used by the
/// playground pill and anywhere else a thing is running.
class PulseDot extends StatelessWidget {
  const PulseDot({super.key, required this.color, this.size = 6});

  final Color color;
  final double size;

  @override
  Widget build(BuildContext context) {
    return Pulse(
      builder: (context, t, _) {
        final opacity = 0.4 + 0.6 * t;
        return Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: color.withValues(alpha: opacity),
            boxShadow: [
              BoxShadow(
                color: color.withValues(alpha: 0.5 * opacity),
                blurRadius: size * 0.85,
              ),
            ],
          ),
        );
      },
    );
  }
}
