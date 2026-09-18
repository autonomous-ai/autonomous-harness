import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_icon_button.dart';
import '../state/app_state.dart';
import '../state/terminal_pane.dart';
import '../widgets/web_pane_panel.dart';
import 'orchestrator_controller.dart';
import 'orchestrator_launcher.dart';

class OrchestratorWorkspace extends StatefulWidget {
  const OrchestratorWorkspace({
    super.key,
    required this.notifier,
    required this.machineId,
    required this.projectId,
    this.controller,
  });
  final AppNotifier notifier;
  final String machineId, projectId;
  final OrchestratorController? controller;
  @override
  State<OrchestratorWorkspace> createState() => _OrchestratorWorkspaceState();
}

class _OrchestratorWorkspaceState extends State<OrchestratorWorkspace> {
  late final OrchestratorController model =
      widget.controller ??
      widget.notifier.orchestratorProject(widget.machineId, widget.projectId);
  late final _composer = TextEditingController(text: model.draft);
  final _composerFocus = FocusNode(), _messagesScroll = ScrollController();
  final _viewers = <String, TerminalPane>{};
  int _nextPane = -1;
  String? _expanded;

  @override
  void initState() {
    super.initState();
    model.addListener(_changed);
    widget.notifier.addListener(_attentionChanged);
    model.watch();
  }

  void _attentionChanged() {
    if (mounted) setState(() {});
  }

