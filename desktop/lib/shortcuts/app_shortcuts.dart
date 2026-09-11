import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import '../logging/debug_surface.dart';

/// Every keyboard shortcut in the app, declared once.
///
/// One list feeds both the live bindings and the ⌘/ sheet, so a shortcut can
/// never work without being documented or be documented without working.
///
/// ## Why every one of these is ⌘, and none is Ctrl
///
/// The main pane is a real terminal running a real TUI, and three layers below
/// this app are already holding keys:
///
/// * **The engine's TUI** — `Esc` interrupts, `⇧Tab` cycles permission modes,
///   `⌥⏎` inserts a newline.
/// * **tmux** — agents are attached to tmux panes, whose default prefix is
///   `Ctrl+B`.
/// * **The shell** — `Ctrl+C`, `Ctrl+D`, `Ctrl+R`, `Ctrl+A`, `Ctrl+E`, `Ctrl+L`.
///
/// On macOS the Command key never reaches the pty, so it is the only modifier
/// this app can spend. `⌥` is NOT available: terminals send it as a Meta/ESC
/// prefix, which is why `⌥⏎` reaches the engine at all. `⌘⌥` together is safe.
///
/// Claude Code Desktop binds `Ctrl+Tab`, ``Ctrl+` `` and `Ctrl+O`. It can — its
/// main pane is a chat. Copying that here would break the terminal, so this
/// list deliberately diverges.
///
/// Three more keys are spoken for by `package:xterm` itself on macOS — `⌘C`,
/// `⌘V`, `⌘A` (copy, paste, select all) — and must stay with it.
///
/// ⚠️ THAT ONLY BECAME TRUE ONCE THE MENU LET GO OF THEM. Flutter's macOS
/// template ships `MainMenu.xib` with a full Edit menu, and `Cut`/`Copy`/
/// `Paste`/`Select All` carried `keyEquivalent` — so AppKit matched ⌘X/⌘C/⌘V/⌘A
/// in `performKeyEquivalent:`, which runs BEFORE keyDown reaches the responder
/// chain, and dispatched `cut:`/`copy:`/`paste:`/`selectAll:` up it instead.
/// xterm's paste is a Shortcuts→Actions binding driven by a KEY EVENT, so it
/// never saw the keystroke: ⌘V did nothing in a terminal pane and the only way
/// to paste was whatever the engine's own TUI happened to bind.
///
/// Those four `keyEquivalent`s are now stripped from the xib. The menu items
/// stay — clicked, they still work through the responder chain — and text
/// fields keep their shortcuts from Flutter's own `DefaultTextEditingShortcuts`,
/// which binds the same four on macOS. Do not put them back.

enum ShortcutAction {
  toggleRail,
  nextAgent,
  previousAgent,
  focusPaneLeft,
  focusPaneRight,
  focusPaneAbove,
  focusPaneBelow,
  movePaneLeft,
  movePaneRight,
  movePaneUp,
  movePaneDown,

  /// The agent this window was on before the current one — tmux's `prefix ;`.
  lastPane,

  /// One pane filling the grid, and back. tmux's `prefix z`.
  zoomPane,

  /// Jump to any agent by name, on any machine.
  switchAgent,

  closePane,
  newAgent,
  routeTask,
  reload,
  showLayout,
  pinPane,
  showShortcuts,
  showDebug,
}

enum ShortcutGroup { navigate, panes, actions }

extension ShortcutGroupLabel on ShortcutGroup {
  String get label => switch (this) {
    ShortcutGroup.navigate => 'Navigate',
    ShortcutGroup.panes => 'Panes',
    ShortcutGroup.actions => 'Actions',
  };
}

class AppShortcut {
  const AppShortcut({
    required this.action,
    required this.activator,
    required this.label,
    required this.group,
  });

  final ShortcutAction action;
  final SingleActivator activator;
  final String label;
  final ShortcutGroup group;
}

