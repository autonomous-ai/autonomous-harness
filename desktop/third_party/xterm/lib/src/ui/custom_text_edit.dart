import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:xterm/src/utils/unicode_v11.dart';

class CustomTextEdit extends StatefulWidget {
  CustomTextEdit({
    super.key,
    required this.child,
    required this.onInsert,
    required this.onDelete,
    required this.onComposing,
    required this.onAction,
    required this.onKeyEvent,
    required this.focusNode,
    this.autofocus = false,
    this.readOnly = false,
    // this.initEditingState = TextEditingValue.empty,
    this.inputType = TextInputType.text,
    this.inputAction = TextInputAction.newline,
    this.keyboardAppearance = Brightness.light,
    this.deleteDetection = false,
  });

  final Widget child;

  final void Function(String) onInsert;

  final void Function(int count) onDelete;

  final void Function(String? text, int backtrackCells) onComposing;

  final void Function(TextInputAction) onAction;

  final KeyEventResult Function(FocusNode, KeyEvent) onKeyEvent;

  final FocusNode focusNode;

  final bool autofocus;

  final bool readOnly;

  final TextInputType inputType;

  final TextInputAction inputAction;

  final Brightness keyboardAppearance;

  final bool deleteDetection;

  @override
  CustomTextEditState createState() => CustomTextEditState();
}

class CustomTextEditState extends State<CustomTextEdit> with TextInputClient {
  TextInputConnection? _connection;

  @override
  void initState() {
    widget.focusNode.addListener(_onFocusChange);
    super.initState();
  }

  @override
  void didUpdateWidget(CustomTextEdit oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (widget.focusNode != oldWidget.focusNode) {
      oldWidget.focusNode.removeListener(_onFocusChange);
      widget.focusNode.addListener(_onFocusChange);
    }

    if (!_shouldCreateInputConnection) {
      _closeInputConnectionIfNeeded();
    } else {
      if (oldWidget.readOnly && widget.focusNode.hasFocus) {
        _openInputConnection();
      }
    }
  }

  @override
  void dispose() {
    widget.focusNode.removeListener(_onFocusChange);
    _closeInputConnectionIfNeeded();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Focus(
      focusNode: widget.focusNode,
      autofocus: widget.autofocus,
      onKeyEvent: _onKeyEvent,
      child: widget.child,
    );
  }

  bool get hasInputConnection => _connection != null && _connection!.attached;

  void requestKeyboard() {
    if (widget.focusNode.hasFocus) {
      _openInputConnection();
    } else {
      widget.focusNode.requestFocus();
    }
  }

  void closeKeyboard() {
    if (hasInputConnection) {
      _connection?.close();
    }
  }

  void setEditingState(TextEditingValue value) {
    _cancelPendingDeletes();
    _currentEditingState = value;
    _terminalText = value.text;
    _connection?.setEditingState(value);
  }

  /// Clears the native input buffer after the terminal accepts a command.
  /// It intentionally stays intact between ordinary key presses: Vietnamese
  /// Telex needs the preceding `u` available to convert it into `ư`.
  void resetEditingState() {
    _cancelPendingDeletes();
    _currentEditingState = _initEditingState.copyWith();
    _terminalText = _currentEditingState.text;
    widget.onComposing(null, 0);
    _connection?.setEditingState(_currentEditingState);
  }

  void setEditableRect(Rect rect, Rect caretRect) {
    if (!hasInputConnection) {
      return;
    }

    _connection?.setEditableSizeAndTransform(
      rect.size,
      Matrix4.translationValues(0, 0, 0),
    );

    _connection?.setCaretRect(caretRect);
  }

  void _onFocusChange() {
    _openOrCloseInputConnectionIfNeeded();
  }

  KeyEventResult _onKeyEvent(FocusNode focusNode, KeyEvent event) {
    if (_currentEditingState.composing.isCollapsed) {
      return widget.onKeyEvent(focusNode, event);
    }

    return KeyEventResult.skipRemainingHandlers;
  }

  void _openOrCloseInputConnectionIfNeeded() {
    if (widget.focusNode.hasFocus && widget.focusNode.consumeKeyboardToken()) {
      _openInputConnection();
    } else if (!widget.focusNode.hasFocus) {
      _closeInputConnectionIfNeeded();
    }
  }

