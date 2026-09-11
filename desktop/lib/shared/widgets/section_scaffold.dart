import 'package:flutter/material.dart';

/// Consistent padded frame for a nav section: a title, optional subtitle, and
/// the section body. Reused by every section view.
///
/// Copied from Grid's `shared/widgets/section_scaffold.dart` so a settings
/// screen is laid out identically in both apps — same as the rest of
/// `lib/shared/`. Keep the two in step.
class SectionScaffold extends StatelessWidget {
  const SectionScaffold({
    super.key,
    required this.title,
    required this.child,
    this.subtitle,
  });

  final String title;
  final String? subtitle;

  /// Fills the space under the rule, so a body that can outgrow the window
  /// brings its own scroll view.
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: theme.textTheme.headlineSmall),
          if (subtitle != null) ...[
            const SizedBox(height: 4),
            Text(
              subtitle!,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
          const SizedBox(height: 16),
          const Divider(height: 1),
          const SizedBox(height: 16),
          Expanded(child: child),
        ],
      ),
    );
  }
}
