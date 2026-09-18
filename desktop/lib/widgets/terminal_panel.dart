import '../sharing/share_harness_dialog.dart';

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
import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import 'terminal_find_bar.dart';
import '../terminal/terminal_search.dart';
import '../terminal/terminal_snapshot.dart';
import '../terminal/terminal_binary.dart';
import '../terminal/terminal_font_store.dart';
import '../terminal/terminal_link_opener.dart';
import '../terminal/remote_media_download.dart';
import '../terminal/terminal_links.dart';
import '../terminal/terminal_session.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import '../terminal/terminal_viewport.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../theme/app_theme.dart';
import 'engine_identity.dart';
import 'grid_model_picker.dart';
import 'pane_header_actions.dart';

/// The pane header's own horizontal inset.
const double _stripPadding = 14;

typedef TerminalNotice = ({String label, String detail, IconData icon});

class TerminalPanel extends StatefulWidget {
  final AppNotifier notifier;
  final TerminalSession session;

  /// Takes this tile off the grid. Null when the terminal is the whole window,
  /// where there is nothing to close it back to.
  final VoidCallback? onClose;
  final VoidCallback? onRestart;

  /// Forks this harness — a second agent with its history (fork_agent_dialog.dart).
  final VoidCallback? onFork;
  final VoidCallback? onDelete;

  final VoidCallback? onToggleZoom;
  final bool zoomed;

  /// This native terminal took the keyboard, so its grid tile becomes focused.
  final VoidCallback? onRendererFocus;

  /// Only the focused grid tile may claim keyboard focus on mount/rebuild.
  final bool focused;
  final bool visible;
  final Size? viewportSize;

  /// A shared terminal can move to another tab without being remounted.
  final (String, int)? paneLocation;
  final (int, int, int?)? layoutRequest;
  final bool compactHeader;

  /// The tile's own header strip — engine, title, status, pin, close — and
  /// whether it is built at all. False on the phone, where [PhoneHeader] already
  /// names the agent above this panel, there is no tile to pin, close or drag,
  /// and the pane takes the full remaining height (`phone/terminal_page.dart`
  /// in the mobile package). Find has no way in there — every
  /// [TerminalFindAction] caller lives in the desktop screens — so the row's
  /// Find overlay goes with it.
  final bool showHeader;
  final int focusRequest;

  /// Whether this tile's composer textbox is showing. Only consulted for a remote machine.
  final bool composerVisible;
  final bool readOnly;
  final TerminalNotice? notice;

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
    this.viewportSize,
    this.paneLocation,
    this.layoutRequest,
    this.compactHeader = false,
    this.showHeader = true,
    this.focusRequest = 0,
    this.composerVisible = false,
    this.readOnly = false,
    this.notice,
    this.onToggleComposer,
    this.onClose,
    this.onRestart,
    this.onFork,
    this.onDelete,
    this.onToggleZoom,
    this.zoomed = false,
    this.onRendererFocus,
    this.paneDrag,
    this.linkOpener,
    this.mediaDownloader,
  });

  @override
  State<TerminalPanel> createState() => _TerminalPanelState();
}

