import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/core/codex_profiles.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/widgets/engine_identity.dart';
import 'package:harness_mobile/core/project_folder.dart';
import 'package:harness_mobile/widgets/remote_folder_picker.dart';

import 'agent_index.dart';
import 'phone_header.dart';
import 'phone_navigation.dart';
import 'phone_status.dart';
import 'settings_row.dart';

/// Starting an agent from the phone: a folder on that machine, and an engine to
/// run there.
///
/// A page rather than a sheet. There are two choices to make and one of them can
/// open a folder browser on top — a sheet that has to be dismissed to reach the
/// browser, and rebuilt after it, loses the other choice on the way.
///
/// The desktop asks the same two things (`widgets/new_agent_dialog.dart`) and a
/// few more it has room for — a Codex profile, a split to place the pane into,
/// a permission bypass. A phone shows one agent at a time, so there is no split
/// to aim at, and the rest belong to the machine that already knows them.
class NewAgentPage extends StatefulWidget {
  const NewAgentPage({
    super.key,
    required this.notifier,
    required this.machineId,
  });

  final AppNotifier notifier;
  final String machineId;

  @override
  State<NewAgentPage> createState() => _NewAgentPageState();
}

class _NewAgentPageState extends State<NewAgentPage> {
  /// The machine the agent is created on. Starts on the one the page was opened with, and the
  /// MACHINE rows change it.
  late String _machineId = widget.machineId;

  /// Whether the MACHINE row is folded open onto the other machines.
  bool _machinesOpen = false;

  /// Whether the engines past [_primaryEngines] are shown.
  bool _moreEnginesOpen = false;

  String? _folder;

  /// Set when the MACHINE is to produce the folder — a fresh project, or a clone — instead of one
  /// being picked here.
  ///
  /// ⚠️ Exclusive with [_folder], and the two are cleared against each other everywhere they are
  /// set. They answer the same question, and both being live would leave the button's `ready` true
  /// with no way to tell which answer it meant.
  ProjectFolderRequest? _project;

  /// What the FOLDER rows show as chosen for [_project], since a request carries no path to show:
  /// "New project", or the repository's name.
  String? _projectLabel;

  /// Claude until somebody picks another — the engine most agents are started with.
  String? _engine = 'claude';
  String? _error;
  bool _creating = false;

  /// Codex state folders this machine reported, and the one chosen. Null is the
  /// machine's own default `CODEX_HOME`, which is what the desktop dialog calls
  /// "default profile" and what it starts on.
  List<LocalCodexProfile> _codexProfiles = const [];
  LocalCodexProfile? _codexProfile;
  bool _codexProfilesLoaded = false;

  /// Whether the Recent row is folded open.
  ///
  /// Starts shut every time, and closes again on a pick: what it lists are answers, and once one is
  /// taken the list has nothing left to say.
  bool _recentOpen = false;

