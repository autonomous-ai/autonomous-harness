import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

/// The small uppercase line over one run of a phone list — "Linked", "Recent".
class PhoneSectionLabel extends StatelessWidget {
  const PhoneSectionLabel(
    this.text, {
    super.key,
    this.padding = const EdgeInsets.fromLTRB(4, 8, 4, 8),
  });

  final String text;

  /// Lines the label up with the content under it, whose inset differs by list.
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Padding(
      padding: padding,
      child: Text(
        text.toUpperCase(),
        style: TextStyle(
          color: AppPalette.textFaint,
          fontSize: 11.5,
          fontWeight: FontWeight.w600,
          letterSpacing: 0.5,
        ),
      ),
    );
  }
}
