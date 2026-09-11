import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../logging/app_log.dart';
import '../logging/redact.dart';
import '../core/models.dart';

typedef AccessTokenProvider = Future<String> Function(
  bool forceRefresh,
  String? failedToken,
);

enum WsTransportKind { cloudE2ee, localPlaintext }

/// A `request()` call got no reply within its timeout — distinct from other request-level errors
/// (an explicit `{error: ...}` response) so callers can tell "the peer is unresponsive" apart from
/// "the peer answered with a failure."
class WsRequestTimeout implements Exception {
  final String type;
  const WsRequestTimeout(this.type);
  @override
  String toString() => 'WS request timed out: $type';
}

/// The peer ANSWERED a `request()` with an explicit `{error: ...}` — a refusal it meant, as opposed
/// to [WsRequestTimeout]'s silence.
///
/// The code travels as a field rather than only inside the message because that is what callers act
/// on: `AGENT_BUSY` becomes "move it when the turn finishes", `UNSUPPORTED` becomes "update the CLI
/// on this machine". Before this existed every refusal arrived as a bare `Exception` whose only
/// content was its own `toString()`, so the mapping in `AppNotifier` sat behind an `if` on a reply
/// that had already thrown and could never run — the user got the wire code.
///
/// [toString] is the sentence this used to be thrown with, so a call site that only prints it is
/// unchanged.
class WsRequestFailure implements Exception {
  const WsRequestFailure({
    required this.responseType,
    required this.code,
    this.detail,
  });

  /// The frame that carried the refusal — `agent_create_result`, say.
  final String responseType;

  /// The peer's own error code.
  final String code;

  /// The underlying cause behind the code, when the peer sends one — the tmux message behind
  /// SPAWN_FAILED. Already reads as a sentence; prefer it to anything rewritten from [code].
  final String? detail;

  @override
  String toString() => detail == null || detail!.isEmpty
      ? '$responseType: $code'
      : '$responseType: $code — $detail';
}

/// One SSO-authenticated, machine-scoped connection to `/api/web-ws`.
class WsConn {
  final String wsBaseUrl;
  final String autonomousEnv;
  final String machineId;
  final AccessTokenProvider accessTokenProvider;
  final void Function(String message) onAuthFailure;

  /// The local CLI closed this connection with a specific, non-retryable reason (currently just
  /// `NO_PEER_LINK`: the target machine has no `harness link import`ed trust yet) — surfaced instead
  /// of silently reconnecting forever against a failure the user has to act on to fix.
  final void Function(int code, String reason)? onLocalFailure;
  final WsTransportKind transportKind;
  final Uri? localWsUri;

  /// Retained only for fixture constructor compatibility. Local transport ignores it.
  final String? localApiKey;
  final int localProtocolVersion;

  Future<Map<String, dynamic>> Function(
    String type,
    Map<String, dynamic> payload,
  )?
  onOutgoing;
  Future<Map<String, dynamic>?> Function(Map<String, dynamic> frame)?
  onE2eeFrame;
  Future<void> Function(Uint8List frame)? onBinaryFrame;

  final FutureOr<void> Function(Map<String, dynamic> event) onEvent;
  final void Function(ConnectionStatus status) onStatus;

  WebSocketChannel? _channel;
  StreamSubscription? _sub;
  bool _closing = false;
  bool _connecting = false;
  bool _ready = false;
  int _attempt = 0;
  Timer? _reconnectTimer;
  String? _tokenUsed;
  bool _forceRelayReconnect = false;
  final _pending = <String, _PendingRpc>{};
  final _queue = <Map<String, dynamic>>[];
  Future<void> _outboundTail = Future<void>.value();
  Future<void> _inboundTail = Future<void>.value();

  bool get isReady => _ready && _channel != null;

  /// True once this connection has permanently given up (a deliberate [close], or a non-retryable
  /// local failure like NO_PEER_LINK) — [WsPool] must not hand a closed connection back out.
  bool get isClosed => _closing;
  bool get isLocal => transportKind == WsTransportKind.localPlaintext;
  String get endpointKey => isLocal
      ? 'local:${localWsUri.toString()}'
      : 'cloud:$wsBaseUrl:$autonomousEnv';

  WsConn({
    required this.wsBaseUrl,
    required this.autonomousEnv,
    required this.machineId,
    required this.accessTokenProvider,
    required this.onAuthFailure,
    this.onLocalFailure,
    required this.onEvent,
    required this.onStatus,
    this.transportKind = WsTransportKind.cloudE2ee,
    this.localWsUri,
    this.localApiKey,
    this.localProtocolVersion = 1,
  });

