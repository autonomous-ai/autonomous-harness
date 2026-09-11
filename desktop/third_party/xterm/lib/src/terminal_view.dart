import 'package:flutter/cupertino.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:xterm/src/core/buffer/cell_offset.dart';

import 'package:xterm/src/core/input/keys.dart';
import 'package:xterm/src/terminal.dart';
import 'package:xterm/src/ui/controller.dart';
import 'package:xterm/src/ui/cursor_type.dart';
import 'package:xterm/src/ui/custom_text_edit.dart';
import 'package:xterm/src/ui/gesture/gesture_handler.dart';
import 'package:xterm/src/ui/input_map.dart';
import 'package:xterm/src/ui/keyboard_listener.dart';
import 'package:xterm/src/ui/keyboard_visibility.dart';
import 'package:xterm/src/ui/render.dart';
import 'package:xterm/src/ui/scroll_handler.dart';
import 'package:xterm/src/ui/shortcut/actions.dart';
import 'package:xterm/src/ui/shortcut/shortcuts.dart';
import 'package:xterm/src/ui/terminal_text_style.dart';
import 'package:xterm/src/ui/terminal_theme.dart';
import 'package:xterm/src/ui/themes.dart';

class TerminalView extends StatefulWidget {
  const TerminalView(
    this.terminal, {
    super.key,
    this.controller,
    this.theme = TerminalThemes.defaultTheme,
    this.textStyle = const TerminalStyle(),
    this.textScaler,
    this.padding,
    this.scrollController,
    this.autoResize = true,
    this.backgroundOpacity = 1,
    this.focusNode,
    this.autofocus = false,
    this.onTapDown,
    this.onTapUp,
    this.onSecondaryTapDown,
    this.onSecondaryTapUp,
    this.mouseCursor = SystemMouseCursors.text,
    this.keyboardType = TextInputType.text,
    this.keyboardAppearance = Brightness.dark,
    this.cursorType = TerminalCursorType.block,
    this.alwaysShowCursor = false,
    this.deleteDetection = false,
    this.shortcuts,
    this.onKeyEvent,
    this.readOnly = false,
    this.hardwareKeyboardOnly = false,
    this.simulateScroll = true,
    this.onAltBufferScroll,
  });

  /// The underlying terminal that this widget renders.
  final Terminal terminal;

  final TerminalController? controller;

  /// The theme to use for this terminal.
  final TerminalTheme theme;

  /// The style to use for painting characters.
  final TerminalStyle textStyle;

  final TextScaler? textScaler;

  /// Padding around the inner [Scrollable] widget.
  final EdgeInsets? padding;

  /// Scroll controller for the inner [Scrollable] widget.
  final ScrollController? scrollController;

  /// Should this widget automatically notify the underlying terminal when its
  /// size changes. [true] by default.
  final bool autoResize;

  /// Opacity of the terminal background. Set to 0 to make the terminal
  /// background transparent.
  final double backgroundOpacity;

  /// An optional focus node to use as the focus node for this widget.
  final FocusNode? focusNode;

  /// True if this widget will be selected as the initial focus when no other
  /// node in its scope is currently focused.
  final bool autofocus;

  /// Return true to handle this primary click in the host instead of sending
  /// mouse reports to the terminal or clearing its selection. The matching
  /// tap up still calls [onTapUp]; dragging does not complete a click.
  final bool Function(TapDownDetails, CellOffset)? onTapDown;

  /// Callback for a primary click handled locally, including [onTapDown].
  final void Function(TapUpDetails, CellOffset)? onTapUp;

  /// Function called when the user taps on the terminal with a secondary
  /// button.
  final void Function(TapDownDetails, CellOffset)? onSecondaryTapDown;

  /// Function called when the user stops holding down a secondary button.
  final void Function(TapUpDetails, CellOffset)? onSecondaryTapUp;

  /// The mouse cursor for mouse pointers that are hovering over the terminal.
  /// [SystemMouseCursors.text] by default.
  final MouseCursor mouseCursor;

