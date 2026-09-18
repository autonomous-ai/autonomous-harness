import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:xterm/xterm.dart';

import '../clipboard/native_clipboard.dart';
import '../state/app_state.dart';

import 'agent_drag.dart';
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
import '../terminal/terminal_prompt_zone.dart';
import '../terminal/terminal_session.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import '../terminal/terminal_viewport.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../theme/app_theme.dart';
import 'terminal_pane_badges.dart';
import 'terminal_pane_header.dart';

// The header strip, its drag ghost and the small badges are presentation that
// only changes when its inputs do; they live in `terminal_pane_header.dart` and
// `terminal_pane_badges.dart`. Re-exported so this file stays the one import a
// pane needs.
export 'terminal_pane_header.dart' show TerminalNotice, TerminalPaneHeader;

class TerminalPanel extends StatefulWidget {
  final AppNotifier notifier;
  final TerminalSession session;

  /// Takes this tile off the grid. Null when the terminal is the whole window,
  /// where there is nothing to close it back to.
  final VoidCallback? onClose;
  final VoidCallback? onDelete;

  final VoidCallback? onToggleZoom;
  final bool zoomed;

  /// This native terminal took the keyboard, so its grid tile becomes focused.
  final VoidCallback? onRendererFocus;

  /// Only the focused grid tile may claim keyboard focus on mount/rebuild.
  final bool focused;
  final bool visible;

  /// True while the software keyboard is mid-animation and the pane's height is
  /// still a moving target.
  ///
  /// Holds the remote resize for the duration, WITHOUT touching focus — that is
  /// the whole reason this is not just `visible: false`, which releases the
  /// keyboard this animation is raising.
  ///
  /// ⚠️ What stutters is the RESIZE, not painting. Every frame of the keyboard
  /// sliding gives the view a new height, xterm re-derives rows from it in
  /// `performLayout` and fires `onResize` → `session.resize` → a
  /// `terminal_resize` frame and a real SIGWINCH on the far machine. A
  /// full-screen TUI redraws for each one, and those redraws come back as
  /// keyframes. `autoResize: false` is what closes that loop (see
  /// `RenderTerminal._resizeTerminalIfNeeded`), so the shell is asked exactly
  /// once, for the height the keyboard settles at.
  ///
  /// ⚠️ **It does not stop painting, and it used to.** `renderingEnabled: false`
  /// closed the same loop but froze the output for the whole slide as well —
  /// see [_TerminalPanelState._live].
  final bool settling;
  final Size? viewportSize;

  /// A shared terminal can move to another harness without being remounted.
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

  /// Takes over the tap that would raise the software keyboard. Null leaves it
  /// to xterm, which is what every desktop tile does.
  ///
  /// Set on the phone, where the page raises the keyboard itself, with what the
  /// mic heard typed into the prompt first (`phone/terminal_page.dart`).
  /// Claimed on tap DOWN — xterm then neither raises the keyboard nor reports
  /// the click to a mouse-tracking program — but run on tap UP, so a scroll
  /// that began as a press opens nothing. A tap that clears a selection, or
  /// opens a link, is still exactly that.
  ///
  /// Run only for a tap on the prompt ([isPromptTap]). Every other claimed tap
  /// is swallowed: somebody tapping the output is reading it, and a keyboard
  /// jumping up would cover half of what they were reading.
  final VoidCallback? onInputTap;

  /// Whether this tile's composer textbox is showing. Only consulted for a remote machine.
  final bool composerVisible;
  final bool readOnly;
  final TerminalNotice? notice;

  /// Flips [composerVisible]. Null where there is no composer to toggle.
  final VoidCallback? onToggleComposer;

  /// Lets the header be dragged to trade places with another tile. Null when
  /// this is the only tile — see [TerminalPaneHeader.paneDrag].
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
    this.settling = false,
    this.viewportSize,
    this.paneLocation,
    this.layoutRequest,
    this.compactHeader = false,
    this.showHeader = true,
    this.focusRequest = 0,
    this.onInputTap,
    this.composerVisible = false,
    this.readOnly = false,
    this.notice,
    this.onToggleComposer,
    this.onClose,
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