  bool get _shouldCreateInputConnection => kIsWeb || !widget.readOnly;

  void _openInputConnection() {
    if (!_shouldCreateInputConnection) {
      return;
    }

    if (hasInputConnection) {
      _connection!.show();
    } else {
      final config = TextInputConfiguration(
        inputType: widget.inputType,
        inputAction: widget.inputAction,
        keyboardAppearance: widget.keyboardAppearance,
        autocorrect: false,
        enableSuggestions: false,
        enableIMEPersonalizedLearning: false,
      );

      _connection = TextInput.attach(this, config);

      _connection!.show();

      // setEditableRect(Rect.zero, Rect.zero);

      _connection!.setEditingState(_initEditingState);
    }
  }

  void _closeInputConnectionIfNeeded() {
    if (_connection != null && _connection!.attached) {
      _connection!.close();
      _connection = null;
    }

    // An IME can still have a pre-edit string while focus moves to another
    // terminal. That text belongs to the old native input connection and must
    // never remain painted (or be committed) in the newly focused terminal.
    resetEditingState();
  }

  TextEditingValue get _initEditingState => widget.deleteDetection
      ? const TextEditingValue(
          text: '  ',
          selection: TextSelection.collapsed(offset: 2),
        )
      : const TextEditingValue(
          text: '',
          selection: TextSelection.collapsed(offset: 0),
        );

  late var _currentEditingState = _initEditingState.copyWith();

  /// Text that has already been mirrored to the PTY. This deliberately stays
  /// separate from [_currentEditingState], whose composing range can contain
  /// marked text that must not reach the terminal before the IME commits it.
  late String _terminalText = _initEditingState.text;

  int _pendingDeleteSelectors = 0;
  Timer? _deleteSelectorTimer;

  @override
  TextEditingValue? get currentTextEditingValue {
    return _currentEditingState;
  }

  @override
  AutofillScope? get currentAutofillScope {
    return null;
  }

  @override
  void updateEditingValue(TextEditingValue value) {
    _applyEditingValue(
      value,
      hasTextMutation: value.text != _currentEditingState.text,
    );
  }

  void _applyEditingValue(
    TextEditingValue value, {
    required bool hasTextMutation,
  }) {
    final wasComposing = !_currentEditingState.composing.isCollapsed;
    _currentEditingState = value;
    final isComposing = !_currentEditingState.composing.isCollapsed;

    if (hasTextMutation || wasComposing || isComposing) {
      // A text delta is authoritative. Any delete selector queued during the
      // same native input transaction is part of that replacement/composition
      // and must not be forwarded to the PTY a second time.
      _cancelPendingDeletes();
    }

    if (isComposing) {
      final text = _currentEditingState.text;
      final composingText = _currentEditingState.composing.textInside(text);

      // macOS can keep the whole editable buffer marked even after that exact
      // value has already been mirrored to the PTY. Painting it again leaves
      // a stale IME overlay (previously visible as an underline) until the
      // terminal is rebuilt. Only preview text that is genuinely ahead of the
      // terminal state; CJK/Japanese pre-edit text still takes this path.
      if (text == _terminalText) {
        widget.onComposing(null, 0);
        return;
      }

      widget.onComposing(
        composingText,
        _composingBacktrackCells(_currentEditingState.composing.start),
      );
      return;
    }

    widget.onComposing(null, 0);

    if (hasTextMutation || wasComposing || value.text != _terminalText) {
      _syncTerminalText(value.text);
    }
  }

  void _syncTerminalText(String value) {
    final edit = _TextEdit.between(_terminalText, value);
    if (edit.removed.isNotEmpty) {
      widget.onDelete(edit.removed.runes.length);
    }
    if (edit.inserted.isNotEmpty) {
      widget.onInsert(edit.inserted);
    }
    _terminalText = value;
  }

  int _composingBacktrackCells(int composingStart) {
    if (composingStart < 0 || composingStart >= _terminalText.length) return 0;

    var width = 0;
    for (final rune in _terminalText.substring(composingStart).runes) {
      final runeWidth = unicodeV11.wcwidth(rune);
      if (runeWidth > 0) width += runeWidth;
    }
    return width;
  }

