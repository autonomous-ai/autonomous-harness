# Vendored xterm.dart

This directory contains the MIT-licensed `xterm` 4.0.0 package used by the
desktop app. It is pinned in-tree because that release corrupts
`IndexAwareCircularBuffer` ownership when `Buffer.scrollUp` or
`Buffer.scrollDown` moves line objects through repeated `operator []=` calls.

The local patch adds an atomic same-length `replaceRange` operation and uses it
for vertical scroll regions. This preserves line identity (and selection
anchors) without temporarily storing the same `BufferLine` in multiple slots.
Remove the vendored dependency once the upstream package ships an equivalent
fix and the regression in `test/terminal_session_test.dart` passes against it.

## Local patches

- **Remote grids survive viewport resizing** (`lib/src/terminal_view.dart`,
  `lib/src/ui/render.dart`). `TerminalView.resizeBuffer` defaults to true;
  Harness sets it to false so a smaller local pane reports its desired size
  without deleting rows from the captured remote screen. The next remote
  keyframe supplies the resized grid. Repeated output does not repeat the
  resize request. Regressions: `test/terminal_initial_output_test.dart`, including
  a tall screen with its cursor parked above the newest output, five fresh
  panes, delayed snapshots, and preserved reading positions on return.

- **On-demand terminal find** (`lib/src/core/buffer/line.dart`,
  `lib/src/terminal.dart`). Text mutations advance a local line version so a
  search can reuse decoded rows; color-only changes keep the version. Optional
  resize listeners run after buffer reflow without replacing the transport's
  `onResize` callback. Search attaches only while visible with a nonempty query.
  Regressions: `test/terminal_search_test.dart`, `test/terminal_find_test.dart`.

- **Host-handled primary clicks** (`lib/src/terminal_view.dart`,
  `lib/src/ui/gesture/gesture_handler.dart`). `onTapUp` was declared but never
  dispatched by the single-click path. It now runs, and a consuming `onTapDown`
  lets Desktop own modifier-clicks without also sending mouse reports to a TUI.
  Ordinary clicks and drag selection keep their existing behavior. Regressions:
  `test/terminal_link_gesture_test.dart`, `test/terminal_panel_links_test.dart`.

Each of these has to survive an upstream bump — the tests named are what catch
it if one is dropped.

1. **Atomic `replaceRange` for scroll regions** (the reason this copy exists at
   all — see above). Regression: `test/terminal_session_test.dart`.

2. **Backspace is only handed to the native text input client on Apple
   platforms** (`lib/src/terminal_view.dart`). The key is deliberately not
   turned into bytes there, so that an IME can use it internally (Telex types
   `ư` as `u` + backspace + `ư`); macOS returns it as the `deleteBackward:`
   selector over `TextInputClient.performSelectors`. The GTK embedder has no
   such channel method and names `GDK_KEY_BackSpace` explicitly to ignore it —
   correct for an `EditableText`, wrong for the bare `TextInputClient` here —
   so upstream's unconditional version dropped the key entirely on Linux and no
   byte reached the pty. Regression: the macOS/Linux pair in
   `test/terminal_view_interaction_test.dart`.

3. **A Meta chord is left for the app on every platform, not just Apple**
   (`lib/src/terminal_view.dart`). Every shortcut in
   `lib/shortcuts/app_shortcuts.dart` is declared `meta: true`, which is Super
   on Linux; while this was gated on macOS/iOS a focused terminal answered
   Super+key itself and no app shortcut worked with a pane open. Regression:
   `test/terminal_view_interaction_test.dart`.

4. **Erase-left accepts a cursor in the first column**
   (`lib/src/core/buffer/line.dart`, `lib/src/core/buffer/buffer.dart`). `CSI 1 K`
   at column zero previously passed an empty range to `BufferLine.eraseRange`,
   which read cell `-1` while checking a wide-character boundary. The range
   guard now accepts an empty range, and erase-left includes the cursor cell as
   required by its terminal contract. Regression: `test/terminal_session_test.dart`.

