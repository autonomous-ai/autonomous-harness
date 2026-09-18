import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'voice_mic_face.dart';
import 'voice_mic_mode.dart';

/// The one voice control on a terminal page — a small round button floating
/// over the terminal's bottom right corner. [VoiceMicFab] is what places it.
///
/// Two ways to work it, chosen by [voiceMicMode] and nothing else:
///
///  - [VoiceMicMode.tapToToggle] — tap to start, tap again to finish the
///    sentence and send it. The face says which tap is next: a mic, then an
///    arrow. Long-press is the language shortcut.
///  - [VoiceMicMode.holdToTalk] — the recording lasts exactly as long as the
///    thumb is down, and letting go sends. Sliding off the button first throws
///    the take away, and the face turns to a `×` to say so. No long-press:
///    that gesture is what records.
///
/// ⚠️ **The swell is painted, never laid out.** The breathing ring scales past
/// the button's box with [Clip.none] rather than growing it, so nothing around
/// the button moves while it breathes.
class VoiceMicButton extends StatefulWidget {
  const VoiceMicButton({
    super.key,
    required this.face,
    required this.onPressed,
    this.onLongPress,
    this.onHoldStart,
    this.onHoldFinish,
    this.onSlipChanged,
  });

  final VoiceMicFace face;

  /// Null draws the button dimmed and dead.
  ///
  /// In [VoiceMicMode.holdToTalk] this still decides whether the button is live
  /// — a terminal that is not taking input must not record — but it is the hold
  /// callbacks below that do the work.
  final VoidCallback? onPressed;

  /// The language picker — a shortcut to the Settings row, for someone who
  /// talks in two languages. Null in [VoiceMicMode.holdToTalk], whose press and
  /// hold belong to the recording.
  final VoidCallback? onLongPress;

  /// The thumb went down: start recording. [VoiceMicMode.holdToTalk] only.
  final VoidCallback? onHoldStart;

  /// The thumb came up. `cancelled` is true when it was dragged off the button
  /// first, which throws the take away instead of sending it.
  final void Function({required bool cancelled})? onHoldFinish;

  /// The thumb crossed in or out of the button mid-hold, so the row beside it
  /// can say what letting go will now do.
  ///
  /// The button's own face already turns to a `×`, but the thumb is ON the
  /// button and covering most of it — the words to the left are what somebody
  /// can actually read at that moment.
  final ValueChanged<bool>? onSlipChanged;

  /// The space this button asks of its parent's layout.
  ///
  /// ⚠️ **It no longer sets any row's height.** The mic floats over the terminal
  /// now (see `voice_mic_fab.dart`), so this is simply the box the `Positioned`
  /// sizes to — raising it costs the terminal nothing, and the hit area below
  /// already reaches well past it either way.
  static const double extent = 60;

  /// What the finger may actually land on.
  ///
  /// ⚠️ **Deliberately LARGER than [extent], and drawn outside the layout
  /// box.** Hold-to-talk asks for a press held through a whole sentence, so the
  /// target has to forgive a thumb that shifts while somebody talks. An
  /// [OverflowBox] is what allows a child bigger than its parent: the hit area
  /// reaches out over the terminal on every side, which has nothing tappable to
  /// collide with.
  static const double touchExtent = 84;

  /// How far the hit area spills past its slot on each side.
  ///
  /// What anything placed beside or above this button has to clear: the
  /// overhang is painted over its neighbour and would swallow the neighbour's
  /// presses. See the gap above the mic in `voice_mic_fab.dart`.
  static const double touchOverhang = (touchExtent - extent) / 2;

  /// How far past [touchExtent] the thumb may stray and still count as "on" the
  /// button.
  ///
  /// ⚠️ Generous on purpose — a thumb resting on the circle covers most of it,
  /// and the finger's reported point wanders by several points while somebody
  /// talks. Cancelling is meant to be a deliberate move away, not something a
  /// steady hand trips over mid-sentence.
  static const double _slipMargin = 32;

  @override
  State<VoiceMicButton> createState() => _VoiceMicButtonState();
}

class _VoiceMicButtonState extends State<VoiceMicButton> {
  /// Whether the thumb is currently outside the button, with a hold in
  /// progress. Drives the [VoiceMicFace.cancelling] face.
  bool _slippedOff = false;

