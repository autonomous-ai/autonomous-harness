import 'dart:async';

import 'dart:convert';
import 'dart:ui' show AppExitResponse;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/main.dart';
import 'package:harness/state/app_state.dart';
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

class _PendingWriteStore extends MemoryStore {
  final release = Completer<void>();
  final snapshots = <String>[];
  bool failFirst = false;
  @override
  Future<void> write(String key, String value) async {
    if (key == 'swarm_layout_v1') {
      snapshots.add(value);
      if (snapshots.length == 1) {
        await release.future;
        if (failFirst) throw StateError('Busy fixture disk');
      }
    }
    await super.write(key, value);
  }
}

void main() {
  for (final failFirst in [false, true]) {
    test(
      'rapid tab changes save only the final queued layout after ${failFirst ? 'a failed' : 'a slow'} write',
      () async {
        final storage = _PendingWriteStore()..failFirst = failFirst;
        final app = createApp(store: storage);
        addTearDown(app.dispose);
        app.newSwarm();
        for (var i = 0; i < 100; i++) {
          app.stepSwarm(1);
        }
        app.renameSwarm(app.activeSwarmId, 'Final arrangement');
        expect(storage.snapshots, hasLength(1));
        final saving = app.flushPaneLayout();
        storage.release.complete();
        await saving;
        expect(storage.snapshots, hasLength(2));
        final saved = jsonDecode(storage.values['swarm_layout_v1']!) as Map;
        expect(saved['activeId'], app.activeSwarmId);
        expect((saved['swarms'] as List).last['name'], 'Final arrangement');
        app.renameSwarm(app.activeSwarmId, 'After completion');
        await app.flushPaneLayout();
        expect(storage.snapshots, hasLength(3));
        expect(storage.snapshots.last, contains('After completion'));
      },
    );
  }

  for (final timedOut in [false, true]) {
    testWidgets(
      'quit ${timedOut ? 'stays available with a stalled disk' : 'waits for the latest saved arrangement'}',
      (tester) async {
        final storage = _PendingWriteStore();
        final app = createApp(store: storage)..status = AppStatus.authenticated;
        app.newSwarm();
        app.renameSwarm(app.activeSwarmId, 'Before quit');
        await tester.pumpWidget(
          ProviderScope(
            overrides: [appStateProvider.overrideWithValue(app)],
            child: const DesktopApp(),
          ),
        );
        await tester.pump();
        final observer =
            tester.state(find.byType(RootShell)) as WidgetsBindingObserver;
        var completed = false;
        final quitting = observer.didRequestAppExit().then((result) {
          completed = true;
          return result;
        });
        await tester.pump();
        expect(completed, isFalse);
        if (timedOut) {
          await tester.pump(const Duration(seconds: 1));
          expect(completed, isTrue);
        }
        storage.release.complete();
        await tester.pump();
        expect(await quitting, AppExitResponse.exit);
        await app.flushPaneLayout();
        expect(storage.values['swarm_layout_v1'], contains('Before quit'));
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      },
    );
  }

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
