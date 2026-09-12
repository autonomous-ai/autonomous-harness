import 'dart:async';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';

import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_select_field.dart';
import '../state/app_state.dart';
import '../state/swarm_catalog.dart';
import 'link_machine_dialog.dart';
import 'link_machine_screen.dart';
import 'remote_folder_picker.dart';
import 'swarm_welcome.dart';

Future<SwarmAgentRef?> showSwarmAgentPicker(
  BuildContext context,
  AppNotifier notifier,
  VoidCallback onNew,
) => showAppDialog<SwarmAgentRef>(
  context: context,
  builder: (_) => _AgentPicker(notifier: notifier, onNew: onNew),
);

class _AgentPicker extends StatefulWidget {
  const _AgentPicker({required this.notifier, required this.onNew});
  final AppNotifier notifier;
  final VoidCallback onNew;
  @override
  State<_AgentPicker> createState() => _AgentPickerState();
}

class _AgentPickerState extends State<_AgentPicker> {
  String query = '';
  @override
  Widget build(BuildContext context) => Dialog(
    child: SizedBox(
      width: 620,
      height: 520,
      child: Padding(
        padding: const EdgeInsets.all(22),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Text(
                  'Add agent',
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.w500),
                ),
                const Spacer(),
                TextButton.icon(
                  onPressed: () {
                    widget.onNew();
                    Navigator.pop(context);
                  },
                  icon: const Icon(Icons.add, size: 16),
                  label: const Text('New agent'),
                ),
                IconButton(
                  tooltip: 'Close agent picker',
                  onPressed: () => Navigator.pop(context),
                  icon: const Icon(Icons.close, size: 18),
                ),
              ],
            ),
            const SizedBox(height: 16),
            SwarmSearchField(
              autofocus: true,
              onChanged: (value) => setState(() => query = value),
              onSubmitted: (_) {
                final rows = swarmAgents(widget.notifier, query);
                if (rows.isNotEmpty) Navigator.pop(context, rows.first);
              },
            ),
            const SizedBox(height: 16),
            Expanded(
              child: ListenableBuilder(
                listenable: widget.notifier,
                builder: (_, _) => SwarmAgentRows(
                  notifier: widget.notifier,
                  agents: swarmAgents(widget.notifier, query),
                  onAgent: (agent) => Navigator.pop(context, agent),
                ),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

Future<String?> showSwarmRenameDialog(BuildContext context, String name) async {
  final controller = TextEditingController(text: name)
    ..selection = TextSelection(baseOffset: 0, extentOffset: name.length);
  try {
    return await showAppDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Rename swarm'),
        content: SizedBox(
          width: 360,
          child: TextField(
            controller: controller,
            autofocus: true,
            maxLength: 80,
            decoration: const InputDecoration(labelText: 'Name'),
            onSubmitted: (value) => Navigator.pop(context, value),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, controller.text),
            child: const Text('Save'),
          ),
        ],
      ),
    );
  } finally {
    // The route's reverse transition may still be rendering the field.
    Future<void>.delayed(const Duration(milliseconds: 200), controller.dispose);
  }
}

Future<SavedSwarmProject?> showSwarmProjectDialog(
  BuildContext context,
  AppNotifier notifier,
) => showAppDialog<SavedSwarmProject>(
  context: context,
  builder: (_) => _ProjectDialog(notifier: notifier),
);

class _ProjectDialog extends StatefulWidget {
  const _ProjectDialog({required this.notifier});
  final AppNotifier notifier;
  @override
  State<_ProjectDialog> createState() => _ProjectDialogState();
}

class _ProjectDialogState extends State<_ProjectDialog> {
  late String? machineId =
      (widget.notifier.machineStates.values
                  .where((m) => m.isLocalMachine)
                  .firstOrNull ??
              widget.notifier.machineStates.values.firstOrNull)
          ?.machine
          .machineId;
  final name = TextEditingController();
  String? path;
  String? error;
  bool picking = false;
  @override
  void dispose() {
    name.dispose();
    super.dispose();
  }