  /// The type of information for which to optimize the text input control.
  /// [TextInputType.text] by default so native IMEs can compose text.
  final TextInputType keyboardType;

  /// The appearance of the keyboard. [Brightness.dark] by default.
  ///
  /// This setting is only honored on iOS devices.
  final Brightness keyboardAppearance;

  /// The type of cursor to use. [TerminalCursorType.block] by default.
  final TerminalCursorType cursorType;

  /// Whether to always show the cursor. This is useful for debugging.
  /// [false] by default.
  final bool alwaysShowCursor;

  /// Workaround to detect delete key for platforms and IMEs that does not
  /// emit hardware delete event. Prefered on mobile platforms. [false] by
  /// default.
  final bool deleteDetection;

  /// Shortcuts for this terminal. This has higher priority than input handler
  /// of the terminal If not provided, [defaultTerminalShortcuts] will be used.
  final Map<ShortcutActivator, Intent>? shortcuts;

  /// Keyboard event handler of the terminal. This has higher priority than
  /// [shortcuts] and input handler of the terminal.
  final FocusOnKeyEventCallback? onKeyEvent;

  /// True if no input should send to the terminal.
  final bool readOnly;

  /// True if only hardware keyboard events should be used as input. This will
  /// also prevent any on-screen keyboard to be shown.
  final bool hardwareKeyboardOnly;

  /// If true, when the terminal is in alternate buffer (for example running
  /// vim, man, etc), if the application does not declare that it can handle
  /// scrolling, the terminal will simulate scrolling by sending up/down arrow
  /// keys to the application. This is standard behavior for most terminal
  /// emulators. True by default.
  final bool simulateScroll;

  /// See `TerminalScrollGestureHandler.onAltBufferScroll` for why a caller would ever supply this —
  /// a program that owns terminal mouse-tracking but doesn't correctly handle wheel reports needs a
  /// backend-native way to scroll instead of the emulator's own mouse/key simulation.
  final void Function(bool up)? onAltBufferScroll;

  @override
  State<TerminalView> createState() => TerminalViewState();
}

class TerminalViewState extends State<TerminalView> {
  late FocusNode _focusNode;

  late final ShortcutManager _shortcutManager;

  final _customTextEditKey = GlobalKey<CustomTextEditState>();

  final _scrollableKey = GlobalKey<ScrollableState>();

  final _viewportKey = GlobalKey();

  String? _composingText;

  int _composingBacktrackCells = 0;

  late TerminalController _controller;

  late ScrollController _scrollController;

  RenderTerminal get renderTerminal =>
      _viewportKey.currentContext!.findRenderObject() as RenderTerminal;

  @override
  void initState() {
    _focusNode = widget.focusNode ?? FocusNode();
    _controller = widget.controller ?? TerminalController();
    _scrollController = widget.scrollController ?? ScrollController();
    widget.terminal.addListener(_onTerminalChanged);
    _shortcutManager = ShortcutManager(
      shortcuts: widget.shortcuts ?? defaultTerminalShortcuts,
    );
    super.initState();
  }

