import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../logging/app_log.dart';
import '../logging/redact.dart';
import '../core/models.dart';
import 'relay_codec.dart';
import 'terminal_transport_plugin.dart';

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
  final String? observerShareId;
  final int localProtocolVersion;

  /// A flat delay between reconnect attempts instead of the exponential backoff (1s→30s). Set for
  /// the socket to THIS computer's daemon: a refused connect on the loopback costs microseconds and
  /// nothing on the wire, and the daemon comes back within a second or two of a restart or an
  /// update handoff — waiting up to 30s to notice is what made a local terminal sit on
  /// "reconnecting" long after the daemon was up. Null keeps the backoff, which the relayed
  /// machines need: every one of their selects has the daemon dial the backend (15s handshake).
  final Duration? fixedReconnectDelay;

  /// A viewer build's end-to-end session with the machine, minted fresh on every connect — the
  /// role the harness CLI plays everywhere else (see [RelayCodec]). Null leaves the relay's frames
  /// as they are, which is right for the local transport and the dev fixture.
  final RelayCodecFactory? relayCodecs;

  /// A second wire beside the relay socket (a viewer's WebRTC data channel to the
  /// machine), built per connect once the codec exists. Null — the desktop, the
  /// local transport, the dev fixture — means every frame rides the socket.
  final TerminalTransportPluginFactory? transportPlugins;

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
  RelayCodec? _codec;
  TerminalTransportPlugin? _plugin;
  StreamSubscription? _sub;
  bool _closing = false;
  bool _connecting = false;
  bool _ready = false;
  int _attempt = 0;
  Timer? _reconnectTimer;
  String? _tokenUsed;
  bool _forceRelayReconnect = false;
  final _pending = <String, _PendingRpc>{};
  final _readinessWaiters = <Completer<void>>{};
  final _queue = <Map<String, dynamic>>[];
  Future<void> _outboundTail = Future<void>.value();
  Future<void> _inboundTail = Future<void>.value();

  bool get isReady => _ready && _channel != null;

  /// Wait for this machine's handshake without queuing a request or changing
  /// its timeout. Callers can then start independent RPCs with their own budgets.
  Future<void> waitUntilReady({required Duration timeout}) {
    if (isReady) return Future<void>.value();
    if (_closing) return Future<void>.error(StateError('WS closed'));
    final ready = Completer<void>();
    _readinessWaiters.add(ready);
    return ready.future
        .timeout(
          timeout,
          onTimeout: () => throw const WsRequestTimeout('machine_select'),
        )
        .whenComplete(() => _readinessWaiters.remove(ready));
  }

  void _settleReadiness([String? failure]) {
    final waiters = _readinessWaiters.toList();
    _readinessWaiters.clear();
    for (final waiter in waiters) {
      if (failure == null) {
        waiter.complete();
      } else {
        waiter.completeError(StateError(failure));
      }
    }
  }

  /// True once this connection has permanently given up (a deliberate [close], or a non-retryable
  /// local failure like NO_PEER_LINK) — [WsPool] must not hand a closed connection back out.
  bool get isClosed => _closing;
  bool get isLocal => transportKind == WsTransportKind.localPlaintext;

  /// Must produce exactly what WsPool.connFor computes as its desired key — the pool reuses a
  /// socket only when the two agree, and closes it otherwise. A key that could never match churned
  /// every socket on every `_conn()` call (measured: `agents_list` failing "WS closed" in a loop).
  String get endpointKey => isLocal
      ? 'local:${localWsUri.toString()}:${fixedReconnectDelay?.inMilliseconds ?? 'backoff'}'
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
    this.observerShareId,
    this.localProtocolVersion = 1,
    this.fixedReconnectDelay,
    this.relayCodecs,
    this.transportPlugins,
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
      final codecs = isLocal ? null : relayCodecs;
      if (codecs != null) {
        final codec = await codecs(machineId);
        if (_closing) return;
        if (codec == null) {
          _refusePeer('NO_PEER_LINK');
          return;
        }
        _codec = codec;
        // A dial that failed past this point left one behind; this connect owns a new one.
        _disposePlugin();
        final plugins = transportPlugins;
        if (plugins != null) _plugin = plugins(_PluginHost(this), machineId);
      }
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
          if (observerShareId != null) 'shareId': observerShareId,
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
    final codec = _codec;
    if (raw is List<int>) {
      final bytes = Uint8List.fromList(raw);
      _inboundTail = _inboundTail
          .then((_) async {
            final local = codec == null ? bytes : codec.decodeBinary(bytes);
            if (local == null) return;
            await _plugin?.observeWsBinary(local);
            await onBinaryFrame?.call(local);
          })
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
    if (codec != null) {
      _inboundTail = _inboundTail
          .then((_) => _onRelayFrame(codec, message))
          .catchError((_) {
            // Keep the FIFO alive: a frame that will not open is dropped, never dispatched.
          });
      return;
    }
    final type = message['type'] as String? ?? '';
    final payload = (message['payload'] as Map<String, dynamic>?) ?? {};

    if (type == 'connected') {
      if (payload['machineId'] == machineId) _markReady();
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

  void _markReady() {
    _ready = true;
    _attempt = 0;
    onStatus(ConnectionStatus.connected);
    _flushQueue();
    _settleReadiness();
  }

  /// A frame on a relay connection whose E2EE session this app holds: relayClient.ts's dial
  /// handshake, then open-and-dispatch. Nothing is ready — and nothing queued goes out — until the
  /// machine's welcome proves it holds the identity this device pinned for it.
  Future<void> _onRelayFrame(
    RelayCodec codec,
    Map<String, dynamic> message,
  ) async {
    final payload = (message['payload'] as Map<String, dynamic>?) ?? {};
    switch (message['type']) {
      case 'connected':
        // The socket's first `connected` answers the socket itself (it names the user, not a
        // machine); only the select's own ack starts the handshake.
        if (payload['machineId'] == machineId) {
          // The policy rides the ack; the plugin must have it before the welcome
          // that decides whether to act on it.
          _plugin?.onConnectedAck(payload);
          _channel?.sink.add(jsonEncode(codec.helloFrame()));
        }
        return;
      case 'e2e_welcome':
        if (await codec.handleWelcome(payload)) {
          _markReady();
          _plugin?.onSessionReady();
        } else {
          _refusePeer('E2EE_WELCOME_INVALID');
        }
        return;
      case 'e2e_denied':
        _refusePeer('E2E_DENIED');
        return;
      case 'e2e_rekey':
        codec.handleRekey(payload);
        return;
    }
    final clear = codec.decodeFrame(message);
    if (clear == null) return;
    final plain = <String, dynamic>{
      ...clear,
      'payload': (clear['payload'] as Map<String, dynamic>?) ?? {},
    };
    final plugin = _plugin;
    final type = plain['type'];
    if (plugin != null && type is String && plugin.consumesInbound(type)) {
      await plugin.handleInbound(
        type,
        plain['payload'] as Map<String, dynamic>,
      );
      return;
    }
    await _dispatch(plain);
    // After, not before: for `terminal_ready` the session learns its streamId from
    // the frame itself, and anything the plugin derives from it (its own
    // `terminal_link_mode`) must land once that has happened.
    await _plugin?.observeWsFrame(plain);
  }

  /// The machine is reachable but this device may not talk to it: never linked, the link revoked
  /// on its side, or a welcome that did not prove the pinned identity. No retry can fix any of the
  /// three — only a link can — so this stops and says so the way the CLI's own relay does, with
  /// 4404.
  void _refusePeer(String reason) {
    _closing = true;
    _ready = false;
    _disposePlugin();
    // needsLink first: AppNotifier's onStatus handler reads machine.needsLink to decide whether a
    // disconnect should be treated as the node going offline — it has to see it flipped before
    // onStatus runs, or the very first 4404 for this machine reads as offline for one retry cycle.
    onLocalFailure?.call(4404, reason);
    onStatus(ConnectionStatus.disconnected);
    unawaited(_channel?.sink.close());
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
    'project_preview',
    'project_preview_result',
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
  Future<bool> sendTerminalFrame(
    String type,
    Map<String, dynamic> payload,
  ) async {
    // Outside the FIFO on purpose: the plugin may wait a bounded while for its wire
    // before an open, and that wait must not hold up other panes' input.
    var openViaPlugin = false;
    final plugin = _plugin;
    final requestId = payload['requestId'];
    // Not worth the wait when the frame cannot go anyway.
    if (plugin != null &&
        isReady &&
        type == 'terminal_open' &&
        requestId is String) {
      openViaPlugin = await plugin.prepareOpen(requestId);
    }
    return _enqueueFrame(
      {'type': type, 'payload': payload},
      requireReady: true,
      openViaPlugin: openViaPlugin,
    );
  }

  Future<bool> sendTerminalBinary(Uint8List bytes) {
    final completer = Completer<bool>();
    _outboundTail = _outboundTail
        .then((_) async {
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
            // Sealed here, inside the outbound FIFO, so frames take their counters in send order.
            final codec = _codec;
            final wire = codec == null ? bytes : codec.encodeBinary(bytes);
            if (wire == null) {
              completer.complete(false);
              return;
            }
            final plugin = _plugin;
            if (plugin != null && await plugin.sendBinary(bytes, wire)) {
              completer.complete(true);
              return;
            }
            channel.sink.add(wire);
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
    bool openViaPlugin = false,
    TransportVia? force,
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
            await _sendFrameNow(
              frame,
              openViaPlugin: openViaPlugin,
              force: force,
            );
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

  Future<void> _sendFrameNow(
    Map<String, dynamic> frame, {
    bool openViaPlugin = false,
    TransportVia? force,
  }) async {
    final type = frame['type'] as String;
    var payload = (frame['payload'] as Map<String, dynamic>?) ?? {};
    if (onOutgoing != null) payload = await onOutgoing!(type, payload);
    final channel = _channel;
    if (channel == null) throw StateError('WS is not connected');
    final out = <String, dynamic>{'type': type, 'payload': payload};
    final codec = _codec;
    final wire = codec == null ? out : codec.encodeFrame(out);
    if (wire == null) throw StateError('E2EE session is not ready for $type');
    final encoded = jsonEncode(wire);
    // Sealed first, then offered: the counter is taken in send order whichever
    // wire ends up carrying the frame, which is what the peer's replay window needs.
    // Only once the session is up: nothing before that (the select, the hello) is
    // the plugin's to route.
    final plugin = _plugin;
    if (plugin != null &&
        _ready &&
        plugin.sendJson(
          type,
          payload,
          encoded,
          openViaPlugin: openViaPlugin,
          force: force,
        )) {
      return;
    }
    channel.sink.add(encoded);
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
    _codec = null;
    _disposePlugin();
    _ready = false;
    _rejectPending('WS disconnected');
    if (_closing) {
      onStatus(ConnectionStatus.disconnected);
      return;
    }
    final code = channel.closeCode;
    if (isLocal) {
      if (code == 4404 || (observerShareId != null && code == 4403)) {
        _closing = true;
        // needsLink first: AppNotifier's onStatus handler reads machine.needsLink
        // to decide whether a disconnect should be treated as the node going
        // offline — it has to see it flipped before onStatus runs, or the very
        // first 4404 for this machine reads as offline for one retry cycle.
        onLocalFailure?.call(code!, channel.closeReason ?? 'NO_PEER_LINK');
        onStatus(ConnectionStatus.disconnected);
        return;
      }
      if (code == 4403) {
        // The daemon does not serve the machine id this socket selected ("machine mismatch",
        // localWsServer.ts): it runs on another id now — a sign-out and sign-in gave the account a
        // new machine, or a first start with no backend left it on the computer id. Retrying the
        // same select every 30s used to be the whole response, silently and for good. Reported so
        // the app can look up which id the daemon does serve; the retry stays, in case the answer
        // is a re-key of this very row.
        onLocalFailure?.call(code!, channel.closeReason ?? 'machine mismatch');
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
    final delay =
        fixedReconnectDelay ??
        Duration(milliseconds: min(30000, 1000 * (1 << exponent)));
    _reconnectTimer = Timer(delay, connect);
  }

  void _rejectPending(String reason) {
    _settleReadiness(reason);
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
    _codec = null;
    _disposePlugin();
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _rejectPending('WS closed');
    final sub = _sub;
    _sub = null;
    await sub?.cancel();
    final channel = _channel;
    _channel = null;
    // Bounded: a channel whose connect was refused (the daemon down, a 1s retry in flight) has a
    // sink whose close never completes, and this used to wait on it for good — an app closing a
    // machine while its daemon was down hung right here.
    await channel?.sink.close().timeout(
      const Duration(seconds: 2),
      onTimeout: () => null,
    );
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
    // A viewer's relay connection holds that session itself, so for it this is simply a fresh dial
    // — and with it a fresh session.
    if (_closing || (!isLocal && relayCodecs == null)) return;
    _forceRelayReconnect = true;
    _reconnectTimer?.cancel();
    _ready = false;
    _codec = null;
    _disposePlugin();
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

  void _disposePlugin() {
    final plugin = _plugin;
    _plugin = null;
    plugin?.dispose();
  }

  static String _newRequestId() {
    final random = Random.secure();
    final bytes = List<int>.generate(16, (_) => random.nextInt(256));
    return 'dsk_${bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join()}';
  }
}

/// The connection as its plugin sees it — see [TerminalTransportHost].
class _PluginHost implements TerminalTransportHost {
  _PluginHost(this._conn);
  final WsConn _conn;

  @override
  RelayCodec get codec {
    final codec = _conn._codec;
    if (codec == null) throw StateError('relay session is gone');
    return codec;
  }

  @override
  Future<bool> send(Map<String, dynamic> frame, {TransportVia? force}) =>
      _conn._enqueueFrame(frame, requireReady: true, force: force);

  @override
  void enqueueInbound(Future<void> Function() task) {
    _conn._inboundTail = _conn._inboundTail.then((_) => task()).catchError((_) {
      // Keep the FIFO alive, as the socket's own handlers do.
    });
  }

  @override
  Future<void> dispatch(Map<String, dynamic> plain) => _conn._dispatch({
    ...plain,
    'payload': (plain['payload'] as Map<String, dynamic>?) ?? {},
  });

  @override
  Future<void> deliverBinary(Uint8List localFrame) async {
    await _conn.onBinaryFrame?.call(localFrame);
  }
}

class _PendingRpc {
  final Completer<Map<String, dynamic>> completer;
  final Timer timer;
  _PendingRpc(this.completer, this.timer);
}
