import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import 'swarm_dialogs.dart';

Future<void> showMachinesManager(BuildContext context, AppNotifier notifier) =>
    showAppDialog<void>(
      context: context,
      builder: (_) => _MachinesManager(notifier: notifier),
    );

class _MachinesManager extends StatefulWidget {
  const _MachinesManager({required this.notifier});
  final AppNotifier notifier;

  @override
  State<_MachinesManager> createState() => _MachinesManagerState();
}

class _MachinesManagerState extends State<_MachinesManager> {
  bool _refreshing = false;

  Future<void> _refresh() async {
    if (_refreshing) return;
    setState(() => _refreshing = true);
    try {
      await widget.notifier.retryMachines();
    } finally {
      if (mounted) setState(() => _refreshing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ListenableBuilder(
      listenable: widget.notifier,
      builder: (context, _) {
        final machines = widget.notifier.machineStates.values.toList();
        return AlertDialog(
          title: const Text('Machines Manager'),
          content: SizedBox(
            width: 600,
            child: ConstrainedBox(
              constraints: BoxConstraints(
                maxHeight: MediaQuery.sizeOf(context).height * 0.55,
              ),
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (machines.isEmpty)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 24),
                        child: Text(
                          widget.notifier.machinesLoading
                              ? 'Loading machines…'
                              : 'No machines linked yet.',
                        ),
                      ),
                    for (var i = 0; i < machines.length; i++) ...[
                      if (i > 0) const Divider(height: 1),
                      ListTile(
                        key: ValueKey(
                          'managed-machine-${machines[i].machine.machineId}',
                        ),
                        contentPadding: const EdgeInsets.symmetric(vertical: 8),
                        leading: Icon(
                          machines[i].isLocalMachine
                              ? Icons.laptop_mac_outlined
                              : Icons.desktop_windows_outlined,
                          size: 22,
                          color: grid.AppPalette.textSecondary,
                        ),
                        title: Text(machines[i].machine.displayName),
                        subtitle: Text(
                          [
                            if (machines[i].isLocalMachine) 'This computer',
                            // Presence and link state are independent segments,
                            // the same split the Machines menu and rail use: an
                            // unlinked machine whose node is up reads
                            // "Online · Link required" rather than the link
                            // state hiding that the computer is reachable.
                            // "Connecting…" only when presence is genuinely
                            // unknown and there is no link prompt to show.
                            if (machines[i].nodeOnline == true)
                              'Online'
                            else if (machines[i].nodeOnline == false)
                              'Offline'
                            else if (!machines[i].needsLink)
                              'Connecting…',
                            if (machines[i].needsLink) 'Link required',
                          ].join(' · '),
                        ),
                        trailing: machines[i].machine.isShared
                            ? const Text('View only')
                            : TextButton(
                                onPressed: () => showMachineRenameDialog(
                                  context,
                                  widget.notifier,
                                  machines[i].machine.machineId,
                                  machines[i].machine.displayName,
                                ),
                                child: const Text('Rename'),
                              ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: _refreshing ? null : _refresh,
              child: Text(_refreshing ? 'Refreshing…' : 'Refresh'),
            ),
            TextButton.icon(
              onPressed: () => showSwarmLinkDialog(context, widget.notifier),
              icon: const Icon(Icons.add, size: 18),
              label: const Text('Link Machine'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Done'),
            ),
          ],
        );
      },
    );
  }
}

Future<void> showMachineRenameDialog(
  BuildContext context,
  AppNotifier notifier,
  String machineId,
  String currentName,
) => showAppDialog<void>(
  context: context,
  builder: (_) => _RenameMachineDialog(
    notifier: notifier,
    machineId: machineId,
    currentName: currentName,
  ),
);

class _RenameMachineDialog extends StatefulWidget {
  const _RenameMachineDialog({
    required this.notifier,
    required this.machineId,
    required this.currentName,
  });
  final AppNotifier notifier;
  final String machineId;
  final String currentName;

  @override
  State<_RenameMachineDialog> createState() => _RenameMachineDialogState();
}

class _RenameMachineDialogState extends State<_RenameMachineDialog> {
  late final _text = TextEditingController(text: widget.currentName)
    ..selection = TextSelection(
      baseOffset: 0,
      extentOffset: widget.currentName.length,
    );
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_saving) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    final error = await widget.notifier.renameMachine(
      widget.machineId,
      _text.text,
    );
    if (!mounted) return;
    if (error == null) {
      Navigator.pop(context);
    } else {
      setState(() {
        _saving = false;
        _error = error;
      });
    }
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Rename Machine'),
    content: SizedBox(
      width: 360,
      child: TextField(
        controller: _text,
        autofocus: true,
        readOnly: _saving,
        decoration: InputDecoration(labelText: 'Name', errorText: _error),
        onSubmitted: (_) => _save(),
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Cancel'),
      ),
      FilledButton(
        onPressed: _saving ? null : _save,
        child: Text(_saving ? 'Saving…' : 'Save'),
      ),
    ],
  );
}
