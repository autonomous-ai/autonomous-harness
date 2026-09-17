import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show listEquals;
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
import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import '../shortcuts/keymap_commands.dart';
import '../shortcuts/keymap_host.dart';
import '../shortcuts/keymap_native.dart';
import '../shortcuts/keymap_settings.dart';
import '../state/app_state.dart';
import '../state/pane_arrangement.dart';
import '../terminal/terminal_viewport.dart';
import '../usage/models_menu_controller.dart';
import '../state/swarm_catalog.dart';
import '../state/swarm_attention.dart';
import '../state/swarm_navigation.dart';
import '../state/swarm_search.dart';
import '../state/swarm.dart';
import '../widgets/layout_palette.dart';
import '../widgets/engine_identity.dart';
import '../store/store_screen.dart';
import '../widgets/harness_start_page.dart';
import '../widgets/link_machine_screen.dart';
import '../widgets/machine_actions.dart';
import '../widgets/machines_manager.dart';
import '../widgets/new_agent_dialog.dart';
import '../widgets/pane_grid.dart';
import '../widgets/shortcuts_sheet.dart';
import '../widgets/swarm_dialogs.dart';
import '../widgets/swarm_search_input.dart';
import '../widgets/swarm_attention.dart';
import '../widgets/swarm_switcher.dart';
import '../widgets/swarm_wallpaper.dart';
import '../widgets/agent_action_icons.dart';
import '../widgets/swarm_icon.dart';
import '../widgets/task_palette.dart';

class SwarmScreen extends StatefulWidget {
  const SwarmScreen({
    super.key,
    required this.notifier,
    this.nativeTabs,
    this.projectStore,
    this.modelsMenu,
  });
  final AppNotifier notifier;
  final bool? nativeTabs;
  final SwarmProjectStore? projectStore;
  final ModelsMenuController? modelsMenu;
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
  final _startSearchFocus = FocusNode(debugLabel: 'Start page search');
  final _canvasFocus = FocusNode(
    debugLabel: 'Swarm canvas',
    canRequestFocus: false,
    skipTraversal: true,
  );
  final _navigation = SwarmNavigationHistory();
  final _searchCatalog = SwarmSearchCatalog();
  final _searchText = TextEditingController();
  final _searchFocus = FocusNode(debugLabel: 'Find a harness');
  SwarmSearchController? _search;
  OverlayEntry? _searchOverlay;
  (String, bool)? _searchHeaderState;
  FocusNode? _searchReturnFocus;
  (String, bool)? _lastWorkspace;
  bool _spokenPaletteOpen = false;
  bool _dialogOpen = false;
  bool _routeIsCurrent = true;
  String? _linkDialogMachineId;
  String? _nativeState;
  List<Object?>? _machinesPresentation;
  ModelsMenuController? _modelsMenu;
  String? _modelsState;
  final _defaultKeymap = AppKeymap();
  AppKeymap? _providedKeymap;
  AppKeymap get _keymap => _providedKeymap ?? _defaultKeymap;
  String? _nativeKeyContext;
  String _pendingKeys = '';
  AppNotifier get app => widget.notifier;

