import 'dart:async';

import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

import 'voice_language_store.dart';
import 'voice_input_controller.dart';
import 'voice_mic_action.dart';
import 'voice_mic_button.dart';
import 'voice_mic_mode.dart';

/// The mic, floating over the terminal's bottom right corner at the top of
/// [TerminalActionColumn].
///
/// ⚠️ **Floating rather than in a row.** A row under the terminal would take
/// its height off the remote shell; floating, the button costs the terminal
/// nothing but the corner it covers.
///
/// ⚠️ **The corner, deliberately — not centred, and not over the middle.** A
/// terminal's newest output is the line being read, and it runs left to right:
/// the right end of the last few lines is the least of it.
///
/// ⚠️ **The `×` is NOT here.** It is in the pill beside the mic, next to the
/// words it dismisses — see `voice_status_pill.dart`.
class VoiceMicFab extends StatefulWidget {
  const VoiceMicFab({
    super.key,
    required this.voice,
    required this.session,
    this.onSlipChanged,
  });

  final VoiceInputController voice;
  final TerminalSession session;

  /// The thumb crossed in or out of the button mid-hold, in
  /// [VoiceMicMode.holdToTalk]. Unused in the tap mode, which has no hold.
  final ValueChanged<bool>? onSlipChanged;

  /// What the whole floating cluster asks of the corner it sits in.
  ///
  /// Bigger than [VoiceMicButton.extent] because the mic's hit area spills past
  /// its slot: this is what the page keeps clear of anything else tappable.
  static const double extent = VoiceMicButton.touchExtent;

  /// How far the cluster sits from the terminal's right and bottom edges.
  static const double inset = 8;

  @override
  State<VoiceMicFab> createState() => _VoiceMicFabState();
}

class _VoiceMicFabState extends State<VoiceMicFab> {
  VoiceInputController get voice => widget.voice;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return ListenableBuilder(
      listenable: Listenable.merge([voice, widget.session]),
      builder: (context, _) => _mic(context),
    );
  }

  Widget _mic(BuildContext context) {
    final action = voiceMicAction(voice, widget.session);
    return VoiceMicButton(
      face: action.face,
      onPressed: action.onPressed,
      // ⚠️ No language shortcut in hold-to-talk: press-and-hold is what records
      // there, and a picker opening out of a held mic would fire in the middle
      // of every sentence. Settings ▸ Voice language is the way to it.
      onLongPress: micHoldsToTalk
          ? null
          : () => unawaited(showVoiceLanguagePicker(context)),
      onHoldStart: action.onHoldStart,
      onHoldFinish: action.onHoldFinish,
      onSlipChanged: widget.onSlipChanged,
    );
  }
}
