import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'window_chrome.dart';

import '../core/models.dart';
import '../shared/layouts/widgets/sidebar_item.dart';
import '../shared/layouts/widgets/sidebar_timeline.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_icon_button.dart';
import '../shared/widgets/app_menu.dart';
import '../shared/widgets/skeleton.dart';
import '../shortcuts/app_shortcuts.dart';
import '../state/app_state.dart';
import 'agent_drag.dart';
import 'rename_agent_dialog.dart';
import 'account_footer.dart';
import 'device_row.dart';
import 'engine_identity.dart';
import 'link_machine_dialog.dart';
import 'new_agent_dialog.dart';

/// The machine caption's type.
///
/// A function rather than a constant so its skeleton can borrow the exact
/// metrics: `skeleton_sites_test.dart` measures a placeholder machine row
/// against a real one, and a caption whose type drifts from its placeholder
/// makes the rail resize the moment the list lands.
TextStyle _machineCaptionStyle(Color color) => TextStyle(
  color: color,
  fontFamily: grid.AppFont.sans,
  fontSize: 11,
  fontWeight: grid.AppFont.semibold,
  letterSpacing: 0.3,
);

/// The caption's own box: 18px mark at the rail's gutter, 22px of line, and
/// symmetric padding so the mark lands on [SidebarTimeline]'s trunk break.
/// Shared with the placeholder for the same reason as the type above.
const EdgeInsets _machineCaptionPadding = EdgeInsets.fromLTRB(10, 7, 6, 7);
const double _machineCaptionHeight = 22;
const double _machineMarkSize = 18;

class MachineRail extends StatefulWidget {
  final AppNotifier notifier;

  /// Fold the rail away. Null hides the control — a button that collapses
  /// nothing is worse than no button.
  final VoidCallback? onCollapse;

  const MachineRail({super.key, required this.notifier, this.onCollapse});

  @override
  State<MachineRail> createState() => _MachineRailState();
}

class _MachineRailState extends State<MachineRail> {
  /// The node that holds the keyboard while the cursor is in the rail.
  ///
  /// A real Flutter focus node rather than a flag the rail reads, because focus
  /// is EXCLUSIVE: taking it here is what makes the terminal let go, and that is
  /// the whole reason plain `j` and `k` can mean something in this column while
  /// they are ordinary characters two pixels to the right.
  final FocusNode _railFocus = FocusNode(debugLabel: 'rail');

  @override
  void dispose() {
    _railFocus.dispose();
    super.dispose();
  }

  /// The keys the rail answers while it holds them.
  ///
  /// PLAIN LETTERS, no ⌘. Everywhere else in this app a bare key belongs to the
  /// terminal (see app_shortcuts.dart's header), and that rule is exactly why it
  /// can be broken here: the rail is not a pty, and while it has focus no shell
  /// is waiting for anything. This is the one surface where vim's own keys can
  /// be vim's own keys.
  KeyEventResult _onRailKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    final notifier = widget.notifier;
    final key = event.logicalKey;

    // BARE KEYS ONLY. `h` and `l` mean two different things two pixels apart:
    // plain, they are the rail's own — close this machine, open this agent —
    // and with ⌘ they are the window's ring, which seats the rail between the
    // last tile and the first. Without this guard the rail swallows ⌘h and the
    // ring has no way out of the sidebar.
    if (HardwareKeyboard.instance.isMetaPressed ||
        HardwareKeyboard.instance.isControlPressed ||
        HardwareKeyboard.instance.isAltPressed) {
      return KeyEventResult.ignored;
    }

    if (key == LogicalKeyboardKey.keyJ || key == LogicalKeyboardKey.arrowDown) {
      notifier.moveRailCursor(1);
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.keyK || key == LogicalKeyboardKey.arrowUp) {
      notifier.moveRailCursor(-1);
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.keyH || key == LogicalKeyboardKey.arrowLeft) {
      notifier.railCollapseOrExit();
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.keyL ||
        key == LogicalKeyboardKey.arrowRight ||
        key == LogicalKeyboardKey.enter ||
        key == LogicalKeyboardKey.numpadEnter ||
        key == LogicalKeyboardKey.space) {
      unawaited(notifier.activateRailRow());
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.escape) {
      notifier.unfocusRail();
      return KeyEventResult.handled;
    }
    // Everything else — including ⌘ chords — goes up to the app's own bindings,
    // so ⌘P and ⌘N still work with the cursor parked in here.
    return KeyEventResult.ignored;
  }

  /// The wordmark strip. The same 46px the terminal panes draw, so the
  /// wordmark and a pane's title sit on one baseline.
  static const _headerHeight = 46.0;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    // No fill here. The fold above draws one surface under whichever rail is
    // showing: during the crossfade both are mounted, and two translucent fills
    // stacked over the window would darken the whole rail for the length of the
    // animation.
    return ListenableBuilder(
      listenable: widget.notifier,
      builder: (context, _) {
        // Requested during the build that turns it on, not from the handler that
        // set the flag: the node has to be mounted to take focus, and on the
        // first ⌘h of a session the rail may have only just been laid out.
        if (widget.notifier.railFocused && !_railFocus.hasFocus) {
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (mounted && widget.notifier.railFocused) {
              _railFocus.requestFocus();
            }
          });
        }
        // Keep the current computer immediately reachable while preserving
        // the backend order for every other machine.
        final machines = <Machine>[
          ...widget.notifier.machines.where(
            (machine) =>
                widget.notifier.stateOf(machine.machineId)?.isLocalMachine ==
                true,
          ),
          ...widget.notifier.machines.where(
            (machine) =>
                widget.notifier.stateOf(machine.machineId)?.isLocalMachine !=
                true,
          ),
        ];
        return Focus(
          focusNode: _railFocus,
          onKeyEvent: _onRailKey,
          // Losing focus to a click in a terminal must put the cursor away too,
          // or the rail keeps a highlight that no key will move.
          onFocusChange: (has) {
            if (!has && widget.notifier.railFocused) {
              widget.notifier.unfocusRail();
            }
          },
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // The rail's head is a TOOLBAR, and it is built to look like one:
              // its own surface and its own bottom edge.
              //
              // It used to be a wordmark and three glyphs on the same fill as the
              // list, with no edge under them — so "Harness" read as the first
              // entry in the rail rather than as the thing above the entries, and
              // the three buttons bunched into the right corner 2px apart.
              //
              // [grid.AppSurface.recess] over the rail's own fill, not a colour
              // of its own: it is an overlay, so it separates in BOTH themes —
              // lighter than the charcoal rail in dark, a touch greyer than the
              // near-white one in light, the way a Finder toolbar sits over its
              // list.
              DecoratedBox(
                decoration: BoxDecoration(
                  color: grid.AppSurface.recess,
                  border: Border(
                    bottom: BorderSide(color: grid.AppPalette.divider),
                  ),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    // Still the window's drag handle — the title bar is hidden,
                    // see configureDesktopWindow. `WindowDragArea` rather than
                    // window_manager's own `DragToMoveArea`: main introduced one
                    // for the whole app when `HarnessTopBar` took over the
                    // traffic-light row, and two ways to drag the same window is
                    // one too many.
                    //
                    // No top inset for the traffic lights here — that bar sits
                    // above the window now, and an inset would push the wordmark
                    // down twice.
                    WindowDragArea(
                      child: SizedBox(
                        height: _headerHeight,
                        child: Padding(
                          // 16 left against 8 right, so the wordmark's stem and
                          // the last button's CENTRE both land 20px from their
                          // own edge. Matching the two paddings instead would
                          // push the buttons visibly further in than the text.
                          padding: const EdgeInsets.fromLTRB(16, 0, 8, 0),
                          child: Row(
                            children: [
                              Expanded(
                                child: Text(
                                  'Harness',
                                  style: TextStyle(
                                    color: grid.AppPalette.textPrimary,
                                    fontSize: 16,
                                    // Semibold, not bold. A wordmark at this size
                                    // already out-ranks everything below it.
                                    fontWeight: grid.AppFont.semibold,
                                    letterSpacing: -0.1,
                                  ),
                                ),
                              ),
                              AppIconButton(
                                icon: LucideIcons.refreshCw300,
                                size: 17,
                                // A step up from the default resting ink. At
                                // textSecondary these two hairline glyphs read as
                                // half-loaded next to a semibold wordmark.
                                color: grid.AppPalette.textPrimary.withValues(
                                  alpha: 0.72,
                                ),
                                tooltip: withShortcutHint(
                                  'Reload machines',
                                  ShortcutAction.reload,
                                ),
                                // The glyph turns for as long as the reload runs
                                // and the button refuses presses meanwhile — a
                                // reload is a REST call plus an `agents_list` per
                                // open machine, long enough that a button which
                                // just sat there read as not having registered
                                // the click.
                                spinning: widget.notifier.machinesRefreshing,
                                onPressed: () =>
                                    unawaited(widget.notifier.retryMachines()),
                              ),
                              if (widget.onCollapse != null) ...[
                                // 6, not 2. Two glyphs a hair apart read as one
                                // smudge; this is the smallest gap that still
                                // says "two buttons".
                                const SizedBox(width: 6),
                                AppIconButton(
                                  icon: LucideIcons.panelLeft300,
                                  size: 17,
                                  color: grid.AppPalette.textPrimary.withValues(
                                    alpha: 0.72,
                                  ),
                                  tooltip: withShortcutHint(
                                    'Collapse sidebar',
                                    ShortcutAction.toggleRail,
                                  ),
                                  onPressed: widget.onCollapse!,
                                ),
                              ],
                            ],
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              Expanded(
                child: machines.isEmpty
                    // Two kinds of empty, and they must not look the same: the
                    // list has not answered yet, or it answered with nothing.
                    ? widget.notifier.machinesLoading
                          ? const _MachineListSkeleton(
                              key: ValueKey('machines-loading'),
                            )
                          : Center(
                              child: Text(
                                'no remote machines',
                                style: TextStyle(
                                  color: grid.AppPalette.textFaint,
                                  fontFamily: grid.AppFont.sans,
                                  fontSize: 13.5,
                                ),
                              ),
                            )
                    : ListView.builder(
                        itemCount: machines.length,
                        itemBuilder: (context, index) => _MachineNode(
                          notifier: widget.notifier,
                          machine: machines[index],
                          isFirst: index == 0,
                        ),
                      ),
              ),
              // The dial's row stands on the rail's floor, above the account. It is
              // not a setting, it is a thing on the desk — present, absent, or on its
              // way — and the one place someone without one is told where to get one.
              DeviceRow(notifier: widget.notifier),
              AccountFooter(notifier: widget.notifier),
            ],
          ),
        );
      },
    );
  }
}

