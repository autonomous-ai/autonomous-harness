import 'dart:async';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../analytics/analytics.dart';
import '../core/engine_availability.dart';
import '../core/codex_profiles.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_checkbox.dart';
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_select_field.dart';
import '../shared/widgets/labeled_field.dart';
import '../state/app_state.dart';
import 'engine_identity.dart';
import 'codex_profile_field.dart';
import 'remote_folder_picker.dart';

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

/// Opens the New agent dialog for [machineId].
///
/// [source] names the door it was opened by — `machine_row`, `rail_empty`,
/// `pane_empty` or `shortcut` — and is required rather than defaulted, so a
/// fifth entry point has to say which one it is instead of quietly filing
/// itself under an existing name.
Future<void> showNewAgentDialog(
  BuildContext context,
  AppNotifier notifier,
  String machineId, {
  required String source,
  String? initialFolder,
  String? swarmId,
}) {
  // Reported here rather than at each call site: the doors are four and
  // growing, and one that forgets to track is a hole in the funnel that only
  // shows up as a number quietly being too small.
  analytics.newAgentOpened(source: source);
  return showAppDialog<void>(
    context: context,
    builder: (context) => _NewAgentDialog(
      notifier: notifier,
      machineId: machineId,
      initialFolder: initialFolder,
      swarmId: swarmId ?? notifier.activeSwarmId,
    ),
  );
}

class _NewAgentDialog extends StatefulWidget {
  final AppNotifier notifier;
  final String machineId;
  final String? initialFolder;
  final String swarmId;

  const _NewAgentDialog({
    required this.notifier,
    required this.machineId,
    this.initialFolder,
    required this.swarmId,
  });

  @override
  State<_NewAgentDialog> createState() => _NewAgentDialogState();
}

class _NewAgentDialogState extends State<_NewAgentDialog> {
  late String _engine = allEngines.first.id;
  late String _machineId = widget.machineId;
  late String? _folder = widget.initialFolder;
  LocalCodexProfile? _codexProfile;
  bool _codexProfilesBusy = true;
  bool _bypassPermission = false;

  /// Whether the fold is open. Closed on every open of the dialog, deliberately:
  /// it is shut for the case it exists to serve, and a drawer that remembers
  /// being open is a drawer that is open for somebody who never asked.
  bool _advancedOpen = false;
  bool _submitting = false;

