import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:xterm/xterm.dart';

import '../core/crash_log.dart';
import 'terminal_binary.dart';
import 'terminal_viewport.dart';

typedef TerminalFrameSender = Future<bool> Function(
  String type,
  Map<String, dynamic> payload,
);
typedef TerminalBinarySender = Future<bool> Function(TerminalBinaryFrame frame);

enum TerminalSessionStatus {
  closed,
  opening,
  controlling,
  resyncing,
  takenOver,
  error,
}

/// Transient progress for an in-flight [TerminalSession.pasteImage]/[TerminalSession.pasteFile]
/// chunked upload. `bytesWritten` reflects the daemon's own per-chunk ACKs, not bytes merely handed
/// to the local socket.
class UploadProgress {
  const UploadProgress({
    required this.label,
    required this.bytesWritten,
    required this.totalBytes,
  });

  /// The image/file name shown in the overlay — a filename for a file upload, a generic word for
  /// an image (which carries no name of its own).
  final String label;
  final int bytesWritten;
  final int totalBytes;

  double get percent =>
      totalBytes <= 0 ? 0 : (bytesWritten / totalBytes).clamp(0, 1);

  UploadProgress copyWith({int? bytesWritten, int? totalBytes}) =>
      UploadProgress(
        label: label,
        bytesWritten: bytesWritten ?? this.bytesWritten,
        totalBytes: totalBytes ?? this.totalBytes,
      );
}

/// Internal bookkeeping for one in-flight upload — see [TerminalSession._uploadBytes]. Two
/// Completers rather than one, since "the daemon accepted the announcement" and "the transfer is
/// over (however it ended)" are resolved at different points and by different frames.
class _ActiveUpload {
  final Completer<bool> beginAccepted = Completer<bool>();
  final Completer<bool> finished = Completer<bool>();
}

/// One controller stream for one remote Harness agent.
///
/// Sequence corruption is recovered with bounded resync retries and one clean
/// reopen. Transport loss still freezes input until the user opens a session.
class TerminalSession extends ChangeNotifier {
  static const protocolVersion = 3;
  static const minCols = 40;
  static const maxCols = 300;
  static const minRows = 12;
  static const maxRows = 120;

  final String machineId;
  final String agentId;
  String agentName;
  final String? engineId;
  final TerminalFrameSender send;
  final TerminalBinarySender sendBinary;
  final Duration resyncTimeout;

  /// Forces a fresh transport dial (see `WsConn.forceReconnect`) — called once when the very first
  /// `terminal_open` never gets a `terminal_ready` back within [resyncTimeout]. Covers the relay
  /// going stale silently (the relayed machine's own Harness process restarted, dropping its E2EE
  /// session without the transport ever closing) so a reconnect looks like a couple of extra seconds
  /// of "attaching" instead of a hang the user has to notice and manually retry.
  final Future<void> Function()? onOpenStalled;

  TerminalSession({
    required this.machineId,
    required this.agentId,
    required this.agentName,
    required this.engineId,
    required this.send,
    required this.sendBinary,
    this.onOpenStalled,
    this.resyncTimeout = const Duration(seconds: 4),
  }) {
    terminal = _newTerminal();
  }

  late Terminal terminal;
  TerminalSessionStatus status = TerminalSessionStatus.closed;
  String? streamId;

  /// How this pane's terminal bytes are currently reaching it — one of:
  ///
  ///   'p2p'   direct WebRTC, ICE nominated a direct candidate pair.
  ///   'turn'  WebRTC too, but ICE could only manage a relay pair, so Cloudflare TURN carries it.
  ///   'relay' no data channel at all; the bytes ride the backend WebSocket.
  ///
  /// Only ever set for a `harness link connect`-linked remote machine (the CLI never sends this frame
  /// for a local machine's own terminal, which has no such distinction), and reset alongside [streamId]
  /// so a stale mode can never survive into the next stream.
  String? linkMode;
  String? errorCode;
  String? errorMessage;
  int cols = 80;
  int rows = 24;

  /// Set while an image/file upload is in flight ([pasteImage]/[pasteFile]); `null` otherwise. The
  /// terminal panel's overlay shows a progress pill exactly when this is non-null.
  UploadProgress? uploadProgress;
  _ActiveUpload? _activeUpload;

  String? _openRequestId;
  int? _expectedSeq;
  int _lastRenderedSeq = -1;
  int _framesSinceAck = 0;
  int _renderedSinceAckBytes = 0;
  int _inputSeq = 0;

  /// The last `expectedSeq` a TERMINAL_INPUT_INVALID realigned the counter to.
  /// The daemon refuses every in-flight frame it cannot accept, each naming
  /// the SAME expected seq; only the first of those may rewind the counter,
  /// or frames accepted since would be re-sent under numbers already used.
  int? _lastRealignedTo;
  int _resizeSeq = 0;
  bool _resyncRequested = false;
  int _resyncAttempts = 0;
  int _autoReopenAttempts = 0;
  bool _openStallRecovered = false;
  bool _disposed = false;
  bool _remoteCursorVisible = true;
  bool _cursorBlinkPhaseVisible = true;
  List<int> _utf8Tail = const [];
  final List<int> _inputBytes = [];
  Timer? _heartbeat;
  Timer? _ackTimer;
  Timer? _inputTimer;
  Timer? _resizeTimer;
  DateTime? _lastInputFlushAt;
  DateTime? _lastResizeFlushAt;
  Timer? _resyncTimer;
  Timer? _scrollTimer;
  bool? _pendingScrollUp;
  int _pendingScrollLines = 0;
  int? _pendingCols;
  int? _pendingRows;
  TerminalViewport? _viewport;
  ({int cols, int rows})? _measuredViewport;
  final Completer<({int cols, int rows})> _viewportSize = Completer();
  Future<void> _renderTail = Future<void>.value();
  Future<void> _inputSendTail = Future<void>.value();

  bool get acceptsInput =>
      status == TerminalSessionStatus.controlling && streamId != null;

