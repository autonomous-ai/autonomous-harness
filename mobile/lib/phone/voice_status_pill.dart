import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

import 'voice_input_controller.dart';
import 'voice_mic_action.dart';

/// What the mic is doing, in words, floating beside it — with the `×` that
/// calls it off.
///
/// ```
///   ( Listening… tap ✓ when done   × )  (✓)
/// ```
///
/// ⚠️ **The `×` is the way out of every step, and what it undoes depends on
/// the step.** While the mic is opening, recording or transcribing, it throws
/// the take away. Once the words are written into the prompt, it takes them
/// back OUT of the prompt — they are on the remote screen by then, and a cancel
/// that left them there would not be one. With a notice up, it dismisses it.
///
/// ⚠️ **Nothing at rest.** The pill exists only while there is something to
/// read; a label that stayed would sit over the terminal's newest lines.
class VoiceStatusPill extends StatelessWidget {
  const VoiceStatusPill({
    super.key,
    required this.voice,
    required this.session,
  });

  final VoiceInputController voice;

  /// The terminal the mic is on — whose prompt staged words are erased from.
  final TerminalSession session;

  /// The pill's height: the mic's visible circle, less a little, so the two
  /// read as one control rather than two of a size.
  static const double height = 36;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return ListenableBuilder(
      listenable: voice,
      builder: (context, _) {
        final notice = voice.notice;
        final label =
            notice ??
            voiceActivityLabel(voice, session) ??
            (voice.transcript.isNotEmpty ? 'Tap ↑ to send again' : null);
        return AnimatedSwitcher(
          duration: const Duration(milliseconds: 180),
          transitionBuilder: (child, animation) =>
              FadeTransition(opacity: animation, child: child),
          layoutBuilder: (current, previous) => Stack(
            alignment: Alignment.centerRight,
            children: [...previous, ?current],
          ),
          child: label == null
              ? const SizedBox.shrink(key: ValueKey('voice-pill-none'))
              : _Pill(
                  key: const ValueKey('voice-pill'),
                  label: label,
                  warn: notice != null,
                  // A send already on its way cannot be recalled, so no `×`
                  // offers to.
                  onCancel: voice.isSending ? null : _cancel,
                ),
        );
      },
    );
  }

  void _cancel() {
    if (voice.isStagedIn(session)) {
      voice.discardStaged((text) => eraseFromPrompt(session, text));
    } else {
      voice.clear();
    }
  }
}

class _Pill extends StatelessWidget {
  const _Pill({
    super.key,
    required this.label,
    required this.warn,
    required this.onCancel,
  });

  final String label;

  /// A notice — something that went wrong — rather than what the mic is doing.
  final bool warn;

  final VoidCallback? onCancel;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final onCancel = this.onCancel;
    return Container(
      height: VoiceStatusPill.height,
      padding: EdgeInsets.only(left: 14, right: onCancel == null ? 14 : 2),
      decoration: BoxDecoration(
        color: AppGlass.surfaceFill,
        borderRadius: BorderRadius.circular(VoiceStatusPill.height / 2),
        border: Border.all(color: AppGlass.lift),
        // It floats over streaming output, like the buttons beside it, and
        // needs the same lift to keep its edge over a bright line.
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.35),
            blurRadius: 10,
            offset: const Offset(0, 2),
          ),
        ],
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w500,
                color: warn ? AppPalette.warn : AppPalette.accentOnSurface,
              ),
            ),
          ),
          if (onCancel != null)
            Semantics(
              button: true,
              label: 'Cancel',
              child: GestureDetector(
                key: const ValueKey('voice-cancel'),
                behavior: HitTestBehavior.opaque,
                onTap: onCancel,
                child: SizedBox(
                  width: 34,
                  height: VoiceStatusPill.height,
                  child: Icon(
                    LucideIcons.x300,
                    size: 16,
                    color: AppPalette.textSecondary,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
