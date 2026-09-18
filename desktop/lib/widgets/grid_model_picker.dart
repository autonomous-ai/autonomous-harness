import 'dart:async';

import 'package:flutter/material.dart';

import '../core/models.dart';
import '../core/test_run.dart';
import '../state/app_state.dart';
import '../theme/app_theme.dart';
import '../usage/models_menu_controller.dart';
import 'engine_identity.dart';
import 'pane_menu.dart';

/// The engines whose panes carry a model picker.
///
/// Named here rather than derived from the daemon's `localModelEngines`, because the two answer
/// different questions. That list is which engines a Local model *can* be handed to — a launch
/// contract exists for seven of them. This is the narrower question of which ones a person is
/// OFFERED the switch on, and it is the three whose switching has been driven end to end: Claude
/// Code and Codex move by environment, and OpenCode by a config file plus its own `/models` picker.
///
/// The rest keep the header they had. A picker on an engine whose move has never been watched work
/// is a menu that looks like a choice and may not be one, and the cost of finding out is an agent
/// answering on a model nobody asked for.
const Set<String> kModelPickerEngines = {'claude', 'codex', 'opencode'};

/// Whether [engine] gets a picker. Unknown or absent is NO — a header offers nothing it cannot back.
bool modelPickerSupports(String? engine) =>
    kModelPickerEngines.contains(engine?.trim().toLowerCase());

/// The pane header's model picker, in two sections: **Subscription** and **Local**.
///
/// The shape is the app's own Models menu, deliberately — that menu already answers "what could this
/// run on" for the whole window, and a second control answering the same question in a different
/// visual language would read as a different KIND of question. It carries only two of that menu's
/// sections: the engine's own login, and the models the account's private grid is serving. There is
/// no API section here because this picker cannot put an agent on one.
///
/// **Only the private harness grid.** Not every grid this computer's `grid` CLI happens to be signed
/// into — the question the header asks is "which of MY machines could answer for this agent", and a
/// catalogue of other people's grids is a different question with a different blast radius.
///
/// The list is fetched when the menu opens rather than held in state, because it is live: an engine
/// can join or leave a grid between two openings, and an offer nobody is serving any more is worse
/// than a moment's spinner.
class GridModelPicker extends StatefulWidget {
  final AppNotifier notifier;
  final String machineId;

  /// Called with the chosen grid model.
  final ValueChanged<GridModel>? onSelected;

  /// Called to put the agent back on its own vendor login. Offered FIRST and always — a picker that
  /// can only move an agent ONTO a grid is a one-way door, and the way back must not be a thing you
  /// have to know a command for.
  final VoidCallback? onUseOwnLogin;

  /// Called when the Local section's action — "Open Grid" — is chosen. An action, not a
  /// destination: it opens the Grid harness, the agent that puts models on the user's machines,
  /// which is the answer to the empty section this menu otherwise stops at. Always offered,
  /// whether or not anything is being served yet: a person with no Local models is exactly who
  /// needs the door.
  final VoidCallback? onRunLocalModel;

  /// The grid model this agent is on right now, or null when it is on its own login. Drives the
  /// filled row, so the menu answers "where am I" as well as "where could I go".
  final String? currentModel;

  /// Whether the agent can search the web on [currentModel], as the daemon decided when it built
  /// the launch. Shown as a subtitle under the current Local row and in the control's tooltip —
  /// only for the two degraded values; `on` and null (nothing said) show nothing. Read only when
  /// [currentModel] is set: it is a fact about a Local-model launch, and the Subscription row has
  /// its own web tools.
  final GridWebSearch? webSearch;

  /// The agent's engine, for the subscription row's icon and label.
  final String? engineLabel;

  const GridModelPicker({
    super.key,
    required this.notifier,
    required this.machineId,
    this.onSelected,
    this.onUseOwnLogin,
    this.onRunLocalModel,
    this.currentModel,
    this.webSearch,
    this.engineLabel,
  });

  @override
  State<GridModelPicker> createState() => _GridModelPickerState();
}

class _GridModelPickerState extends State<GridModelPicker> {
  bool _loading = false;
  ModelsMenuController? _usage;
  GridModels? _last;

