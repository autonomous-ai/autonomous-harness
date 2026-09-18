import '../logging/debug_surface.dart';
import 'app_shortcuts.dart';
import 'keymap.dart';
import 'keymap_keyboard.dart';

/// Stable identities connect search to workspace actions. The same catalog
/// supplies the file-remapping foundation; native runtime wiring is separate.
class HarnessCommand {
  const HarnessCommand(
    this.id,
    this.label,
    this.group, {
    this.extraKeys = const [],
    this.action,
    this.nativeAction,
    this.context = KeymapContext.workspace,
    this.repeatable = false,
  });
  final String id, label;
  final ShortcutGroup group;
  final List<String> extraKeys;

  /// Workspace defaults come from the live shortcut table. A command cannot
  /// quietly propose different keys from the ones the user already uses.
  List<String> get keys =>
      action == null ? extraKeys : _workspaceKeys[action] ?? const [];
  final ShortcutAction? action;
  final String? nativeAction;
  final KeymapContext context;
  final bool repeatable;
}

final _workspaceKeys = _readWorkspaceKeys();
Map<ShortcutAction, List<String>> _readWorkspaceKeys() {
  final result = <ShortcutAction, List<String>>{};
  for (final shortcut in appShortcuts()) {
    final keys = keyStrokeFor(
      shortcut.activator.trigger,
      command: shortcut.activator.meta,
      control: shortcut.activator.control,
      alt: shortcut.activator.alt,
      shift: shortcut.activator.shift,
    )!.toString();
    (result[shortcut.action] ??= []).add(keys);
  }
  return result;
}

