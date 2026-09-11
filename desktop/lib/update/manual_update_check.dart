import 'desktop_updater.dart';

/// Result of a user-initiated check. A manually checked version remains
/// installable even when the user skipped its background notification earlier.
class ManualUpdateCheck {
  final UpdateInfo? update;
  final bool isSkipped;

  const ManualUpdateCheck({this.update, this.isSkipped = false});

  bool get isUpToDate => update == null;
}