  Future<void> connect() async {
    if (_closing || _connecting) return;
    _connecting = true;
    _ready = false;
    onStatus(
      _attempt == 0
          ? ConnectionStatus.connecting
          : ConnectionStatus.reconnecting,
    );
    try {
      final token = isLocal ? null : await accessTokenProvider(false, null);
      if (!isLocal && (token == null || token.isEmpty)) {
        throw StateError('WebSocket credential is missing');
      }
      if (_closing) return;
      _tokenUsed = token;
      final Uri uri;
      if (isLocal) {
        final local = localWsUri;
        if (local == null ||
            (local.host != '127.0.0.1' && local.host != 'localhost')) {
          throw StateError('Local WebSocket must use loopback');
        }
        uri = local;
      } else {
        final base = Uri.parse('$wsBaseUrl/api/web-ws');
        uri = base.replace(
          queryParameters: {
            ...base.queryParameters,
            'autonomousEnv': autonomousEnv,
          },
        );
      }
      final channel = isLocal
          ? WebSocketChannel.connect(uri)
          : WebSocketChannel.connect(uri, protocols: [token!]);
      _channel = channel;
      await channel.ready;
      if (_closing || !identical(_channel, channel)) {
        await channel.sink.close();
        return;
      }
      _sub = channel.stream.listen(
        _onRaw,
        onDone: () => _onDone(channel),
        onError: (_) => _onDone(channel),
      );
      final forceRelayReconnect = _forceRelayReconnect;
      _forceRelayReconnect = false;
      await sendFrame({
        'type': 'machine_select',
        'payload': {
          'machineId': machineId,
          if (isLocal) 'localProtocolVersion': localProtocolVersion,
          if (isLocal && forceRelayReconnect) 'forceReconnect': true,
        },
      });
    } catch (_) {
      if (!_closing) _scheduleReconnect();
    } finally {
      _connecting = false;
    }
  }

  void _onRaw(dynamic raw) {
    if (raw is List<int>) {
      final bytes = Uint8List.fromList(raw);
      _inboundTail = _inboundTail
          .then((_) async => onBinaryFrame?.call(bytes))
          .catchError((_) {
            // Binary E2EE/session code owns recovery for bad frames.
          });
      return;
    }
    final Map<String, dynamic> message;
    try {
      message = jsonDecode(raw as String) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    final type = message['type'] as String? ?? '';
    final payload = (message['payload'] as Map<String, dynamic>?) ?? {};

    if (type == 'connected') {
      if (payload['machineId'] == machineId) {
        _ready = true;
        _attempt = 0;
        onStatus(ConnectionStatus.connected);
        _flushQueue();
      }
      return;
    }
    final normalized = <String, dynamic>{...message, 'payload': payload};
    _inboundTail = _inboundTail
        .then((_) async {
          final isE2ee =
              type.startsWith('e2e_') ||
              (payload.containsKey('__e2e') && payload['__e2e'] is Map);
          if (isE2ee && onE2eeFrame != null) {
            await _handleE2ee(normalized);
          } else {
            await _dispatch(normalized);
          }
        })
        .catchError((_) {
          // Keep the FIFO alive. E2EE/session code owns recovery for bad frames.
        });
  }

  Future<void> _dispatch(Map<String, dynamic> message) async {
    final payload = (message['payload'] as Map<String, dynamic>?) ?? {};
    final requestId = payload['requestId'];
    if (requestId is String && _pending.containsKey(requestId)) {
      final pending = _pending.remove(requestId)!;
      pending.timer.cancel();
      if (payload['error'] != null) {
        // `detail`, when the peer sends one, is the underlying cause behind the code — the tmux
        // message behind SPAWN_FAILED, say. Without it an error code alone sends the user to a log file
        // on a machine that is not the one in front of them.
        final detail = payload['detail'];
        pending.completer.completeError(
          WsRequestFailure(
            responseType: message['type'] as String? ?? 'unknown_result',
            code: '${payload['error']}',
            detail: detail is String && detail.isNotEmpty ? detail : null,
          ),
        );
      } else {
        pending.completer.complete(payload);
      }
      return;
    }
    final eventType = message['type'];
    if (eventType is String && _worthLogging(eventType)) {
      appLog.debug('ws', '↓ $eventType ${summariseForLog(payload)}');
    }
    await onEvent({...message, 'payload': payload});
  }

  Future<void> _handleE2ee(Map<String, dynamic> frame) async {
    final decrypted = await onE2eeFrame!(frame);
    if (decrypted != null) await _dispatch(decrypted);
  }

  /// Frame types deliberately kept OUT of the log.
  ///
  /// Terminal traffic is the overwhelming majority of what crosses this socket
  /// and none of it is diagnostic — it is somebody's screen. Logging it would
  /// bury every frame that matters, cost an fsync per keystroke, and write the
  /// contents of their editor to disk. The hardware dial's events are dropped
  /// for the volume alone.
  static const _unlogged = {
    // File paths and media contents are user data, not frame diagnostics.
    'agent_read_file',
    'agent_read_file_result',
    'terminal_output',
    'terminal_input',
    'terminal_resize',
    'terminal_sync',
    'dial_scroll',
    'dial_focus',
    'ping',
    'pong',
  };

  static bool _worthLogging(String type) => !_unlogged.contains(type);

  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    final requestId = _newRequestId();
    final completer = Completer<Map<String, dynamic>>();
    final timer = Timer(timeout, () {
      _pending.remove(requestId);
      _queue.removeWhere(
        (f) =>
            (f['payload'] as Map<String, dynamic>?)?['requestId'] == requestId,
      );
      if (!completer.isCompleted) {
        completer.completeError(WsRequestTimeout(type));
      }
    });
    _pending[requestId] = _PendingRpc(completer, timer);
    if (_worthLogging(type)) {
      appLog.debug('ws', '→ $type ${summariseForLog(payload)}');
      // A second listener on the same future purely to record how it ended. It
      // handles its own error, so the caller's handling is unchanged and nothing
      // becomes an unhandled rejection.
      completer.future.then(
        (value) => appLog.debug('ws', '← $type ${summariseForLog(value)}'),
        onError: (Object error) =>
            appLog.warn('ws', '← $type failed', error: error),
      );
    }
    final frame = {
      'type': type,
      'payload': {...payload, 'requestId': requestId},
    };
    if (_ready) {
      unawaited(_sendRpcFrame(frame, requestId, type));
    } else {
      _queue.add(frame);
    }
    return completer.future;
  }

