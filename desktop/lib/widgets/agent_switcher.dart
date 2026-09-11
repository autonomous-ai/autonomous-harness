import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/models.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../state/app_state.dart';
import 'engine_identity.dart';

/// ⌘P — go to an agent by name, on any machine.
///
/// THE KEY THAT WAS MISSING, and it was missing for the main verb of the
/// product. Before this, a hand that never touched the mouse could reach an
/// agent three ways and none of them did this job: ⌘1…⌘9 address TILES, so they
/// only find agents already on the grid; ⌘[ / ⌘] walk that same short list; ⌘B
/// takes a task and lets a model choose who gets it. Open the eleventh agent by
/// name — the thing tmux answers with `prefix s` and vim with telescope — and
/// the only answer was the sidebar, with a pointer.
///
/// A FILTER, NOT A MENU. Every agent on every machine is in the list, and typing
/// narrows it; that is the shape of the motion terminal people already have, and
/// it is the only shape that stays usable at thirty agents. The match is
/// subsequence, not substring — `frn` finds `frontend`, the way fzf and every
/// editor's go-to-file does — and it runs over the machine's name too, so
/// "mini auth" reaches the Auth agent on the mac mini.
///
/// Built on the same bones as [showLayoutPalette]: a dialog that takes focus at
/// once, walks on the arrow keys, commits on Enter. That palette proved the
/// pattern works in this app; this one adds a field in front of it.

/// Guards a second ⌘P while the switcher is already up — the same stacking
/// failure `showLayoutPalette` documents, where every press laid another
/// barrier over the last and the window appeared to fade to black.
bool _switcherOpen = false;

Future<void> showAgentSwitcher(BuildContext context, AppNotifier notifier) {
  if (_switcherOpen) return Future<void>.value();
  _switcherOpen = true;
  return showDialog<void>(
    context: context,
    barrierColor: Colors.black.withValues(alpha: 0.3),
    builder: (context) => _AgentSwitcher(notifier: notifier),
  ).whenComplete(() => _switcherOpen = false);
}

/// One agent, with everything the list needs to draw and rank it.
@immutable
class SwitcherEntry {
  const SwitcherEntry({
    required this.machineId,
    required this.machineName,
    required this.agent,
    required this.onGrid,
  });

  final String machineId;
  final String machineName;
  final Agent agent;

  /// Already has a tile. Shown, not hidden: "where is it" and "is it open" are
  /// different questions, and a switcher that omitted the open ones would make
  /// ⌘P useless for the very agents being worked on.
  final bool onGrid;

  /// What the filter reads — the agent's name and its machine's, so a query can
  /// name either.
  String get haystack => '${agent.name} $machineName'.toLowerCase();
}

/// Subsequence match, fzf-style: every character of [query] appears in [text]
/// in order, not necessarily together.
///
/// Returns the match's SPREAD — the distance from the first matched character
/// to the last — or null when it does not match. Spread is the ranking signal
/// because a tight run is what a person meant: `auth` against "Auth" scores 3
/// and against "a...u...t...h" scores forty, and the first is the one they were
/// typing at.
int? subsequenceSpread(String text, String query) {
  if (query.isEmpty) return 0;
  var at = -1;
  var first = -1;
  for (final rune in query.runes) {
    final ch = String.fromCharCode(rune);
    final found = text.indexOf(ch, at + 1);
    if (found < 0) return null;
    if (first < 0) first = found;
    at = found;
  }
  return at - first;
}

/// The agents this window can reach, ranked against [query].
///
/// Pulled out of the widget so the ranking can be tested without a screen —
/// which matters more here than usual, because "why did it not find my agent"
/// is the one bug report a fuzzy list reliably generates.
List<SwitcherEntry> rankAgentsForSwitcher(
  List<SwitcherEntry> all,
  String query,
) {
  final needle = query.trim().toLowerCase();
  if (needle.isEmpty) {
    // No query: the ones NOT on the grid first. Someone who opened this with an
    // empty field is looking for something they cannot already see, and the
    // agents in front of them are the least likely answer.
    return [...all]..sort((a, b) {
      if (a.onGrid != b.onGrid) return a.onGrid ? 1 : -1;
      return a.agent.name.toLowerCase().compareTo(b.agent.name.toLowerCase());
    });
  }
  final scored = <({SwitcherEntry entry, int spread})>[];
  for (final entry in all) {
    final spread = subsequenceSpread(entry.haystack, needle);
    if (spread != null) scored.add((entry: entry, spread: spread));
  }
  scored.sort((a, b) {
    if (a.spread != b.spread) return a.spread.compareTo(b.spread);
    return a.entry.agent.name.toLowerCase().compareTo(
      b.entry.agent.name.toLowerCase(),
    );
  });
  return [for (final row in scored) row.entry];
}

class _AgentSwitcher extends StatefulWidget {
  const _AgentSwitcher({required this.notifier});

  final AppNotifier notifier;

  @override
  State<_AgentSwitcher> createState() => _AgentSwitcherState();
}

class _AgentSwitcherState extends State<_AgentSwitcher> {
  final _query = TextEditingController();
  final _field = FocusNode();
  int _cursor = 0;

  @override
  void dispose() {
    _query.dispose();
    _field.dispose();
    super.dispose();
  }

  List<SwitcherEntry> _entries() {
    final out = <SwitcherEntry>[];
    for (final state in widget.notifier.machineStates.values) {
      for (final agent in state.agents) {
        // An agent with no terminal cannot be opened, so offering it is a row
        // that answers a keystroke with nothing.
        if (!agent.terminalAvailable) continue;
        out.add(
          SwitcherEntry(
            machineId: state.machine.machineId,
            machineName: state.machine.displayName,
            agent: agent,
            onGrid:
                widget.notifier.paneOfAgent(
                  state.machine.machineId,
                  agent.id,
                ) !=
                null,
          ),
        );
      }
    }
    return out;
  }