/// A machine's actions, revealed on hover: `⋯` first, then `+` to its right.
///
/// Both hide at rest, so a rail full of machines is a list of hostnames rather
/// than a column of buttons — and the hostname, which is the part you read, has
/// the whole row until you reach for something.
///
/// The `+` sits at the far right, nearest the rail's edge and furthest from the
/// name: it is the one you press, so it gets the end of the row where the hand
/// is already travelling, with the housekeeping menu tucked behind it.
///
/// Two things move at once, deliberately on one curve. The pair FADES up and
/// slides in a few pixels from the right, so it reads as arriving from off the
/// row's edge rather than blinking into place. And the row makes room as it
/// comes: [Align.widthFactor] runs 0 → 1, so the hostname shortens under the
/// buttons instead of the buttons landing on a name that never moved.
///
/// A slot held permanently open would avoid that reflow, but it costs every row
/// in the rail ~50px of nothing for the sake of the one row under the pointer —
/// and the hostname is exactly the thing that was running out of width.
class _CaptionActions extends StatelessWidget {
  const _CaptionActions({
    required this.shown,
    required this.onNewAgent,
    required this.menu,
  });

  /// Whether the pointer is on the row — or the menu it opened is still up,
  /// which is the case a plain hover test gets wrong: the pointer has left the
  /// row for the panel, and the button the panel hangs off must not vanish
  /// under it.
  final bool shown;

  final VoidCallback onNewAgent;

  /// The ⋯ and its panel, built by the caller because the menu's controller and
  /// its open/close state belong to the row, not to this animation.
  final Widget menu;

  /// How far the pair drifts in from the right. A hint, not a journey: enough
  /// to read as movement, short enough that the two buttons never separate.
  static const double _drift = 10;

  @override
  Widget build(BuildContext context) => TweenAnimationBuilder<double>(
    // No `begin`: a row built already hovered is settled, not animating in.
    tween: Tween(end: shown ? 1.0 : 0.0),
    duration: grid.AppMotion.hover,
    curve: grid.AppMotion.curve,
    builder: (context, t, child) => ClipRect(
      child: Align(
        // Pinned right, so the pair grows out of the row's edge rather than
        // sliding along it — and clipped, so nothing is clickable while it is
        // still folded away.
        alignment: Alignment.centerRight,
        widthFactor: t,
        child: Opacity(
          opacity: t,
          child: Transform.translate(
            offset: Offset((1 - t) * _drift, 0),
            child: child,
          ),
        ),
      ),
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        menu,
        const SizedBox(width: 2),
        AppIconButton(
          icon: LucideIcons.plus300,
          size: 16,
          tooltip: 'New agent here…',
          onPressed: onNewAgent,
        ),
      ],
    ),
  );
}

class _MachineNode extends StatefulWidget {
  /// Whether the guide line arrives from a row above. False on the first
  /// machine, where a line dangling up towards the New agent button would point
  /// at nothing.
  final bool isFirst;

  final AppNotifier notifier;
  final Machine machine;

  const _MachineNode({
    required this.notifier,
    required this.machine,
    required this.isFirst,
  });

  @override
  State<_MachineNode> createState() => _MachineNodeState();
}

class _MachineNodeState extends State<_MachineNode> {
  final MenuController _machineMenu = MenuController();
  bool _menuOpen = false;
  bool _hovered = false;

  AppNotifier get notifier => widget.notifier;
  Machine get machine => widget.machine;