  @override
  void initState() {
    super.initState();
    // Warm the answer as soon as the control exists, so a click lands on a memo rather than on two
    // subprocess spawns and two network round trips — measured at ~1.4s, which is a person watching
    // a header do nothing. Fire-and-forget: nothing here waits on it, and a failure just means the
    // first open pays what it used to.
    unawaited(_prefetch());
  }

  Future<void> _prefetch() async {
    // Created here, not only on the cold path: a warm open reads `_usage.rows` for the subscription
    // row's provider name and percentage, and skipping it left that row falling back to the bare
    // engine label with no status beside it.
    _usage ??= ModelsMenuController(remote: widget.notifier.readRemoteUsage);
    // Not under `flutter test`: a refresh reads the Keychain and asks the vendors, the same reads the
    // usage rail keeps out of tests (kUnderTest) — here every test that drew a pane header left that
    // work's timers pending after the tree was gone. Opening the menu still refreshes.
    if (!kUnderTest) unawaited(_usage!.refresh().catchError((_) {}));
    final answer = await widget.notifier.gridModels(widget.machineId);
    if (mounted) _last = answer;
  }

  /// Closes the menu this control has open, if any. Set while one is showing.
  void Function()? _close;

  /// The answer the OPEN menu is drawing, and the overlay entry drawing it. Both set only while a
  /// menu is showing. A refresh that lands while the menu is open swaps the first and rebuilds
  /// the second, so a model that came up since the last open appears in THIS one rather than the
  /// next — a person who just started a model and opened the picker is looking for exactly that
  /// row, and a menu that showed it only on a second click read as the model not being there.
  GridModels? _shown;
  OverlayEntry? _entry;

  @override
  void dispose() {
    // A pane can go away under an open menu — closed, moved, or its swarm switched — and an overlay
    // entry outlives the State that inserted it.
    _close?.call();
    _usage?.dispose();
    super.dispose();
  }

  /// The sentence about web search on the current Local model, or null when there is none to
  /// show. Null off a grid whatever the daemon said: a frame can lag a move home by a beat, and
  /// the Subscription row must never wear a sentence about a launch it was no part of.
  String? get _webSearchSentence =>
      widget.currentModel == null ? null : widget.webSearch?.sentence;

  /// The subtitle under one Local row: the sentence for the CURRENT model only. The status is about
  /// this agent's launch, and the other rows are places it could go, about which nothing is known.
  String? _subtitleFor(GridModel model) =>
      widget.currentModel == model.id ? _webSearchSentence : null;

  /// The subscription reading for THIS agent's engine, or null when there is none to show.
  ///
  /// Built from the same controller the window's own Models menu uses, so the percentage here and
  /// the percentage up there cannot disagree. Its refresh is capped at once a minute and it answers
  /// from cache in between, which is why opening this menu does not cost a request.
  Map<String, Object?>? _subscriptionRow() {
    final engine = widget.engineLabel?.trim().toLowerCase();
    if (engine == null || engine.isEmpty) return null;
    for (final row in _usage?.rows ?? const <Map<String, Object?>>[]) {
      if (row['engine'] == engine) return row;
    }
    return null;
  }

