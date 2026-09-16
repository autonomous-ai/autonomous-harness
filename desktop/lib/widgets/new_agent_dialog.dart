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
import '../core/project_folder.dart';
import '../core/repository_clone.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_checkbox.dart';
import '../shared/widgets/app_choice_picker.dart';
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_select_field.dart';
import '../state/app_state.dart';
import 'engine_identity.dart';
import 'codex_profile_field.dart';
import 'agent_picker.dart';
import 'remote_folder_picker.dart';
import 'new_agent_project_picker.dart';
import 'new_harness_help.dart';
import 'dsh_install_panel.dart';

/// Mirrors the harness CLI's `BYPASS_PERMISSION_FLAGS`
/// (autonomous-harness/cli/src/lib/engineLaunch.ts) 1:1 — this is UI-only display + gating, the CLI
/// is the actual enforcement point. An engine absent here shows no checkbox at all rather than
/// guessing a flag for a CLI we haven't verified. Keep both maps in sync.
const Map<String, String> kEngineBypassPermissionFlag = {
  'claude': '--dangerously-skip-permissions',
  'codex': '--dangerously-bypass-approvals-and-sandbox',
  'cursor': '--force',
  'opencode': '--auto',
};

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
}) {
  // Reported here rather than at each call site: the doors are four and
  // growing, and one that forgets to track is a hole in the funnel that only
  // shows up as a number quietly being too small.
  analytics.newAgentOpened(source: source);
  return showAppDialog<NewAgentDialogResult>(
    context: context,
    transitionDuration: Duration.zero,
    veilBlur: 0,
    builder: (context) => _NewAgentDialog(
      notifier: notifier,
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
  });

  @override
  State<_NewAgentDialog> createState() => _NewAgentDialogState();
}