const List<AppShortcut> kAppShortcuts = [
  // --- navigate -------------------------------------------------------------
  //
  // ONE MOTION, TWO SPELLINGS. Every direction is bound as both `⌘`+arrow and
  // `⌘`+hjkl, live at the same time and with no mode to switch between them —
  // which is what zellij does with Alt, and for the same reason: a person who
  // reaches for hjkl and a person who reaches for the arrows are not two
  // populations to be asked about, they are two hands on the same keyboard.
  //
  // ⌘, NOT Ctrl, and that is forced. `vim-tmux-navigator` — the thing vim users
  // actually have in their fingers — binds Ctrl+hjkl, and it works there because
  // tmux ASKS whether the focused pane is running vim and forwards the key only
  // then. Nothing here can ask: the pane is always a terminal running a TUI, and
  // Ctrl-h/j/k/l are backspace, newline, kill-line and clear — keys the agent
  // needs. Taking them would break the terminal for everyone to please one half
  // of the room. See this file's header for why ⌥ is out too.
  //
  // ⌘H WAS MACOS'S. `MainMenu.xib` carried `keyEquivalent="h"` on Hide, matched
  // in `performKeyEquivalent:` before Flutter ever sees the key — the same trap
  // the header describes for ⌘C/⌘V/⌘A, and answered the same way: the
  // keyEquivalent is stripped, the menu item stays and still works when clicked.
  // ⌘J (Jump to Selection) and ⌘; (Check Document Now) went with it; this app
  // has no Find and no spell-checked field. The cost is real and worth saying:
  // Hide is no longer a keystroke in this app.
  AppShortcut(
    action: ShortcutAction.focusPaneLeft,
    activator: SingleActivator(LogicalKeyboardKey.keyH, meta: true),
    label: 'Focus the pane to the left',
    group: ShortcutGroup.navigate,
  ),
  AppShortcut(
    action: ShortcutAction.focusPaneBelow,
    activator: SingleActivator(LogicalKeyboardKey.keyJ, meta: true),
    label: 'Focus the pane below',
    group: ShortcutGroup.navigate,
  ),
  AppShortcut(
    action: ShortcutAction.focusPaneAbove,
    activator: SingleActivator(LogicalKeyboardKey.keyK, meta: true),
    label: 'Focus the pane above',
    group: ShortcutGroup.navigate,
  ),
  AppShortcut(
    action: ShortcutAction.focusPaneRight,
    activator: SingleActivator(LogicalKeyboardKey.keyL, meta: true),
    label: 'Focus the pane to the right',
    group: ShortcutGroup.navigate,
  ),
  // The same four, for the hand that never left the arrow cluster. Safe despite
  // the bare-arrow rule this file's tests enforce: that rule is about UNMODIFIED
  // arrows, which the terminal owns for the cursor and for shell history. A ⌘
  // chord is the app's — terminal_panel._onTerminalKey passes everything but ⌘V
  // straight through.
  AppShortcut(
    action: ShortcutAction.focusPaneLeft,
    activator: SingleActivator(LogicalKeyboardKey.arrowLeft, meta: true),
    label: 'Focus the pane to the left',
    group: ShortcutGroup.navigate,
  ),
  AppShortcut(
    action: ShortcutAction.focusPaneBelow,
    activator: SingleActivator(LogicalKeyboardKey.arrowDown, meta: true),
    label: 'Focus the pane below',
    group: ShortcutGroup.navigate,
  ),
  AppShortcut(
    action: ShortcutAction.focusPaneAbove,
    activator: SingleActivator(LogicalKeyboardKey.arrowUp, meta: true),
    label: 'Focus the pane above',
    group: ShortcutGroup.navigate,
  ),
  AppShortcut(
    action: ShortcutAction.focusPaneRight,
    activator: SingleActivator(LogicalKeyboardKey.arrowRight, meta: true),
    label: 'Focus the pane to the right',
    group: ShortcutGroup.navigate,
  ),

  // --- panes ----------------------------------------------------------------
  //
  // SHIFT MOVES WHAT THE PLAIN KEY WALKS TO, and that is not a convention
  // invented here: vim has used `Ctrl-w H/J/K/L` — the capitals — to move a
  // window to an edge for as long as it has had splits. A vim user does not
  // have to be taught this row; they have to be told it is not missing.
  AppShortcut(
    action: ShortcutAction.movePaneLeft,
    activator: SingleActivator(
      LogicalKeyboardKey.keyH,
      meta: true,
      shift: true,
    ),
    label: 'Move this pane left',
    group: ShortcutGroup.panes,
  ),
  AppShortcut(
    action: ShortcutAction.movePaneDown,
    activator: SingleActivator(
      LogicalKeyboardKey.keyJ,
      meta: true,
      shift: true,
    ),
    label: 'Move this pane down',
    group: ShortcutGroup.panes,
  ),
  AppShortcut(
    action: ShortcutAction.movePaneUp,
    activator: SingleActivator(
      LogicalKeyboardKey.keyK,
      meta: true,
      shift: true,
    ),
    label: 'Move this pane up',
    group: ShortcutGroup.panes,
  ),
  AppShortcut(
    action: ShortcutAction.movePaneRight,
    activator: SingleActivator(
      LogicalKeyboardKey.keyL,
      meta: true,
      shift: true,
    ),
    label: 'Move this pane right',
    group: ShortcutGroup.panes,
  ),
  AppShortcut(
    action: ShortcutAction.movePaneLeft,
    activator: SingleActivator(
      LogicalKeyboardKey.arrowLeft,
      meta: true,
      shift: true,
    ),
    label: 'Move this pane left',
    group: ShortcutGroup.panes,
  ),
  AppShortcut(
    action: ShortcutAction.movePaneDown,
    activator: SingleActivator(
      LogicalKeyboardKey.arrowDown,
      meta: true,
      shift: true,
    ),
    label: 'Move this pane down',
    group: ShortcutGroup.panes,
  ),
  AppShortcut(
    action: ShortcutAction.movePaneUp,
    activator: SingleActivator(
      LogicalKeyboardKey.arrowUp,
      meta: true,
      shift: true,
    ),
    label: 'Move this pane up',
    group: ShortcutGroup.panes,
  ),
  AppShortcut(
    action: ShortcutAction.movePaneRight,
    activator: SingleActivator(
      LogicalKeyboardKey.arrowRight,
      meta: true,
      shift: true,
    ),
    label: 'Move this pane right',
    group: ShortcutGroup.panes,
  ),

  // ⌘⏎ — tmux's `prefix z`, one of the most-pressed keys that multiplexer has.
  // Enter because it reads as "make THIS the thing", and because it is the one
  // chord on this list nobody has to look up twice.
  AppShortcut(
    action: ShortcutAction.zoomPane,
    activator: SingleActivator(LogicalKeyboardKey.enter, meta: true),
    label: 'Zoom this pane, or put it back',
    group: ShortcutGroup.panes,
  ),
  // ⌘; — tmux's `prefix ;`, spelled the same. Two agents at a time is the shape
  // most work actually has, and walking a list to get back to the other one is
  // the wrong motion for it.
  AppShortcut(
    action: ShortcutAction.lastPane,
    activator: SingleActivator(LogicalKeyboardKey.semicolon, meta: true),
    label: 'Back to the pane you were just on',
    group: ShortcutGroup.panes,
  ),
  AppShortcut(
    action: ShortcutAction.closePane,
    activator: SingleActivator(LogicalKeyboardKey.keyW, meta: true),
    label: 'Close the focused pane',
    group: ShortcutGroup.panes,
  ),
  AppShortcut(
    action: ShortcutAction.pinPane,
    // ⇧⌘P: plain ⌘P is the switcher now, which is the key people reach for far
    // more often. Same letter, so the pair stays learnable.
    activator: SingleActivator(
      LogicalKeyboardKey.keyP,
      meta: true,
      shift: true,
    ),
    label: 'Hold this pane in its slot',
    group: ShortcutGroup.panes,
  ),
  AppShortcut(
    action: ShortcutAction.showLayout,
    activator: SingleActivator(LogicalKeyboardKey.keyS, meta: true),
    label: 'Choose the grid layout',
    group: ShortcutGroup.panes,
  ),

  // --- agents ---------------------------------------------------------------
  //
  // THE BRACKETS MEAN ONE THING NOW. They used to carry three: ⌘[ ] walked
  // panes, ⇧⌘[ ] walked agents and ⌥⌘[ ] moved panes — three verbs told apart
  // only by which modifiers were down. Panes moved to hjkl and arrows, so the
  // brackets keep the one job they are good at: stepping along a list.
  AppShortcut(
    action: ShortcutAction.previousAgent,
    activator: SingleActivator(LogicalKeyboardKey.bracketLeft, meta: true),
    label: 'Previous agent',
    group: ShortcutGroup.navigate,
  ),
  AppShortcut(
    action: ShortcutAction.nextAgent,
    activator: SingleActivator(LogicalKeyboardKey.bracketRight, meta: true),
    label: 'Next agent',
    group: ShortcutGroup.navigate,
  ),
  // ⌘P — "go to", the way VS Code's quick-open spells it, because that is what
  // this is: type part of a name, land on the agent.
  //
  // It answers the one thing a keyboard-only session could not do at all. ⌘1…⌘9
  // address TILES, so they only reach agents already on the grid; ⌘B sends a
  // task and lets a model choose. Neither opens the eleventh agent by name, and
  // until this key existed the only way was the mouse.
  //
  // ⌘K stays unbound and is now spoken for by the navigation row above — see
  // the header's note about what the file used to hold it in reserve for.
  AppShortcut(
    action: ShortcutAction.switchAgent,
    activator: SingleActivator(LogicalKeyboardKey.keyP, meta: true),
    label: 'Go to an agent by name',
    group: ShortcutGroup.navigate,
  ),
  // ⌃⇥ / ⌃⇧⇥ — the one Ctrl pair this app is allowed, and the terminal is made
  // to let it past on purpose (terminal_view.dart) because no shell or tmux
  // binding wants it.
  //
  // It walks AGENTS now, not panes. It used to be a third spelling of "next
  // pane", which put it in list order beside hjkl's geometry — the same split
  // brain the brackets had. Tab between agents is what every tabbed app has
  // trained the hand to expect anyway.
  AppShortcut(
    action: ShortcutAction.nextAgent,
    activator: SingleActivator(LogicalKeyboardKey.tab, control: true),
    label: 'Next agent',
    group: ShortcutGroup.navigate,
  ),
  AppShortcut(
    action: ShortcutAction.previousAgent,
    activator: SingleActivator(
      LogicalKeyboardKey.tab,
      control: true,
      shift: true,
    ),
    label: 'Previous agent',
    group: ShortcutGroup.navigate,
  ),
  AppShortcut(
    action: ShortcutAction.toggleRail,
    activator: SingleActivator(LogicalKeyboardKey.backslash, meta: true),
    label: 'Show or hide the sidebar',
    group: ShortcutGroup.navigate,
  ),

  // --- actions --------------------------------------------------------------
  AppShortcut(
    action: ShortcutAction.newAgent,
    activator: SingleActivator(LogicalKeyboardKey.keyN, meta: true),
    label: 'New agent',
    group: ShortcutGroup.actions,
  ),
  AppShortcut(
    action: ShortcutAction.routeTask,
    activator: SingleActivator(LogicalKeyboardKey.keyB, meta: true),
    label: 'Describe a task, and let it pick the agent',
    group: ShortcutGroup.actions,
  ),
  AppShortcut(
    action: ShortcutAction.reload,
    activator: SingleActivator(LogicalKeyboardKey.keyR, meta: true),
    label: 'Reload machines and agents',
    group: ShortcutGroup.actions,
  ),
  AppShortcut(
    action: ShortcutAction.showShortcuts,
    activator: SingleActivator(LogicalKeyboardKey.slash, meta: true),
    label: 'Show keyboard shortcuts',
    group: ShortcutGroup.actions,
  ),
];

