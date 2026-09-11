import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// The caption over a control — ABOVE it, never floating into its rim.
///
/// Material animates `InputDecoration.labelText` into the border when a field
/// focuses or fills, which leaves a form where an empty field wears its label as
/// a placeholder and a filled one wears it notched into the outline: it reads as
/// focused when nothing is focused. macOS does not move labels, so
/// `labelText:` is not used anywhere in this app.
///
/// ⚠️ Sentence case, at the control font. This replaces an earlier `SettingLabel`
/// that set captions in tracked 10.5pt UPPERCASE — a web-dashboard idiom that
/// System Settings and Finder never use, and at 0.84 of letter-spacing well past
/// the point [AppFont.trackingFor] calls a logotype. Group headers that really
/// are headers keep their own treatment; this is for the caption on ONE control.
class FieldLabel extends StatelessWidget {
  const FieldLabel(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Text(
        text,
        style: Theme.of(context).textTheme.labelMedium
            ?.copyWith(color: AppPalette.textSecondary),
      ),
    );
  }
}

/// The app's field chrome: a soft borderless capsule that grows a rim only on
/// focus.
///
/// [fill] defaults to [AppPalette.cardBg], which is chosen to read on the PAGE.
///
/// ⚠️ A field placed on a RAISED block — a dialog, a card — has to pass
/// `fill: AppCard.inset` instead. Against `#202020` in dark the default lands at
/// 1.023:1 and an unfocused field dissolves into the surface behind it; in light
/// it is the other way round. Do NOT fix that by adding a border: depth in this
/// app comes from fill and shadow, and the one border it allows belongs to the
/// menu panel.
InputDecoration labeledFieldDecoration(String hint, {Color? fill}) {
  final radius = BorderRadius.circular(AppControl.radius);
  return InputDecoration(
    hintText: hint,
    filled: true,
    fillColor: fill ?? AppPalette.cardBg,
    isDense: true,
    contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
    border: OutlineInputBorder(
      borderRadius: radius,
      borderSide: BorderSide.none,
    ),
    enabledBorder: OutlineInputBorder(
      borderRadius: radius,
      borderSide: BorderSide.none,
    ),
    focusedBorder: OutlineInputBorder(
      borderRadius: radius,
      // The one rim a field earns: macOS rings the focused control in the
      // accent, and without it a focused field is indistinguishable from an
      // idle one.
      borderSide: BorderSide(color: AppPalette.accent, width: 1.5),
    ),
  );
}