  /// Grok's CLI declares terminal mouse-tracking (so tmux defers wheel bytes to it, same as any
  /// alt-buffer program) but doesn't correctly handle wheel reports itself — confirmed live: it
  /// echoes the raw SGR escape bytes into its own prompt as literal characters instead of
  /// scrolling. Its alt-buffer scroll gestures route through the daemon's tmux copy-mode
  /// (`sendScrollCommand`/`terminal_scroll`) instead of the raw `mouseInput` path every other
  /// engine already uses correctly.
  bool get scrollViaTmuxCopyMode => engineId == 'grok';

  void renameAgent(String name) {
    final cleanName = name.trim();
    if (cleanName.isEmpty || cleanName == agentName) return;
    agentName = cleanName;
    notifyListeners();
  }

  Future<void> open({
    int initialCols = 80,
    int initialRows = 24,
    bool waitForViewportSize = false,
  }) => _open(
    initialCols: initialCols,
    initialRows: initialRows,
    waitForViewportSize: waitForViewportSize,
    resetRecovery: true,
  );

  Future<void> _open({
    required int initialCols,
    required int initialRows,
    required bool waitForViewportSize,
    required bool resetRecovery,
  }) async {
    _cancelTimers();
    streamId = null;
    linkMode = null;
    errorCode = null;
    errorMessage = null;
    _expectedSeq = null;
    _lastRenderedSeq = -1;
    _framesSinceAck = 0;
    _renderedSinceAckBytes = 0;
    _inputSeq = 0;
    _lastRealignedTo = null;
    _resizeSeq = 0;
    _utf8Tail = const [];
    _remoteCursorVisible = true;
    _cursorBlinkPhaseVisible = true;
    _resyncRequested = false;
    _resyncAttempts = 0;
    if (resetRecovery) {
      _autoReopenAttempts = 0;
      _openStallRecovered = false;
    }
    cols = _clampCols(initialCols);
    rows = _clampRows(initialRows);
    terminal = _newTerminal()..resize(cols, rows);
    status = TerminalSessionStatus.opening;
    _openRequestId =
        'term_${DateTime.now().microsecondsSinceEpoch}_${Random.secure().nextInt(1 << 31)}';
    notifyListeners();

    if (waitForViewportSize) {
      try {
        final measured = await _viewportSize.future.timeout(
          const Duration(seconds: 2),
        );
        cols = _clampCols(measured.cols);
        rows = _clampRows(measured.rows);
        terminal.resize(cols, rows);
        notifyListeners();
      } on TimeoutException {
        // Keep the conservative fallback when the terminal viewport cannot be
        // measured; the normal resize path will reconcile it after attach.
      }
    }

    final openPayload = {
      'protocolVersion': protocolVersion,
      'requestId': _openRequestId,
      'agentId': agentId,
      'cols': cols,
      'rows': rows,
      'compression': const ['zlib', 'none'],
    };
    var sent = await send('terminal_open', openPayload);
    if (!sent) {
      // Most commonly transient: the local transport is mid-reconnect at this exact instant (e.g.
      // right after the app itself just started, or another machine's relay hiccupped a moment ago).
      sent = await _recoverAndResend(openPayload);
    }
    if (!sent) {
      transportLost('Could not send terminal_open');
      return;
    }
    // Armed unconditionally (not just on reopen attempts): a `terminal_open` sent through a silently
    // stale relay session never gets ANY reply — nothing else would ever notice or recover from that.
    _resyncTimer?.cancel();
    _resyncTimer = Timer(
      resyncTimeout,
      () => unawaited(_handleOpenTimeout(openPayload)),
    );
  }

  /// The armed-on-every-open watchdog fired: no `terminal_ready` arrived in time even though the send
  /// itself succeeded — the relay session was silently stale (ciphertext for a dead E2EE session gets
  /// dropped, not rejected). Force a fresh dial and resend the SAME open request (same `requestId`, so
  /// a late reply for the original still matches) before giving up.
  Future<void> _handleOpenTimeout(Map<String, dynamic> openPayload) async {
    if (status != TerminalSessionStatus.opening || streamId != null) return;
    final sent = await _recoverAndResend(openPayload);
    if (sent) {
      _resyncTimer?.cancel();
      _resyncTimer = Timer(
        resyncTimeout,
        () => unawaited(_handleOpenTimeout(openPayload)),
      );
      return;
    }
    _fail(
      'TERMINAL_RESYNC_TIMEOUT',
      _autoReopenAttempts > 0
          ? 'Terminal did not reopen after resync failed.'
          : 'Harness did not respond — check your connection.',
    );
  }

  /// Shared recovery for both open-failure paths (`send()` itself failing, and `terminal_ready` never
  /// arriving): force a fresh transport dial (see `WsConn.forceReconnect`), then poll-resend — a forced
  /// relay redial is a REAL network round trip (fresh E2EE handshake for a relayed machine), and
  /// `forceReconnect()` resolving only means the redial STARTED, not that the transport is ready again.
  /// Bounded by [_openStallRecovered] (one forced reconnect per open) and a fixed poll budget, so a
  /// persistently broken connection still fails closed instead of retrying forever.
  Future<bool> _recoverAndResend(Map<String, dynamic> openPayload) async {
    final recover = onOpenStalled;
    if (_openStallRecovered || recover == null) return false;
    _openStallRecovered = true;
    try {
      await recover();
    } catch (_) {
      // Still worth polling for readiness even if the forced reconnect itself errored.
    }
    for (var attempt = 0; attempt < 10; attempt++) {
      if (_disposed || status != TerminalSessionStatus.opening) return false;
      if (await send('terminal_open', openPayload)) return true;
      await Future.delayed(const Duration(milliseconds: 300));
    }
    return false;
  }