  @override
  void initState() {
    super.initState();
    // After the first frame, not during it: `probeEngines` can notify synchronously, and a notify
    // while this page is still being mounted marks the listeners above it dirty mid-build — the
    // "setState() called during build" assertion.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _askMachine();
    });
    // Read from disk once. `recent` answers from memory after this, so the rows below need no
    // await — but the first build happens before it lands, hence the rebuild.
    unawaited(
      widget.notifier.projectHistory.load().then((_) {
        if (mounted) setState(() {});
      }),
    );
  }

  /// What this form needs to hear from [_machineId]: its engines and its Codex profiles.
  void _askMachine() {
    // Which engines this machine actually has. Best effort: an unanswered probe
    // leaves the list to the engines its own agents are already running, and a
    // machine with neither still gets the browse-and-create path.
    unawaited(widget.notifier.probeEngines(_machineId));
    unawaited(_loadCodexProfiles());
  }

  /// Moves the form to another machine.
  ///
  /// ⚠️ Every folder choice goes with the old machine — a path, a Recent entry and a Codex profile
  /// all name something on THAT computer, and carried over they would point at nothing, or at a
  /// different folder that happens to share the path. The engine stays: it names a program, not a
  /// place.
  void _selectMachine(String machineId) {
    if (machineId == _machineId) {
      setState(() => _machinesOpen = false);
      return;
    }
    setState(() {
      _machineId = machineId;
      _machinesOpen = false;
      _folder = null;
      _project = null;
      _projectLabel = null;
      _recentOpen = false;
      _codexProfiles = const [];
      _codexProfile = null;
      _codexProfilesLoaded = false;
      _error = null;
    });
    _askMachine();
  }

  /// Machines an agent can be created on right now, in the order the Agents tab's chips draw them —
  /// so "the first one" is the same machine in both places. The chosen one is kept even if it stops
  /// answering, so the row never goes blank under the person.
  List<MachineState> get _machines => [
    for (final machine in filterableMachines(widget.notifier))
      if (phoneMachineStatusOf(machine) == PhoneMachineStatus.ready ||
          machine.machine.machineId == _machineId)
        machine,
  ];

  /// Discovery runs on the MACHINE, never on this device — the phone has no
  /// Codex config of its own and the agent will not run here anyway.
  Future<void> _loadCodexProfiles() async {
    final machineId = _machineId;
    final result = await widget.notifier.listCodexProfiles(machineId);
    // A late answer from a machine the form has since moved off belongs to nobody.
    if (!mounted || machineId != _machineId) return;
    final raw = result['profiles'] as List<dynamic>? ?? const [];
    final loaded = raw.map(
      (entry) =>
          LocalCodexProfile.fromJson(Map<String, dynamic>.from(entry as Map)),
    );
    // Keyed by path: the machine can report one folder under two labels.
    final profiles = {for (final p in loaded) p.path: p}.values.toList();
    setState(() {
      _codexProfiles = profiles;
      _codexProfilesLoaded = true;
      // Exactly one, and there is nothing to choose between — the desktop
      // dialog settles on it the same way.
      if (profiles.length == 1) _codexProfile = profiles.single;
    });
  }

  /// Codex can be pointed at a state folder; nothing else can, and the CLI has
  /// to be new enough to be told.
  bool get _showsCodexProfile =>
      _engine == 'codex' &&
      _machine?.engines['codex']?.supportsCodexHome == true;

  MachineState? get _machine => widget.notifier.stateOf(_machineId);

  /// Whether this machine can make a folder of its own — a fresh project, or a clone.
  ///
  /// ⚠️ Gated because an older CLI fails in a way that BLAMES THE PERSON. It ignores
  /// `projectSource`, finds no `cwd`, and refuses with INVALID_CWD, which the app renders as "the
  /// project folder is unavailable on this machine, choose another folder and try again" — advice
  /// about a folder they never chose, for a problem that is not theirs to fix.
  ///
  /// ⚠️ The desktop offers both unconditionally and has the same hole. Worth carrying over there.
  bool get _canMakeProject => _machine?.projectFolderAvailable ?? false;

  /// Why the two rows are unavailable, or null while they are not.
  ///
  /// Printed rather than left to a disabled row: "Update OpenHarness on that machine" is something the
  /// person can act on, and a row that simply does nothing teaches them nothing.
  String? get _projectSourceNote {
    final machine = _machine;
    if (machine == null || _canMakeProject) return null;
    // Said only once the machine has actually answered. Before that, silence — a row must not call
    // a machine out of date on the strength of an answer that has not arrived.
    if (!machine.terminalCapabilityLoaded) return null;
    return 'Update OpenHarness on ${machine.machine.displayName} to create a '
        'project or clone one there.';
  }

  /// Folders agents have been started in on THIS machine, newest first.
  ///
  /// ⚠️ A stored history, not a reading of what exists now. It survives the agent that put it
  /// there, which is what makes "recent" honest — the list that came from `machine.agents` emptied
  /// itself when an agent was deleted, and called that "recent" too.
  ///
  /// Scoped per machine because the paths are: a folder on one computer means nothing on another.
  List<String> get _recent => widget.notifier.projectHistory.recent(_machineId);

  /// Whether the chosen folder came from the browser rather than from Recent.
  bool get _browsed => _folder != null && !_recent.contains(_folder);

  /// The recent folder currently chosen, for the folded row to show, or null.
  String? get _pickedRecent =>
      _folder != null && _recent.contains(_folder) ? _folder : null;

  String get _recentCount =>
      _recent.length == 1 ? '1 folder' : '${_recent.length} folders';

  /// The last segment of a path, for the row's title. No `package:path` here — these are the remote
  /// machine's paths, and its separator is not this device's to assume.
  String _basename(String path) {
    final trimmed = path.endsWith('/') && path.length > 1
        ? path.substring(0, path.length - 1)
        : path;
    final cut = trimmed.lastIndexOf('/');
    return cut < 0 || cut == trimmed.length - 1
        ? trimmed
        : trimmed.substring(cut + 1);
  }

  /// Every engine Harness knows, the way the desktop dialog offers them.
  ///
  /// Offered, not filtered to what is installed: an engine Harness can install
  /// is installed on launch, and hiding the rest would make a machine that has
  /// not answered the probe yet look like it runs one engine. The row carries
  /// the caveat instead — see [_engineNote].
  List<EngineIdentity> get _engines => allEngines;

  /// The engines shown before "More". The rest fold behind it: fourteen rows put the Create button's
  /// neighbours out of reach, and most people start with one of these.
  static const _primaryEngines = {'claude', 'codex', 'opencode', 'hermes'};

  /// The engine rows on screen: the primary ones, then the rest once unfolded. A chosen engine from
  /// the folded part stays visible, so the tick is never hidden behind "More".
  List<EngineIdentity> get _shownEngines => [
    for (final identity in _engines)
      if (_primaryEngines.contains(identity.id) ||
          _moreEnginesOpen ||
          identity.id == _engine)
        identity,
  ];

  int get _hiddenEngineCount => _engines.length - _shownEngines.length;

  /// The one caveat worth printing beside an engine's name, or none.
  ///
  /// Absent and installable earns nothing: Harness puts it there before it
  /// launches. Absent and NOT installable is the one state nobody else can fix,
  /// so it keeps words. An unanswered probe says nothing at all — a row must
  /// not call an engine missing on the strength of an answer that never came.
  String? _engineNote(String engine) {
    final machine = _machine;
    if (machine == null || !machine.engines.loaded) return null;
    final entry = machine.engines[engine];
    if (entry == null || entry.installed || entry.installable) return null;
    return 'not installed';
  }

  /// Asks for a GitHub repository by URL — the desktop's "Git" button, which is also just a field
  /// to paste into. Neither end lists repositories or talks to GitHub.
  ///
  /// ⚠️ Refuses in the dialog rather than on submit. `cli/src/lib/projectFolder.ts` parses the URL
  /// again at its end and would refuse too, but that answer arrives after a round trip and lands as
  /// a failed creation; [GitHubRepository.parse] is the same rule applied where it was typed.
  Future<void> _pickRepository() async {
    final repository = await showDialog<GitHubRepository>(
      context: context,
      useRootNavigator: true,
      // ⚠️ The dialog owns its controller. Holding one out here and disposing it when `showDialog`
      // returns disposes it while the route is still animating OUT, with the field still attached —
      // "A TextEditingController was used after being disposed", and the frame after it takes the
      // whole screen down.
      builder: (_) => _RepositoryDialog(initialUrl: _project?.repository?.url),
    );
    if (repository == null || !mounted) return;
    setState(() {
      _project = ProjectFolderRequest.remote(repository);
      _projectLabel = repository.name;
      _folder = null;
      _error = null;
    });
  }

  Future<void> _browse() async {
    final chosen = await showRemoteFolderPicker(
      context,
      notifier: widget.notifier,
      machineId: _machineId,
      initialPath: _folder,
    );
    if (chosen == null || !mounted) return;
    setState(() {
      _folder = chosen;
      _project = null;
      _projectLabel = null;
      _error = null;
    });
  }

  Future<void> _create() async {
    final folder = _folder, engine = _engine, project = _project;
    if ((folder == null && project == null) || engine == null || _creating) {
      return;
    }
    setState(() {
      _creating = true;
      _error = null;
    });
    // Held so the id of what it starts comes back here — see
    // [AgentCreationAttempt.agentId]. A fresh one per submit, which is what the
    // call made on its own before: a retry after a refusal is a new request.
    final creation = AgentCreationAttempt();
    final error = await widget.notifier.createAgent(
      _machineId,
      engine: engine,
      // Empty only in the branch that drops `cwd` from the payload entirely — `createAgent` keeps
      // this required so the ordinary case cannot be left out by accident.
      folder: folder ?? '',
      projectFolder: project,
      // Only for Codex, and only when chosen: omitted, the machine launches
      // with its own default CODEX_HOME.
      codexHome: _showsCodexProfile ? _codexProfile?.path : null,
      attempt: creation,
    );
    if (!mounted) return;
    if (error == null) {
      _open(creation.agentId);
      return;
    }
    setState(() {
      _creating = false;
      _error = error;
    });
  }

  /// Where a finished creation lands: inside the agent it just started.
  ///
  /// Asking for an agent and being handed back the list to find it in is a step
  /// nobody wants — the answer to "create this" is the thing created. It
  /// REPLACES this page rather than stacking on it, so back from the terminal
  /// is the list this was opened from, not a form for an agent that now exists.
  ///
  /// A machine can still confirm a creation without naming the agent — an older
  /// CLI's reply carries no record. Then there is nothing to open, and the list
  /// behind this page picks the new agent up the way it picks up every other.
  void _open(String? agentId) {
    if (agentId == null) {
      Navigator.of(context).pop();
      return;
    }
    openAgent(
      context,
      widget.notifier,
      _machineId,
      agentId,
      replacingCurrentPage: true,
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.notifier,
    builder: (context, _) {
      AppTheme.watch(context);
      final machine = _machine;
      final machines = _machines;
      // "New project" is the folder until one is chosen. Applied here rather than in `initState`
      // because it can only be offered once the machine has said it can make one, and that answer
      // lands after the page opens. Nothing but a machine switch leaves both unset again, so this
      // never overrides a choice — and a switch re-applies it on the new machine.
      if (_folder == null && _project == null && _canMakeProject) {
        _project = const ProjectFolderRequest.newProject();
        _projectLabel = 'New project';
      }
      final ready =
          (_folder != null || _project != null) &&
          _engine != null &&
          !_creating;
      return Scaffold(
        backgroundColor: AppPalette.windowBg,
        body: SafeArea(
          child: Column(
            children: [
              // No machine under the title any more: the MACHINE rows below say it, and are where it
              // is changed.
              const PhoneHeader(title: 'New agent'),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.only(bottom: 16),
                  children: [
                    const SettingsCaption('MACHINE'),
                    SettingsGroup(
                      children: [
                        // Folded like Recent: the chosen machine is the answer most of the time,
                        // and the others only matter to somebody about to change it.
                        SettingsRow(
                          title: machine?.machine.displayName ?? 'Machine',
                          leading: Icon(
                            LucideIcons.laptopMinimal300,
                            size: 18,
                            color: AppPalette.textSecondary,
                          ),
                          trailing: machines.length < 2
                              ? null
                              : Icon(
                                  _machinesOpen
                                      ? LucideIcons.chevronUp300
                                      : LucideIcons.chevronDown300,
                                  size: 18,
                                  color: AppPalette.textFaint,
                                ),
                          onTap: machines.length < 2
                              ? null
                              : () => setState(
                                  () => _machinesOpen = !_machinesOpen,
                                ),
                        ),
                        if (_machinesOpen)
                          for (final other in machines)
                            SettingsRow(
                              title: other.machine.displayName,
                              nested: true,
                              trailing: _check(
                                other.machine.machineId == _machineId,
                              ),
                              onTap: () =>
                                  _selectMachine(other.machine.machineId),
                            ),
                      ],
                    ),
                    const SettingsCaption('FOLDER'),
                    SettingsGroup(
                      children: [
                        SettingsRow(
                          title: 'New project',
                          detail:
                              _projectSourceNote ??
                              'A fresh folder, made on the machine',
                          leading: Icon(
                            LucideIcons.folderPlus300,
                            size: 18,
                            color: AppPalette.textSecondary,
                          ),
                          trailing: _check(
                            _project != null && _project!.repository == null,
                          ),
                          onTap: !_canMakeProject
                              ? null
                              : () => setState(() {
                                  _project =
                                      const ProjectFolderRequest.newProject();
                                  _projectLabel = 'New project';
                                  _folder = null;
                                  _error = null;
                                }),
                        ),
                        // Shows its path only when the choice is this row's own. A folder picked
                        // from RECENT below is already named there, and printing it here too would
                        // put one answer under two ticks.
                        SettingsRow(
                          title: 'Browse…',
                          detail: _browsed ? _folder : null,
                          leading: Icon(
                            LucideIcons.folderSearch300,
                            size: 18,
                            color: AppPalette.textSecondary,
                          ),
                          trailing: _check(_browsed),
                          onTap: () => unawaited(_browse()),
                        ),
                        SettingsRow(
                          title: 'Git…',
                          detail:
                              _projectSourceNote ??
                              (_project?.repository == null
                                  ? 'Clone a GitHub repository'
                                  : _projectLabel),
                          leading: Icon(
                            LucideIcons.gitBranch300,
                            size: 18,
                            color: AppPalette.textSecondary,
                          ),
                          trailing: _check(_project?.repository != null),
                          onTap: !_canMakeProject
                              ? null
                              : () => unawaited(_pickRepository()),
                        ),
                        // The fourth source, folded shut. Its entries are answers already given
                        // rather than a way of choosing, so they stay out of sight until asked
                        // for — a machine used for months would otherwise bury the three rows
                        // above under its own history.
                        //
                        // ⚠️ Absent entirely when there is no history, rather than opening onto
                        // nothing. Nobody's first agent has a recent folder.
                        if (_recent.isNotEmpty)
                          SettingsRow(
                            title: 'Recent',
                            detail: _recentOpen
                                ? null
                                : (_pickedRecent ?? _recentCount),
                            leading: Icon(
                              LucideIcons.history300,
                              size: 18,
                              color: AppPalette.textSecondary,
                            ),
                            trailing: Icon(
                              _recentOpen
                                  ? LucideIcons.chevronUp300
                                  : LucideIcons.chevronDown300,
                              size: 18,
                              color: AppPalette.textFaint,
                            ),
                            onTap: () =>
                                setState(() => _recentOpen = !_recentOpen),
                          ),
                        if (_recentOpen)
                          for (final path in _recent)
                            SettingsRow(
                              title: _basename(path),
                              detail: path,
                              nested: true,
                              // No leading glyph: the indent under an open Recent is what says
                              // these belong to it, and a second icon column would put them back
                              // level with the sources above.
                              trailing: _check(_folder == path),
                              onTap: () => setState(() {
                                _folder = path;
                                _project = null;
                                _projectLabel = null;
                                _recentOpen = false;
                                _error = null;
                              }),
                            ),
                      ],
                    ),
                    const SettingsCaption('ENGINE'),
                    SettingsGroup(
                      children: [
                        for (final identity in _shownEngines) ...[
                          SettingsRow(
                            title: identity.label,
                            detail: _engineNote(identity.id),
                            leading: EngineMark(engine: identity.id, size: 18),
                            trailing: _check(_engine == identity.id),
                            onTap: () => setState(() {
                              _engine = identity.id;
                              _error = null;
                            }),
                          ),
                          // Codex's profiles belong UNDER Codex, not in a section of their own at
                          // the foot of the page. They are a detail of one engine — a section
                          // separated from the row that summons it reads as a second question,
                          // and appearing at the bottom of a long list is how it went unnoticed.
                          //
                          // ⚠️ Only for the engine that has them, and only once the machine has
                          // said it understands CODEX_HOME. Every other engine shows nothing here,
                          // which is why this is a list inside the loop rather than a block after
                          // it.
                          if (identity.id == 'codex' && _showsCodexProfile) ...[
                            SettingsRow(
                              title: 'Default profile',
                              nested: true,
                              detail: _codexProfilesLoaded
                                  ? null
                                  : 'Looking for others…',
                              trailing: _check(_codexProfile == null),
                              onTap: () => setState(() => _codexProfile = null),
                            ),
                            for (final profile in _codexProfiles)
                              SettingsRow(
                                title: profile.label,
                                detail: profile.path,
                                nested: true,
                                trailing: _check(_codexProfile == profile),
                                onTap: () =>
                                    setState(() => _codexProfile = profile),
                              ),
                          ],
                        ],
                        // The rest of the engines, behind one row. It stays once opened: there is
                        // nothing to fold back to that the person would want.
                        if (!_moreEnginesOpen && _hiddenEngineCount > 0)
                          SettingsRow(
                            title: '$_hiddenEngineCount more',
                            leading: Icon(
                              LucideIcons.ellipsis300,
                              size: 18,
                              color: AppPalette.textSecondary,
                            ),
                            onTap: () =>
                                setState(() => _moreEnginesOpen = true),
                          ),
                      ],
                    ),
                  ],
                ),
              ),
              // ⚠️ The refusal belongs BESIDE the button, not at the end of the list above it.
              // It used to sit after the engines and the Codex profile — past nine rows and well
              // below the fold — while the button is pinned here. Pressing Create and being
              // refused looked exactly like pressing Create and nothing happening, because the
              // answer rendered somewhere nobody was looking.
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 12, 20, 0),
                  child: Text(
                    _error!,
                    style: TextStyle(color: AppPalette.offline, fontSize: 13),
                  ),
                ),
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 8, 20, 12),
                child: SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: ready ? () => unawaited(_create()) : null,
                    child: Text(_creating ? 'Starting…' : 'Create agent'),
                  ),
                ),
              ),
            ],
          ),
        ),
      );
    },
  );

  Widget? _check(bool selected) => selected
      ? Icon(LucideIcons.check300, size: 18, color: AppPalette.accent)
      : null;
}