  @override
  void initState() {
    super.initState();
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
      unawaited(widget.notifier.probeEngines(_machineId, force: true));
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

  /// The row's note about installation, or null when there is nothing to say —
  /// which covers both "it is here" and "the machine has not answered yet".
  ///
  /// Those two produce the same absent note on purpose. A row cannot say
  /// "not installed" on the strength of a probe that has not returned; the
  /// dialog's own preflight panel is where the settled answer is stated, and it
  /// arrives a moment later without moving anything.
  String? _engineInstallNote(String engine) {
    final entry = _availability(engine);
    if (entry == null || entry.installed) return null;
    // Only the state Harness cannot fix keeps words. It is rare, it is the one
    // the reader has to act on themselves, and a glyph for "we cannot help you
    // here" would be a glyph nobody decodes in time.
    return entry.installable ? null : 'not installed';
  }

  /// The one caveat worth printing beside an engine's name, or none.
  ///
  /// Stated in the row rather than discovered after picking: each of these
  /// changes what the engine can do, and finding out by watching the checkbox
  /// vanish — or by reading `command not found` out of a pane — is a worse way
  /// to learn it. One note per row, so the row stays a name with a caveat
  /// rather than a sentence.
  String? _engineNote(String engine) {
    return _engineInstallNote(engine) ??
        (kEngineBypassPermissionFlag.containsKey(engine)
            ? null
            : 'no bypass flag');
  }

  /// This engine is absent and Harness would install it before launching.
  bool _willInstallEngine(String engine) {
    final entry = _availability(engine);
    return entry != null && !entry.installed && entry.installable;
  }

  /// The system panel is modal and slow enough to notice. Without this the
  /// button stays live and a second click stacks a second panel behind the
  /// first — on macOS that leaves one the user cannot reach until they dismiss
  /// the one on top.
  /// refuse it either, it simply never replies, so this arrives 30s later —
  /// and until it is rendered the panel says "Ready to launch" over an engine
  /// nobody checked for, which the create then fails on at the far end.
  bool get _engineCheckFailed {
    final machine = widget.notifier.stateOf(_machineId);
    if (machine == null) return false;
    return !machine.engines.loaded && machine.engines.error != null;
  }

  /// The engine is missing but this machine cannot safely auto-install it — for
  /// example, an explicit ENGINE_PATH override points at a missing file, or an
  /// older CLI has no recipe. Stated rather than silently offered, because the
  /// create WILL fail and the person needs to fix that machine first.

  /// What the fold says about itself while it is shut.
  ///
  /// Two facts in the order they matter: which Codex home, and whether the
  /// prompts are on. It is the ONLY thing on screen reporting either once the
  /// drawer is closed, which is why it is built here rather than left to a
  /// string in the widget — the two have to stay in step.
  String _advancedState() {
    // THE PROFILE ONLY. It also carried "prompts on" / "prompts OFF", and that
    // was cut on the owner's call for the reason that decides most copy here:
    // it did not say what it meant. "Prompts" names a thing the sentence inside
    // the fold explains and the row outside it does not, so the row was asking
    // people to already know.
    if (_engine != 'codex') return '';
    return _codexProfile?.label ?? 'default profile';
  }

  /// This engine is absent and Harness would install it before launching.
  bool get _willInstall {
    final entry = _availability(_engine);
    return entry != null && !entry.installed && entry.installable;
  }

  bool _picking = false;
  bool _folderHovered = false;
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
      _engine == 'codex' &&
      _availability('codex')?.supportsCodexHome == true &&
      _codexProfilesBusy;

  /// [Machine.displayName], not `name` — the latter is nullable and a machine
  /// that never got one would title the dialog "New agent on null".
  String get _machineName =>
      widget.notifier.stateOf(_machineId)?.machine.displayName ??
      'this machine';

  Future<void> _browse() async {
    if (_picking) return;
    // The agent runs on the MACHINE, so the folder has to exist on the machine
    // — which is the whole reason this branches.
    //
    // On this computer that is the OS's own panel (`getDirectoryPath` is
    // NSOpenPanel on macOS, IFileDialog on Windows, the desktop's file-chooser
    // portal on Linux): it is the picker the user already knows, it can reach
    // sidebar favourites, iCloud and network mounts that `fs_list_dir` never
    // enumerates, and the app is not sandboxed (`macos/Runner/*.entitlements`
    // declares no `com.apple.security.app-sandbox`) so the path it returns is
    // one the CLI can actually open — no security-scoped bookmark to hand over.
    //
    // On any other machine a native panel is not merely wrong but actively
    // misleading: it browses THIS Mac and hands back a path that does not exist
    // over there, so the agent would fail to start in a folder the user watched
    // themselves select. That case keeps the in-app browser, which walks the
    // remote filesystem over the `fs_list_dir` RPC.
    setState(() => _picking = true);
    final pickingMachine = _machineId;
    try {
      final picked = _machineIsThisComputer
          ? await getDirectoryPath(initialDirectory: _folder)
          : await showRemoteFolderPicker(
              context,
              notifier: widget.notifier,
              machineId: _machineId,
              initialPath: _folder,
            );
      if (!mounted) return;
      setState(() {
        _picking = false;
        if (picked != null && pickingMachine == _machineId) _folder = picked;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _picking = false;
        _error = 'Could not open the folder picker: $error';
      });
    }
  }

  Future<void> _submit() async {
    final folder = _folder;
    if (folder == null || _submitting || _waitingForCodexProfile) return;
    final engine = _engine;
    final profile = _codexProfile;
    final bypassPermission =
        _bypassPermission && kEngineBypassPermissionFlag.containsKey(engine);
    setState(() {
      _submitting = true;
      _error = null;
    });
    final error = await widget.notifier.createAgent(
      _machineId,
      engine: engine,
      folder: folder,
      swarmId: widget.swarmId,
      bypassPermission: bypassPermission,
      // Keep the explicit choice even if machine discovery changes mid-submit.
      // The notifier must reject a now-remote target, never use its default login.
      codexHome: engine == 'codex' ? profile?.path : null,
    );
    if (!mounted) return;
    if (error != null) {
      setState(() {
        _submitting = false;
        _error = error;
      });
      return;
    }
    analytics.agentCreated(engine: engine, bypassPermission: bypassPermission);
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    // Reads colour tokens, and lives in an Overlay — a top-down rebuild never
    // reaches it, so it has to watch for itself or it strands on the palette it
    // opened with.
    grid.AppTheme.watch(context);
    return ListenableBuilder(
      listenable: widget.notifier,
      builder: (context, _) => _buildDialog(context),
    );
  }

  Widget _buildDialog(BuildContext context) {
    final bypassFlag = kEngineBypassPermissionFlag[_engine];
    final canCreate =
        _folder != null && !_submitting && !_waitingForCodexProfile;

    return AlertDialog(
      // JUST "New agent". The machine used to be named here, and it was telling
      // somebody what they had already done: this dialog is opened FROM a
      // machine — its row, its `+`, its empty pane — so there is no other one it
      // could be for.
      title: const Text('New agent'),
      titleTextStyle: Theme.of(context).textTheme.titleMedium,
      content: SizedBox(
        width: _dialogWidth,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // ONE COLUMN, and no summary card beside it.
              //
              // The card held three facts and every one of them was already on
              // screen: the folder a field above it, the machine in the title,
              // and the command a restatement of the engine that had just been
              // picked. Only the bypass FLAG was its own — and that has moved to
              // the Advanced row, which is the one thing still reporting what is
              // folded away.
              //
              // Dropping it takes the dialog from 712px to 520. The old width
              // was not chosen for the content: it was measured against
              // `--dangerously-bypass-approvals-and-sandbox`, so the rarest
              // thing on the screen was setting the size of the window for
              // everybody who never turns it on.
              AbsorbPointer(
                absorbing: _submitting,
                child: _choices(bypassFlag),
              ),
              if (_error != null) ...[
                const SizedBox(height: _gapBlock),
                Text(
                  _error!,
                  style: Theme.of(context).textTheme.bodySmall
                      ?.copyWith(color: Theme.of(context).colorScheme.error),
                ),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: _submitting ? null : () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: canCreate ? _submit : null,
          child: _submitting
              ? const SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Text('Create agent'),
        ),
      ],
    );
  }

  /// The left column: what the user actually decides.
  Widget _choices(String? bypassFlag) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const FieldLabel('Machine'),
        AppSelectField<String>(
          key: const Key('new-agent-machine-field'),
          value: _machineId,
          options: [
            for (final machine in widget.notifier.machineStates.values)
              SelectOption(
                value: machine.machine.machineId,
                label: machine.isLocalMachine
                    ? 'Local'
                    : machine.machine.displayName,
                note: machine.nodeOnline == false
                    ? 'Offline'
                    : machine.needsLink
                    ? 'Link required'
                    : null,
              ),
          ],
          onChanged: (id) {
            setState(() {
              _machineId = id;
              _folder = null;
              _codexProfile = null;
              _codexProfilesBusy = true;
              _error = null;
            });
            unawaited(widget.notifier.probeEngines(id, force: true));
          },
        ),
        const SizedBox(height: _gapField),
        const FieldLabel('Engine'),
        // The app's own picker, not `DropdownButtonFormField`.
        //
        // Material's dropdown renders its own popup, anchors it OVER the field
        // instead of under it, forces the panel to the field's width, and comes
        // out square-cornered and edge-to-edge whatever you pass it — while
        // ignoring both `menuTheme` and `popupMenuTheme`, so it could not be
        // made to match any other menu in this app.
        AppSelectField<String>(
          key: const Key('new-agent-engine-field'),
          value: _engine,
          options: [
            for (final identity in allEngines)
              SelectOption(
                value: identity.id,
                label: identity.label,
                note: _engineNote(identity.id),
                leading: () => EngineMark(engine: identity.id, size: 14),
                // "will install" said in words repeated down a third of the
                // list, and a column of the same two words is a column the eye
                // has to read to discover it says nothing new. The glyph is
                // scanned once; the sentence moves to its tooltip and to the
                // preflight panel, which names the exact command anyway.
                trailing: _willInstallEngine(identity.id)
                    ? () => _InstallMark(engine: identity.id)
                    : null,
              ),
          ],
          onChanged: (value) => setState(() {
            _engine = value;
            _codexProfile = null;
            _codexProfilesBusy = true;
            if (!kEngineBypassPermissionFlag.containsKey(value)) {
              _bypassPermission = false;
            }
          }),
        ),
        // Unconditional now: Codex here is always on its own login, so the
        // profile it runs under is always a live question.
        // WHAT THE SUMMARY'S HEADING USED TO SAY, minus the half that had
        // somewhere else to live.
        //
        // Four states were printed on that card. Two of them already have a
        // home: "not installed" is a note on the engine's own row, and "pick a
        // folder" is the Create button being disabled. These two had nowhere
        // else, and losing them would have made a machine that Harness has not
        // managed to reach look exactly like one it has.
        if (_willInstall || _engineCheckFailed) ...[
          const SizedBox(height: 6),
          Text(
            _willInstall
                ? 'Not here yet — Harness will install '
                      '${engineIdentity(_engine).label} first.'
                // Faint and phrased as an absence, not a fault: nothing is
                // wrong with the launch, we simply could not look, and painting
                // that as a problem would cry wolf on every older remote box.
                //
                // THE WHOLE PARAGRAPH, not a headline. It was tempting to leave
                // this at "Could not check this machine" — the dialog is being
                // made smaller, after all — but the sentence that got cut was
                // the one naming the way out. This line only appears when the
                // check actually failed, so its length costs nothing on the
                // launches that work.
                : '$_machineName did not say which engines it has, so Harness '
                      'could not check for '
                      '${engineIdentity(_engine).label} before offering to '
                      'launch it. The create will still run — if the engine is '
                      'missing there, that will only show up when it fails. '
                      'Updating the Harness CLI on $_machineName lets this be '
                      'checked first.',
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: _willInstall
                  ? grid.AppPalette.accentOnSurface
                  : grid.AppPalette.textFaint,
            ),
          ),
        ],
        const SizedBox(height: _gapField),
        const FieldLabel('Working folder'),
        _FolderControl(
          folder: _folder,
          machineName: _machineName,
          machineIsThisComputer: _machineIsThisComputer,
          picking: _picking,
          hovered: _folderHovered,
          onHover: (value) => setState(() => _folderHovered = value),
          onPressed: _browse,
        ),
        // THE FOLD. What is behind it is what most people never touch: a Codex
        // home to run under, and the flag that turns the approvals off. Leaving
        // them in the main column made this a four-question dialog to do a
        // two-question job.
        //
        // The row REPORTS ITS OWN STATE on the right, and that is what makes
        // folding them away safe rather than merely tidy. A drawer that hides
        // what it is set to is a drawer people open every time to check.
        const SizedBox(height: _gapBlock),
        _Advanced(
          open: _advancedOpen,
          state: _advancedState(),
          onToggle: () => setState(() => _advancedOpen = !_advancedOpen),
          children: [
            if (_engine == 'codex') ...[
              if (_availability('codex')?.supportsCodexHome == true)
                CodexProfileField(
                  notifier: widget.notifier,
                  machineId: _machineId,
                  machineIsThisComputer: _machineIsThisComputer,
                  value: _codexProfile,
                  observedPaths: {
                    for (final agent
                        in widget.notifier.stateOf(_machineId)!.agents)
                      if (agent.engine == 'codex' && agent.codexHome != null)
                        agent.codexHome!,
                  },
                  onChanged: (profile) =>
                      setState(() => _codexProfile = profile),
                  onBusyChanged: (busy) {
                    if (_codexProfilesBusy != busy) {
                      setState(() => _codexProfilesBusy = busy);
                    }
                  },
                )
              else
                Text(
                  _availability('codex') == null
                      ? _engineCheckFailed
                            ? 'Could not check Codex profiles. Reopen this dialog to retry.'
                            : 'Checking whether this computer supports Codex profiles…'
                      : 'Update Harness CLI to choose a local Codex profile.',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
            ],
            // No 'Permissions' heading. It sat over a single checkbox whose own
            // label already says what it does, so it was a section title for a
            // section of one.
            if (bypassFlag != null)
              _BypassCheck(
                value: _bypassPermission,
                flag: bypassFlag,
                hovered: _bypassHovered,
                onHover: (value) => setState(() => _bypassHovered = value),
                onChanged: (value) => setState(() => _bypassPermission = value),
              )
            else
              // Not silence: an engine with no checkbox looks identical to one whose
              // checkbox the user simply missed.
              Text(
                '${engineIdentity(_engine).label} has no permission flag this app '
                'can pass — it asks in the terminal.',
                style: Theme.of(context).textTheme.bodySmall,
              ),
          ],
        ),
      ],
    );
  }
}