  /// Returns true when [type] belongs to this session's protocol.
  Future<bool> handleFrame(String type, Map<String, dynamic> payload) async {
    switch (type) {
      case 'terminal_ready':
        if (status != TerminalSessionStatus.opening ||
            payload['requestId'] != _openRequestId ||
            payload['agentId'] != agentId ||
            payload['protocolVersion'] != protocolVersion) {
          return true;
        }
        streamId = payload['streamId'] as String?;
        if (streamId == null || streamId!.isEmpty) {
          _fail('TERMINAL_READY_INVALID', 'Harness returned no stream id');
          return true;
        }
        _resyncTimer?.cancel();
        _resyncTimer = null;
        _heartbeat = Timer.periodic(
          const Duration(seconds: 5),
          (_) => unawaited(_sendHeartbeat()),
        );
        _armInitialKeyframeWatchdog();
        return true;
      case 'terminal_keyframe':
      case 'terminal_output':
        _fail(
          'TERMINAL_BINARY_REQUIRED',
          'Harness sent terminal bulk data as JSON',
        );
        return true;
      case 'terminal_chunked_upload_begin_result':
        if (!_matchesStream(payload)) return true;
        final accepted = payload['accepted'] == true;
        if (_activeUpload?.beginAccepted.isCompleted == false) {
          _activeUpload!.beginAccepted.complete(accepted);
        }
        return true;
      case 'terminal_chunked_upload_progress':
        if (!_matchesStream(payload)) return true;
        final bytesWritten = (payload['bytesWritten'] as num?)?.toInt();
        final totalBytes = (payload['totalBytes'] as num?)?.toInt();
        if (bytesWritten != null &&
            totalBytes != null &&
            uploadProgress != null) {
          uploadProgress = uploadProgress!.copyWith(
            bytesWritten: bytesWritten,
            totalBytes: totalBytes,
          );
          notifyListeners();
        }
        return true;
      case 'terminal_paste_image_result':
      case 'terminal_paste_file_result':
        if (!_matchesStream(payload)) return true;
        if (_activeUpload?.finished.isCompleted == false) {
          _activeUpload!.finished.complete(true);
        }
        return true;
      case 'terminal_link_mode':
        if (!_matchesStream(payload)) return true;
        final mode = payload['mode']?.toString();
        // Allow-list, not a blind assign: an older CLI knows only 'p2p'/'relay', a newer one may learn
        // values this build cannot draw, and either way linkMode must stay something the header has an
        // icon for. An unknown value leaves the previous state alone rather than blanking it.
        if (mode == 'p2p' || mode == 'turn' || mode == 'relay') {
          linkMode = mode;
          notifyListeners();
        }
        return true;
      case 'terminal_closed':
        if (!_matchesStream(payload)) return true;
        _cancelTimers();
        final code = payload['code']?.toString();
        final takenOver = code == 'TERMINAL_TAKEN_OVER';
        status = takenOver
            ? TerminalSessionStatus.takenOver
            : TerminalSessionStatus.closed;
        errorCode = takenOver ? code : null;
        errorMessage = takenOver
            ? 'Another client connected to this terminal.'
            : payload['reason']?.toString();
        streamId = null;
        linkMode = null;
        notifyListeners();
        return true;
      case 'terminal_error':
        final errorStream = payload['streamId'];
        final errorRequest = payload['requestId'];
        if (errorStream != null && errorStream != streamId) return true;
        if (errorRequest != null && errorRequest != _openRequestId) return true;
        final errorCode = payload['code']?.toString() ?? 'TERMINAL_ERROR';
        // A rejected paste (empty, or over the daemon's sanity ceiling) never touched tmux — the
        // stream itself is completely fine, so this must not freeze it the way a real transport/
        // protocol failure does. `debugPrint` only: there is no dedicated per-action failure surface
        // to show the user something better than silence, and silence beats losing the terminal.
        // A malformed upload chunk (bad seq/size) is the same shape of non-event for the same
        // reason — nothing it describes ever reached tmux either.
        if (errorCode == 'TERMINAL_PASTE_INVALID' ||
            errorCode == 'TERMINAL_CHUNKED_UPLOAD_INVALID') {
          _abortActiveUpload();
          notifyListeners();
          debugPrint(
            'TerminalSession: paste rejected: ${payload['message'] ?? errorCode}',
          );
          return true;
        }
        // A refused INPUT frame never reached tmux either: the stream is fine, only our counter
        // disagrees with the daemon's (a frame dropped on this side while resyncing, say). A daemon
        // that says what it expects gets realigned in place — the refused keystroke is gone either
        // way, and the person retypes it — and an older one that does not gets a fresh stream. What
        // it must NOT get is the frozen pane this used to be: every later keystroke was refused too,
        // and a working terminal read as a dead one.
        if (errorCode == 'TERMINAL_INPUT_INVALID') {
          final expected = payload['expectedSeq'];
          if (expected is int && expected >= 0) {
            // A stale duplicate: the daemon refused several in-flight frames
            // at once, each naming this same seq, and the counter has since
            // moved on from it and been accepted. Rewinding again would put the
            // next keystroke under a number the daemon has already taken.
            // Safe because its expectation only ever grows and its errors
            // arrive in order — a NEW gap always names a larger seq.
            if (expected == _lastRealignedTo) return true;
            _lastRealignedTo = expected;
            _inputSeq = expected;
            // Bytes still waiting in the coalescer are kept: they are numbered
            // on the way out, after this, so they go under the right seq.
            debugPrint(
              'TerminalSession: input seq realigned to $expected '
              '(${payload['reason'] ?? payload['message'] ?? 'no reason given'})',
            );
            notifyListeners();
          } else {
            _inputBytes.clear();
            unawaited(_recoverByReopen(reason: 'TERMINAL_INPUT_INVALID'));
          }
          return true;
        }
        // A genuine mid-transfer failure (the daemon couldn't write the clipboard/disk, or the
        // pty write itself failed) IS treated like a real transport/protocol failure — same as
        // TERMINAL_PASTE_FAILED already is, since it may mean the pty is in an unknown state.
        // `_fail` itself resolves any in-flight upload (see `_abortActiveUpload`), so there is
        // nothing extra to do here for TERMINAL_PASTE_IMAGE_FAILED/TERMINAL_PASTE_FILE_FAILED.
        _fail(errorCode, payload['message']?.toString());
        return true;
      case 'terminal_transport_error':
        transportLost(
          payload['code']?.toString() ?? 'Terminal relay rejected the frame',
        );
        return true;
      default:
        return false;
    }
  }

