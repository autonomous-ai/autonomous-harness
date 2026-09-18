import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../core/models.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/skeleton.dart';
import '../state/app_state.dart';
import '../state/terminal_pane.dart';
import '../terminal/terminal_binary.dart';
import '../terminal/terminal_session.dart';
import '../widgets/terminal_panel.dart';
import '../ws/ws_conn.dart';

class SharedHarnessPanel extends StatefulWidget {
  const SharedHarnessPanel({
    super.key,
    required this.notifier,
    required this.pane,
    required this.grant,
    required this.hasAccess,
    required this.visible,
    required this.onClose,
  });
  final AppNotifier notifier;
  final TerminalPane pane;
  final SharedHarness grant;
  final bool hasAccess, visible;
  final VoidCallback onClose;
  @override
  State<SharedHarnessPanel> createState() => _SharedHarnessPanelState();
}

class _SharedHarnessPanelState extends State<SharedHarnessPanel> {
  late WsConn _connection;
  late TerminalSession _terminal;
  ConnectionStatus _status = ConnectionStatus.connecting;
  String? _failure;
  String _viewerMessage = 'Waiting for the live viewer…';
  Uint8List? _image;
  bool _viewerSelected = false, _ended = false;
  int _generation = 0;
  @override
  void initState() {
    super.initState();
    _start();
  }

  void _start() {
    final generation = ++_generation;
    final uri = Uri.parse(widget.notifier.config.localCliBaseUrl)
        .replace(scheme: 'ws', path: '/api/local-ws');
    _terminal = TerminalSession(
      machineId: widget.pane.machineId,
      agentId: widget.grant.agentId,
      agentName: widget.grant.name,
      engineId: widget.grant.engine,
      readOnly: true,
      send: (type, payload) => _connection.sendTerminalFrame(type, payload),
      sendBinary: (_) async => false,
      onOpenStalled: () => _connection.forceReconnect(),
      resyncTimeout: const Duration(seconds: 15),
    );
    _connection = WsConn(
      wsBaseUrl: '',
      autonomousEnv: widget.notifier.config.autonomousEnv,
      machineId: widget.pane.machineId,
      observerShareId: widget.grant.id,
      transportKind: WsTransportKind.localPlaintext,
      localWsUri: uri,
      accessTokenProvider: (_, _) async => '',
      onAuthFailure: (reason) {
        if (generation == _generation) _end(reason);
      },
      onLocalFailure: (code, reason) {
        if (generation == _generation) _end(reason);
      },
      onEvent: (frame) async {
        if (generation != _generation) return;
        final type = frame['type'] as String,
            payload = Map<String, dynamic>.from(frame['payload'] as Map);
        if (type == 'observer_viewer') {
          if (!mounted || _ended) return;
          Uint8List? next;
          try {
            if (payload['data'] is String) {
              next = base64Decode(payload['data'] as String);
            }
          } on FormatException {
            return;
          }
          setState(() {
            if (next != null) _image = next;
            _viewerMessage =
                payload['message'] as String? ??
                (payload['state'] == 'live'
                    ? 'Live viewer'
                    : 'Opening the viewer…');
          });
        } else {
          await _terminal.handleFrame(type, payload);
        }
      },
      onStatus: (status) {
        if (!mounted || _ended || generation != _generation) return;
        setState(() {
          _status = status;
          _failure = null;
        });
        if (status == ConnectionStatus.connected) {
          unawaited(_terminal.reopen());
          unawaited(
            _connection.sendTerminalFrame('observer_viewer', {
              'agentId': widget.grant.agentId,
            }),
          );
        } else {
          _terminal.transportLost('Waiting for the owner to reconnect.');
        }
      },
    );
    _connection.onBinaryFrame = (bytes) async {
      if (generation != _generation) return;
      final frame = decodeTerminalLocal(bytes);
      if (frame != null && !_ended) await _terminal.handleBinary(frame);
    };
    if (widget.hasAccess) {
      unawaited(_connection.connect());
    } else {
      _ended = true;
      _failure = 'Access removed or invitation expired.';
    }
  }

  void _end(String reason) {
    if (!mounted || _ended) return;
    setState(() {
      _ended = true;
      _failure = reason;
      _image = null;
    });
    _terminal.transportLost(reason);
    unawaited(_connection.close());
  }

