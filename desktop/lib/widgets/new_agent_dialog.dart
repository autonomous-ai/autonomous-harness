import 'dart:async';
import 'dart:math' as math;

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../analytics/analytics.dart';
import '../state/pane_arrangement.dart';
import '../core/engine_availability.dart';
import '../core/codex_profiles.dart';
import '../core/dsh_catalog.dart';
import '../core/first_task.dart';
import '../core/permission_modes.dart';
import '../core/project_folder.dart';
import '../core/repository_clone.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../shared/widgets/app_choice_picker.dart';
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_select_field.dart';
import '../state/app_state.dart';
import '../store/store_editorial.dart';
import 'engine_identity.dart';
import 'codex_profile_field.dart';
import 'agent_picker.dart';
import 'remote_folder_picker.dart';
import 'new_agent_project_picker.dart';
import 'new_harness_help.dart';
import 'dsh_install_panel.dart';

enum NewAgentDialogResult { created, findExisting, backToSearch }

enum _FolderSource { newProject, local, remote }

/// Opens the Create Agent dialog for [machineId].
///
/// [source] names the door it was opened by — `machine_row`, `rail_empty`,
/// `pane_empty` or `shortcut` — and is required rather than defaulted, so a
/// fifth entry point has to say which one it is instead of quietly filing
/// itself under an existing name.
///
/// Hosts with an Add picker can set [offerFindExisting] and handle
/// [NewAgentDialogResult.findExisting] after the dialog closes.
Future<NewAgentDialogResult?> showNewAgentDialog(
  BuildContext context,
  AppNotifier notifier,
  String machineId, {
  required String source,
  String? initialFolder,
  String? swarmId,
  PaneSplitRequest? split,
  Future<void>? initialEngineProbe,
  bool offerFindExisting = false,
  bool offerBackToSearch = false,

  /// Open with this engine or harness already chosen — the store's Get and
  /// Open buttons, which know exactly which one the person is looking at.
  String? initialEngine,

  /// The harness's first message, sent as it starts — the store's "Try this prompt".
  String? initialPrompt,
}) {
  // Reported here rather than at each call site: the doors are four and
  // growing, and one that forgets to track is a hole in the funnel that only
  // shows up as a number quietly being too small.
  if (notifier.stateOf(machineId)?.machine.isShared == true) {
    machineId =
        notifier.machineStates.values
            .where((m) => !m.machine.isShared)
            .firstOrNull
            ?.machine
            .machineId ??
        '';
  }
  analytics.newAgentOpened(source: source);
  return showAppDialog<NewAgentDialogResult>(
    context: context,
    transitionDuration: Duration.zero,
    veilBlur: 0,
    builder: (context) => _NewAgentDialog(
      notifier: notifier,
      initialEngine: initialEngine,
      initialPrompt: initialPrompt,
      machineId: machineId,
      initialFolder: initialFolder,
      swarmId: swarmId ?? notifier.activeSwarmId,
      split: split,
      initialEngineProbe: initialEngineProbe,
      offerFindExisting: offerFindExisting,
      offerBackToSearch: offerBackToSearch,
    ),
  );
}

class _NewAgentDialog extends StatefulWidget {
  final AppNotifier notifier;
  final String machineId;
  final String? initialFolder;
  final String swarmId;
  final PaneSplitRequest? split;
  final Future<void>? initialEngineProbe;
  final bool offerFindExisting;
  final bool offerBackToSearch;

  const _NewAgentDialog({
    required this.notifier,
    required this.machineId,
    this.initialFolder,
    required this.swarmId,
    this.split,
    this.initialEngineProbe,
    required this.offerFindExisting,
    required this.offerBackToSearch,
    this.initialEngine,
    this.initialPrompt,
  });

  /// An engine or harness to open on, chosen elsewhere (the store); null lets
  /// the remembered or first installed engine win.
  final String? initialEngine;

  /// A first message to start the harness with (the store's "Try this prompt").
  final String? initialPrompt;

  @override
  State<_NewAgentDialog> createState() => _NewAgentDialogState();
}

class _NewAgentDialogState extends State<_NewAgentDialog> {
  /// The task: sent, exactly as written, as the harness's first message. Empty
  /// starts the harness with nothing sent. The Store's "Try this prompt" fills
  /// it, and the person can change it before creating.
  late final _task = TextEditingController(
    text: widget.initialPrompt?.trim() ?? '',
  );
  String? get _firstPrompt {
    final task = _task.text.trim();
    return task.isEmpty || !_takesTask || _taskTooLong ? null : task;
  }

  /// Whether the chosen agent can start on a task at all: only some engines
  /// can be opened with a first message, and a machine refuses one for the
  /// rest. The field says so and keeps what was typed, unsent.
  bool get _takesTask => takesFirstTask(_baseEngine(_engine));

  /// Longer than a machine accepts: Create waits until it is shortened, rather
  /// than sending something the machine refuses or cutting it.
  bool get _taskTooLong =>
      _takesTask && _task.text.trim().length > kFirstTaskMaxLength;
  late bool _taskWasTooLong = _taskTooLong;

  /// Rebuilds the dialog, not just the field, when Create's answer changes.
  void _onTaskChanged() {
    if (_taskTooLong == _taskWasTooLong) return;
    setState(() => _taskWasTooLong = _taskTooLong);
  }

  final _folderFocus = FocusNode(debugLabel: 'Working folder');
  final _agentSearchFocus = FocusNode(debugLabel: 'Agent search');
  final _actionFocus = FocusNode(debugLabel: 'Create or check agent');
  GitHubRepository? _repository;
  final _choicesScroll = ScrollController();
  final _projectChoices = PageStorageBucket();
  late _FolderSource _folderSource = widget.initialFolder == null
      ? _FolderSource.newProject
      : _FolderSource.local;
  String? _preparedFolder;
  AgentCreationAttempt? _creation;
  bool _checkingCreation = false;
  bool get _confirmationPending => _creation?.awaitingConfirmation == true;
  bool get _choicesLocked => _submitting || _confirmationPending;
  late String _engine = allEngines.first.id;
  bool _engineChosenByUser = false;
  late String _machineId = widget.machineId;
  int _machineRevision = 0;
  late String? _folder = widget.initialFolder;
  LocalCodexProfile? _codexProfile;
  bool _codexProfilesBusy = true;

  /// Auto-approve unless the person picks otherwise: a new harness works without stopping to ask
  /// for each command — Claude Code's manual mode was what every harness opened in before. Kept
  /// across engine changes; an engine without the picked mode uses its default instead.
  String _permissionMode = kDefaultPermissionMode;