  void _changed() {
    if (!mounted) return;
    final follow =
        !_messagesScroll.hasClients ||
        _messagesScroll.position.extentAfter < 100;
    setState(() {});
    if (follow) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _messagesScroll.hasClients) {
          _messagesScroll.jumpTo(_messagesScroll.position.maxScrollExtent);
        }
      });
    }
  }

  @override
  void dispose() {
    model.removeListener(_changed);
    widget.notifier.removeListener(_attentionChanged);
    model.unwatch();
    _composer.dispose();
    _composerFocus.dispose();
    _messagesScroll.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final text = _composer.text;
    if (await model.send(text) && mounted && _composer.text == text) {
      _composer.clear();
    }
    if (mounted) _composerFocus.requestFocus();
  }

  Future<void> _stop() async {
    final confirmed = await showAppDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Stop this project?'),
        content: const Text(
          'Stops the director and active specialist turns. Files and agent sessions remain available to inspect. Other projects are unaffected.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Keep working'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Stop project'),
          ),
        ],
      ),
    );
    if (confirmed == true) await model.perform('cancel');
  }

  void _inspect(String agentId) => unawaited(
    widget.notifier.inspectOrchestratorAgent(widget.machineId, agentId),
  );

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Padding(
      padding: const EdgeInsets.all(12),
      child: Column(
        children: [
          Row(
            children: [
              Icon(
                LucideIcons.sparkles,
                size: 17,
                color: grid.AppPalette.swarmAccent,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  'Orchestrator · ${model.state}',
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              if (const ['cancelled', 'paused', 'failed'].contains(model.state))
                TextButton(
                  onPressed: model.operating
                      ? null
                      : () => model.perform('resume'),
                  child: const Text('Resume'),
                ),
              if (const ['starting', 'active'].contains(model.state))
                TextButton(
                  onPressed: model.operating ? null : _stop,
                  child: const Text('Stop'),
                ),
              AppIconButton(
                icon: LucideIcons.plus,
                tooltip: 'New project (⌘P)',
                onPressed: () =>
                    showOrchestratorLauncher(context, widget.notifier),
              ),
            ],
          ),
          if ((model.error ?? model.project?['error']) != null) ...[
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: Text(
                    model.error ?? model.project?['error'] as String? ?? '',
                    style: TextStyle(color: grid.AppPalette.warn),
                  ),
                ),
                TextButton(
                  onPressed: model.refresh,
                  child: const Text('Reconnect'),
                ),
              ],
            ),
          ],
          const SizedBox(height: 12),
          Expanded(
            child: LayoutBuilder(
              builder: (context, constraints) {
                if (constraints.maxWidth < 760) {
                  return Column(
                    children: [
                      Expanded(child: _outputs()),
                      const SizedBox(height: 10),
                      Expanded(child: _conversation()),
                    ],
                  );
                }
                return Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Expanded(child: _outputs()),
                    const SizedBox(width: 12),
                    SizedBox(
                      width: (constraints.maxWidth * .34).clamp(300, 440),
                      child: _conversation(),
                    ),
                  ],
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget _outputs() {
    final tasks = model.tasks;
    if (tasks.isEmpty) {
      return _surface(
        Center(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  LucideIcons.layers,
                  color: grid.AppPalette.textSecondary,
                  size: 28,
                ),
                const SizedBox(height: 16),
                const Text('Your work takes shape here'),
                const SizedBox(height: 8),
                Text(
                  model.state == 'starting' ? 'Starting your director…' : 'Live views appear as specialists begin. You can keep talking on the right.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: grid.AppPalette.textSecondary),
                ),
              ],
            ),
          ),
        ),
      );
    }
    final visible = _expanded == null
        ? tasks
        : tasks.where((t) => t.id == _expanded).toList();
    return Column(
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                'Live views · ${tasks.length} tasks',
                style: TextStyle(color: grid.AppPalette.textSecondary),
              ),
            ),
            if (_expanded != null)
              TextButton(
                onPressed: () => setState(() => _expanded = null),
                child: const Text('All views'),
              ),
          ],
        ),
        const SizedBox(height: 8),
        Expanded(
          child: LayoutBuilder(
            builder: (context, c) => GridView.builder(
              key: const ValueKey('orchestrator-views'),
              itemCount: visible.length,
              gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                crossAxisCount: visible.length > 1 && c.maxWidth >= 680 ? 2 : 1,
                mainAxisExtent: visible.length == 1
                    ? c.maxHeight.clamp(180, 1000)
                    : 330,
                mainAxisSpacing: 12,
                crossAxisSpacing: 12,
              ),
              itemBuilder: (context, index) => _task(visible[index]),
            ),
          ),
        ),
      ],
    );
  }

  Widget _task(OrchestratorTask task) {
    final paneKey = '${task.id}/${task.attempt}';
    final question = task.agentId == null
        ? null
        : widget.notifier.questionFor(widget.machineId, task.agentId!);
    Widget content;
    final viewerUrl = task.viewerUrl;
    final uri = viewerUrl == null ? null : Uri.tryParse(viewerUrl);
    // Mirror same-host ownership. Never mount an arbitrary remote URL returned by
    // an older or malformed daemon as a privileged local viewer.
    final safeViewer =
        uri != null &&
        const ['http', 'https'].contains(uri.scheme) &&
        const ['127.0.0.1', 'localhost', '::1', '[::1]'].contains(uri.host);
    if (safeViewer && task.agentId != null) {
      final pane = _viewers.putIfAbsent(
        paneKey,
        () => TerminalPane(
          id: _nextPane--,
          machineId: widget.machineId,
          kind: PaneKind.web,
          ownerAgentId: task.agentId,
        ),
      )..url = viewerUrl;
      content = WebPanePanel(
        notifier: widget.notifier,
        pane: pane,
        title: task.viewerName,
        ownerName: task.title,
        ownerEngine: null,
        ownerDisplayName: task.harness,
        working: task.state == 'running',
        compactHeader: true,
        zoomed: _expanded == task.id,
        onToggleZoom: () =>
            setState(() => _expanded = _expanded == task.id ? null : task.id),
      );
    } else {
      content = Center(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  task.state == 'succeeded'
                      ? LucideIcons.check
                      : LucideIcons.layers,
                  size: 24,
                  color: grid.AppPalette.textSecondary,
                ),
                const SizedBox(height: 12),
                Text(
                  task.error ??
                      (task.summary.isNotEmpty
                          ? task.summary
                          : task.state == 'queued'
                          ? 'Waiting for upstream results or an available worker.'
                          : !task.hasViewer
                          ? 'This specialist works in the background. Its summary and files will appear here.'
                          : 'The specialist’s live view will appear when its viewer is ready.'),
                  textAlign: TextAlign.center,
                ),
                if (task.artifacts.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 10),
                    child: SelectableText(task.artifacts.join('\n')),
                  ),
              ],
            ),
          ),
        ),
      );
    }
    return _surface(
      Column(
        key: ValueKey('task:$paneKey'),
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        task.title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      Text(
                        '${task.harness} · ${question != null ? 'needs input' : task.state}${task.attempt > 1 ? ' · attempt ${task.attempt}' : ''}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: task.error == null && question == null
                              ? grid.AppPalette.textSecondary
                              : grid.AppPalette.warn,
                          fontSize: 12,
                        ),
                      ),
                    ],
                  ),
                ),
                if (!task.uncertain &&
                    const [
                      'failed',
                      'blocked',
                      'cancelled',
                    ].contains(task.state) &&
                    model.state == 'active')
                  AppIconButton(
                    icon: LucideIcons.rotateCcw,
                    tooltip: 'Retry task',
                    onPressed: model.operating
                        ? null
                        : () => model.perform('retry', taskId: task.id),
                  ),
                if (task.agentId != null)
                  AppIconButton(
                    icon: LucideIcons.terminal,
                    tooltip: 'Inspect ${task.title}',
                    onPressed: () => _inspect(task.agentId!),
                  ),
              ],
            ),
          ),
          if (question != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
              child: Text(
                'Needs your input: ${question.prompt}\nUse Inspect to answer in the original agent.',
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: grid.AppPalette.warn),
              ),
            ),
          if (safeViewer && task.error != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
              child: Text(
                task.error!,
                style: TextStyle(color: grid.AppPalette.warn),
              ),
            ),
          Expanded(child: content),
        ],
      ),
    );
  }

  Widget _conversation() => _surface(
    Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(18, 10, 10, 10),
          child: Row(
            children: [
              const Expanded(child: Text('Director')),
              if (model.directorId != null)
                AppIconButton(
                  icon: LucideIcons.terminal,
                  tooltip: 'Inspect director',
                  onPressed: () => _inspect(model.directorId!),
                ),
            ],
          ),
        ),
        const Divider(height: 1),
        if (model.directorId != null &&
            widget.notifier.questionFor(widget.machineId, model.directorId!) !=
                null)
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 10, 18, 0),
            child: Text(
              'The director needs your input. Use Inspect director to answer.',
              style: TextStyle(color: grid.AppPalette.warn),
            ),
          ),
        Expanded(
          child: SelectionArea(
            child: ListView.builder(
              key: const ValueKey('orchestrator-conversation'),
              controller: _messagesScroll,
              padding: const EdgeInsets.all(18),
              itemCount: model.messages.length,
              itemBuilder: (context, index) {
                final message = model.messages[index];
                final role = message['role'];
                return Padding(
                  key: ValueKey(message['id']),
                  padding: const EdgeInsets.only(bottom: 22),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        role == 'user'
                            ? 'You'
                            : role == 'assistant'
                            ? 'Director'
                            : 'Project update',
                        style: TextStyle(
                          color: grid.AppPalette.textSecondary,
                          fontSize: 12,
                        ),
                      ),
                      const SizedBox(height: 6),
                      Text(message['text'] as String? ?? ''),
                      if (message['delivery'] == 'failed' ||
                          message['delivery'] == 'unknown')
                        Text(
                          message['delivery'] == 'failed'
                              ? 'Message not delivered. ${message['deliveryReason'] ?? 'Inspect the agent before resending.'}'
                              : 'Delivery unconfirmed. Inspect the agent before resending.',
                          style: TextStyle(color: grid.AppPalette.warn),
                        ),
                      if (const [
                        'pending',
                        'accepted',
                        'queued',
                      ].contains(message['delivery']))
                        Text(
                          'Queued for the agent',
                          style: TextStyle(
                            color: grid.AppPalette.textSecondary,
                            fontSize: 12,
                          ),
                        ),
                    ],
                  ),
                );
              },
            ),
          ),
        ),
        if (model.directorWorking)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 6),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(
                'Director is working…',
                style: TextStyle(
                  color: grid.AppPalette.textSecondary,
                  fontSize: 12,
                ),
              ),
            ),
          ),
        Padding(
          padding: const EdgeInsets.all(12),
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: grid.AppSurface.recess,
              borderRadius: BorderRadius.circular(14),
            ),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 6, 6),
              child: Column(
                children: [
                  Focus(
                    onKeyEvent: (_, event) {
                      if (event is KeyDownEvent &&
                          event.logicalKey == LogicalKeyboardKey.enter &&
                          !HardwareKeyboard.instance.isShiftPressed &&
                          !_composer.value.composing.isValid) {
                        if (model.canChat) unawaited(_send());
                        return KeyEventResult.handled;
                      }
                      return KeyEventResult.ignored;
                    },
                    child: TextField(
                      key: const ValueKey('orchestrator-composer'),
                      controller: _composer,
                      focusNode: _composerFocus,
                      minLines: 2,
                      maxLines: 6,
                      maxLength: 24000,
                      enabled: model.canChat,
                      onChanged: (value) => model.draft = value,
                      decoration: InputDecoration(
                        border: InputBorder.none,
                        counterText: '',
                        hintText: model.canChat
                            ? 'Keep shaping the project…'
                            : 'Waiting for the director…',
                      ),
                    ),
                  ),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      Text(
                        'Shift ↵ for a new line',
                        style: TextStyle(
                          color: grid.AppPalette.textSecondary,
                          fontSize: 11,
                        ),
                      ),
                      const SizedBox(width: 10),
                      AppIconButton(
                        icon: LucideIcons.arrowUp,
                        tooltip: 'Send to director',
                        onPressed: !model.canChat || model.sending
                            ? null
                            : _send,
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    ),
  );

  Widget _surface(Widget child) => Container(
    decoration: BoxDecoration(
      color: grid.AppPalette.panelBg,
      border: Border.all(color: grid.AppPalette.divider),
      borderRadius: BorderRadius.circular(16),
    ),
    clipBehavior: Clip.antiAlias,
    child: child,
  );
}