  @override
  void didUpdateWidget(SharedHarnessPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!widget.hasAccess && !_ended) {
      _end('Access removed or invitation expired.');
    } else if (widget.hasAccess &&
        (!oldWidget.hasAccess || widget.grant.id != oldWidget.grant.id)) {
      unawaited(_connection.close());
      _terminal.dispose();
      _ended = false;
      _failure = null;
      _image = null;
      _status = ConnectionStatus.connecting;
      _start();
    }
  }

  @override
  void dispose() {
    unawaited(_connection.close());
    _terminal.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final live = !_ended && _status == ConnectionStatus.connected;
    return Column(
      children: [
        Container(
          height: 44,
          padding: const EdgeInsets.only(left: 12, right: 4),
          color: grid.AppSurface.recess,
          child: Row(
            children: [
              const Icon(Icons.visibility_outlined, size: 16),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  widget.grant.name,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontWeight: FontWeight.w600,
                    fontSize: 13,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              const Text('View only', style: TextStyle(fontSize: 11)),
              const SizedBox(width: 12),
              Tooltip(
                message:
                    _failure ??
                    (live
                        ? 'Watching ${widget.pane.sharedOwnerName ?? 'the owner'}’s harness'
                        : 'Waiting for the owner’s machine. Reconnecting automatically.'),
                child: Text(
                  _ended
                      ? 'Sharing ended'
                      : live
                      ? 'Live'
                      : 'Reconnecting',
                  style: TextStyle(
                    fontSize: 11,
                    color: grid.AppPalette.textSecondary,
                  ),
                ),
              ),
              IconButton(
                tooltip: 'Close shared harness',
                onPressed: widget.onClose,
                icon: const Icon(Icons.close, size: 16),
              ),
            ],
          ),
        ),
        if (_failure != null)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(12),
            color: grid.AppSurface.recess,
            child: Text(_failure!, style: const TextStyle(fontSize: 12)),
          ),
        Expanded(
          child: LayoutBuilder(
            builder: (context, constraints) {
              Widget terminal() => TerminalPanel(
                notifier: widget.notifier,
                session: _terminal,
                focused: widget.notifier.isPaneFocused(widget.pane.id),
                visible: widget.visible,
                showHeader: false,
                readOnly: true,
                viewportSize: constraints.biggest,
              );
              Widget viewer() => ColoredBox(
                color: grid.AppPalette.windowBg,
                child: Center(
                  child: _image == null
                      ? Padding(
                          padding: const EdgeInsets.all(24),
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              if (!_ended)
                                const Skeleton(width: 220, height: 130),
                              const SizedBox(height: 14),
                              Text(
                                _viewerMessage,
                                textAlign: TextAlign.center,
                                style: TextStyle(
                                  fontSize: 12,
                                  color: grid.AppPalette.textSecondary,
                                ),
                              ),
                            ],
                          ),
                        )
                      : Image.memory(
                          _image!,
                          gaplessPlayback: true,
                          fit: BoxFit.contain,
                          semanticLabel:
                              'Live output from ${widget.grant.name}',
                          errorBuilder: (_, _, _) =>
                              const Text('Waiting for the next viewer frame.'),
                        ),
                ),
              );
              if (constraints.maxWidth >= 880) {
                return Row(
                  children: [
                    Expanded(flex: 5, child: terminal()),
                    VerticalDivider(width: 1, color: grid.AppPalette.textFaint),
                    Expanded(flex: 4, child: viewer()),
                  ],
                );
              }
              return Column(
                children: [
                  Row(
                    children: [
                      TextButton(
                        onPressed: () =>
                            setState(() => _viewerSelected = false),
                        child: Text(
                          'Terminal',
                          style: TextStyle(
                            fontWeight: !_viewerSelected
                                ? FontWeight.w600
                                : FontWeight.normal,
                          ),
                        ),
                      ),
                      TextButton(
                        onPressed: () => setState(() => _viewerSelected = true),
                        child: Text(
                          'Viewer',
                          style: TextStyle(
                            fontWeight: _viewerSelected
                                ? FontWeight.w600
                                : FontWeight.normal,
                          ),
                        ),
                      ),
                      const Spacer(),
                      Flexible(
                        child: Text(
                          widget.pane.sharedOwnerName ?? 'Shared harness',
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 11),
                        ),
                      ),
                      const SizedBox(width: 12),
                    ],
                  ),
                  Expanded(
                    child: IndexedStack(
                      index: _viewerSelected ? 1 : 0,
                      children: [terminal(), viewer()],
                    ),
                  ),
                ],
              );
            },
          ),
        ),
      ],
    );
  }
}