  /// The pointer holding the mic down, or null with no hold in progress.
  ///
  /// ⚠️ Only the pointer that STARTED a hold may finish it. A press that landed
  /// while the button was dead started nothing, and its release must not send
  /// words held from an earlier failed send; a second finger must not end the
  /// first one's take.
  int? _holdPointer;

  bool get _live => widget.onPressed != null;

  /// What to draw: the face given, unless a hold has been dragged off the
  /// button, which only this widget knows about.
  VoiceMicFace get _face => _slippedOff && widget.face == VoiceMicFace.listening
      ? VoiceMicFace.cancelling
      : widget.face;

  bool get _lit => switch (_face) {
    VoiceMicFace.starting ||
    VoiceMicFace.listening ||
    VoiceMicFace.cancelling ||
    VoiceMicFace.retry => true,
    VoiceMicFace.talk || VoiceMicFace.busy || VoiceMicFace.off => false,
  };

  String get _semanticLabel => switch (_face) {
    VoiceMicFace.talk =>
      micHoldsToTalk ? 'Hold to talk to the agent' : 'Talk to the agent',
    VoiceMicFace.starting => 'Cancel',
    VoiceMicFace.listening =>
      micHoldsToTalk ? 'Release to send' : 'Done talking',
    VoiceMicFace.cancelling => 'Release to cancel',
    VoiceMicFace.busy => 'Working',
    VoiceMicFace.retry => 'Send again',
    VoiceMicFace.off => 'Voice input is off',
  };

  /// Whether [point], in the hit area's own coordinates, still counts as on the
  /// button.
  ///
  /// Measured against [VoiceMicButton.touchExtent] — the box the [Listener]
  /// actually covers — rather than the row slot, because that is the box the
  /// pointer's `localPosition` is reported in.
  bool _within(Offset point) {
    const extent = VoiceMicButton.touchExtent;
    const margin = VoiceMicButton._slipMargin;
    return point.dx >= -margin &&
        point.dy >= -margin &&
        point.dx <= extent + margin &&
        point.dy <= extent + margin;
  }

  void _onPointerDown(PointerDownEvent event) {
    if (!_live || _holdPointer != null) return;
    _holdPointer = event.pointer;
    _setSlipped(false);
    HapticFeedback.lightImpact();
    widget.onHoldStart?.call();
  }

  void _onPointerMove(PointerMoveEvent event) {
    if (event.pointer != _holdPointer || widget.onHoldFinish == null) return;
    final off = !_within(event.localPosition);
    if (off == _slippedOff) return;
    // Felt as well as seen: the thumb is over the button, so the change of
    // meaning has to reach the hand that cannot see it.
    HapticFeedback.selectionClick();
    _setSlipped(off);
  }

  void _onPointerUp(PointerUpEvent event) {
    if (event.pointer != _holdPointer) return;
    _holdPointer = null;
    final cancelled = _slippedOff;
    _setSlipped(false);
    widget.onHoldFinish?.call(cancelled: cancelled);
  }

  /// The gesture was taken away by the system — the app going away. Treated as
  /// a cancel: a take nobody ended deliberately must not be sent.
  void _onPointerCancel(PointerCancelEvent event) {
    if (event.pointer != _holdPointer) return;
    _holdPointer = null;
    _setSlipped(false);
    widget.onHoldFinish?.call(cancelled: true);
  }

  /// ⚠️ **A hold whose button leaves the tree mid-take is cancelled.** The
  /// button is unmounted while the thumb is still down whenever the page drops
  /// it — the keyboard coming up, the pane going away — and the release then
  /// reaches no one: without this the microphone stays open with no thumb on it
  /// until [VoiceInputController.maxTake] ends it.
  ///
  /// Deferred to a microtask: the cancel notifies listeners that rebuild, and
  /// the tree is locked while it is being finalised.
  @override
  void dispose() {
    if (_holdPointer != null) {
      final finish = widget.onHoldFinish;
      final slipChanged = _slippedOff ? widget.onSlipChanged : null;
      scheduleMicrotask(() {
        slipChanged?.call(false);
        finish?.call(cancelled: true);
      });
    }
    super.dispose();
  }

  /// ⚠️ Tells the row BEFORE rebuilding itself. The listener sits in an ancestor
  /// that rebuilds this button, so calling it inside `setState` would report the
  /// change from the middle of a build.
  void _setSlipped(bool value) {
    if (value == _slippedOff) return;
    _slippedOff = value;
    widget.onSlipChanged?.call(value);
    if (mounted) setState(() {});
  }

