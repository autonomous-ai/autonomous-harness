import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// "There's nothing here (yet)."
///
/// The app grew at least fourteen private one-off versions of this — `_Empty`
/// four times, `_NoAgent` three, plus `_NoJobs`, `_NoResults`, `_NoMatches`,
/// `_NoMatch`, `_NoGrid`, `_NoSelection`, `_NothingServedYet`, `_NoModelYet`.
/// Same idea every time, all `_`-private, so none could be reused and each drew
/// its icon at a different size.
///
/// Two flavours worth keeping distinct:
///  - *nothing exists yet* → give the user the action that creates the first one
///    ([action]).
///  - *nothing matches the filter* → no action; the fix is to change the query.
class EmptyState extends StatelessWidget {
  const EmptyState({
    super.key,
    required this.icon,
    required this.title,
    this.message,
    this.action,
    this.compact = false,
  });

  final IconData icon;
  final String title;

  /// One quiet line under the title. Keep it to a sentence.
  final String? message;

  /// The action that makes the emptiness go away — "New agent", "Add plugin".
  final Widget? action;

  /// Tightens the spacing for an empty state inside a card or a narrow column
  /// rather than a whole pane.
  final bool compact;

  /// Nothing matched the current search or filter. Deliberately actionless.
  const EmptyState.noMatches({super.key, this.message, this.compact = true})
    : icon = Icons.search_off_rounded,
      title = 'No matches',
      action = null;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Center(
      child: Padding(
        padding: EdgeInsets.all(compact ? 16 : 32),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: compact ? 24 : 32, color: AppPalette.textFaint),
            SizedBox(height: compact ? 10 : 14),
            Text(
              title,
              textAlign: TextAlign.center,
              style: TextStyle(
                color: AppPalette.textPrimary,
                fontSize: compact ? 13 : 14.5,
                fontWeight: FontWeight.w600,
              ),
            ),
            if (message != null) ...[
              const SizedBox(height: 6),
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 320),
                child: Text(
                  message!,
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    color: AppPalette.textSecondary,
                    fontSize: compact ? 12 : 13,
                    height: 1.4,
                  ),
                ),
              ),
            ],
            if (action != null) ...[
              SizedBox(height: compact ? 12 : 18),
              action!,
            ],
          ],
        ),
      ),
    );
  }
}
