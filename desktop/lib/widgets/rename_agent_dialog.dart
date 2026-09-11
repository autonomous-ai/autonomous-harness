import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';

/// The one "Edit name" dialog, opened from every place a name is shown.
///
/// Pulled out of the rail so the pane header could use it too: two copies would
/// have been two sets of error handling for one rename, and the second is the
/// one that quietly stops matching.
///
/// Keyboard-complete on purpose — autofocus, Enter submits, Escape closes —
/// because the way in is a double click but the way through should never need
/// the mouse again.
Future<void> showAgentRenameDialog(
  BuildContext context,
  AppNotifier notifier,
  String machineId,
  String agentId,
  String currentName,
) => showAppDialog<void>(
  context: context,
  builder: (_) => _RenameAgentDialog(
    notifier: notifier,
    machineId: machineId,
    agentId: agentId,
    currentName: currentName,
  ),
);

/// ⚠️ A widget that OWNS its controller, not a `StatefulBuilder` over one made
/// beside `showDialog`.
///
/// That is what this file used to be, and it crashed the app on Escape: the
/// controller was disposed the moment `showDialog`'s future resolved, which is
/// when the route STARTS animating out — the dialog is still on screen and
/// still rebuilding for the length of that transition, and the first rebuild
/// after the dispose threw "A TextEditingController was used after being
/// disposed" and took the window to a red screen.
///
/// A `State` disposes on unmount instead, which happens after the transition
/// has finished and the route is gone, so there is nothing left to rebuild.
class _RenameAgentDialog extends StatefulWidget {
  const _RenameAgentDialog({
    required this.notifier,
    required this.machineId,
    required this.agentId,
    required this.currentName,
  });

  final AppNotifier notifier;
  final String machineId;
  final String agentId;
  final String currentName;

  @override
  State<_RenameAgentDialog> createState() => _RenameAgentDialogState();
}

class _RenameAgentDialogState extends State<_RenameAgentDialog> {
  late final _controller = TextEditingController(text: widget.currentName);

  /// The CLI's refusal, shown under the field. Null until one arrives.
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final result = await widget.notifier.renameAgent(
      widget.machineId,
      widget.agentId,
      _controller.text,
    );
    if (!mounted) return;
    if (result == null) {
      Navigator.of(context).pop();
      return;
    }
    setState(() => _error = result);
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return AlertDialog(
      title: const Text('Edit name'),
      content: SizedBox(
        width: 360,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TextField(
              controller: _controller,
              autofocus: true,
              style: grid.kFieldTextStyle,
              onSubmitted: (_) => _submit(),
            ),
            if (_error case final error?) ...[
              const SizedBox(height: 10),
              Text(
                error,
                style: TextStyle(
                  color: grid.AppPalette.dangerFill,
                  fontFamily: grid.AppFont.sans,
                  fontSize: 11.2,
                ),
              ),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(onPressed: _submit, child: const Text('Save')),
      ],
    );
  }
}
