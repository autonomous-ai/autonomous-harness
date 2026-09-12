import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:flutter/services.dart';
import 'package:xterm/xterm.dart';

import '../clipboard/native_clipboard.dart';
import '../state/app_state.dart';

import 'agent_drag.dart';
import 'rename_agent_dialog.dart';
import 'terminal_composer.dart';
import '../terminal/terminal_binary.dart';
import '../terminal/terminal_font_store.dart';
import '../terminal/terminal_link_opener.dart';
import '../terminal/remote_media_download.dart';
import '../terminal/terminal_links.dart';
import '../terminal/terminal_session.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_viewport.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../theme/app_theme.dart';
import 'engine_identity.dart';

/// The pane header's own horizontal inset.
const double _stripPadding = 14;

class TerminalPanel extends StatefulWidget {
  final AppNotifier notifier;
  final TerminalSession session;

  /// Takes this tile off the grid. Null when the terminal is the whole window,
  /// where there is nothing to close it back to.
  final VoidCallback? onClose;

  /// Whether this tile keeps its slot when the grid moves under it, and the
  /// control that changes that. Null where there is no grid to hold a slot in.
  final bool pinned;
  final VoidCallback? onTogglePin;

  /// This native terminal took the keyboard, so its grid tile becomes focused.
  final VoidCallback? onRendererFocus;

  /// Only the focused grid tile may claim keyboard focus on mount/rebuild.
  final bool focused;
  final bool visible;
  final bool compactHeader;

  /// Whether this tile's composer textbox is showing. Only consulted for a remote machine.
  final bool composerVisible;
  final bool readOnly;

  /// Flips [composerVisible]. Null where there is no composer to toggle.
  final VoidCallback? onToggleComposer;

  /// Lets the header be dragged to trade places with another tile. Null when
  /// this is the only tile — see [_TerminalHeader.paneDrag].
  final PaneDragHandle? paneDrag;

  /// Test seam for OS actions; normal panes use the platform launcher.
  final TerminalLinkOpener? linkOpener;
  final RemoteMediaDownloader? mediaDownloader;

  const TerminalPanel({
    super.key,
    required this.notifier,
    required this.session,
    required this.focused,
    this.visible = true,
    this.compactHeader = false,
    this.composerVisible = false,
    this.readOnly = false,
    this.onToggleComposer,
    this.onClose,
    this.pinned = false,
    this.onTogglePin,
    this.onRendererFocus,
    this.paneDrag,
    this.linkOpener,
    this.mediaDownloader,
  });

  @override
  State<TerminalPanel> createState() => _TerminalPanelState();
}