/// Open Settings ▸ Debug — the app's own log, as this session still holds it.
///
/// Kept out of [kAppShortcuts] because it is not always there: a release build
/// has no Debug screen (see [kDebugSurfaceEnabled]), and a key that opens
/// nothing is worse than a key that was never taken. `⌘D` is free on this list
/// and on this OS's own menus, and — like every other shortcut here — never
/// reaches the pty.
const AppShortcut kDebugShortcut = AppShortcut(
  action: ShortcutAction.showDebug,
  activator: SingleActivator(LogicalKeyboardKey.keyD, meta: true),
  label: 'Open the debug log',
  group: ShortcutGroup.actions,
);

/// Every shortcut THIS build has — [kAppShortcuts], plus the developer ones the
/// build is allowed to show.
///
/// The one list the bindings, the ⌘/ sheet and the tooltips all read, so a
/// build cannot bind a key it does not document or document one it does not
/// bind.
List<AppShortcut> appShortcuts() => [
  ...kAppShortcuts,
  if (kDebugSurfaceEnabled) kDebugShortcut,
];

/// `⌘1`…`⌘9` jump to the nth TILE on the grid.
///
/// Tiles, not sidebar rows: the number is the one printed on the tile and the
/// one the dial walks, so "the third one" means the same thing wherever it is
/// said. Addressing the sidebar instead made ⌘3 open something that was not on
/// screen and replace a tile to do it.
///
/// Not in [kAppShortcuts] because nine near-identical rows would bury the sheet;
/// the sheet prints them as one line instead.
const int kAgentDigitCount = 9;