  Future<void> handleBinary(TerminalBinaryFrame frame) async {
    if (frame.streamId != streamId) return;
    _renderTail = _renderTail
        .then((_) async {
          final bytes = _decodeBinaryBytes(frame);
          if (bytes == null) {
            await _requestResync('TERMINAL_BINARY_DECODE_FAILED');
            return;
          }
          if (frame.kind == TerminalBinaryKind.keyframe) {
            final nextCols = frame.cols;
            final nextRows = frame.rows;
            if (nextCols == null || nextRows == null) {
              await _requestResync('TERMINAL_KEYFRAME_INVALID');
              return;
            }
            cols = _clampCols(nextCols);
            rows = _clampRows(nextRows);
            _utf8Tail = const [];
            _remoteCursorVisible = true;
            _cursorBlinkPhaseVisible = true;
            terminal = _newTerminal()..resize(cols, rows);
            if (!_writeBytes(_prepareKeyframeBytes(bytes))) {
              await _requestResync('TERMINAL_UTF8_DECODE_FAILED');
              return;
            }
            _expectedSeq = frame.seq + 1;
            _lastRenderedSeq = frame.seq;
            _resyncRequested = false;
            _resyncAttempts = 0;
            _autoReopenAttempts = 0;
            errorCode = null;
            errorMessage = null;
            _resyncTimer?.cancel();
            _resyncTimer = null;
            status = TerminalSessionStatus.controlling;
            _markForAck(bytes.length);
            notifyListeners();
            final measured = _measuredViewport;
            if (measured != null) {
              _pendingCols = measured.cols;
              _pendingRows = measured.rows;
            }
            if (_pendingCols != null && _pendingRows != null) {
              unawaited(_flushResize());
            }
            return;
          }
          if (frame.kind == TerminalBinaryKind.sync) {
            if (status == TerminalSessionStatus.resyncing) return;
            if (_expectedSeq == null || frame.seq != _expectedSeq) {
              await _requestResync('TERMINAL_SEQUENCE_GAP');
              return;
            }
            _expectedSeq = frame.seq + 1;
            _lastRenderedSeq = frame.seq;
            _markForAck(0);
            return;
          }
          if (frame.kind != TerminalBinaryKind.output ||
              status == TerminalSessionStatus.resyncing) {
            return;
          }
          if (_expectedSeq == null || frame.seq != _expectedSeq) {
            await _requestResync('TERMINAL_SEQUENCE_GAP');
            return;
          }
          if (!_writeBytes(bytes)) {
            await _requestResync('TERMINAL_OUTPUT_DECODE_FAILED');
            return;
          }
          _expectedSeq = frame.seq + 1;
          _lastRenderedSeq = frame.seq;
          _markForAck(bytes.length);
        })
        .catchError((Object error, StackTrace stackTrace) async {
          debugPrint(
            '[terminal-session] renderer failed for '
            '$machineId/$agentId: $error\n$stackTrace',
          );
          CrashLog.record(error, stackTrace, context: 'renderer');
          await onRendererFailure();
        });
    await _renderTail;
  }

  /// Recover from an exception thrown while drawing a frame.
  ///
  /// A renderer fault is LOCAL, and calling it a lost transport was the wrong
  /// diagnosis: the bytes arrived intact and something in drawing them threw.
  /// That froze the tile behind a manual "attach new stream" for a fault the
  /// ordinary resync ladder already clears — it is what the decode failures in
  /// [handleBinary] do — and the ladder is bounded (resync x3, reopen x1, then
  /// a real failure), so a renderer that throws every time still ends up
  /// reporting itself rather than retrying for ever.
  ///
  /// A parser exception can leave the current buffer partially mutated, so the
  /// emulator is not reused: the resync's keyframe is authoritative and
  /// [handleBinary] builds a fresh Terminal for it. Nothing more is written to
  /// the damaged one in the meantime, because the output branch drops frames
  /// while the status is `resyncing`.
  @visibleForTesting
  Future<void> onRendererFailure() =>
      _requestResync('TERMINAL_RENDERER_FAILED');

  Uint8List? _decodeBinaryBytes(TerminalBinaryFrame frame) {
    try {
      return frame.compressed
          ? Uint8List.fromList(ZLibDecoder().convert(frame.bytes))
          : frame.bytes;
    } catch (_) {
      return null;
    }
  }

  void attachViewport(TerminalViewport viewport) {
    _viewport = viewport;
  }

  /// Reports the first grid measured from the actual Flutter terminal render
  /// object. This is deliberately separate from [Terminal.onResize]: creating
  /// a terminal at the conservative 80x24 fallback also fires onResize and
  /// must not be mistaken for a measured viewport.
  void reportViewport(int width, int height) {
    final measured = (cols: _clampCols(width), rows: _clampRows(height));
    _measuredViewport = measured;
    if (_viewportSize.isCompleted) return;
    _viewportSize.complete(measured);
  }

  void detachViewport(TerminalViewport viewport) {
    if (identical(_viewport, viewport)) _viewport = null;
  }

  /// Changes only the local paint phase of the cursor. Incoming terminal data
  /// is always parsed against [_remoteCursorVisible], so blinking cannot turn
  /// a remote DECTCEM hide/show command into terminal input or corrupt its
  /// authoritative cursor state.
  void setCursorBlinkPhase(bool visible) {
    if (_cursorBlinkPhaseVisible == visible) return;
    _cursorBlinkPhaseVisible = visible;
    _applyCursorVisibility();
  }

  void _writeTerminalText(String text) {
    terminal.setCursorVisibleMode(_remoteCursorVisible);
    terminal.write(text);
    _remoteCursorVisible = terminal.cursorVisibleMode;
    _applyCursorVisibility();
  }

  void _applyCursorVisibility() {
    terminal.setCursorVisibleMode(
      _remoteCursorVisible && _cursorBlinkPhaseVisible,
    );
  }

