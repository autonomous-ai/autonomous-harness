import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/desktop_window.dart';
import '../core/harness_file_store.dart';
import '../core/test_run.dart';
import '../settings/settings_screen.dart';
import '../settings/settings_section.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shortcuts/app_shortcuts.dart';
import '../state/app_state.dart';
import '../state/swarm_catalog.dart';
import '../widgets/engine_identity.dart';
import '../widgets/layout_palette.dart';
import '../widgets/link_machine_screen.dart';
import '../widgets/new_agent_dialog.dart';
import '../widgets/pane_grid.dart';
import '../widgets/shortcuts_sheet.dart';
import '../widgets/swarm_dialogs.dart';
import '../widgets/swarm_wallpaper.dart';
import '../widgets/swarm_welcome.dart';
import '../widgets/task_palette.dart';

class SwarmScreen extends StatefulWidget {
  const SwarmScreen({
    super.key,
    required this.notifier,
    this.nativeTabs,
    this.projectStore,
  });
  final AppNotifier notifier;
  final bool? nativeTabs;
  final SwarmProjectStore? projectStore;
  @override
  State<SwarmScreen> createState() => _SwarmScreenState();
}

class _SwarmScreenState extends State<SwarmScreen> {
  static const _channel = MethodChannel('harness/swarm_tabs');
  late final bool _native =
      widget.nativeTabs ?? (Platform.isMacOS && !kUnderTest);
  late final SwarmProjectStore _projects =
      widget.projectStore ??
      SwarmProjectStore(storage: kUnderTest ? null : HarnessFileStore.shared);
  StreamSubscription<SpokenTaskRequest>? _spokenTasks;
  final _shellFocus = FocusNode(debugLabel: 'Swarm shell');
  bool _spokenPaletteOpen = false;
  bool _dialogOpen = false;
  bool _routeIsCurrent = true;
  String? _linkDialogMachineId;
  String? _nativeState;
  AppNotifier get app => widget.notifier;

