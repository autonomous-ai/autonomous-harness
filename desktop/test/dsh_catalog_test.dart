// The per-machine harness catalog: what `dsh_list` says a machine has or could
// install, and how an install the dialog asked for is narrated back.
import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show createApp;

class _Connection extends WsConn {
  _Connection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final calls = <(String, Map<String, dynamic>)>[];
  Future<Map<String, dynamic>> Function(String type, Map<String, dynamic>)?
  answer;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) {
    calls.add((type, Map.of(payload)));
    return answer?.call(type, payload) ?? Future.value({});
  }
}

const _circuit = {
  'id': 'autonomous/autonomous-circuit',
  'name': 'Autonomous Circuit',
  'description': 'Chat with AI → a board you can order',
  'engine': 'claude',
  'installed': false,
  'viewer': true,
  'tier': 2,
};

void main() {
  _authorAndKindTests();
  test('shared viewer dependencies are optional and validated', () {
    expect(
      DshEntry.fromJson({..._circuit, 'viewerUse': 'autonomous/cad-viewer'})!
          .viewerUse,
      'autonomous/cad-viewer',
    );
    expect(DshEntry.fromJson(_circuit)!.viewerUse, isNull);
    expect(
      DshEntry.fromJson({..._circuit, 'viewerUse': '../viewer'})!.viewerUse,
      isNull,
    );
  });
  test('an entry is read off the wire and refuses ids outside owner/name', () {
    final entry = DshEntry.fromJson(_circuit)!;
    expect(entry.id, 'autonomous/autonomous-circuit');
    expect(entry.name, 'Autonomous Circuit');
    expect(entry.engine, 'claude');
    expect(entry.installed, isFalse);
    expect(entry.viewer, isTrue);
    expect(entry.tier, 2);
    // A name the machine left out falls back to the id's own name half.
    expect(
      DshEntry.fromJson({'id': 'someone/robot-arm', 'engine': 'codex'})!.name,
      'robot-arm',
    );
    expect(DshEntry.fromJson({'id': 'circuit', 'engine': 'claude'}), isNull);
    expect(DshEntry.fromJson({'id': 'a/b', 'engine': ''}), isNull);
    expect(DshEntry.fromJson('autonomous/autonomous-circuit'), isNull);
  });

  test(
    'install progress reads as a sentence, and a failure keeps its detail',
    () {
      expect(
        DshInstallProgress.fromJson({'id': 'a/b', 'phase': 'setup'})!.label,
        'Setting up the toolchain…',
      );
      final failed = DshInstallProgress.fromJson({
        'id': 'a/b',
        'phase': 'failed',
        'detail': 'kicad-cli\u0000 not found',
      })!;
      expect(failed.failed, isTrue);
      expect(failed.inProgress, isFalse);
      expect(failed.label, 'kicad-cli  not found');
      expect(DshInstallProgress.fromJson({'id': 'a/b'}), isNull);
    },
  );

  test(
    'probeDsh records the answer, and an older CLI leaves it unknown',
    () async {
      final connection = _Connection();
      final app = createApp(connectionForTest: (_) => connection);
      addTearDown(app.dispose);
      connection.answer = (type, _) async => {
        'dsh': [
          _circuit,
          'junk',
          {'id': 'bad', 'engine': 'claude'},
        ],
      };
      await app.probeDsh('m');
      final catalog = app.stateOf('m')!.dsh;
      expect(catalog.loaded, isTrue);
      expect(catalog.error, isNull);
      expect(catalog.entries.map((e) => e.id), [
        'autonomous/autonomous-circuit',
      ]);
      expect(connection.calls.map((c) => c.$1), ['dsh_list']);
      // A second ask is answered from memory unless forced.
      await app.probeDsh('m');
      expect(connection.calls.length, 1);
      await app.probeDsh('m', force: true);
      expect(connection.calls.length, 2);

      final older = _Connection()
        ..answer = (_, _) => Future.error(
          const WsRequestFailure(responseType: 'dsh_list', code: 'UNSUPPORTED'),
        );
      final legacy = createApp(connectionForTest: (_) => older);
      addTearDown(legacy.dispose);
      await legacy.probeDsh('m');
      expect(legacy.stateOf('m')!.dsh.loaded, isFalse);
      expect(legacy.stateOf('m')!.dsh.error, 'UNSUPPORTED');
    },
  );

  test(
    'installDsh narrates its phases and re-asks the catalog when done',
    () async {
      final connection = _Connection();
      final app = createApp(connectionForTest: (_) => connection);
      addTearDown(app.dispose);
      final install = Completer<Map<String, dynamic>>();
      connection.answer = (type, _) => type == 'dsh_install'
          ? install.future
          : Future.value({
              'dsh': [
                {..._circuit, 'installed': true},
              ],
            });
      final result = app.installDsh('m', 'autonomous/autonomous-circuit');
      final catalog = app.stateOf('m')!.dsh;
      expect(catalog.installs['autonomous/autonomous-circuit']!.phase, 'clone');
      await app.handleEventForTest('m', {
        'type': 'dsh_install_status',
        'payload': {'id': 'autonomous/autonomous-circuit', 'phase': 'setup'},
      });
      expect(
        catalog.installs['autonomous/autonomous-circuit']!.label,
        'Setting up the toolchain…',
      );
      install.complete({'ok': true});
      expect(await result, isNull);
      expect(catalog.installs['autonomous/autonomous-circuit']!.done, isTrue);
      expect(catalog['autonomous/autonomous-circuit']!.installed, isTrue);
      expect(connection.calls.map((c) => c.$1), ['dsh_install', 'dsh_list']);
      expect(connection.calls.first.$2, {
        'id': 'autonomous/autonomous-circuit',
      });
    },
  );

  test('a refused install says so and stays retryable', () async {
    final connection = _Connection()
      ..answer = (type, _) => Future.error(
        const WsRequestFailure(
          responseType: 'dsh_install',
          code: 'UNSUPPORTED',
        ),
      );
    final app = createApp(connectionForTest: (_) => connection);
    addTearDown(app.dispose);
    final error = await app.installDsh('m', 'autonomous/autonomous-circuit');
    expect(error, 'Update the harness CLI on Test host to install harnesses');
    expect(
      app.stateOf('m')!.dsh.installs['autonomous/autonomous-circuit']!.failed,
      isTrue,
    );
  });
}

void _authorAndKindTests() {
  test('a row carries who made it, and a viewer package needs no engine', () {
    final agent = DshEntry.fromJson({
      'id': 'autonomous/text-to-cad',
      'name': 'text-to-cad',
      'category': 'CAD',
      'author': '  Jake Fitzgerald  ',
      'engine': 'claude',
      'installed': true,
      'viewer': true,
      'tier': 2,
    });
    expect(agent, isNotNull);
    expect(agent!.author, 'Jake Fitzgerald');
    expect(agent.isViewerPackage, isFalse);
    final viewer = DshEntry.fromJson({
      'id': 'autonomous/cad-viewer',
      'kind': 'viewer',
      'name': 'CAD Viewer',
      'installed': true,
      'viewer': true,
      'tier': 2,
    });
    expect(viewer, isNotNull);
    expect(viewer!.isViewerPackage, isTrue);
    expect(viewer.engine, '');
    // an agent row without an engine is still refused
    expect(DshEntry.fromJson({'id': 'a/b', 'name': 'B'}), isNull);
  });
}
