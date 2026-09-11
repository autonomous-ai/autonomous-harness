import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:harness/core/models.dart';
import 'package:harness/ws/ws_conn.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('async encrypt/send and decrypt/dispatch remain FIFO', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final socketReady = Completer<WebSocket>();
    final received = <Map<String, dynamic>>[];
    unawaited(
      server.forEach((request) async {
        final socket = await WebSocketTransformer.upgrade(request);
        if (!socketReady.isCompleted) socketReady.complete(socket);
        socket.listen((raw) {
          final frame = jsonDecode(raw as String) as Map<String, dynamic>;
          received.add(frame);
          if (frame['type'] == 'machine_select') {
            socket.add(
              jsonEncode({
                'type': 'connected',
                'payload': {'machineId': 'machine-1'},
              }),
            );
          }
        });
      }),
    );

    final connected = Completer<void>();
    final dispatched = <int>[];
    final e2eeControls = <String>[];
    final conn = WsConn(
      wsBaseUrl: 'ws://127.0.0.1:${server.port}',
      autonomousEnv: 'prod',
      machineId: 'machine-1',
      accessTokenProvider: (_, _) async => 'test-token',
      onAuthFailure: (_) {},
      onStatus: (status) {
        if (status == ConnectionStatus.connected && !connected.isCompleted) {
          connected.complete();
        }
      },
      onEvent: (event) {
        if (event['type'] == 'terminal_output') {
          dispatched.add(
            (event['payload'] as Map<String, dynamic>)['seq'] as int,
          );
        }
      },
    );
    conn.onOutgoing = (type, payload) async {
      if (type == 'terminal_input' && payload['inputSeq'] == 0) {
        await Future<void>.delayed(const Duration(milliseconds: 30));
      }
      return payload;
    };
    conn.onE2eeFrame = (frame) async {
      if (frame['type'] == 'e2e_welcome') {
        e2eeControls.add('e2e_welcome');
        return null;
      }
      final envelope = frame['payload'] as Map<String, dynamic>;
      final seq = (envelope['__e2e'] as Map<String, dynamic>)['seq'] as int;
      if (seq == 0) {
        await Future<void>.delayed(const Duration(milliseconds: 30));
      }
      return {
        'type': 'terminal_output',
        'payload': {'streamId': 'stream-1', 'seq': seq},
      };
    };

    await conn.connect();
    await connected.future.timeout(const Duration(seconds: 2));
    final serverSocket = await socketReady.future;

    serverSocket.add(
      jsonEncode({
        'type': 'e2e_welcome',
        'payload': {'ephPub': 'opaque-handshake'},
      }),
    );
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(e2eeControls, ['e2e_welcome']);

    final first = conn.sendTerminalFrame('terminal_input', {
      'streamId': 'stream-1',
      'inputSeq': 0,
      'data': 'YQ==',
    });
    final second = conn.sendTerminalFrame('terminal_input', {
      'streamId': 'stream-1',
      'inputSeq': 1,
      'data': 'Yg==',
    });
    expect(await Future.wait([first, second]), [true, true]);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    final terminalInput = received
        .where((frame) => frame['type'] == 'terminal_input')
        .toList();
    expect(
      terminalInput.map(
        (frame) => (frame['payload'] as Map<String, dynamic>)['inputSeq'],
      ),
      [0, 1],
    );

    serverSocket.add(
      jsonEncode({
        'type': 'terminal_output',
        'payload': {
          '__e2e': {'seq': 0},
        },
      }),
    );
    serverSocket.add(
      jsonEncode({
        'type': 'terminal_output',
        'payload': {
          '__e2e': {'seq': 1},
        },
      }),
    );
    await Future<void>.delayed(const Duration(milliseconds: 80));
    expect(dispatched, [0, 1]);

    await conn.close();
    await server.close(force: true);
  });

  test(
    'terminal frames fail closed instead of entering reconnect queue',
    () async {
      final conn = WsConn(
        wsBaseUrl: 'ws://127.0.0.1:1',
        autonomousEnv: 'prod',
        machineId: 'machine-1',
        accessTokenProvider: (_, _) async => 'test-token',
        onAuthFailure: (_) {},
        onStatus: (_) {},
        onEvent: (_) {},
      );
      expect(
        await conn.sendTerminalFrame('terminal_input', {
          'streamId': 'stream-1',
          'inputSeq': 0,
          'data': 'YQ==',
        }),
        isFalse,
      );
      await conn.close();
    },
  );
}