  bool _writeBytes(List<int> bytes) {
    // Most packets end on a scalar boundary. Decode their existing byte view
    // directly; only a split UTF-8 scalar needs a joined buffer.
    final combined = _utf8Tail.isEmpty ? bytes : <int>[..._utf8Tail, ...bytes];
    for (
      var tailLength = 0;
      tailLength <= min(3, combined.length);
      tailLength++
    ) {
      try {
        final text = utf8.decoder.convert(
          combined,
          0,
          combined.length - tailLength,
        );
        if (text.isNotEmpty) _writeTerminalText(text);
        _utf8Tail = tailLength == 0
            ? const []
            : combined.sublist(combined.length - tailLength);
        return true;
      } catch (_) {
        // A UTF-8 scalar can span at most four bytes; retain only a trailing
        // partial scalar before falling back to replacement rendering below.
      }
    }
    // PTY output is byte-oriented. A snapshot cut can rarely land between the
    // leading and continuation bytes of a scalar, leaving a continuation byte
    // at the start of the post-cut frame. Real terminals render malformed UTF-8
    // as U+FFFD; resyncing the entire screen creates a second keyframe race and
    // cannot recover the missing pre-cut byte anyway.
    final text = utf8.decode(combined, allowMalformed: true);
    if (text.isNotEmpty) _writeTerminalText(text);
    _utf8Tail = const [];
    return true;
  }

  List<int> _prepareKeyframeBytes(Uint8List bytes) {
    if (engineId != 'grok') return bytes;

    // Grok renders a full-screen TUI in tmux's normal buffer. Its tmux
    // scrollback therefore contains old full-screen repaint frames rather than
    // semantic history. Render Grok in the receiver's alternate buffer so the
    // stale frames cannot become local scrollback; wheel input is then routed
    // back to Grok, which owns and redraws its real transcript with ANSI style.
    const alternateBuffer = <int>[
      0x1b,
      0x5b,
      0x3f,
      0x31,
      0x30,
      0x34,
      0x39,
      0x68,
    ];
    if (bytes.length >= 2 && bytes[0] == 0x1b && bytes[1] == 0x63) {
      return <int>[bytes[0], bytes[1], ...alternateBuffer, ...bytes.sublist(2)];
    }
    return <int>[...alternateBuffer, ...bytes];
  }

  Terminal _newTerminal() {
    final result = Terminal(
      maxLines: 10000,
      platform: TerminalTargetPlatform.macos,
      // The remote pane owns its grid and redraws after resize. Reflowing TUI
      // rows locally both changes their geometry and exercises an xterm.dart
      // circular-buffer bug when a remote/local switch changes viewport size.
      reflowEnabled: false,
    );
    result.onOutput = _onTerminalOutput;
    result.onResize = (width, height, _, _) => resize(width, height);
    return result;
  }

  /// Sends a composed message as one turn.
  ///
  /// This does NOT write bytes into the pane. It sends the same `message` frame the web client
  /// uses to drive a turn (`sendMessage` in web's `lib/ws.ts`), and the machine's own handler owns
  /// the injection from there: it adapts slash commands to the pane's engine and retries the
  /// submit Enter. A client typing bytes can do neither — which is exactly how Codex ended up
  /// holding a composed line unsent, its Enter arriving in the same read as the text.
  Future<bool> sendComposerText(String text) async {
    if (!acceptsInput) return false;
    final content = text.trimRight();
    if (content.trim().isEmpty) return false;
    return send('message', {
      'content': content,
      'agentId': agentId,
      'mode': 'auto',
    });
  }

  /// A clipboard paste made directly into this pane, delivered as one atomic unit instead of going
  /// through the same chunked pipeline as ordinary typing ([_onTerminalOutput]/[_flushInput]).
  ///
  /// A big paste run through that pipeline gets sliced into ≤8 KiB binary frames client-side and then
  /// into 2 KiB `send-keys -H` bursts on the daemon — each burst arrives far enough apart that the
  /// engine's own paste-detector (readline/Ink) can register it as a SEPARATE paste, which is why a
  /// large paste read as dozens of `[Pasted text #N]` markers instead of one. A [TerminalBinaryKind.paste]
  /// frame routes through the daemon's `tmux paste-buffer` instead, the same single-shot mechanism
  /// composer messages already use — see `pasteRawIntoTmux` in the harness CLI.
  ///
  /// Binary, not JSON: unlike a JSON frame type, a new binary `kind` needs no entry in the E2EE
  /// allowlist (`ENCRYPTED_DOWN_TYPES`) three OTHER codebases also pin a hash of — the AEAD wrapping
  /// that already covers `input`/`output` covers this too, with nothing extra to keep in sync. That is
  /// what lets this work over a relayed machine, not just a local one.
  ///
  /// The caller must check [MachineState.terminalPasteRawAvailable] first: an older CLI does not know
  /// this binary kind at all, so sending it there would silently go nowhere.
  Future<bool> pasteText(String text) async {
    if (!acceptsInput) return false;
    // Forwarded verbatim, including a stray 0x03 — same as _onTerminalOutput/sendComposerText.
    if (text.isEmpty) return false;
    final currentStreamId = streamId;
    if (currentStreamId == null) return false;
    final frame = TerminalBinaryFrame(
      kind: TerminalBinaryKind.paste,
      streamId: currentStreamId,
      // Unused server-side (a paste is one self-contained unit, not part of the ordered keystroke
      // stream `input`'s seq guards) — kept at 0 rather than threading a second counter for a field
      // nothing reads.
      seq: 0,
      bytes: Uint8List.fromList(utf8.encode(text)),
      compressed: false,
    );
    final sent = await sendBinary(frame);
    if (!sent) transportLost('Terminal paste was not sent');
    return sent;
  }

  /// A clipboard IMAGE paste (raw PNG bytes) made directly into this pane, sent as a chunked
  /// upload (see [_uploadBytes]) over [TerminalBinaryKind.imagePaste] frames — the daemon's
  /// text-paste handler requires valid UTF-8 and would reject PNG bytes outright, hence its own
  /// kind, same reason [pasteText] doesn't carry it.
  ///
  /// The caller must check [MachineState.terminalImagePasteAvailable] first, same reason
  /// [pasteText] checks `terminalPasteRawAvailable`: an older CLI does not know this binary kind
  /// at all, so sending it there would silently go nowhere.
  Future<bool> pasteImage(Uint8List pngBytes) async {
    if (pngBytes.isEmpty) return false;
    return _uploadBytes(
      uploadKind: 'image',
      filename: null,
      bytes: pngBytes,
      binaryKind: TerminalBinaryKind.imagePaste,
    );
  }