/// Wide enough for two columns that both hold a path without wrapping every
/// line; the summary takes [_summaryWidth] and the choices take the rest.
///
/// The summary is the wider of the two, and deliberately: the choices column
/// holds controls that ellipsize cleanly, while the summary holds three strings
/// that must be read whole — a flag as long as
/// `--dangerously-bypass-approvals-and-sandbox`, a hostname, and a path. At an
/// even split the longest flag broke across two lines mid-word.
///
/// ⚠️ THAT REASONING IS GONE WITH THE SUMMARY, and it is worth keeping the
/// record of it: 712 was 360 for the controls plus 352 for a card, and the 352
/// was measured against `--dangerously-bypass-approvals-and-sandbox` — 42
/// characters of a flag most people never turn on. The width of the dialog was
/// being set by the rarest thing that could appear in it.
///
/// 520 is what two fields and a fold need. A path still ellipsizes from its
/// HEAD (see `_ellipsizeHead`), which is what keeps the leaf readable.
const double _dialogWidth = 520;

/// A path shortened from its HEAD, so the leaf survives.
///
/// `/Users/macbookpro/Desktop/A` truncated the ordinary way keeps the part
/// every path on the machine shares and drops the only part that identifies it.
/// This drops whole leading segments instead and marks the cut with `…/`, the
/// same shorthand a shell prompt uses:
///
/// ```
/// /Users/macbookpro/work/harness/autonomous-harness-desktop
/// …/harness/autonomous-harness-desktop
/// ```
///
/// Segment-wise rather than character-wise: cutting mid-name reads as a typo,
/// while a dropped segment reads as a path someone abbreviated. Windows paths
/// come back untouched — they are separated by `\`, and a wrong guess about the
/// separator would mangle the string rather than shorten it.
/// The advance of one character at the 12pt mono the path control sets — the
/// face is 0.6em wide, like every monospaced face in this family.
///
/// Arithmetic rather than a `TextPainter`: this runs on every rebuild, and a
/// layout pass to answer a question this cheap is a poor trade.
const double _monoAdvance = 12 * 0.6;

