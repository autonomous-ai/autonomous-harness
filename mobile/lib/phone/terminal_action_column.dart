import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

import 'voice_input_controller.dart';
import 'voice_mic_button.dart';
import 'voice_mic_face.dart';
import 'voice_mic_fab.dart';
import 'voice_status_pill.dart';

/// The terminal's floating controls, stacked in its bottom-right corner:
/// the mic, then Search, then New agent.
///
/// ```
///   ( Listening…  × )  (🎤)
///                      (🔍)
///                      (＋)
/// ```
///
/// ⚠️ **The mic is on top, and that is what "moved up" means.** It used to sit
/// alone in the corner, over the agent's own status line; Search and New agent
/// now take the corner under it, and the mic rides above them. The three share
/// one column so they read as one set of controls rather than three strays.
///
/// ⚠️ **The gaps are set by the mic's hit area, not by the look.** The mic's
/// target spills [VoiceMicButton.touchOverhang] past its slot on every side and
/// is generous on purpose — a button under it that sat any closer would lose
/// the top of its own target to the mic, and a tap aimed at Search would start
/// a recording.
class TerminalActionColumn extends StatelessWidget {
  const TerminalActionColumn({
    super.key,
    required this.voice,
    required this.session,
    required this.onSearch,
    required this.onNewAgent,
  });

  final VoiceInputController voice;

  /// Null while the terminal is still attaching: no mic, since there is nothing
  /// to talk to yet, but Search and New agent stay where the thumb expects them.
  final TerminalSession? session;

  final VoidCallback onSearch;

  /// Null when the machine cannot host a new agent right now — offline, or
  /// still asking for its password. The button is left out rather than drawn
  /// dead.
  final VoidCallback? onNewAgent;

  /// The column's width: the mic's slot, which the smaller buttons centre under.
  static const double width = VoiceMicButton.extent;

  /// How far the column sits from the terminal's right and bottom edges.
  static const double inset = VoiceMicFab.inset;

  /// How far the column sits above the terminal's bottom edge — higher than
  /// [inset], so the `＋` clears the agent's own status line under it.
  static const double bottomInset = 172;

  /// The DRAWN gap between one circle and the next, the same all the way down.
  ///
  /// ⚠️ No smaller than the mic's overhang plus a button's, less the slack
  /// between the mic's slot and its drawn face — any closer and the mic's
  /// target would swallow the top of Search's.
  static const double _gap = 22;

  /// The mic's slot is larger than its drawn circle, so the gap under the slot
  /// is [_gap] less that slack.
  static const double _underMic =
      _gap - (VoiceMicButton.extent - VoiceMicCore.diameter) / 2;

  /// Between Search and New agent: circles in slots of their own size.
  static const double _between = _gap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final session = this.session;
    final onNewAgent = this.onNewAgent;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        if (session != null) ...[
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              // Left of the mic, on its centreline: the words the mic has
              // nowhere to put, and the `×` that calls it off.
              ConstrainedBox(
                constraints: BoxConstraints(
                  maxWidth:
                      (MediaQuery.sizeOf(context).width -
                              width -
                              inset * 2 -
                              24)
                          .clamp(0, double.infinity),
                ),
                child: VoiceStatusPill(voice: voice),
              ),
              const SizedBox(width: 6),
              VoiceMicFab(voice: voice, session: session),
            ],
          ),
          const SizedBox(height: _underMic),
        ],
        _centred(
          TerminalRoundAction(
            key: const ValueKey('terminal-search'),
            icon: LucideIcons.search300,
            label: 'Search agents and machines',
            onTap: onSearch,
          ),
        ),
        if (onNewAgent != null) ...[
          const SizedBox(height: _between),
          _centred(
            TerminalRoundAction(
              key: const ValueKey('terminal-new-agent'),
              icon: LucideIcons.plus300,
              label: 'New agent',
              onTap: onNewAgent,
            ),
          ),
        ],
      ],
    );
  }

  Widget _centred(Widget child) => SizedBox(
    width: width,
    child: Center(child: child),
  );
}

/// A round floating button in the mic's style, one size down.
///
/// ⚠️ Smaller than the mic, and that is the right way round: the mic is the
/// page's one action, and these are tapped once and rarely.
class TerminalRoundAction extends StatelessWidget {
  const TerminalRoundAction({
    super.key,
    required this.icon,
    required this.label,
    required this.onTap,
  });

  final IconData icon;

  /// For screen readers and the long-press tooltip.
  final String label;

  final VoidCallback onTap;

  /// The drawn circle.
  static const double diameter = 42;

  /// What the finger may land on, spilling past the circle on every side.
  static const double touchExtent = 50;

  static const double touchOverhang = (touchExtent - diameter) / 2;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Semantics(
      button: true,
      label: label,
      child: Tooltip(
        message: label,
        child: SizedBox.square(
          dimension: diameter,
          child: OverflowBox(
            maxWidth: touchExtent,
            maxHeight: touchExtent,
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: onTap,
              child: SizedBox.square(
                dimension: touchExtent,
                child: Center(
                  child: Container(
                    width: diameter,
                    height: diameter,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      // The mic's resting look: see-through, so the output
                      // under the button stays readable, with a light shadow
                      // to keep the edge — see [floatingButtonFill].
                      color: floatingButtonFill,
                      border: Border.all(color: AppGlass.lift),
                      boxShadow: floatingButtonShadow,
                    ),
                    child: Icon(icon, size: 20, color: AppPalette.textPrimary),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