List<SingleActivator> agentDigitActivators() => const [
  SingleActivator(LogicalKeyboardKey.digit1, meta: true),
  SingleActivator(LogicalKeyboardKey.digit2, meta: true),
  SingleActivator(LogicalKeyboardKey.digit3, meta: true),
  SingleActivator(LogicalKeyboardKey.digit4, meta: true),
  SingleActivator(LogicalKeyboardKey.digit5, meta: true),
  SingleActivator(LogicalKeyboardKey.digit6, meta: true),
  SingleActivator(LogicalKeyboardKey.digit7, meta: true),
  SingleActivator(LogicalKeyboardKey.digit8, meta: true),
  SingleActivator(LogicalKeyboardKey.digit9, meta: true),
];

/// One line in the shortcuts UI: what it does, and every chord that does it.
///
/// Not the same shape as [AppShortcut], and deliberately. Two activators can
/// drive one action — `⌘]` and `⌃⇥` both focus the next pane — which the
/// bindings need as two entries and the reader needs as one line. Printed as
/// two rows it reads as a duplicate the screen forgot to collapse.
class ShortcutRow {
  const ShortcutRow({
    required this.label,
    required this.chords,
    required this.group,
  });

  final String label;

  /// Every way to fire it, in declaration order — the first is the one to
  /// learn, the rest are alternates.
  final List<KeyChord> chords;