  @override
  void didUpdateWidget(TerminalView oldWidget) {
    if (!identical(oldWidget.terminal, widget.terminal)) {
      oldWidget.terminal.removeListener(_onTerminalChanged);
      widget.terminal.addListener(_onTerminalChanged);
      // A marked string is owned by the old native input session. TerminalView
      // states are reused while switching agents, so never carry that overlay
      // or editing buffer into the newly selected terminal.
      _composingText = null;
      _composingBacktrackCells = 0;
      final currentTerminal = widget.terminal;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || !identical(widget.terminal, currentTerminal)) return;
        _customTextEditKey.currentState?.resetEditingState();
      });
    }
    if (oldWidget.focusNode != widget.focusNode) {
      if (oldWidget.focusNode == null) {
        _focusNode.dispose();
      }
      _focusNode = widget.focusNode ?? FocusNode();
    }
    if (oldWidget.controller != widget.controller) {
      if (oldWidget.controller == null) {
        _controller.dispose();
      }
      _controller = widget.controller ?? TerminalController();
    }
    if (oldWidget.scrollController != widget.scrollController) {
      if (oldWidget.scrollController == null) {
        _scrollController.dispose();
      }
      _scrollController = widget.scrollController ?? ScrollController();
    }
    _shortcutManager.shortcuts = widget.shortcuts ?? defaultTerminalShortcuts;
    super.didUpdateWidget(oldWidget);
  }

  @override
  void dispose() {
    widget.terminal.removeListener(_onTerminalChanged);
    if (widget.focusNode == null) {
      _focusNode.dispose();
    }
    if (widget.controller == null) {
      _controller.dispose();
    }
    if (widget.scrollController == null) {
      _scrollController.dispose();
    }
    _shortcutManager.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    Widget child = Scrollable(
      key: _scrollableKey,
      controller: _scrollController,
      viewportBuilder: (context, offset) {
        return _TerminalView(
          key: _viewportKey,
          terminal: widget.terminal,
          controller: _controller,
          offset: offset,
          padding: MediaQuery.of(context).padding,
          autoResize: widget.autoResize,
          textStyle: widget.textStyle,
          textScaler: widget.textScaler ?? MediaQuery.textScalerOf(context),
          theme: widget.theme,
          focusNode: _focusNode,
          cursorType: widget.cursorType,
          alwaysShowCursor: widget.alwaysShowCursor,
          onEditableRect: _onEditableRect,
          composingText: _composingText,
          composingBacktrackCells: _composingBacktrackCells,
        );
      },
    );

    child = TerminalScrollGestureHandler(
      terminal: widget.terminal,
      simulateScroll: widget.simulateScroll,
      onAltBufferScroll: widget.onAltBufferScroll,
      getCellOffset: (offset) => renderTerminal.getCellOffset(offset),
      getLineHeight: () => renderTerminal.lineHeight,
      child: child,
    );

    if (!widget.hardwareKeyboardOnly) {
      child = CustomTextEdit(
        key: _customTextEditKey,
        focusNode: _focusNode,
        autofocus: widget.autofocus,
        inputType: widget.keyboardType,
        keyboardAppearance: widget.keyboardAppearance,
        deleteDetection: widget.deleteDetection,
        onInsert: _onInsert,
        onDelete: (count) {
          _scrollToBottom();
          for (var index = 0; index < count; index++) {
            widget.terminal.keyInput(TerminalKey.backspace);
          }
        },
        onComposing: _onComposing,
        onAction: (action) {
          _scrollToBottom();
          if (action == TextInputAction.done ||
              action == TextInputAction.newline) {
            widget.terminal.keyInput(TerminalKey.enter);
            _customTextEditKey.currentState?.resetEditingState();
          }
        },
        onKeyEvent: _handleKeyEvent,
        readOnly: widget.readOnly,
        child: child,
      );
    } else if (!widget.readOnly) {
      // Only listen for key input from a hardware keyboard.
      child = CustomKeyboardListener(
        child: child,
        focusNode: _focusNode,
        autofocus: widget.autofocus,
        onInsert: _onInsert,
        onComposing: (text) => _onComposing(text, 0),
        onKeyEvent: _handleKeyEvent,
      );
    }

    child = TerminalActions(
      terminal: widget.terminal,
      controller: _controller,
      child: child,
    );

    child = KeyboardVisibilty(
      onKeyboardShow: _onKeyboardShow,
      child: child,
    );

    child = TerminalGestureHandler(
      terminalView: this,
      terminalController: _controller,
      onTapUp: _onTapUp,
      onTapDown: _onTapDown,
      onSecondaryTapDown:
          widget.onSecondaryTapDown != null ? _onSecondaryTapDown : null,
      onSecondaryTapUp:
          widget.onSecondaryTapUp != null ? _onSecondaryTapUp : null,
      readOnly: widget.readOnly,
      child: child,
    );

    child = MouseRegion(
      cursor: widget.mouseCursor,
      child: child,
    );

    child = Container(
      color: widget.theme.background.withOpacity(widget.backgroundOpacity),
      padding: widget.padding,
      child: child,
    );

    return child;
  }

  void requestKeyboard() {
    _customTextEditKey.currentState?.requestKeyboard();
  }

  void closeKeyboard() {
    _customTextEditKey.currentState?.closeKeyboard();
  }

  Rect get cursorRect {
    return renderTerminal.cursorOffset & renderTerminal.cellSize;
  }

  Rect get globalCursorRect {
    return renderTerminal.localToGlobal(renderTerminal.cursorOffset) &
        renderTerminal.cellSize;
  }

  void _onTapUp(TapUpDetails details) {
    final offset = renderTerminal.getCellOffset(
      renderTerminal.globalToLocal(details.globalPosition),
    );
    widget.onTapUp?.call(details, offset);
  }

  bool _onTapDown(TapDownDetails details) {
    final offset = renderTerminal.getCellOffset(
      renderTerminal.globalToLocal(details.globalPosition),
    );
    if (widget.onTapDown?.call(details, offset) ?? false) return true;
    if (_controller.selection != null) {
      _controller.clearSelection();
    } else {
      if (!widget.hardwareKeyboardOnly) {
        _customTextEditKey.currentState?.requestKeyboard();
      } else {
        _focusNode.requestFocus();
      }
    }
    return false;
  }

  void _onSecondaryTapDown(TapDownDetails details) {
    final offset = renderTerminal.getCellOffset(details.localPosition);
    widget.onSecondaryTapDown?.call(details, offset);
  }

  void _onSecondaryTapUp(TapUpDetails details) {
    final offset = renderTerminal.getCellOffset(details.localPosition);
    widget.onSecondaryTapUp?.call(details, offset);
  }

  bool get hasInputConnection {
    return _customTextEditKey.currentState?.hasInputConnection == true;
  }

  void _onInsert(String text) {
    if (text.isEmpty) return;

    final key = charToTerminalKey(text.trim());

    // On mobile platforms there is no guarantee that virtual keyboard will
    // generate hardware key events. So we need first try to send the key
    // as a hardware key event. If it fails, then we send it as a text input.
    final consumed = key == null ? false : widget.terminal.keyInput(key);

    if (!consumed) {
      widget.terminal.textInput(text);
    }

    _scrollToBottom();
  }

  void _onComposing(String? text, int backtrackCells) {
    if (text != null && _terminalAlreadyEchoes(text)) {
      text = null;
      backtrackCells = 0;
    }
    if (!mounted ||
        (_composingText == text &&
            _composingBacktrackCells == backtrackCells)) {
      return;
    }
    setState(() {
      _composingText = text;
      _composingBacktrackCells = backtrackCells;
    });
  }

  /// The native macOS input client keeps a marked range while a remote TUI
  /// has already echoed the exact same characters. Keeping our own preview in
  /// that case duplicates the cells and makes them look underlined/stale until
  /// the next keyframe. A real CJK pre-edit has not reached the PTY yet, so it
  /// does not match the cells before the cursor and remains visible.
  bool _terminalAlreadyEchoes(String text) {
    if (text.isEmpty) return false;
    final buffer = widget.terminal.buffer;
    if (buffer.cursorX <= 0) return false;
    return buffer.currentLine.getText(0, buffer.cursorX).endsWith(text);
  }

  void _onTerminalChanged() {
    final text = _composingText;
    if (!mounted || text == null || !_terminalAlreadyEchoes(text)) return;
    setState(() {
      _composingText = null;
      _composingBacktrackCells = 0;
    });
  }

  @visibleForTesting
  String? get debugComposingText => _composingText;

  KeyEventResult _handleKeyEvent(FocusNode focusNode, KeyEvent event) {
    final resultOverride = widget.onKeyEvent?.call(focusNode, event);
    if (resultOverride != null && resultOverride != KeyEventResult.ignored) {
      return resultOverride;
    }

    // ignore: invalid_use_of_protected_member
    final shortcutResult = _shortcutManager.handleKeypress(
      focusNode.context!,
      event,
    );

    if (shortcutResult != KeyEventResult.ignored) {
      return shortcutResult;
    }

    if (event is KeyUpEvent) {
      return KeyEventResult.ignored;
    }

    final key = keyToTerminalKey(event.logicalKey);
    final reservesTerminalKey = HardwareKeyboard.instance.isControlPressed ||
        HardwareKeyboard.instance.isMetaPressed;

    // Let the native text input client process Backspace while editable. Some
    // IMEs emit it internally to replace an earlier committed letter (Telex
    // does this for transformations such as `u` to `ư`).
    //
    // ONLY WHERE THE EMBEDDER HOLDS UP ITS END. This hands the key to the
    // platform and sends nothing, which is a bargain only Apple's embedder
    // keeps: AppKit turns Backspace into `deleteBackward:` and ships the
    // selector to Dart over `TextInputClient.performSelectors`, which
    // CustomTextEdit answers (see its performSelector). The GTK embedder has
    // no performSelectors channel method at all, and its key handler names
    // GDK_KEY_BackSpace explicitly to do NOTHING with it — "already handled
    // inside the framework in RenderEditable", which is true of an
    // EditableText and false of the bare TextInputClient below. So on Linux
    // the key was dropped here, dropped again by the engine, and no byte ever
    // reached the pty: everything typed except Backspace.
    //
    // Everywhere else the key falls through to keyInput() at the bottom, where
    // the keytab turns it into ^? (\x7f). Composition is not at risk either
    // way — while an IME is composing, CustomTextEdit._onKeyEvent never calls
    // this method.
    final nativeClientOwnsBackspace =
        defaultTargetPlatform == TargetPlatform.macOS ||
            defaultTargetPlatform == TargetPlatform.iOS;
    if (key == TerminalKey.backspace &&
        nativeClientOwnsBackspace &&
        !widget.hardwareKeyboardOnly &&
        !reservesTerminalKey) {
      return KeyEventResult.skipRemainingHandlers;
    }

    // On macOS a physical key arrives before the platform text-input client
    // reports its composing value. Forwarding printable keys here therefore
    // leaks IME pre-edit input (for example `ni`) to the PTY before the final
    // committed text (`に`) arrives. Let TextInputClient own all text without
    // Control/Command; it will call _onInsert exactly once on commit.
    final isTextInput = _isPrintableText(event.character);
    if (isTextInput && !reservesTerminalKey) {
      // Do not let another Flutter shortcut consume this before macOS gets a
      // chance to update the native text-input client.
      return KeyEventResult.skipRemainingHandlers;
    }

    if (key == null) {
      return KeyEventResult.ignored;
    }

    // ⌘ IS THE APP'S MODIFIER, NEVER THE TERMINAL'S. No terminal emulator sends
    // a Command chord to the pty — Terminal.app and iTerm both reserve it for
    // themselves — but this fell through to keyInput() below, which is not even
    // given `meta`, so ⌘] arrived as a bare bracketRight: it typed "]" into the
    // shell AND returned handled, which stopped the chord from ever reaching
    // the app's own Shortcuts above. That is one bug wearing two faces, and it
    // ate every app shortcut whose base key has a terminal mapping — moving
    // between panes, closing one, opening an agent, reloading.
    //
    // Returning `ignored` (not skipRemainingHandlers) is the point: the event
    // keeps travelling UP the focus chain to those Shortcuts. xterm's own
    // ⌘C/⌘V/⌘A are matched earlier, by the shortcut map, so they still work.
    //
    // Not gated on Apple: ⌘ is this app's modifier on every desktop it runs on
    // (app_shortcuts.dart declares every one of them `meta: true`, which is
    // the Super key on Linux). Gating it there meant a focused terminal on
    // Linux swallowed Super+key — typing the bare letter into the shell — and
    // the app's own Shortcuts never saw a single chord.
    if (HardwareKeyboard.instance.isMetaPressed) {
      return KeyEventResult.ignored;
    }

    // ⌃⇥ IS THE APP'S, EVERYWHERE. Ctrl generally belongs to the terminal — it
    // is how a shell gets ^C, ^D, ^Z — so this is a single named exception
    // rather than a rule about Ctrl: no shell or tmux binding uses Ctrl+Tab,
    // and it is the chord every tabbed app moves between views with, so the
    // hand reaches for it here too. Without this the terminal answered it and
    // the app's Shortcuts never saw the key.
    if (key == TerminalKey.tab && HardwareKeyboard.instance.isControlPressed) {
      return KeyEventResult.ignored;
    }

    final handled = widget.terminal.keyInput(
      key,
      ctrl: HardwareKeyboard.instance.isControlPressed,
      alt: HardwareKeyboard.instance.isAltPressed,
      shift: HardwareKeyboard.instance.isShiftPressed,
    );

    if (handled) {
      _scrollToBottom();
      if (key == TerminalKey.enter) {
        _customTextEditKey.currentState?.resetEditingState();
      }
    }

    return handled ? KeyEventResult.handled : KeyEventResult.ignored;
  }

  bool _isPrintableText(String? text) {
    if (text == null || text.isEmpty) return false;

    // Backspace, Enter, Tab, Escape, Delete and macOS function/navigation
    // keys can all carry a `character` value. They remain terminal controls;
    // only actual printable text is deferred to the native IME.
    return text.runes.every(
      (rune) =>
          rune >= 0x20 && rune != 0x7f && (rune < 0xf700 || rune > 0xf8ff),
    );
  }

  void _onKeyboardShow() {
    if (_focusNode.hasFocus) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _scrollToBottom();
      });
    }
  }

  void _onEditableRect(Rect rect, Rect caretRect) {
    _customTextEditKey.currentState?.setEditableRect(rect, caretRect);
  }

  void _scrollToBottom() {
    final position = _scrollableKey.currentState?.position;
    if (position != null) {
      position.jumpTo(position.maxScrollExtent);
    }
  }
}