  @override
  void performAction(TextInputAction action) {
    // print('performAction $action');
    widget.onAction(action);
  }

  @override
  void performSelector(String selectorName) {
    if (!selectorName.startsWith('deleteBackward')) return;

    // A marked string belongs entirely to the IME. It will send a fresh
    // editing value after changing the pre-edit text, so nothing reaches the
    // terminal yet.
    if (!_currentEditingState.composing.isCollapsed) return;

    _pendingDeleteSelectors++;
    _deleteSelectorTimer ??= Timer(
      Duration.zero,
      _flushPendingDeleteSelectors,
    );
  }

  void _flushPendingDeleteSelectors() {
    _deleteSelectorTimer = null;
    final count = _pendingDeleteSelectors;
    _pendingDeleteSelectors = 0;

    if (count == 0 || !_currentEditingState.composing.isCollapsed) return;

    for (var index = 0; index < count; index++) {
      _applyNativeBackspace();
    }
  }

  void _applyNativeBackspace() {
    final value = _currentEditingState;
    final selection = value.selection.isValid
        ? value.selection
        : TextSelection.collapsed(offset: value.text.length);
    final end = selection.end;
    final start = selection.isCollapsed
        ? _previousCodePointBoundary(value.text, end)
        : selection.start;

    if (start < end) {
      final next = value.copyWith(
        text: value.text.replaceRange(start, end, ''),
        selection: TextSelection.collapsed(offset: start),
        composing: TextRange.empty,
      );
      _currentEditingState = next;
      _connection?.setEditingState(next);
      _syncTerminalText(next.text);
      return;
    }

    // The native buffer can be empty at a shell prompt, but Backspace still
    // has meaning to the remote terminal.
    widget.onDelete(1);
  }

  void _cancelPendingDeletes() {
    _pendingDeleteSelectors = 0;
    _deleteSelectorTimer?.cancel();
    _deleteSelectorTimer = null;
  }

  int _previousCodePointBoundary(String text, int offset) {
    if (offset <= 0) return 0;
    final previous = text.codeUnitAt(offset - 1);
    if (previous >= 0xdc00 &&
        previous <= 0xdfff &&
        offset >= 2 &&
        text.codeUnitAt(offset - 2) >= 0xd800 &&
        text.codeUnitAt(offset - 2) <= 0xdbff) {
      return offset - 2;
    }
    return offset - 1;
  }

  @override
  void updateFloatingCursor(RawFloatingCursorPoint point) {
    // print('updateFloatingCursor $point');
  }

  @override
  void didChangeInputControl(
    TextInputControl? oldControl,
    TextInputControl? newControl,
  ) {}

  @override
  void insertContent(KeyboardInsertedContent content) {}

  @override
  bool onFocusReceived() => false;

  @override
  void showAutocorrectionPromptRect(int start, int end) {
    // print('showAutocorrectionPromptRect');
  }

  @override
  void connectionClosed() {
    // print('connectionClosed');
  }

  @override
  void performPrivateCommand(String action, Map<String, dynamic> data) {
    // print('performPrivateCommand $action');
  }

  @override
  void insertTextPlaceholder(Size size) {
    // print('insertTextPlaceholder');
  }

  @override
  void removeTextPlaceholder() {
    // print('removeTextPlaceholder');
  }

  @override
  void showToolbar() {
    // print('showToolbar');
  }
}

class _TextEdit {
  const _TextEdit({required this.removed, required this.inserted});

  factory _TextEdit.between(String before, String after) {
    var prefix = 0;
    final sharedLength =
        before.length < after.length ? before.length : after.length;
    while (prefix < sharedLength &&
        before.codeUnitAt(prefix) == after.codeUnitAt(prefix)) {
      prefix++;
    }

    return _TextEdit(
      // A PTY terminal edits at the current cursor; it cannot preserve a
      // common suffix while replacing an earlier character. Rewind the whole
      // suffix from the first difference, then replay the desired suffix.
      removed: before.substring(prefix),
      inserted: after.substring(prefix),
    );
  }

  final String removed;
  final String inserted;
}