5. **String sequences (DCS/APC/PM/SOS) are consumed instead of leaking**
   (`lib/src/core/escape/parser.dart`). `ESC P` had no handler, so its body was
   handed to the text path one fragment at a time. tmux wraps passthrough as
   `ESC P tmux; <body> ESC \` and doubles every ESC inside that body, so a
   program asking the outer terminal for its background colour from inside tmux
   painted `tmux;]11;?` into the pane — seen in Claude Code's theme picker.
   Only ST ends the body: neither the doubled `ESC ESC` nor an inner OSC's BEL
   may terminate it, and a body split across two pty chunks rolls back and waits
   the same way `_consumeOsc` does. Regression: the two string-sequence tests in
   `test/terminal_session_test.dart`.

6. **The selection/highlight rectangle is painted at the render box's own paint
   offset, not at (0,0)** (`lib/src/ui/render.dart`). `_paintHighlights`/
   `_paintSelection`/`_paintSegment` never received the `offset` `paint()` is
   handed — unlike the line-glyph and cursor paints right above them, which
   both add it — so whenever this box has a non-zero paint offset (the pane's
   own padding, in this app) the highlighted rectangle was drawn shifted away
   from the glyphs it was supposed to cover, leaving trailing selected
   characters rendered outside the box instead of inside it. No regression
   test (would need a golden/paint-offset test harness this repo doesn't
   have yet) — verify visually: drag-select text ending near the right edge
   of a padded pane and confirm the highlight covers every selected glyph.

7. **`BufferLine.getText` renders a blank cell as a literal space instead of
   dropping it** (`lib/src/core/buffer/line.dart`). A cell whose stored
   codePoint is 0 — never written, or erased — was skipped outright rather
   than emitting anything, so a gap laid out with cursor-forward (CSI `C`)
   instead of literal space bytes (the normal way TUI output from Claude Code,
   Codex, etc. positions text and indentation) copied as nothing: two words
   glued together with no separator, leading indentation gone. Only the
   second half of a wide character also stores codePoint 0 and must still be
   skipped (checked via the preceding cell's width being 2), and only
   *trailing* blank cells stay trimmed — a wholly blank line still copies as
   empty, not as columns of padding. Regression: `test/terminal_session_test.dart`
   (`'copied text keeps cursor-positioned gaps as spaces...'` and the
   erase-left test, which now expects a leading space where the erased cell
   is).

8. **Shift+Left/Right reach the TUI in both screen buffers**
   (`lib/src/core/input/keytab/keytab_default.dart`). The upstream mapping
   required the alternate screen, so a normal-screen Codex terminal emitted
   no input for its "shift + left to answer" queued-question shortcut. Both
   horizontal chords now send the xterm modifier sequence in either buffer;
   vertical scrolling and app-owned Meta shortcuts keep their bindings.
   Regression: the macOS/Linux pair in `test/terminal_panel_focus_test.dart`
   exercises physical key events through `TerminalPanel` to binary PTY input.

9. **A software keyboard is allowed to compose**
   (`lib/src/ui/custom_text_edit.dart`). The strict
   `autocorrect: false` / `enableSuggestions: false` this connection attached
   with is right for a hardware keyboard — a desktop IME composes through
   marked text, which neither flag touches — but on a phone those two flags ARE
   the IME: iOS maps `autocorrect` onto `UITextAutocorrectionTypeNo` and
   Android maps `enableSuggestions` onto `TYPE_TEXT_FLAG_NO_SUGGESTIONS`, and
   with no pre-edit buffer to work in a Vietnamese Telex keyboard converted
   nothing — `hoom` reached the pty as four raw letters instead of `hôm`, and a
   CJK candidate window never opened. iOS and Android now attach with
   composition left on (iOS needs `autocorrect`, the only knob it has; Android
   needs `enableSuggestions` and keeps autocorrection itself off), and smart
   dashes and quotes — which default to ENABLED, and which iOS only acts on
   once autocorrect is on — are switched off on every platform so `"` and
   `--flag` stay syntax rather than typography. Regression:
   `mobile/test/terminal_ime_input_test.dart`, the only build that reaches the
   mobile branch.

10. **The keyboard may paste, and may hand over an image**
    (`lib/src/ui/custom_text_edit.dart`, `lib/src/terminal_view.dart`).
    `enableIMEPersonalizedLearning: false` reads as a privacy default and is
    not one on Android: it sets `IME_FLAG_NO_PERSONALIZED_LEARNING`, which puts
    Gboard in incognito mode, and incognito replaces the toolbar with the
    incognito glasses — taking the CLIPBOARD with it. A phone has no ⌘V and no
    readable system clipboard for anything but `text/plain`, so that one flag
    left a pane with no way to receive text from elsewhere on the device at
    all. The two are one switch in Gboard; the cost of turning it back on is
    that words typed at this prompt are learned, masked password prompts
    included, since a pty cannot tell the keyboard one is open.

    Images are a second, separate refusal: Gboard rejects them in the keyboard
    with "the current app does not allow pasting images here" whenever
    `EditorInfo.contentMimeTypes` is empty, which is what Flutter sends while
    `allowedMimeTypes` is unset — before any Dart runs, so `insertContent`
    being an empty stub was never the reason. It is now forwarded through
    `TerminalView.onContentInserted`, and the embedder decides what an image
    means; `mobile/lib/widgets/terminal_panel.dart` sends it as the chunked
    `TerminalSession.pasteImage` upload, which on a phone is the only path
    there is — every pane is remote.

    ⚠️ `image/png` alone, and not because other types are rare: the daemon
    names what it receives `<uuid>.png` outright
    (`cli/src/lib/pasteDropFiles.ts`), so a JPEG would arrive under a name that
    lies about it. Widening this means teaching the CLI the real type first.

    ⚠️ Kept out of the desktop copy deliberately. The flag is Android-only, and
    desktop reads images through `NativeClipboard` on ⌘V instead — mirroring it
    there would have been an inert change carrying a privacy decision made for
    a platform that never sees it.

