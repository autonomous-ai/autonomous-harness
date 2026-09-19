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

- **Windows native text input attaches to its Flutter view**
  (`lib/src/ui/custom_text_edit.dart`). Pass `View.of(context).viewId` in the
  text-input configuration. The Windows embedder rejects a null view ID, leaving
  focused terminals able to receive key events but unable to commit typed text.
  Regression: `test/terminal_view_interaction_test.dart`; physically typed text
  was also verified in a native Windows probe using this widget.

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

- **Alternate-screen scrolling reaches the program even when its grid is taller
  than the pane** (`lib/src/ui/scroll_handler.dart`). With `resizeBuffer: false`
  the local grid is the remote one, so a remote screen that has not taken this
  pane's size yet — or that another client keeps larger — leaves the alternate
  screen a few pixels of local scroll extent. The buffer's `Scrollable` sits
  inside `TerminalScrollGestureHandler`, and a Scrollable with somewhere to go
  wins the trackpad pan and the wheel signal, so the TUI received nothing and
  the pane could not be scrolled. While the alternate screen is up that
  Scrollable now takes no user scrolling; programmatic tail alignment is
  unaffected, and the normal screen still scrolls local history. Regressions:
  `test/terminal_alt_buffer_scroll_test.dart`.

- **The alternate screen's scroll view keeps listening after its position is
  replaced** (`lib/src/ui/infinite_scroll_view.dart`). `attach` listens to the
  `ScrollPosition` with `_onScroll`, but the `position` setter moved
  `markNeedsLayout` instead. `Scrollable` replaces its position whenever its
  dependencies change — the pane grid reparenting a terminal is enough — so
  `_onScroll` stayed on the discarded position and every later wheel or
  trackpad scroll reached nothing: a Claude Code pane scrolled two or three
  times and then stopped for good, with no error anywhere. The setter now moves
  `_onScroll`. Regression: the reparent test in
  `test/terminal_alt_buffer_scroll_test.dart`.

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

10. **Return does not leave the line it just sent sitting in the prompt**
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
11. **Block Elements (U+2580–U+259F) are painted as rectangles, not font
    glyphs** (`lib/src/ui/block_glyphs.dart`, `lib/src/ui/painter.dart`,
    `lib/src/ui/render.dart`, `lib/src/terminal_view.dart`). A cell is
    `TerminalStyle.height` (1.2) times the font size, rounded to whole pixels
    by SkParagraph (13 pt → 16 px), but a font's block glyphs only cover the
    face's own ascent and descent — and SF Mono's don't reach the cell's edges
    horizontally either — so anything drawn with blocks (Claude Code's mascot,
    progress bars, TUI borders) showed a dark band under every row and seams
    between columns. `paintCellForeground` now hands those code points to
    `paintBlockGlyph`, which fills the cell's own rectangle(s) with every edge
    snapped to a device pixel (the view feeds the painter
    `MediaQuery.devicePixelRatioOf`) and anti-aliasing off; the snapping is
    what makes neighbours tile on Impeller, which ignores the flag. The three
    shade characters are a full cell at 25/50/75 % coverage, and inverse/faint
    follow the text path. Box drawing (U+2500–U+257F) still comes from the
    font. Regression: `test/terminal_block_glyph_test.dart`, which also
    rasterises through the real painter.