class _TerminalPanelState extends State<TerminalPanel>
    with WidgetsBindingObserver
    implements TerminalViewport {
  static const _dialScale = 2.5;
  static const _dialStopVelocity = 40.0;
  static const _dialDecayPerSecond = 0.002;

  final TerminalController _controller = TerminalController();
  final ScrollController _scrollController = ScrollController(
    keepScrollOffset: false,
  );
  final FocusNode _focusNode = FocusNode();
  final FocusNode _composerFocus = FocusNode();
  final _findBarKey = GlobalKey<TerminalFindBarState>();
  TerminalSearch? _find;
  String _lastFindQuery = '';
  bool _lastFindCaseSensitive = false;
  CellAnchor? _lastFindAnchor;
  Buffer? _lastFindBuffer;
  TerminalHighlight? _findHighlight;
  Buffer? _findPaintedBuffer;
  BufferRangeLine? _findPaintedRange;
  Buffer? _findOriginBuffer;
  CellAnchor? _findOriginLine;
  double _findOriginFraction = 0;
  bool _findOriginAtEnd = false;
  bool _findRevealPending = false;
  late Terminal _viewTerminal;
  late GlobalKey<TerminalViewState> _terminalViewKey;
  Timer? _dialInertiaTimer;
  Timer? _cursorBlinkTimer;
  ValueListenable<TickerModeData>? _tickerMode;
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
  bool _followTail = true;
  TerminalStyle _terminalFont = terminalFontStore.value;
  bool _observingLinkModifiers = false;
  late final RemoteMediaDownloader _mediaDownloader;
  MediaDownloadCancellation? _previewCancellation;
  RemoteMediaProgress? _previewProgress;
  Object? _headerPresentation;
  Widget? _header;

  @override
  void initState() {
    super.initState();
    _viewTerminal = widget.session.terminal;
    _viewTerminal.addListener(_scheduleLinkRefresh);
    _scrollController.addListener(_onScrollChanged);
    _terminalViewKey = GlobalKey<TerminalViewState>();
    _linkOpener = widget.linkOpener ?? TerminalLinkOpener();
    _mediaDownloader = widget.mediaDownloader ?? RemoteMediaDownloader();
    _focusNode.addListener(_handleFocusChange);
    _composerFocus.addListener(_handleComposerFocusChange);
    WidgetsBinding.instance.addObserver(this);
    widget.session.attachViewport(this);
    widget.session.addListener(_onSessionChanged);
    terminalFontStore.addListener(_onFontChanged);
    // Colours repaint the view in place — no relayout, no resize frame — but
    // they still need a rebuild to reach it, and this widget reads the store
    // directly rather than through a builder.
    terminalThemeStore.addListener(_onFontChanged);
    _afterTerminalMounted();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _updateTickerMode();
  }

  @override
  void activate() {
    super.activate();
    _updateTickerMode();
  }

  @override
  void deactivate() {
    _stopCursorBlink();
    super.deactivate();
  }

  void _updateTickerMode() {
    final mode = TickerMode.getValuesNotifier(context);
    if (!identical(mode, _tickerMode)) {
      _tickerMode?.removeListener(_syncCursorBlink);
      _tickerMode = mode..addListener(_syncCursorBlink);
    }
    _syncCursorBlink();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) =>
      _syncCursorBlink();

  @override
  void didUpdateWidget(TerminalPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.session, widget.session)) {
      _closeFind(restore: false, focus: false, rebuild: false);
      _clearLastFind();
      _lastFindQuery = '';
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
      _observeLinkModifiers(false);
      _terminalViewKey = GlobalKey<TerminalViewState>();
      _followTail = true;
      _cursorBlinkVisible = true;
      widget.session.setCursorBlinkPhase(true);
      _afterTerminalMounted();
    }
    if (oldWidget.visible && !widget.visible) {
      _rememberFollowTail();
      _focusNode.unfocus();
      _composerFocus.unfocus();
      _cancelDialInertia();
      _linkPointerPosition = null;
      _hoveredLink = null;
      _pressedLink = null;
      _observeLinkModifiers(false);
    }
    if (widget.visible &&
        (!oldWidget.visible || oldWidget.paneLocation != widget.paneLocation)) {
      _afterTerminalMounted();
    }
    if (oldWidget.viewportSize != widget.viewportSize ||
        oldWidget.layoutRequest != widget.layoutRequest) {
      // Geometry can change while a resize handle or another control owns
      // the keyboard. Refresh the viewport without claiming input ownership.
      _afterTerminalMounted(claimFocus: false);
    }
    if (widget.focused &&
        (!oldWidget.focused || oldWidget.focusRequest != widget.focusRequest)) {
      _claimFocusAfterFrame();
    }
    // Showing or hiding the box changes how many rows the terminal has. Re-measure so the remote
    // grid is resized to what is actually on screen.
    if (oldWidget.composerVisible != widget.composerVisible) {
      _afterTerminalMounted();
    }
    _syncCursorBlink();
  }

  @override
  void dispose() {
    _closeFind(restore: false, focus: false, rebuild: false);
    _clearLastFind();
    WidgetsBinding.instance.removeObserver(this);
    _tickerMode?.removeListener(_syncCursorBlink);
    _previewCancellation?.cancel();
    _viewTerminal.removeListener(_scheduleLinkRefresh);
    _scrollController.removeListener(_onScrollChanged);
    _observeLinkModifiers(false);
    widget.session.setCursorBlinkPhase(true);
    widget.session.removeListener(_onSessionChanged);
    widget.session.detachViewport(this);
    terminalFontStore.removeListener(_onFontChanged);
    terminalThemeStore.removeListener(_onFontChanged);
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
    return machineState?.isLocalMachine != true && widget.composerVisible;
  }

  /// The composer refuses focus while it is disabled, which it is until the stream goes live. When
  /// a selection lands on a still-attaching agent, the claim is parked here and made again from
  /// [_onSessionChanged] the moment it starts accepting input.
  bool _composerFocusPending = false;

  void _onSessionChanged() {
    if (!mounted) return;
    _syncCursorBlink();
    // A pane can open BEFORE its screen exists: over the relay it mounts empty
    // and the retained scrollback is replayed a moment later, so the jump in
    // `_afterTerminalMounted` lands on nothing and the screen then fills in
    // above the reader. xterm does not close this — its own `_scrollToBottom`
    // answers typing and the keyboard opening, never new output.
    //
    // Gated on [_followTail], which is kept as "the view is showing its end",
    // so a pane the reader has scrolled up in — or one restored to a saved
    // position — is not at the end, and is never followed.
    // Visible only. A parked pane holds the offset it was left at while output
    // arrives behind it — `swarm_screen_test` pins that — and comes back to the
    // end through `_afterTerminalMounted`, which is where returning is handled.
    if (_followTail && widget.visible) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || !widget.visible) return;
        if (!_followTail || !_scrollController.hasClients) return;
        final position = _scrollController.position;
        if (position.pixels != position.maxScrollExtent) {
          position.jumpTo(position.maxScrollExtent);
        }
      });
    }
    if (!_composerFocusPending) return;
    if (!widget.focused || !_showsComposer) {
      _composerFocusPending = false;
      return;
    }
    if (widget.readOnly || !widget.session.acceptsInput) return;
    _composerFocusPending = false;
    // Deferred a frame on purpose. This panel registers its session listener before the composer
    // registers its own (a parent's initState runs first), so at this instant the field is still
    // built as disabled — and a disabled field REFUSES focus. Claiming after the frame the
    // composer rebuilds in is what makes the claim actually land.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_canClaimInput || !widget.focused || !_showsComposer) return;
      if (widget.readOnly || !widget.session.acceptsInput) return;
      _composerFocus.requestFocus();
    });
  }

  /// The vendored renderer already treats a changed `textStyle` as a full re-layout — see
  /// `RenderTerminal.textStyle`'s setter — which recomputes cols/rows from the new cell size and
  /// resizes the remote session automatically. This just needs to get the new value into `build()`.
  void _onFontChanged() {
    if (!mounted) return;
    if (_terminalFont != terminalFontStore.value) {
      _terminalFont = terminalFontStore.value;
      _afterTerminalMounted(claimFocus: false);
    }
    setState(() {});
  }

  void _syncTerminal(Terminal terminal) {
    if (identical(_viewTerminal, terminal)) return;

    final previous = _viewTerminal.buffer;
    final next = terminal.buffer;
    final render = _laidOutTerminalView()?.renderTerminal;
    final lineHeight = render?.lineHeight;
    final position = _scrollController.hasClients
        ? _scrollController.position
        : null;
    final viewportRow = position != null && lineHeight != null
        ? (position.pixels / lineHeight).floor()
        : null;
    final viewportFraction = position != null && lineHeight != null
        ? position.pixels / lineHeight - viewportRow!
        : 0.0;
    final atEnd = _followTail || position == null;
    final originRow = _findOriginLine?.attached == true
        ? _findOriginLine!.y
        : null;
    final originFraction = _findOriginFraction;
    final originAtEnd = _findOriginAtEnd;
    final match =
        _find?.match?.begin ??
        (_lastFindAnchor?.attached == true ? _lastFindAnchor!.offset : null);
    final selection = _controller.selection;
    final selectedText = selection == null ? null : previous.getText(selection);
    final locations = remapTerminalRows(previous, next, [
      if (!atEnd) ?viewportRow,
      ?originRow,
      ?match?.y,
      ?selection?.begin.y,
      ?selection?.end.y,
    ]);
    int row(int old) => locations[old] ?? old.clamp(0, next.lines.length - 1);
    CellOffset location(CellOffset old) =>
        CellOffset(old.x.clamp(0, terminal.viewWidth - 1), row(old.y));
    final wasFinding = _find != null;
    _closeFind(restore: false, focus: false, rebuild: false);
    _clearLastFind();
    // Selection anchors belong to a specific circular buffer. Detach them
    // before the TerminalView starts laying out the replacement terminal.
    _controller.clearSelection();
    _viewTerminal.removeListener(_scheduleLinkRefresh);
    _viewTerminal = terminal;
    _viewTerminal.addListener(_scheduleLinkRefresh);
    _pressedLink = null;
    _hoveredLink = null;
    _observeLinkModifiers(false);
    _cancelDialInertia();
    _alternateScrollRemainder = 0;
    _cursorBlinkVisible = true;
    widget.session.setCursorBlinkPhase(true);
    if (position != null &&
        lineHeight != null &&
        !atEnd &&
        viewportRow != null) {
      // Correct before the retained renderer lays out the replacement, so its
      // first frame already shows the reader's location without a scroll flash.
      position.correctPixels(
        (row(viewportRow) + viewportFraction) * lineHeight,
      );
    }
    if (match != null) {
      _lastFindBuffer = next;
      _lastFindAnchor = next.createAnchorFromOffset(location(match));
    }
    if (selection != null &&
        locations.containsKey(selection.begin.y) &&
        locations.containsKey(selection.end.y)) {
      final range = selection is BufferRangeBlock
          ? BufferRangeBlock(location(selection.begin), location(selection.end))
          : BufferRangeLine(location(selection.begin), location(selection.end));
      if (next.getText(range) == selectedText) {
        _controller.setSelection(
          next.createAnchorFromOffset(range.begin),
          next.createAnchorFromOffset(range.end),
        );
      }
    }
    if (wasFinding) {
      _findOriginBuffer = next;
      _findOriginAtEnd = originAtEnd;
      _findOriginFraction = originFraction;
      if (originRow != null) {
        _findOriginLine = next.createAnchor(0, row(originRow));
      }
      _findRevealPending = true;
      _find = TerminalSearch(
        terminal,
        origin: match == null ? null : location(match),
      )..addListener(_onFindChanged);
      _find!.setQuery(_lastFindQuery, caseSensitive: _lastFindCaseSensitive);
    }
    _followTail = atEnd;
    _afterTerminalMounted(scrollToEnd: atEnd);
  }

  /// Typing in the composer focuses the tile, exactly like clicking into the terminal does.
  void _handleComposerFocusChange() {
    if (_composerFocus.hasFocus) widget.onRendererFocus?.call();
  }

  void _handleFocusChange() {
    _syncCursorBlink();
    if (_focusNode.hasFocus) {
      widget.onRendererFocus?.call();
    }
  }

  /// Re-establishes the native text-input connection on pane activation.
  ///
  /// Replacing an agent remounts TerminalView but deliberately keeps this
  /// FocusNode. A plain requestFocus is a no-op when that node already owns
  /// focus, leaving macOS without a TextInputConnection until the user clicks
  /// the terminal. TerminalView.requestKeyboard handles both cases: it moves
  /// focus when needed, or opens the connection immediately when focus stayed
  /// on this tile. That is essential for ordinary keys and IMEs alike.
  bool _claimFocus(TerminalViewState view, {bool navigating = false}) {
    if (!_canClaimInput ||
        (!navigating && (!widget.focused || !widget.visible))) {
      return false;
    }
    if (_find != null) {
      final bar = _findBarKey.currentState;
      if (bar == null) return false;
      bar.focusSearch(selectAll: false);
      return true;
    }
    if (_composerFocus.hasFocus) return true;
    // On a remote pane the box gets the caret, not the terminal. Landing in the terminal would
    // hand the user the per-keystroke path by default — the exact cost the box exists to avoid.
    if (_showsComposer && !widget.readOnly) {
      if (widget.session.acceptsInput && _composerFocus.canRequestFocus) {
        _composerFocus.requestFocus();
        return true;
      }
      _composerFocusPending = true;
      return false;
    }
    view.requestKeyboard();
    return true;
  }

  bool get _canClaimInput =>
      mounted &&
      _focusNode.canRequestFocus &&
      ModalRoute.of(context)?.isCurrent != false;

  @override
  bool focusInput() {
    // The model has already selected this retained view, but widget visibility
    // and focus flags will not catch up until the canvas's next frame.
    if (!_canClaimInput ||
        !identical(widget.notifier.focusedPane?.session, widget.session)) {
      return false;
    }
    final view = _laidOutTerminalView();
    if (view == null) return false;
    return _claimFocus(view, navigating: true);
  }

  void _claimFocusAfterFrame() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final view = _laidOutTerminalView();
      if (view != null) _claimFocus(view);
    });
  }

  /// Retaining a renderer must not retain a polling loop. Only the focused,
  /// interactive terminal in the active window needs a cursor clock. Observe
  /// ticker mode without rebuilding the subtree when a route covers it.
  void _syncCursorBlink() {
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    final findEnabled =
        mounted &&
        widget.visible &&
        (_tickerMode?.value.enabled ?? false) &&
        (lifecycle == null || lifecycle == AppLifecycleState.resumed);
    _find?.setEnabled(findEnabled);
    if (!findEnabled) _clearFindHighlight();
    final enabled =
        mounted &&
        widget.visible &&
        !widget.readOnly &&
        _focusNode.hasFocus &&
        widget.session.acceptsInput &&
        (_tickerMode?.value.enabled ?? false) &&
        (lifecycle == null || lifecycle == AppLifecycleState.resumed);
    if (!enabled) {
      _stopCursorBlink();
      return;
    }
    _cursorBlinkTimer ??= Timer.periodic(
      const Duration(milliseconds: 500),
      (_) => _setCursorBlinkVisible(!_cursorBlinkVisible),
    );
  }

  void _stopCursorBlink() {
    _cursorBlinkTimer?.cancel();
    _cursorBlinkTimer = null;
    _setCursorBlinkVisible(true);
  }

  void _setCursorBlinkVisible(bool visible) {
    if (visible == _cursorBlinkVisible) return;
    _cursorBlinkVisible = visible;
    widget.session.setCursorBlinkPhase(visible);
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

  void _afterTerminalMounted({
    bool clearSelection = false,
    bool scrollToEnd = true,
    bool claimFocus = true,
    int retries = 2,
  }) {
    // Request alignment before this frame's layout, so even a retained pane's
    // first visible paint uses its new size. Keep Find's explicit location.
    if (scrollToEnd && _find == null) {
      _cancelDialInertia();
      _followTail = true;
      _laidOutTerminalView()?.scrollToBottom();
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !widget.visible) return;
      if (clearSelection) _controller.clearSelection();
      final view = _laidOutTerminalView();
      if (view == null) {
        if (retries > 0) {
          _afterTerminalMounted(
            clearSelection: clearSelection,
            scrollToEnd: scrollToEnd,
            claimFocus: claimFocus,
            retries: retries - 1,
          );
        }
        return;
      }
      final renderTerminal = view.renderTerminal;
      final cellSize = renderTerminal.cellSize;
      final renderSize = renderTerminal.size;
      if (cellSize.width > 0 && cellSize.height > 0) {
        widget.session.reportViewport(
          renderSize.width ~/ cellSize.width,
          renderSize.height ~/ cellSize.height,
        );
      }
      if (scrollToEnd && _followTail && _find == null) {
        view.scrollToBottom();
      }
      // Never over the composer: a rebuild that re-focuses this tile while someone is typing into
      // the box would pull the caret out from under them mid-sentence.
      if (claimFocus) _claimFocus(view);
      if (_find != null) _onFindChanged();
      if (_linkPointerPosition != null) _hoverLink(_linkPointerPosition);
    });
  }

  @override
  void find(TerminalFindAction action) {
    if (!mounted || !widget.visible || !widget.focused) return;
    final wasClosed = _find == null;
    if (wasClosed) {
      final view = _laidOutTerminalView();
      if (view == null || !_scrollController.hasClients) return;
      final position = _scrollController.position;
      final height = view.renderTerminal.lineHeight;
      final row = (position.pixels / height).floor().clamp(
        0,
        _viewTerminal.buffer.lines.length - 1,
      );
      _findOriginBuffer = _viewTerminal.buffer;
      _findOriginLine = _findOriginBuffer!.createAnchor(0, row);
      _findOriginFraction = position.pixels / height - row;
      _findOriginAtEnd = position.maxScrollExtent - position.pixels < 1;
      var origin = CellOffset(0, row);
      if (action != TerminalFindAction.open &&
          _lastFindAnchor?.attached == true &&
          identical(_lastFindBuffer, _viewTerminal.buffer)) {
        final last = _lastFindAnchor!.offset;
        origin = CellOffset(
          last.x + (action == TerminalFindAction.next ? 1 : 0),
          last.y,
        );
      }
      _find = TerminalSearch(_viewTerminal, origin: origin)
        ..addListener(_onFindChanged);
      _findRevealPending = true;
      _find!.setQuery(_lastFindQuery, caseSensitive: _lastFindCaseSensitive);
      _findBarKey.currentState?.focusSearch(search: _find);
      setState(() {});
    } else if (action == TerminalFindAction.open) {
      _findBarKey.currentState?.focusSearch();
    }
    if (action != TerminalFindAction.open &&
        !(wasClosed && action == TerminalFindAction.next)) {
      _stepFind(action == TerminalFindAction.next ? 1 : -1);
    }
  }

  void _queryFind(String query, bool caseSensitive) {
    _lastFindQuery = query;
    _lastFindCaseSensitive = caseSensitive;
    _findRevealPending = true;
    _find?.setQuery(query, caseSensitive: caseSensitive);
  }

  void _stepFind(int delta) {
    _findRevealPending = true;
    _find?.step(delta);
  }

  void _onFindChanged() {
    final search = _find;
    if (!mounted || search == null || !widget.visible) return;
    final range = search.match;
    if (range != _findPaintedRange ||
        !identical(_findPaintedBuffer, _viewTerminal.buffer)) {
      _clearFindHighlight();
      if (range != null) {
        _findPaintedBuffer = _viewTerminal.buffer;
        _findPaintedRange = range;
        _findHighlight = _controller.highlight(
          p1: _viewTerminal.buffer.createAnchorFromOffset(range.begin),
          p2: _viewTerminal.buffer.createAnchorFromOffset(range.end),
          color: const Color(0x99cf8e25),
        );
      }
    }
    if (_findRevealPending && search.hasSnapshot && range != null) {
      final render = _laidOutTerminalView()?.renderTerminal;
      if (render == null || !_scrollController.hasClients) return;
      _findRevealPending = false;
      final position = _scrollController.position;
      final top = range.begin.y * render.lineHeight + 10;
      final bottom = (range.end.y + 1) * render.lineHeight + 10;
      final safeTop = position.pixels + 10;
      final safeBottom = position.pixels + position.viewportDimension - 10;
      final offset = top < safeTop
          ? top - 10
          : bottom > safeBottom
          ? bottom - position.viewportDimension + 10
          : position.pixels;
      final target = offset.clamp(
        position.minScrollExtent,
        position.maxScrollExtent,
      );
      if (target != position.pixels) position.jumpTo(target);
    }
  }

  void _clearFindHighlight() {
    final highlight = _findHighlight;
    _findHighlight = null;
    _findPaintedBuffer = null;
    _findPaintedRange = null;
    if (highlight == null) return;
    highlight.dispose();
    highlight.p1.dispose();
    highlight.p2.dispose();
  }

  void _clearLastFind() {
    _lastFindAnchor?.dispose();
    _lastFindAnchor = null;
    _lastFindBuffer = null;
  }

  void _closeFind({
    bool restore = true,
    bool focus = true,
    bool rebuild = true,
  }) {
    final search = _find;
    if (search == null) return;
    final match = search.match;
    if (match != null) {
      _clearLastFind();
      _lastFindAnchor = _viewTerminal.buffer.createAnchorFromOffset(
        match.begin,
      );
      _lastFindBuffer = _viewTerminal.buffer;
    }
    _find = null;
    _findBarKey.currentState?.releaseSearchFocus();
    search.removeListener(_onFindChanged);
    search.dispose();
    _clearFindHighlight();
    if (restore &&
        identical(_findOriginBuffer, _viewTerminal.buffer) &&
        _scrollController.hasClients) {
      final height = _laidOutTerminalView()?.renderTerminal.lineHeight;
      final position = _scrollController.position;
      if (height != null) {
        final offset = _findOriginAtEnd
            ? position.maxScrollExtent
            : _findOriginLine?.attached == true
            ? (_findOriginLine!.y + _findOriginFraction) * height
            : 0.0;
        position.jumpTo(
          offset.clamp(position.minScrollExtent, position.maxScrollExtent),
        );
      }
    }
    _findOriginLine?.dispose();
    _findOriginLine = null;
    _findOriginBuffer = null;
    if (rebuild && mounted) setState(() {});
    if (focus) {
      // The retained terminal is already mounted. Return its input connection
      // now: the next key can arrive before Find's removal is painted.
      final view = _laidOutTerminalView();
      if (view != null) {
        _claimFocus(view);
      } else {
        _claimFocusAfterFrame();
      }
    }
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

  /// Modifier keys only change the pointer over a link. Do not fan every key
  /// out to the retained terminal pool when no pointer feedback can change.
  void _observeLinkModifiers(bool enabled) {
    if (_observingLinkModifiers == enabled) return;
    _observingLinkModifiers = enabled;
    final keyboard = HardwareKeyboard.instance;
    if (enabled) {
      keyboard.addHandler(_onLinkModifierChanged);
    } else {
      keyboard.removeHandler(_onLinkModifierChanged);
    }
  }

  void _scheduleLinkRefresh() {
    if (!widget.visible ||
        _linkPointerPosition == null ||
        _linkRefreshPending) {
      return;
    }
    _linkRefreshPending = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _linkRefreshPending = false;
      if (mounted && widget.visible) _hoverLink(_linkPointerPosition);
    });
  }

  void _rememberFollowTail() {
    if (!_scrollController.hasClients) return;
    final position = _scrollController.position;
    _followTail = position.maxScrollExtent - position.pixels < 1;
  }

  void _onScrollChanged() {
    _rememberFollowTail();
    _scheduleLinkRefresh();
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
    _linkPointerPosition = widget.visible ? globalPosition : null;
    final target = _linkPointerPosition == null
        ? null
        : _linkAtPointer(_linkPointerPosition!);
    _observeLinkModifiers(target != null);
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
    return KeymapRegion(
      contextKind: KeymapContext.terminal,
      composing: () =>
          _focusNode.hasFocus &&
          _terminalViewKey.currentState?.isComposing == true,
      child: ColoredBox(
        color: grid.AppPalette.windowBg,
        child: Column(
          children: [
            if (widget.showHeader)
              Stack(
                children: [
                  Visibility(
                    visible: _find == null,
                    maintainSize: true,
                    maintainAnimation: true,
                    maintainState: true,
                    child: _buildHeader(context),
                  ),
                  // Attach the focused pane's input before Find is requested.
                  // Hidden/unfocused panes need no dormant editor or index.
                  if (_find != null || (widget.visible && widget.focused))
                    Positioned.fill(
                      child: Offstage(
                        offstage: _find == null,
                        child: LayoutBuilder(
                          builder: (context, constraints) => Row(
                            children: [
                              if (constraints.maxWidth > 520)
                                Expanded(
                                  child: Padding(
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: _stripPadding,
                                    ),
                                    child: Text(
                                      session.agentName,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(
                                        fontSize: 13,
                                        color: Colors.white70,
                                      ),
                                    ),
                                  ),
                                )
                              else
                                const Spacer(),
                              SizedBox(
                                width: math.min(constraints.maxWidth, 380),

                                child: Padding(
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 6,
                                    vertical: 4,
                                  ),
                                  child: TerminalFindBar(
                                    key: _findBarKey,
                                    search: _find,
                                    initialQuery: _lastFindQuery,
                                    initialCaseSensitive:
                                        _lastFindCaseSensitive,
                                    readOnly:
                                        widget.readOnly ||
                                        !session.acceptsInput,
                                    onQuery: _queryFind,
                                    onStep: _stepFind,
                                    onClose: _closeFind,
                                    onFocus: () =>
                                        widget.onRendererFocus?.call(),
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                ],
              ),

            // Goes with the row above it: the phone draws its own rule under
            // [PhoneHeader], and keeping this one would stack two.
            if (widget.showHeader) Divider(height: 1, color: AppColors.border),
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
                          autoResize: widget.visible && !session.readOnly,
                          resizeBuffer: false,
                          renderingEnabled: widget.visible,
                          scrollController: _scrollController,
                          focusNode: _focusNode,
                          autofocus: widget.focused && !showComposer,
                          readOnly: widget.readOnly || !session.acceptsInput,
                          theme: terminalThemeFor(
                            grid.AppTheme.palette.value,
                            terminalThemeStore.value,
                          ),
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
                  if (session.uploadProgress != null ||
                      _previewProgress != null)
                    Positioned(
                      left: 14,
                      right: 14,
                      bottom: 12,
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          if (session.uploadProgress != null)
                            _TransferProgressBadge(
                              label:
                                  'Uploading ${session.uploadProgress!.label}',
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
              TerminalComposer(
                session: session,
                focusNode: _composerFocus,
                inputEnabled: !widget.readOnly,
              ),
          ],
        ),
      ),
    );
  }

  /// Visibility and focus affect the renderer, not its title and controls.
  /// Retain that subtree until its presentation changes. Callback wrappers
  /// resolve the current widget so cached controls never retain an old action.
  Widget _buildHeader(BuildContext context) {
    final session = widget.session;
    final machine = widget.notifier.stateOf(session.machineId);
    final agent = machine?.agents
        .where((a) => a.id == session.agentId)
        .firstOrNull;
    final presentation = (
      theme: Theme.of(context),
      brightness: grid.AppTheme.brightness.value,
      fontFamily: AppFonts.sans,
      notifier: widget.notifier,
      session: session,
      name: session.agentName,
      status: session.status,
      notice: widget.notice,
      readOnly: widget.readOnly,
      error: session.errorMessage ?? session.errorCode,
      link: session.linkMode,
      machine: machine?.machine,
      local: machine?.isLocalMachine,
      agent: agent,
      // Named on its own even though `agent` is already here: an Agent has no
      // equality, so a frame that changed nothing but the verdict must still
      // be seen as a change by the one field that can say so.
      verdict: agent?.verdict,
      project: agent == null ? null : machine?.projectOf(agent),
      compact: widget.compactHeader,
      close: widget.onClose != null,
      restart: widget.onRestart != null,
      fork: widget.onFork != null,
      delete: widget.onDelete != null,
      composer: widget.composerVisible,
      toggleComposer: widget.onToggleComposer != null,
      zoomed: widget.zoomed,
      zoom: widget.onToggleZoom != null,
      dragId: widget.paneDrag?.ref.paneId,
      dragSize: widget.paneDrag?.size,
    );
    if (_headerPresentation != presentation) {
      _headerPresentation = presentation;
      _header = _TerminalHeader(
        notifier: widget.notifier,
        session: session,
        notice: widget.notice,
        readOnly: widget.readOnly,
        compact: widget.compactHeader,
        zoomed: widget.zoomed,
        onToggleZoom: widget.onToggleZoom == null
            ? null
            : () => widget.onToggleZoom?.call(),
        onClose: widget.onClose == null ? null : () => widget.onClose?.call(),
        onRestart: widget.onRestart == null
            ? null
            : () => widget.onRestart?.call(),
        onFork: widget.onFork == null ? null : () => widget.onFork?.call(),
        onDelete: widget.onDelete == null
            ? null
            : () => widget.onDelete?.call(),
        composerVisible: widget.composerVisible,
        onToggleComposer: widget.onToggleComposer == null
            ? null
            : () => widget.onToggleComposer?.call(),
        paneDrag: widget.paneDrag,
      );
    }
    return _header!;
  }
}

class _TerminalHeader extends StatelessWidget {
  final AppNotifier notifier;
  final TerminalSession session;
  final TerminalNotice? notice;
  final bool readOnly;
  final VoidCallback? onClose;
  final VoidCallback? onRestart;
  final VoidCallback? onFork;

  /// Ends the agent (with a confirmation), as the rail's row menu does. Null
  /// where the pane cannot name a live agent to end.
  final VoidCallback? onDelete;
  final bool compact;
  final VoidCallback? onToggleZoom;
  final bool zoomed;
  final VoidCallback? onToggleComposer;
  final bool composerVisible;

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
    this.notice,
    this.readOnly = false,
    this.onClose,
    this.onRestart,
    this.onFork,
    this.onDelete,
    this.compact = false,
    this.onToggleZoom,
    this.zoomed = false,
    this.paneDrag,
    this.onToggleComposer,
    this.composerVisible = false,
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
    final status =
        notice ??
        switch (session.status) {
          TerminalSessionStatus.controlling => null,
          TerminalSessionStatus.opening => (
            label: 'Connecting',
            icon: Icons.sync,
            detail:
                'Connecting to this terminal. Retained output is read only.',
          ),
          TerminalSessionStatus.resyncing => (
            label: 'Restoring',
            icon: Icons.sync,
            detail: 'Restoring this terminal. Retained output is read only.',
          ),
          TerminalSessionStatus.takenOver => (
            label: 'Take control',
            icon: Icons.lock_outline,
            detail: 'Read only: another app controls this terminal. Take control moves input ownership to this app.',
          ),
          TerminalSessionStatus.error || TerminalSessionStatus.closed => (
            label: 'Reconnect',
            icon: Icons.refresh,
            detail:
                session.errorMessage ??
                session.errorCode ??
                'This stream is closed. Retained output is read only.',
          ),
        };
    final canReconnect =
        notice == null &&
        !readOnly &&
        (session.status == TerminalSessionStatus.error ||
            session.status == TerminalSessionStatus.closed ||
            session.status == TerminalSessionStatus.takenOver);
    final machine = notifier.stateOf(session.machineId);
    final agent = machine?.agents
        .where((a) => a.id == session.agentId)
        .firstOrNull;
    final project = agent == null ? null : machine?.projectOf(agent);
    final machineName = machine?.machine.displayName ?? session.machineId;
    final identityDetail = [
      session.agentName,
      machineName,
      if (project != null) project.cwd,
      if (project?.branch != null) 'Branch: ${project!.branch}',
      if (profile != null) 'Codex profile: $profile',
      'Double-click to rename',
    ].join('\n');
    // A terminal has no prompt to compose a message for — a shell reads keys,
    // and the composer's Enter-to-send would be a line nobody asked for.
    final remoteComposer =
        machine != null &&
            !machine.isLocalMachine &&
            !isTerminalEngine(session.engineId)
        ? onToggleComposer
        : null;
    // The icon cluster, plus the model picker that now sits at its left — without the extra the
    // constraint clips the picker rather than the details it was measured for. Zero on an engine
    // that gets no picker, so those headers keep the width they always had.
    final showModelPicker =
        status == null && !readOnly && modelPickerSupports(session.engineId);
    final pickerWidth = showModelPicker ? 72.0 : 0.0;
    final actionsWidth = (remoteComposer == null ? 118.0 : 148.0) + pickerWidth;
    final folder =
        project?.cwd
            .split(RegExp(r'[/\\]'))
            .where((part) => part.isNotEmpty)
            .lastOrNull ??
        project?.name;
    // A fork says so first: "forked from X" is the one fact about this pane
    // that the folder and the branch — shared with its source — cannot tell.
    final forkedFrom = agent?.forkedFrom;
    final details = [
      if (forkedFrom != null) 'forked from ${forkedFrom.name}',
      if (folder?.isNotEmpty == true) folder!,
      if (project?.branch?.trim().isNotEmpty == true) project!.branch!,
      machineName,
    ];
    final forkIndex = forkedFrom != null ? 0 : null;
    final branchIndex = project?.branch?.trim().isNotEmpty == true
        ? (forkedFrom != null ? 1 : 0) + (folder?.isNotEmpty == true ? 1 : 0)
        : null;
    final strip = PaneHeaderHover(
      child: SizedBox(
        height: compact ? 38 : 46,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: _stripPadding),
          child: LayoutBuilder(
            builder: (context, constraints) => Row(
              children: [
                if (agent != null)
                  EngineMark.forAgent(agent, size: 17)
                else
                  EngineMark(engine: session.engineId, size: 17),
                // Icon and name, the same as every other pane (owner,
                // 2026-09-15): a harness agent is its harness here, and the
                // engine it runs on is the dialog's and the tooltip's to say.
                const SizedBox(width: 10),
                Expanded(
                  child: Row(
                    children: [
                      Flexible(
                        child: Tooltip(
                          message: identityDetail,
                          waitDuration: const Duration(milliseconds: 700),
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
                            child: Text(
                              session.agentName,
                              maxLines: 1,
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
                      const SizedBox(width: 8),
                      if (status != null)
                        ConstrainedBox(
                          constraints: BoxConstraints(
                            maxWidth: math.max(
                              0,
                              math.min(
                                constraints.maxWidth * .22,
                                constraints.maxWidth - actionsWidth - 110,
                              ),
                            ),
                          ),
                          child: Align(
                            alignment: Alignment.centerLeft,
                            child: Tooltip(
                              message: status.detail,
                              child: TextButton(
                                onPressed: canReconnect
                                    ? () => notifier.selectAgent(
                                        session.machineId,
                                        session.agentId,
                                      )
                                    : null,
                                style: TextButton.styleFrom(
                                  foregroundColor: color,
                                  disabledForegroundColor: AppColors.textSoft,
                                  minimumSize: Size.zero,
                                  tapTargetSize:
                                      MaterialTapTargetSize.shrinkWrap,
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 6,
                                    vertical: 4,
                                  ),
                                ),
                                child: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    Icon(status.icon, size: 14),
                                    const SizedBox(width: 6),
                                    Flexible(
                                      child: Text(
                                        status.label,
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: const TextStyle(fontSize: 11),
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          ),
                        )
                      else if (!compact)
                        Padding(
                          padding: const EdgeInsets.all(4),
                          child: Icon(Icons.circle, size: 8, color: color),
                        ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
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
                ConstrainedBox(
                  constraints: BoxConstraints(
                    maxWidth: math.max(
                      actionsWidth,
                      constraints.maxWidth * .55,
                    ),
                  ),
                  child: PaneHeaderActions(
                    // Where this agent runs, with the controls rather than beside the name — the
                    // header has room for one of the two, and this is the half you only read while
                    // reaching for it. Absent while a notice is showing: a header asking to
                    // reconnect is not the moment to offer a menu.
                    modelPicker: showModelPicker
                        ? GridModelPicker(
                            notifier: notifier,
                            machineId: session.machineId,
                            currentModel: agent?.gridModel,
                            webSearch: agent?.gridWebSearch,
                            engineLabel: session.engineId,
                            onSelected: (model) => unawaited(
                              notifier.retargetAgentToGridModel(
                                session.machineId,
                                session.agentId,
                                model.id,
                              ),
                            ),
                            onUseOwnLogin: () => unawaited(
                              notifier.clearAgentGrid(
                                session.machineId,
                                session.agentId,
                              ),
                            ),
                            // The pane's own context, because the flow opens a dialog before it
                            // opens a pane — and the pane's own MACHINE, because a picker on a
                            // remote agent's pane is asking about the models that computer can
                            // serve, not this one's.
                            onRunLocalModel: () => unawaited(
                              notifier.runLocalModel(
                                context,
                                machineId: session.machineId,
                                chooseMachine: false,
                              ),
                            ),
                          )
                        : null,
                    onShare:
                        readOnly ||
                            notifier
                                    .stateOf(session.machineId)
                                    ?.machine
                                    .isShared ==
                                true
                        ? null
                        : () => showShareHarnessDialog(
                            context,
                            notifier,
                            session.machineId,
                            session.agentId,
                            session.agentName,
                          ),
                    zoomed: zoomed,
                    onZoom: onToggleZoom,
                    onRestart: onRestart,
                    onFork: onFork,
                    onDelete: onDelete,
                    onClose: onClose,
                    terminal: isTerminalEngine(session.engineId),
                    onToggleComposer: remoteComposer,
                    composerVisible: composerVisible,
                    // A harness agent's viewer, shown or hidden from the
                    // pane it belongs to.
                    onToggleViewer:
                        agent?.viewerUrl == null && agent?.viewerError == null
                        ? null
                        : () => notifier.toggleViewerPane(
                            session.machineId,
                            agent!.id,
                          ),
                    viewerVisible:
                        agent != null &&
                        notifier.viewerPaneShown(session.machineId, agent.id),
                    viewerColor: agent == null
                        ? null
                        : agentIdentity(agent).color,
                    details: Tooltip(
                      message: [
                        if (forkedFrom != null)
                          'Forked from ${forkedFrom.name}',
                        if (project != null) project.cwd,
                        if (project?.branch?.isNotEmpty == true)
                          'Branch: ${project!.branch}',
                        machineName,
                      ].join('\n'),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          for (var i = 0; i < details.length; i++) ...[
                            if (i > 0)
                              Text(
                                '  •  ',
                                style: TextStyle(
                                  fontSize: 10,
                                  color: AppColors.mutedStrong,
                                ),
                              ),
                            Flexible(
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  if (i == branchIndex) ...[
                                    Icon(
                                      LucideIcons.gitBranch300,
                                      size: 12,
                                      color: AppColors.mutedStrong,
                                    ),
                                    const SizedBox(width: 4),
                                  ],
                                  if (i == forkIndex) ...[
                                    Icon(
                                      LucideIcons.gitFork300,
                                      size: 12,
                                      color: AppColors.mutedStrong,
                                    ),
                                    const SizedBox(width: 4),
                                  ],
                                  Flexible(
                                    child: Text(
                                      details[i],
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: TextStyle(
                                        fontFamily: AppFonts.sans,
                                        fontSize: 12,
                                        color: AppColors.mutedStrong,
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
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

/// A domain harness's verdict on the agent's workspace, in one word or one count.
///
/// Green "Ready" is the harness's one machine fact — fab-ready, every gate passed. Red carries the
/// error count, amber the warning count when nothing blocks, grey "Checked" a clean run that the
/// harness still would not call ready. The summary rides in the tooltip; the findings themselves
/// live in the harness's own viewer, which is the pane beside this one.
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

/// Image/file transfer progress with a cancel action, kept in the pane's corner.
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
