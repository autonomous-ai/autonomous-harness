import 'dart:async';

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show createApp, MemoryStore;

class _PendingConnection extends WsConn {
  _PendingConnection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final reply = Completer<Map<String, dynamic>>();
  final calls = <String>[];
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    calls.add(type);
    return reply.future;
  }

  void complete() => reply.complete({
    'agent': {'id': 'created', 'name': 'Created', 'engine': 'claude'},
  });
}

class _DelayedStore extends MemoryStore {
  String? blockedKey;
  final entered = Completer<void>();
  final answer = Completer<String?>();
  bool failWrites = false;
  @override
  Future<String?> read(String key) {
    if (key != blockedKey) return super.read(key);
    if (!entered.isCompleted) entered.complete();
    return answer.future;
  }

  @override
  Future<void> write(String key, String value) async {
    if (failWrites) throw StateError('Fixture disk unavailable');
    await super.write(key, value);
  }
}

void main() {
  for (final change in ['switch', 'close', 'dispose']) {
    test(
      'an agent launch stays with its destination after $change during the RPC',
      () async {
        final connection = _PendingConnection();
        final app = createApp(connectionForTest: (_) => connection);
        final destination = app.activeSwarm;
        final launch = app.createAgent('m', engine: 'claude', folder: '/work');
        expect(connection.calls, ['agent_create']);
        app.newSwarm();
        if (change == 'close') await app.closeSwarm(destination.id);
        if (change == 'dispose') app.dispose();
        connection.complete();
        expect(await launch, isNull);
        expect(app.panes, isEmpty);
        expect(
          destination.panes.map((p) => p.agentId),
          change == 'switch' ? ['created'] : isEmpty,
        );
        expect(connection.calls, isNot(contains('agent_delete')));
        if (change != 'dispose') app.dispose();
      },
    );
  }

  for (final key in ['terminal_pane_presets', 'terminal_pane_layout']) {
    for (final change in ['rename', 'dispose']) {
      test(
        'legacy $key restore cannot overwrite a $change during the read',
        () async {
          final store = _DelayedStore()..blockedKey = key;
          final app = createApp(store: store);
          final restore = app.restorePaneLayoutForTest();
          await store.entered.future;
          if (change == 'rename') app.renameSwarm(app.activeSwarmId, 'Chosen');
          if (change == 'dispose') app.dispose();
          store.answer.complete(
            key == 'terminal_pane_presets'
                ? '{"2":"rows"}'
                : jsonEncode([
                    {'machineId': 'm', 'agentId': 'a0'},
                  ]),
          );
          await restore;
          expect(app.panes, isEmpty);
          expect(app.panePresets, isEmpty);
          if (change == 'rename') {
            expect(app.activeSwarm.name, 'Chosen');
            app.dispose();
          }
        },
      );
    }
  }

  test(
    'adding while saved projects load preserves old and concurrent additions',
    () async {
      final storage = _DelayedStore()..blockedKey = 'swarm_projects_v1';
      final store = SwarmProjectStore(storage: storage);
      final load = store.load();
      final addA = store.add(
        const SavedSwarmProject(machineId: 'm', path: '/a', name: 'A'),
      );
      final addB = store.add(
        const SavedSwarmProject(machineId: 'm', path: '/b', name: 'B'),
      );
      storage.answer.complete(
        '[{"machineId":"m","path":"/saved","name":"Saved"}]',
      );
      await load;
      expect(await addA, isTrue);
      expect(await addB, isTrue);
      expect(store.projects.map((p) => p.path), ['/saved', '/a', '/b']);
      final saved = jsonDecode(storage.values['swarm_projects_v1']!) as List;
      expect(saved.map((p) => p['path']), ['/saved', '/a', '/b']);
      store.dispose();
    },
  );

  test(
    'a project write failure is visible and does not claim it was saved',
    () async {
      final storage = _DelayedStore()..failWrites = true;
      final store = SwarmProjectStore(storage: storage);
      const project = SavedSwarmProject(machineId: 'm', path: '/a', name: 'A');
      expect(await store.add(project), isFalse);
      expect(store.projects, isEmpty);
      expect(store.error, contains('Could not save'));
      storage.failWrites = false;
      expect(await store.add(project), isTrue);
      expect(store.projects.single, same(project));
      expect(store.error, isNull);
      store.dispose();
    },
  );
}