class _TerminalPanelState extends State<TerminalPanel>
    implements TerminalViewport {
  static const _dialScale = 2.5;
  static const _dialStopVelocity = 40.0;
  static const _dialDecayPerSecond = 0.002;

  final TerminalController _controller = TerminalController();
  final ScrollController _scrollController = ScrollController();
  final FocusNode _focusNode = FocusNode();
  final FocusNode _composerFocus = FocusNode();
  late Terminal _viewTerminal;
  late GlobalKey<TerminalViewState> _terminalViewKey;
  Timer? _dialInertiaTimer;
  Timer? _cursorBlinkTimer;
  double _dialVelocity = 0;
  bool _cursorBlinkVisible = true;
  double _alternateScrollRemainder = 0;
  int? _lastInertiaMicros;
  late final TerminalLinkOpener _linkOpener;
  Offset? _linkPointerPosition;
  String? _hoveredLink;
  String? _pressedLink;
  bool _openingLink = false;
  bool _linkRefreshPending = false;
  late final RemoteMediaDownloader _mediaDownloader;
  MediaDownloadCancellation? _previewCancellation;
  RemoteMediaProgress? _previewProgress;

  @override
  void initState() {
    super.initState();
    _viewTerminal = widget.session.terminal;
    _viewTerminal.addListener(_scheduleLinkRefresh);
    _scrollController.addListener(_scheduleLinkRefresh);
    _terminalViewKey = GlobalKey<TerminalViewState>();
    _linkOpener = widget.linkOpener ?? TerminalLinkOpener();
    _mediaDownloader = widget.mediaDownloader ?? RemoteMediaDownloader();
    HardwareKeyboard.instance.addHandler(_onLinkModifierChanged);
    _focusNode.addListener(_handleFocusChange);
    _composerFocus.addListener(_handleComposerFocusChange);
    _cursorBlinkTimer = Timer.periodic(
      const Duration(milliseconds: 500),
      (_) => _advanceCursorBlink(),
    );
    widget.session.attachViewport(this);
    widget.session.addListener(_onSessionChanged);
    terminalFontStore.addListener(_onFontChanged);
    _afterTerminalMounted();
  }

  @override
  void didUpdateWidget(TerminalPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.session, widget.session)) {
      _previewCancellation?.cancel();
      _previewProgress = null;
      oldWidget.session.setCursorBlinkPhase(true);
      oldWidget.session.removeListener(_onSessionChanged);
      oldWidget.session.detachViewport(this);
      widget.session.attachViewport(this);
      widget.session.addListener(_onSessionChanged);
      _composerFocusPending = false;
      _cancelDialInertia();
      _controller.clearSelection();
      _viewTerminal.removeListener(_scheduleLinkRefresh);
      _viewTerminal = widget.session.terminal;
      _viewTerminal.addListener(_scheduleLinkRefresh);
      _pressedLink = null;
      _hoveredLink = null;
      _terminalViewKey = GlobalKey<TerminalViewState>();
      _cursorBlinkVisible = true;
      widget.session.setCursorBlinkPhase(true);
      _afterTerminalMounted();
    }
    if (oldWidget.visible && !widget.visible) {
      _focusNode.unfocus();
      _composerFocus.unfocus();
      _cancelDialInertia();
    }
    if (!oldWidget.focused && widget.focused) {
      _claimFocusAfterFrame();
    }
    // Showing or hiding the box changes how many rows the terminal has. Re-measure so the remote
    // grid is resized to what is actually on screen.
    if (oldWidget.composerVisible != widget.composerVisible) {
      _afterTerminalMounted();
    }
  }

  @override
  void dispose() {
    _previewCancellation?.cancel();
    _viewTerminal.removeListener(_scheduleLinkRefresh);
    _scrollController.removeListener(_scheduleLinkRefresh);
    HardwareKeyboard.instance.removeHandler(_onLinkModifierChanged);
    widget.session.setCursorBlinkPhase(true);
    widget.session.removeListener(_onSessionChanged);
    widget.session.detachViewport(this);
    terminalFontStore.removeListener(_onFontChanged);
    _cancelDialInertia();
    _cursorBlinkTimer?.cancel();
    _focusNode.removeListener(_handleFocusChange);
    _composerFocus.removeListener(_handleComposerFocusChange);
    _controller.dispose();
    _scrollController.dispose();
    _focusNode.dispose();
    _composerFocus.dispose();
    super.dispose();
  }

  /// Whether this pane shows the composer.
  ///
  /// Only a machine reached over the network charges a round trip per keystroke, so only it gets
  /// the box — typing into a local pane already costs well under a millisecond and it would be
  /// dead weight across the bottom.
  ///
  /// The test is `isLocalMachine`, NOT `isRemote`: the app only ever lists machines whose authMode
  /// is `remote` (see the filter in `_loadMachines`), so `isRemote` is true for every pane,
  /// including this very computer. What separates them is whether the machine's computerId is this
  /// one, which is what puts it on the loopback transport.
  bool get _showsComposer {
    final machineState = widget.notifier.stateOf(widget.session.machineId);
    return machineState != null &&
        !machineState.isLocalMachine &&
        !widget.readOnly &&
        widget.composerVisible;
  }

  /// The composer refuses focus while it is disabled, which it is until the stream goes live. When
  /// a selection lands on a still-attaching agent, the claim is parked here and made again from
  /// [_onSessionChanged] the moment it starts accepting input.
  bool _composerFocusPending = false;

  void _onSessionChanged() {
    if (!mounted || !_composerFocusPending) return;
    if (!widget.focused || !_showsComposer) {
      _composerFocusPending = false;
      return;
    }
    if (!widget.session.acceptsInput) return;
    _composerFocusPending = false;
    // Deferred a frame on purpose. This panel registers its session listener before the composer
    // registers its own (a parent's initState runs first), so at this instant the field is still
    // built as disabled — and a disabled field REFUSES focus. Claiming after the frame the
    // composer rebuilds in is what makes the claim actually land.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !widget.focused || !_showsComposer) return;
      if (!widget.session.acceptsInput) return;
      _composerFocus.requestFocus();
    });
  }

  /// The vendored renderer already treats a changed `textStyle` as a full re-layout — see
  /// `RenderTerminal.textStyle`'s setter — which recomputes cols/rows from the new cell size and
  /// resizes the remote session automatically. This just needs to get the new value into `build()`.
  void _onFontChanged() {
    if (mounted) setState(() {});
  }

  void _syncTerminal(Terminal terminal) {
    if (identical(_viewTerminal, terminal)) return;
    // Selection anchors belong to a specific circular buffer. Detach them
    // before the TerminalView starts laying out the replacement terminal.
    _controller.clearSelection();
    _viewTerminal.removeListener(_scheduleLinkRefresh);
    _viewTerminal = terminal;
    _viewTerminal.addListener(_scheduleLinkRefresh);
    _pressedLink = null;
    _hoveredLink = null;
    _terminalViewKey = GlobalKey<TerminalViewState>();
    _cancelDialInertia();
    _alternateScrollRemainder = 0;
    _cursorBlinkVisible = true;
    widget.session.setCursorBlinkPhase(true);
    _afterTerminalMounted(clearSelection: true);
  }

  /// Typing in the composer focuses the tile, exactly like clicking into the terminal does.
  void _handleComposerFocusChange() {
    if (_composerFocus.hasFocus) widget.onRendererFocus?.call();
  }

  void _handleFocusChange() {
    if (_focusNode.hasFocus) {
      widget.onRendererFocus?.call();
      return;
    }
    _cursorBlinkVisible = true;
    widget.session.setCursorBlinkPhase(true);
    _repaintTerminalCursor();
  }

  /// Re-establishes the native text-input connection after a rail selection.
  ///
  /// Replacing an agent remounts TerminalView but deliberately keeps this
  /// FocusNode. A plain requestFocus is a no-op when that node already owns
  /// focus, leaving macOS without a TextInputConnection until the user clicks
  /// the terminal. TerminalView.requestKeyboard handles both cases: it moves
  /// focus when needed, or opens the connection immediately when focus stayed
  /// on this tile. That is essential for ordinary keys and IMEs alike.
  void _claimFocus(TerminalViewState view) {
    if (!mounted || !widget.focused || _composerFocus.hasFocus) return;
    // On a remote pane the box gets the caret, not the terminal. Landing in the terminal would
    // hand the user the per-keystroke path by default — the exact cost the box exists to avoid.
    if (_showsComposer) {
      if (widget.session.acceptsInput) {
        _composerFocus.requestFocus();
      } else {
        _composerFocusPending = true;
      }
      return;
    }
    view.requestKeyboard();
  }

  void _claimFocusAfterFrame() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final view = _laidOutTerminalView();
      if (view != null) _claimFocus(view);
    });
  }

  void _advanceCursorBlink() {
    if (!mounted) return;
    final shouldBlink =
        widget.visible && _focusNode.hasFocus && widget.session.acceptsInput;
    final next = shouldBlink ? !_cursorBlinkVisible : true;
    if (next == _cursorBlinkVisible) return;
    _cursorBlinkVisible = next;
    widget.session.setCursorBlinkPhase(next);
    _repaintTerminalCursor();
  }

  void _repaintTerminalCursor() {
    _laidOutTerminalView()?.renderTerminal.markNeedsPaint();
  }

  /// The terminal view, but only once its render object can be read.
  ///
  /// `currentState?.renderTerminal` reads as null-safe and is not: the `?.`
  /// answers "is the State there", while the getter behind it is
  /// `_viewportKey.currentContext!.findRenderObject()`. Three call sites here
  /// relied on that misreading, one of them a timer that keeps ticking while a
  /// keyframe swaps the emulator underneath it.
  ///
  /// Insurance, NOT a diagnosis. The app has been crashing with exactly the
  /// error this bang produces, and the obvious theory — that the viewport is
  /// built during layout, leaving a window where the State exists and the
  /// context does not — was tested and is FALSE: the library builds it inside
  /// `Scrollable.viewportBuilder`, which runs during build, so the context is
  /// there as soon as the State is. Whatever is actually throwing has not been
  /// found yet; see the trace written by TerminalSession on a renderer fault.
  /// This only makes sure these three sites are not the ones that do it.
  TerminalViewState? _laidOutTerminalView() {
    final state = _terminalViewKey.currentState;
    if (state == null) return null;
    try {
      state.renderTerminal;
      return state;
    } catch (_) {
      return null;
    }
  }

  void _afterTerminalMounted({bool clearSelection = false}) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !widget.visible) return;
      if (clearSelection) _controller.clearSelection();
      final view = _laidOutTerminalView();
      if (view == null) return;
      final renderTerminal = view.renderTerminal;
      final cellSize = renderTerminal.cellSize;
      final renderSize = renderTerminal.size;
      if (cellSize.width > 0 && cellSize.height > 0) {
        widget.session.reportViewport(
          renderSize.width ~/ cellSize.width,
          renderSize.height ~/ cellSize.height,
        );
      }
      if (_scrollController.hasClients) {
        _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
      }
      // Never over the composer: a rebuild that re-focuses this tile while someone is typing into
      // the box would pull the caret out from under them mid-sentence.
      _claimFocus(view);
    });
  }

  @override
  void scroll(int phase, int dy, int velocity) {
    if (phase == 0) _cancelDialInertia();
    if (dy != 0) _applyDialDelta(-dy * _dialScale);
    if (phase == 2) _startDialInertia(velocity.toDouble());
  }

  void _applyDialDelta(double delta) {
    final terminal = widget.session.terminal;
    if (terminal.isUsingAltBuffer) {
      final lineHeight =
          _laidOutTerminalView()?.renderTerminal.lineHeight ?? 16.0;
      _alternateScrollRemainder += delta;
      while (_alternateScrollRemainder.abs() >= lineHeight) {
        final up = _alternateScrollRemainder < 0;
        if (widget.session.scrollViaTmuxCopyMode) {
          widget.session.sendScrollCommand(up, 1);
        } else {
          final handled = terminal.mouseInput(
            up ? TerminalMouseButton.wheelUp : TerminalMouseButton.wheelDown,
            TerminalMouseButtonState.down,
            CellOffset(terminal.viewWidth ~/ 2, terminal.viewHeight ~/ 2),
          );
          if (!handled) {
            terminal.keyInput(up ? TerminalKey.arrowUp : TerminalKey.arrowDown);
          }
        }
        _alternateScrollRemainder += up ? lineHeight : -lineHeight;
      }
      return;
    }

    if (!_scrollController.hasClients) return;
    final position = _scrollController.position;
    final target = (position.pixels + delta)
        .clamp(position.minScrollExtent, position.maxScrollExtent)
        .toDouble();
    position.jumpTo(target);
  }

  void _startDialInertia(double velocity) {
    _cancelDialInertia();
    if (velocity.abs() < _dialStopVelocity) return;
    _dialVelocity = velocity;
    _lastInertiaMicros = DateTime.now().microsecondsSinceEpoch;
    _dialInertiaTimer = Timer.periodic(const Duration(milliseconds: 16), (_) {
      if (!mounted) {
        _cancelDialInertia();
        return;
      }
      final now = DateTime.now().microsecondsSinceEpoch;
      final previous = _lastInertiaMicros ?? now;
      final elapsedSeconds = math.min((now - previous) / 1000000, 0.05);
      _lastInertiaMicros = now;
      _applyDialDelta(-_dialVelocity * elapsedSeconds * _dialScale);
      _dialVelocity *= math.pow(_dialDecayPerSecond, elapsedSeconds).toDouble();
      if (_dialVelocity.abs() < _dialStopVelocity) _cancelDialInertia();
    });
  }

  void _cancelDialInertia() {
    _dialInertiaTimer?.cancel();
    _dialInertiaTimer = null;
    _dialVelocity = 0;
    _lastInertiaMicros = null;
  }

  Future<void> _copyOrPaste() async {
    final terminal = widget.session.terminal;
    final selection = _controller.selection;
    if (selection != null) {
      final text = terminal.buffer.getText(selection);
      _controller.clearSelection();
      await Clipboard.setData(ClipboardData(text: text));
      return;
    }
    await _paste();
  }

  /// Paste — including the kinds of clipboard this app cannot fully read.
  ///
  /// ⚠️ FLUTTER'S OWN `Clipboard` API ONLY SEES `text/plain`. A screenshot has no
  /// text at all, so a naive body finds `null` and returns, silently: the single
  /// most common thing anyone pastes into a coding agent did nothing, with no
  /// error and nothing in a log. [NativeClipboard] closes that gap with a native
  /// platform-channel read for an actual image (macOS/Linux only; see its doc).
  ///
  /// The engines running in these panes read the system clipboard THEMSELVES —
  /// Claude Code attaches an image on Ctrl+V — so on a LOCAL pane that is already
  /// true with zero help from us: a bare Ctrl+V is all that ever ran here, before
  /// native image paste existed, and it still works because the engine and this
  /// app share the exact same OS clipboard. The wire-based `pasteImage` (chunked
  /// upload, daemon writes the far side's OS clipboard, daemon replays Ctrl+V) is
  /// reserved for a genuinely REMOTE pane, whose engine reads a DIFFERENT
  /// clipboard than this one — see `MachineState.isLocalMachine`.
  Future<void> _paste() async {
    if (widget.readOnly || !widget.session.acceptsInput) return;
    final text = (await Clipboard.getData(Clipboard.kTextPlain))?.text;
    if (text != null && text.isNotEmpty) {
      // A binary TerminalBinaryKind.paste frame rides the same AEAD channel as every other terminal
      // byte, so this works identically for a local or a relayed machine — see pasteText's doc. Only
      // the CLI's own version gates it: an older daemon never advertises the capability.
      final machine = widget.notifier.stateOf(widget.session.machineId);
      if (machine != null && machine.terminalPasteRawAvailable) {
        await widget.session.pasteText(text);
      } else {
        widget.session.terminal.paste(text);
      }
      return;
    }
    final machine = widget.notifier.stateOf(widget.session.machineId);
    if (machine != null &&
        !machine.isLocalMachine &&
        machine.terminalImagePasteAvailable) {
      final imageBytes = await NativeClipboard.readImagePng();
      if (imageBytes != null &&
          imageBytes.isNotEmpty &&
          imageBytes.length <= terminalLocalImagePasteMaxPayloadBytes) {
        await widget.session.pasteImage(imageBytes);
        return;
      }
    }
    widget.session.terminal.keyInput(TerminalKey.keyV, ctrl: true);
  }

  /// ⌘V (Ctrl+V off Apple) — taken from xterm so the fallthrough above applies.
  ///
  /// xterm binds paste itself, but only ever to its text-only action. `onKeyEvent`
  /// is the one hook that runs BEFORE its shortcut map (terminal_view.dart), so
  /// this is where the binding has to be replaced rather than added.
  KeyEventResult _onTerminalKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent) return KeyEventResult.ignored;
    if (event.logicalKey != LogicalKeyboardKey.keyV) {
      return KeyEventResult.ignored;
    }
    final keyboard = HardwareKeyboard.instance;
    if (keyboard.isShiftPressed) {
      return KeyEventResult.ignored; // ⇧⌘V is a different verb
    }

    final apple =
        defaultTargetPlatform == TargetPlatform.macOS ||
        defaultTargetPlatform == TargetPlatform.iOS;
    final pasting = apple ? keyboard.isMetaPressed : keyboard.isControlPressed;
    if (!pasting) return KeyEventResult.ignored;
    unawaited(_paste());
    return KeyEventResult.handled;
  }

  bool get _linkModifierPressed {
    final keyboard = HardwareKeyboard.instance;
    if (keyboard.isAltPressed || keyboard.isShiftPressed) return false;
    return defaultTargetPlatform == TargetPlatform.macOS
        ? keyboard.isMetaPressed && !keyboard.isControlPressed
        : keyboard.isControlPressed && !keyboard.isMetaPressed;
  }

  bool _onLinkModifierChanged(KeyEvent event) {
    const modifiers = [
      LogicalKeyboardKey.metaLeft,
      LogicalKeyboardKey.metaRight,
      LogicalKeyboardKey.controlLeft,
      LogicalKeyboardKey.controlRight,
      LogicalKeyboardKey.altLeft,
      LogicalKeyboardKey.altRight,
      LogicalKeyboardKey.shiftLeft,
      LogicalKeyboardKey.shiftRight,
    ];
    if (_linkPointerPosition != null &&
        mounted &&
        modifiers.contains(event.logicalKey)) {
      setState(() {}); // Refresh the cursor even when the mouse has not moved.
    }
    return false; // Modifier observation never consumes a terminal key.
  }

  void _scheduleLinkRefresh() {
    if (_linkPointerPosition == null || _linkRefreshPending) return;
    _linkRefreshPending = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _linkRefreshPending = false;
      if (mounted) _hoverLink(_linkPointerPosition);
    });
  }

  String? _linkAtPointer(Offset globalPosition) {
    final view = _laidOutTerminalView();
    if (view == null) return null;
    final render = view.renderTerminal;
    final local = render.globalToLocal(globalPosition);
    if (!(Offset.zero & render.size).contains(local)) return null;
    return terminalLinkAt(_viewTerminal, render.getCellOffset(local));
  }

  void _hoverLink(Offset? globalPosition) {
    _linkPointerPosition = globalPosition;
    final target = globalPosition == null
        ? null
        : _linkAtPointer(globalPosition);
    if (target != _hoveredLink) setState(() => _hoveredLink = target);
  }

  bool _onLinkTapDown(TapDownDetails details, CellOffset cell) {
    _pressedLink = _linkModifierPressed
        ? _linkAtPointer(details.globalPosition)
        : null;
    return _pressedLink != null;
  }

  void _onLinkTapUp(TapUpDetails details, CellOffset cell) {
    final target = _pressedLink;
    _pressedLink = null;
    // Read the current buffer again: streamed output may have replaced the
    // text between press and release, or this pane may now show another agent.
    if (target == null ||
        !_linkModifierPressed ||
        target != _linkAtPointer(details.globalPosition)) {
      return;
    }
    unawaited(_openLink(target));
  }

  Future<void> _openLink(String target) async {
    if (_openingLink) return;
    _openingLink = true;
    final session = widget.session;
    final notifier = widget.notifier;
    final cancellation = MediaDownloadCancellation();
    _previewCancellation = cancellation;
    try {
      final message = await _linkOpener.open(
        target,
        isLocalMachine:
            notifier.stateOf(session.machineId)?.isLocalMachine == true,
        isCancelled: () =>
            cancellation.isCancelled ||
            !mounted ||
            !identical(session, widget.session),
        downloadRemote: (path) async {
          setState(
            () => _previewProgress = const RemoteMediaProgress('', 0, null),
          );
          return _mediaDownloader.download(
            readChunk: ({required offset, revision}) =>
                notifier.readRemoteMediaChunk(
                  session.machineId,
                  session.agentId,
                  path,
                  offset: offset,
                  revision: revision,
                ),
            cancellation: cancellation,
            onProgress: (progress) {
              if (mounted &&
                  !cancellation.isCancelled &&
                  identical(session, widget.session)) {
                setState(() => _previewProgress = progress);
              }
            },
          );
        },
      );
      if (!mounted || !identical(session, widget.session) || message == null) {
        return;
      }
      ScaffoldMessenger.maybeOf(context)
          ?.showSnackBar(SnackBar(content: Text(message)));
    } finally {
      _openingLink = false;
      if (identical(_previewCancellation, cancellation)) {
        _previewCancellation = null;
        if (mounted) setState(() => _previewProgress = null);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final session = widget.session;
    _syncTerminal(session.terminal);
    final machineState = widget.notifier.stateOf(session.machineId);
    final remote = machineState != null && !machineState.isLocalMachine;
    final showComposer = _showsComposer;
    return ColoredBox(
      color: grid.AppPalette.windowBg,
      child: Column(
        children: [
          _TerminalHeader(
            notifier: widget.notifier,
            session: session,
            compact: widget.compactHeader,
            onClose: widget.onClose,
            pinned: widget.pinned,
            onTogglePin: widget.onTogglePin,
            paneDrag: widget.paneDrag,
          ),

          Divider(height: 1, color: AppColors.border),
          Expanded(
            child: Stack(
              children: [
                Positioned.fill(
                  child: MouseRegion(
                    onEnter: (event) => _hoverLink(event.position),
                    onHover: (event) => _hoverLink(event.position),
                    onExit: (_) => _hoverLink(null),
                    child: Tooltip(
                      message: _hoveredLink == null
                          ? ''
                          : '${defaultTargetPlatform == TargetPlatform.macOS ? '⌘' : 'Ctrl'}-click to open\n$_hoveredLink',
                      child: TerminalView(
                        session.terminal,
                        key: _terminalViewKey,
                        controller: _controller,
                        autoResize: widget.visible,
                        scrollController: _scrollController,
                        focusNode: _focusNode,
                        autofocus: widget.focused && !showComposer,
                        readOnly: widget.readOnly || !session.acceptsInput,
                        theme: darkTerminalTheme,
                        padding: const EdgeInsets.all(10),
                        textStyle: terminalFontStore.value,
                        // ⚠️ The terminal is NOT app chrome, and the user said so:
                        // it carries its own font settings (Settings ▸ Terminal,
                        // [terminalFontStore]) precisely because its type is a grid
                        // a remote program is drawing into, not a label.
                        //
                        // Without this, `TerminalView` falls back to
                        // `MediaQuery.textScalerOf(context)` (xterm's
                        // terminal_view.dart:257), so the app-wide UI size would
                        // change the cell size — and a changed cell size is not
                        // cosmetic here: it re-derives `rows`, which fires
                        // `Terminal.resize` → `session.resize` → a `terminal_resize`
                        // frame on the wire and a real SIGWINCH at the far end.
                        //
                        // Read in `createRenderObject`, not only on update, so this
                        // holds from the very first frame — no scaled first paint
                        // and no startup resize.
                        textScaler: TextScaler.noScaling,
                        onKeyEvent: _onTerminalKey,
                        onTapDown: _onLinkTapDown,
                        onTapUp: _onLinkTapUp,
                        mouseCursor:
                            _hoveredLink != null && _linkModifierPressed
                            ? SystemMouseCursors.click
                            : SystemMouseCursors.text,
                        onSecondaryTapDown: (_, _) => _copyOrPaste(),

                        onAltBufferScroll: session.scrollViaTmuxCopyMode
                            ? (up) => session.sendScrollCommand(up, 1)
                            : null,
                      ),
                    ),
                  ),
                ),
                if (session.status == TerminalSessionStatus.opening ||
                    session.status == TerminalSessionStatus.resyncing)
                  Positioned(
                    top: 12,
                    right: 14,
                    child: _OverlayBadge(
                      label: session.status == TerminalSessionStatus.opening
                          ? 'ATTACHING'
                          : 'RESYNCING',
                      spinning: true,
                    ),
                  ),
                if (session.status == TerminalSessionStatus.error ||
                    session.status == TerminalSessionStatus.takenOver)
                  Positioned.fill(
                    child: _FrozenOverlay(
                      session: session,
                      onRetry: () => widget.notifier.selectAgent(
                        session.machineId,
                        session.agentId,
                      ),
                    ),
                  ),
                // Bottom, not top-right alongside ATTACHING/RESYNCING: the two are not mutually
                // exclusive (a reconnect can happen mid-upload) and must not overlap each other.
                if (session.uploadProgress != null || _previewProgress != null)
                  Positioned(
                    left: 14,
                    right: 14,
                    bottom: 12,
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        if (session.uploadProgress != null)
                          _TransferProgressBadge(
                            label: 'Uploading ${session.uploadProgress!.label}',
                            fraction: session.uploadProgress!.percent,
                            onCancel: () => unawaited(session.cancelUpload()),
                          ),
                        if (session.uploadProgress != null &&
                            _previewProgress != null)
                          const SizedBox(height: 8),
                        if (_previewProgress != null)
                          _TransferProgressBadge(
                            label: _previewProgress!.totalBytes == null
                                ? 'Preparing preview…'
                                : 'Downloading ${_previewProgress!.filename}',
                            fraction: _previewProgress!.fraction,
                            onCancel: () => _previewCancellation?.cancel(),
                          ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
          // The grip is shown whether or not the box is: collapsed, it is the only way back.
          if (!widget.compactHeader &&
              remote &&
              widget.onToggleComposer != null)
            ComposerGrip(
              expanded: widget.composerVisible,
              onPressed: widget.onToggleComposer!,
            ),
          if (showComposer)
            TerminalComposer(session: session, focusNode: _composerFocus),
        ],
      ),
    );
  }
}

class _TerminalHeader extends StatelessWidget {
  final AppNotifier notifier;
  final TerminalSession session;
  final VoidCallback? onClose;
  final bool pinned;
  final bool compact;
  final VoidCallback? onTogglePin;

  /// This strip's drag gesture, or null when there is nothing to drag.
  ///
  /// Null with a SINGLE pane, and then the strip is inert on purpose: there is
  /// no other tile to trade places with, so a drag would have no meaning to
  /// give it. It used to move the WINDOW here (window_manager's
  /// DragToMoveArea, left over from hiding the title bar) — but once AppKit's
  /// `startDragging` takes a gesture it keeps it, so the two meanings cannot
  /// share one drag. The window is moved from HarnessTopBar now.
  final PaneDragHandle? paneDrag;

  const _TerminalHeader({
    required this.notifier,
    required this.session,
    this.onClose,
    this.pinned = false,
    this.compact = false,
    this.onTogglePin,
    this.paneDrag,
  });

  @override
  Widget build(BuildContext context) {
    final color = switch (session.status) {
      TerminalSessionStatus.controlling => AppColors.success,
      TerminalSessionStatus.opening ||
      TerminalSessionStatus.resyncing => AppColors.warning,
      TerminalSessionStatus.takenOver => AppColors.warning,
      TerminalSessionStatus.error => AppColors.danger,
      TerminalSessionStatus.closed => AppColors.mutedStrong,
    };
    final profile = notifier
        .stateOf(session.machineId)
        ?.agents
        .where((agent) => agent.id == session.agentId)
        .firstOrNull
        ?.codexHome;
    final statusLabel = switch (session.status) {
      TerminalSessionStatus.controlling => 'controlling',
      TerminalSessionStatus.opening => 'attaching',
      TerminalSessionStatus.resyncing => 'resyncing',
      TerminalSessionStatus.takenOver => 'taken over',
      TerminalSessionStatus.error => 'error',
      TerminalSessionStatus.closed => 'closed',
    };
    final statusMark = switch (session.status) {
      TerminalSessionStatus.opening ||
      TerminalSessionStatus.resyncing => SizedBox(
        width: 13,
        height: 13,
        child: CircularProgressIndicator(strokeWidth: 1.7, color: color),
      ),
      TerminalSessionStatus.controlling ||
      TerminalSessionStatus.takenOver ||
      TerminalSessionStatus.error ||
      TerminalSessionStatus.closed => Container(
        width: 8,
        height: 8,
        decoration: BoxDecoration(color: color, shape: BoxShape.circle),
      ),
    };
    final machine = notifier.stateOf(session.machineId);
    final agent = machine?.agents
        .where((a) => a.id == session.agentId)
        .firstOrNull;
    final project = agent?.project;
    final contextLabel = [
      if (project != null) project.name,
      if (project?.branch != null) project!.branch!,
    ].join(' / ');
    final strip = SizedBox(
      height: compact ? 38 : 46,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: _stripPadding),
        child: Row(
          children: [
            EngineMark(engine: session.engineId, size: 17),
            const SizedBox(width: 8),
            Expanded(
              // Double click the NAME to rename — the same dialog the rail's
              // row opens, so one name has one way to change wherever it is
              // shown. Scoped to the text rather than the whole strip: the
              // strip is the drag handle, and a double click that both renamed
              // and looked like the start of a drag would be two answers to one
              // gesture.
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onDoubleTap: () => unawaited(
                  showAgentRenameDialog(
                    context,
                    notifier,
                    session.machineId,
                    session.agentId,
                    session.agentName,
                  ),
                ),
                child: Tooltip(
                  message: profile == null
                      ? 'Double-click to rename'
                      : 'Codex profile: $profile\nDouble-click to rename',
                  waitDuration: const Duration(milliseconds: 700),
                  child: Text(
                    // The profile path's basename used to trail the name here, but for the
                    // default profile that basename is literally the hidden `.codex` folder —
                    // meaningless clutter on every ordinary codex agent. The tooltip above still
                    // carries the full path for whoever actually needs it.
                    session.agentName,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: AppColors.text,
                      fontFamily: AppFonts.sans,
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ),
            ),
            if (compact && project != null) ...[
              const SizedBox(width: 12),
              Flexible(
                child: Tooltip(
                  message:
                      '${project.cwd}\n${project.remote ?? project.root ?? ""}',
                  child: Text(
                    contextLabel,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 11, color: AppColors.textSoft),
                  ),
                ),
              ),
            ],
            if (compact) ...[
              const SizedBox(width: 12),
              Flexible(
                child: Tooltip(
                  message: machine?.machine.displayName ?? session.machineId,
                  child: Text(
                    machine?.machine.displayName ?? session.machineId,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 11,
                      color: AppColors.mutedStrong,
                    ),
                  ),
                ),
              ),
            ],
            const SizedBox(width: 6),
            if (!compact && session.status == TerminalSessionStatus.controlling)
              Padding(padding: const EdgeInsets.all(4), child: statusMark)
            else if (session.status != TerminalSessionStatus.controlling)
              Tooltip(
                message: statusLabel,
                child: Padding(
                  padding: const EdgeInsets.all(4),
                  child: statusMark,
                ),
              ),
            // Which of the three paths carries this pane's bytes. Absent for a local machine's own
            // terminal, which has no such distinction and so gets no badge.
            //
            // The wire word and the word a person reads differ for the middle state, deliberately:
            // the CLI sends 'turn' (it is a TURN allocation) but both middle and last are relays to
            // a reader, so they read as "relay" and "ws". 'relay' on the wire kept its original
            // meaning — the backend WebSocket — so an older CLI is never mislabelled.
            if (!compact && session.linkMode != null)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 2),
                child: _LinkModeMark(mode: session.linkMode!),
              ),
            // Before the close button: pinning is the rarer act, and a control
            // that appears to the LEFT of the one people aim for by muscle
            // memory cannot shift it under their pointer.
            if (!compact && onTogglePin != null)
              PanePinButton(pinned: pinned, onPressed: onTogglePin!),
            if (onClose != null) PaneCloseButton(onPressed: onClose!),
          ],
        ),
      ),
    );
    final handle = paneDrag;
    if (handle == null) return strip;

    return Draggable<PaneDragRef>(
      data: handle.ref,
      // The grip is kept where the hand took it, so the ghost stays under the
      // cursor at the same spot on the header it was picked up by.
      dragAnchorStrategy: childDragAnchorStrategy,
      onDragStarted: () => paneDragging.value = handle.ref,
      onDragEnd: (_) => paneDragging.value = null,
      onDraggableCanceled: (_, _) => paneDragging.value = null,
      feedback: _PaneGhost(session: session, size: handle.size, header: strip),

      // The header itself does NOT change — the whole tile fades instead, in
      // _PaneCell, so what dims is the thing that is moving rather than one
      // strip of it.
      child: strip,
    );
  }
}

/// The pane header's transport badge: a compact topology for the path carrying terminal bytes.
///
/// The three shapes describe one hop, an intermediate hop, and a central server respectively. That
/// makes the modes distinguishable without colour while keeping the badge small enough for a four-pane
/// layout. The wire name `relay` still means the backend WebSocket; only its human-facing label is WS.
class _LinkModeMark extends StatelessWidget {
  final String mode;

  const _LinkModeMark({required this.mode});

  @override
  Widget build(BuildContext context) {
    final (icon, color, label) = switch (mode) {
      'p2p' => (
        LucideIcons.link2,
        AppColors.success,
        'P2P · Direct peer connection',
      ),
      'turn' => (
        LucideIcons.waypoints,
        AppColors.warning,
        'TURN · Via Cloudflare relay',
      ),
      _ => (
        LucideIcons.server,
        AppColors.mutedStrong,
        'WS · Via Harness WebSocket relay',
      ),
    };
    return Tooltip(
      message: label,
      child: Icon(icon, size: 14, color: color, semanticLabel: label),
    );
  }
}

class _OverlayBadge extends StatelessWidget {
  final String label;
  final bool spinning;
  const _OverlayBadge({required this.label, required this.spinning});

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 6),
      decoration: BoxDecoration(
        color: grid.AppPalette.panelBg.withValues(alpha: 0.93),
        border: Border.all(color: AppColors.borderStrong),
        // Left at 4 on purpose. This badge is drawn INSIDE a terminal pane, and
        // the pane is off-limits to the app-wide design pass — it is reviewed
        // with the terminal, not with the app's chrome.
        borderRadius: BorderRadius.circular(4),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (spinning) ...[
            const SizedBox(
              width: 11,
              height: 11,
              child: CircularProgressIndicator(strokeWidth: 1.5),
            ),
            const SizedBox(width: 7),
          ],
          Text(
            label,
            style: TextStyle(
              color: AppColors.textSoft,
              fontFamily: AppFonts.sans,
              fontSize: 10,
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
    );
  }
}

/// Shown while an image/file drag-drop upload is in flight — see [TerminalSession.uploadProgress].
/// Same container language as [_OverlayBadge] (panelBg@0.93, borderStrong border, radius 4,
/// textSoft label) with a thin [LinearProgressIndicator] in place of a spinner, plus a Cancel
/// affordance.
class _TransferProgressBadge extends StatelessWidget {
  final String label;
  final double? fraction;
  final VoidCallback onCancel;
  const _TransferProgressBadge({
    required this.label,
    required this.fraction,
    required this.onCancel,
  });

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final percentLabel = fraction == null
        ? ''
        : ' · ${(fraction! * 100).round()}%';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: grid.AppPalette.panelBg.withValues(alpha: 0.93),
        border: Border.all(color: AppColors.borderStrong),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  '$label$percentLabel',
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: AppColors.textSoft,
                    fontFamily: AppFonts.sans,
                    fontSize: 10,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              InkWell(
                onTap: onCancel,
                child: Text(
                  'CANCEL',
                  style: TextStyle(
                    color: AppColors.textSoft,
                    fontFamily: AppFonts.sans,
                    fontSize: 10,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          ClipRRect(
            borderRadius: BorderRadius.circular(3),
            child: LinearProgressIndicator(
              minHeight: 4,
              value: fraction,
              backgroundColor: AppColors.border,
              color: AppColors.accent,
            ),
          ),
        ],
      ),
    );
  }
}

