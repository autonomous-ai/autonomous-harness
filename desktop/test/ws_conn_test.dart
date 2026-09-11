import 'dart:convert';
import 'dart:io';

import 'package:harness/ws/ws_conn.dart';
import 'package:harness/ws/ws_pool.dart';
import 'package:flutter_test/flutter_test.dart';

class FakeHub {
  final HttpServer server;
  final bool rejectOldToken;
  final int? closeCodeOnSelect;
  final List<Map<String, dynamic>> frames = [];
  final List<String> protocols = [];
  final List<String?> environments = [];
  final Map<String, int> machineSelected = {};

  FakeHub._(this.server, this.rejectOldToken, this.closeCodeOnSelect);
  int get port => server.port;

  static Future<FakeHub> start({
    bool rejectOldToken = false,
    int? closeCodeOnSelect,
  }) async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final hub = FakeHub._(server, rejectOldToken, closeCodeOnSelect);
    server.listen((request) async {
      if (!WebSocketTransformer.isUpgradeRequest(request)) {
        request.response.statusCode = 404;
        await request.response.close();
        return;
      }
      final protocol = request.headers.value('sec-websocket-protocol') ?? '';
      hub.protocols.add(protocol);
      hub.environments.add(request.uri.queryParameters['autonomousEnv']);
      final ws = await WebSocketTransformer.upgrade(
        request,
        protocolSelector: (protocols) =>
            protocols.isNotEmpty ? protocols.first : null,
      );
      ws.listen((data) {
        final frame = jsonDecode(data as String) as Map<String, dynamic>;
        hub.frames.add(frame);
        if (frame['type'] == 'machine_select') {
          final machineId = (frame['payload'] as Map)['machineId'] as String;
          if (hub.closeCodeOnSelect != null) {
            ws.close(hub.closeCodeOnSelect!, 'rejected');
            return;
          }
          if (hub.rejectOldToken && protocol == 'tok-old') {
            ws.close(4401, 'auth expired');
            return;
          }
          hub.machineSelected[machineId] =
              (hub.machineSelected[machineId] ?? 0) + 1;
          ws.add(
            jsonEncode({
              'type': 'connected',
              'payload': {'machineId': machineId},
            }),
          );
        } else if (frame['type'] == 'agent_create') {
          // A REFUSAL — the shape every CLI-side "no" arrives in: a `<type>_result` frame carrying
          // an error code, never a returned map with an `error` key. See WsRequestFailure.
          ws.add(
            jsonEncode({
              'type': 'agent_create_result',
              'payload': {
                'requestId': (frame['payload'] as Map)['requestId'],
                'error': 'UNSUPPORTED_ON_REMOTE',
                'detail': 'this machine cannot create agents',
              },
            }),
          );
        } else if (frame['type'] == 'agents_list') {
          ws.add(
            jsonEncode({
              'type': 'agents_list_result',
              'payload': {
                'requestId': (frame['payload'] as Map)['requestId'],
                'agents': [
                  {'id': 'a1', 'name': 'Agent A', 'status': 'active'},
                ],
              },
            }),
          );
        }
      });
    });
    return hub;
  }

  Future<void> close() => server.close(force: true);
}