String _ellipsizeHead(String path, double maxWidth) {
  final fits = path.length * _monoAdvance <= maxWidth;
  if (fits || !path.contains('/')) return path;
  final segments = path.split('/').where((s) => s.isNotEmpty).toList();
  // Never below the leaf: a control too narrow for even that shows the leaf and
  // lets the Text's own ellipsis take the rest.
  for (var drop = 1; drop < segments.length; drop++) {
    final candidate = '…/${segments.skip(drop).join('/')}';
    if (candidate.length * _monoAdvance <= maxWidth) return candidate;
  }
  return '…/${segments.last}';
}

/// A path or a flag, in the face the user chose for code.
///
/// Built from [grid.AppFont] rather than a literal family so it follows Settings
/// ▸ Terminal, and carries `monoFallback` — without it a user whose chosen face
/// lacks a glyph gets Roboto for that one character.
///
/// One size for every mono string here, taken off the ramp rather than picked
/// per call: the path, the flag under the checkbox and the flag in the command
/// are the same kind of text, and three hand-set sizes is how they stop looking
/// like it. `labelSmall`'s 12 is a step under the 13 of the controls around
/// them, which is where a monospaced face has to sit to read at the same size.
TextStyle _mono({required Color color}) => TextStyle(
  fontFamily: grid.AppFont.mono,
  fontFamilyFallback: grid.AppFont.monoFallback,
  fontSize: 12,
  color: color,
);

