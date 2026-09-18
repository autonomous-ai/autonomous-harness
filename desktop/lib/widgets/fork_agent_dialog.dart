import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';

/// The default name for a fork of [name] — the owner's spelling.
String forkNameFor(String name) =>
    '${name.trim().isEmpty ? 'Agent' : name.trim()} - fork';

/// The engines that can fork a session outright. Fork is only OFFERED for an
/// agent that can fork at all ([Agent.canFork]); among those, this sets the
/// words the dialog opens with, so a person is told before the round trip
/// whether the fork will carry the whole context or a handoff.
const _nativeForkEngines = {'claude', 'codex'};

/// Fork a harness: open the dialog, then a second agent with the first one's
/// history, placed beside it and focused. Errors land as a snackbar; a fork
/// that could only hand off (no native fork on that engine) says so once.
Future<void> forkHarness(
  BuildContext context,
  AppNotifier notifier,
  String machineId,
  String agentId,
  String name, {
  String? engine,
}) async {
  if (notifier.agentIsProcessing(machineId, agentId)) {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text(
          'This harness is in the middle of a turn. Wait for it to finish, then fork.',
        ),
      ),
    );
    return;
  }
  final choice = await showForkAgentDialogForTest(
    context,
    name,
    engine: engine,
  );
  if (choice == null || !context.mounted) return;
  final result = await notifier.forkAgent(
    machineId,
    agentId,
    name: choice.name,
    prompt: choice.task,
  );
  if (!context.mounted) return;
  final message =
      result.error ??
      (result.level == 'handoff'
          ? 'Forked with a handoff: this engine cannot copy a session, so the fork opened with a summary of what “$name” had done.'
          : null);
  if (message != null) {
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }
}

/// The dialog alone — name and first task, or null on cancel. Public for the
/// widget test; [forkHarness] is what the app calls.
@visibleForTesting
Future<({String name, String task})?> showForkAgentDialogForTest(
  BuildContext context,
  String sourceName, {
  String? engine,
}) => showAppDialog<({String name, String task})>(
  context: context,
  transitionDuration: Duration.zero,
  veilBlur: 0,
  veilTint: const Color(0x99000000),
  builder: (_) => _ForkAgentDialog(sourceName: sourceName, engine: engine),
);

class _ForkAgentDialog extends StatefulWidget {
  const _ForkAgentDialog({required this.sourceName, this.engine});
  final String sourceName;
  final String? engine;
  @override
  State<_ForkAgentDialog> createState() => _ForkAgentDialogState();
}

class _ForkAgentDialogState extends State<_ForkAgentDialog> {
  late final _name = TextEditingController(
    text: forkNameFor(widget.sourceName),
  );
  final _task = TextEditingController();
  final _nameFocus = FocusNode(debugLabel: 'Fork name');
  final _taskFocus = FocusNode(debugLabel: 'Fork first task');

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && ModalRoute.isCurrentOf(context) != false) {
        _taskFocus.requestFocus();
      }
    });
  }

  @override
  void dispose() {
    _nameFocus.dispose();
    _taskFocus.dispose();
    _name.dispose();
    _task.dispose();
    super.dispose();
  }

  void _fork() {
    final name = _name.text.trim();
    if (name.isEmpty) return;
    Navigator.pop(context, (name: name, task: _task.text.trim()));
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final accent = grid.AppPalette.accentOnSurface;
    final border = OutlineInputBorder(
      borderRadius: BorderRadius.circular(10),
      borderSide: BorderSide.none,
    );
    InputDecoration decoration(String hint) => InputDecoration(
      filled: true,
      fillColor: grid.AppSurface.recess,
      isDense: true,
      hintText: hint,
      hintStyle: TextStyle(fontSize: 14, color: grid.AppPalette.textSecondary),
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      border: border,
      enabledBorder: border,
      focusedBorder: border.copyWith(borderSide: BorderSide(color: accent)),
      counterText: '',
    );
    final native =
        widget.engine == null || _nativeForkEngines.contains(widget.engine);
    final what = native
        ? 'The fork starts with everything “${widget.sourceName}” knows, in the same folder. Both keep running on their own.'
        : 'This engine cannot copy a session: the fork opens with a summary of what “${widget.sourceName}” has done, in the same folder.';
    Widget label(String text) => Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Text(
        text,
        style: TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.w600,
          color: grid.AppPalette.textSecondary,
        ),
      ),
    );
    return ListenableBuilder(
      listenable: _name,
      builder: (context, _) => AlertDialog(
        title: const Text('Fork Harness'),
        titleTextStyle: Theme.of(context).textTheme.titleMedium,
        content: SizedBox(
          width: 400,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                what,
                style: TextStyle(
                  fontFamily: grid.AppFont.sans,
                  fontSize: 13,
                  height: 1.4,
                  color: grid.AppPalette.textSecondary,
                ),
              ),
              const SizedBox(height: 16),
              label('Name'),
              TextField(
                key: const ValueKey('fork-name'),
                controller: _name,
                focusNode: _nameFocus,
                maxLength: 80,
                cursorColor: accent,
                textInputAction: TextInputAction.next,
                style: TextStyle(
                  fontSize: 14,
                  color: grid.AppPalette.textPrimary,
                ),
                decoration: decoration(''),
                onSubmitted: (_) => _taskFocus.requestFocus(),
              ),
              const SizedBox(height: 14),
              label('First task (optional)'),
              // Return adds a line; ⌘Return forks — the New Harness field's
              // own contract, so the two forms answer the keyboard alike.
              CallbackShortcuts(
                bindings: {
                  const SingleActivator(LogicalKeyboardKey.enter, meta: true):
                      _fork,
                },
                child: TextField(
                  key: const ValueKey('fork-task'),
                  controller: _task,
                  focusNode: _taskFocus,
                  minLines: 2,
                  maxLines: 6,
                  maxLength: 2000,
                  cursorColor: accent,
                  style: TextStyle(
                    fontSize: 14,
                    height: 1.4,
                    color: grid.AppPalette.textPrimary,
                  ),
                  decoration: decoration(
                    'What should the fork work on? Sent as its first message, exactly as written.',
                  ),
                ),
              ),
            ],
          ),
        ),
        actions: [
          OutlinedButton(
            onPressed: () => Navigator.pop(context),
            style: OutlinedButton.styleFrom(
              foregroundColor: grid.AppPalette.textSecondary,
              minimumSize: const Size(88, 38),
              padding: const EdgeInsets.symmetric(horizontal: 18),
              side: const BorderSide(color: Colors.white24),
              shape: const StadiumBorder(),
            ),
            child: const Text('Cancel'),
          ),
          FilledButton(
            key: const ValueKey('fork-submit'),
            onPressed: _name.text.trim().isEmpty ? null : _fork,
            style: FilledButton.styleFrom(
              backgroundColor: grid.AppPalette.swarmAccent,
              foregroundColor: grid.AppPalette.swarmTabBar,
              minimumSize: const Size(88, 38),
              padding: const EdgeInsets.symmetric(horizontal: 18),
              shape: const StadiumBorder(),
            ),
            child: const Text('Fork'),
          ),
        ],
      ),
    );
  }
}
