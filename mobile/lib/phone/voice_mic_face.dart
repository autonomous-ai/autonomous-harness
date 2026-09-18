import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/pulse.dart';

import 'floating_glass.dart';
import 'voice_mic_mode.dart';

/// What the mic says it will do when tapped.
enum VoiceMicFace {
  /// At rest: tap to talk.
  talk,

  /// The microphone is opening: tap to call it off.
  starting,

  /// Recording: tap Send, and what was said is sent. It breathes while it
  /// listens.
  listening,

  /// Transcribing or sending: nothing to tap until that is back.
  busy,

  /// A send failed and its words are held: tap to send them again.
  retry,

  /// The microphone was refused: tap to ask again.
  off,

  /// Recording with the thumb dragged off the button — letting go now throws
  /// the take away. [VoiceMicMode.holdToTalk] only.
  ///
  /// Its own face rather than a flag on [listening] because it is the opposite
  /// promise: the ring stops breathing, the fill goes to the warning colour and
  /// the glyph becomes a `×`. What is about to happen has to be readable at a
  /// glance, by someone whose thumb is covering the button.
  cancelling,
}

/// The mic's fill for [face].
///
/// Cancelling takes the warning colour: the button is about to throw away what
/// was just said, and that is not something the accent — which everywhere else
/// in the app means "go" — should be saying.
///
/// Listening is the accent's blue: the next tap sends.
Color voiceMicTint(VoiceMicFace face) => switch (face) {
  VoiceMicFace.cancelling => AppPalette.warn,
  _ => AppPalette.accent,
};

/// The round, filled part of the mic: its colour, its glow, and the glyph for
/// what a press will do.
class VoiceMicCore extends StatelessWidget {
  const VoiceMicCore({super.key, required this.face, required this.lit});

  /// The visible circle's diameter — the ring breathes out from the same size.
  static const double diameter = 48;

  final VoiceMicFace face;
  final bool lit;

  Color get _tint => voiceMicTint(face);

  @override
  Widget build(BuildContext context) => FloatingGlass(child: _circle());

  Widget _circle() => AnimatedContainer(
    duration: const Duration(milliseconds: 220),
    curve: Curves.easeOutCubic,
    width: VoiceMicCore.diameter,
    height: VoiceMicCore.diameter,
    decoration: BoxDecoration(
      shape: BoxShape.circle,
      gradient: lit
          ? LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [Color.lerp(_tint, Colors.white, 0.18)!, _tint],
            )
          : null,
      color: lit ? null : floatingButtonFill,
      border: Border.all(
        color: lit ? Colors.white.withValues(alpha: 0.28) : floatingButtonRim,
      ),
      // ⚠️ **Two different shadows for two different jobs, and the resting one
      // is not optional.** Lit, the button glows in its own colour — that is
      // state, saying the mic is open. At rest it casts a plain drop shadow
      // instead: it floats over streaming output rather than over a surface, and
      // without one its edge disappears against every dark line it happens to
      // sit on. The screenshot that prompted this had it all but invisible.
      boxShadow: lit
          ? [
              BoxShadow(color: _tint.withValues(alpha: 0.4), blurRadius: 12),
              // The lift, under the glow. The glow says "recording"; it does
              // not separate the circle from the text behind it, because it is
              // the same brightness as the accent the terminal itself uses.
              BoxShadow(
                color: Colors.black.withValues(alpha: 0.35),
                blurRadius: 10,
                offset: const Offset(0, 3),
              ),
            ]
          // ⚠️ Kept light: a box shadow paints under the WHOLE circle, and
          // the fill is not opaque — a heavy one showed through as a dark disc.
          : floatingButtonShadow,
    ),
    child: Center(
      child: AnimatedSwitcher(
        duration: const Duration(milliseconds: 160),
        child: _Glyph(key: ValueKey(face), face: face, lit: lit),
      ),
    ),
  );
}

class _Glyph extends StatelessWidget {
  const _Glyph({super.key, required this.face, required this.lit});

  final VoiceMicFace face;
  final bool lit;

  @override
  Widget build(BuildContext context) {
    if (face == VoiceMicFace.busy) {
      return SizedBox.square(
        dimension: 21,
        child: CircularProgressIndicator(
          strokeWidth: 2.4,
          color: AppPalette.accent,
        ),
      );
    }
    return Icon(
      switch (face) {
        // ⚠️ In hold-to-talk the arrow would be a lie: nothing is sent by
        // pressing this, it is sent by letting go. The mic stays up for the
        // whole take and the thumb never leaves it, so there is no second press
        // for an arrow to describe.
        //
        // The mic stays the glyph while it listens; the blue fill is what
        // says the next tap sends — see [voiceMicTint].
        VoiceMicFace.listening => LucideIcons.mic300,
        VoiceMicFace.retry => LucideIcons.arrowUp300,
        VoiceMicFace.cancelling => LucideIcons.x300,
        VoiceMicFace.off => LucideIcons.micOff300,
        VoiceMicFace.talk ||
        VoiceMicFace.starting ||
        VoiceMicFace.busy => LucideIcons.mic300,
      },
      size: 25,
      color: lit
          ? Colors.white
          : face == VoiceMicFace.off
          ? AppPalette.textFaint
          : AppPalette.textPrimary,
    );
  }
}

/// The glow that swells out of the button while it listens, on the app's one
/// [Pulse] — which is also what holds it still under Reduce Motion.
class VoiceMicRing extends StatelessWidget {
  const VoiceMicRing({super.key});

  @override
  Widget build(BuildContext context) => Pulse(
    duration: const Duration(milliseconds: 900),
    curve: Curves.easeOut,
    builder: (context, t, _) => Transform.scale(
      scale: 1 + 0.45 * t,
      child: Container(
        width: VoiceMicCore.diameter,
        height: VoiceMicCore.diameter,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: voiceMicTint(VoiceMicFace.listening)
              .withValues(alpha: 0.35 * (1 - t)),
        ),
      ),
    ),
  );
}
