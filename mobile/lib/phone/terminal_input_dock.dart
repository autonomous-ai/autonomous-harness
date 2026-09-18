import 'package:flutter/material.dart';

import 'package:harness_mobile/terminal/terminal_session.dart';

import 'terminal_key_bar.dart';

/// The bottom of a terminal page while the keyboard is up: [TerminalKeyBar] over
/// it, following the session's input state. Nothing while it is down — the foot
/// row with the mic is the page's then.
///
/// ⚠️ **The row OPENS and CLOSES, rather than appearing and vanishing whole.**
/// The pane above it is an `Expanded`, so every pixel this row takes is a pixel
/// the terminal loses — and it used to take all of them in a single frame, on
/// the tap, while the keyboard underneath it was only beginning to rise. The
/// terminal's bottom edge therefore jumped ~47px and then slid the rest of the
/// way over the ~250ms the keyboard spends travelling: one move of one edge,
/// arriving as a jump followed by a slide. That is the judder.
///
/// Opened over [slide] instead, the two move together and the edge travels once.
///
/// ⚠️ **Timed, not driven by the keyboard's inset.** Following the inset sounds
/// stricter and cannot be done: what the row needs is the FRACTION of the rise
/// that is over, and the platform announces no keyboard height to measure that
/// against — the first frame of a rise reports an inset that means "barely
/// started" on one phone and "nearly up" on another, and taking it for a
/// fraction snaps the row open exactly as before. [slide] is matched to the
/// platform's own keyboard curve, which is the same on every phone that has one.
class TerminalInputDock extends StatefulWidget {
  const TerminalInputDock({
    super.key,
    required this.session,
    required this.keyboardUp,
    required this.onDismiss,
    this.onPickImage,
    this.onTakePhoto,
  });

  final TerminalSession session;

  /// The software keyboard is up, or has been asked for and is on its way.
  final bool keyboardUp;

  /// `⌄` on the key bar: puts the keyboard away.
  final VoidCallback onDismiss;
  final VoidCallback? onPickImage;
  final VoidCallback? onTakePhoto;

  /// How long the row takes to open or close, matched to the software
  /// keyboard's own slide: iOS animates its keyboard over 250ms and Android
  /// over roughly the same, both decelerating into place.
  ///
  /// ⚠️ Read by `TerminalPage`, which holds the remote resize for at least this
  /// long — the row is still taking pixels out of the pane after the keyboard's
  /// inset has stopped moving, and a hold that ended with the inset would let
  /// xterm size the far shell to a height this row has not finished claiming.
  static const slide = Duration(milliseconds: 250);

  @override
  State<TerminalInputDock> createState() => _TerminalInputDockState();
}

class _TerminalInputDockState extends State<TerminalInputDock>
    with SingleTickerProviderStateMixin {
  late final AnimationController _open = AnimationController(
    vsync: this,
    duration: TerminalInputDock.slide,
    // The row is on screen the moment a page arrives under a keyboard that is
    // already up — a swipe to the next agent mid-sentence — rather than sliding
    // in for a keyboard that is not moving.
    value: widget.keyboardUp ? 1 : 0,
  );

  /// Decelerating, like the keyboard it travels with. `easeOut` in, and `easeIn`
  /// out so the reverse decelerates too rather than mirroring into an
  /// accelerating close.
  late final CurvedAnimation _curve = CurvedAnimation(
    parent: _open,
    curve: Curves.easeOut,
    reverseCurve: Curves.easeIn,
  );

  @override
  void didUpdateWidget(TerminalInputDock oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.keyboardUp == oldWidget.keyboardUp) return;
    if (widget.keyboardUp) {
      _open.forward();
    } else {
      _open.reverse();
    }
  }

  @override
  void dispose() {
    _curve.dispose();
    _open.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _curve,
    // ⚠️ Built ONCE, outside the builder. The strip is rebuilt only when the
    // session changes, never on the animation's frames — every one of those
    // frames is competing with the keyboard's own slide and with whatever the
    // agent is streaming into the pane above.
    child: ListenableBuilder(
      listenable: widget.session,
      builder: (context, _) => TerminalKeyBar(
        terminal: widget.session.terminal,
        enabled: widget.session.acceptsInput,
        onClearPrompt: widget.session.clearPrompt,
        onPromptEdited: widget.session.resetInputBuffer,
        onDismissKeyboard: widget.onDismiss,
        onPickImage: widget.onPickImage,
        onTakePhoto: widget.onTakePhoto,
      ),
    ),
    builder: (context, child) {
      final factor = _curve.value;
      // Nothing left of the row, and the keyboard is gone: give the pane the
      // pixels back outright rather than leaving a zero-height box in its column.
      if (factor <= 0) return const SizedBox.shrink();
      return ClipRect(
        child: Align(
          alignment: Alignment.topCenter,
          // Laid out at its full height and revealed from the top, so nothing
          // inside reflows on the way: the keys keep their size and their places
          // — which is what [TerminalKeyBar] is built around — and only how much
          // of the strip is on screen changes.
          heightFactor: factor,
          child: child,
        ),
      );
    },
  );
}