11. **Return does not leave the line it just sent sitting in the prompt**
    (`lib/src/ui/custom_text_edit.dart`). iOS answers the Return key by calling
    `performAction` and then inserting the `\n` into its own buffer anyway:
    `shouldChangeTextInRange:` returns YES for the default return key
    (`FlutterTextInputPlugin.mm`). So an editing value the terminal has ALREADY
    acted on arrives right after the action — by which point
    `resetEditingState` has emptied the mirror, so the diff retyped the whole
    line into the pty and followed it with a literal LF. A TUI reads that as
    Ctrl+J, a soft newline rather than a submit, so the message the user just
    sent reappeared in the prompt underneath its own answer. That one value is
    now recognised by its shape, dropped, and the native buffer put back on the
    state the action left. It is one shot, so real typing after a submit is
    never swallowed, and Android performs its editor action without the second
    insert so nothing there matches. Regression:
    `mobile/test/terminal_ime_input_test.dart`.

12. **Backspace sent as a key keeps the keyboard's buffer in step**
    (`lib/src/ui/custom_text_edit.dart`). Gboard delivers Backspace as a
    `KeyDownEvent`, not as an edit to its buffer, and the terminal consumed the
    key — deleting on the pty while the buffer the keyboard edits kept the
    letter. After "xin chào" and four Backspaces the keyboard still held
    "xin chào" and appended the next word to it; when Telex re-marked that run,
    the diff deleted and retyped characters already gone ("chào" came out as
    "xiaochaof"). On a phone, a plain Backspace over a non-empty buffer is now
    applied to the buffer itself and handed back to the keyboard, and the pty
    gets the same single delete through the usual sync. An empty buffer still
    sends it straight on; Ctrl/Alt/Meta+Backspace and desktop platforms are
    untouched.

13. **Delete detection survives a kept buffer**
    (`lib/src/ui/custom_text_edit.dart`). iOS answers Backspace over an empty
    native buffer with nothing at all (`deleteBackward` in
    `FlutterTextInputPlugin.mm`), so the phone turns `deleteDetection` on and
    Backspace eats a two-space padding instead. Upstream reset the buffer after
    every edit, which refilled it; this copy keeps the buffer between keys for
    Telex (note 12's neighbour), so two Backspaces into a line the keyboard
    never typed — a voice transcript, a recalled command — spent the padding and
    Backspace went dead. The buffer is now reset whenever the padding has been
    eaten into, and the Return echo of note 11 also matches a newline appended
    to the padding. Regression: `mobile/test/terminal_ime_input_test.dart`.

14. **A plain space paints nothing** (`lib/src/ui/painter.dart`). Every frame
    paints every cell on screen, one `drawParagraph` per cell, and a TUI's
    screen is mostly spaces — padding, box interiors, the tail of every short
    line. A space has no ink (its colour is the background pass's), so it now
    returns before the hash, the cache lookup and the draw. An underlined
    space still draws, through the existing U+00A0 substitution. Regression:
    `mobile/test/terminal_painter_test.dart`.
15. **Alt-buffer scrolling survives a new scroll position**
    (`lib/src/ui/infinite_scroll_view.dart`). `_RenderInfiniteScrollView`
    listened for `_onScroll` on the position it was attached with, and its
    `position` setter moved only the layout listener. The Scrollable replaces
    its position whenever its dependencies change — a route pushed over the
    terminal and popped is enough — so from then on no drag reached the
    full-screen program as wheel events or arrow keys, until the view was
    rebuilt. The setter now moves `_onScroll` with it. Regression:
    `mobile/test/terminal_alt_scroll_test.dart`.

16. **An embedder can empty the keyboard's buffer**
    (`lib/src/terminal_view.dart`). `TerminalViewState.clearInputBuffer()`
    resets the native editing state the way a submitted line does. The phone's
    key strip clears the prompt with Ctrl+E Ctrl+U and types `/` and Tab
    without the keyboard seeing them; left holding the old words, the keyboard
    would edit them again — Telex re-marks the word it believes is being typed
    and would rub out characters the prompt no longer holds.
