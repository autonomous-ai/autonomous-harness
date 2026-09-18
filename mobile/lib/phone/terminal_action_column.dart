import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

import 'floating_glass.dart';
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

  /// Null while the terminal is still attaching: the mic is drawn dimmed and
  /// dead, since there is nothing to talk to yet.
  final TerminalSession? session;

  final VoidCallback onSearch;

  /// Null when the machine cannot host a new agent right now — offline, still
  /// asking for its password, or not loaded yet after a restart.
  ///
  /// ⚠️ **Drawn dimmed, never left out.** All three buttons are always there:
  /// a `+` that came and went with the machine's state made the column jump,
  /// and read as a missing button rather than one not ready yet.
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
    // One backdrop read for the three buttons' blurs — see [FloatingGlass].
    return BackdropGroup(child: _column(context, session));
  }

  Widget _column(BuildContext context, TerminalSession? session) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        if (session != null)
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
          )
        else
          // Still attaching: the mic in its place, dimmed and dead.
          const VoiceMicButton(face: VoiceMicFace.talk, onPressed: null),
        const SizedBox(height: _underMic),
        _centred(
          TerminalRoundAction(
            key: const ValueKey('terminal-search'),
            icon: LucideIcons.search300,
            label: 'Search agents and machines',
            onTap: onSearch,
          ),
        ),
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

  /// Null draws the button dimmed and dead, the way the mic is.
  final VoidCallback? onTap;

  /// The drawn circle.
  static const double diameter = 42;

  /// What the finger may land on, spilling past the circle on every side.
  static const double touchExtent = 50;

  static const double touchOverhang = (touchExtent - diameter) / 2;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final live = onTap != null;
    return Semantics(
      button: true,
      enabled: live,
      label: label,
      child: Tooltip(
        message: label,
        child: SizedBox.square(
          dimension: diameter,
          child: OverflowBox(
            maxWidth: touchExtent,
            maxHeight: touchExtent,
            child: GestureDetector(
              // Opaque even when dead: a tap on a dimmed button must not fall
              // through to the terminal and raise the keyboard.
              behavior: HitTestBehavior.opaque,
              onTap: onTap,
              child: SizedBox.square(
                dimension: touchExtent,
                child: AnimatedOpacity(
                  // The mic's dimmed opacity, so the three read alike.
                  duration: const Duration(milliseconds: 160),
                  opacity: live ? 1 : 0.4,
                  child: Center(
                    // The mic's resting look — see [FloatingGlass].
                    child: FloatingGlass(
                      child: Container(
                        width: diameter,
                        height: diameter,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: floatingButtonFill,
                          border: Border.all(color: floatingButtonRim),
                          boxShadow: floatingButtonShadow,
                        ),
                        child: Icon(
                          icon,
                          size: 20,
                          color: AppPalette.textPrimary,
                        ),
                      ),
                    ),
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