// The dialog's spacing scale. Four steps, named, rather than the run of
// 3/6/7/8/10/12/14/16/18 this file grew — a column whose gaps are all slightly
// different is what "the padding feels off" actually is.
//
// `FieldLabel` already carries its own 6px gap to the control it names, so a
// caption never takes a step from here; these are the gaps BETWEEN things.

/// A label and the line it belongs to — the flag under its title.
const double _gapTight = 4;

/// Blocks inside one card: the command, the facts, the reason.
const double _gapBlock = 12;

/// One field and the next, down the choices column.
const double _gapField = 16;

/// The folder control: one target, not a text box with a button beside it.
///
/// The old shape put a read-only `InputDecorator` next to a `Browse…` button,
/// which read as a field you could type in and as the loudest control in the
/// dialog. Here the whole row is the button — the path is what it displays, and
/// the trailing word says what clicking does.
/// The fold that holds what most people never touch.
///
/// A ROW THAT REPORTS ITSELF. Everything about this is ordinary — a twisty, a
/// label, some children — except the state printed on the right, and that is the
/// part doing the work. Two settings were moved out of sight here; a drawer that
/// hides what it is set to is one people open every time to check, which costs
/// more than leaving the controls where they were.
///
/// AMBER, NOT RED, when the prompts are off. Red on this desktop means destroy,
/// and it was tried: a red "Create without prompts" button read as though the
/// button itself were dangerous rather than the setting behind it. Amber is
/// already what this app gives that flag wherever else it appears.
class _Advanced extends StatelessWidget {
  const _Advanced({
    required this.open,
    required this.state,
    required this.onToggle,
    required this.children,
  });