class _NewAgentDialogState extends State<_NewAgentDialog> {
  final _folderFocus = FocusNode(debugLabel: 'Working folder');
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
  bool _bypassPermission = false;

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
    _folderFocus.dispose();
    _actionFocus.dispose();
    _choicesScroll.dispose();
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    final remembered = widget.notifier.agentPreference.value;
    if (_knownChoice(remembered)) {
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
        // actionable control once the route and its focus tree are mounted.
        _folderFocus.requestFocus();
        unawaited(_probeEngines(initialProbe: widget.initialEngineProbe));
        unawaited(_loadAgentPreference());
      }
    });
  }

  /// Whether [id] is something this dialog can offer: an engine, or a harness
  /// this build ships a face for, or one the machine has named.
  bool _knownChoice(String? id) =>
      id != null &&
      (allEngines.any((identity) => identity.id == id) ||
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

  /// What it makes and whose it is — "CAD · Autonomous" — the
  /// machine's words first, this build's when the machine has not answered,
  /// the description when there is nothing else.
  String? _harnessDetail(DshEntry harness) {
    final identity = engineIdentity(harness.id);
    final parts = [
      harness.category ?? identity.category,
      harness.author ?? identity.creator,
    ].whereType<String>().where((s) => s.isNotEmpty);
    return parts.isEmpty ? harness.description : parts.join(' · ');
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
    // the machine's catalog, and a remembered harness stays chosen.
    if (_engineIsHarness) return _engine;
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
  bool _bypassHovered = false;
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
    final project = _preparedFolder == null ? _projectFolder : null;
    final folder =
        _preparedFolder ??
        (_folderSource == _FolderSource.local ? _folder : null);
    if ((folder == null && project == null) ||
        _submitting ||
        (!_confirmationPending && _waitingForCodexProfile)) {
      return;
    }
    final choice = _engine;
    final harness = _engineIsHarness ? choice : null;
    final engine = _baseEngine(choice);
    final profile = _codexProfile;
    final bypassPermission =
        _bypassPermission && kEngineBypassPermissionFlag.containsKey(engine);
    if (!_confirmationPending) _creation = AgentCreationAttempt();
    setState(() {
      _checkingCreation = _confirmationPending;
      _submitting = true;
      _error = null;
    });
    // A harness the machine does not have yet is installed FIRST, as its own
    // step with its own words: minutes of clone and toolchain under a button
    // that said "Creating agent…" would read as a create that hung. The
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
      // Claude Code where Copper was picked. Say so and stop here instead.
      final catalog = widget.notifier.stateOf(_machineId)?.dsh;
      if (catalog != null && !catalog.loaded && catalog.error != null) {
        setState(() {
          _submitting = false;
          _error =
              'Update Harness CLI on $_machineName to create a '
              '${_labelOf(harness)} agent.';
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
      folder: folder ?? '',
      projectFolder: project,
      swarmId: widget.swarmId,
      split: widget.split,
      bypassPermission: bypassPermission,
      // Keep the explicit choice even if machine discovery changes mid-submit.
      // The notifier must reject a now-remote target, never use its default login.
      codexHome: engine == 'codex' ? profile?.path : null,
      dsh: harness,
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
    analytics.agentCreated(engine: choice, bypassPermission: bypassPermission);
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

  Widget _buildDialog(BuildContext context) {
    final edgePadding = MediaQuery.sizeOf(context).width < 700 ? 24.0 : 36.0;
    final compactHeight = MediaQuery.sizeOf(context).height < 800;
    final bypassFlag = kEngineBypassPermissionFlag[_baseEngine(_engine)];
    final canCreate =
        (_preparedFolder != null ||
            (_folderSource == _FolderSource.local
                ? _folder != null
                : _projectFolder != null)) &&
        !_picking &&
        !_submitting &&
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
        title: Text(switch (widget.split?.axis) {
          PaneResizeAxis.x => 'New Harness to the right',
          PaneResizeAxis.y => 'New Harness below',
          null => 'New Harness',
        }),
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
                    // beside "Creating agent…" meaning nothing (owner,
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
                        minimumSize: const Size(192, 56),
                        padding: const EdgeInsets.symmetric(
                          horizontal: 32,
                          vertical: 16,
                        ),
                        backgroundColor: grid.AppPalette.accent,
                        foregroundColor: Colors.white,
                        textStyle: TextStyle(
                          fontFamily: grid.AppFont.sans,
                          fontFamilyFallback: grid.AppFont.sansFallback,
                          fontSize: 16,
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
                                  Text(
                                    _checkingCreation
                                        ? 'Checking status…'
                                        : _folderSource ==
                                                  _FolderSource.remote &&
                                              _preparedFolder == null
                                        ? 'Cloning and starting…'
                                        : _installing
                                        ? 'Installing ${_labelOf(_engine)}…'
                                        : 'Creating agent…',
                                  ),
                                ],
                              ),
                            )
                          : Text(
                              _confirmationPending
                                  ? 'Check status'
                                  : _installRun?.failed == true
                                  ? 'Retry'
                                  : 'Create',
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
                      child: _settingsRow(bypassFlag),
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

  Widget _sectionHeader(
    String label,
    String prompt,
    HarnessHelpTopic helpTopic, {
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
        HarnessHelpLink(topic: helpTopic),
      ],
    ),
  );

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
      final tileSize = Size(
        (constraints.maxWidth - AppChoiceTile.gap * (columns - 1)) / columns,
        math.max(
          compactHeight ? 96 : 100,
          scaler.scale(16) * 2.5 + scaler.scale(14) * 1.25 + 38,
        ),
      );
      return Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _sectionHeader(
            'Agent',
            'Choose who you’ll work with.',
            HarnessHelpTopic.agent,
            compactHeight: compactHeight,
          ),
          AgentPicker(
            compact: true,
            tileSize: tileSize,
            value: _engine,
            options: [
              for (final identity in allEngines)
                SelectOption(
                  value: identity.id,
                  label: identity.label,
                  detail: identity.detail,
                  leading: () => EngineMark(engine: identity.id, size: 14),
                ),
              // The domain harnesses, after the engines they run on. What the
              // machine named when it has answered, else this build's own two.
              for (final harness in _harnessOptions)
                SelectOption(
                  value: harness.id,
                  label: harness.name,
                  // No "on Codex" here: the engine underneath is a backend
                  // detail (owner, 2026-09-15) — the settings row says it.
                  // What it makes, in a word or two; the machine's word first,
                  // this build's when the machine has not answered.
                  detail: _harnessDetail(harness),
                  leading: () => EngineMark(
                    engine: harness.id,
                    displayName: harness.name,
                    size: 14,
                  ),
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
                }
                _error = null;
                if (!kEngineBypassPermissionFlag.containsKey(
                  _baseEngine(value),
                )) {
                  _bypassPermission = false;
                }
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
                    'You can still try creating an agent.',
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
            'Start something new or choose an existing project.',
            HarnessHelpTopic.project,
            compactHeight: compactHeight,
          ),
          PageStorage(
            bucket: _projectChoices,
            child: NewAgentProjectPicker(
              key: ValueKey('new-agent-projects-$_machineId'),
              notifier: widget.notifier,
              machineId: _machineId,
              initialFolder: _folder,
              focusNode: _folderFocus,
              tileSize: tileSize,
              locked: _choicesLocked,
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

  Widget _settingsRow(String? bypassFlag) => Wrap(
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
      _setting(
        _BypassCheck(
          value: bypassFlag != null && _bypassPermission,
          hovered: _bypassHovered,
          onHover: (value) => setState(() => _bypassHovered = value),
          onChanged: bypassFlag == null
              ? null
              : (value) => setState(() => _bypassPermission = value),
        ),
      ),
      if (_baseEngine(_engine) == 'codex') _setting(_profileOptions()),
    ],
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
    final machines = widget.notifier.machineStates.values.toList();
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
      if (_engineIsHarness) unawaited(_probeHarnesses());
    },
  );
}

/// The project picker shares Open Agent’s generous reading space.
const double _dialogWidth = 1080;

/// Blocks inside one card: the command, the facts, the reason.
const double _gapBlock = 12;

class _BypassCheck extends StatelessWidget {
  const _BypassCheck({
    required this.value,
    required this.hovered,
    required this.onHover,
    required this.onChanged,
  });
  final bool value;
  final bool hovered;
  final ValueChanged<bool> onHover;
  final ValueChanged<bool>? onChanged;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return MouseRegion(
      cursor: onChanged == null
          ? SystemMouseCursors.basic
          : SystemMouseCursors.click,
      onEnter: (_) => onHover(true),
      onExit: (_) => onHover(false),
      child: GestureDetector(
        onTap: onChanged == null ? null : () => onChanged!(!value),
        behavior: HitTestBehavior.opaque,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 10),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              AppCheckbox(value: value, hovered: hovered, onChanged: onChanged),
              const SizedBox(width: 10),
              Text(
                'Bypass approvals',
                style: TextStyle(
                  fontSize: 13,
                  color: onChanged == null
                      ? grid.AppPalette.textFaint
                      : grid.AppPalette.textPrimary,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