  @override
  void initState() {
    super.initState();
    _keymap.addListener(_keymapChanged);
    app.hasNavigationRail = false;
    app.railFocused = false;
    _recordNavigation();
    app.addListener(_recordNavigation);
    FocusManager.instance.addListener(_restoreEmptyFocus);
    FocusManager.instance.addListener(_syncKeyContext);
    grid.AppTheme.palette.addListener(_paletteChanged);
    unawaited(_projects.load());
    _spokenTasks = app.spokenTasks.listen(_openSpokenTask);
    if (_native) {
      _modelsMenu =
          widget.modelsMenu ??
          ModelsMenuController(remote: app.readRemoteUsage);
      _modelsMenu!.addListener(_syncModels);
      _channel.setMethodCallHandler(_onNative);
      app.addListener(_syncNative);
      _syncNative();
      _syncModels();
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final keymap = KeymapTheme.of(context);
    if (keymap != _providedKeymap) {
      _keymap.removeListener(_keymapChanged);
      _providedKeymap = keymap;
      _keymap.addListener(_keymapChanged);
    }
    _syncKeymap();
    final current = ModalRoute.isCurrentOf(context) ?? true;
    if (_routeIsCurrent == current) return;
    _routeIsCurrent = current;
    if (!current && _search != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && !_routeIsCurrent) {
          _closeSearch(restoreFocus: false);
        }
      });
    }
    if (_native) _syncNative();
  }

  @override
  void dispose() {
    _keymap.removeListener(_keymapChanged);
    _defaultKeymap.dispose();
    grid.AppTheme.palette.removeListener(_paletteChanged);
    app.removeListener(_recordNavigation);
    FocusManager.instance.removeListener(_restoreEmptyFocus);
    FocusManager.instance.removeListener(_syncKeyContext);
    _searchOverlay?.remove();
    _searchOverlay?.dispose();
    _search?.dispose();
    _searchFocus.dispose();
    _searchText.dispose();
    _canvasFocus.dispose();
    _shellFocus.dispose();
    _startSearchFocus.dispose();
    unawaited(_spokenTasks?.cancel());
    if (_native) {
      _modelsMenu?.removeListener(_syncModels);
      if (widget.modelsMenu == null) _modelsMenu?.dispose();
      unawaited(
        _channel.invokeMethod<void>('modelsState', {'subscriptions': []}),
      );
      unawaited(_channel.invokeMethod<void>('machinesState', {'machines': []}));
      app.removeListener(_syncNative);
      _channel.setMethodCallHandler(null);
      unawaited(
        _channel.invokeMethod<void>('update', {'tabs': [], 'enabled': false}),
      );
    }
    if (widget.projectStore == null) _projects.dispose();
    super.dispose();
  }

  AppKeymap? _sentKeymap;
  int? _sentKeymapVersion;
  void _syncKeymap() {
    if (!_native ||
        (_sentKeymap == _keymap && _sentKeymapVersion == _keymap.version)) {
      return;
    }
    _sentKeymap = _keymap;
    _sentKeymapVersion = _keymap.version;
    unawaited(
      _channel.invokeMethod<void>('keymapState', nativeKeymapSnapshot(_keymap)),
    );
  }

  void _keymapChanged() {
    _syncKeymap();
    if (mounted) setState(() {});
    _search?.refreshCommands();
  }

  void _syncKeyContext() {
    if (!_native) return;
    final focus = FocusManager.instance.primaryFocus?.context;
    final kind = focus == null
        ? KeymapContext.workspace
        : KeymapRegion.of(focus)?.contextKind ?? KeymapContext.workspace;
    if (_nativeKeyContext == kind.name) return;
    _nativeKeyContext = kind.name;
    unawaited(
      _channel.invokeMethod<void>('keymapContext', {'context': kind.name}),
    );
  }

  bool get _shortcutsEnabled =>
      mounted && _routeIsCurrent && !_dialogOpen && !_spokenPaletteOpen;

  void _runShortcut(String id) {
    if (id == 'agent.new' && _search != null) {
      final target = _search!.targetId;
      final split = _search!.split;
      _closeSearch(restoreFocus: false);
      unawaited(_newAgent(swarmId: target, split: split));
      return;
    }
    if (!_canExecuteCommand(id)) return;
    if (id != 'navigation.commands') {
      _closeSearch();
    }
    _commands[id]?.call();
  }

  void _recordNavigation() {
    _navigation.record(app);
    if (_search != null &&
        (_search!.targetId != app.activeSwarmId ||
            (_lastWorkspace?.$2 == true && app.panes.isNotEmpty))) {
      _closeSearch(restoreFocus: false);
    }
    final workspace = (app.activeSwarmId, app.panes.isEmpty);
    if (_lastWorkspace == workspace) return;
    _lastWorkspace = workspace;
  }

  int get _attention =>
      app.machineStates.values.fold(0, (n, m) => n + m.blockedAgents.length);

  void _restoreEmptyFocus() {
    if (!mounted ||
        app.panes.isNotEmpty ||
        _dialogOpen ||
        _spokenPaletteOpen ||
        _search != null ||
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

  // Any retained session has a mounted terminal, including read-only/offline
  // output. Never-attached setup guides have no buffer to search.
  bool get _canFindTerminal => app.focusedPane?.session != null;

  void _paletteChanged() {
    _searchOverlay?.markNeedsBuild();
    if (_native) _syncNative();
  }

  String? _tabEngine(Swarm tab) {
    if (tab.panes.length != 1) return null;
    final pane = tab.panes.single;
    return app
            .stateOf(pane.machineId)
            ?.agents
            .where((agent) => agent.id == pane.agentId)
            .firstOrNull
            ?.identityEngine ??
        pane.session?.engineId;
  }

  void _syncNative() {
    _syncMachines();
    final payload = {
      'enabled': _routeIsCurrent && !_dialogOpen && !_spokenPaletteOpen,
      'activeId': app.activeSwarmId,
      'canOpenNewTab': app.canOpenNewTab,
      'palette': grid.AppTheme.palette.value.nativeColors,
      'canReopen': app.canReopenLastClosed,
      'canFind': _canFindTerminal,
      'canClosePane': app.focusedPane != null,
      'canGoBack': _navigation.canGoBack(app),
      'canGoForward': _navigation.canGoForward(app),
      'closedHistory': [
        for (final entry in closedWorkDestinations(app))
          {
            'id': entry.id,
            'title': entry.title,
            'machineName': entry.machineLabel,
            'detail': entry.detail,
            'swarm': entry.isSwarm,
            'agentCount': entry.isSwarm ? entry.members.length : 1,
            'engine': entry.engine,
            'iconAsset': engineIdentity(entry.engine).asset,
            'canReopen': app.canReopenClosed(entry.id),
          },
      ],
      'attention': _attention,
      'history': [
        for (final entry in _navigation.menuDestinations(app))
          {
            'id': entry.id,
            'title': entry.title,
            'machineName': entry.machineLabel,
            'detail': entry.detail,
            'swarm': entry.isSwarm,
            'agentCount': entry.isSwarm ? entry.members.length : 1,
            'engine': entry.engine,
            'iconAsset': engineIdentity(entry.engine).asset,
            'current': entry.current,
          },
      ],
      'tabs': [
        for (final swarm in app.swarms)
          {
            'id': swarm.id,
            'name': swarm.name,
            'kind': swarm.kind,
            'agentCount': swarm.panes.length,
            'engine': swarm.isStore ? 'store' : _tabEngine(swarm),
            'iconAsset': swarm.isStore
                ? kStoreMarkAsset
                : engineIdentity(_tabEngine(swarm)).asset,
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

  void _syncMachines() {
    final openAgents = {
      for (final tab in app.swarms)
        for (final pane in tab.panes) (pane.machineId, pane.agentId),
    };
    final machines = app.machineStates.values.take(128);
    // Compare only visible values before building/encoding a potentially large
    // inventory. Tab focus, palette and attention changes use the small update
    // message; they never resend or decode every agent on the native thread.
    final presentation = <Object?>[
      for (final machine in machines) ...[
        (
          machine.machine.machineId,
          machine.machine.displayName,
          machine.isLocalMachine,
          machine.nodeOnline,
          machine.needsLink,
          machine.agents.isNotEmpty ||
                  machine.agentLoadStatus == AgentLoadStatus.loaded
              ? machine.agents.length
              : null,
        ),
        for (final agent in machine.agents.take(512))
          (
            agent.id,
            agent.name,
            agent.engine,
            agent.terminalAvailable ||
                openAgents.contains((machine.machine.machineId, agent.id)),
          ),
      ],
    ];
    if (listEquals(presentation, _machinesPresentation)) return;
    _machinesPresentation = presentation;
    unawaited(
      _channel.invokeMethod<void>('machinesState', {
        'machines': [
          for (final machine in machines)
            {
              'id': machine.machine.machineId,
              'name': machine.machine.displayName,
              'local': machine.isLocalMachine,
              'agentCount':
                  machine.agents.isNotEmpty ||
                      machine.agentLoadStatus == AgentLoadStatus.loaded
                  ? machine.agents.length
                  : null,
              'agents': [
                for (final agent in machine.agents.take(512))
                  {
                    'id': agent.id,
                    'title': agent.name,
                    'engine': agent.engine,
                    'iconAsset': engineIdentity(agent.engine).asset,
                    'canOpen':
                        agent.terminalAvailable ||
                        openAgents.contains((
                          machine.machine.machineId,
                          agent.id,
                        )),
                  },
              ],
              // Two independent slots. `presence` is the node's own state
              // (is `harness` running/reachable?), shown after the name — a
              // definite "Online"/"Offline", or blank while unknown. `status`
              // /`linkRequired` is the trailing slot: the peer link/trust
              // between this computer and the machine. They are orthogonal, so
              // an unlinked machine whose node is up reads BOTH "Online" and
              // "Link required" instead of the link state masking presence.
              'presence': machine.nodeOnline == true
                  ? 'Online'
                  : machine.nodeOnline == false
                  ? 'Offline'
                  : '',
              'linkRequired': machine.needsLink,
              // Trailing word. Offline/Online live in `presence` now, so they
              // drop out here (the agent count fills the slot). Only the link
              // state and the still-connecting case need the trailing edge.
              'status': machine.needsLink
                  ? 'Link required'
                  : machine.nodeOnline == null
                  ? 'Connecting…'
                  : '',
            },
        ],
      }),
    );
  }

  void _syncModels() {
    final payload = {'subscriptions': _modelsMenu?.rows ?? []};
    final encoded = jsonEncode(payload);
    if (encoded == _modelsState) return;
    _modelsState = encoded;
    unawaited(_channel.invokeMethod<void>('modelsState', payload));
  }

  Future<void> _onNative(MethodCall call) async {
    if (mounted && call.method == 'keymapPending') {
      final keys = (call.arguments as Map?)?['keys'];
      if (keys is List &&
          keys.length <= 4 &&
          keys.every((key) => key is String)) {
        final pending = keys
            .map((key) => describeKeyStroke(KeyStroke.parse(key)))
            .join(' ');
        if (_pendingKeys != pending) setState(() => _pendingKeys = pending);
      }
      return;
    }
    if (!mounted ||
        _dialogOpen ||
        _spokenPaletteOpen ||
        ModalRoute.of(context)?.isCurrent == false) {
      return;
    }
    final args = call.arguments is Map ? call.arguments as Map : const {};
    if (call.method == 'modelsOpened') {
      await _modelsMenu?.refresh();
      return;
    }
    final nativeCommand = switch (call.method) {
      'keymapCommand' =>
        args['command'] is String ? args['command'] as String : null,
      'commands' => 'navigation.commands',
      'newAgent' => 'agent.new',
      _ => null,
    };
    if (nativeCommand != null) {
      final focus = FocusManager.instance.primaryFocus?.context;
      final region = focus == null ? null : KeymapRegion.of(focus);
      final action = region?.actions?[nativeCommand];
      if (action != null) {
        // Match keyboard dispatch: the focused picker owns its commands and
        // closes its own results before opening creation. Bypassing it stacks
        // another search or leaves the start-page dropdown under the dialog.
        if (region?.composing?.call() == true) return;
        action();
        if (call.method != 'keymapCommand') {
          await WidgetsBinding.instance.endOfFrame;
          if (mounted) FocusManager.instance.applyFocusChangesIfNeeded();
        }
        return;
      }
    }
    if (call.method == 'keymapCommand' &&
        nativeCommand?.startsWith('picker.') != true) {
      if (nativeCommand != null) _runShortcut(nativeCommand);
      return;
    }
    if (call.method == 'searchCommand' || call.method == 'keymapCommand') {
      final search = _search;
      if (search == null) return;
      final command =
          const {
            'picker.next': 'next',
            'picker.previous': 'previous',
            'picker.accept': 'submit',
            'picker.add_here': 'add',
            'picker.cancel': 'close',
          }[args['command']] ??
          args['command'];
      switch (command) {
        case 'next':
          search.move(1);
        case 'previous':
          search.move(-1);
        case 'submit':
          final choice = search.submit();
          if (choice != null) await _chooseSearch(choice);
        case 'add':
          final choice = search.addHere();
          if (choice != null) await _chooseSearch(choice);
        case 'close':
          _dismissSearch();
      }
      return;
    }
    if (call.method == 'newAgent' && _search != null) {
      _runShortcut('agent.new');
      await WidgetsBinding.instance.endOfFrame;
      return;
    }
    _closeSearch(restoreFocus: false);
    switch (call.method) {
      case 'new':
        _newTab();
      case 'reopen':
        app.reopenClosed();
      case 'reopenHistory':
        if (args['id'] is String) app.reopenClosed(historyId: args['id']);
      case 'historyBack':
        _stepHistory(-1);
      case 'historyForward':
        _stepHistory(1);
      case 'showHistory':
        await _showHistory();
      case 'select':
        if (args['id'] is String) app.selectSwarm(args['id']);
      case 'close':
        if (args['id'] is String) await app.closeSwarm(args['id']);
      case 'closeActive':
        await app.closeSwarm(app.activeSwarmId);
      case 'rename':
        // Acknowledge after the form opens so the titlebar can hand its native
        // keyboard focus to Flutter while the user edits the name.
        if (args['id'] is String) unawaited(_rename(args['id']));
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
      case 'newAgent':
        unawaited(_newAgent(swarmId: app.activeSwarmId));
      case 'splitRight':
        unawaited(_splitAgent(PaneResizeAxis.x));
      case 'splitDown':
        unawaited(_splitAgent(PaneResizeAxis.y));
      case 'zoomPane':
        app.toggleZoomPane();
      case 'pinPane':
        if (app.focusedPaneId != null) app.togglePinPane(app.focusedPaneId!);
      case 'addProject':
        await _addProject();
      case 'linkMachine':
        await _dialog(() => showSwarmLinkDialog(context, app));
      case 'manageMachines':
        unawaited(_dialog(() => showMachinesManager(context, app)));
      case 'refreshMachines':
        unawaited(app.retryMachines());
      case 'machineDestination':
        final machine = args['id'] is String ? app.stateOf(args['id']) : null;
        if (machine != null) {
          _openSearch(adding: true, query: machine.machine.displayName);
        }
      case 'deleteMachine':
        final machine = args['id'] is String ? app.stateOf(args['id']) : null;
        if (machine != null && !machine.isLocalMachine) {
          unawaited(
            _dialog(
              () => confirmDeleteMachine(
                context,
                app,
                machineId: machine.machine.machineId,
                displayName: machine.machine.displayName,
              ),
            ),
          );
        }
      case 'machineAgent':
        final machineId = args['machineId'], agentId = args['agentId'];
        if (machineId is String &&
            agentId is String &&
            app
                    .stateOf(machineId)
                    ?.agents
                    .any((agent) => agent.id == agentId) ==
                true) {
          final entry = swarmDestinations(app)
              .where(
                (entry) => entry.id == agentDestinationId(machineId, agentId),
              )
              .firstOrNull;
          if (entry != null) {
            _closeSearch();
            _preparePaneFocus();
            await activateSwarmDestination(
              app,
              entry,
              destinationSwarmId: app.activeSwarmId,
            );
          }
        }
      case 'commands':
        _showSearchCommands();
      case 'historyDestination':
        final entry = _navigation
            .menuDestinations(app)
            .where((entry) => entry.id == args['id'])
            .firstOrNull;
        if (entry != null) {
          _preparePaneFocus();
          await activateSwarmDestination(
            app,
            entry,
            destinationSwarmId: app.activeSwarmId,
          );
        }
      case 'closePane':
        if (app.focusedPaneId != null) await app.closePane(app.focusedPaneId!);
      case 'findTerminal':
        app.focusedPane?.session?.find(TerminalFindAction.open);
      case 'findNext':
        app.focusedPane?.session?.find(TerminalFindAction.next);
      case 'findPrevious':
        app.focusedPane?.session?.find(TerminalFindAction.previous);
      case 'notifications':
        unawaited(_notifications());
      case 'settings':
        await _settings();
    }
    if (mounted &&
        const {
          'select',
          'close',
          'new',
          'rename',
          'commands',
          'notifications',
          'addAgent',
          'newAgent',
          'manageMachines',
          'deleteMachine',
          'splitRight',
          'splitDown',
          'zoomPane',
          'pinPane',
          'machineDestination',
          'machineAgent',
        }.contains(call.method)) {
      // Native tab controls wait for this reply before releasing keyboard
      // ownership. The destination's actual focus tree must be ready first.
      await WidgetsBinding.instance.endOfFrame;
      if (mounted) FocusManager.instance.applyFocusChangesIfNeeded();
    }
  }

  Future<void> _dialog(
    Future<void> Function() action, {
    bool restoreEntry = true,
  }) async {
    if (_dialogOpen || _spokenPaletteOpen || !mounted) return;
    _closeSearch();
    _dialogOpen = true;
    // The route must not restore an old terminal while the destination changes
    // behind a dialog. Return input explicitly when that dialog finishes.
    _canvasFocus.descendantsAreFocusable = false;
    if (_native) _syncNative();
    try {
      await action();
    } finally {
      _dialogOpen = false;
      if (mounted) {
        _canvasFocus.descendantsAreFocusable = _search == null;
        if (_search == null &&
            ModalRoute.of(context)?.isCurrent != false &&
            app.focusedPane?.session?.focusInput() != true) {
          _shellFocus.requestFocus();
        }
        if (_native) _syncNative();
      }
    }
    if (restoreEntry) await _ensureEmptyEntry();
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
    PaneSplitRequest? split,
  }) async {
    // A pane never lands in the store tab: New Harness from there goes to
    // the empty starter tab (or a fresh one), the way New Tab does.
    if (swarmId == null && app.activeSwarm.isStore) app.newSwarm();
    final target = swarmId ?? _search?.targetId ?? app.activeSwarmId;
    final requestedSplit = split ?? _search?.split;
    if (app.activeSwarmId != target) return;
    final focused = requestedSplit == null ? null : app.focusedPane;
    final machine = focused == null ? null : app.stateOf(focused.machineId);
    final agent = machine?.agents
        .where((agent) => agent.id == focused?.agentId)
        .firstOrNull;
    final id =
        machineId ??
        machine?.machine.machineId ??
        app.machineStates.values
            .where((machine) => machine.isLocalMachine)
            .firstOrNull
            ?.machine
            .machineId ??
        app.machineStates.keys.firstOrNull;
    final initialFolder =
        folder ?? (agent == null ? null : machine?.projectOf(agent)?.cwd);
    await _dialog(() async {
      if (id == null) {
        await showSwarmLinkDialog(context, app);
        return;
      }
      await showNewAgentDialog(
        context,
        app,
        id,
        source: 'swarm',
        initialFolder: initialFolder,
        swarmId: target,
        split: requestedSplit,
      );
    }, restoreEntry: false);
    await _ensureEmptyEntry();
  }

  Future<void> _splitAgent(
    PaneResizeAxis axis, {
    int? paneId,
    bool create = false,
  }) async {
    final split = app.preparePaneSplit(axis, paneId: paneId);
    if (split == null) return;
    if (paneId != null) app.focusPane(split.paneId);
    if (create) {
      await _newAgent(split: split);
    } else {
      _openSearch(adding: true, split: split);
    }
  }

  Future<void> _showHistory() async {
    final target = app.activeSwarmId;
    SwarmSearchSelection? selected;
    await _dialog(() async {
      selected = await showSwarmHistory(context, app, _navigation);
    });
    if (!mounted || selected == null) return;
    await _activateSearch(selected!, target);
  }

  Future<void> _activateSearch(
    SwarmSearchSelection selected,
    String target, {
    PaneSplitRequest? split,
  }) async {
    final command = selected.destination.commandId;
    if (command != null) {
      // The result list is gone before a dialog or focus-changing command runs.
      // Recheck availability: a machine or pane may have changed while typing.
      FocusManager.instance.applyFocusChangesIfNeeded();
      if (_canExecuteCommand(command)) _commands[command]?.call();
      return;
    }
    _preparePaneFocus();
    final opened = await activateSwarmSearchSelection(
      app,
      selected,
      destinationSwarmId: target,
      projects: _projects.projects,
      split: split,
    );
    if (!opened && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('That result is no longer available. Search again.'),
        ),
      );
    }
  }

  void _openSearch({
    bool adding = false,
    PaneSplitRequest? split,
    String query = '',
  }) {
    if (_search != null ||
        !mounted ||
        _dialogOpen ||
        _spokenPaletteOpen ||
        !_routeIsCurrent) {
      return;
    }
    _searchReturnFocus ??= FocusManager.instance.primaryFocus == _searchFocus
        ? null
        : FocusManager.instance.primaryFocus;
    if (_native) _preparePaneFocus();
    // Search is an overlay, so late pane attachment needs an explicit focus
    // boundary to keep its programmatic focus request out of the picker.
    _canvasFocus.descendantsAreFocusable = false;
    _search = SwarmSearchController(
      app,
      _navigation.recent,
      projects: _projects,
      commands: _searchCommands,
      adding: adding,
      commandsOnly: !adding,
      split: split,
      catalog: _searchCatalog,
    )..setQuery(query);
    _search!.addListener(_syncSearch);
    _searchOverlay = OverlayEntry(builder: _buildSearchOverlay);
    Overlay.of(context).insert(_searchOverlay!);
    _syncSearch();
    // The overlay and focus nodes update independently of the retained canvas.
    _focusSearch();
  }

  void _focusSearch({bool selectAll = false}) {
    if (_search == null) return;
    _searchFocus.requestFocus();
    if (selectAll) {
      _searchText.selection = TextSelection(
        baseOffset: 0,
        extentOffset: _searchText.text.length,
      );
    }
  }

  void _showSearchCommands() {
    if (_search?.adding == true) _closeSearch(restoreFocus: false);
    _openSearch();
    _search?.setQuery('> ');
    _focusSearch();
  }

  void _syncSearch() {
    final search = _search;
    if (search == null) return;
    if (_searchText.text != search.query) {
      _searchText.value = TextEditingValue(
        text: search.query,
        selection: TextSelection.collapsed(offset: search.query.length),
      );
    }
    // Results listen to their controller directly. Rebuilding the entire
    // overlay on every arrow also rebuilt the unchanged text editor/button.
    final header = (search.hint, search.canCreate);
    if (_searchHeaderState != header) {
      _searchHeaderState = header;
      _searchOverlay?.markNeedsBuild();
    }
  }

  void _closeSearch({bool restoreFocus = true}) {
    if (_search == null) return;
    // Enable the chosen terminal synchronously, before activation requests its
    // focus and before the following frame rebuilds the canvas.
    _canvasFocus.descendantsAreFocusable = true;
    _searchOverlay?.remove();
    _searchOverlay?.dispose();
    _searchOverlay = null;
    _search!.removeListener(_syncSearch);
    _search!.dispose();
    _search = null;
    _searchHeaderState = null;
    _searchText.clear();
    _searchFocus.unfocus();
    final previous = _searchReturnFocus;
    _searchReturnFocus = null;
    if (restoreFocus) {
      if (previous?.context != null && previous!.canRequestFocus) {
        previous.requestFocus();
      } else {
        _shellFocus.requestFocus();
      }
    }
  }

  void _dismissSearch() => _closeSearch();

  Future<void> _ensureEmptyEntry() async {
    if (!mounted || app.panes.isNotEmpty) return;
    await WidgetsBinding.instance.endOfFrame;
    if (mounted && _shortcutsEnabled && app.panes.isEmpty) {
      _restoreEmptyFocus();
    }
  }

  Future<void> _chooseSearch(SwarmSearchSelection choice) async {
    final target = _search?.targetId;
    final split = _search?.split;
    if (target == null) return;
    _closeSearch(restoreFocus: choice.destination.isCommand);
    await _activateSearch(choice, target, split: split);
    if (mounted) {
      if (app.activeSwarmId != target) app.cancelSwarmDraft(target);
      await _ensureEmptyEntry();
    }
  }

  Widget _buildSearchOverlay(BuildContext context) {
    final search = _search!;
    final commandsOnly = search.commandsOnly;
    final panel = Material(
      key: const ValueKey('swarm-search-results'),
      elevation: 10,
      shadowColor: Colors.black38,
      color: grid.AppPalette.swarmSearchSurface,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(commandsOnly ? 14 : 32),
        side: BorderSide(color: Colors.white.withValues(alpha: .10)),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        children: [
          if (commandsOnly)
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 24, 20, 16),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Semantics(
                  header: true,
                  child: const Text(
                    'Commands',
                    style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                  ),
                ),
              ),
            ),
          Semantics(
            label: commandsOnly ? 'Search commands' : 'Find a harness',
            child: SwarmSearchInput(
              inputKey: const ValueKey('swarm-search-input'),
              controller: _searchText,
              focusNode: _searchFocus,
              search: search,
              onClose: _dismissSearch,
              onChanged: search.setQuery,
              onOpen: _focusSearch,
              showClose: true,
              rounded: true,
              prominent: !commandsOnly,
              hintText: commandsOnly ? null : 'Find a harness',
              trailing: !commandsOnly && search.split != null
                  ? KeymapRegion(
                      contextKind: KeymapContext.workspace,
                      child: IconButton(
                        key: const ValueKey('harness-picker-new'),
                        tooltip: 'New Harness',
                        onPressed: search.canCreate
                            ? () => _runShortcut('agent.new')
                            : null,
                        icon: const Icon(AgentActionIcons.create, size: 18),
                      ),
                    )
                  : null,
            ),
          ),
          Expanded(
            child: SwarmSearchResults(
              search: search,
              onChoose: _chooseSearch,
              onRefocus: _focusSearch,
            ),
          ),
          if (!commandsOnly) const SizedBox(height: 12),
        ],
      ),
    );
    return KeymapProvider(
      keymap: _keymap,
      child: LayoutBuilder(
        builder: (context, constraints) {
          final height = (constraints.maxHeight - 64).clamp(
            240.0,
            commandsOnly ? 600.0 : 760.0,
          );
          return Stack(
            children: [
              Positioned.fill(
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: _dismissSearch,
                  child: const ColoredBox(color: kDialogVeilTint),
                ),
              ),
              Align(
                alignment: const Alignment(0, -0.12),
                child: SizedBox(
                  width: (constraints.maxWidth - 64).clamp(
                    280.0,
                    commandsOnly ? 720.0 : 1120.0,
                  ),
                  height: height,
                  child: SwarmSearchKeys(
                    search: search,
                    editing: _searchText,
                    onChoose: _chooseSearch,
                    onClose: _dismissSearch,
                    onOpen: _focusSearch,
                    onNewAgent: () => _runShortcut('agent.new'),
                    onRefocus: _focusSearch,
                    child: panel,
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }

  void _stepHistory(int direction) {
    if (direction < 0
        ? !_navigation.canGoBack(app)
        : !_navigation.canGoForward(app)) {
      return;
    }
    _preparePaneFocus();
    _navigation.step(app, direction);
  }

  void _preparePaneFocus() {
    // The closing picker otherwise restores its previous terminal, whose focus
    // callback can overwrite the chosen destination during this same frame.
    _shellFocus.requestFocus();
    FocusManager.instance.applyFocusChangesIfNeeded();
  }

  Future<void> _addAgent() async {
    if (_search != null) _closeSearch(restoreFocus: false);
    _openSearch(adding: true);
  }

  void _newTab() {
    // At the cap New Tab used to do nothing at all — no tab, no sound, no word — so a person (or a
    // script) went on typing into whatever pane still had focus. Say why instead.
    if (!app.canOpenNewTab) {
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(
          const SnackBar(
            key: ValueKey('tab-limit-notice'),
            content: Text(
              '${AppNotifier.maxSwarms} tabs are open, the most Harness keeps. '
              'Close a tab to open a new one.',
            ),
          ),
        );
      return;
    }
    app.newSwarm();
    if (app.panes.isEmpty) _startSearchFocus.requestFocus();
  }

  Future<void> _addProject() => _dialog(() async {
    final project = await showSwarmProjectDialog(context, app);
    if (project != null) await _projects.add(project);
  });
  Future<void> _notifications() async {
    final target = app.activeSwarmId;
    SwarmAttentionEntry? selected;
    await _dialog(() async {
      selected = await showSwarmAttention(context, app, _navigation);
    });
    if (!mounted || selected == null) return;
    _preparePaneFocus();
    await activateSwarmAttention(app, selected!, destinationSwarmId: target);
  }

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
    _closeSearch();
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
        _search != null ||
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

  // Keyboard actions and search commands execute the same callbacks.
  late final Map<ShortcutAction, VoidCallback> _actionHandlers = {
    ShortcutAction.newSwarm: _newTab,
    ShortcutAction.reopenClosedSwarm: app.reopenClosed,
    ShortcutAction.closeSwarm: () => app.closeSwarm(app.activeSwarmId),
    ShortcutAction.renameSwarm: () => _rename(app.activeSwarmId),
    ShortcutAction.nextSwarm: () => app.stepSwarm(1),
    ShortcutAction.previousSwarm: () => app.stepSwarm(-1),
    ShortcutAction.showSettings: _settings,
    ShortcutAction.focusPaneLeft: () => app.focusPaneHorizontally(-1),
    ShortcutAction.focusPaneRight: () => app.focusPaneHorizontally(1),
    ShortcutAction.focusPaneAbove: () => app.focusPaneVertically(-1),
    ShortcutAction.focusPaneBelow: () => app.focusPaneVertically(1),
    ShortcutAction.movePaneLeft: () => app.movePaneDirection(dx: -1, dy: 0),
    ShortcutAction.movePaneRight: () => app.movePaneDirection(dx: 1, dy: 0),
    ShortcutAction.movePaneUp: () => app.movePaneDirection(dx: 0, dy: -1),
    ShortcutAction.movePaneDown: () => app.movePaneDirection(dx: 0, dy: 1),
    ShortcutAction.nextAgent: () => _stepHistory(1),
    ShortcutAction.previousAgent: () => _stepHistory(-1),
    ShortcutAction.showHistory: _showHistory,
    ShortcutAction.findTerminal: () =>
        app.focusedPane?.session?.find(TerminalFindAction.open),
    ShortcutAction.findNext: () =>
        app.focusedPane?.session?.find(TerminalFindAction.next),
    ShortcutAction.findPrevious: () =>
        app.focusedPane?.session?.find(TerminalFindAction.previous),
    ShortcutAction.lastPane: app.focusLastPane,
    ShortcutAction.zoomPane: app.toggleZoomPane,
    ShortcutAction.showAttention: _notifications,
    ShortcutAction.addAgent: _addAgent,
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
  };

  late final Map<String, VoidCallback> _commands = {
    for (final command in harnessCommands)
      if (command.action != null && _actionHandlers.containsKey(command.action))
        command.id: _actionHandlers[command.action]!,
    for (var i = 1; i <= kTabDigitCount; i++)
      'swarm.select_$i': () => app.selectSwarmByIndex(i - 1),
    for (var i = 1; i <= 9; i++)
      'pane.focus_$i': () => app.focusPaneByIndex(i - 1),
    'navigation.commands': _showSearchCommands,
    'machine.link': () => _dialog(() => showSwarmLinkDialog(context, app)),
    'machines.manage': () => _dialog(() => showMachinesManager(context, app)),
    'project.add': _addProject,
    'keyboard.open_config': () => openKeyboardConfig(context),
    'pane.resize': app.beginPaneResize,
    'pane.reset_sizes': app.resetPaneSizes,
    'pane.split_right': () => _splitAgent(PaneResizeAxis.x),
    'pane.split_down': () => _splitAgent(PaneResizeAxis.y),
  };

  bool _canExecuteCommand(String id) {
    if (!_commands.containsKey(id) ||
        !_routeIsCurrent ||
        _dialogOpen ||
        _spokenPaletteOpen) {
      return false;
    }
    if (id == 'keyboard.open_config') return _keymap.store != null;
    if (id == 'pane.layout' || id == 'task.route') return true;
    if (id.startsWith('swarm.select_')) {
      final number = int.tryParse(id.substring('swarm.select_'.length));
      return number != null && number >= 1 && number <= app.swarms.length;
    }
    // Always runnable: at the tab cap it explains itself rather than silently doing nothing.
    if (id == 'swarm.new') return true;
    if (id == 'swarm.reopen') return app.canReopenLastClosed;
    if (id == 'swarm.next' || id == 'swarm.previous') {
      return app.swarms.length > 1;
    }
    if (id == 'navigation.back') return _navigation.canGoBack(app);
    if (id == 'navigation.forward') return _navigation.canGoForward(app);
    if (id.startsWith('terminal.')) return _canFindTerminal;
    if (id == 'pane.resize') {
      return app.panes.length > 1 && app.zoomedPaneId == null;
    }
    if (id == 'pane.split_right') {
      return app.preparePaneSplit(PaneResizeAxis.x) != null;
    }
    if (id == 'pane.split_down') {
      return app.preparePaneSplit(PaneResizeAxis.y) != null;
    }
    if (id == 'pane.reset_sizes') {
      return app.activeSwarm.paneSizes.keys.any(
        (key) => key.startsWith('${app.panes.length}:'),
      );
    }
    if (id.startsWith('pane.') || id == 'task.route') {
      return app.focusedPane != null;
    }
    return true;
  }

  List<SwarmDestination> _searchCommands() => [
    for (final command in harnessCommands)
      if (command.id != 'navigation.commands' &&
          !RegExp(r'^pane\.focus_[1-9]$').hasMatch(command.id) &&
          _canExecuteCommand(command.id))
        SwarmDestination(
          id: 'command:${command.id}',
          title: command.label,
          detail: command.group.label,
          swarmId: null,
          current: false,
          commandId: command.id,
          shortcut: _keymap.hint(command.id),
          searchFields: [command.id],
        ),
  ];

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
      return KeymapProvider(
        keymap: _keymap,
        child: KeymapHost(
          keymap: _keymap,
          enabled: () => _shortcutsEnabled,
          canExecute: _canExecuteCommand,
          actions: {
            for (final id in _commands.keys) id: () => _runShortcut(id),
          },
          onPending: (keys) => setState(() => _pendingKeys = keys),
          child: Focus(
            focusNode: _shellFocus,
            autofocus: app.panes.isNotEmpty,
            child: Scaffold(
              backgroundColor: grid.AppPalette.swarmField,
              body: Column(
                children: [
                  if (!_native) _tabStrip(),
                  if (_keymap.error != null)
                    Material(
                      color: grid.AppPalette.panelBg,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 16),
                        child: Row(
                          children: [
                            const Expanded(
                              child: Text(
                                'Keyboard config has an error. Using the last working shortcuts.',
                                style: TextStyle(fontSize: 12),
                              ),
                            ),
                            TextButton(
                              onPressed: () =>
                                  _dialog(() => showShortcutsSheet(context)),
                              child: const Text('Details'),
                            ),
                          ],
                        ),
                      ),
                    ),
                  if (_pendingKeys.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 16,
                        vertical: 4,
                      ),
                      child: Align(
                        alignment: Alignment.centerLeft,
                        child: Text(
                          '$_pendingKeys …  Esc to cancel',
                          style: TextStyle(
                            fontSize: 12,
                            color: grid.AppPalette.textSecondary,
                          ),
                        ),
                      ),
                    ),
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
                            if (_projects.error == null &&
                                app.lastErrorRetryable)
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
                          const RepaintBoundary(
                            key: ValueKey('harness-start-background'),
                            child: SwarmWallpaper(),
                          ),
                        if (app.activeSwarm.isStore)
                          StoreTab(
                            key: ValueKey('store-tab:${app.activeSwarmId}'),
                            notifier: app,
                            source: 'tab',
                          )
                        else
                        Padding(
                          padding: app.panes.isEmpty
                              ? EdgeInsets.zero
                              : const EdgeInsets.all(10),
                          child: Focus.withExternalFocusNode(
                            focusNode: _canvasFocus,
                            includeSemantics: false,
                            child: Stack(
                              children: [
                                Positioned.fill(
                                  child: PaneGrid(
                                    notifier: app,
                                    swarmMode: true,
                                    onSplit: (paneId, axis) => unawaited(
                                      _splitAgent(axis, paneId: paneId),
                                    ),
                                    onNewSplit: (paneId, axis) => unawaited(
                                      _splitAgent(
                                        axis,
                                        paneId: paneId,
                                        create: true,
                                      ),
                                    ),
                                    empty: app.panes.isEmpty
                                        ? HarnessStartPage(
                                            key: ValueKey(
                                              'harness-start:${app.activeSwarmId}',
                                            ),
                                            focusNode: _startSearchFocus,
                                            createSearch: () =>
                                                SwarmSearchController(
                                                  app,
                                                  _navigation.recent,
                                                  projects: _projects,
                                                  commands: _searchCommands,
                                                  adding: true,
                                                  catalog: _searchCatalog,
                                                ),
                                            onNew: _newAgent,
                                            onStore: app.openStore,
                                            onChoose: (selection) =>
                                                _activateSearch(
                                                  selection,
                                                  app.activeSwarmId,
                                                ),
                                          )
                                        : null,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
    },
  );

  /// Below this the strip's fixed furniture does not fit: the notification and new-tab buttons are
  /// ~48 each, the two harness buttons ~150 each once icon and padding are counted, plus 32 of gaps —
  /// about 430 before the tab list gets a single pixel. Rather than let the Row overflow, the two
  /// labelled buttons drop to their icons, which is what their tooltips are for.
  static const double _labelledStripMinWidth = 560;

  Widget _tabStrip() => LayoutBuilder(
    builder: (context, constraints) {
      final compact =
          constraints.maxWidth <
          _labelledStripMinWidth *
              MediaQuery.textScalerOf(context).scale(12) /
              12;
      return Container(
        height: 52,
        color: grid.AppPalette.swarmTabBar,
        child: Row(
          children: [
            IconButton(
              key: const ValueKey('swarm-notifications-button'),
              onPressed: _notifications,
              icon: Badge(
                isLabelVisible: _attention > 0,
                child: Icon(
                  Icons.notifications_none,
                  size: 20,
                  semanticLabel: _attention > 0
                      ? '$_attention agents need input'
                      : 'Notifications',
                ),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
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
                      child: _TabActionsReveal(
                        builder: (showClose) => Container(
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
                                  style: TextButton.styleFrom(
                                    animationDuration: Duration.zero,
                                    foregroundColor:
                                        app.activeSwarmId == swarm.id
                                        ? Colors.white
                                        : Colors.white70,
                                  ),
                                  child: Row(
                                    children: [
                                      if (swarm.isStore)
                                        // The store's own mark: a shelf of
                                        // four tiles, one lifted.
                                        Image.asset(
                                          kStoreMarkAsset,
                                          key: ValueKey('tab-store:${swarm.id}'),
                                          width: 16,
                                          height: 16,
                                        )
                                      else if (swarm.panes.length == 1)
                                        EngineMark(
                                          key: ValueKey(
                                            'tab-engine:${swarm.id}',
                                          ),
                                          engine: _tabEngine(swarm),
                                          size: 16,
                                        )
                                      else if (swarm.panes.length > 1)
                                        SwarmIcon(
                                          key: ValueKey(
                                            'tab-group:${swarm.id}',
                                          ),
                                          size: 16,
                                          color: Colors.white70,
                                        )
                                      else
                                        const Icon(Icons.add, size: 16),
                                      const SizedBox(width: 8),
                                      Expanded(
                                        child: Text(
                                          swarm.name,
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                          style: const TextStyle(fontSize: 13),
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                              Opacity(
                                key: ValueKey('tab-close:${swarm.id}'),
                                opacity: showClose ? 1 : 0,
                                alwaysIncludeSemantics: true,
                                child: IconButton(
                                  onPressed: () => app.closeSwarm(swarm.id),
                                  icon: Icon(
                                    Icons.close,
                                    size: 13,
                                    semanticLabel: 'Close ${swarm.name}',
                                  ),
                                  constraints: const BoxConstraints.tightFor(
                                    width: 30,
                                    height: 30,
                                  ),
                                  padding: EdgeInsets.zero,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  );
                },
              ),
            ),
            IconButton(
              key: const ValueKey('swarm-new-tab-button'),
              onPressed: app.canOpenNewTab ? _newTab : null,
              icon: const Icon(Icons.add, size: 18, semanticLabel: 'New Tab'),
            ),
            _harnessButton(create: true, compact: compact),
            SizedBox(width: compact ? 4 : 10),
            _harnessButton(create: false, compact: compact),
            SizedBox(width: compact ? 6 : 12),
          ],
        ),
      );
    },
  );

  Widget _harnessButton({required bool create, bool compact = false}) {
    final label = create ? 'New Harness' : 'Open Harness';
    final icon = Icon(
      create ? AgentActionIcons.create : AgentActionIcons.open,
      size: 16,
    );
    if (compact) {
      // Same key, same action, same words — carried by the tooltip instead of a label there is no
      // room for. A strip that overflows shows the user nothing at all.
      return Tooltip(
        message: label,
        child: TextButton(
          key: ValueKey(
            create ? 'swarm-new-agent-button' : 'swarm-open-agent-button',
          ),
          onPressed: create ? _newAgent : _addAgent,
          style: TextButton.styleFrom(
            enabledMouseCursor: SystemMouseCursors.click,
            minimumSize: const Size(40, 34),
            padding: const EdgeInsets.symmetric(horizontal: 10),
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            backgroundColor: create
                ? grid.AppPalette.swarmAccent
                : Colors.transparent,
            foregroundColor: create
                ? grid.AppPalette.swarmTabBar
                : grid.AppPalette.textPrimary,
            shape: StadiumBorder(
              side: create
                  ? BorderSide.none
                  : const BorderSide(color: Colors.white24),
            ),
          ),
          child: icon,
        ),
      );
    }
    return TextButton.icon(
      key: ValueKey(
        create ? 'swarm-new-agent-button' : 'swarm-open-agent-button',
      ),
      onPressed: create ? _newAgent : _addAgent,
      style: TextButton.styleFrom(
        enabledMouseCursor: SystemMouseCursors.click,
        minimumSize: const Size(122, 34),
        padding: const EdgeInsets.symmetric(horizontal: 20),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        textStyle: Theme.of(context).textTheme.labelLarge
            ?.copyWith(fontSize: 12, fontWeight: FontWeight.w500),
        backgroundColor: create
            ? grid.AppPalette.swarmAccent
            : Colors.transparent,
        foregroundColor: create
            ? grid.AppPalette.swarmTabBar
            : grid.AppPalette.textPrimary,
        shape: StadiumBorder(
          side: create
              ? BorderSide.none
              : const BorderSide(color: Colors.white24),
        ),
      ),
      icon: icon,
      label: Text(label),
    );
  }
}

/// Hovering or focusing one tab only rebuilds its own controls.
class _TabActionsReveal extends StatefulWidget {
  const _TabActionsReveal({required this.builder});
  final Widget Function(bool visible) builder;

  @override
  State<_TabActionsReveal> createState() => _TabActionsRevealState();
}

class _TabActionsRevealState extends State<_TabActionsReveal> {
  bool _hovered = false, _focused = false;

  @override
  Widget build(BuildContext context) => MouseRegion(
    onEnter: (_) => setState(() => _hovered = true),
    onExit: (_) => setState(() => _hovered = false),
    child: Focus(
      canRequestFocus: false,
      includeSemantics: false,
      onFocusChange: (value) => setState(() => _focused = value),
      child: widget.builder(_hovered || _focused),
    ),
  );
}