  /// The link under the pointer, and whether the modifier that would open it is
  /// down. Both change on ordinary mouse movement and on every modifier press,
  /// and both feed ONLY the tooltip and the cursor shape.
  ///
  /// ⚠️ NOT setState. A rebuild of this element rebuilds [TerminalView] with it,
  /// and that is the one widget in the pane whose element must not be churned
  /// while output is streaming: it carries the input connection, the scroll
  /// position and the retained render object. Hovering a link, or tapping ⌘,
  /// used to rebuild the whole pane; now it repaints two leaves.
  final ValueNotifier<String?> _hoveredLink = ValueNotifier(null);
  final ValueNotifier<bool> _linkModifierDown = ValueNotifier(false);

  /// Download progress for a link preview. Ticks once per chunk, so it gets the
  /// same treatment as [_hoveredLink] — see the note there.
  final ValueNotifier<RemoteMediaProgress?> _previewProgress = ValueNotifier(
    null,
  );
  String? _pressedLink;

  /// Whether the tap in progress was claimed for [TerminalPanel.onInputTap].
  bool _inputTapClaimed = false;
  bool _openingLink = false;
  bool _linkRefreshPending = false;
  bool _followTail = true;
  TerminalStyle _terminalFont = terminalFontStore.value;
  bool _observingLinkModifiers = false;
  late final RemoteMediaDownloader _mediaDownloader;
  MediaDownloadCancellation? _previewCancellation;
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
      _previewProgress.value = null;
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
      _hoveredLink.value = null;
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
      _hoveredLink.value = null;
      _pressedLink = null;
      _observeLinkModifiers(false);
    }
    if (widget.visible &&
        (!oldWidget.visible || oldWidget.paneLocation != widget.paneLocation)) {
      _afterTerminalMounted();
    }
    // The keyboard has finished moving and the pane's height is final. Measure
    // it once and ask the shell for that size — the single SIGWINCH this whole
    // gate exists to reduce the animation to.
    //
    // `claimFocus: false` on purpose: the keyboard is already up, or already
    // gone, and whoever owns the caret decided that. Re-claiming here would
    // pull it back from the composer, or summon the keyboard again just as the
    // user finished dismissing it.
    if (oldWidget.settling && !widget.settling && widget.visible) {
      _afterTerminalMounted(claimFocus: false);
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
    _hoveredLink.dispose();
    _linkModifierDown.dispose();
    _previewProgress.dispose();
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
  /// Whether the renderer may resize the remote shell to this view's height,
  /// and run the cursor clock.
  ///
  /// A parked page may not because it is not the one being read; a settling one
  /// may not because its height is still moving. Focus is deliberately NOT part
  /// of this — see [TerminalPanel.settling].
  ///
  /// ⚠️ **Painting is not gated on it, and on a phone it must not be.** A
  /// mounted panel there is on screen: the pager builds only the pages the
  /// viewport touches. Gating paint on [TerminalPanel.visible] meant the agent
  /// sliding in never laid out — its scroll offset sat at zero, so it drew the
  /// OLDEST lines of its scrollback until the swipe passed halfway, then jumped
  /// to the end — while the agent sliding out froze. Gating it on settling
  /// stopped the output dead for the whole keyboard slide.
  bool get _live => widget.visible && !widget.settling;

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
        // ⚠️ A position can be attached before its first layout, and until then `maxScrollExtent`
        // is a null-check that THROWS — it did, once per output frame, for a pane whose session
        // was already streaming while the terminal was still behind "Attaching…". Nothing to
        // follow yet; the next frame after layout does it.
        if (!position.hasContentDimensions || !position.hasPixels) return;
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
    _hoveredLink.value = null;
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

  @override
  void clearInputBuffer() => _terminalViewKey.currentState?.clearInputBuffer();

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
        // `_live`, not `visible`: a cursor phase is a markNeedsPaint on the
        // terminal, and nothing should repaint it while the keyboard slides.
        _live &&
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
  /// An image handed over by the software keyboard's own clipboard.
  ///
  /// This is the phone's ONLY way to get an image into a pane: Flutter's
  /// [Clipboard] reads `text/plain` and nothing else, and the native reader
  /// [_paste] falls back on is macOS/Linux. Gboard hands the bytes over directly,
  /// so there is no clipboard to read at all.
  ///
  /// ⚠️ A pane on a phone is ALWAYS remote — the agent runs on another machine,
  /// whose engine reads a different OS clipboard — so unlike the desktop there is
  /// no local shortcut here: every paste is the chunked upload.
  void _onContentInserted(KeyboardInsertedContent content) {
    final bytes = content.data;
    if (bytes == null || bytes.isEmpty) return;
    if (widget.readOnly || !widget.session.acceptsInput) return;
    if (bytes.length > terminalLocalImagePasteMaxPayloadBytes) return;
    final machine = widget.notifier.stateOf(widget.session.machineId);
    if (machine == null || !machine.terminalImagePasteAvailable) return;
    unawaited(widget.session.pasteImage(bytes));
  }

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
      // Refresh the cursor even when the mouse has not moved. Published, not
      // setState: the cursor is one leaf, and a rebuild here would take the
      // streaming TerminalView with it.
      _linkModifierDown.value = _linkModifierPressed;
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
      _linkModifierDown.value = _linkModifierPressed;
    } else {
      keyboard.removeHandler(_onLinkModifierChanged);
      // Nothing is watching the modifier any more, so the cursor must not stay
      // latched on a ⌘ that was down when the pointer left the link.
      _linkModifierDown.value = false;
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
    _hoveredLink.value = target;
  }

  bool _onTerminalTapDown(TapDownDetails details, CellOffset cell) {
    _inputTapClaimed = false;
    if (_onLinkTapDown(details, cell)) return true;
    if (widget.onInputTap == null || _controller.selection != null) {
      return false;
    }
    return _inputTapClaimed = true;
  }

  void _onTerminalTapUp(TapUpDetails details, CellOffset cell) {
    if (!_inputTapClaimed) {
      _onLinkTapUp(details, cell);
      return;
    }
    _inputTapClaimed = false;
    if (!isPromptTap(_viewTerminal.buffer, cell.y)) return;
    widget.onInputTap?.call();
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
          _previewProgress.value = const RemoteMediaProgress('', 0, null);
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
                _previewProgress.value = progress;
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
        // `mounted` gates the notifier, not a rebuild: a download can outlive
        // the pane, and writing to a disposed ValueNotifier throws.
        if (mounted) _previewProgress.value = null;
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
                                      horizontal: stripPadding,
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
                      child: _LinkTooltip(
                        link: _hoveredLink,
                        modifierDown: _linkModifierDown,
                        child: TerminalView(
                          session.terminal,
                          key: _terminalViewKey,
                          controller: _controller,
                          autoResize: _live,
                          resizeBuffer: false,
                          scrollController: _scrollController,
                          focusNode: _focusNode,
                          autofocus: widget.focused && !showComposer,
                          readOnly: widget.readOnly || !session.acceptsInput,
                          // iOS answers Backspace over an empty native buffer
                          // with nothing at all (`deleteBackward` in
                          // FlutterTextInputPlugin.mm), so a line the keyboard
                          // did not type — text typed on the desktop, a voice
                          // transcript, a recalled command — could not be
                          // rubbed out. xterm keeps a padding for Backspace to
                          // eat instead — see test/terminal_ime_input_test.dart.
                          //
                          // Unconditional: this package builds for iOS and
                          // Android only. ⚠️ Lost once already in a merge
                          // (cb47ba35 → TestFlight build 11), which is why
                          // test/terminal_panel_backspace_test.dart pins it.
                          deleteDetection: true,
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
                          // ⚠️ PNG alone, and not because other types are rare.
                          // The daemon writes what it receives to a file it names
                          // `<uuid>.png` outright (`cli/src/lib/pasteDropFiles.ts`),
                          // so a JPEG would arrive on the far machine under a name
                          // that lies about it. Widening this means teaching the
                          // CLI the real type first — and an older CLI, which
                          // `terminalImagePasteAvailable` already gates on, would
                          // still not know it.
                          allowedMimeTypes: const ['image/png'],
                          onContentInserted: _onContentInserted,
                          onKeyEvent: _onTerminalKey,
                          onTapDown: _onTerminalTapDown,
                          onTapUp: _onTerminalTapUp,
                          // Constant on purpose. The click cursor is applied by
                          // [_LinkTooltip]'s own MouseRegion, which repaints
                          // without rebuilding this view.
                          mouseCursor: SystemMouseCursors.text,
                          onSecondaryTapDown: (_, _) => _copyOrPaste(),

                          onAltBufferScroll: session.scrollViaTmuxCopyMode
                              ? (up) => session.sendScrollCommand(up, 1)
                              : null,
                        ),
                      ),
                    ),
                  ),
                  // Both bars tick once per transferred chunk. Listening here
                  // keeps that traffic off the pane's own element, so a paste
                  // or a preview download cannot stutter the live terminal.
                  Positioned(
                    left: 14,
                    right: 14,
                    bottom: 12,
                    child: _TransferOverlay(
                      session: session,
                      preview: _previewProgress,
                      onCancelPreview: () => _previewCancellation?.cancel(),
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
      project: agent == null ? null : machine?.projectOf(agent),
      compact: widget.compactHeader,
      close: widget.onClose != null,
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
      _header = TerminalPaneHeader(
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

/// The "⌘-click to open" hint, and the click cursor that goes with it.
///
/// Both answer the same two facts — which link is under the pointer, and
/// whether the modifier is down — and both used to live in the pane's own
/// `build`, which meant a mouse crossing a URL rebuilt [TerminalView]. Reading
/// the notifiers HERE confines that to this subtree: the terminal element, its
/// input connection and its scroll position are never touched.
class _LinkTooltip extends StatelessWidget {
  const _LinkTooltip({
    required this.link,
    required this.modifierDown,
    required this.child,
  });

  final ValueListenable<String?> link;
  final ValueListenable<bool> modifierDown;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final modifier = defaultTargetPlatform == TargetPlatform.macOS
        ? '⌘'
        : 'Ctrl';
    return ValueListenableBuilder<String?>(
      valueListenable: link,
      // The terminal is passed through untouched, so rebuilding this builder
      // re-parents nothing: `child` is the same element every time.
      child: child,
      builder: (context, target, child) => ValueListenableBuilder<bool>(
        valueListenable: modifierDown,
        child: child,
        builder: (context, down, child) => MouseRegion(
          opaque: false,
          cursor: target != null && down
              ? SystemMouseCursors.click
              : MouseCursor.defer,
          child: Tooltip(
            message: target == null ? '' : '$modifier-click to open\n$target',
            child: child,
          ),
        ),
      ),
    );
  }
}

/// The upload and preview-download bars stacked in the pane's corner.
///
/// Kept out of the pane's `build` because both tick once per chunk: a 4 MB
/// paste is hundreds of notifications, and each one would otherwise rebuild the
/// streaming terminal beside it.
class _TransferOverlay extends StatelessWidget {
  const _TransferOverlay({
    required this.session,
    required this.preview,
    required this.onCancelPreview,
  });

  final TerminalSession session;
  final ValueListenable<RemoteMediaProgress?> preview;
  final VoidCallback onCancelPreview;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: session,
      builder: (context, _) => ValueListenableBuilder<RemoteMediaProgress?>(
        valueListenable: preview,
        builder: (context, download, _) {
          final upload = session.uploadProgress;
          if (upload == null && download == null) {
            return const SizedBox.shrink();
          }
          return Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (upload != null)
                TransferProgressBadge(
                  label: 'Uploading ${upload.label}',
                  fraction: upload.percent,
                  onCancel: () => unawaited(session.cancelUpload()),
                ),
              if (upload != null && download != null) const SizedBox(height: 8),
              if (download != null)
                TransferProgressBadge(
                  label: download.totalBytes == null
                      ? 'Preparing preview…'
                      : 'Downloading ${download.filename}',
                  fraction: download.fraction,
                  onCancel: onCancelPreview,
                ),
            ],
          );
        },
      ),
    );
  }
}