  Future<void> _open() async {
    if (_loading) return;
    // A warm answer opens the menu with no wait at all. It is at most seconds old — the daemon's own
    // memo is what bounds that — and the refresh below lands in time for the next open.
    final GridModels answer;
    if (_last != null) {
      answer = _last!;
      // The refresh lands INTO the open menu, not only into the memo for the next one.
      unawaited(_prefetch().then((_) => _refreshOpenMenu()));
      await _show(answer);
      return;
    }
    setState(() => _loading = true);
    try {
      _usage ??= ModelsMenuController(remote: widget.notifier.readRemoteUsage);
      // ⚠️ The usage read is NOT awaited. It is decoration — a percentage beside the subscription
      // row — while the grid list is the menu's actual content, and a menu that waits on a credential
      // read to draw a list it already has is a menu that feels broken whenever that source is slow.
      // This open uses whatever is cached; the refresh lands for the next one. `refresh()` is itself
      // capped at once a minute, so opening the menu repeatedly costs nothing.
      unawaited(_usage!.refresh().catchError((_) {}));
      answer = await widget.notifier.gridModels(widget.machineId);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
    _last = answer;
    if (!mounted) return;
    await _show(answer);
  }

  /// Draw the menu for an answer already in hand. Split from [_open] so a warm open shares exactly
  /// the same menu as a cold one rather than a second copy of it.
  Future<void> _show(GridModels answer) async {
    if (!mounted) return;
    _shown = answer;

    final box = context.findRenderObject() as RenderBox?;
    final overlay =
        Overlay.of(context).context.findRenderObject() as RenderBox?;
    if (box == null || overlay == null) return;
    final origin = box.localToGlobal(Offset.zero, ancestor: overlay);
    final position = RelativeRect.fromLTRB(
      origin.dx,
      origin.dy + box.size.height + 6,
      overlay.size.width - origin.dx - box.size.width,
      0,
    );

    final subscription = _subscriptionRow();
    final chosen = await _showMenu(
      position: position,
      children: (close) => [
        paneMenuHeader('Subscription'),
        paneMenuItem(
          onTap: () => close(const _Choice.ownLogin()),
          child: PaneMenuRow(
            selected: widget.currentModel == null,
            engine: widget.engineLabel,
            title:
                (subscription?['title'] as String?) ??
                engineIdentity(widget.engineLabel).label,
            detail: (subscription?['account'] as String?) ?? '',
            // Absent rather than "unknown": a row that cannot say how much is left says nothing,
            // which reads as "no figure" instead of as a figure that happens to be missing.
            status: subscription?['status'] as String?,
          ),
        ),
        Divider(height: 9, thickness: 1, color: AppColors.border),
        // One section per grid with something to offer, the account's own first as "Local"
        // (its rows are the user's own computers), the shared ones by name — the same shape as
        // Subscription above, so a model on a team's grid is one row away like any other.
        // With no grid at all there is still a "Local" heading, so the sentence under it has a
        // place to be. Each heading carries a few words saying what the group is: a grid's name
        // alone ("autonomous.ai") over a model's id read as two entries of the same kind.
        for (final (index, section) in _sectionsToDraw(_shown!).indexed) ...[
          if (index > 0) const SizedBox(height: 4),
          // Own: one plain sentence, nothing under it — "your machines" was a second half of the
          // same fact and read oddly split onto its own clause. Shared: the general fact as the
          // heading, the specific grid as the name under it — the two are different kinds of
          // information (why the rows are here vs. which fleet they are), not one sentence.
          section.own
              ? paneMenuHeader('Local models on your machines')
              : paneMenuHeader('Models shared with you', caption: section.name),
          // An engine with no way onto a Local model (Cursor talks only to its own API; the
          // daemon refuses the move) is told so here, instead of being offered rows whose click
          // would do nothing. The daemon names the capable engines beside the list; an older
          // daemon names none, and then every row is offered as before.
          if (!_shown!.canRunLocally(widget.engineLabel))
            paneMenuEmpty(
              '${engineIdentity(widget.engineLabel).label} can only run on its own login.',
            )
          // Two different facts, two sentences. "We could not ask" and "this account has no
          // grid" send a person to two different places, and the one that used to cover both
          // told a signed-in user to sign in again. "The grid is serving nothing" is NOT a
          // sentence here: the "Open Grid" row that ends the menu is the answer, and a line
          // saying the list is empty above an empty list is noise.
          else if (section.models.isEmpty &&
              _emptySentence(_shown!, section) != null)
            paneMenuEmpty(_emptySentence(_shown!, section)!),
          if (_shown!.canRunLocally(widget.engineLabel))
            for (final model in section.models)
              paneMenuItem(
                onTap: () => close(_Choice.model(model)),
                child: PaneMenuRow(
                  selected: widget.currentModel == model.id,
                  title: model.id,
                  // Which machine answers it — on the own grid one of the user's own computers,
                  // which is the useful part of the answer.
                  status: model.node.isEmpty ? null : model.node,
                  subtitle: _subtitleFor(model),
                ),
              ),
        ],
        // The way to GET a Local model, under the ones there are and behind a rule of its own.
        //
        // Not a row among the models: those are places this agent can go, and this starts something
        // instead. Not on the section's own line either — that put a button beside a heading, two
        // different kinds of thing sharing a line and competing for the same glance. A captioned
        // rule says plainly that what follows answers a different question, and the button spans
        // the menu so it reads as the section's one action rather than as a wider row.
        //
        // Offered whatever THIS pane's engine can do: it opens a new pane, on an engine that can.
        _ManagerInvitation(
          onPressed: () => close(const _Choice.runLocalModel()),
        ),
      ],
    );
    if (chosen == null) return;
    if (chosen.runLocalModel) {
      widget.onRunLocalModel?.call();
      return;
    }
    // Selecting what is already selected respawns the pane for no reason — do nothing instead.
    if (chosen.model == null) {
      if (widget.currentModel != null) widget.onUseOwnLogin?.call();
      return;
    }
    if (chosen.model!.id != widget.currentModel)
      widget.onSelected?.call(chosen.model!);
  }

  /// What the Local section says when it lists nothing.
  ///
  /// Two sentences, because they are two different situations and only one of them is about the
  /// account. Folding them together is what put "sign in again to set them up" in front of a
  /// signed-in user whose daemon happened to be offline — advice that was wrong, and that would
  /// not have helped even if the diagnosis had been right. A reachable own grid serving nothing
  /// still answers the sentence below, so "Local models on your machines" is never left to end
  /// at an empty list that reads as a rendering gap.
  String? _emptySentence(GridModels answer, GridSection section) {
    if (!answer.reachable) return 'Could not reach this machine.';
    // The machine's gap before the account's: with no `grid` on this computer there is nothing a
    // sign-in could set up here, and the feature's name is the only word for it a person knows.
    if (answer.gridCli == GridCli.missing) {
      return "Harness Compute isn't installed on this machine.";
    }
    // The account's rest are the models on the user's own machines; an empty list there needs a
    // sentence under the heading. Shared grids are never drawn empty (see _sectionsToDraw), so
    // this branch only ever fires for the own grid.
    if (section.own) {
      return 'No local models on this account yet.';
    }
    return null;
  }

  /// The sections worth a heading: "Local" always (so the empty-state sentence has a place),
  /// and a shared grid only while it serves something. A team grid with nothing running is not
  /// a choice this menu can offer, and a heading over "nothing here" was a line to read for no
  /// gain — the menu is for picking a model, not for surveying grids.
  List<GridSection> _sectionsToDraw(GridModels answer) {
    final sections = answer.sections
        .where((s) => s.own || s.models.isNotEmpty)
        .toList();
    if (sections.any((s) => s.own)) return sections;
    return [
      GridSection(
        name: answer.gridName ?? '',
        own: true,
        models: answer.models,
      ),
      ...sections,
    ];
  }

  /// The pane menu ([showPaneMenu]), with this picker's two hooks: the entry, so a refresh that
  /// lands while the menu is open can redraw it, and the closer, so a pane going away under an
  /// open menu can take the menu with it.
  Future<_Choice?> _showMenu({
    required RelativeRect position,
    required List<Widget> Function(void Function(_Choice?) close) children,
  }) => showPaneMenu<_Choice>(
    context: context,
    position: position,
    children: children,
    onOpen: (entry, close) {
      _entry = entry;
      _close = close;
    },
    onClose: () {
      _entry = null;
      _shown = null;
      _close = null;
    },
  );

  /// Redraw the open menu from the fresh memo, if the list changed under it. Nothing to do when
  /// no menu is open, or when the refresh said what the menu already shows — a rebuild for an
  /// identical list would only flicker the hover.
  void _refreshOpenMenu() {
    final entry = _entry;
    final fresh = _last;
    final shown = _shown;
    if (!mounted || entry == null || fresh == null || shown == null) return;
    if (_sameAnswer(fresh, shown)) return;
    _shown = fresh;
    entry.markNeedsBuild();
  }

  static bool _sameAnswer(GridModels a, GridModels b) {
    if (a.reachable != b.reachable ||
        a.gridName != b.gridName ||
        a.gridCli != b.gridCli) {
      return false;
    }
    if (a.models.length != b.models.length) return false;
    for (var i = 0; i < a.models.length; i += 1) {
      if (a.models[i].id != b.models[i].id ||
          a.models[i].node != b.models[i].node) {
        return false;
      }
    }
    return true;
  }

  @override
  Widget build(BuildContext context) {
    final sentence = _webSearchSentence;
    return Tooltip(
      // The same sentence the menu shows, one line under the control's own — so a person can learn
      // the agent has no web search without opening the menu at all.
      message: sentence == null
          ? 'Where this agent runs'
          : 'Where this agent runs\n$sentence',
      waitDuration: const Duration(milliseconds: 700),
      child: MouseRegion(
        // Stated rather than inherited. The pane header sits over a terminal, and the cursor a
        // person sees while hovering this was whatever the surface underneath asked for — so a
        // control that opens a menu did not look like one until you clicked it.
        cursor: SystemMouseCursors.click,
        // Its own ink surface: an InkWell needs a Material above it, and a pane header is not
        // always inside one — every test that drew a header threw "No Material widget found".
        child: Material(
          type: MaterialType.transparency,
          child: InkWell(
            onTap: _open,
            // Stated on the InkWell as well as on the MouseRegion above it. The cursor a person sees is
            // the INNERMOST annotation under the pointer, and InkWell installs one of its own — so an
            // ancestor asking for a hand is not, by itself, the thing that decides.
            mouseCursor: SystemMouseCursors.click,
            borderRadius: BorderRadius.circular(4),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  // No leading glyph: the word carries the control, and a header this dense reads
                  // better with one fewer mark in it. The spinner takes that space only while a read
                  // is in flight, so the label does not shift when nothing is happening.
                  if (_loading) ...[
                    const SizedBox(
                      width: 11,
                      height: 11,
                      child: CircularProgressIndicator(strokeWidth: 1.5),
                    ),
                    const SizedBox(width: 5),
                  ],
                  Text(
                    'Model',
                    style: TextStyle(fontSize: 11, color: AppColors.textSoft),
                  ),
                  Icon(
                    Icons.arrow_drop_down,
                    size: 14,
                    color: AppColors.mutedStrong,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The invitation that closes the Local section: a captioned rule, then the one ACTION in this menu.
///
/// Everything above is a destination — pick it and the agent moves. This starts something instead,
/// and the rule is what says so before the button is read: a line that names a different question,
/// so the button under it is not scanned as one more place to go.
///
/// The spacing is the point as much as the parts. A rule tight against the last model reads as a
/// separator between two rows rather than the end of a list, and a button pressed against its own
/// caption reads as one block of chrome; both were tried. The gaps here are deliberately larger
/// than the row rhythm above, because this is where the menu stops listing and starts offering.
class _ManagerInvitation extends StatefulWidget {
  const _ManagerInvitation({required this.onPressed});

  final VoidCallback onPressed;

  @override
  State<_ManagerInvitation> createState() => _ManagerInvitationState();
}

class _ManagerInvitationState extends State<_ManagerInvitation> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final rule = Expanded(child: Container(height: 1, color: AppColors.border));
    return Padding(
      // Wider than a row's inset on purpose: this block is not one of them.
      padding: const EdgeInsets.fromLTRB(
        kPaneMenuInset + kPaneMenuRowPadding,
        12,
        kPaneMenuInset + kPaneMenuRowPadding,
        4,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              rule,
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 10),
                child: Text(
                  'Manage the models on your machines',
                  style: TextStyle(
                    fontSize: 10.5,
                    letterSpacing: .2,
                    color: AppColors.mutedStrong,
                  ),
                ),
              ),
              rule,
            ],
          ),
          const SizedBox(height: 9),
          MouseRegion(
            cursor: SystemMouseCursors.click,
            onEnter: (_) => setState(() => _hovered = true),
            onExit: (_) => setState(() => _hovered = false),
            child: GestureDetector(
              onTap: widget.onPressed,
              child: Container(
                // Full width, so it reads as the section's one action rather than as a wider row.
                width: double.infinity,
                alignment: Alignment.center,
                padding: const EdgeInsets.symmetric(vertical: 8),
                decoration: BoxDecoration(
                  color: _hovered ? AppColors.selected : Colors.transparent,
                  border: Border.all(color: AppColors.border),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  'Open Grid',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w500,
                    color: _hovered ? AppColors.text : AppColors.textSoft,
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// One row's meaning: a grid model, the engine's own login, or the action that starts a local
/// model. A sealed set rather than a nullable `GridModel`, because `null` already means "the menu
/// was dismissed" in `showMenu`'s own result — and the action is neither a model nor a login, so
/// it carries its own flag rather than borrowing `model == null` from the login row.
class _Choice {
  final GridModel? model;
  final bool runLocalModel;
  const _Choice.model(GridModel this.model) : runLocalModel = false;
  const _Choice.ownLogin() : model = null, runLocalModel = false;
  const _Choice.runLocalModel() : model = null, runLocalModel = true;
}