  void _open(SwitcherEntry entry, {required bool newTile}) {
    Navigator.of(context).pop();
    if (newTile && !entry.onGrid) {
      unawaited(
        widget.notifier.assignAgentToPane(
          null,
          entry.machineId,
          entry.agent.id,
        ),
      );
      return;
    }
    // selectAgent focuses the tile this agent already has, or opens one. Both
    // are "take me there", which is the only promise this list makes.
    unawaited(widget.notifier.selectAgent(entry.machineId, entry.agent.id));
  }

  KeyEventResult _onKey(
    FocusNode node,
    KeyEvent event,
    List<SwitcherEntry> rows,
  ) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    final key = event.logicalKey;
    final ctrl = HardwareKeyboard.instance.isControlPressed;

    // Ctrl-n / Ctrl-p walk the list as well as the arrows. Inside a text field
    // those two are readline's "next line" / "previous line", which is exactly
    // what they are being asked to do here, and they are what a terminal user's
    // hand does without being told. They cost nothing: the field is this app's,
    // not a pty, so no shell is waiting for them.
    final down =
        key == LogicalKeyboardKey.arrowDown ||
        (ctrl && key == LogicalKeyboardKey.keyN);
    final up =
        key == LogicalKeyboardKey.arrowUp ||
        (ctrl && key == LogicalKeyboardKey.keyP);
    if (down || up) {
      if (rows.isEmpty) return KeyEventResult.handled;
      setState(() {
        // Wraps, unlike the layout palette's strip: this is a LIST, and a list
        // that runs off its own end is the one place wrapping reads as correct.
        _cursor = (_cursor + (down ? 1 : -1) + rows.length) % rows.length;
      });
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.enter ||
        key == LogicalKeyboardKey.numpadEnter) {
      if (rows.isEmpty) return KeyEventResult.handled;
      _open(
        rows[_cursor.clamp(0, rows.length - 1)],
        newTile: HardwareKeyboard.instance.isShiftPressed,
      );
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.escape) {
      Navigator.of(context).pop();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ListenableBuilder(
      listenable: widget.notifier,
      builder: (context, _) {
        final rows = rankAgentsForSwitcher(_entries(), _query.text);
        final at = rows.isEmpty ? 0 : _cursor.clamp(0, rows.length - 1);
        return Dialog(
          alignment: Alignment.topCenter,
          insetPadding: const EdgeInsets.only(top: 96, left: 24, right: 24),
          backgroundColor: grid.AppGlass.surfaceFill,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(13),
            side: BorderSide(color: grid.AppGlass.hair),
          ),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 620),
            child: Focus(
              onKeyEvent: (node, event) => _onKey(node, event, rows),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
                    child: TextField(
                      controller: _query,
                      focusNode: _field,
                      autofocus: true,
                      style: TextStyle(
                        fontSize: 17,
                        color: grid.AppPalette.textPrimary,
                      ),
                      decoration: InputDecoration(
                        border: InputBorder.none,
                        isDense: true,
                        hintText: 'Go to agent…',
                        hintStyle: TextStyle(
                          fontSize: 17,
                          color: grid.AppPalette.textFaint,
                        ),
                      ),
                      // Rebuilt on every keystroke, and the cursor goes home
                      // with it: after narrowing the list, row 4 is a different
                      // agent than it was, and landing on it would open
                      // something nobody chose.
                      onChanged: (_) => setState(() => _cursor = 0),
                    ),
                  ),
                  Divider(height: 1, color: grid.AppGlass.hair),
                  if (rows.isEmpty)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 18, 16, 20),
                      child: Text(
                        'No agent matches that.',
                        style: TextStyle(
                          fontSize: 13,
                          color: grid.AppPalette.textFaint,
                        ),
                      ),
                    )
                  else
                    Flexible(
                      child: ListView.builder(
                        shrinkWrap: true,
                        padding: const EdgeInsets.symmetric(vertical: 6),
                        itemCount: rows.length,
                        itemBuilder: (context, i) => _Row(
                          entry: rows[i],
                          selected: i == at,
                          onTap: () => _open(rows[i], newTile: false),
                        ),
                      ),
                    ),
                  Divider(height: 1, color: grid.AppGlass.hair),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 9, 16, 10),
                    child: Text(
                      '↑↓ or ⌃n ⌃p to move · ⏎ to go · ⇧⏎ in a new tile · esc',
                      style: TextStyle(
                        fontSize: 11,
                        color: grid.AppPalette.textFaint,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({
    required this.entry,
    required this.selected,
    required this.onTap,
  });

  final SwitcherEntry entry;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return InkWell(
      onTap: onTap,
      child: Container(
        color: selected ? grid.AppGlass.surfaceHoverFill : null,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
        child: Row(
          children: [
            EngineMark(
              engine: entry.agent.engine,
              displayName: entry.agent.engineDisplayName,
              size: 15,
            ),
            const SizedBox(width: 11),
            Expanded(
              child: Text(
                entry.agent.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 13.5,
                  color: grid.AppPalette.textPrimary,
                ),
              ),
            ),
            const SizedBox(width: 12),
            Text(
              entry.machineName,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 12, color: grid.AppPalette.textFaint),
            ),
            // A dot, not the word "open": the list is read at a glance and a
            // second column of text would compete with the machine's name.
            if (entry.onGrid) ...[
              const SizedBox(width: 10),
              Container(
                width: 5,
                height: 5,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: grid.AppPalette.textSecondary,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