  final bool open;

  /// What is set, in a few words — see `_advancedState`. Empty says nothing.
  final String state;

  final VoidCallback onToggle;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Divider(height: 1, color: grid.AppGlass.hair),
        InkWell(
          key: const Key('new-agent-advanced'),
          onTap: onToggle,
          borderRadius: BorderRadius.circular(6),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 9),
            child: Row(
              children: [
                // Rotated rather than swapped for a second glyph: one shape
                // turning reads as the same control in two positions, which is
                // what it is.
                AnimatedRotation(
                  turns: open ? 0 : -0.25,
                  duration: const Duration(milliseconds: 120),
                  child: Icon(
                    Icons.expand_more,
                    size: 16,
                    color: grid.AppPalette.textFaint,
                  ),
                ),
                const SizedBox(width: 6),
                Text(
                  'Advanced',
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: grid.AppPalette.textSecondary,
                  ),
                ),
                const Spacer(),
                Flexible(
                  child: Text(
                    key: const Key('new-agent-advanced-state'),
                    state,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    textAlign: TextAlign.right,
                    style: _mono(color: grid.AppPalette.textFaint)
                        .copyWith(fontSize: 11.5),
                  ),
                ),
              ],
            ),
          ),
        ),
        // HIDDEN, NOT UNMOUNTED, and that is not a preference — it is what the
        // dialog needs to work at all.
        //
        // It was `if (open)` first, on the reasoning that a shut drawer should
        // not pay for a question nobody asked. The Codex profile field is the
        // thing that asks the machine for its profiles, and TWO things downstream
        // depend on its having asked: it clears `_codexProfilesBusy`, which gates
        // the Create button, and it auto-selects when there is exactly one
        // profile. Unmounted, neither ever happens — so Create stayed disabled
        // forever on Codex, with nothing on screen saying why.
        //
        // Offstage builds and runs it, and merely declines to paint it.
        Offstage(
          offstage: !open,
          child: Padding(
            padding: const EdgeInsets.only(top: 4, bottom: 2),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: children,
            ),
          ),
        ),
      ],
    );
  }
}