final harnessCommands = <HarnessCommand>[
  const HarnessCommand(
    'navigation.commands',
    'Search commands',
    ShortcutGroup.actions,
    extraKeys: ['cmd+shift+p'],
    nativeAction: 'commands',
  ),
  const HarnessCommand(
    'swarm.new',
    'New Tab',
    ShortcutGroup.navigate,
    action: ShortcutAction.newSwarm,
    nativeAction: 'new',
  ),
  const HarnessCommand(
    'swarm.close',
    'Close Tab',
    ShortcutGroup.navigate,
    action: ShortcutAction.closeSwarm,
    nativeAction: 'closeActive',
  ),
  const HarnessCommand(
    'swarm.reopen',
    'Reopen last closed harness',
    ShortcutGroup.navigate,
    action: ShortcutAction.reopenClosedSwarm,
    nativeAction: 'reopen',
  ),
  const HarnessCommand(
    'swarm.next',
    'Next Harness',
    ShortcutGroup.navigate,
    action: ShortcutAction.nextSwarm,
    nativeAction: 'next',
    repeatable: true,
  ),
  const HarnessCommand(
    'swarm.previous',
    'Previous Harness',
    ShortcutGroup.navigate,
    action: ShortcutAction.previousSwarm,
    nativeAction: 'previous',
    repeatable: true,
  ),
  const HarnessCommand(
    'swarm.rename',
    'Rename Tab',
    ShortcutGroup.actions,
    action: ShortcutAction.renameSwarm,
    nativeAction: 'renameActive',
  ),
  const HarnessCommand(
    'navigation.back',
    'Go back',
    ShortcutGroup.navigate,
    action: ShortcutAction.previousAgent,
    nativeAction: 'historyBack',
    repeatable: true,
  ),
  const HarnessCommand(
    'navigation.forward',
    'Go forward',
    ShortcutGroup.navigate,
    action: ShortcutAction.nextAgent,
    nativeAction: 'historyForward',
    repeatable: true,
  ),
  const HarnessCommand(
    'navigation.history',
    'Show full history',
    ShortcutGroup.navigate,
    action: ShortcutAction.showHistory,
    nativeAction: 'showHistory',
  ),
  const HarnessCommand(
    'navigation.needs_input',
    'Show agents needing input',
    ShortcutGroup.navigate,
    action: ShortcutAction.showAttention,
    nativeAction: 'notifications',
  ),
  for (var i = 1; i <= 9; i++)
    HarnessCommand(
      'swarm.select_$i',
      'Select harness $i',
      ShortcutGroup.navigate,
      extraKeys: ['cmd+$i'],
    ),
  for (var i = 1; i <= 9; i++)
    HarnessCommand('pane.focus_$i', 'Focus pane $i', ShortcutGroup.panes),
  const HarnessCommand(
    'pane.focus_left',
    'Focus the pane to the left',
    ShortcutGroup.panes,
    action: ShortcutAction.focusPaneLeft,
    repeatable: true,
  ),
  const HarnessCommand(
    'pane.focus_right',
    'Focus the pane to the right',
    ShortcutGroup.panes,
    action: ShortcutAction.focusPaneRight,
    repeatable: true,
  ),
  const HarnessCommand(
    'pane.focus_above',
    'Focus the pane above',
    ShortcutGroup.panes,
    action: ShortcutAction.focusPaneAbove,
    repeatable: true,
  ),
  const HarnessCommand(
    'pane.focus_below',
    'Focus the pane below',
    ShortcutGroup.panes,
    action: ShortcutAction.focusPaneBelow,
    repeatable: true,
  ),
  const HarnessCommand(
    'pane.move_left',
    'Move the pane left',
    ShortcutGroup.panes,
    action: ShortcutAction.movePaneLeft,
    repeatable: true,
  ),
  const HarnessCommand(
    'pane.move_right',
    'Move the pane right',
    ShortcutGroup.panes,
    action: ShortcutAction.movePaneRight,
    repeatable: true,
  ),
  const HarnessCommand(
    'pane.move_up',
    'Move the pane up',
    ShortcutGroup.panes,
    action: ShortcutAction.movePaneUp,
    repeatable: true,
  ),
  const HarnessCommand(
    'pane.move_down',
    'Move the pane down',
    ShortcutGroup.panes,
    action: ShortcutAction.movePaneDown,
    repeatable: true,
  ),
  const HarnessCommand(
    'pane.zoom',
    'Zoom or restore the focused pane',
    ShortcutGroup.panes,
    action: ShortcutAction.zoomPane,
    nativeAction: 'zoomPane',
  ),
  const HarnessCommand(
    'pane.close',
    'Close the focused pane',
    ShortcutGroup.panes,
    action: ShortcutAction.closePane,
    nativeAction: 'closePane',
  ),
  const HarnessCommand(
    'pane.last',
    'Return to the last pane',
    ShortcutGroup.panes,
    action: ShortcutAction.lastPane,
  ),
  const HarnessCommand(
    'pane.pin',
    'Pin or unpin the focused pane',
    ShortcutGroup.panes,
    action: ShortcutAction.pinPane,
    nativeAction: 'pinPane',
  ),
  const HarnessCommand(
    'pane.layout',
    'Choose a layout',
    ShortcutGroup.panes,
    action: ShortcutAction.showLayout,
    nativeAction: 'layout',
  ),
  const HarnessCommand('pane.resize', 'Resize panes', ShortcutGroup.panes),
  const HarnessCommand(
    'pane.split_right',
    'Split right…',
    ShortcutGroup.panes,
    extraKeys: ['cmd+r'],
    nativeAction: 'splitRight',
  ),
  const HarnessCommand(
    'pane.split_down',
    'Split down…',
    ShortcutGroup.panes,
    extraKeys: ['cmd+d'],
    nativeAction: 'splitDown',
  ),
  const HarnessCommand(
    'pane.reset_sizes',
    'Reset pane sizes',
    ShortcutGroup.panes,
  ),
  const HarnessCommand(
    'terminal.find',
    'Find in the focused terminal',
    ShortcutGroup.navigate,
    action: ShortcutAction.findTerminal,
    nativeAction: 'findTerminal',
  ),
  const HarnessCommand(
    'terminal.find_next',
    'Next terminal match',
    ShortcutGroup.navigate,
    action: ShortcutAction.findNext,
    nativeAction: 'findNext',
    repeatable: true,
  ),
  const HarnessCommand(
    'terminal.find_previous',
    'Previous terminal match',
    ShortcutGroup.navigate,
    action: ShortcutAction.findPrevious,
    nativeAction: 'findPrevious',
    repeatable: true,
  ),
  const HarnessCommand(
    'agent.add',
    'Open Harness',
    ShortcutGroup.actions,
    action: ShortcutAction.addAgent,
    nativeAction: 'addAgent',
  ),
  const HarnessCommand(
    'agent.new',
    'New Harness',
    ShortcutGroup.actions,
    action: ShortcutAction.newAgent,
    nativeAction: 'newAgent',
  ),
  const HarnessCommand(
    'machines.manage',
    'Open Machines Manager',
    ShortcutGroup.actions,
    nativeAction: 'manageMachines',
  ),
  const HarnessCommand(
    'machine.link',
    'Link machine',
    ShortcutGroup.actions,
    nativeAction: 'linkMachine',
  ),
  const HarnessCommand(
    'project.add',
    'Add project',
    ShortcutGroup.actions,
    nativeAction: 'addProject',
  ),
  const HarnessCommand(
    'machines.refresh',
    'Refresh machines and agents',
    ShortcutGroup.actions,
    action: ShortcutAction.reload,
    nativeAction: 'reload',
  ),
  const HarnessCommand(
    'task.route',
    'Boss mode: route a task',
    ShortcutGroup.actions,
    action: ShortcutAction.routeTask,
  ),
  const HarnessCommand(
    'project.orchestrate',
    'Create with the orchestrator',
    ShortcutGroup.actions,
    action: ShortcutAction.orchestrate,
  ),
  const HarnessCommand(
    'app.settings',
    'Open Settings',
    ShortcutGroup.actions,
    action: ShortcutAction.showSettings,
    nativeAction: 'settings',
  ),
  const HarnessCommand(
    'keyboard.help',
    'Keyboard shortcuts',
    ShortcutGroup.actions,
    action: ShortcutAction.showShortcuts,
    nativeAction: 'showShortcuts',
  ),
  const HarnessCommand(
    'keyboard.open_config',
    'Open keyboard config',
    ShortcutGroup.actions,
    nativeAction: 'openKeymap',
  ),
  if (kDebugSurfaceEnabled)
    const HarnessCommand(
      'app.debug',
      'Open the debug log',
      ShortcutGroup.actions,
      action: ShortcutAction.showDebug,
    ),
  const HarnessCommand(
    'picker.next',
    'Next result',
    ShortcutGroup.navigate,
    extraKeys: ['down', 'ctrl+n', 'ctrl+j'],
    context: KeymapContext.picker,
    repeatable: true,
  ),
  const HarnessCommand(
    'picker.previous',
    'Previous result',
    ShortcutGroup.navigate,
    extraKeys: ['up', 'ctrl+p', 'ctrl+k'],
    context: KeymapContext.picker,
    repeatable: true,
  ),
  const HarnessCommand(
    'picker.preview_page_up',
    'Scroll preview up',
    ShortcutGroup.navigate,
    extraKeys: ['pageup'],
    context: KeymapContext.picker,
    repeatable: true,
  ),
  const HarnessCommand(
    'picker.preview_page_down',
    'Scroll preview down',
    ShortcutGroup.navigate,
    extraKeys: ['pagedown'],
    context: KeymapContext.picker,
    repeatable: true,
  ),
  const HarnessCommand(
    'picker.accept',
    'Open the selected result',
    ShortcutGroup.navigate,
    extraKeys: ['enter'],
    context: KeymapContext.picker,
  ),
  const HarnessCommand(
    'picker.add_here',
    'Add the selected agent',
    ShortcutGroup.actions,
    extraKeys: ['cmd+enter'],
    context: KeymapContext.picker,
  ),
  const HarnessCommand(
    'picker.cancel',
    'Close search',
    ShortcutGroup.navigate,
    extraKeys: ['escape', 'ctrl+g'],
    context: KeymapContext.picker,
  ),
];