/// The Git field, as its own widget so the text it holds survives the parent's rebuilds — a
/// `StatefulBuilder` inside the dialog would lose the error the moment anything above repainted.
class _RepositoryDialog extends StatefulWidget {
  const _RepositoryDialog({this.initialUrl});

  final String? initialUrl;

  @override
  State<_RepositoryDialog> createState() => _RepositoryDialogState();
}

class _RepositoryDialogState extends State<_RepositoryDialog> {
  late final _controller = TextEditingController(text: widget.initialUrl ?? '');
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit() {
    final repository = GitHubRepository.parse(_controller.text);
    if (repository == null) {
      setState(() => _error = 'That is not a GitHub repository.');
      return;
    }
    Navigator.of(context).pop(repository);
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return AlertDialog(
      backgroundColor: AppPalette.panelBg,
      title: Text(
        'Git repository',
        style: TextStyle(color: AppPalette.textPrimary, fontSize: 18),
      ),
      content: TextField(
        controller: _controller,
        autofocus: true,
        autocorrect: false,
        enableSuggestions: false,
        keyboardType: TextInputType.url,
        textInputAction: TextInputAction.go,
        style: TextStyle(color: AppPalette.textPrimary, fontSize: 15),
        decoration: InputDecoration(
          hintText: 'owner/repo, or a GitHub URL',
          errorText: _error,
        ),
        onChanged: (_) {
          if (_error != null) setState(() => _error = null);
        },
        onSubmitted: (_) => _submit(),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(onPressed: _submit, child: const Text('Select')),
      ],
    );
  }
}