  final ShortcutGroup group;
}

/// [kAppShortcuts] as the UI prints it: one row per action, alternates folded
/// in, and `⌘1`–`⌘9` as the single line it deserves.
///
/// Derived rather than written out, so a shortcut cannot be added to the
/// bindings and forgotten here.
List<ShortcutRow> shortcutRows() {
  final byAction = <ShortcutAction, List<KeyChord>>{};
  final order = <ShortcutAction>[];
  final labels = <ShortcutAction, String>{};
  final groups = <ShortcutAction, ShortcutGroup>{};

  for (final shortcut in appShortcuts()) {
    if (byAction.putIfAbsent(shortcut.action, () => []).isEmpty) {
      order.add(shortcut.action);
      labels[shortcut.action] = shortcut.label;
      groups[shortcut.action] = shortcut.group;
    }
    byAction[shortcut.action]!.add(describeShortcutKeys(shortcut.activator));
  }

  final rows = [
    for (final action in order)
      ShortcutRow(
        label: labels[action]!,
        chords: byAction[action]!,
        group: groups[action]!,
      ),
  ];

  // The digits are not in [kAppShortcuts] — nine near-identical rows would bury
  // everything around them — so they join here, at the end of their group.
  final digits = ShortcutRow(
    label: 'Focus the 1st–9th pane',
    chords: const [
      ['⌘', '1 – $kAgentDigitCount'],
    ],
    // Panes, not Navigate: the digits address tiles on the grid now, and a row
    // reads under the heading that matches what it does.
    group: ShortcutGroup.panes,
  );
  final lastPane = rows.lastIndexWhere(
    (row) => row.group == ShortcutGroup.panes,
  );
  rows.insert(lastPane + 1, digits);
  return rows;
}