  @override
  void initState() {
    super.initState();
    app.hasNavigationRail = false;
    app.railFocused = false;
    FocusManager.instance.addListener(_restoreEmptyFocus);
    unawaited(_projects.load());
    _spokenTasks = app.spokenTasks.listen(_openSpokenTask);
    if (_native) {
      _channel.setMethodCallHandler(_onNative);
      app.addListener(_syncNative);
      _syncNative();
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final current = ModalRoute.isCurrentOf(context) ?? true;
    if (_routeIsCurrent == current) return;
    _routeIsCurrent = current;
    if (_native) _syncNative();
  }

  @override
  void dispose() {
    FocusManager.instance.removeListener(_restoreEmptyFocus);
    _shellFocus.dispose();
    unawaited(_spokenTasks?.cancel());
    if (_native) {
      app.removeListener(_syncNative);
      _channel.setMethodCallHandler(null);
      unawaited(
        _channel.invokeMethod<void>('update', {'tabs': [], 'enabled': false}),
      );
    }
    if (widget.projectStore == null) _projects.dispose();
    super.dispose();
  }

  int get _attention =>
      app.machineStates.values.fold(0, (n, m) => n + m.blockedAgents.length);

  void _restoreEmptyFocus() {
    if (!mounted ||
        app.panes.isNotEmpty ||
        _dialogOpen ||
        _spokenPaletteOpen ||
        ModalRoute.of(context)?.isCurrent == false ||
        _shellFocus.hasFocus) {
      return;
    }
    // Hiding the final terminal releases focus after its parent has rebuilt.
    // Only reclaim the route's empty scope, never another field or dialog.
    if (FocusManager.instance.primaryFocus == _shellFocus.enclosingScope) {
      _shellFocus.requestFocus();
    }
  }

  void _syncNative() {
    final payload = {
      'enabled': _routeIsCurrent && !_dialogOpen && !_spokenPaletteOpen,
      'activeId': app.activeSwarmId,
      'canReopen': app.canReopenClosedSwarm,
      'attention': _attention,
      'tabs': [
        for (final swarm in app.swarms)
          {
            'id': swarm.id,
            'name': swarm.name,
            'attention': swarm.panes
                .where(
                  (p) =>
                      p.agentId != null &&
                      app.questionFor(p.machineId, p.agentId!) != null,
                )
                .length,
          },
      ],
    };
    final encoded = jsonEncode(payload);
    if (encoded == _nativeState) return;
    _nativeState = encoded;
    unawaited(_channel.invokeMethod<void>('update', payload));
  }

  Future<void> _onNative(MethodCall call) async {
    if (!mounted ||
        _dialogOpen ||
        _spokenPaletteOpen ||
        ModalRoute.of(context)?.isCurrent == false) {
      return;
    }
    final args = call.arguments is Map ? call.arguments as Map : const {};
    switch (call.method) {
      case 'new':
        app.newSwarm();
      case 'reopen':
        app.reopenClosedSwarm();
      case 'select':
        if (args['id'] is String) app.selectSwarm(args['id']);
      case 'close':
        if (args['id'] is String) await app.closeSwarm(args['id']);
      case 'closeActive':
        await app.closeSwarm(app.activeSwarmId);
      case 'rename':
        if (args['id'] is String) await _rename(args['id']);
      case 'renameActive':
        await _rename(app.activeSwarmId);
      case 'next':
        app.stepSwarm(1);
      case 'previous':
        app.stepSwarm(-1);
      case 'reorder':
        if (args['id'] is String && args['index'] is int) {
          app.reorderSwarm(args['id'], args['index']);
        }
      case 'addAgent':
        await _addAgent();
      case 'closePane':
        if (app.focusedPaneId != null) await app.closePane(app.focusedPaneId!);
      case 'notifications':
        await _notifications();
      case 'settings':
        await _settings();
    }
  }

  Future<void> _dialog(Future<void> Function() action) async {
    if (_dialogOpen || _spokenPaletteOpen || !mounted) return;
    _dialogOpen = true;
    if (_native) _syncNative();
    try {
      await action();
    } finally {
      _dialogOpen = false;
      if (_native && mounted) _syncNative();
    }
  }

  Future<void> _rename(String id) => _dialog(() async {
    final swarm = app.swarms.where((s) => s.id == id).firstOrNull;
    if (swarm == null) return;
    final name = await showSwarmRenameDialog(context, swarm.name);
    if (name != null) app.renameSwarm(id, name);
  });
  Future<void> _settings() =>
      _dialog(() => showSettingsScreen(context, app, source: 'swarm'));
  Future<void> _newAgent({
    String? machineId,
    String? folder,
    String? swarmId,
  }) => _dialog(() async {
    final local = app.machineStates.values
        .where((m) => m.isLocalMachine)
        .firstOrNull;
    final id =
        machineId ??
        local?.machine.machineId ??
        app.machineStates.keys.firstOrNull;
    if (id == null) {
      await showSwarmLinkDialog(context, app);
      return;
    }
    await showNewAgentDialog(
      context,
      app,
      id,
      source: 'swarm',
      initialFolder: folder,
      swarmId: swarmId,
    );
  });
  Future<void> _addAgent() async {
    final target = app.activeSwarmId;
    bool create = false;
    SwarmAgentRef? selected;
    await _dialog(() async {
      selected = await showSwarmAgentPicker(context, app, () => create = true);
    });
    if (!mounted) return;
    if (create) {
      await _newAgent(swarmId: target);
    } else if (selected != null) {
      await app.addAgentToSwarm(
        selected!.machineId,
        selected!.agent.id,
        swarmId: target,
      );
    }
  }

  Future<void> _addProject() => _dialog(() async {
    final project = await showSwarmProjectDialog(context, app);
    if (project != null) await _projects.add(project);
  });
  Future<void> _machine(MachineState machine) async {
    if (machine.needsLink) {
      await _dialog(
        () => showLinkMachineScreenDialog(
          context,
          app,
          machine.machine.machineId,
        ),
      );
      return;
    }
    if (machine.agents.isEmpty) {
      if (machine.nodeOnline == false) {
        await _dialog(() => showSwarmLinkDialog(context, app));
      } else {
        await _newAgent(machineId: machine.machine.machineId);
      }
      return;
    }
    await app.seedSwarm(machine.machine.displayName, [
      for (final a in machine.agents)
        (machineId: machine.machine.machineId, agentId: a.id),
    ]);
  }

  Future<void> _project(SwarmProjectGroup group) async {
    if (group.agents.isEmpty) {
      final saved = group.saved;
      await _newAgent(machineId: saved?.machineId, folder: saved?.path);
    } else {
      await app.seedSwarm(group.name, [
        for (final a in group.agents)
          (machineId: a.machineId, agentId: a.agent.id),
      ]);
    }
  }

  Future<void> _goToAgent(String machineId, String agentId) async {
    if (app.paneOfAgent(machineId, agentId) == null) {
      final owner = app.swarms
          .where(
            (s) => s.panes.any(
              (p) => p.machineId == machineId && p.agentId == agentId,
            ),
          )
          .firstOrNull;
      if (owner != null) app.selectSwarm(owner.id);
    }
    await app.selectAgent(machineId, agentId);
  }

  Future<void> _notifications() => _dialog(() async {
    final selected = await showAppDialog<({String machineId, String agentId})>(
      context: context,
      builder: (context) => Dialog(
        child: SizedBox(
          width: 520,
          height: 400,
          child: Padding(
            padding: const EdgeInsets.all(22),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const Text('Notifications', style: TextStyle(fontSize: 20)),
                    const Spacer(),
                    IconButton(
                      tooltip: 'Close notifications',
                      onPressed: () => Navigator.pop(context),
                      icon: const Icon(Icons.close, size: 18),
                    ),
                  ],
                ),
                const SizedBox(height: 14),
                Expanded(
                  child: ListenableBuilder(
                    listenable: app,
                    builder: (context, _) {
                      final questions =
                          app.machineStates.values
                              .expand((m) => m.blockedAgents.values)
                              .toList()
                            ..sort((a, b) => a.since.compareTo(b.since));
                      if (questions.isEmpty) {
                        return const Center(
                          child: Text(
                            'No agents need your input',
                            style: TextStyle(color: Colors.white60),
                          ),
                        );
                      }
                      return ListView(
                        children: [
                          for (final q in questions)
                            ListTile(
                              leading: EngineMark(
                                engine: app
                                    .stateOf(q.machineId)
                                    ?.agents
                                    .where((a) => a.id == q.agentId)
                                    .firstOrNull
                                    ?.engine,
                                size: 22,
                              ),
                              title: Text(
                                q.prompt,
                                maxLines: 3,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(fontSize: 13),
                              ),
                              subtitle: Text(
                                '${app.stateOf(q.machineId)?.agents.where((a) => a.id == q.agentId).firstOrNull?.name ?? q.agentId} · ${app.stateOf(q.machineId)?.machine.displayName ?? q.machineId}',
                                style: const TextStyle(
                                  fontSize: 11,
                                  color: Colors.white54,
                                ),
                              ),
                              onTap: () => Navigator.pop(context, (
                                machineId: q.machineId,
                                agentId: q.agentId,
                              )),
                            ),
                        ],
                      );
                    },
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
    if (selected != null) {
      await _goToAgent(selected.machineId, selected.agentId);
    }
  });

  Future<void> _openSpokenTask(SpokenTaskRequest request) async {
    final spoken = SpokenTask(
      voiceId: request.voiceId,
      text: request.text,
      cmd: request.cmd,
      report: (voiceId, state, agentId) =>
          app.reportVoiceRoute(request.machineId, voiceId, state, agentId),
    );
    if (_spokenPaletteOpen || _dialogOpen || !mounted) {
      spoken.cancelled();
      return;
    }
    _spokenPaletteOpen = true;
    if (_native) _syncNative();
    try {
      await revealWindow();
      if (!mounted) {
        spoken.cancelled();
        return;
      }
      await showTaskPalette(context, app, spoken: spoken);
    } finally {
      _spokenPaletteOpen = false;
      if (_native && mounted) _syncNative();
      spoken.cancelled();
    }
  }

  void _maybeLink() {
    final machine = app.stateOf(app.selectedMachineId ?? '');
    if (machine == null ||
        !machine.needsLink ||
        machine.isLocalMachine ||
        _dialogOpen ||
        app.isLinkPromptDismissed(machine.machine.machineId) ||
        _linkDialogMachineId != null) {
      return;
    }
    _linkDialogMachineId = machine.machine.machineId;
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (mounted) {
        await _dialog(
          () => showLinkMachineScreenDialog(
            context,
            app,
            machine.machine.machineId,
          ),
        );
      }
      _linkDialogMachineId = null;
    });
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([app, _projects]),
    builder: (context, _) {
      grid.AppTheme.watch(context);
      _maybeLink();
      if (app.panes.isEmpty) {
        WidgetsBinding.instance.addPostFrameCallback(
          (_) => _restoreEmptyFocus(),
        );
      }
      return CallbackShortcuts(
        bindings: {
          ...buildShortcutBindings(
            handlers: {
              ShortcutAction.newSwarm: app.newSwarm,
              ShortcutAction.reopenClosedSwarm: app.reopenClosedSwarm,
              ShortcutAction.closeSwarm: () =>
                  app.closeSwarm(app.activeSwarmId),
              ShortcutAction.renameSwarm: () => _rename(app.activeSwarmId),
              ShortcutAction.nextSwarm: () => app.stepSwarm(1),
              ShortcutAction.previousSwarm: () => app.stepSwarm(-1),
              ShortcutAction.showSettings: _settings,
              ShortcutAction.focusPaneLeft: () => app.focusPaneHorizontally(-1),
              ShortcutAction.focusPaneRight: () => app.focusPaneHorizontally(1),
              ShortcutAction.focusPaneAbove: () => app.focusPaneVertically(-1),
              ShortcutAction.focusPaneBelow: () => app.focusPaneVertically(1),
              ShortcutAction.movePaneLeft: () =>
                  app.movePaneDirection(dx: -1, dy: 0),
              ShortcutAction.movePaneRight: () =>
                  app.movePaneDirection(dx: 1, dy: 0),
              ShortcutAction.movePaneUp: () =>
                  app.movePaneDirection(dx: 0, dy: -1),
              ShortcutAction.movePaneDown: () =>
                  app.movePaneDirection(dx: 0, dy: 1),
              ShortcutAction.nextAgent: () => app.focusPaneBy(1),
              ShortcutAction.previousAgent: () => app.focusPaneBy(-1),
              ShortcutAction.lastPane: app.focusLastPane,
              ShortcutAction.zoomPane: app.toggleZoomPane,
              ShortcutAction.switchAgent: _addAgent,
              ShortcutAction.closePane: () {
                if (app.focusedPaneId != null) {
                  app.closePane(app.focusedPaneId!);
                }
              },
              ShortcutAction.newAgent: _newAgent,
              ShortcutAction.routeTask: () =>
                  _dialog(() => showTaskPalette(context, app)),
              ShortcutAction.reload: app.retryMachines,
              ShortcutAction.showLayout: () =>
                  _dialog(() => showLayoutPalette(context, app)),
              ShortcutAction.pinPane: () {
                if (app.focusedPaneId != null) {
                  app.togglePinPane(app.focusedPaneId!);
                }
              },
              ShortcutAction.showShortcuts: () =>
                  _dialog(() => showShortcutsSheet(context)),
              ShortcutAction.showDebug: () => _dialog(
                () => showSettingsScreen(
                  context,
                  app,
                  source: 'shortcut',
                  initialSection: SettingsSection.debug,
                ),
              ),
            },
            onSelectPaneIndex: app.focusPaneByIndex,
          ),
        },
        child: Focus(
          focusNode: _shellFocus,
          autofocus: true,
          child: Scaffold(
            backgroundColor: grid.AppPalette.swarmField,
            body: Column(
              children: [
                if (!_native) _tabStrip(),
                if (_projects.error != null || app.lastError != null)
                  Material(
                    color: grid.AppPalette.panelBg,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      child: Row(
                        children: [
                          const Icon(
                            Icons.info_outline,
                            size: 16,
                            color: Colors.orangeAccent,
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Text(
                              _projects.error ?? app.lastError!,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 12),
                            ),
                          ),
                          if (_projects.error == null && app.lastErrorRetryable)
                            TextButton(
                              onPressed: app.retryMachines,
                              child: const Text('Retry'),
                            ),
                          IconButton(
                            onPressed: _projects.error != null
                                ? _projects.dismissError
                                : app.dismissError,
                            tooltip: 'Dismiss',
                            icon: const Icon(Icons.close, size: 16),
                          ),
                        ],
                      ),
                    ),
                  ),
                Expanded(
                  child: Stack(
                    fit: StackFit.expand,
                    children: [
                      if (app.panes.isEmpty)
                        RepaintBoundary(
                          child: SwarmWallpaper(
                            index: app.activeSwarm.wallpaper,
                          ),
                        ),
                      Padding(
                        padding: app.panes.isEmpty
                            ? EdgeInsets.zero
                            : const EdgeInsets.all(10),
                        child: Stack(
                          children: [
                            Positioned.fill(
                              child: PaneGrid(
                                notifier: app,
                                swarmMode: true,
                                empty: SwarmWelcome(
                                  key: ValueKey(app.activeSwarmId),
                                  notifier: app,
                                  projects: _projects.projects,
                                  onNewAgent: _newAgent,
                                  onAddProject: _addProject,
                                  onLinkMachine: () => _dialog(
                                    () => showSwarmLinkDialog(context, app),
                                  ),
                                  onMachine: _machine,
                                  onProject: _project,
                                  onAgent: (entry) => app.addAgentToSwarm(
                                    entry.machineId,
                                    entry.agent.id,
                                  ),
                                ),
                              ),
                            ),
                            if (app.panes.isNotEmpty)
                              Positioned(
                                right: 10,
                                bottom: 10,
                                child: Material(
                                  color: grid.AppPalette.swarmTabBar,
                                  elevation: 6,
                                  borderRadius: BorderRadius.circular(8),
                                  child: IconButton(
                                    tooltip: withShortcutHint(
                                      'Add agent',
                                      ShortcutAction.switchAgent,
                                    ),
                                    onPressed: _addAgent,
                                    constraints: const BoxConstraints.tightFor(
                                      width: 34,
                                      height: 34,
                                    ),
                                    padding: EdgeInsets.zero,
                                    icon: Icon(
                                      Icons.add,
                                      size: 21,
                                      color: grid.AppPalette.swarmAccent,
                                    ),
                                  ),
                                ),
                              ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    },
  );

  Widget _tabStrip() => Container(
    height: 44,
    color: grid.AppPalette.swarmTabBar,
    child: Row(
      children: [
        const SizedBox(width: 10),
        Flexible(
          child: ReorderableListView.builder(
            scrollDirection: Axis.horizontal,
            shrinkWrap: true,
            buildDefaultDragHandles: false,
            itemCount: app.swarms.length,
            onReorderItem: (old, to) =>
                app.reorderSwarm(app.swarms[old].id, to),
            itemBuilder: (context, index) {
              final swarm = app.swarms[index];
              return ReorderableDragStartListener(
                key: ValueKey(swarm.id),
                index: index,
                child: GestureDetector(
                  onDoubleTap: () => _rename(swarm.id),
                  child: Container(
                    width: 186,
                    margin: const EdgeInsets.only(top: 6, right: 2),
                    decoration: BoxDecoration(
                      color: app.activeSwarmId == swarm.id
                          ? grid.AppPalette.swarmField
                          : Colors.transparent,
                      borderRadius: const BorderRadius.vertical(
                        top: Radius.circular(9),
                      ),
                    ),
                    child: Row(
                      children: [
                        Expanded(
                          child: TextButton(
                            onPressed: () => app.selectSwarm(swarm.id),
                            child: Text(
                              swarm.name,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 12),
                            ),
                          ),
                        ),
                        IconButton(
                          tooltip: 'Close ${swarm.name}',
                          onPressed: () => app.closeSwarm(swarm.id),
                          icon: const Icon(Icons.close, size: 13),
                          constraints: const BoxConstraints.tightFor(
                            width: 30,
                            height: 30,
                          ),
                          padding: EdgeInsets.zero,
                        ),
                      ],
                    ),
                  ),
                ),
              );
            },
          ),
        ),
        IconButton(
          tooltip: withShortcutHint('New swarm', ShortcutAction.newSwarm),
          onPressed: app.swarms.length < AppNotifier.maxSwarms
              ? app.newSwarm
              : null,
          icon: const Icon(Icons.add, size: 18),
        ),
        const Spacer(),
        IconButton(
          tooltip: _attention == 0
              ? 'Notifications'
              : '$_attention agents need input',
          onPressed: _notifications,
          icon: Badge(
            isLabelVisible: _attention > 0,
            label: Text('$_attention'),
            child: const Icon(Icons.notifications_none, size: 19),
          ),
        ),
        IconButton(
          tooltip: withShortcutHint('Settings', ShortcutAction.showSettings),
          onPressed: _settings,
          icon: const Icon(Icons.settings_outlined, size: 18),
        ),
        const SizedBox(width: 6),
      ],
    ),
  );
}