  Future<void> _showRenameDialog() async {
    final controller = TextEditingController(text: machine.displayName);
    String? error;
    await showAppDialog<void>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setDialogState) => AlertDialog(
          title: const Text('Edit name'),
          content: SizedBox(
            width: 360,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                TextField(
                  controller: controller,
                  autofocus: true,
                  style: grid.kFieldTextStyle,
                  onSubmitted: (_) async {
                    final result = await notifier.renameMachine(
                      machine.machineId,
                      controller.text,
                    );
                    if (result == null) {
                      if (dialogContext.mounted) {
                        Navigator.of(dialogContext).pop();
                      }
                    } else {
                      setDialogState(() => error = result);
                    }
                  },
                ),
                if (error != null) ...[
                  const SizedBox(height: 10),
                  Text(
                    error!,
                    style: TextStyle(
                      color: grid.AppPalette.dangerFill,
                      fontFamily: grid.AppFont.sans,
                      fontSize: 11.2,
                    ),
                  ),
                ],
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () async {
                final result = await notifier.renameMachine(
                  machine.machineId,
                  controller.text,
                );
                if (result == null) {
                  if (dialogContext.mounted) Navigator.of(dialogContext).pop();
                } else {
                  setDialogState(() => error = result);
                }
              },
              child: const Text('Save'),
            ),
          ],
        ),
      ),
    );
    controller.dispose();
  }

  Future<void> _confirmDeleteMachine() async {
    final confirmed = await showAppDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Delete machine'),
        content: SizedBox(
          width: 360,
          child: Text(
            'Delete "${machine.displayName}"? All its agents will be disconnected and '
            "it'll need to be linked again. This can't be undone.",
            style: TextStyle(fontFamily: grid.AppFont.sans, fontSize: 13.5),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: grid.AppPalette.dangerFill,
            ),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    final error = await notifier.deleteMachine(machine.machineId);
    if (error != null && mounted) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error)));
    }
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final expanded = notifier.expandedMachines.contains(machine.machineId);
    final state = notifier.stateOf(machine.machineId)!;
    // The relay's local WS session can stay `connected` for a beat after the backend has already
    // reported the underlying node offline (two independently-polled signals) — never show green here
    // while the offline-guide panel is (or is about to be) blocking the same machine.
    final connectionColor = state.nodeOnline == false
        ? grid.AppPalette.textFaint
        : state.needsLink
        // Unlinked, our socket never reaches this machine: NO_PEER_LINK is the
        // local CLI's own peer table saying no, before anything is dialled, and
        // the link-retry loop then bounces connecting/disconnected every few
        // seconds — none of which is a fact about the other computer. Only the
        // REST status is, so green needs an explicit `true` from it; unknown
        // stays grey rather than promising a machine that may be off. Offline,
        // above, still wins.
        ? (state.nodeOnline == true
              ? grid.AppPalette.online
              : grid.AppPalette.textFaint)
        : switch (state.connectionStatus) {
            ConnectionStatus.connected => grid.AppPalette.online,
            ConnectionStatus.connecting ||
            ConnectionStatus.reconnecting => grid.AppPalette.warn,
            ConnectionStatus.disconnected => grid.AppPalette.textFaint,
          };
    // One clock for the whole node, and it has to be one: the trunk under the
    // caption, the agent count beside the name and the rows themselves all
    // change at the moment the machine opens. Run on three timers they arrive
    // in three stages 30ms apart and the row reads as sluggish even though
    // nothing is slow.
    //
    // No `begin` on the tween: a rail that mounts with this machine already
    // open is *settled*, not unfolding itself while the user watches.
    //
    // Leaving is the shorter half — the user has already decided to close it,
    // and waiting on the rows to go is what makes a fold feel heavy.
    return TweenAnimationBuilder<double>(
      tween: Tween(end: expanded ? 1.0 : 0.0),
      duration: MediaQuery.disableAnimationsOf(context)
          ? Duration.zero
          : expanded
          ? grid.AppMotion.fold
          : grid.AppMotion.swap,
      curve: grid.AppMotion.curve,
      // Hoisted so the rows are not rebuilt on every frame of the fold. Built
      // here but only *mounted* below while `fold > 0`, so a closed machine
      // costs nothing.
      child: _AgentTree(notifier: notifier, state: state),
      builder: (context, fold, tree) =>
          _node(context, fold, tree!, state, connectionColor),
    );
  }

  Widget _node(
    BuildContext context,
    double fold,
    Widget tree,
    MachineState state,
    Color connectionColor,
  ) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // The machine is a CAPTION over its agents, not a row among them.
        //
        // Quiet micro-type is what makes that read at a glance: the eye sorts
        // the rail into "things I open" and "labels saying where they live"
        // without having to decode the indent alone. It used to be a full
        // SidebarItem, which gave a machine exactly the weight, the height and
        // the hover of the agents under it.
        //
        // Not upper-cased, though the type is sized for it: a hostname is 26
        // characters of shouting by the time it reaches the ellipsis, and the
        // case of `MacBooks-MacBook-Pro.local` is information.
        //
        // It is still a NODE on the guide line, and that is why the glyph sits
        // on [SidebarTimeline]'s trunk with nothing in front of it: the line
        // runs THROUGH the mark it breaks around, so anything to its left
        // pushes the mark off the line. Which is also why there is no chevron —
        // the trunk carrying on down into the agents already says the machine
        // is open, and says it better than a glyph pointing at itself.
        SidebarTimeline(
          role: SidebarTimelineRole.node,
          above: !widget.isFirst,
          // While the rows are on their way out too: a trunk that vanished at
          // frame one would leave them hanging off nothing.
          below: fold > 0 && state.agents.isNotEmpty,
          child: MouseRegion(
            onEnter: (_) => setState(() => _hovered = true),
            onExit: (_) => setState(() => _hovered = false),
            child: GestureDetector(
              behavior: HitTestBehavior.translucent,
              // Same menu the ⋯ opens — one shape for one set of actions.
              onSecondaryTap: _machineMenu.open,
              onTap: () => notifier.toggleExpand(machine.machineId),
              child: _RailCursor(
                on:
                    notifier.railFocused &&
                    notifier.railRowAt(notifier.railCursor) ==
                        RailRow(machineId: machine.machineId),
                child: Padding(
                  key: ValueKey('machine-row-${machine.machineId}'),
                  // Symmetric top and bottom on purpose: [TimelineGuide] breaks
                  // the trunk around the middle of the band it is given, so an
                  // off-centre glyph would sit beside the gap left for it.
                  padding: _machineCaptionPadding,
                  child: SizedBox(
                    height: _machineCaptionHeight,
                    child: Row(
                      children: [
                        // 18px at the rail's 10px gutter puts this glyph's centre
                        // at x=19, which is exactly where SidebarTimeline runs
                        // its trunk. Change either and they part company.
                        Semantics(
                          label: state.isLocalMachine
                              ? 'This computer'
                              : 'Remote machine',
                          child: SizedBox(
                            width: _machineMarkSize,
                            height: _machineMarkSize,
                            child: Icon(
                              state.isLocalMachine
                                  ? LucideIcons.laptopMinimal300
                                  : LucideIcons.network300,
                              key: const ValueKey('machine-connection-icon'),
                              size: _machineMarkSize,
                              color: connectionColor,
                            ),
                          ),
                        ),
                        // The same 10px SidebarItem puts between its own icon and
                        // label, so the caption and the agents under it start in
                        // one column.
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(
                            machine.displayName,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: _machineCaptionStyle(
                              _hovered
                                  ? grid.AppPalette.textSecondary
                                  : grid.AppPalette.textFaint,
                            ),
                          ),
                        ),
                        // A computer that is not answering, said once, where the
                        // computer is named. It replaces two lines of red further
                        // down: a machine being off is a STATE, and red is for
                        // something that went wrong. Mutually exclusive with the
                        // link affordance below: a daemon that is not running
                        // cannot shake hands, so offline still wins (see
                        // _AgentTree's own "OFFLINE WINS").
                        if (state.nodeOnline == false)
                          const _OfflineWord()
                        else if (state.needsLink)
                          // Not known to be off, and never linked with this app
                          // instance — the one click that fixes it, ALWAYS
                          // visible rather than hidden behind hover like
                          // _CaptionActions: that was the whole reason an
                          // unlinked-but-alive machine read as unreachable in
                          // the first place. Same gate as _LinkMachineRow.
                          Padding(
                            padding: const EdgeInsets.only(left: 6),
                            child: AppIconButton(
                              key: const ValueKey('machine-link-affordance'),
                              icon: LucideIcons.link2300,
                              size: 13,
                              color: grid.AppPalette.accentOnSurface,
                              hoverColor: grid.AppPalette.accentOnSurface,
                              tooltip: 'Link this machine…',
                              onPressed: () => notifier.selectMachineForSetup(
                                machine.machineId,
                              ),
                            ),
                          ),
                        // How many agents are inside something you have closed.
                        // Only when closed: with the list open you can count
                        // them, and a number beside a list you can see is noise.
                        if (fold < 1 && state.agents.isNotEmpty)
                          // Width as well as opacity, so the name beside it
                          // lengthens into the space the number gives up rather
                          // than snapping wider the instant the fold starts.
                          Align(
                            alignment: Alignment.centerLeft,
                            widthFactor: 1 - fold,
                            child: Opacity(
                              opacity: 1 - fold,
                              child: Padding(
                                padding: const EdgeInsets.only(left: 6),
                                child: Text(
                                  '${state.agents.length}',
                                  style: TextStyle(
                                    color: grid.AppPalette.textFaint,
                                    fontFamily: grid.AppFont.sans,
                                    fontSize: 11,
                                    fontFeatures: const [
                                      FontFeature.tabularFigures(),
                                    ],
                                  ),
                                ),
                              ),
                            ),
                          ),
                        // Both of this machine's actions, on this machine's own
                        // row. The `+` is what the rail's big New agent button
                        // used to be: that button had to guess which machine you
                        // meant, and this one cannot be wrong about it.
                        _CaptionActions(
                          shown: _hovered || _menuOpen,
                          onNewAgent: () => showNewAgentDialog(
                            context,
                            notifier,
                            machine.machineId,
                            source: 'machine_row',
                          ),
                          menu: MenuAnchor(
                            controller: _machineMenu,
                            onOpen: () => setState(() => _menuOpen = true),
                            onClose: () => setState(() => _menuOpen = false),
                            menuChildren: [
                              // Where the empty state's refresh went. It used to hang off a status line
                              // that only existed while a machine had no agents, so the one machine you
                              // could not reload was a machine whose list had gone stale WITH agents in
                              // it. A per-machine action belongs with the machine's other ones.
                              AppMenuItem(
                                icon: LucideIcons.refreshCw300,
                                label: 'Reload agents',
                                onPressed: () {
                                  _machineMenu.close();
                                  notifier.reloadMachineData(machine.machineId);
                                },
                              ),
                              AppMenuItem(
                                icon: LucideIcons.pencil300,
                                label: 'Edit name',
                                onPressed: () {
                                  _machineMenu.close();
                                  _showRenameDialog();
                                },
                              ),
                              if (state.isLocalMachine) ...[
                                const AppMenuDivider(),
                                AppMenuItem(
                                  icon: LucideIcons.keyRound300,
                                  label: 'Set remote password',
                                  onPressed: () {
                                    _machineMenu.close();
                                    unawaited(
                                      showLinkMachineDialog(context, notifier),
                                    );
                                  },
                                ),
                              ],
                              if (!state.isLocalMachine) ...[
                                const AppMenuDivider(),
                                AppMenuItem(
                                  icon: LucideIcons.link2300,
                                  label: 'Remote into this machine…',
                                  onPressed: () {
                                    _machineMenu.close();
                                    notifier.selectMachineForSetup(
                                      machine.machineId,
                                    );
                                  },
                                ),
                                const AppMenuDivider(),
                                AppMenuItem(
                                  icon: LucideIcons.trash2300,
                                  label: 'Delete machine',
                                  danger: true,
                                  onPressed: () {
                                    _machineMenu.close();
                                    _confirmDeleteMachine();
                                  },
                                ),
                              ],
                            ],
                            builder: (context, controller, child) =>
                                AppIconButton(
                                  icon: LucideIcons.ellipsis300,
                                  size: 16,
                                  tooltip: 'Machine options',
                                  onPressed: () => controller.isOpen
                                      ? controller.close()
                                      : controller.open(),
                                ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
        if (fold > 0)
          // Clipped, not re-laid out. The rows keep their full height and the
          // box in front of them grows — laying the list out again at every
          // height in between would be a dozen frames of rows reflowing, and it
          // would look like it.
          ClipRect(
            child: Align(
              alignment: Alignment.topLeft,
              heightFactor: fold,
              // `Align` hands its child loose constraints, which would drop the
              // stretch this Column gives everything else and let the rows
              // shrink-wrap mid-fold. This puts the width back.
              child: SizedBox(width: double.infinity, child: tree),
            ),
          ),
      ],
    );
  }
}

class _AgentTree extends StatelessWidget {
  final AppNotifier notifier;
  final MachineState state;

  const _AgentTree({required this.notifier, required this.state});

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    if (state.agents.isEmpty) {
      switch (state.agentLoadStatus) {
        case AgentLoadStatus.idle:
          return _AgentStatusRow(
            icon: Icons.sync,
            label: state.connectionStatus == ConnectionStatus.connected
                ? 'preparing agent list…'
                : 'connecting…',
          );
        case AgentLoadStatus.needsLink:
          // OFFLINE WINS. Linking is a PAKE handshake with the daemon on the
          // other computer, and a daemon that is not running cannot shake
          // hands — so a machine that is both unlinked and offline gets the
          // offline note, not an invitation to do the impossible. The retry
          // poll that already runs for an unlinked machine turns this into the
          // link row by itself once the computer comes back.
          if (state.nodeOnline == false) {
            return _MachineOfflineNote(state: state, linkPending: true);
          }
          return _LinkMachineRow(notifier: notifier, state: state);
        case AgentLoadStatus.loading:
          // Rows, not a sentence: "loading agents…" is one line tall, so
          // everything under the machine dropped when the real rows arrived.
          return const _AgentRowsSkeleton(key: ValueKey('agents-loading'));
        case AgentLoadStatus.error:
          // A machine with no agents AND no connection fails HERE, not on the
          // branch below — that one only runs once some agents are known. This
          // is the path the rail actually took for an offline computer, and the
          // reason the red block outlived the first attempt to replace it.
          if (state.nodeOnline == false) {
            return _MachineOfflineNote(state: state);
          }
          return _AgentLoadError(notifier: notifier, state: state);
        case AgentLoadStatus.loaded:
          return _EmptyAgents(notifier: notifier, state: state);
      }
    }

    final byParent = <String?, List<Agent>>{};
    final ids = state.agents.map((agent) => agent.id).toSet();
    for (final agent in state.agents) {
      final parent = ids.contains(agent.parentAgentId)
          ? agent.parentAgentId
          : null;
      byParent.putIfAbsent(parent, () => []).add(agent);
    }
    final visible = state.agents.map((agent) => agent.id).toSet();

    final rows = <Widget>[
      for (final root in byParent[null] ?? const <Agent>[])
        ..._rows(root, byParent, visible, 0, <String>{}),
      // …and the invitation, last, as a row of the same list. Adding an agent to a machine that already
      // has some was reachable only through a `+` revealed on hover of the machine's caption — a control
      // nobody finds who does not already know it. Put where a new row would actually appear, it needs no
      // discovering. It joins `rows` rather than being appended after the loop so the guide's trunk runs
      // down to it and closes there, exactly as it would on a real last agent.
      _NewAgentRow(
        notifier: notifier,
        machineId: state.machine.machineId,
        source: 'rail_tail',
      ),
    ];

    return Column(
      children: [
        if (state.agentsRefreshing) const LinearProgressIndicator(minHeight: 1),
        // The guide arm reaches out to each agent from the trunk running down
        // through its machine's mark. `below` closes the line on the last row:
        // a trunk carrying on past the end would point at whatever section
        // happens to follow, which is not part of this tree.
        for (var i = 0; i < rows.length; i++)
          SidebarTimeline(
            role: SidebarTimelineRole.branch,
            below: i < rows.length - 1,
            child: rows[i],
          ),
        // Only while the machine can answer — see the empty-tree branch. An
        // offline machine already shows its note below.
        if (state.agentLoadStatus == AgentLoadStatus.needsLink &&
            state.nodeOnline != false)
          _LinkMachineRow(notifier: notifier, state: state),
        // OFFLINE IS NOT AN ERROR, so it does not get the error's treatment.
        //
        // The red row told an app user to "run harness start on that machine" —
        // an instruction for a terminal, given to somebody who opened a window,
        // about a computer they may not be sitting at. The chip on the row above
        // already says the machine is off; this says why its agents are missing,
        // in the rail's ordinary grey, once.
        if (state.nodeOnline == false)
          _MachineOfflineNote(state: state)
        else if (state.agentsLoadError != null)
          _AgentLoadError(notifier: notifier, state: state),
        if (state.terminalCapabilityLoaded &&
            !state.terminalCapabilityAvailable)
          Padding(
            padding: const EdgeInsets.fromLTRB(38, 2, 12, 8),
            child: Text(
              state.terminalCapabilityError ?? 'terminal unavailable',
              style: TextStyle(
                color: grid.AppPalette.dangerFill,
                fontFamily: grid.AppFont.sans,
                fontSize: 11.2,
              ),
            ),
          ),
      ],
    );
  }

  List<Widget> _rows(
    Agent agent,
    Map<String?, List<Agent>> byParent,
    Set<String> visible,
    int depth,
    Set<String> ancestors,
  ) {
    if (ancestors.contains(agent.id)) return const [];
    final children = byParent[agent.id] ?? const <Agent>[];
    final descendantVisible = children.any(
      (child) => visible.contains(child.id),
    );
    if (!visible.contains(agent.id) && !descendantVisible) return const [];
    final nextAncestors = {...ancestors, agent.id};
    return [
      _AgentRow(
        notifier: notifier,
        state: state,
        agent: agent,
        depth: depth,
        hasChildren: children.isNotEmpty,
      ),
      for (final child in children)
        ..._rows(child, byParent, visible, depth + 1, nextAncestors),
    ];
  }
}

/// The keyboard's place in the rail, drawn as a rim rather than a fill.
///
/// A FILL would compete with `selected`, which the rail already spends on "this
/// agent is the one the window is looking at" — two different facts that are
/// true at different times, and shading both would make the column ambiguous in
/// exactly the state where it has to be clear: cursor on one row, selection on
/// another.
///
/// It also only ever shows while the rail HOLDS the keyboard. A cursor left
/// behind on a column nobody is driving is a highlight that no key will move,
/// which reads as the app having lost track of itself.
class _RailCursor extends StatelessWidget {
  const _RailCursor({required this.on, required this.child});

  final bool on;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    if (!on) return child;
    grid.AppTheme.watch(context);
    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(7),
        border: Border.all(color: grid.AppPalette.accentOnSurface, width: 1),
      ),
      child: child,
    );
  }
}

class _AgentRow extends StatefulWidget {
  final AppNotifier notifier;
  final MachineState state;
  final Agent agent;
  final int depth;
  final bool hasChildren;

  const _AgentRow({
    required this.notifier,
    required this.state,
    required this.agent,
    required this.depth,
    required this.hasChildren,
  });

  @override
  State<_AgentRow> createState() => _AgentRowState();
}

class _AgentRowState extends State<_AgentRow> {
  final MenuController _agentMenu = MenuController();
  bool _menuOpen = false;

  AppNotifier get notifier => widget.notifier;
  MachineState get state => widget.state;
  Agent get agent => widget.agent;
  int get depth => widget.depth;
  bool get hasChildren => widget.hasChildren;

  /// The row's own way into the shared dialog — see rename_agent_dialog.dart.
  Future<void> _showRenameDialog() => showAgentRenameDialog(
    context,
    notifier,
    state.machine.machineId,
    agent.id,
    agent.name,
  );

  Future<void> _confirmDelete() async {
    final confirmed = await showAppDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Delete agent'),
        content: SizedBox(
          width: 360,
          child: Text(
            "Delete “${agent.name}”? This can't be undone.",
            style: TextStyle(fontFamily: grid.AppFont.sans, fontSize: 13.5),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: grid.AppPalette.dangerFill,
            ),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    final error = await notifier.deleteAgent(state.machine.machineId, agent.id);
    if (error != null && mounted) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error)));
    }
  }

  // Restart is disruptive (it briefly kills the current process) but NOT destructive — the same
  // agent survives, resumed where possible — so unlike delete it fires straight away, no
  // confirmation dialog, and just surfaces a failure the same lightweight way.
  Future<void> _restartAgent() async {
    final result = await notifier.restartAgent(
      state.machine.machineId,
      agent.id,
    );
    if (!mounted) return;
    final error = result.error;
    if (error != null) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error)));
      return;
    }
    if (!result.resumed) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'Restarted with a new session — the previous one could not be resumed.',
          ),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final machineId = state.machine.machineId;
    // Two different facts, and the grid is why they had to separate. "Selected"
    // used to be the only terminal there was. Now a row can be on screen in a
    // tile the keyboard is not in — still worth showing, but not as the current
    // one, or four rows would claim to be current at once.
    final focusedHere =
        notifier.focusedPane?.machineId == machineId &&
        notifier.focusedPane?.agentId == agent.id;
    final inAnotherPane =
        !focusedHere && notifier.isAgentInPane(machineId, agent.id);
    final selected = focusedHere;
    // Cached agents remain selectable while the adapter is offline so the
    // user gets the actionable `harness login` guide instead of a dead row.
    final offlineSelectable =
        state.nodeOnline == false && agent.terminalAvailable;
    final enabled =
        offlineSelectable ||
        // `connected` never arrives until the local CLI has finished terminating E2EE for this
        // machine (or confirmed none is needed, for its own) — no separate readiness check left.
        state.connectionStatus == ConnectionStatus.connected &&
            state.terminalCapabilityAvailable &&
            agent.terminalAvailable;
    // A cached agent under an offline machine stays clickable (`offlineSelectable`, above) so the
    // login guide is reachable — but it should still LOOK offline, not bright/normal. Decouple the
    // visual state from `enabled` (which only governs tap-ability) so the row dims whenever the
    // machine itself is offline, regardless of whether it's still selectable.
    final visuallyEnabled = enabled && state.nodeOnline != false;
    final reason = !agent.terminalAvailable
        ? agent.terminalUnavailableReason
        : offlineSelectable
        ? 'Harness is offline — run harness login'
        : !state.terminalCapabilityAvailable
        ? state.terminalCapabilityError
        : null;
    final identity = engineIdentity(
      agent.engine,
      displayName: agent.engineDisplayName,
    );
    final processing = state.processingAgentIds.contains(agent.id);
    // Right-click wraps the row rather than fighting it: SidebarItem owns the
    // primary tap and the press/hover states that go with it, and exposes no
    // secondary gesture.
    final row = GestureDetector(
      behavior: HitTestBehavior.translucent,
      // Right-click opens the SAME menu the ⋯ does. Two menus carrying the same
      // two actions in two different shapes is the drift this avoids; the only
      // thing lost is opening at the cursor rather than at the button.
      onSecondaryTap: _agentMenu.open,
      child: Padding(
        // 28px is where a nested row's box starts, which is what the guide's
        // arm is drawn to reach (trunk at 19, arm 7 long, stopping 2px short of
        // the row's own hover fill). Without it the agents line up under the
        // machine's own mark and the arm points at nothing. Sub-agents step in
        // further from there.
        padding: EdgeInsets.only(left: 28 + depth * 14.0),
        child: _RailCursor(
          on:
              notifier.railFocused &&
              notifier.railRowAt(notifier.railCursor) ==
                  RailRow(
                    machineId: state.machine.machineId,
                    agentId: agent.id,
                  ),
          child: SidebarItem(
            label: agent.name,
            selected: selected,
            enabled: enabled,
            dimmed: !visuallyEnabled,
            // ⌘-click opens a NEW tile, the same meaning it has on a link in
            // every browser. A plain click stays navigation — it replaces the
            // focused tile — because that rule is what keeps four glances at the
            // rail from becoming four terminals. But until this existed, ADDING a
            // tile was only possible by dragging a row onto the grid, so the
            // ceiling of nine was unreachable for anyone who did not know the
            // drag: a cap nobody can climb to is the same as no cap being raised.
            onTap: () {
              final machineId = state.machine.machineId;
              if (HardwareKeyboard.instance.isMetaPressed &&
                  notifier.canAddPane &&
                  notifier.paneOfAgent(machineId, agent.id) == null) {
                unawaited(
                  notifier.assignAgentToPane(null, machineId, agent.id),
                );
                return;
              }
              unawaited(notifier.selectAgent(machineId, agent.id));
            },
            // The same "Edit name" the row's own menu opens — a double click is
            // just the shorter way to it, and the place a hand reaches first.
            onDoubleTap: _showRenameDialog,

            // No tooltip on a row that works. "Claude engine" only repeated what
            // the mark beside it already says, and it followed the pointer down
            // the whole list. A row that CANNOT be used keeps one, because then
            // it carries the reason — which is the only thing here the row
            // itself cannot show.
            tooltip: enabled ? null : (reason ?? 'machine not ready'),
            // The engine's mark in a well, which is what carries the row now
            // that the guide line is gone. A bare 16px logo floating at the head
            // of a flat list left the column no left edge to sit on; the well is
            // a translucent overlay (see [grid.AppSurface.wellFill]) so it keeps
            // its edge on the hovered and the selected row too.
            leading: Container(
              width: 24,
              height: 24,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: grid.AppSurface.wellFill,
                borderRadius: BorderRadius.circular(7),
              ),
              child: SizedBox(
                width: 15,
                height: 15,
                child: Semantics(
                  label: '${identity.label} engine',
                  image: true,
                  child: EngineMark(
                    engine: agent.engine,
                    displayName: agent.engineDisplayName,
                    enabled: visuallyEnabled,
                    size: 15,
                  ),
                ),
              ),
            ),
            // A turn in flight is a FACT about the row, so it goes in the badge
            // slot, which never hides. Reaching for the row must not take away
            // the only sign that it is busy.
            badge: SizedBox(
              width: 16,
              height: 16,
              child: AnimatedSwitcher(
                duration: grid.AppMotion.hover,
                child: processing
                    ? Padding(
                        key: const ValueKey('processing'),
                        padding: const EdgeInsets.all(2),
                        child: CircularProgressIndicator(
                          key: const ValueKey('agent-processing-indicator'),
                          strokeWidth: 1.6,
                          color: grid.AppPalette.online,
                        ),
                      )
                    : inAnotherPane
                    ? Tooltip(
                        key: const ValueKey('in-pane'),
                        message: 'Open in another pane',
                        child: Icon(
                          Icons.crop_square,
                          size: 12,
                          color: grid.AppPalette.textFaint,
                        ),
                      )
                    : const SizedBox.shrink(key: ValueKey('idle')),
              ),
            ),
            // The ⋯ is an ACTION, so it arrives with the pointer — except while
            // its own menu is open, where a button that vanished under the menu
            // it opened would leave the panel pointing at nothing.
            trailingAlwaysVisible: _menuOpen,
            trailing: MenuAnchor(
              controller: _agentMenu,
              onOpen: () => setState(() => _menuOpen = true),
              onClose: () => setState(() => _menuOpen = false),
              menuChildren: [
                AppMenuItem(
                  icon: LucideIcons.pencil300,
                  label: 'Edit name',
                  onPressed: () {
                    _agentMenu.close();
                    _showRenameDialog();
                  },
                ),
                const AppMenuDivider(),
                AppMenuItem(
                  icon: LucideIcons.refreshCw300,
                  label: 'Restart',
                  onPressed: () {
                    _agentMenu.close();
                    _restartAgent();
                  },
                ),
                const AppMenuDivider(),
                AppMenuItem(
                  icon: LucideIcons.trash2300,
                  label: 'Delete',
                  danger: true,
                  onPressed: () {
                    _agentMenu.close();
                    _confirmDelete();
                  },
                ),
              ],
              builder: (context, controller, child) => AppIconButton(
                icon: LucideIcons.ellipsis300,
                size: 16,
                onPressed: () =>
                    controller.isOpen ? controller.close() : controller.open(),
              ),
            ),
          ),
        ),
      ),
    );

    // A row that cannot be opened cannot be dropped either: dragging it would
    // promise a tile that assignAgentToPane would then refuse to fill, and the
    // grid would answer a deliberate gesture with nothing at all.
    if (!enabled) return row;

    return Draggable<AgentDragRef>(
      data: AgentDragRef(
        machineId: machineId,
        agentId: agent.id,
        name: agent.name,
      ),
      // Horizontal only, and the rail is a scrolling list — that is the whole
      // reason. An unrestricted Draggable competes with the list's own vertical
      // drag, so trying to scroll past a row would pick the row up instead. The
      // tiles are to the RIGHT of the rail, so the gesture that means "take
      // this there" is horizontal anyway, and the two never contend.
      affinity: Axis.horizontal,
      dragAnchorStrategy: pointerDragAnchorStrategy,
      onDragStarted: () => agentDrag.value = AgentDragRef(
        machineId: machineId,
        agentId: agent.id,
        name: agent.name,
      ),
      onDragEnd: (_) => agentDrag.value = null,
      onDraggableCanceled: (_, _) => agentDrag.value = null,
      feedback: _DragChip(name: agent.name, engine: agent.engine),
      // The row stays put and dims. Removing it would reflow the list under the
      // pointer mid-drag, moving every other row out from under the place the
      // hand had already aimed at.
      childWhenDragging: Opacity(opacity: 0.4, child: row),
      child: row,
    );
  }
}

