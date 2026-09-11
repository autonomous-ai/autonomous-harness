import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// A heading for one group inside a screen — "Theme", "Typography" — sitting
/// under the screen's own title and above the rows it names.
///
/// 19pt semibold with a touch of negative tracking, which is a step of its own
/// rather than a ramp entry: it only has to out-rank the `medium` row titles
/// BELOW it, not the screen title above. Reaching for `headlineSmall` (25) here
/// makes every group look like a new screen; reaching for `titleSmall` (14.5)
/// leaves the group indistinguishable from its own contents.
///
/// A widget rather than a style so the size cannot drift: before this existed
/// each pane invented its own, which is how one app ends up with four different
/// answers to "how big is a section title".
class SectionHeading extends StatelessWidget {
  const SectionHeading(this.title, {super.key, this.subtitle});

  final String title;

  /// One line saying what the group is for. Optional, and worth skipping when
  /// the heading is already obvious — an explanation nobody needed reads as
  /// noise between the reader and the controls.
  final String? subtitle;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final subtitle = this.subtitle;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          title,
          style: TextStyle(
            fontFamily: AppFont.sans,
            fontFamilyFallback: AppFont.sansFallback,
            color: AppPalette.textPrimary,
            fontSize: 19,
            fontWeight: AppFont.semibold,
            letterSpacing: -0.2,
            height: 1.2,
          ),
        ),
        if (subtitle != null) ...[
          const SizedBox(height: 3),
          Text(
            subtitle,
            style: Theme.of(context).textTheme.bodySmall
                ?.copyWith(height: 1.35),
          ),
        ],
      ],
    );
  }
}