  /// ⚠️ **The buzz that says "the microphone is open — talk now", and
  /// hold-to-talk does not work without it.** Opening the microphone is real
  /// hardware time, and a thumb that has just pressed a button is a thumb whose
  /// owner has already started the sentence: those first words land before
  /// anything is recording, and what reaches the backend is half a sentence that
  /// transcribes to nothing. The row asks them to wait; this is what releases
  /// them, felt rather than read, because their thumb is over the button and
  /// their eyes are not necessarily on the screen.
  ///
  /// Only on the way IN to listening, and only while holding — the tap mode's
  /// own press already told them the take had begun.
  @override
  void didUpdateWidget(VoiceMicButton old) {
    super.didUpdateWidget(old);
    if (!micHoldsToTalk) return;
    if (old.face != VoiceMicFace.listening &&
        widget.face == VoiceMicFace.listening) {
      HapticFeedback.mediumImpact();
    }
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Semantics(
      button: true,
      enabled: _live,
      label: _semanticLabel,
      onLongPressHint: widget.onLongPress == null ? null : 'Choose language',
      // ⚠️ **The slot is [VoiceMicButton.extent]; the hit area inside it is the
      // larger [VoiceMicButton.touchExtent], spilling out on every side.** The
      // [OverflowBox] is what allows a child bigger than its parent without the
      // parent growing — so the row, and the terminal above it, keep their
      // heights while the finger gets a target half again as wide.
      //
      // `Clip.none` on the stack matters for the same reason: the ring already
      // paints past the core, and clipping to the slot would cut both it and
      // the overflowing hit area back to nothing.
      child: SizedBox.square(
        dimension: VoiceMicButton.extent,
        child: OverflowBox(
          maxWidth: VoiceMicButton.touchExtent,
          maxHeight: VoiceMicButton.touchExtent,
          child: _gestures(
            child: SizedBox.square(
              dimension: VoiceMicButton.touchExtent,
              child: AnimatedOpacity(
                duration: const Duration(milliseconds: 160),
                opacity: _live ? 1 : 0.4,
                child: Stack(
                  alignment: Alignment.center,
                  clipBehavior: Clip.none,
                  children: [
                    // ⚠️ Not while cancelling: the ring means "listening, carry
                    // on talking", and leaving it breathing under a `×` would
                    // say both things at once.
                    if (_face == VoiceMicFace.listening) const VoiceMicRing(),
                    VoiceMicCore(face: _face, lit: _lit),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// ⚠️ **A [Listener], not a [GestureDetector], and the difference is what
  /// makes hold-to-talk work at all.** A gesture detector's long-press only
  /// fires after the press delay, and reports a drag off the button as the
  /// press being cancelled — so recording would start a beat late and end the
  /// moment the thumb wandered. Raw pointer events start the take on the frame
  /// the finger lands and keep reporting while it moves, which is what lets the
  /// button tell "still talking" from "slid off to cancel".
  ///
  /// The tap mode keeps its [GestureDetector]: there is nothing to track
  /// between the two taps, and it comes with the tap-cancel semantics that mode
  /// wants.
  Widget _gestures({required Widget child}) {
    if (!micHoldsToTalk) {
      return GestureDetector(
        key: const ValueKey('voice-mic'),
        behavior: HitTestBehavior.opaque,
        onTap: _live
            ? () {
                HapticFeedback.lightImpact();
                widget.onPressed!();
              }
            : null,
        onLongPress: widget.onLongPress,
        child: child,
      );
    }
    // ⚠️ **The drag recognizers are here to WIN the arena, and do nothing else.**
    // A [Listener] never enters the gesture arena, so the pager this button sits
    // in would otherwise take any thumb that shifted past touch slop mid-sentence
    // and swipe to the next agent under a live take. Being deeper in the tree,
    // these accept first and the pager's drag never starts; the raw pointer
    // events above keep arriving either way.
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onHorizontalDragStart: (_) {},
      onVerticalDragStart: (_) {},
      child: Listener(
        key: const ValueKey('voice-mic'),
        behavior: HitTestBehavior.opaque,
        onPointerDown: _onPointerDown,
        onPointerMove: _onPointerMove,
        onPointerUp: _onPointerUp,
        onPointerCancel: _onPointerCancel,
        child: child,
      ),
    );
  }
}