final harnessCommandById = {
  for (final command in harnessCommands) command.id: command,
};
final harnessDefaultBindings = [
  for (final command in harnessCommands)
    for (final keys in command.keys)
      KeyBinding(
        keys: keys.split(' ').map(KeyStroke.parse),
        command: command.id,
        context: command.context,
      ),
];
final harnessDefaultKeymap = ResolvedKeymap(
  harnessDefaultBindings,
  const KeymapConfig.empty(),
);

List<String> describeKeyStrokeKeys(KeyStroke stroke) => [
  if (stroke.control) '⌃',
  if (stroke.alt) '⌥',
  if (stroke.shift) '⇧',
  if (stroke.command) '⌘',
  const {
        'left': '←',
        'right': '→',
        'up': '↑',
        'down': '↓',
        'pageup': 'Page Up',
        'pagedown': 'Page Down',
        'enter': '↵',
        'escape': 'Esc',
        'tab': '⇥',
        'space': 'Space',
        'comma': ',',
        'period': '.',
        'slash': '/',
        'backslash': r'\',
        'semicolon': ';',
        'quote': "'",
        'backquote': '`',
        'bracketleft': '[',
        'bracketright': ']',
        'minus': '-',
        'equal': '=',
        'backspace': '⌫',
        'delete': '⌦',
      }[stroke.key] ??
      stroke.key.toUpperCase(),
];
String describeKeyStroke(KeyStroke stroke) =>
    describeKeyStrokeKeys(stroke).join();
String describeKeyBinding(KeyBinding binding) =>
    binding.keys.map(describeKeyStroke).join(' ');