  /// The mode [engine] launches in: the picked one when it has it.
  String _permissionModeFor(String engine) {
    final modes = permissionModesOf(engine);
    return modes.any((mode) => mode.id == _permissionMode)
        ? _permissionMode
        : kDefaultPermissionMode;
  }

  /// Whether the fold is open. Closed on every open of the dialog, deliberately:
  /// it is shut for the case it exists to serve, and a drawer that remembers
  /// being open is a drawer that is open for somebody who never asked.
  bool _advancedOpen = false;
  bool _submitting = false;

  /// A harness install is running ahead of the create. Its progress line is
  /// read off the machine's catalog on every rebuild; this only decides what
  /// the button says.
  bool _installing = false;

  @override
  void dispose() {
    _task.dispose();
    _folderFocus.dispose();
    _agentSearchFocus.dispose();
    _actionFocus.dispose();
    _choicesScroll.dispose();
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    _task.addListener(_onTaskChanged);
    final remembered = widget.notifier.agentPreference.value;
    final asked = widget.initialEngine;
    if (asked != null &&
        (isHarnessId(asked) ||
            isTerminalEngine(asked) ||
            allEngines.any((identity) => identity.id == asked))) {
      // Chosen before the dialog opened: counts as the person's choice, so no
      // probe or remembered preference moves it.
      _engine = asked;
      _engineChosenByUser = true;
    } else if (_knownChoice(remembered)) {
      _engine = remembered!;
      _engineChosenByUser = true;
    } else {
      _engine = _preferredInstalledEngine();
    }
    // Which engines this machine actually has. Asked here rather than at
    // connect because the answer costs the far side one interactive shell per
    // engine and is only ever read on this screen. Deferred a frame so the
    // probe's first notifyListeners() does not land mid-build.
    //
    // `force`, every time this dialog opens. A cached answer is worth nothing
    // here: engines arrive and leave through a terminal this app never sees —
    // `npm i -g opencode-ai`, `npm uninstall -g`, a venv deleted out from under
    // a symlink — and an install this very dialog started makes its own stored
    // answer stale the moment it finishes. Re-asking is bounded (one sweep, on
    // a deliberate user action) and the stored rows keep rendering until the new
    // answer lands, so nothing blanks.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        // The modal's fallback focus can win autofocus. Claim the first
        // actionable control once the route and its focus tree are mounted:
        // the agent search, so the dialog opens ready to type — or the
        // project, when the agent was chosen before it opened (the Store).
        (widget.initialEngine == null ? _agentSearchFocus : _folderFocus)
            .requestFocus();
        unawaited(_probeEngines(initialProbe: widget.initialEngineProbe));
        // And the harnesses, whatever is selected: what the machine has
        // installed is what the agent row shows first.
        unawaited(_probeHarnesses());
        unawaited(_loadAgentPreference());
      }
    });
  }

  /// Whether [id] is something this dialog can offer: an engine, or a harness
  /// this build ships a face for, or one the machine has named.
  bool _knownChoice(String? id) =>
      id != null &&
      (isTerminalEngine(id) ||
          allEngines.any((identity) => identity.id == id) ||
          knownHarnesses.any((identity) => identity.id == id) ||
          _harness(id) != null);

  /// Which harnesses this machine has or could install — asked when a harness
  /// is chosen, not on open: most creates never involve one, and the answer
  /// costs the machine a request. Forced, for the reason `_probeEngines`
  /// gives: an install this very dialog starts is what makes a stored answer
  /// stale.
  Future<void> _probeHarnesses() =>
      widget.notifier.probeDsh(_machineId, force: true);

  /// The machine's row for harness [id], or null while it has not answered
  /// (or does not know the request). Null is "unknown", never "absent".
  DshEntry? _harness(String id) {
    final machine = widget.notifier.stateOf(_machineId);
    if (machine == null || !machine.dsh.loaded) return null;
    return machine.dsh[id];
  }

  bool get _engineIsHarness => isHarnessId(_engine);

  /// A shell rather than an agent: nothing to install, no task, no permission
  /// mode, and a folder is a place to open in, not a project to prepare.
  bool get _engineIsTerminal => isTerminalEngine(_engine);

  /// The engine a choice actually launches: a harness runs ON one of them, and
  /// that is what travels as `engine` beside the harness id.
  String _baseEngine(String id) => isHarnessId(id)
      ? _harness(id)?.engine ?? knownHarnessBase[id] ?? 'claude'
      : id;

  /// What to call [id] on screen: the machine's name for a harness when it has
  /// answered, else this build's.
  String _labelOf(String id) =>
      _harness(id)?.name ??
      (id == 'claude' ? 'Claude Code' : engineIdentity(id).label);

  /// The harness is absent from this machine and Harness would install it
  /// before launching. False until the machine has answered: a harness cannot
  /// be called missing on the strength of a request that has not come back.
  bool _willInstallHarness(String id) {
    final entry = _harness(id);
    return entry != null && !entry.installed;
  }

  /// The line under a harness's name in the agent search: its tagline, in
  /// the project's own words. The machine's catalog first, this build's words
  /// when the machine's CLI does not send one, then its domain, then its
  /// description.
  String? _harnessTagline(DshEntry harness) {
    final identity = engineIdentity(harness.id);
    for (final line in [
      harness.tagline,
      identity.tagline,
      harness.category ?? identity.category,
      harness.description,
    ]) {
      if (line != null && line.trim().isNotEmpty) return line.trim();
    }
    return null;
  }

  /// The harnesses to list after the engines: what the machine named when it
  /// has answered, else the ones this build ships a face for.
  List<DshEntry> get _harnessOptions {
    final machine = widget.notifier.stateOf(_machineId);
    if (machine != null &&
        machine.dsh.loaded &&
        machine.dsh.entries.isNotEmpty) {
      // A viewer package is installed beside the harnesses that use it; it is
      // not something to create.
      return [
        for (final entry in machine.dsh.entries)
          if (!entry.isViewerPackage) entry,
      ];
    }
    return [
      for (final identity in knownHarnesses)
        DshEntry(
          id: identity.id,
          name: identity.label,
          category: identity.category,
          author: identity.creator,
          engine: knownHarnessBase[identity.id] ?? 'claude',
        ),
    ];
  }

  /// The one-line install status while a harness install is running, read off
  /// the machine's own narration (`dsh_install_status`), or null.
  /// The install this dialog is watching for the chosen harness: the one in
  /// flight, or the one that just failed (kept on screen so its verdict and
  /// the fix it names stay readable under the Retry). Null otherwise.
  DshInstallRun? get _installRun {
    final run = widget.notifier.stateOf(_machineId)?.dsh.runs[_engine];
    if (run == null) return null;
    if (_installing) return run;
    if (run.failed && _willInstallHarness(_engine)) return run;
    return null;
  }

  Future<void> _loadAgentPreference() async {
    await widget.notifier.agentPreference.load();
    if (!mounted || _choicesLocked || _engineChosenByUser) return;
    final remembered = widget.notifier.agentPreference.value;
    if (_knownChoice(remembered)) {
      setState(() {
        _engineChosenByUser = true;
        if (_engine != remembered) {
          _engine = remembered!;
          _codexProfile = null;
          _codexProfilesBusy = true;
        }
      });
    }
  }

  String _preferredInstalledEngine() {
    // A harness is not in the engine probe at all; its own install state is
    // the machine's catalog, and a remembered harness stays chosen. Nor is
    // the terminal: every machine has a shell.
    if (_engineIsHarness || _engineIsTerminal) return _engine;
    final engines = widget.notifier.stateOf(_machineId)?.engines;
    if (engines?.loaded != true || engines?[_engine]?.installed == true) {
      return _engine;
    }
    return allEngines
            .where((identity) => engines?[identity.id]?.installed == true)
            .firstOrNull
            ?.id ??
        _engine;
  }

  Future<void> _probeEngines({Future<void>? initialProbe}) async {
    final machineId = _machineId;
    final revision = _machineRevision;
    await (initialProbe ??
        widget.notifier.probeEngines(machineId, force: true));
    if (!mounted ||
        revision != _machineRevision ||
        _choicesLocked ||
        _engineChosenByUser) {
      return;
    }
    final preferred = _preferredInstalledEngine();
    if (preferred == _engine) return;
    setState(() {
      _engine = preferred;
      _codexProfile = null;
      _codexProfilesBusy = true;
    });
  }

  /// What this machine said about the selected engine, or null while the probe
  /// is still out (or when the machine could not answer).
  ///
  /// Null is deliberately not "missing": until the machine has spoken, this
  /// dialog behaves exactly as it did before the probe existed. Claiming an
  /// engine is absent on no evidence would send someone to install one they
  /// already have.
  EngineAvailability? _availability(String engine) {
    final machine = widget.notifier.stateOf(_machineId);
    if (machine == null || !machine.engines.loaded) return null;
    return machine.engines[engine];
  }

  /// A failed availability check can be retried without changing the choices.
  bool get _engineCheckFailed {
    final machine = widget.notifier.stateOf(_machineId);
    if (machine == null) return false;
    return !machine.engines.loaded && machine.engines.error != null;
  }

  bool get _checkingEngines =>
      widget.notifier.stateOf(_machineId)?.engines.inFlight != null;

  void _retryEngineCheck() {
    if (_choicesLocked || _checkingEngines) return;
    unawaited(_probeEngines());
  }

  bool _picking = false;
  String? _error;

  /// Whether the machine this agent will run on is the computer the app is
  /// running on, which is what decides where the folder is picked.
  ///
  /// Read per build rather than cached: `localOnly`/`localEndpoint` are settled
  /// by `_refreshMachines`, which can land while this dialog is open.
  bool get _machineIsThisComputer =>
      widget.notifier.stateOf(_machineId)?.isLocalMachine ?? false;

  /// Create waits while the Codex profile list is still loading on a machine
  /// that can launch into one, so a click cannot land before the choice does.
  bool get _waitingForCodexProfile =>
      _baseEngine(_engine) == 'codex' &&
      _availability('codex')?.supportsCodexHome == true &&
      _codexProfilesBusy;

  /// [Machine.displayName], not `name` — the latter is nullable and a machine
  /// that never got one would title the dialog "Create Agent on null".
  String get _machineName =>
      widget.notifier.stateOf(_machineId)?.machine.displayName ??
      'this machine';

  Future<String?> _browse() async {
    if (_picking || _choicesLocked) return null;
    setState(() => _picking = true);
    final revision = _machineRevision;
    try {
      final picked = _machineIsThisComputer
          ? await getDirectoryPath(initialDirectory: _folder)
          : await showRemoteFolderPicker(
              context,
              notifier: widget.notifier,
              machineId: _machineId,
              initialPath: _folder,
            );
      return mounted && !_choicesLocked && revision == _machineRevision
          ? picked
          : null;
    } catch (_) {
      if (mounted && revision == _machineRevision) {
        setState(() => _error = 'Could not open the folder picker. Try again.');
      }
      return null;
    } finally {
      if (mounted) setState(() => _picking = false);
    }
  }

  Future<void> _submit() async {
    final terminal = _engineIsTerminal;
    // A terminal never prepares a folder: "Home" is no cwd at all, which the
    // daemon opens at the machine's home, and a Git repository is not on
    // offer for it.
    final project = _preparedFolder == null && !terminal
        ? _projectFolder
        : null;
    final folder =
        _preparedFolder ??
        (_folderSource == _FolderSource.local ? _folder : null);
    if ((folder == null && project == null && !terminal) ||
        _submitting ||
        (!_confirmationPending && _waitingForCodexProfile)) {
      return;
    }
    final choice = _engine;
    final harness = _engineIsHarness ? choice : null;
    final engine = _baseEngine(choice);
    final profile = _codexProfile;
    final hasModes = permissionModesOf(engine).isNotEmpty;
    final permissionMode = hasModes ? _permissionModeFor(engine) : null;
    final bypassPermission =
        permissionMode != null && permissionModeApproves(permissionMode);
    if (!_confirmationPending) _creation = AgentCreationAttempt();
    setState(() {
      _checkingCreation = _confirmationPending;
      _submitting = true;
      _error = null;
    });
    // A harness the machine does not have yet is installed FIRST, as its own
    // step with its own words: minutes of clone and toolchain under a button
    // that said "Creating harness…" would read as a create that hung. The
    // machine's catalog decides "has it" — asked AGAIN at this moment, not
    // read from the answer the dialog opened with: a harness removed or
    // installed in the meantime (`harness dsh remove` in a terminal, another
    // window) made the stale answer send a create for a harness the machine
    // no longer had, and the create failed with "not installed" instead of
    // installing. The answer is an index read on the machine; it is cheap.
    if (harness != null && !_confirmationPending) {
      await _probeHarnesses();
      if (!mounted) return;
      // A machine whose Harness CLI predates harnesses refuses `dsh_list`
      // and would take `dsh` on `agent_create` in silence — creating a plain
      // Claude Code where Autonomous Circuit was picked. Say so and stop here instead.
      final catalog = widget.notifier.stateOf(_machineId)?.dsh;
      if (catalog != null && !catalog.loaded && catalog.error != null) {
        setState(() {
          _submitting = false;
          _error =
              'Update Harness CLI on $_machineName to create a '
              '${_labelOf(harness)} harness.';
        });
        return;
      }
    }
    if (harness != null &&
        !_confirmationPending &&
        _willInstallHarness(harness)) {
      setState(() => _installing = true);
      final failure = await widget.notifier.installDsh(_machineId, harness);
      if (!mounted) return;
      setState(() => _installing = false);
      if (failure != null) {
        setState(() {
          _submitting = false;
          _error = failure;
        });
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) _actionFocus.requestFocus();
        });
        return;
      }
    }
    final error = await widget.notifier.createAgent(
      _machineId,
      engine: engine,
      folder: terminal ? folder : folder ?? '',
      projectFolder: project,
      swarmId: widget.swarmId,
      split: widget.split,
      bypassPermission: bypassPermission,
      permissionMode: permissionMode,
      // Keep the explicit choice even if machine discovery changes mid-submit.
      // The notifier must reject a now-remote target, never use its default login.
      codexHome: engine == 'codex' ? profile?.path : null,
      dsh: harness,
      prompt: _firstPrompt,
      attempt: _creation,
    );
    if (!mounted) return;
    if (error != null) {
      setState(() {
        if (!_confirmationPending) {
          _preparedFolder = _creation?.preparedFolder;
          if (_preparedFolder != null) {
            _folder = _preparedFolder;
            _repository = null;
            _folderSource = _FolderSource.local;
          }
        }
        _submitting = false;
        _error = error;
      });
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _actionFocus.requestFocus();
      });
      return;
    }
    analytics.agentCreated(
      engine: choice,
      bypassPermission: bypassPermission,
      permissionMode: permissionMode,
    );
    // What New Harness lists first next time, before anything is typed.
    unawaited(widget.notifier.agentPreference.remember(choice));
    Navigator.of(context).pop(NewAgentDialogResult.created);
  }

  ProjectFolderRequest? get _projectFolder => switch (_folderSource) {
    _FolderSource.newProject => const ProjectFolderRequest.newProject(),
    _FolderSource.local => null,
    _FolderSource.remote => switch (_repository) {
      final repository? => ProjectFolderRequest.remote(repository),
      null => null,
    },
  };

  void _toggleAdvanced() => setState(() => _advancedOpen = !_advancedOpen);

  @override
  Widget build(BuildContext context) {
    // Reads colour tokens, and lives in an Overlay — a top-down rebuild never
    // reaches it, so it has to watch for itself or it strands on the palette it
    // opened with.
    grid.AppTheme.watch(context);
    return ListenableBuilder(
      listenable: widget.notifier,
      builder: (context, _) => PopScope(
        // The launch request cannot be cancelled after it is sent. Keep its
        // outcome visible instead of allowing an accidental second launch.
        canPop: !_submitting,
        child: _buildDialog(context),
      ),
    );
  }

  /// The dialog's title: what it makes, and where a split puts it. The
  /// primary button says "New Harness" alone.
  String get _title => switch (widget.split?.axis) {
    PaneResizeAxis.x => 'New Harness to the right',
    PaneResizeAxis.y => 'New Harness below',
    null => 'New Harness',
  };

  Widget _buildDialog(BuildContext context) {
    final edgePadding = MediaQuery.sizeOf(context).width < 700 ? 24.0 : 36.0;
    final compactHeight = MediaQuery.sizeOf(context).height < 800;
    final canCreate =
        (_preparedFolder != null ||
            (_folderSource == _FolderSource.local
                ? _folder != null
                : _projectFolder != null)) &&
        !_picking &&
        !_submitting &&
        (_confirmationPending || !_taskTooLong) &&
        (_confirmationPending || !_waitingForCodexProfile);

    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.enter, meta: true): () {
          if (canCreate) _submit();
        },
        const SingleActivator(LogicalKeyboardKey.enter, control: true): () {
          if (canCreate) _submit();
        },
      },
      child: AlertDialog(
        constraints: BoxConstraints.tightFor(
          width: _dialogWidth + edgePadding * 2,
        ),
        backgroundColor: grid.AppPalette.swarmField,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(28)),
        title: Text(_title),
        titleTextStyle: Theme.of(context).textTheme.headlineSmall?.copyWith(
          fontSize: 28,
          height: 1.2,
          fontWeight: grid.AppFont.semibold,
          color: grid.AppPalette.textPrimary,
        ),
        titlePadding: EdgeInsets.fromLTRB(
          edgePadding,
          compactHeight ? 24 : 32,
          edgePadding,
          0,
        ),
        contentPadding: EdgeInsets.fromLTRB(
          edgePadding,
          compactHeight ? 24 : 32,
          edgePadding,
          40,
        ),
        actionsPadding: EdgeInsets.fromLTRB(
          edgePadding,
          0,
          edgePadding,
          compactHeight ? 24 : 28,
        ),
        actionsOverflowButtonSpacing: 8,
        content: SizedBox(
          width: _dialogWidth,
          child: ConstrainedBox(
            // AlertDialog gives the form the space left by its title and
            // footer, including when the footer wraps or text is enlarged.
            constraints: const BoxConstraints(maxHeight: 840),
            child: Scrollbar(
              controller: _choicesScroll,
              thickness: 4,
              radius: const Radius.circular(2),
              child: SingleChildScrollView(
                controller: _choicesScroll,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    AbsorbPointer(
                      absorbing: _choicesLocked,
                      child: ExcludeFocus(
                        excluding: _choicesLocked,
                        // Clipped choices can overlap the fixed footer in
                        // screen coordinates. Keep Tab in the form's order.
                        child: FocusTraversalGroup(
                          policy: WidgetOrderTraversalPolicy(),
                          child: _choices(),
                        ),
                      ),
                    ),
                    // Last: who, where and which folder are chosen, then what
                    // to do, said right beside the button that starts it.
                    //
                    // Outside the choices' traversal group, and locked the
                    // same way: that group orders Tab by when a focus node
                    // attached, and choosing a machine rebuilds the project
                    // tiles — inside the group they would come AFTER this
                    // field, and Shift-Tab would bounce between the two.
                    AbsorbPointer(
                      absorbing: _choicesLocked,
                      child: ExcludeFocus(
                        excluding: _choicesLocked,
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            SizedBox(height: compactHeight ? 24 : 32),
                            _sectionHeader(
                              'First task',
                              _takesTask
                                  ? 'What should your agent work on? (Optional)'
                                  : _engineIsTerminal
                                  ? 'A terminal opens straight on your shell; '
                                        'type there.'
                                  : '${_labelOf(_engine)} starts without one. '
                                        'Tell it once it opens.',
                              null,
                              compactHeight: compactHeight,
                            ),
                            _taskField(
                              minHeight: _tileHeight(
                                MediaQuery.textScalerOf(context),
                                compactHeight: compactHeight,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                    // Under everything chosen, and OUTSIDE the AbsorbPointer
                    // above: the choices lock while the install runs, and a
                    // panel inside that lock cannot be clicked (owner,
                    // 2026-09-16: "Show log bấm không được"). The install is
                    // what happens after the choices, and reads that way here.
                    if (!_confirmationPending && _installRun != null) ...[
                      const SizedBox(height: _gapBlock),
                      Semantics(
                        liveRegion: true,
                        child: DshInstallPanel(
                          key: const Key('new-agent-install-status'),
                          run: _installRun!,
                          harnessName: _labelOf(_engine),
                          machineName: _machineName,
                        ),
                      ),
                    ],
                    if (_error != null) ...[
                      const SizedBox(height: _gapBlock),
                      Semantics(
                        liveRegion: true,
                        child: Text(
                          _error!,
                          style: Theme.of(context).textTheme.bodySmall
                              ?.copyWith(
                                color: _confirmationPending
                                    ? grid.AppPalette.textSecondary
                                    : Theme.of(context).colorScheme.error,
                              ),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
        actions: [
          SizedBox(
            width: _dialogWidth,
            child: LayoutBuilder(
              builder: (context, constraints) {
                final actions = Wrap(
                  alignment: WrapAlignment.end,
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    // Close belongs to the UNCERTAIN state — a create whose
                    // reply was lost, where the person may leave and check
                    // later. `awaitingConfirmation` is set the moment the
                    // request goes out, so on its own it also covered every
                    // ordinary create in flight, and a disabled Close sat
                    // beside "Creating harness…" meaning nothing (owner,
                    // 2026-09-16). Same gate as Find an agent below.
                    if (_confirmationPending &&
                        (!_submitting || _checkingCreation))
                      TextButton(
                        onPressed: _submitting
                            ? null
                            : () => Navigator.of(context).pop(),
                        style: TextButton.styleFrom(
                          foregroundColor: grid.AppPalette.textSecondary,
                        ),
                        child: const Text('Close'),
                      ),
                    if (widget.offerFindExisting &&
                        _confirmationPending &&
                        (!_submitting || _checkingCreation))
                      TextButton.icon(
                        onPressed: _submitting
                            ? null
                            : () =>
                                  Navigator.of(context)
                                      .pop(NewAgentDialogResult.findExisting),
                        icon: const Icon(LucideIcons.search, size: 16),
                        label: const Text('Find a harness'),
                      ),
                    FilledButton(
                      key: const ValueKey('create-agent-submit'),
                      focusNode: _actionFocus,
                      onPressed: canCreate ? _submit : null,
                      style: FilledButton.styleFrom(
                        // Taller and larger type, in proportion with the
                        // tile-tall rows above it; no wider at rest, so the
                        // settings beside it keep their one line at 900.
                        minimumSize: const Size(192, 64),
                        maximumSize: const Size(420, double.infinity),
                        padding: const EdgeInsets.symmetric(
                          horizontal: 32,
                          vertical: 18,
                        ),
                        backgroundColor: grid.AppPalette.accent,
                        foregroundColor: Colors.white,
                        textStyle: TextStyle(
                          fontFamily: grid.AppFont.sans,
                          fontFamilyFallback: grid.AppFont.sansFallback,
                          fontSize: 18,
                          fontWeight: FontWeight.w600,
                        ),
                        shape: const StadiumBorder(),
                        disabledForegroundColor: _submitting
                            ? grid.AppPalette.textPrimary
                            : null,
                      ),
                      child: _submitting
                          ? Semantics(
                              liveRegion: true,
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  const SizedBox(
                                    width: 14,
                                    height: 14,
                                    child: CircularProgressIndicator(
                                      color: Colors.white,
                                      strokeWidth: 2,
                                    ),
                                  ),
                                  const SizedBox(width: 8),
                                  // A long harness name ends in an ellipsis
                                  // rather than pushing the button past the
                                  // footer.
                                  Flexible(
                                    child: Text(
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      _checkingCreation
                                          ? 'Checking status…'
                                          : _folderSource ==
                                                    _FolderSource.remote &&
                                                _preparedFolder == null
                                          ? 'Cloning and starting…'
                                          : _installing
                                          ? 'Installing ${_labelOf(_engine)}…'
                                          : _engineIsTerminal
                                          ? 'Opening terminal…'
                                          : 'Creating harness…',
                                    ),
                                  ),
                                ],
                              ),
                            )
                          : Text(
                              _confirmationPending
                                  ? 'Check status'
                                  : _installRun?.failed == true
                                  ? 'Retry'
                                  : 'New Harness',
                            ),
                    ),
                  ],
                );
                final scale = MediaQuery.textScalerOf(context).scale(13) / 13;
                final stacked =
                    (_advancedOpen || _confirmationPending) &&
                    constraints.maxWidth < 740 * math.min(1.4, scale);
                // Keep the controls mounted when the footer wraps or hides.
                // In particular, an explicit Default profile must stay chosen.
                return Flex(
                  direction: stacked ? Axis.vertical : Axis.horizontal,
                  mainAxisSize: stacked ? MainAxisSize.min : MainAxisSize.max,
                  crossAxisAlignment: stacked
                      ? CrossAxisAlignment.start
                      : CrossAxisAlignment.center,
                  children: [
                    Flexible(
                      fit: stacked ? FlexFit.loose : FlexFit.tight,
                      child: _settingsRow(),
                    ),
                    SizedBox(width: stacked ? 0 : 16, height: stacked ? 12 : 0),
                    Align(alignment: Alignment.centerRight, child: actions),
                  ],
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  /// "Machine. Where would you like your agent to run?" and its help link;
  /// a section with no [helpTopic] has the line alone.
  Widget _sectionHeader(
    String label,
    String prompt,
    HarnessHelpTopic? helpTopic, {
    required bool compactHeight,
  }) => Padding(
    padding: EdgeInsets.only(bottom: compactHeight ? 12 : 16),
    child: OverflowBar(
      alignment: MainAxisAlignment.spaceBetween,
      overflowAlignment: OverflowBarAlignment.end,
      spacing: 20,
      overflowSpacing: 4,
      children: [
        Semantics(
          header: true,
          child: Text.rich(
            TextSpan(
              children: [
                TextSpan(
                  text: '$label.',
                  style: TextStyle(
                    fontWeight: grid.AppFont.semibold,
                    color: grid.AppPalette.textPrimary,
                  ),
                ),
                TextSpan(text: ' $prompt'),
              ],
            ),
            style: TextStyle(
              fontSize: 20,
              height: 1.35,
              fontWeight: grid.AppFont.regular,
              color: grid.AppPalette.textSecondary,
            ),
          ),
        ),
        if (helpTopic != null) HarnessHelpLink(topic: helpTopic),
      ],
    ),
  );

  /// A tile's height, which depends on the text size and the window's height
  /// but never on its width — so the task field, laid out outside the tiles'
  /// LayoutBuilder, can be the same height as they are.
  static double _tileHeight(TextScaler scaler, {required bool compactHeight}) {
    final labelLine =
        scaler.scale(AppChoiceTileContent.labelSize) *
        AppChoiceTileContent.lineHeight;
    final detailLine =
        scaler.scale(AppChoiceTileContent.detailSize) *
        AppChoiceTileContent.lineHeight;
    return math.max(
      compactHeight ? 96 : 100,
      math.max(labelLine * 2 + detailLine, labelLine + detailLine * 2) + 38,
    );
  }

  Widget _choices() => LayoutBuilder(
    builder: (context, constraints) {
      final scaler = MediaQuery.textScalerOf(context);
      final compactHeight = MediaQuery.sizeOf(context).height < 800;
      final sectionGap = compactHeight ? 24.0 : 32.0;
      final minimumTileWidth = 172 * math.min(1.3, scaler.scale(16) / 16);
      final columns =
          constraints.maxWidth >= minimumTileWidth * 4 + AppChoiceTile.gap * 3
          ? 4
          : constraints.maxWidth >= minimumTileWidth * 2 + AppChoiceTile.gap
          ? 2
          : 1;
      // Three lines of text, and the 38 the tile spends on its own padding and
      // the gap between them. Three because the name and the detail under it
      // each want two and the tile can afford one second line between them:
      // sized for whichever of those two shapes is taller, so either can
      // happen without the column overflowing its box. The detail is the one
      // that usually takes it — "Documents · Typst GmbH" does not fit on one
      // line at this width, and on one it arrived as "Documents · Typst Gm…".
      // Which line is spent where is decided per tile, against the name it
      // actually holds: AppChoiceTileContent.linesFor.
      final tileSize = Size(
        (constraints.maxWidth - AppChoiceTile.gap * (columns - 1)) / columns,
        _tileHeight(scaler, compactHeight: compactHeight),
      );
      return Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // The section's line, like Machine's and Project's but with no help
          // link (owner, 2026-09-17), and the search box under it naming the
          // chosen agent.
          _sectionHeader(
            'Agent',
            'Choose who you’ll work with.',
            null,
            compactHeight: compactHeight,
          ),
          AgentPicker(
            key: const Key('new-agent-agent-picker'),
            focusNode: _agentSearchFocus,
            // A tile's height, so the bar is in proportion with the rows of
            // tiles under it.
            height: tileSize.height,
            width: constraints.maxWidth,
            value: _engine,
            recent: () => _recentAgents,
            installed: _installedIds,
            statusOf: _agentStatus,
            choices: [
              for (final identity in allEngines)
                AgentChoice(
                  id: identity.id,
                  label: _labelOf(identity.id),
                  detail: identity.tagline ?? identity.category,
                  creator: identity.creator,
                  keywords: identity.category,
                  description: identity.blurb,
                  mark: (size) => EngineMark(engine: identity.id, size: size),
                ),
              // The domain harnesses, after the engines they run on. What the
              // machine named when it has answered, else this build's own.
              for (final harness in _harnessOptions)
                AgentChoice(
                  id: harness.id,
                  label: harness.name,
                  // "MuJoCo by Google DeepMind" over "Advanced physics
                  // simulation" (owner, 2026-09-17). No "on Codex": the engine
                  // underneath is a backend detail (owner, 2026-09-15).
                  detail: _harnessTagline(harness),
                  creator: harness.author ?? engineIdentity(harness.id).creator,
                  // For the search alone: the Store's shelf and the package's
                  // own domain, so "engineering" and "PCB" both find Circuit.
                  keywords: [
                    storeCategoryFor(harness),
                    ?(harness.category ?? engineIdentity(harness.id).category),
                  ].join(' '),
                  description:
                      harness.description ??
                      engineIdentity(harness.id).blurb ??
                      storeStories[harness.id]?.benefit,
                  mark: (size) => EngineMark(
                    engine: harness.id,
                    displayName: harness.name,
                    size: size,
                  ),
                ),
              // After every agent: a plain shell, for when none of them is
              // wanted — the same tile ⌘⇧T opens, from here with a machine
              // and a folder chosen. Every machine has one, so the search
              // lists it with what the machine has (_installedIds).
              AgentChoice(
                id: kTerminalEngine,
                label: terminalIdentity.label,
                detail: terminalIdentity.tagline,
                keywords: '${terminalIdentity.category} shell bash zsh',
                description: terminalIdentity.blurb,
                mark: (size) => EngineMark(engine: kTerminalEngine, size: size),
              ),
            ],
            onChanged: (value) {
              if (_choicesLocked) return;
              setState(() {
                unawaited(widget.notifier.agentPreference.select(value));
                _engineChosenByUser = true;
                if (_engine != value) {
                  _engine = value;
                  _codexProfile = null;
                  _codexProfilesBusy = true;
                  // A terminal cannot clone: a Git project chosen for an
                  // agent goes back to the default, as the project picker
                  // is about to be remounted to.
                  if (isTerminalEngine(value) &&
                      _folderSource == _FolderSource.remote) {
                    _repository = null;
                    _folder = null;
                    _folderSource = _FolderSource.newProject;
                  }
                }
                // The choice is kept across agents; one with no flag simply shows none (and sends
                // false, see _submit), so coming back to Claude Code finds it as it was left.
                _error = null;
              });
              if (isHarnessId(value)) unawaited(_probeHarnesses());
            },
          ),
          if (!_confirmationPending && _engineCheckFailed) ...[
            const SizedBox(height: 6),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Text(
                    'Couldn’t check whether ${_labelOf(_baseEngine(_engine))} is installed. '
                    'You can still try creating the harness.',
                    style: Theme.of(context).textTheme.bodySmall
                        ?.copyWith(color: grid.AppPalette.textSecondary),
                  ),
                ),
                const SizedBox(width: 12),
                TextButton(
                  key: const Key('new-agent-retry-check'),
                  onPressed: _checkingEngines ? null : _retryEngineCheck,
                  child: Text(_checkingEngines ? 'Checking…' : 'Retry'),
                ),
              ],
            ),
          ],
          SizedBox(height: sectionGap),
          _sectionHeader(
            'Machine',
            'Where would you like your agent to run?',
            HarnessHelpTopic.machine,
            compactHeight: compactHeight,
          ),
          _machineOptions(tileSize),
          SizedBox(height: sectionGap),
          _sectionHeader(
            'Project',
            _engineIsTerminal
                ? 'Where the shell opens: your home folder, or a project.'
                : 'Start something new or choose an existing project.',
            HarnessHelpTopic.project,
            compactHeight: compactHeight,
          ),
          PageStorage(
            bucket: _projectChoices,
            child: NewAgentProjectPicker(
              // Keyed on the kind too: a terminal's tiles differ (Home, no
              // Git), and switching remounts the picker with them.
              key: ValueKey(
                'new-agent-projects-$_machineId-'
                '${_engineIsTerminal ? 'terminal' : 'agent'}',
              ),
              notifier: widget.notifier,
              machineId: _machineId,
              initialFolder: _folder,
              focusNode: _folderFocus,
              tileSize: tileSize,
              locked: _choicesLocked,
              // A terminal opens IN a folder, the way a terminal app does: at
              // home when none is named, never in one prepared or cloned.
              terminal: _engineIsTerminal,
              onBrowse: _browse,
              onSelected: (folder, repository) {
                if (_choicesLocked) return;
                setState(() {
                  _folder = folder;
                  _repository = repository;
                  _folderSource = repository != null
                      ? _FolderSource.remote
                      : folder != null
                      ? _FolderSource.local
                      : _FolderSource.newProject;
                  _preparedFolder = null;
                  _error = null;
                });
              },
            ),
          ),
        ],
      );
    },
  );

  Widget _profileOptions() => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    mainAxisSize: MainAxisSize.min,
    children: [
      if (_availability('codex')?.supportsCodexHome == true)
        CodexProfileField(
          notifier: widget.notifier,
          machineId: _machineId,
          machineIsThisComputer: _machineIsThisComputer,
          value: _codexProfile,
          observedPaths: {
            for (final agent in widget.notifier.stateOf(_machineId)!.agents)
              if (agent.engine == 'codex' && agent.codexHome != null)
                agent.codexHome!,
          },
          onChanged: (profile) {
            if (!_choicesLocked) {
              setState(() => _codexProfile = profile);
            }
          },
          onBusyChanged: (busy) {
            if (_codexProfilesBusy != busy) {
              setState(() => _codexProfilesBusy = busy);
            }
          },
        )
      else
        Text(
          _availability('codex') == null
              ? _engineCheckFailed && !_checkingEngines
                    ? 'Retry the agent check above to load Codex profiles.'
                    : 'Checking whether $_machineName supports Codex profiles…'
              : 'Update Harness CLI on $_machineName to choose a Codex profile.',
          style: Theme.of(context).textTheme.bodySmall,
        ),
    ],
  );

  /// The task field: what the harness is told first, exactly as typed, with no
  /// guessing about it (owner, 2026-09-17: "you just pick exactly what you want
  /// and enter the exact task"). One line tall at rest — as tall as the agent
  /// box and the tiles above it, [minHeight] — and taller as lines are added.
  /// Return adds a line; ⌘Return creates, as it does anywhere in the dialog.
  Widget _taskField({required double minHeight}) => ListenableBuilder(
    listenable: _task,
    builder: (context, _) {
      final radius = BorderRadius.circular(grid.AppControl.radius);
      final line = MediaQuery.textScalerOf(context).scale(16) * 1.45;
      final padding = ((minHeight - line) / 2).clamp(12.0, double.infinity);
      final tooLong = _taskTooLong;
      final errorBorder = OutlineInputBorder(
        borderRadius: radius,
        borderSide: BorderSide(
          color: Theme.of(context).colorScheme.error,
          width: 1.5,
        ),
      );
      return TextField(
        key: const Key('new-agent-task'),
        controller: _task,
        // Kept, not cleared, for an agent that cannot take it: choosing one
        // that can sends it after all.
        enabled: _takesTask,
        minLines: 1,
        maxLines: 6,
        keyboardType: TextInputType.multiline,
        textInputAction: TextInputAction.newline,
        style: TextStyle(
          fontSize: 16,
          height: 1.45,
          color: grid.AppPalette.textPrimary,
        ),
        decoration: InputDecoration(
          hintText: 'Tell your agent what to do first.',
          // Readable, not faint: the hint says what the field is for.
          hintStyle: TextStyle(
            fontSize: 16,
            height: 1.45,
            color: grid.AppPalette.textSecondary,
          ),
          // One line, so an empty box is exactly a tile tall at any width.
          hintMaxLines: 1,
          errorText: tooLong
              ? 'A first task can be up to $kFirstTaskMaxLength characters. '
                    'This one is ${_task.text.trim().length}.'
              : null,
          errorMaxLines: 2,
          errorBorder: errorBorder,
          focusedErrorBorder: errorBorder,
          filled: true,
          fillColor: grid.AppSurface.recess,
          isDense: true,
          // One line fills exactly [minHeight]: the padding is what a line of
          // text at this size leaves. A minimum height on the decoration would
          // reserve the space but paint the fill only around the text.
          contentPadding: EdgeInsets.fromLTRB(18, padding, 8, padding),
          border: OutlineInputBorder(
            borderRadius: radius,
            borderSide: BorderSide.none,
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: radius,
            borderSide: BorderSide.none,
          ),
          disabledBorder: OutlineInputBorder(
            borderRadius: radius,
            borderSide: BorderSide.none,
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: radius,
            borderSide: BorderSide(
              color: grid.AppPalette.swarmAccent.withValues(alpha: .7),
              width: 1.5,
            ),
          ),
          // A disabled field takes no clicks, so it offers none.
          suffixIcon: _task.text.isEmpty || !_takesTask
              ? null
              : Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: AppIconButton(
                    key: const Key('new-agent-task-clear'),
                    icon: LucideIcons.x300,
                    tooltip: 'Clear the task',
                    onPressed: _choicesLocked ? null : _task.clear,
                  ),
                ),
        ),
      );
    },
  );

  Widget _settingsRow() => Wrap(
    spacing: 12,
    runSpacing: 8,
    crossAxisAlignment: WrapCrossAlignment.center,
    children: [
      Semantics(
        label: 'Advanced settings',
        button: true,
        toggled: _advancedOpen,
        child: IconButton(
          key: const Key('new-agent-advanced'),
          onPressed: _choicesLocked ? null : _toggleAdvanced,
          icon: const Icon(LucideIcons.settings, size: 16),
          color: grid.AppPalette.textFaint,
          style: IconButton.styleFrom(
            minimumSize: const Size(28, 28),
            padding: const EdgeInsets.all(6),
          ),
        ),
      ),
      if (permissionModesOf(_baseEngine(_engine)) case final modes
          when modes.isNotEmpty)
        _setting(_permissionModeField(modes)),
      if (_baseEngine(_engine) == 'codex') _setting(_profileOptions()),
    ],
  );

  /// How far the agent may go without asking. The field shows the mode; the menu says what each
  /// one does, since "Accept edits" and "Plan first" mean little on their own.
  Widget _permissionModeField(List<PermissionMode> modes) => SizedBox(
    width: 156 * math.min(1.4, MediaQuery.textScalerOf(context).scale(13) / 13),
    height: 34,
    child: AppSelectField<String>(
      key: const Key('new-agent-permission-mode'),
      height: 34,
      menuWidth: 340,
      value: _permissionModeFor(_baseEngine(_engine)),
      options: [
        for (final mode in modes)
          SelectOption(
            value: mode.id,
            label: mode.label,
            detail: mode.detail,
            leading: () => Icon(
              mode.risky
                  ? LucideIcons.shieldOff
                  : mode.id == kDefaultPermissionMode
                  ? LucideIcons.shieldCheck
                  : LucideIcons.shield,
              size: 16,
              color: mode.risky
                  ? grid.AppPalette.dangerFill
                  : grid.AppPalette.textSecondary,
            ),
          ),
      ],
      onChanged: (mode) {
        if (!_choicesLocked) setState(() => _permissionMode = mode);
      },
    ),
  );

  Widget _setting(Widget child) => Offstage(
    offstage: !_advancedOpen,
    child: ExcludeFocus(
      excluding: !_advancedOpen || _choicesLocked,
      child: IgnorePointer(ignoring: _choicesLocked, child: child),
    ),
  );

  bool _machineOnline(MachineState machine) =>
      machine.isLocalMachine ||
      (machine.nodeOnline == true && !machine.needsLink);

  List<MachineState> get _orderedMachines {
    final machines = widget.notifier.machineStates.values
        .where((m) => !m.machine.isShared)
        .toList();
    int priority(MachineState machine) => machine.isLocalMachine
        ? 0
        : _machineOnline(machine)
        ? 1
        : 2;
    final originalOrder = {
      for (var i = 0; i < machines.length; i++)
        machines[i].machine.machineId: i,
    };
    machines.sort((a, b) {
      final order = priority(a).compareTo(priority(b));
      return order != 0
          ? order
          : originalOrder[a.machine.machineId]!.compareTo(
              originalOrder[b.machine.machineId]!,
            );
    });
    return machines;
  }

  Widget _machineOptions(Size tileSize) => AppChoicePicker<String>(
    key: const Key('new-agent-machine-field'),
    value: _machineId,
    moreKey: const Key('new-agent-machine-more'),
    moreLabel: 'More machines',
    moreLeading: const Icon(LucideIcons.monitor, size: 22),
    optionKey: (id) => ValueKey('new-agent-machine-$id'),
    showDetails: true,
    compact: true,
    wrap: true,
    tileSize: tileSize,
    preferredValues: _orderedMachines
        .map((machine) => machine.machine.machineId)
        .toList(),
    options: [
      for (final machine in widget.notifier.machineStates.values)
        if (!machine.machine.isShared)
          SelectOption(
            value: machine.machine.machineId,
            label: machine.machine.displayName,
            detail: machine.isLocalMachine ? 'This computer' : 'Remote',
            leading: () => Icon(
              _machineOnline(machine)
                  ? (machine.isLocalMachine
                        ? LucideIcons.laptop
                        : LucideIcons.monitor)
                  : LucideIcons.monitorOff,
              size: 22,
              color: _machineOnline(machine)
                  ? grid.AppPalette.textPrimary
                  : grid.AppPalette.textFaint,
              semanticLabel: _machineOnline(machine) ? 'Online' : 'Offline',
            ),
          ),
    ],
    onChanged: (id) {
      if (id == _machineId || _choicesLocked) return;
      setState(() {
        _machineRevision++;
        _engineChosenByUser = true;
        _machineId = id;
        _folder = null;
        _repository = null;
        _folderSource = _FolderSource.newProject;
        _preparedFolder = null;
        _codexProfile = null;
        _codexProfilesBusy = true;
        _error = null;
      });
      unawaited(_probeEngines());
      // And its harnesses, whatever is chosen: what this machine has
      // installed is what the agent row shows first.
      unawaited(_probeHarnesses());
    },
  );

  /// The agents you used lately, most recent first: the ones harnesses were
  /// created with here, then the ones running on this machine and the rest.
  List<String> get _recentAgents => [
    ...widget.notifier.agentPreference.recent,
    for (final machine in [
      ?widget.notifier.stateOf(_machineId),
      ...widget.notifier.machineStates.values,
    ])
      for (final agent in machine.agents.reversed) ?(agent.dsh ?? agent.engine),
  ];

  /// A line for the agent search's preview: is [id] on the chosen machine, or
  /// will Harness install it first. Null while the machine has not said.
  String? _agentStatus(String id) {
    final machine = widget.notifier.stateOf(_machineId);
    if (machine == null) return null;
    final name = machine.machine.displayName;
    if (isTerminalEngine(id)) return 'Your shell on $name';
    if (isHarnessId(id)) {
      final entry = _harness(id);
      if (entry == null) return null;
      return entry.installed
          ? 'Installed on $name'
          : 'Installs on $name before it starts';
    }
    final engine = machine.engines.loaded ? machine.engines[id] : null;
    if (engine == null) return null;
    if (engine.installed) return 'Installed on $name';
    return engine.installable
        ? 'Installs on $name before it starts'
        : 'Not installed on $name';
  }

  /// What the machine has, by id: engines from its probe, harnesses from its
  /// catalog. The agent search lists them after the agents you used.
  Set<String> get _installedIds {
    final machine = widget.notifier.stateOf(_machineId);
    if (machine == null) return const {};
    return {
      kTerminalEngine,
      for (final entry in machine.dsh.entries)
        if (entry.installed && !entry.isViewerPackage) entry.id,
      for (final engine in machine.engines.byEngine.values)
        if (engine.installed) engine.engine,
    };
  }
}

/// The project picker shares Open Agent’s generous reading space.
const double _dialogWidth = 1080;

/// Blocks inside one card: the command, the facts, the reason.
const double _gapBlock = 12;
