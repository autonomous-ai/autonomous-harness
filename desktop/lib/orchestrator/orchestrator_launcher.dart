import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_icon_button.dart';
import '../shared/widgets/app_select_field.dart';
import '../state/app_state.dart';
import '../ws/ws_conn.dart';
import 'orchestrator_controller.dart';

Future<void> showOrchestratorLauncher(
  BuildContext context,
  AppNotifier notifier,
) async {
  await showAppDialog<void>(
    context: context,
    builder: (_) => OrchestratorLauncher(notifier: notifier),
  );
}

class OrchestratorLauncher extends StatefulWidget {
  const OrchestratorLauncher({super.key, required this.notifier});
  final AppNotifier notifier;
  @override
  State<OrchestratorLauncher> createState() => _OrchestratorLauncherState();
}

class _OrchestratorLauncherState extends State<OrchestratorLauncher> {
  final _prompt = TextEditingController(), _folder = TextEditingController();
  final _focus = FocusNode();
  String _engine = 'claude';
  String? _error;
  bool _starting = false, _automatic = false, _advanced = false;
  Map<String, dynamic>? _attempt;
  List<Map<String, dynamic>> _recent = [];
  String? get _machine => widget.notifier.localMachineState?.machine.machineId;

  @override
  void initState() {
    super.initState();
    final preferred = widget.notifier.agentPreference.value;
    if (const ['claude', 'codex', 'opencode'].contains(preferred)) {
      _engine = preferred!;
    }
    unawaited(_loadRecent());
  }