void main() {
  late FakeHub hub;
  WsConn? conn;

  tearDown(() async {
    await conn?.close();
    await hub.close();
  });

  test(
    'uses SSO subprotocol, environment, readiness, and machine_select',
    () async {
      hub = await FakeHub.start();
      conn = WsConn(
        wsBaseUrl: 'ws://127.0.0.1:${hub.port}',
        autonomousEnv: 'prod',
        machineId: 'm1',
        accessTokenProvider: (_, _) async => 'access-token',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
      await conn!.connect();
      final result = await conn!.request('agents_list');
      expect(hub.protocols, ['access-token']);
      expect(hub.environments, ['prod']);
      expect(hub.machineSelected['m1'], 1);
      expect((result['agents'] as List).first['id'], 'a1');
    },
  );

  // The regression this guards: `AppNotifier.createAgent` used to map the CLI's refusal codes to
  // sentences in a branch reading `result['error']` — on a reply that had already thrown, so the
  // branch could never run and the user got the wire code instead of the sentence. The code has to
  // survive the throw for that call site to have anything to map.
  test('a refusal reply throws WsRequestFailure carrying the code', () async {
    hub = await FakeHub.start();
    conn = WsConn(
      wsBaseUrl: 'ws://127.0.0.1:${hub.port}',
      autonomousEnv: 'prod',
      machineId: 'm1',
      accessTokenProvider: (_, _) async => 'access-token',
      onAuthFailure: (_) {},
      onEvent: (_) {},
      onStatus: (_) {},
    );
    await conn!.connect();
    await expectLater(
      conn!.request('agent_create', payload: {'engine': 'codex'}),
      throwsA(
        isA<WsRequestFailure>()
            .having((f) => f.code, 'code', 'UNSUPPORTED_ON_REMOTE')
            .having(
              (f) => f.detail,
              'detail',
              'this machine cannot create agents',
            )
            .having(
              (f) => f.responseType,
              'responseType',
              'agent_create_result',
            ),
      ),
    );
  });

  test(
    'local transport sends no credential and skips SSO environment',
    () async {
      hub = await FakeHub.start();
      var tokenProviderCalls = 0;
      conn = WsConn(
        wsBaseUrl: 'wss://unused.example',
        autonomousEnv: 'prod',
        machineId: 'm1',
        accessTokenProvider: (_, _) async {
          tokenProviderCalls++;
          return 'sso-token';
        },
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
        transportKind: WsTransportKind.localPlaintext,
        localWsUri: Uri.parse('ws://127.0.0.1:${hub.port}/api/local-ws'),
      );
      await conn!.connect();
      final result = await conn!.request('agents_list');
      expect(tokenProviderCalls, 0);
      expect(hub.protocols, ['']);
      expect(hub.environments.single, isNull);
      final select = hub.frames.firstWhere(
        (frame) => frame['type'] == 'machine_select',
      );
      expect((select['payload'] as Map)['localProtocolVersion'], 1);
      expect((result['agents'] as List).first['id'], 'a1');
    },
  );

  test('forceReconnect() sends forceReconnect:true on the next machine_select, only for local transport', () async {
    hub = await FakeHub.start();
    conn = WsConn(
      wsBaseUrl: 'wss://unused.example',
      autonomousEnv: 'prod',
      machineId: 'm1',
      accessTokenProvider: (_, _) async => 'sso-token',
      onAuthFailure: (_) {},
      onEvent: (_) {},
      onStatus: (_) {},
      transportKind: WsTransportKind.localPlaintext,
      localWsUri: Uri.parse('ws://127.0.0.1:${hub.port}/api/local-ws'),
    );
    await conn!.connect();
    await Future<void>.delayed(const Duration(milliseconds: 100));
    final selects = hub.frames
        .where((frame) => frame['type'] == 'machine_select')
        .toList();
    expect(selects, hasLength(1));
    expect(
      (selects.first['payload'] as Map).containsKey('forceReconnect'),
      isFalse,
    );

    await conn!.forceReconnect();
    await Future<void>.delayed(const Duration(milliseconds: 200));
    final selectsAfter = hub.frames
        .where((frame) => frame['type'] == 'machine_select')
        .toList();
    expect(selectsAfter, hasLength(2));
    expect((selectsAfter[1]['payload'] as Map)['forceReconnect'], isTrue);
    expect(conn!.isReady, isTrue);
  });

  test('blocked encrypted RPC fails immediately and is never sent', () async {
    hub = await FakeHub.start();
    conn = WsConn(
      wsBaseUrl: 'ws://127.0.0.1:${hub.port}',
      autonomousEnv: 'prod',
      machineId: 'm1',
      accessTokenProvider: (_, _) async => 'access-token',
      onAuthFailure: (_) {},
      onEvent: (_) {},
      onStatus: (_) {},
    );
    conn!.onOutgoing = (type, payload) async {
      if (type == 'agents_list') throw StateError('E2EE is not ready');
      return payload;
    };
    await conn!.connect();
    await Future<void>.delayed(const Duration(milliseconds: 100));

    await expectLater(
      conn!.request('agents_list', timeout: const Duration(seconds: 5)),
      throwsA(isA<StateError>()),
    );
    expect(
      hub.frames.where((frame) => frame['type'] == 'agents_list'),
      isEmpty,
    );
  });

  test('4403 stops reconnecting and reports an environment mismatch', () async {
    hub = await FakeHub.start(closeCodeOnSelect: 4403);
    final failures = <String>[];
    conn = WsConn(
      wsBaseUrl: 'ws://127.0.0.1:${hub.port}',
      autonomousEnv: 'prod',
      machineId: 'm1',
      accessTokenProvider: (_, _) async => 'access-token',
      onAuthFailure: failures.add,
      onEvent: (_) {},
      onStatus: (_) {},
    );
    await conn!.connect();
    await Future<void>.delayed(const Duration(milliseconds: 250));
    expect(hub.protocols, hasLength(1));
    expect(failures.single, contains('environment'));
  });

  // AppNotifier's onStatus handler reads machine.needsLink to decide whether a
  // disconnect should be treated as the node going offline — it only sees the
  // right value if onLocalFailure (which sets needsLink) has already run.
  test('4404 reports onLocalFailure before onStatus(disconnected)', () async {
    hub = await FakeHub.start(closeCodeOnSelect: 4404);
    final calls = <String>[];
    conn = WsConn(
      wsBaseUrl: 'wss://unused.example',
      autonomousEnv: 'prod',
      machineId: 'm1',
      accessTokenProvider: (_, _) async => 'sso-token',
      onAuthFailure: (_) {},
      onLocalFailure: (code, reason) => calls.add('onLocalFailure'),
      onEvent: (_) {},
      onStatus: (status) => calls.add('onStatus:$status'),
      transportKind: WsTransportKind.localPlaintext,
      localWsUri: Uri.parse('ws://127.0.0.1:${hub.port}/api/local-ws'),
    );
    await conn!.connect();
    await Future<void>.delayed(const Duration(milliseconds: 250));
    expect(
      calls,
      containsAllInOrder([
        'onLocalFailure',
        'onStatus:ConnectionStatus.disconnected',
      ]),
    );
    expect(conn!.isClosed, isTrue);
  });

  test(
    '4401 refreshes once and reconnects with the new access token',
    () async {
      hub = await FakeHub.start(rejectOldToken: true);
      var token = 'tok-old';
      var refreshes = 0;
      conn = WsConn(
        wsBaseUrl: 'ws://127.0.0.1:${hub.port}',
        autonomousEnv: 'prod',
        machineId: 'm1',
        accessTokenProvider: (force, _) async {
          if (force) {
            refreshes++;
            token = 'tok-new';
          }
          return token;
        },
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
      await conn!.connect();
      await Future<void>.delayed(const Duration(milliseconds: 400));
      expect(refreshes, 1);
      expect(hub.protocols, containsAllInOrder(['tok-old', 'tok-new']));
      expect(hub.machineSelected['m1'], 1);
    },
  );

  test(
    'debug transport drop uses a client-valid code and reconnects',
    () async {
      hub = await FakeHub.start();
      conn = WsConn(
        wsBaseUrl: 'ws://127.0.0.1:${hub.port}',
        autonomousEnv: 'prod',
        machineId: 'm1',
        accessTokenProvider: (_, _) async => 'access-token',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
      await conn!.connect();
      await Future<void>.delayed(const Duration(milliseconds: 100));
      expect(conn!.isReady, isTrue);

      await conn!.debugDropTransport();
      await Future<void>.delayed(const Duration(milliseconds: 1300));

      expect(hub.machineSelected['m1'], 2);
      expect(conn!.isReady, isTrue);
    },
  );

  test(
    'WsPool keeps one SSO connection per machine and closes independently',
    () async {
      hub = await FakeHub.start();
      final pool = WsPool(
        wsBaseUrl: 'ws://127.0.0.1:${hub.port}',
        autonomousEnv: 'prod',
        accessTokenProvider: (_, _) async => 'access-token',
        onAuthFailure: (_) {},
        onEvent: (_, _) {},
        onStatus: (_, _) {},
      );
      final c1a = pool.connFor('m1');
      final c1b = pool.connFor('m1');
      final c2 = pool.connFor('m2');
      expect(identical(c1a, c1b), isTrue);
      expect(identical(c1a, c2), isFalse);
      await Future<void>.delayed(const Duration(milliseconds: 300));
      expect(hub.machineSelected['m1'], 1);
      expect(hub.machineSelected['m2'], 1);
      await pool.closeMachine('m1');
      expect(pool.has('m1'), isFalse);
      expect(pool.has('m2'), isTrue);
      await pool.closeAll();
    },
  );
}