class _FrozenOverlay extends StatelessWidget {
  final TerminalSession session;
  final VoidCallback onRetry;
  const _FrozenOverlay({required this.session, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final takenOver = session.status == TerminalSessionStatus.takenOver;
    final accent = takenOver ? AppColors.warning : AppColors.danger;
    return ColoredBox(
      color: grid.AppPalette.windowBg.withValues(alpha: 0.67),
      child: Center(
        child: Container(
          constraints: const BoxConstraints(maxWidth: 440),
          padding: const EdgeInsets.all(18),
          decoration: BoxDecoration(
            color: grid.AppPalette.panelBg,
            border: Border.all(color: const Color(0xff7f1d1d)),
            borderRadius: BorderRadius.circular(6),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'TERMINAL FROZEN',
                style: TextStyle(
                  color: accent,
                  fontFamily: AppFonts.sans,
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                takenOver
                    ? 'Another app is controlling this terminal.'
                    : session.errorMessage ??
                          session.errorCode ??
                          'Stream closed',
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: AppColors.textSoft,
                  fontFamily: AppFonts.sans,
                  fontSize: 11,
                ),
              ),
              const SizedBox(height: 14),
              OutlinedButton.icon(
                onPressed: onRetry,
                icon: Icon(takenOver ? Icons.link : Icons.refresh, size: 16),
                label: Text(takenOver ? 'CONNECT' : 'ATTACH NEW STREAM'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The whole tile, carried under the cursor.
///
/// ⚠️ THIS IS DRAWN, NOT PHOTOGRAPHED, AND THE PHOTOGRAPH IS WHY. The obvious
/// way to carry "the whole pane" is RepaintBoundary.toImage() on press — and it
/// FROZE THE APP. That call is a GPU readback on the raster thread, and the
/// raster thread in this app is never idle: every pane holds a terminal that
/// repaints on its own, so asking it to stop and hand a surface back on every
/// pointer-down deadlocked the window. It is not a tuning problem; there is
/// nothing to tune down to.
///
/// So the ghost is built from what is already known — the pane's measured size
/// and its own header — and the body is a plain surface rather than a copy of
/// the scrollback. It reads as the tile because it is tile-SHAPED and carries
/// the tile's name, which is what the eye is following.
///
/// See-through on purpose: a full-size opaque copy sits exactly over the tile
/// being aimed at and hides the "Swap with this pane" highlight that says the
/// drop will land.
class _PaneGhost extends StatelessWidget {
  const _PaneGhost({
    required this.session,
    required this.size,
    required this.header,
  });

  final TerminalSession session;

  /// The tile's size, handed down from the grid's LayoutBuilder.
  final Size size;

  final Widget header;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final tile = size;
    return Material(
      color: Colors.transparent,
      child: Opacity(
        opacity: 0.75,
        child: Container(
          width: tile.width,
          height: tile.height,
          decoration: BoxDecoration(
            color: grid.AppPalette.windowBg,
            border: Border.all(color: AppColors.accent, width: 1.5),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withValues(alpha: 0.45),
                blurRadius: 24,
                offset: const Offset(0, 10),
              ),
            ],
          ),
          child: Column(
            children: [
              header,
              Divider(height: 1, color: AppColors.border),
              Expanded(
                child: Center(
                  child: Text(
                    session.agentName,
                    style: TextStyle(
                      color: AppColors.mutedStrong,
                      fontFamily: AppFonts.sans,
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