  /// A dropped (non-image) FILE — sent as a chunked upload (see [_uploadBytes]) so the daemon can
  /// write it to disk on its own (REMOTE) machine and paste that path as text. Only meaningful for
  /// a genuinely remote pane: a LOCAL file already has a valid path on this same machine, so
  /// callers should paste that path directly via [pasteText] instead and never reach this method
  /// at all — see [MachineState.isLocalMachine].
  ///
  /// The caller must check [MachineState.terminalPasteFileAvailable] first, same reason
  /// [pasteImage] checks `terminalImagePasteAvailable`: an older CLI does not know this binary kind
  /// at all, so sending it there would silently go nowhere.
  Future<bool> pasteFile(String filename, Uint8List content) async {
    if (filename.isEmpty || content.isEmpty) return false;
    return _uploadBytes(
      uploadKind: 'file',
      filename: filename,
      bytes: content,
      binaryKind: TerminalBinaryKind.pasteFile,
    );
  }

  /// Cancels whatever image/file upload is currently in flight on this pane, if any — the user's
  /// own Cancel affordance on the upload-progress overlay. A no-op if nothing is uploading.
  Future<void> cancelUpload() async {
    final upload = _activeUpload;
    final currentStreamId = streamId;
    if (upload == null) return;
    if (!upload.finished.isCompleted) upload.finished.complete(false);
    _clearUpload();
    if (currentStreamId != null) {
      await send('terminal_chunked_upload_cancel', {
        'streamId': currentStreamId,
      });
    }
  }

  /// Shared orchestration for [pasteImage]/[pasteFile]: announce the upload
  /// (`terminal_chunked_upload_begin`), wait to be accepted, send the bytes as a series of
  /// `binaryKind` frames — [TerminalBinaryFrame.seq] is the chunk index — each at most
  /// [terminalUploadChunkBytes], then wait for the daemon's completion/error frame. Chunked rather
  /// than sent whole because a single frame over 512 KiB never reaches a relayed or P2P-connected
  /// remote machine at all (both cap a binary message there); see the plan this shipped from.
  ///
  /// [uploadProgress] reflects the daemon's own per-chunk ACKs
  /// (`terminal_chunked_upload_progress`), not "chunks handed to the local socket" — that is what
  /// keeps the percentage honest on a slow link, mirroring the firmware pusher's `fw.progress`
  /// philosophy (`autonomous-harness/cli/src/cable/fwPush.ts`). Only one upload runs at a time per
  /// pane — a second call while one is active is refused immediately, matching the daemon's own
  /// "an upload is already in progress" rejection.
  Future<bool> _uploadBytes({
    required String uploadKind,
    required String? filename,
    required Uint8List bytes,
    required TerminalBinaryKind binaryKind,
  }) async {
    if (!acceptsInput) return false;
    if (_activeUpload != null) return false;
    final currentStreamId = streamId;
    if (currentStreamId == null) return false;

    final upload = _ActiveUpload();
    _activeUpload = upload;
    uploadProgress = UploadProgress(
      label: filename ?? 'image',
      bytesWritten: 0,
      totalBytes: bytes.length,
    );
    notifyListeners();

    final sentBegin = await send('terminal_chunked_upload_begin', {
      'streamId': currentStreamId,
      'uploadKind': uploadKind,
      'totalBytes': bytes.length,
      'filename': ?filename,
    });
    if (!sentBegin) {
      transportLost('Terminal upload request was not sent');
      _clearUpload();
      return false;
    }

    final accepted = await upload.beginAccepted.future.timeout(
      const Duration(seconds: 10),
      onTimeout: () => false,
    );
    if (!accepted || !identical(_activeUpload, upload)) {
      _clearUpload();
      return false;
    }

    var offset = 0;
    var seq = 0;
    while (offset < bytes.length) {
      final end = min(offset + terminalUploadChunkBytes, bytes.length);
      final frame = TerminalBinaryFrame(
        kind: binaryKind,
        streamId: currentStreamId,
        seq: seq,
        bytes: Uint8List.sublistView(bytes, offset, end),
        compressed: false,
      );
      final sentChunk = await sendBinary(frame);
      if (!sentChunk || !identical(_activeUpload, upload)) {
        if (sentChunk) return false; // upload was cancelled/cleared out from under us mid-send
        transportLost('Terminal upload chunk was not sent');
        _clearUpload();
        return false;
      }
      offset = end;
      seq++;
    }

    final finished = await upload.finished.future.timeout(
      const Duration(minutes: 2),
      onTimeout: () => false,
    );
    if (identical(_activeUpload, upload)) _clearUpload();
    return finished;
  }

  void _clearUpload() {
    _activeUpload = null;
    uploadProgress = null;
    notifyListeners();
  }

  void _onTerminalOutput(String data) {
    if (!acceptsInput || data.isEmpty) return;
    final bytes = utf8.encode(data);
    final isBoundary =
        data.contains('\r') ||
        data.contains('\x1b[200~') ||
        data.contains('\x1b[201~');
    if (isBoundary) unawaited(_flushInput());
    var offset = 0;
    while (offset < bytes.length) {
      final available = 8 * 1024 - _inputBytes.length;
      final take = min(available, bytes.length - offset);
      _inputBytes.addAll(bytes.sublist(offset, offset + take));
      offset += take;
      if (_inputBytes.length == 8 * 1024) unawaited(_flushInput());
    }
    if (isBoundary) {
      unawaited(_flushInput());
    } else if (_inputBytes.isNotEmpty) {
      // Leading edge: the first keystroke after a pause goes out at once. The window exists to
      // batch key-repeat, and a lone keypress has nothing to batch with — making it wait was
      // 4ms of pure latency on every character typed at human speed. Anything arriving inside
      // the window still rides the trailing timer, so the frame rate stays bounded.
      final last = _lastInputFlushAt;
      final idle =
          last == null ||
          DateTime.now().difference(last) >= _inputCoalesceWindow;
      if (_inputTimer == null && idle) {
        unawaited(_flushInput());
      } else {
        _inputTimer ??= Timer(
          _inputCoalesceWindow,
          () => unawaited(_flushInput()),
        );
      }
    }
  }