class _TerminalView extends LeafRenderObjectWidget {
  const _TerminalView({
    super.key,
    required this.terminal,
    required this.controller,
    required this.offset,
    required this.padding,
    required this.autoResize,
    required this.textStyle,
    required this.textScaler,
    required this.theme,
    required this.focusNode,
    required this.cursorType,
    required this.alwaysShowCursor,
    this.onEditableRect,
    this.composingText,
    this.composingBacktrackCells = 0,
  });

  final Terminal terminal;

  final TerminalController controller;

  final ViewportOffset offset;

  final EdgeInsets padding;

  final bool autoResize;

  final TerminalStyle textStyle;

  final TextScaler textScaler;

  final TerminalTheme theme;

  final FocusNode focusNode;

  final TerminalCursorType cursorType;

  final bool alwaysShowCursor;

  final EditableRectCallback? onEditableRect;

  final String? composingText;

  final int composingBacktrackCells;

  @override
  RenderTerminal createRenderObject(BuildContext context) {
    return RenderTerminal(
      terminal: terminal,
      controller: controller,
      offset: offset,
      padding: padding,
      autoResize: autoResize,
      textStyle: textStyle,
      textScaler: textScaler,
      theme: theme,
      focusNode: focusNode,
      cursorType: cursorType,
      alwaysShowCursor: alwaysShowCursor,
      onEditableRect: onEditableRect,
      composingText: composingText,
      composingBacktrackCells: composingBacktrackCells,
    );
  }

  @override
  void updateRenderObject(BuildContext context, RenderTerminal renderObject) {
    renderObject
      ..terminal = terminal
      ..controller = controller
      ..offset = offset
      ..padding = padding
      ..autoResize = autoResize
      ..textStyle = textStyle
      ..textScaler = textScaler
      ..theme = theme
      ..focusNode = focusNode
      ..cursorType = cursorType
      ..alwaysShowCursor = alwaysShowCursor
      ..onEditableRect = onEditableRect
      ..composingText = composingText
      ..composingBacktrackCells = composingBacktrackCells;
  }
}
