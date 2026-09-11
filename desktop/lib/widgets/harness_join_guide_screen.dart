import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/widgets/command_row.dart';
import '../state/app_state.dart';
import '../theme/app_theme.dart';

/// Shown when an agent is selected but its Harness adapter is not running.
///
/// The selected agent remains pending in [MachineState] and is attached
/// automatically after the node reports online again.
class HarnessJoinGuideScreen extends StatefulWidget {
  final AppNotifier notifier;
  final MachineState machineState;
  final String agentName;

  const HarnessJoinGuideScreen({
    super.key,
    required this.notifier,
    required this.machineState,
    required this.agentName,
  });

  @override
  State<HarnessJoinGuideScreen> createState() => _HarnessJoinGuideScreenState();
}

class _HarnessJoinGuideScreenState extends State<HarnessJoinGuideScreen> {
  String? _copiedCommand;

  Future<void> _copy(String command) async {
    await Clipboard.setData(ClipboardData(text: command));
    if (!mounted) return;
    setState(() => _copiedCommand = command);
    Future<void>.delayed(const Duration(milliseconds: 1400), () {
      if (mounted && _copiedCommand == command) {
        setState(() => _copiedCommand = null);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final isLocal = widget.machineState.isLocalMachine;
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 460),
        child: Container(
          margin: const EdgeInsets.all(24),
          padding: const EdgeInsets.all(24),
          decoration: BoxDecoration(
            color: AppColors.surface,
            border: Border.all(color: AppColors.borderStrong),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(Icons.link_off, color: AppColors.warning, size: 28),
              const SizedBox(height: 14),
              Text(
                'Harness is offline',
                style: TextStyle(
                  color: AppColors.text,
                  fontSize: 18,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                '${widget.machineState.machine.displayName} · ${widget.agentName}',
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: AppColors.mutedStrong),
              ),
              const SizedBox(height: 14),
              Text(
                isLocal
                    ? 'The Harness daemon on this machine isn\'t running. Start it — it reuses the SSO session already saved here. The selected agent will attach automatically when it comes online.'
                    : 'The Harness CLI on ${widget.machineState.machine.displayName} appears to be offline. Start it there, then this agent will attach automatically when it comes back online.',
                style: TextStyle(color: AppColors.textSoft, height: 1.45),
              ),
              const SizedBox(height: 18),
              CommandRow(
                key: const Key('harness-start-command'),
                command: 'harness start',
                copied: _copiedCommand == 'harness start',
                onCopy: () => _copy('harness start'),
              ),
              const SizedBox(height: 16),
              Row(
                children: [
                  const SizedBox(
                    width: 13,
                    height: 13,
                    child: CircularProgressIndicator(strokeWidth: 1.5),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'Checking every 5s…',
                      style: TextStyle(color: AppColors.mutedStrong),
                    ),
                  ),
                  TextButton(
                    key: const Key('offline-retry-now'),
                    onPressed: () => widget.notifier.retryOfflineMachine(
                      widget.machineState.machine.machineId,
                    ),
                    child: const Text('Retry now'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