  Future<void> _flushInput() async {
    _inputTimer?.cancel();
    _inputTimer = null;
    if (!acceptsInput || _inputBytes.isEmpty) {
      _inputBytes.clear();
      return;
    }
    final bytes = List<int>.from(_inputBytes);
    _inputBytes.clear();
    _lastInputFlushAt = DateTime.now();
    final currentStreamId = streamId;
    if (currentStreamId == null) return;
    final queued = _inputSendTail.then((_) async {
      if (!acceptsInput || streamId != currentStreamId) return;
      // Numbered HERE, on the tail, not when the flush was asked for. A frame
      // the guard above drops — the session went `resyncing` while an earlier
      // send was still in flight — must not consume a seq: the daemon wants
      // them contiguous and never re-syncs its counter, so one skipped number
      // had the very next keystroke refused and the whole pane frozen. The
      // tail runs one closure at a time, which is what keeps the numbers in
      // order.
      //
      // Never larger than the daemon accepts, either — split rather than let
      // one oversized frame be refused with the counter intact behind it.
      for (
        var offset = 0;
        offset < bytes.length;
        offset += kInputFrameMaxBytes
      ) {
        final end = min(offset + kInputFrameMaxBytes, bytes.length);
        final frame = TerminalBinaryFrame(
          kind: TerminalBinaryKind.input,
          streamId: currentStreamId,
          seq: _inputSeq++,
          bytes: Uint8List.fromList(bytes.sublist(offset, end)),
          compressed: false,
        );
        final sent = await sendBinary(frame);
        if (!sent) {
          transportLost('Terminal input was not sent');
          return;
        }
      }
    });
    _inputSendTail = queued.catchError((_) {
      transportLost('Terminal input was not sent');
    });
    await queued;
  }

  /// A finger on the dial moved — scroll whatever this session is showing.
  ///
  /// Goes STRAIGHT to the renderer rather than through the machine: the scrollback being moved is the copy
  /// in this window, and the agent on the other end has no idea the view scrolled. Nothing is sent over
  /// the wire and nothing is echoed back.
  void scroll(int phase, int dy, int velocity) {
    _viewport?.scroll(phase, dy, velocity);
  }

  /// Coalescing windows for the two things the user drives directly.
  ///
  /// Both are leading + trailing: act on the first event, batch the rest. A flat trailing debounce
  /// charged its full window to every single keystroke and to the start of every drag, which is
  /// latency paid for a batch that mostly never materializes.
  static const _inputCoalesceWindow = Duration(milliseconds: 4);

  /// The daemon's ceiling on one input frame (`INPUT_MAX_BYTES` in
  /// `cli/src/lib/terminalStreamManager.ts`). Larger is refused, not split.
  static const kInputFrameMaxBytes = 64 * 1024;
  static const _resizeCoalesceWindow = Duration(milliseconds: 50);

  void resize(int width, int height) {
    _pendingCols = _clampCols(width);
    _pendingRows = _clampRows(height);
    final last = _lastResizeFlushAt;
    final idle =
        last == null ||
        DateTime.now().difference(last) >= _resizeCoalesceWindow;
    if (_resizeTimer == null && idle) {
      unawaited(_flushResize());
      return;
    }
    // Mid-drag: keep resetting so tmux is asked once, for the size the drag settles on.
    _resizeTimer?.cancel();
    _resizeTimer = Timer(
      _resizeCoalesceWindow,
      () => unawaited(_flushResize()),
    );
  }

  Future<void> _flushResize() async {
    _resizeTimer = null;
    if (!acceptsInput || _pendingCols == null || _pendingRows == null) return;
    final nextCols = _pendingCols!;
    final nextRows = _pendingRows!;
    _pendingCols = null;
    _pendingRows = null;
    if (nextCols == cols && nextRows == rows) return;
    cols = nextCols;
    rows = nextRows;
    _lastResizeFlushAt = DateTime.now();
    final sent = await send('terminal_resize', {
      'streamId': streamId,
      'resizeSeq': _resizeSeq++,
      'cols': cols,
      'rows': rows,
    });
    if (!sent) transportLost('Terminal resize was not sent');
    notifyListeners();
  }

  static const _scrollCoalesceWindow = Duration(milliseconds: 16);

  /// Alt-buffer scroll gesture for a [scrollViaTmuxCopyMode] session — see that getter's doc.
  /// Coalesces rapid deltas (a fast trackpad swipe can emit dozens a second) into one
  /// `terminal_scroll` frame per short burst, mirroring `resize()`'s own debounce. Fire-and-forget
  /// like resize, but a dropped frame here is just a missed scroll, not a transport-health signal —
  /// unlike resize, it never calls `transportLost`.
  void sendScrollCommand(bool up, int lines) {
    if (!scrollViaTmuxCopyMode || lines <= 0) return;
    if (_pendingScrollUp != null && _pendingScrollUp != up) {
      // Direction reversed mid-burst — flush what's accumulated before starting the new direction,
      // rather than let it cancel out into a smaller net scroll the user never asked for.
      unawaited(_flushScrollCommand());
    }
    _pendingScrollUp = up;
    _pendingScrollLines += lines;
    _scrollTimer?.cancel();
    _scrollTimer = Timer(
      _scrollCoalesceWindow,
      () => unawaited(_flushScrollCommand()),
    );
  }

  Future<void> _flushScrollCommand() async {
    _scrollTimer?.cancel();
    _scrollTimer = null;
    final up = _pendingScrollUp;
    final lines = _pendingScrollLines;
    _pendingScrollUp = null;
    _pendingScrollLines = 0;
    if (!acceptsInput || up == null || lines <= 0) return;
    await send('terminal_scroll', {
      'streamId': streamId,
      'direction': up ? 'up' : 'down',
      'lines': lines,
    });
  }

  void _markForAck(int renderedBytes) {
    _framesSinceAck++;
    _renderedSinceAckBytes += renderedBytes;
    if (_renderedSinceAckBytes >= 64 * 1024) {
      unawaited(_flushAck());
      return;
    }
    _ackTimer ??= Timer(
      const Duration(milliseconds: 16),
      () => unawaited(_flushAck()),
    );
  }

