import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import 'engine_identity.dart';

/// Shared Stop Agent confirmation. The legacy agent_delete request stops the
/// engine and removes its active entry, preserving files and saved history.
///
/// [engine] tells the dialog what it is ending: a terminal (`kTerminalEngine`)
/// is a shell, and closing one ends whatever was running in it — said in
/// those words, since "agent" and "conversation history" mean nothing to it.
Future<void> confirmDeleteAgent(
  BuildContext context,
  AppNotifier notifier,
  String machineId,
  String agentId,
  String name, {
  String? engine,
}) async {
  final terminal = isTerminalEngine(engine);
  final verb = terminal ? 'Stop Terminal' : 'Stop Harness';
  final confirmed = await showAppDialog<bool>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      title: Text(verb),
      content: SizedBox(
        width: 360,
        child: Text(
          terminal
              ? 'Stop “$name”? This closes the shell and ends anything still '
                    'running in it. Files are kept.'
              : 'Stop “$name”? This ends the running agent and removes it from your '
                    'active agents. Project files and saved conversation history are kept.',
          style: TextStyle(fontFamily: grid.AppFont.sans, fontSize: 13.5),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(dialogContext).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          style: FilledButton.styleFrom(
            backgroundColor: grid.AppPalette.dangerFill,
          ),
          onPressed: () => Navigator.of(dialogContext).pop(true),
          child: Text(verb),
        ),
      ],
    ),
  );
  if (confirmed != true || !context.mounted) return;
  final error = await notifier.deleteAgent(machineId, agentId);
  if (error != null && context.mounted) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(error)));
  }
}
