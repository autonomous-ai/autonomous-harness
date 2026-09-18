import 'dart:io';

import 'package:flutter/widgets.dart';

import '../core/host_platform.dart';
import 'app_shortcuts.dart';
import 'keymap.dart';
import 'keymap_commands.dart';
import 'keymap_store.dart';

/// A window's configuration, injectable so tests never read a user's dotfiles.
class AppKeymap extends ChangeNotifier {
  AppKeymap({this.store}) {
    store?.addListener(_changed);
  }
  final KeymapStore? store;
  int version = 0;
  ResolvedKeymap get current => store?.current ?? harnessDefaultKeymap;
  String? get error => store?.error;
  String? get path => store?.file.path;
  void _changed() {
    version++;
    notifyListeners();
  }

  Future<void> start() async {
    await store?.start();
  }

  static KeymapStore fileStore() => KeymapStore(
    file: File(KeymapStore.defaultPath()),
    defaults: harnessDefaultBindings,
    commands: harnessCommandById.keys.toSet(),
    validate: (map) => validateNativeKeys(map, macOS: Platform.isMacOS),
    // ⚠️ **Not watched on a phone, and the file is not editable there either.**
    // Watching costs a symlink walk up the whole path and a `Directory.watch`
    // per parent — and iOS does not implement `Directory.watch` at all, so
    // every one of those throws, each failure schedules another reload, and the
    // walk runs again. That whole sequence is on the critical path before the
    // first frame (see `startHarness`), to notice edits to a dotfile that a
    // touchscreen has no way to produce: there is no shell, no editor, and no
    // sync into the app's sandbox. The file is still READ, so a keyboard
    // attached to an iPad keeps whatever bindings a build ships with.
    watchFiles: !isMobileHost,
  );

  Iterable<KeyBinding> bindings(
    String command, {
    KeymapContext context = KeymapContext.workspace,
  }) => current
      .bindingsFor(context)
      .where((binding) => binding.command == command);

  String? hint(
    String command, {
    KeymapContext context = KeymapContext.workspace,
  }) {
    final binding = bindings(command, context: context).firstOrNull;
    return binding == null ? null : describeKeyBinding(binding);
  }

  /// These are names of actual AppKit commands, not all system shortcuts.
  /// Native editing is dispatched before Flutter, including sequence suffixes.
  static void validateNativeKeys(ResolvedKeymap map, {required bool macOS}) {
    if (!macOS) return;
    final reserved = {
      for (final chord in [
        'cmd+q',
        'cmd+m',
        'cmd+alt+h',
        'cmd+ctrl+f',
        'cmd+c',
        'cmd+v',
        'cmd+x',
        'cmd+a',
        'cmd+z',
        'cmd+shift+z',
        'cmd+alt+shift+v',
        'cmd+backquote',
        'cmd+shift+backquote',
        'cmd+0',
        'cmd+equal',
        'cmd+shift+equal',
        'cmd+minus',
      ])
        KeyStroke.parse(chord),
    };
    for (final context in KeymapContext.values) {
      for (final binding in map.bindingsFor(context)) {
        final conflict = binding.keys.where(reserved.contains).firstOrNull;
        if (binding.custom && conflict != null) {
          throw FormatException(
            '$conflict belongs to a native Mac editing, font or window command; choose another key',
          );
        }
      }
    }
  }

  @override
  void dispose() {
    store?.removeListener(_changed);
    super.dispose();
  }
}

/// InheritedTheme lets dialogs/routes carry the same live configuration.
/// The provider rebuilds only on config changes, never on individual keys.
class KeymapProvider extends StatelessWidget {
  const KeymapProvider({super.key, required this.keymap, required this.child});
  final AppKeymap keymap;
  final Widget child;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: keymap,
    builder: (context, _) =>
        KeymapTheme(keymap: keymap, version: keymap.version, child: child),
  );
}

