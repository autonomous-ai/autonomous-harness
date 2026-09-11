import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// A control in a toolbar strip: 26px tall, and quiet unless it is the row's
/// action.
///
/// Copied from Grid (`shared/widgets/toolbar_pill.dart`) — its own construction
/// rather than a `FilledButton`, because a filled accent pill in a 36px toolbar
/// is the loudest thing on the surface and the node dashboard's strip sits over
/// the cards it only points at. [tinted] is as far as it goes: an accent
/// *wash*, which is what the app puts under a primary action that hasn't
/// hardened into a button.
class ToolbarPill extends StatefulWidget {
  const ToolbarPill({
    super.key,
    required this.child,
    required this.onTap,
    this.tinted = false,
    this.active = false,
    this.rimmed = false,
    this.disabledCursor,
  });

  /// The cursor to show while [onTap] is null, when `basic` would undersell why.
  ///
  /// Defaults to `basic` — the right answer for a pill that is merely not this row's action. A
  /// caller passes `forbidden` when the pointer is over something that LOOKS pressable and is
  /// deliberately refusing: the model pill mid-turn is rimmed, lit and captioned, so an arrow there
  /// reads as a dead control rather than a temporary one.
  final MouseCursor? disabledCursor;

  /// What the pill says. Its colours are the caller's — [tint] is the one to
  /// use, so the ink and the fill agree.
  final Widget child;

  /// Null while the action is in flight; the pill stops responding and keeps
  /// its shape rather than disappearing out from under the pointer.
  final VoidCallback? onTap;

  /// Washed with accent: this pill is the row's action, not one of its
  /// switches.
  final bool tinted;

  /// Drawn as though hovered — for a pill with its menu open under it.
  final bool active;

  /// Carries a hairline rim at rest, so the control is legible as a control before it is hovered.
  ///
  /// The default pill is deliberately quiet — it lives in a strip of its peers, where a rim on each
  /// would draw a row of boxes. A pill that sits ALONE among plain labels has the opposite problem:
  /// with no fill and no rim it is indistinguishable from the text beside it, and its affordance
  /// only arrives once the pointer is already on it. [AppPalette.divider] is the same hairline the
  /// app's outlined button wears, so a rimmed pill and a secondary button read as one language.
  final bool rimmed;

  /// The ink a pill of this kind carries: accent when it is the action, the
  /// ordinary text colour otherwise, and faint when it can't be pressed.
  static Color tint({required bool tinted, required bool enabled}) => !enabled
      ? AppPalette.textFaint
      : tinted
      ? AppPalette.accentOnSurface
      : AppPalette.textPrimary;

  @override
  State<ToolbarPill> createState() => _ToolbarPillState();
}

class _ToolbarPillState extends State<ToolbarPill> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final enabled = widget.onTap != null;
    final lit = widget.active || (_hovered && enabled);

    return MouseRegion(
      cursor: enabled
          ? SystemMouseCursors.click
          : widget.disabledCursor ?? SystemMouseCursors.basic,
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: GestureDetector(
        onTap: widget.onTap,
        // Opaque, not the default: the padding around the label has to answer
        // the pointer too, or the pill has dead corners.
        behavior: HitTestBehavior.opaque,
        child: AnimatedContainer(
          duration: AppMotion.hover,
          curve: AppMotion.curve,
          height: 26,
          padding: const EdgeInsets.symmetric(horizontal: 9),
          decoration: BoxDecoration(
            color: _fill(lit),
            border: widget.rimmed
                ? Border.all(color: AppPalette.divider)
                : null,
            borderRadius: BorderRadius.circular(AppControl.radius),
          ),
          // No `Center` around it: the height is already tight, so a row inside
          // centres itself — and inside a `Flexible` a Center would stretch the
          // pill across the free space instead of hugging its label.
          child: widget.child,
        ),
      ),
    );
  }

  Color _fill(bool lit) {
    if (!widget.tinted) return lit ? AppSurface.hoverFill : Colors.transparent;
    return lit ? AppSurface.accentWashHover : AppSurface.accentWash;
  }
}