  void sendRaw(String type, Map<String, dynamic> payload) =>
      unawaited(sendFrame({'type': type, 'payload': payload}));

  /// Terminal input is best-effort: it is never queued across reconnect and
  /// the caller gets false if the socket stopped being ready before send.
  Future<bool> sendTerminalFrame(String type, Map<String, dynamic> payload) =>
      _enqueueFrame({'type': type, 'payload': payload}, requireReady: true);

  Future<bool> sendTerminalBinary(Uint8List bytes) {
    final completer = Completer<bool>();
    _outboundTail = _outboundTail
        .then((_) {
          if (!isReady) {
            completer.complete(false);
            return;
          }
          final channel = _channel;
          if (channel == null) {
            completer.complete(false);
            return;
          }
          try {
            channel.sink.add(bytes);
            completer.complete(true);
          } catch (_) {
            completer.complete(false);
          }
        })
        .catchError((_) {
          if (!completer.isCompleted) completer.complete(false);
        });
    return completer.future;
  }

  Future<void> sendFrame(Map<String, dynamic> frame) async {
    await _enqueueFrame(frame);
  }

  Future<bool> _enqueueFrame(
    Map<String, dynamic> frame, {
    bool requireReady = false,
    void Function(Object error)? onFailure,
  }) {
    final completer = Completer<bool>();
    _outboundTail = _outboundTail
        .then((_) async {
          if (requireReady && !isReady) {
            completer.complete(false);
            return;
          }
          try {
            await _sendFrameNow(frame);
            completer.complete(true);
          } catch (error) {
            onFailure?.call(error);
            completer.complete(false);
          }
        })
        .catchError((error) {
          onFailure?.call(error);
          if (!completer.isCompleted) completer.complete(false);
        });
    return completer.future;
  }

  Future<void> _sendRpcFrame(
    Map<String, dynamic> frame,
    String requestId,
    String type,
  ) async {
    Object? failure;
    final sent = await _enqueueFrame(
      frame,
      onFailure: (error) => failure = error,
    );
    if (sent) return;
    final pending = _pending.remove(requestId);
    if (pending == null) return;
    pending.timer.cancel();
    if (!pending.completer.isCompleted) {
      pending.completer.completeError(
        failure ?? StateError('WS request could not be sent: $type'),
      );
    }
  }

  Future<void> _sendFrameNow(Map<String, dynamic> frame) async {
    final type = frame['type'] as String;
    var payload = (frame['payload'] as Map<String, dynamic>?) ?? {};
    if (onOutgoing != null) payload = await onOutgoing!(type, payload);
    final channel = _channel;
    if (channel == null) throw StateError('WS is not connected');
    channel.sink.add(jsonEncode({'type': type, 'payload': payload}));
  }

  void _flushQueue() {
    final queued = List<Map<String, dynamic>>.from(_queue);
    _queue.clear();
    for (final frame in queued) {
      final payload = (frame['payload'] as Map<String, dynamic>?) ?? const {};
      final requestId = payload['requestId'];
      if (requestId is String && _pending.containsKey(requestId)) {
        unawaited(
          _sendRpcFrame(
            frame,
            requestId,
            frame['type'] as String? ?? 'request',
          ),
        );
      } else {
        unawaited(sendFrame(frame));
      }
    }
  }