class KeymapTheme extends InheritedTheme {
  const KeymapTheme({
    super.key,
    required this.keymap,
    required this.version,
    required super.child,
  });
  final AppKeymap keymap;
  final int version;
  static AppKeymap? of(BuildContext context, {bool listen = true}) =>
      (listen
              ? context.dependOnInheritedWidgetOfExactType<KeymapTheme>()
              : context.getInheritedWidgetOfExactType<KeymapTheme>())
          ?.keymap;
  @override
  bool updateShouldNotify(KeymapTheme oldWidget) =>
      keymap != oldWidget.keymap || version != oldWidget.version;
  @override
  Widget wrap(BuildContext context, Widget child) =>
      KeymapProvider(keymap: keymap, child: child);
}

/// Pickers provide their own actions. A terminal only changes scope/IME state;
/// the containing workspace continues to own its navigation commands.
class KeymapRegion extends InheritedWidget {
  const KeymapRegion({
    super.key,
    required this.contextKind,
    this.actions,
    this.composing,
    required super.child,
  });
  final KeymapContext contextKind;
  final Map<String, VoidCallback>? actions;
  final bool Function()? composing;
  static KeymapRegion? of(BuildContext context) =>
      context.getInheritedWidgetOfExactType<KeymapRegion>();
  @override
  bool updateShouldNotify(KeymapRegion oldWidget) => false;
}

String? effectiveShortcutHint(BuildContext context, ShortcutAction action) {
  final command = harnessCommands
      .where((command) => command.action == action)
      .firstOrNull;
  final map = KeymapTheme.of(context);
  if (command == null) return null;
  final binding = (map?.current ?? harnessDefaultKeymap)
      .bindingsFor(KeymapContext.workspace)
      .where((binding) => binding.command == command.id)
      .firstOrNull;
  return binding == null ? null : describeKeyBinding(binding);
}

String withEffectiveShortcutHint(
  BuildContext context,
  String label,
  ShortcutAction action,
) {
  final hint = effectiveShortcutHint(context, action);
  return hint == null ? label : '$label  $hint';
}

String? effectiveCommandHint(
  BuildContext context,
  String command, {
  KeymapContext contextKind = KeymapContext.workspace,
}) {
  final bindings = (KeymapTheme.of(context)?.current ?? harnessDefaultKeymap)
      .bindingsFor(contextKind);
  final binding = bindings
      .where((binding) => binding.command == command)
      .firstOrNull;
  return binding == null ? null : describeKeyBinding(binding);
}

List<ShortcutRow> effectiveShortcutRows(
  BuildContext context,
  KeymapContext contextKind,
) {
  final map = KeymapTheme.of(context)?.current;
  if (map == null && contextKind == KeymapContext.workspace) {
    return shortcutRows();
  }
  final bindings = (map ?? harnessDefaultKeymap).bindingsFor(contextKind);
  final defaultDigits =
      contextKind != KeymapContext.picker &&
      List.generate(kTabDigitCount, (i) {
        final matches = bindings
            .where((b) => b.command == 'swarm.select_${i + 1}')
            .toList();
        return matches.length == 1 &&
            matches.single.keys.length == 1 &&
            matches.single.keys.single == KeyStroke.parse('cmd+${i + 1}');
      }).every((value) => value);
  final shortcuts = appShortcuts();
  return [
    for (final command in harnessCommands)
      if ((command.context == KeymapContext.workspace ||
              command.context == contextKind) &&
          (!defaultDigits ||
              !RegExp(r'^swarm\.select_[1-9]$').hasMatch(command.id)))
        if (command.action != null ||
            bindings.any((b) => b.command == command.id))
          ShortcutRow(
            label:
                shortcuts
                    .where((s) => s.action == command.action)
                    .firstOrNull
                    ?.label ??
                command.label,
            chords: [
              for (final binding in bindings.where(
                (b) => b.command == command.id,
              ))
                binding.keys.length == 1
                    ? describeKeyStrokeKeys(binding.keys.single)
                    : [
                        describeKeyBinding(binding)
                            .replaceAll('↵', 'Return')
                            .replaceAll('⇥', 'Tab'),
                      ],
            ],
            group: command.group,
          ),
    if (defaultDigits)
      const ShortcutRow(
        label: 'Select tabs 1–9',
        chords: [
          ['⌘', '1 – 9'],
        ],
        group: ShortcutGroup.navigate,
      ),
  ];
}