  Future<void> _flushAck() async {
    _ackTimer?.cancel();
    _ackTimer = null;
    if (streamId == null || _lastRenderedSeq < 0 || _framesSinceAck == 0) {
      return;
    }
    _framesSinceAck = 0;
    _renderedSinceAckBytes = 0;
    final sent = await send('terminal_ack', {
      'streamId': streamId,
      'lastSeq': _lastRenderedSeq,
    });
    if (!sent) transportLost('Terminal ACK was not sent');
  }

  Future<void> _sendHeartbeat() async {
    if (!acceptsInput) return;
    final sent = await send('terminal_alive', {'streamId': streamId});
    if (!sent) transportLost('Terminal heartbeat was not sent');
  }

  Future<void> _requestResync(String reason) async {
    if (streamId == null) {
      _fail(reason, null);
      return;
    }
    if (!_resyncRequested) {
      _resyncRequested = true;
      _resyncAttempts = 0;
      status = TerminalSessionStatus.resyncing;
      errorCode = reason;
      _inputBytes.clear();
      notifyListeners();
    }
    if (_resyncAttempts > 0) return;
    await _sendResyncAttempt();
  }

  void _armInitialKeyframeWatchdog() {
    _resyncTimer?.cancel();
    _resyncTimer = Timer(resyncTimeout, () {
      if (streamId != null && _expectedSeq == null) {
        unawaited(_requestResync('TERMINAL_KEYFRAME_TIMEOUT'));
      }
    });
  }

  Future<void> _sendResyncAttempt() async {
    final currentStream = streamId;
    if (!_resyncRequested || currentStream == null) return;
    if (_resyncAttempts >= 3) {
      await _recoverByReopen();
      return;
    }
    _resyncAttempts++;
    debugPrint(
      '[terminal-session] resync_request agent=$agentId stream=$currentStream '
      'attempt=$_resyncAttempts code=$errorCode',
    );
    final sent = await send('terminal_resync', {
      'streamId': currentStream,
      'attempt': _resyncAttempts,
      'reason': errorCode,
    });
    if (!sent) {
      transportLost('Could not request terminal resync');
      return;
    }
    _resyncTimer?.cancel();
    _resyncTimer = Timer(resyncTimeout, () {
      if (_resyncRequested && streamId == currentStream) {
        unawaited(_sendResyncAttempt());
      }
    });
  }

  Future<void> _recoverByReopen({
    String reason = 'TERMINAL_RESYNC_TIMEOUT',
  }) async {
    final previousStream = streamId;
    if (_autoReopenAttempts >= 1) {
      debugPrint(
        '[terminal-session] recovery_failed agent=$agentId '
        'stream=$previousStream reason=$reason attempts=$_resyncAttempts',
      );
      _fail(
        reason,
        reason == 'TERMINAL_RESYNC_TIMEOUT'
            ? 'Terminal did not recover after resync and reopen.'
            : 'Terminal did not recover after reopening the stream.',
      );
      return;
    }
    _autoReopenAttempts++;
    debugPrint(
      '[terminal-session] recovery_reopen agent=$agentId stream=$previousStream',
    );
    if (previousStream != null) {
      unawaited(send('terminal_close', {'streamId': previousStream}));
    }
    await _open(
      initialCols: cols,
      initialRows: rows,
      waitForViewportSize: false,
      resetRecovery: false,
    );
  }

  Future<void> close() async {
    final closingStream = streamId;
    _cancelTimers();
    _inputBytes.clear();
    streamId = null;
    linkMode = null;
    status = TerminalSessionStatus.closed;
    notifyListeners();
    if (closingStream != null) {
      await send('terminal_close', {'streamId': closingStream});
    }
  }

  void transportLost([
    String message = 'Connection lost. Select the agent to reconnect.',
  ]) {
    // `takenOver` is a deliberate dead end (see `_paneNeedsAttach`): only the user's own retry
    // may reopen a stream someone else claimed. A WS hiccup must not quietly overwrite that into
    // `error`, which auto-reattach WOULD pick back up — that is exactly the two-machine tug-of-war
    // this status exists to prevent.
    if (status == TerminalSessionStatus.closed ||
        status == TerminalSessionStatus.takenOver) {
      return;
    }
    _cancelTimers();
    _inputBytes.clear();
    streamId = null;
    linkMode = null;
    status = TerminalSessionStatus.error;
    errorCode = 'TERMINAL_DISCONNECTED';
    errorMessage = message;
    _abortActiveUpload();
    notifyListeners();
  }

  void _fail(String code, String? message) {
    _cancelTimers();
    _inputBytes.clear();
    streamId = null;
    linkMode = null;
    status = TerminalSessionStatus.error;
    errorCode = code;
    errorMessage = message;
    _abortActiveUpload();
    notifyListeners();
  }

  /// A safety net for any path that resets the stream (transport loss, a real failure) while an
  /// image/file upload happens to be in flight — resolves its awaiting Future rather than leaving
  /// it to hang until [_uploadBytes]'s own 2-minute timeout. The specific error codes that mean
  /// "the upload itself failed" already call this via [transportLost]/[_fail]; this also covers
  /// every OTHER way the stream can go away mid-upload.
  void _abortActiveUpload() {
    if (_activeUpload?.beginAccepted.isCompleted == false) {
      _activeUpload!.beginAccepted.complete(false);
    }
    if (_activeUpload?.finished.isCompleted == false) {
      _activeUpload!.finished.complete(false);
    }
    _activeUpload = null;
    uploadProgress = null;
  }

  bool _matchesStream(Map<String, dynamic> payload) =>
      streamId != null && payload['streamId'] == streamId;

  int _clampCols(int value) => value.clamp(minCols, maxCols);
  int _clampRows(int value) => value.clamp(minRows, maxRows);

  void _cancelTimers() {
    _heartbeat?.cancel();
    _heartbeat = null;
    _ackTimer?.cancel();
    _ackTimer = null;
    _inputTimer?.cancel();
    _inputTimer = null;
    _resizeTimer?.cancel();
    _resizeTimer = null;
    _resyncTimer?.cancel();
    _resyncTimer = null;
    _scrollTimer?.cancel();
    _scrollTimer = null;
  }

  @override
  void dispose() {
    _disposed = true;
    _cancelTimers();
    super.dispose();
  }
}