/// What travels with the pointer: enough to recognise the row it came from,
/// small enough not to cover the tile being aimed at.
class _DragChip extends StatelessWidget {
  const _DragChip({required this.name, required this.engine});

  final String name;
  final String? engine;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Material(
      color: Colors.transparent,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
        decoration: BoxDecoration(
          color: grid.AppPalette.windowBg,
          border: Border.all(color: grid.AppPalette.divider),
          borderRadius: BorderRadius.circular(6),
          boxShadow: const [
            BoxShadow(
              color: Color(0x33000000),
              blurRadius: 10,
              offset: Offset(0, 3),
            ),
          ],
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            EngineMark(engine: engine, size: 14),
            const SizedBox(width: 7),
            Text(
              name,
              style: TextStyle(
                color: grid.AppPalette.textPrimary,
                fontSize: 12,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The machine list before the backend has answered: three rows on the guide
/// line, at a [SidebarItem]'s exact geometry.
///
/// Three because the rail is a list pane and most accounts have a few
/// machines; a skeleton taller than the answer jumps up when it lands.
class _MachineListSkeleton extends StatelessWidget {
  const _MachineListSkeleton({super.key});

  static const _labels = [0.56, 0.42, 0.64];

  @override
  Widget build(BuildContext context) => SkeletonList(
    rows: 3,
    semanticsLabel: 'Loading machines',
    itemBuilder: (context, i) => SidebarTimeline(
      role: SidebarTimelineRole.node,
      above: i > 0,
      below: false,
      child: _MachineCaptionSkeleton(labelFactor: _labels[i]),
    ),
  );
}

/// A machine caption with nothing in it yet.
///
/// Not [_SidebarRowSkeleton]: that one stands in for a [SidebarItem], which is
/// what an AGENT row is. A machine is a caption at half the label size in a
/// shorter box, and a placeholder built to the wrong one resizes the rail as
/// the answer lands — which is the whole thing a skeleton exists to avoid.
class _MachineCaptionSkeleton extends StatelessWidget {
  const _MachineCaptionSkeleton({required this.labelFactor});

  final double labelFactor;

  @override
  Widget build(BuildContext context) => Padding(
    padding: _machineCaptionPadding,
    child: SizedBox(
      height: _machineCaptionHeight,
      child: Row(
        children: [
          Skeleton(
            width: _machineMarkSize,
            height: _machineMarkSize,
            radius: 5,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: SkeletonText(
              style: _machineCaptionStyle(grid.AppPalette.textFaint),
              widthFactor: labelFactor,
            ),
          ),
        ],
      ),
    ),
  );
}

/// A machine's agents before `agents_list` has answered: two rows where the
/// agents will go, threaded onto the same guide line they will hang from.
class _AgentRowsSkeleton extends StatelessWidget {
  const _AgentRowsSkeleton({super.key});

  static const _rows = 2;
  static const _labels = [0.48, 0.36];

  @override
  Widget build(BuildContext context) => SkeletonList(
    rows: _rows,
    fadeDepth: skeletonFadeLight,
    semanticsLabel: 'Loading agents',
    itemBuilder: (context, i) => SidebarTimeline(
      role: SidebarTimelineRole.branch,
      below: i < _rows - 1,
      child: Padding(
        // Where a nested row's box starts — see [_AgentRow].
        padding: const EdgeInsets.only(left: 28),
        child: _SidebarRowSkeleton(
          leading: 16,
          leadingRadius: 4,
          labelFactor: _labels[i],
        ),
      ),
    ),
  );
}

/// A [SidebarItem] with nothing in it yet: the same 1px margin, 36px box,
/// icon gutter and label strut, so a placeholder row and a real one measure
/// the same to the pixel — the row's label pins its metrics with a strut, and
/// a bar measured without it comes out a pixel short.
class _SidebarRowSkeleton extends StatelessWidget {
  const _SidebarRowSkeleton({
    required this.leading,
    required this.leadingRadius,
    required this.labelFactor,
  });

  final double leading;
  final double leadingRadius;
  final double labelFactor;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 1),
    child: SizedBox(
      height: 36,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(SidebarItem.iconGutter, 0, 5, 0),
        child: Row(
          children: [
            Skeleton(width: leading, height: leading, radius: leadingRadius),
            const SizedBox(width: 10),
            Expanded(
              child: SkeletonText(
                style: const TextStyle(fontSize: 13.7, height: 1.25),
                strutStyle: const StrutStyle(
                  fontSize: 13.5,
                  height: 1.25,
                  forceStrutHeight: true,
                ),
                widthFactor: labelFactor,
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

class _AgentStatusRow extends StatelessWidget {
  final IconData icon;
  final String label;

  /// A quiet line of fact under a machine — "connecting…", "preparing agent
  /// list…". Never a control: the one tappable thing that used to share this
  /// shape ("link required") is a row of its own now, see [_LinkMachineRow].
  const _AgentStatusRow({required this.icon, required this.label});

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(38, 3, 12, 9),
      child: Row(
        children: [
          Icon(icon, size: 12, color: grid.AppPalette.textFaint),
          const SizedBox(width: 7),
          Expanded(
            child: Text(
              label,
              style: TextStyle(
                color: grid.AppPalette.textFaint,
                fontFamily: grid.AppFont.sans,
                fontSize: 11.2,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The word for a machine that is not answering, on the machine's own row.
///
/// A word, not a chip. It was a filled pill, and it was the only filled thing
/// in a column that says everything else in plain text — so it read as a
/// control, on the one row where there is nothing to press. The grey mark
/// beside the name already carries the fact; this just names it.
class _OfflineWord extends StatelessWidget {
  const _OfflineWord();

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Padding(
      padding: const EdgeInsets.only(left: 8),
      child: Text(
        'offline',
        style: TextStyle(
          color: grid.AppPalette.textFaint,
          fontFamily: grid.AppFont.sans,
          fontSize: 10,
          letterSpacing: 0.2,
        ),
      ),
    );
  }
}

/// Why an offline machine has no agents under it.
///
/// One sentence, in the colour every other quiet line in the rail uses. No icon,
/// because the chip beside the machine name is already the marker; no command,
/// because the person reading it opened an application.
class _MachineOfflineNote extends StatelessWidget {
  const _MachineOfflineNote({required this.state, this.linkPending = false});

  final MachineState state;

  /// True when the machine also has no link yet — then the note says what
  /// comes next, so the person is not left wondering why the link row they
  /// saw on another machine is missing on this one.
  final bool linkPending;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    // "it", not the machine's name: the name is the caption directly above
    // this line, and repeating it doubled the note to two lines on every host
    // with a hostname-shaped name. The local computer keeps "this computer",
    // because "it" for the machine you are sitting at reads as somewhere else.
    final where = state.isLocalMachine ? 'this computer' : 'it';
    return Padding(
      padding: const EdgeInsets.fromLTRB(38, 0, 12, 8),
      child: Text(
        linkPending
            ? "Harness isn't running on $where · link when it's back"
            : "Harness isn't running on $where.",
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          color: grid.AppPalette.textFaint,
          fontFamily: grid.AppFont.sans,
          fontSize: 11.2,
          height: 1.4,
        ),
      ),
    );
  }
}

class _AgentLoadError extends StatelessWidget {
  final AppNotifier notifier;
  final MachineState state;

  const _AgentLoadError({required this.notifier, required this.state});

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(38, 2, 8, 8),
      child: Row(
        children: [
          Icon(
            Icons.error_outline,
            size: 12,
            color: grid.AppPalette.dangerFill,
          ),
          const SizedBox(width: 7),
          Expanded(
            child: Text(
              state.agentsLoadError ?? 'Could not load agents',
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: grid.AppPalette.dangerFill,
                fontFamily: grid.AppFont.sans,
                fontSize: 11.2,
              ),
            ),
          ),
          IconButton(
            icon: const Icon(Icons.refresh, size: 14),
            color: grid.AppPalette.textSecondary,
            tooltip: 'Retry agents',
            onPressed: () =>
                notifier.reloadMachineData(state.machine.machineId),
          ),
        ],
      ),
    );
  }
}

/// "New agent…", drawn as the row it would create.
///
/// The rail is a LIST, and every framed control put in it has read as a foreign object — there is
/// nothing else in this column with a border or a fill of its own. So this is not a button placed in a
/// list; it is a row of the list that happens to be empty. Same indent, same well, same label type, same
/// hover fill: what changes is that the well is drawn in dashes and holds a `+`, which is the shared
/// vocabulary for "this one is not real yet".
///
/// It replaces two things that were louder and said less. A sentence — "no running agents" — set at
/// 13.5px under an 11px machine caption, so the status line was bigger than its own heading and the eye
/// landed on the least useful words on screen. And an accent-washed button, which in a rail holding no
/// other framed control read as the primary action of the whole window for a machine that is merely
/// idle. Neither said the thing that matters, which is that a row can be added here.
///
/// It also stands at the END of a machine that already has agents, and that is not scope creep — it is
/// the same problem one row further down. Adding an agent to a machine that has some is only offered by
/// a `+` revealed on hover of the machine caption, which cannot be found by anyone who does not already
/// know it is there. One shape now answers both.
class _NewAgentRow extends StatelessWidget {
  const _NewAgentRow({
    required this.notifier,
    required this.machineId,
    required this.source,
  });

  final AppNotifier notifier;
  final String machineId;

  /// Which of the two places this row is standing in, so the dialog's own telemetry can tell an empty
  /// machine's first agent from a fifth one added to a busy machine — different moments, different
  /// answers to "did this get found".
  final String source;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Padding(
      // The same 28 an agent row takes, so the guide's arm reaches this row exactly as it reaches a real
      // one. A different indent here would bend the trunk at the last branch.
      padding: const EdgeInsets.only(left: 28),
      child: SidebarItem(
        label: 'New agent…',
        // Dimmed rather than a colour of its own: this row is a placeholder until it is reached for, and
        // the hover state SidebarItem already owns is what says it is live.
        dimmed: true,
        tooltip: 'Start an agent on this machine',
        onTap: () =>
            showNewAgentDialog(context, notifier, machineId, source: source),
        // The agent row's well, in dashes. Same 24px box and same 7px radius, so the column of marks
        // stays a column — only the border and the glyph say this one is an invitation.
        leading: CustomPaint(
          painter: _DashedWellPainter(color: grid.AppPalette.textFaint),
          child: SizedBox(
            width: 24,
            height: 24,
            child: Icon(
              LucideIcons.plus300,
              size: 13,
              color: grid.AppPalette.textFaint,
            ),
          ),
        ),
      ),
    );
  }
}

/// "Link this machine…", drawn as the row the link would unlock.
///
/// The same shape as [_NewAgentRow], on purpose: linking is the step BEFORE
/// adding an agent to this machine, and a row that looks like the one it leads
/// to says so without a sentence. It replaces a status line — "link required",
/// grey text with an accent icon and a chevron — that was a fact dressed as a
/// command: it named a condition and then behaved like a button, and its three
/// tones (accent icon, secondary text, faint chevron) agreed on nothing.
///
/// Only ever built for a machine that is ONLINE — the callers check, because
/// the handshake behind this needs the other daemon awake.
class _LinkMachineRow extends StatelessWidget {
  const _LinkMachineRow({required this.notifier, required this.state});

  final AppNotifier notifier;
  final MachineState state;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return SidebarTimeline(
      role: SidebarTimelineRole.branch,
      below: false,
      child: Padding(
        padding: const EdgeInsets.only(left: 28),
        child: SidebarItem(
          label: 'Link this machine…',
          dimmed: true,
          tooltip:
              'Link ${state.machine.displayName} so its agents show up here',
          onTap: () => notifier.selectMachineForSetup(state.machine.machineId),
          leading: CustomPaint(
            painter: _DashedWellPainter(color: grid.AppPalette.textFaint),
            child: SizedBox(
              width: 24,
              height: 24,
              child: Icon(
                LucideIcons.link2300,
                size: 13,
                color: grid.AppPalette.textFaint,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The agent well's 7px rounded square, drawn as a dashed outline.
///
/// Hand-drawn because Flutter has no dashed border: the path is walked in fixed steps and every other
/// step is stroked. Cheap enough for a row — it is one rounded rect — and it keeps the well's exact
/// geometry, which a substitute icon would not.
class _DashedWellPainter extends CustomPainter {
  const _DashedWellPainter({required this.color});

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1
      ..color = color.withValues(alpha: 0.55);
    final rect = RRect.fromRectAndRadius(
      Rect.fromLTWH(0.5, 0.5, size.width - 1, size.height - 1),
      const Radius.circular(7),
    );
    final path = Path()..addRRect(rect);
    for (final metric in path.computeMetrics()) {
      var distance = 0.0;
      while (distance < metric.length) {
        canvas.drawPath(metric.extractPath(distance, distance + 2.5), paint);
        distance += 5;
      }
    }
  }

  @override
  bool shouldRepaint(_DashedWellPainter old) => old.color != color;
}

class _EmptyAgents extends StatelessWidget {
  final AppNotifier notifier;
  final MachineState state;
  const _EmptyAgents({required this.notifier, required this.state});

  @override
  Widget build(BuildContext context) {
    // No sentence, and nothing framed. An empty list says it is empty by being empty; what it cannot say
    // on its own is that a row can be added, and that is exactly what this row is. See [_NewAgentRow] for
    // what it replaces and why.
    //
    // The reload the old sentence carried moved to the machine's own menu. It was a 40px icon button
    // living on a status line, reachable only while a machine happened to be empty — a per-machine action
    // belongs with the machine's other per-machine actions, where it is reachable in every state.
    // Wrapped in the timeline like any other row, and that is the whole claim: the guide's arm reaches
    // this row from the machine's trunk exactly as it reaches a real agent, so the rail reads as a list
    // with one row in it rather than as a message where a list should be. `below: false` closes the
    // trunk here — there is nothing after it.
    return SidebarTimeline(
      role: SidebarTimelineRole.branch,
      below: false,
      child: _NewAgentRow(
        notifier: notifier,
        machineId: state.machine.machineId,
        source: 'rail_empty',
      ),
    );
  }
}