class _FolderControl extends StatelessWidget {
  const _FolderControl({
    required this.folder,
    required this.machineName,
    required this.machineIsThisComputer,
    required this.picking,
    required this.hovered,
    required this.onHover,
    required this.onPressed,
  });

  final String? folder;
  final String machineName;
  final bool machineIsThisComputer;
  final bool picking;
  final bool hovered;
  final ValueChanged<bool> onHover;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final theme = Theme.of(context);
    final chosen = folder;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        // [MouseRegion] + [AnimatedContainer], the shape every hoverable control
        // in this app takes — not `InkWell`, whose ripple is a phone idiom and
        // whose hover is instant where the app's is [AppMotion.hover].
        MouseRegion(
          cursor: picking
              ? SystemMouseCursors.progress
              : SystemMouseCursors.click,
          onEnter: (_) => onHover(true),
          onExit: (_) => onHover(false),
          child: GestureDetector(
            onTap: picking ? null : onPressed,
            behavior: HitTestBehavior.opaque,
            child: AnimatedContainer(
              duration: grid.AppMotion.hover,
              curve: grid.AppMotion.curve,
              constraints: BoxConstraints(
                minHeight: grid.AppControl.heightFieldScaled,
              ),
              // The select field's own padding, so the two controls stacked in
              // this column share one left edge and one right edge.
              padding: const EdgeInsets.only(left: 10, right: 8),
              decoration: BoxDecoration(
                // §1: depth from fill, never a rim. [AppSurface.recess] is the
                // same well [AppSelectField] sits in — a folder is picked the
                // same way an engine is, so it looks the same at rest.
                color: hovered && !picking
                    ? grid.AppSurface.recessHover
                    : grid.AppSurface.recess,
                borderRadius: BorderRadius.circular(grid.AppControl.radius),
              ),
              child: Row(
                children: [
                  Icon(
                    Icons.folder_outlined,
                    size: grid.AppControl.iconSize,
                    color: grid.AppPalette.textFaint,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    key: const Key('new-agent-folder-text'),
                    // Aligned left like every other control's content.
                    //
                    // This used to set `TextDirection.rtl` to make a long path
                    // ellipsize from its head, keeping the leaf visible. But
                    // direction drives ALIGNMENT too, so the whole string was
                    // shoved to the trailing edge and left a hole after the
                    // folder glyph — wider the shorter the path, which is why a
                    // remote `/home/node/work` looked worst of all.
                    //
                    // Truncation is a job for the string, not the layout, so the
                    // head is now trimmed in [_ellipsizeHead] and the Text stays
                    // plain LTR.
                    child: LayoutBuilder(
                      builder: (context, constraints) => Align(
                        alignment: AlignmentDirectional.centerStart,
                        child: Text(
                          picking
                              ? 'Waiting for the folder picker…'
                              // Not "on $machineName": the title says which
                              // machine and so does the summary, and a hostname
                              // like `MacBooks-MacBook-Pro.local` spent the
                              // whole control repeating it, then truncated.
                              : chosen == null
                              ? 'Choose a folder…'
                              : _ellipsizeHead(chosen, constraints.maxWidth),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: chosen != null && !picking
                              ? _mono(color: grid.AppPalette.textPrimary)
                              : theme.textTheme.labelMedium?.copyWith(
                                  color: grid.AppPalette.textFaint,
                                ),
                        ),
                      ),
                    ),
                  ),
                  if (!picking) ...[
                    const SizedBox(width: 8),
                    Text(
                      chosen == null ? 'Browse…' : 'Change',
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: grid.AppPalette.accentOnSurface,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
        // Only the case that needs explaining gets a line. On this computer the
        // OS panel is what everyone expects and saying so is noise; on another
        // machine the in-app browser is the surprising half, so that is the half
        // that speaks.
        if (!machineIsThisComputer) ...[
          const SizedBox(height: _gapTight),
          Text(
            '$machineName is another computer — this browses its folders '
            "through the CLI, not this Mac's.",
            style: theme.textTheme.bodySmall,
          ),
        ],
      ],
    );
  }
}

/// The bypass checkbox, in the app's own row shape.
///
/// Not `CheckboxListTile`: that was the only Material list tile left in the app,
/// and its `dense`/`contentPadding` combination left the box floating well clear
/// of the text it labels and out of line with the fields above it.
class _BypassCheck extends StatelessWidget {
  const _BypassCheck({
    required this.value,
    required this.flag,
    required this.hovered,
    required this.onHover,
    required this.onChanged,
  });

  final bool value;
  final String flag;
  final bool hovered;
  final ValueChanged<bool> onHover;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final theme = Theme.of(context);
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => onHover(true),
      onExit: (_) => onHover(false),
      child: GestureDetector(
        onTap: () => onChanged(!value),
        behavior: HitTestBehavior.opaque,
        child: AnimatedContainer(
          duration: grid.AppMotion.hover,
          curve: grid.AppMotion.curve,
          // Bled out to the left so the row's fill lines up with the fields
          // above it, and the text still starts on their left edge once the
          // box and its gap are counted.
          // NO SIDE PADDING. Ten pixels of it pushed the box in from the
          // margin every other control on this dialog starts at, so the one row
          // that is not a labelled field was also the one row that did not line
          // up with them. The hover fill simply spans the row instead.
          padding: const EdgeInsets.symmetric(vertical: 8),
          decoration: BoxDecoration(
            color: hovered ? grid.AppSurface.hoverFill : Colors.transparent,
            borderRadius: BorderRadius.circular(grid.AppControl.radius),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Nudged down onto the label's own line: the row is top-aligned
              // so the two-line block reads from its title, and a 16px box
              // centred on a 13pt cap sits a hair proud of it.
              Padding(
                padding: const EdgeInsets.only(top: 1),
                child: AppCheckbox(
                  value: value,
                  hovered: hovered,
                  onChanged: onChanged,
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      'Bypass permission prompts',
                      style: theme.textTheme.labelMedium?.copyWith(
                        color: grid.AppPalette.textPrimary,
                      ),
                    ),
                    const SizedBox(height: _gapTight),
                    Text(flag, style: _mono(color: grid.AppPalette.textFaint)),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// What this launch actually is, stated before it happens.
///
/// The dialog's inputs each answer a different question, and the one they add
/// up to — *what will be running, where, on whose account* — was the one thing
/// the old dialog never said. It matters most for the setting that reaches
/// outside this window: a bypass flag turns off an engine's own guardrails on a
/// machine that may not be this one.
///
/// Read-only on purpose, and shaped so: it takes the recessed inset fill, never
/// a field's, so nothing here invites a click.
/// "Not here yet — Harness will fetch it first."
///
/// A download arrow rather than the words, because this state recurs down the
/// engine list and a repeated two-word phrase stops being read. The tooltip
/// carries the meaning for a first encounter; the preflight panel carries the
/// actual command, which is the thing worth reading.
///
/// Drawn in [AppPalette.textFaint] — the ink the row's own qualifiers use. This
/// is a fact about the engine, not a warning about the choice: installing is a
/// normal outcome of picking it, and an amber glyph would say otherwise.
class _InstallMark extends StatelessWidget {
  const _InstallMark({required this.engine});

  final String engine;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Tooltip(
      message:
          '${engineIdentity(engine).label} is not on this machine — '
          'Harness installs it before launching',
      child: Icon(
        LucideIcons.download300,
        // A shade under the note text beside it: the glyph reads heavier than
        // type at the same nominal size, and matching the number makes it
        // louder than the words it replaced.
        size: 12,
        color: grid.AppPalette.textFaint,
      ),
    );
  }
}
