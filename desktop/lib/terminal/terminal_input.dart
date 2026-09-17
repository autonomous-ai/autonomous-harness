import 'package:xterm/xterm.dart';

/// Makes ⌥ the Meta key for the two chords an engine's prompt reads as line editing: ⌥⏎ breaks the
/// line instead of submitting it, and ⌥⌫ kills the word behind the caret instead of doing nothing.
///
/// Claude Code, Codex and every other Ink/readline prompt read Meta+Enter — `ESC` followed by the
/// ordinary Return bytes — as "add a line, do not send this turn yet", and Meta+Backspace — `ESC`
/// followed by `\x7f` — as "delete the word behind me". A real terminal produces those only when it
/// is configured to treat ⌥ as Meta (iTerm's "Esc+", Terminal.app's "Use Option as Meta Key");
/// xterm.dart has no such setting, and its [AltInputHandler] deliberately does nothing on macOS so
/// ⌥ stays the compose key for `å`/`ø`/`¬`. So ⌥⏎ fell through to the keytab, which matches on
/// `Return` alone and answers `\r` — the submit. ⌥⌫ never even reached the keytab: macOS hands
/// Backspace to the native text input client, which answers `deleteBackward:` and has no idea what
/// ⌥ adds (see patch 2 in `third_party/xterm/README.autonomous.md`). Both keys the shortcuts sheet
/// promises (`kTerminalOwnedKeys`) did the wrong thing, or nothing at all.
///
/// ⌥ is Meta for THESE KEYS, not for the keyboard: neither carries a character to compose, so
/// prefixing them costs nothing that ⌥-as-compose needs, and the rest of the alphabet is untouched.
///
/// The base bytes are asked of [_inner] rather than written out here, because neither key has one
/// fixed answer: under LNM (`lineFeedMode`) the keytab answers Return with `\r\n` rather than
/// `\r`, and a caller may pass a keytab of its own. Alt and Shift are cleared for that question — Alt so the keytab does not see the very
/// modifier being translated (it has a rule of its own for ⌥⌫, `\x17`, which this replaces with the
/// word-boundary kill a Mac field does), Shift so ⌥⇧⏎ yields a prefixed Return rather than a
/// prefixed `\EOM`, which no prompt would recognise.
class AltAsMetaInputHandler implements TerminalInputHandler {
  const AltAsMetaInputHandler(this._inner);

  final TerminalInputHandler _inner;

  /// The keys ⌥ prefixes. Enter and Backspace only — see the note above about the compose key.
  static const _metaKeys = {
    TerminalKey.enter,
    TerminalKey.numpadEnter,
    TerminalKey.backspace,
  };

  @override
  String? call(TerminalKeyboardEvent event) {
    // ⌃⌥ is left alone: that chord belongs to whatever is running, not to this.
    if (!event.alt || event.ctrl || !_metaKeys.contains(event.key)) {
      return _inner(event);
    }
    final base = _inner(event.copyWith(alt: false, shift: false));
    if (base == null) return null;
    return '\x1b$base';
  }
}

/// The handler every pane's [Terminal] is built with — xterm's default behaviour, plus ⌥⏎ and ⌥⌫.
const TerminalInputHandler harnessInputHandler = AltAsMetaInputHandler(
  defaultInputHandler,
);
