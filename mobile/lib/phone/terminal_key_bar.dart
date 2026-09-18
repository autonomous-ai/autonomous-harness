import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:xterm/xterm.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'phone_sheet.dart';

/// The keys a phone keyboard does not have, in a strip above the one it does.
///
/// A pane is driven by `esc` and the arrows far more than by anything the
/// alphabet offers — interrupting Claude Code, walking shell history, moving
/// through a menu. None of them exist on a software keyboard, so
/// until this strip a phone could type at an agent but could not DRIVE one.
///
/// It appears with the keyboard and goes away with it: the terminal is short
/// enough on a phone that chrome is worth its height only while someone is
/// actually typing.
///
/// ⚠️ **ONE row, fixed, and nothing scrolls.** It used to be two — `↵`, `⇧tab`,
/// `ctrl` and a row of digits beside what is here now — and the second row cost
/// the terminal a line of output for keys the system keyboard below already
/// types (the digits) or that were rarely reached for. What is left is what a
/// phone keyboard cannot produce, or buries, and a pane is driven by:
///
/// ```
/// esc tab clear ← ↑ ↓ → /  │  🖼 ⌄
/// ```
///
/// Every key stays in the same place every time; this strip is used while
/// looking at the TERMINAL, not at the strip.
class TerminalKeyBar extends StatelessWidget {
  const TerminalKeyBar({
    super.key,
    required this.terminal,
    required this.enabled,
    required this.onDismissKeyboard,
    this.onClearPrompt,
    this.onPromptEdited,
    this.onPickImage,
    this.onTakePhoto,
  });

  final Terminal terminal;

  /// The `clear` key: empties the prompt being typed into. Null leaves the key
  /// out.
  final VoidCallback? onClearPrompt;

  /// Called after `tab` or `/` changed the prompt without the software
  /// keyboard knowing — so its buffer can be emptied before it edits words the
  /// prompt no longer holds.
  final VoidCallback? onPromptEdited;

  /// False while the stream is not accepting input — the strip stays visible
  /// (it moves with the keyboard, and a row that vanished would take the
  /// keyboard's place with it) but dims and stops answering.
  final bool enabled;

  final VoidCallback onDismissKeyboard;

  /// Sending a picture. Null on a pane that cannot take one — an older CLI that
  /// never advertised `terminalImagePasteAvailable` — and the key is then not
  /// drawn at all rather than drawn dead: a key that does nothing is worse than
  /// one that was never offered.
  final VoidCallback? onPickImage;
  final VoidCallback? onTakePhoto;

  bool get _canSendImage => onPickImage != null || onTakePhoto != null;

  void _send(void Function() action) {
    if (!enabled) return;
    HapticFeedback.selectionClick();
    action();
  }