  Future<void> browse() async {
    final id = machineId;
    if (id == null || picking) return;
    setState(() {
      picking = true;
      error = null;
    });
    try {
      final folder = widget.notifier.stateOf(id)?.isLocalMachine == true
          ? await getDirectoryPath(initialDirectory: path)
          : await showRemoteFolderPicker(
              context,
              notifier: widget.notifier,
              machineId: id,
              initialPath: path,
            );
      if (!mounted || machineId != id) return;
      setState(() {
        path = folder ?? path;
        if (folder != null && name.text.trim().isEmpty)
          name.text = folder.split('/').where((s) => s.isNotEmpty).last;
      });
    } catch (_) {
      if (mounted)
        setState(
          () =>
              error = 'Could not browse this machine. Reconnect and try again.',
        );
    } finally {
      if (mounted) setState(() => picking = false);
    }
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Add project'),
    content: SizedBox(
      width: 460,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Choose an existing working folder.',
            style: TextStyle(fontSize: 12, color: Colors.white60),
          ),
          const SizedBox(height: 20),
          if (machineId != null)
            AppSelectField<String>(
              value: machineId!,
              options: [
                for (final machine in widget.notifier.machineStates.values)
                  SelectOption(
                    value: machine.machine.machineId,
                    label: machine.isLocalMachine
                        ? 'Local'
                        : machine.machine.displayName,
                  ),
              ],
              onChanged: (value) => setState(() {
                machineId = value;
                path = null;
              }),
            ),
          const SizedBox(height: 16),
          OutlinedButton.icon(
            onPressed: machineId == null || picking ? null : browse,
            icon: const Icon(Icons.folder_open, size: 17),
            label: Text(
              path ?? 'Choose folder',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          const SizedBox(height: 16),
          TextField(
            controller: name,
            maxLength: 80,
            decoration: const InputDecoration(labelText: 'Project name'),
            onChanged: (_) => setState(() {}),
          ),
          if (error != null)
            Text(
              error!,
              style: const TextStyle(color: Colors.orangeAccent, fontSize: 12),
            ),
        ],
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Cancel'),
      ),
      FilledButton(
        onPressed: path == null || name.text.trim().isEmpty || picking
            ? null
            : () => Navigator.pop(
                context,
                SavedSwarmProject(
                  machineId: machineId!,
                  path: path!,
                  name: name.text.trim(),
                ),
              ),
        child: const Text('Add project'),
      ),
    ],
  );
}

Future<void> showSwarmLinkDialog(
  BuildContext context,
  AppNotifier notifier,
) async {
  final selected = await showAppDialog<String>(
    context: context,
    builder: (context) => AlertDialog(
      title: const Text('Link machine'),
      content: SizedBox(
        width: 480,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'On the other machine, sign in to Harness and start the daemon:',
              ),
              const SizedBox(height: 14),
              const SelectableText(
                'harness login\nharness start',
                style: TextStyle(fontFamily: 'monospace', fontSize: 13),
              ),
              const SizedBox(height: 18),
              const Text(
                'Use the same account. Set a remote password on that machine, then choose it here to connect.',
                style: TextStyle(fontSize: 12, color: Colors.white60),
              ),
              const SizedBox(height: 12),
              ListenableBuilder(
                listenable: notifier,
                builder: (_, _) => Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    for (final machine in notifier.machineStates.values.where(
                      (m) => !m.isLocalMachine,
                    ))
                      ListTile(
                        leading: const Icon(Icons.computer, size: 18),
                        title: Text(machine.machine.displayName),
                        subtitle: Text(
                          machine.needsLink
                              ? 'Link required'
                              : machine.nodeOnline == false
                              ? 'Offline'
                              : 'Linked',
                        ),
                        onTap: () =>
                            Navigator.pop(context, machine.machine.machineId),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: notifier.refreshMachines,
          child: const Text('Refresh'),
        ),
        TextButton(
          onPressed: () => Navigator.pop(context, 'local-access'),
          child: const Text('This machine’s remote password'),
        ),
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Done'),
        ),
      ],
    ),
  );
  if (!context.mounted || selected == null) return;
  if (selected == 'local-access') {
    await showLinkMachineDialog(context, notifier);
  } else {
    await showLinkMachineScreenDialog(context, notifier, selected);
  }
}