/// A key this app deliberately does **not** take, and who has it instead.
class TerminalKey {
  const TerminalKey(this.chord, this.label);

  final KeyChord chord;
  final String label;
}

/// What the terminal keeps — the doc comment at the top of this file, stated
/// where a user can read it.
///
/// The shortcuts screen prints these beside the ones the app takes, because
/// "why is there no shortcut for X" is answered by seeing that X already
/// belongs to something.
const List<TerminalKey> kTerminalOwnedKeys = [
  TerminalKey(['⌘', 'C'], 'Copy — xterm\'s own'),
  TerminalKey(['⌘', 'V'], 'Paste'),
  TerminalKey(['⌘', 'A'], 'Select all'),
  TerminalKey(['esc'], 'Interrupt the engine'),
  TerminalKey(['⌥', '⏎'], "Newline in the engine's prompt"),
  TerminalKey(['⌃', 'B'], 'tmux prefix'),
  TerminalKey(['⌃', 'C'], "The shell's own keys"),
];

/// Turns the declared shortcuts into the map [CallbackShortcuts] wants.
///
/// A missing handler is left unbound rather than bound to nothing: a key that
/// silently does nothing is worse than a key that was never taken, because the
/// terminal underneath could have had it.
Map<ShortcutActivator, VoidCallback> buildShortcutBindings({
  required Map<ShortcutAction, VoidCallback> handlers,
  void Function(int index)? onSelectPaneIndex,
}) {
  final bindings = <ShortcutActivator, VoidCallback>{};
  for (final shortcut in appShortcuts()) {
    final handler = handlers[shortcut.action];
    if (handler != null) bindings[shortcut.activator] = handler;
  }
  if (onSelectPaneIndex != null) {
    final digits = agentDigitActivators();
    for (var i = 0; i < digits.length; i++) {
      bindings[digits[i]] = () => onSelectPaneIndex(i);
    }
  }
  return bindings;
}

/// One chord, split into the keys a keyboard actually has — `['⇧', '⌘', ']']`.
///
/// Split rather than joined because the shortcuts UI draws one keycap per key.
/// [describeShortcut] is the same thing run together, for the places that want
/// a string (a tooltip, a test's failure message).
typedef KeyChord = List<String>;

/// The caps for [activator], in the order Apple prints them.
KeyChord describeShortcutKeys(SingleActivator activator) => [
  if (activator.control) '⌃',
  if (activator.alt) '⌥',
  if (activator.shift) '⇧',
  if (activator.meta) '⌘',
  _keyLabel(activator.trigger),
];

/// "⇧⌘]" — the way a Mac menu prints it, in the order Apple prints it.
String describeShortcut(SingleActivator activator) =>
    describeShortcutKeys(activator).join();

String _keyLabel(LogicalKeyboardKey key) {
  // keyLabel spells these out ("Arrow Left"), which is not how a Mac prints a
  // shortcut.
  if (key == LogicalKeyboardKey.arrowLeft) return '←';
  if (key == LogicalKeyboardKey.arrowRight) return '→';
  if (key == LogicalKeyboardKey.arrowUp) return '↑';
  if (key == LogicalKeyboardKey.arrowDown) return '↓';
  if (key == LogicalKeyboardKey.enter) return '⏎';
  if (key == LogicalKeyboardKey.tab) return '⇥';
  if (key == LogicalKeyboardKey.escape) return 'esc';
  return key.keyLabel;
}

/// The chord for [action], ready to append to a tooltip.
///
/// Tooltips read this instead of spelling the keys out, so a rebinding cannot
/// leave a button advertising a key that no longer works.
String? shortcutHintFor(ShortcutAction action) {
  for (final shortcut in appShortcuts()) {
    if (shortcut.action == action) return describeShortcut(shortcut.activator);
  }
  return null;
}

/// "Reload machines  ⌘R"
String withShortcutHint(String tooltip, ShortcutAction action) {
  final hint = shortcutHintFor(action);
  return hint == null ? tooltip : '$tooltip  $hint';
}