  /// The image key: asks WHICH picture, then hands off.
  ///
  /// The sheet only appears where there is a choice to make. A build with just
  /// one of the two wired goes straight there instead — a sheet with a single
  /// row is a tap spent on nothing.
  void _sendImage(BuildContext context) {
    final pick = onPickImage;
    final photo = onTakePhoto;
    if (pick == null) {
      photo?.call();
      return;
    }
    if (photo == null) {
      pick();
      return;
    }
    showPhoneSheet(
      context,
      title: 'Send a picture to this agent',
      actions: [
        PhoneSheetAction(
          icon: LucideIcons.image300,
          label: 'Choose from library',
          onTap: pick,
        ),
        PhoneSheetAction(
          icon: LucideIcons.camera300,
          label: 'Take a photo',
          onTap: photo,
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    // What drives an engine and a phone keyboard lacks: leave a mode, walk
    // history, move through a menu.
    final onClearPrompt = this.onClearPrompt;
    final keys = <Widget>[
      _key(label: 'esc', onTap: () => terminal.keyInput(TerminalKey.escape)),
      // Completes a path or a command, and moves through Claude Code's menus.
      _key(
        label: 'tab',
        onTap: () {
          terminal.keyInput(TerminalKey.tab);
          onPromptEdited?.call();
        },
      ),
      if (onClearPrompt != null) _key(label: 'clear', onTap: onClearPrompt),
      _key(
        icon: LucideIcons.arrowLeft300,
        semanticLabel: 'Left',
        onTap: () => terminal.keyInput(TerminalKey.arrowLeft),
      ),
      _key(
        icon: LucideIcons.arrowUp300,
        semanticLabel: 'Up',
        onTap: () => terminal.keyInput(TerminalKey.arrowUp),
      ),
      _key(
        icon: LucideIcons.arrowDown300,
        semanticLabel: 'Down',
        onTap: () => terminal.keyInput(TerminalKey.arrowDown),
      ),
      _key(
        icon: LucideIcons.arrowRight300,
        semanticLabel: 'Right',
        onTap: () => terminal.keyInput(TerminalKey.arrowRight),
      ),
      // Last before the rule, beside the image key: how a slash command
      // starts, and a phone keyboard buries `/` a layer down.
      _key(
        label: '/',
        onTap: () {
          terminal.textInput('/');
          onPromptEdited?.call();
        },
      ),
    ];
    // ⚠️ **Neither of these sends a byte anywhere**, and that is why they sit
    // apart from the grid rather than in it. Every key to the left of the rule
    // is a keystroke the pty receives; these two act on the PHONE — one opens an
    // OS picker, the other drops the keyboard. Sharing a row taught the eye they
    // were the same kind of thing, and an image button that looks like `esc`
    // reads as something that will be typed at the agent.
    final apart = <Widget>[
      if (_canSendImage)
        _key(
          icon: LucideIcons.image300,
          semanticLabel: 'Send image',
          onTap: () => _sendImage(context),
        ),
      // The way back to a full screen of output, which on a phone is the only
      // way to read one.
      _key(
        icon: LucideIcons.chevronDown300,
        semanticLabel: 'Hide keyboard',
        alwaysEnabled: true,
        onTap: onDismissKeyboard,
      ),
    ];

    return ExcludeFocus(
      // ⚠️ Load-bearing. Every key here is a tap target inside a focus scope the
      // TERMINAL owns: a focusable one would take the focus on tap, the input
      // connection would close, and the keyboard this strip is attached to
      // would leave with it on the first `esc`.
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: AppPalette.panelBg,
          border: Border(top: BorderSide(color: AppGlass.hair)),
        ),
        child: Padding(
          padding: const EdgeInsets.all(6),
          // Held out of the app-wide text scale like the composer's own type:
          // at a large scale the keys stop fitting the row.
          child: MediaQuery.withNoTextScaling(
            // Every key the same width, the two apart ones included — they are
            // separated by the rule, not by being a different size.
            child: Row(
              children: [
                ..._row(keys),
                // The rule earns its place only when there are two kinds of
                // thing to separate. Against an older CLI the image key is
                // absent and `⌄` is all that is left, so a rule drawn for it
                // alone would be marking a distinction that is no longer made.
                if (_canSendImage) ...[
                  const SizedBox(width: 8),
                  Container(width: 1, height: 22, color: AppGlass.hair),
                  const SizedBox(width: 8),
                ] else
                  const SizedBox(width: 4),
                ..._row(apart),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// A run of keys for the strip's one [Row], each `Expanded` with the same
  /// flex — so every key on the strip, on either side of the rule, gets the
  /// same width, and the row fills the phone rather than ending in a gap.
  List<Widget> _row(List<Widget> keys) => [
    for (var index = 0; index < keys.length; index++) ...[
      if (index > 0) const SizedBox(width: 4),
      Expanded(child: keys[index]),
    ],
  ];

  Widget _key({
    String? label,
    IconData? icon,
    String? semanticLabel,
    bool alwaysEnabled = false,
    required VoidCallback onTap,
  }) {
    assert((label == null) != (icon == null), 'a key carries one of the two');
    final live = enabled || alwaysEnabled;
    final foreground = live ? AppPalette.textPrimary : AppPalette.textFaint;
    return Semantics(
      button: true,
      label: semanticLabel ?? label,
      // Named so a test can reach the icon keys, which carry no text.
      key: ValueKey('terminal-key-${semanticLabel ?? label}'),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: alwaysEnabled ? onTap : () => _send(onTap),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 120),
          curve: Curves.easeOut,
          height: 34,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: AppGlass.surfaceFill,
            borderRadius: BorderRadius.circular(7),
            border: Border.all(color: AppGlass.lift),
          ),
          child: icon != null
              ? Icon(icon, size: 16, color: foreground)
              // Shrinks rather than clips: ten keys share a phone's width, and
              // `clear` is the widest word among them.
              : Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 3),
                  child: FittedBox(
                    fit: BoxFit.scaleDown,
                    child: Text(
                      label!,
                      maxLines: 1,
                      style: TextStyle(
                        fontSize: 13,
                        height: 1,
                        color: foreground,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
                ),
        ),
      ),
    );
  }
}