  Future<void> _loadRecent() async {
    final machine = _machine;
    if (machine == null) return;
    try {
      final reply = await widget.notifier.orchestratorRequest(machine, {
        'action': 'list',
      });
      if (!mounted) return;
      setState(
        () => _recent = [
          for (final item in reply['projects'] as List? ?? [])
            if (item is Map) item.cast<String, dynamic>(),
        ],
      );
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  Future<void> _start() async {
    if (_starting || _prompt.text.trim().isEmpty) return;
    final machine = _machine;
    if (machine == null) {
      setState(() => _error = 'Connect this computer’s Harness daemon first.');
      return;
    }
    _attempt ??= {
      'action': 'start',
      'id': orchestratorRequestId(),
      'prompt': _prompt.text.trim(),
      'engine': _engine,
      'bypassPermission': _automatic,
      if (_folder.text.trim().isNotEmpty) 'cwd': _folder.text.trim(),
    };
    setState(() {
      _starting = true;
      _error = null;
    });
    try {
      final reply = await widget.notifier.orchestratorRequest(
        machine,
        _attempt!,
      );
      if (reply['error'] != null) {
        throw StateError(
          reply['detail'] as String? ?? reply['error'].toString(),
        );
      }
      final project = reply['project'] as Map;
      if (!mounted) return;
      widget.notifier.openOrchestratorProject(
        machine,
        project['id'] as String,
        project['prompt'] as String,
      );
      Navigator.of(context).pop();
    } catch (e) {
      // Retain the exact id and payload after an uncertain reply. A second click
      // asks about the same launch instead of starting another director.
      if (mounted) {
        final refused =
            e is WsRequestFailure &&
            const {
              'INVALID_REQUEST',
              'INVALID_CWD',
              'ENGINE_UNSUPPORTED',
              'LOCAL_ONLY',
              'UNSUPPORTED',
              'WORKSPACE_EXISTS',
            }.contains(e.code);
        setState(() {
          if (refused) _attempt = null;
          _error = refused
              ? e.toString()
              : '${e.toString()}\nRetry checks the same launch; it will not create a duplicate.';
        });
      }
    } finally {
      if (mounted) setState(() => _starting = false);
    }
  }

  @override
  void dispose() {
    _prompt.dispose();
    _folder.dispose();
    _focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Dialog(
      backgroundColor: grid.AppPalette.panelBg,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
      insetPadding: const EdgeInsets.all(24),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 740, maxHeight: 740),
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(28),
          child: CallbackShortcuts(
            bindings: {
              const SingleActivator(LogicalKeyboardKey.enter, meta: true):
                  _start,
            },
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  children: [
                    Icon(
                      LucideIcons.sparkles,
                      size: 18,
                      color: grid.AppPalette.swarmAccent,
                    ),
                    const SizedBox(width: 10),
                    const Expanded(child: Text('Orchestrator')),
                    AppIconButton(
                      icon: LucideIcons.x,
                      tooltip: 'Close',
                      onPressed: () => Navigator.of(context).pop(),
                    ),
                  ],
                ),
                const SizedBox(height: 28),
                Text(
                  'What would you like to make?',
                  style: Theme.of(context).textTheme.headlineMedium,
                ),
                const SizedBox(height: 10),
                Text(
                  'One conversation. The right harnesses working together.',
                  style: TextStyle(color: grid.AppPalette.textSecondary),
                ),
                const SizedBox(height: 24),
                TextField(
                  key: const ValueKey('orchestrator-prompt'),
                  controller: _prompt,
                  focusNode: _focus,
                  autofocus: true,
                  readOnly: _attempt != null,
                  minLines: 5,
                  maxLines: 9,
                  maxLength: 24000,
                  style: Theme.of(context).textTheme.titleMedium,
                  onChanged: (_) => setState(() {}),
                  decoration: const InputDecoration(
                    border: InputBorder.none,
                    counterText: '',
                    hintText: 'Design a desk lamp, render it in a warm room, and create a short launch film…',
                  ),
                ),
                const SizedBox(height: 12),
                Wrap(
                  spacing: 12,
                  runSpacing: 10,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    SizedBox(
                      width: 180,
                      child: IgnorePointer(
                        ignoring: _attempt != null,
                        child: AppSelectField<String>(
                          value: _engine,
                          options: const [
                            SelectOption(
                              value: 'claude',
                              label: 'Claude director',
                            ),
                            SelectOption(
                              value: 'codex',
                              label: 'Codex director',
                            ),
                            SelectOption(
                              value: 'opencode',
                              label: 'OpenCode director',
                            ),
                          ],
                          onChanged: (value) => setState(() => _engine = value),
                        ),
                      ),
                    ),
                    TextButton(
                      onPressed: () => setState(() => _advanced = !_advanced),
                      child: const Text('Project options'),
                    ),
                    FilledButton.icon(
                      key: const ValueKey('orchestrator-start'),
                      onPressed: _starting || _prompt.text.trim().isEmpty
                          ? null
                          : _start,
                      icon: Icon(
                        _starting
                            ? LucideIcons.ellipsis
                            : LucideIcons.arrowUpRight,
                        size: 16,
                      ),
                      label: Text(
                        _starting
                            ? 'Starting…'
                            : _attempt == null
                            ? 'Start creating  ⌘↵'
                            : 'Check launch',
                      ),
                    ),
                  ],
                ),
                if (_advanced) ...[
                  const SizedBox(height: 18),
                  TextField(
                    controller: _folder,
                    readOnly: _attempt != null,
                    decoration: const InputDecoration(
                      labelText: 'Project folder (optional)',
                      hintText: 'Absolute path to an existing folder',
                    ),
                  ),
                  CheckboxListTile(
                    contentPadding: EdgeInsets.zero,
                    value: _automatic,
                    onChanged: _attempt != null
                        ? null
                        : (value) =>
                              setState(() => _automatic = value ?? false),
                    title: const Text(
                      'Use the engines’ automatic approval modes',
                    ),
                    subtitle: const Text(
                      'Off by default. Otherwise inspect an agent to answer its permission prompts.',
                    ),
                  ),
                ],
                const SizedBox(height: 18),
                Text(
                  'Runs on this computer with installed harnesses. Each specialist gets its own folder; no automatic installs.',
                  style: TextStyle(
                    color: grid.AppPalette.textSecondary,
                    fontSize: 12,
                  ),
                ),
                if (_error != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 16),
                    child: SelectableText(
                      _error!,
                      style: TextStyle(color: grid.AppPalette.warn),
                    ),
                  ),
                if (_recent.isNotEmpty) ...[
                  const Divider(height: 32),
                  const Text('Recent projects'),
                  for (final project in _recent.take(4))
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      dense: true,
                      title: Text(
                        project['prompt'] as String? ?? 'Project',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      subtitle: Text(project['state'] as String? ?? ''),
                      trailing: const Icon(LucideIcons.arrowUpRight, size: 14),
                      onTap: _machine == null
                          ? null
                          : () {
                              widget.notifier.openOrchestratorProject(
                                _machine!,
                                project['id'] as String,
                                project['prompt'] as String? ?? 'Project',
                              );
                              Navigator.of(context).pop();
                            },
                    ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