  void _onDone(WebSocketChannel channel) {
    if (!identical(_channel, channel)) return;
    _channel = null;
    _sub = null;
    _ready = false;
    _rejectPending('WS disconnected');
    if (_closing) {
      onStatus(ConnectionStatus.disconnected);
      return;
    }
    final code = channel.closeCode;
    if (isLocal) {
      if (code == 4404) {
        _closing = true;
        // needsLink first: AppNotifier's onStatus handler reads machine.needsLink
        // to decide whether a disconnect should be treated as the node going
        // offline — it has to see it flipped before onStatus runs, or the very
        // first 4404 for this machine reads as offline for one retry cycle.
        onLocalFailure?.call(code!, channel.closeReason ?? 'NO_PEER_LINK');
        onStatus(ConnectionStatus.disconnected);
        return;
      }
      _scheduleReconnect();
      return;
    }
    if (code == 4401) {
      unawaited(_refreshAndReconnect());
      return;
    }
    if (code == 4403) {
      _closing = true;
      onStatus(ConnectionStatus.disconnected);
      onAuthFailure('SSO environment does not match this backend');
      return;
    }
    _scheduleReconnect();
  }

  Future<void> _refreshAndReconnect() async {
    onStatus(ConnectionStatus.reconnecting);
    try {
      await accessTokenProvider(true, _tokenUsed);
      if (!_closing) await connect();
    } catch (_) {
      _closing = true;
      onStatus(ConnectionStatus.disconnected);
      onAuthFailure('Your SSO session expired. Please sign in again.');
    }
  }

  void _scheduleReconnect() {
    if (_closing) return;
    _attempt++;
    onStatus(ConnectionStatus.reconnecting);
    _reconnectTimer?.cancel();
    final exponent = min(max(_attempt - 1, 0), 5);
    final delay = Duration(milliseconds: min(30000, 1000 * (1 << exponent)));
    _reconnectTimer = Timer(delay, connect);
  }

  void _rejectPending(String reason) {
    for (final pending in _pending.values) {
      pending.timer.cancel();
      if (!pending.completer.isCompleted) {
        pending.completer.completeError(Exception(reason));
      }
    }
    _pending.clear();
    _queue.clear();
  }

  Future<void> close() async {
    _closing = true;
    _ready = false;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _rejectPending('WS closed');
    final sub = _sub;
    _sub = null;
    await sub?.cancel();
    final channel = _channel;
    _channel = null;
    await channel?.sink.close();
    onStatus(ConnectionStatus.disconnected);
  }

  /// Forces a fresh upstream relay dial for this machine — the transport itself can stay technically
  /// "connected" (ping/pong healthy) while the *application*-level session behind it is dead, e.g. the
  /// relayed machine's own Harness process restarted and dropped its in-memory E2EE session state; no
  /// close event ever fires for that, so nothing else would ever redial. Callers reach for this after
  /// observing a live RPC time out on an otherwise "connected" machine. Closes the local connection and
  /// immediately reconnects with a `forceReconnect` hint so the CLI daemon drops its cached relay entry
  /// instead of reusing it.
  Future<void> forceReconnect() async {
    if (_closing || isLocal == false) return;
    _forceRelayReconnect = true;
    _reconnectTimer?.cancel();
    _ready = false;
    _rejectPending('forcing relay reconnect');
    final sub = _sub;
    _sub = null;
    await sub?.cancel();
    final channel = _channel;
    _channel = null;
    if (channel != null) {
      try {
        await channel.sink.close();
      } catch (_) {
        /* already gone */
      }
    }
    _attempt = 0;
    await connect();
  }

  /// Drops only the live transport so integration tests can exercise the real
  /// reconnect path. Unlike [close], this deliberately leaves reconnect
  /// enabled and does not queue terminal input while the socket is down.
  @visibleForTesting
  Future<void> debugDropTransport() async {
    final channel = _channel;
    if (channel == null) throw StateError('WS transport is not connected');
    // 1012 is a server-only close code and Dart correctly rejects clients that
    // try to send it. Use the application/private range so this still drives
    // the real onDone -> reconnect path without pretending to be the server.
    await channel.sink.close(4000, 'integration test transport drop');
  }

  static String _newRequestId() {
    final random = Random.secure();
    final bytes = List<int>.generate(16, (_) => random.nextInt(256));
    return 'dsk_${bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join()}';
  }
}

class _PendingRpc {
  final Completer<Map<String, dynamic>> completer;
  final Timer timer;
  _PendingRpc(this.completer, this.timer);
}
