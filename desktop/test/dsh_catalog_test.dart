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
  test('update versions are optional, validated, and offered only for installed clones', () {
    final old = DshEntry.fromJson(_circuit)!;
    expect(old.installedCommit, isNull);
    expect(old.hasUpdate, isFalse);
    final version = {
      ..._circuit,
      'installed': true,
      'installedCommit': 'a' * 40,
      'availableCommit': 'b' * 40,
      'updateAvailable': true,
    };
    final entry = DshEntry.fromJson(version)!;
    expect(entry.installedCommit, 'a' * 40);
    expect(entry.availableCommit, 'b' * 40);
    expect(entry.hasUpdate, isTrue);
    expect(DshEntry.fromJson({...version, 'linked': true})!.hasUpdate, isFalse);
    expect(
      DshEntry.fromJson({...version, 'installed': false})!.hasUpdate,
      isFalse,
    );
    expect(
      DshEntry.fromJson({...version, 'updateAvailable': 'yes'})!.hasUpdate,
      isFalse,
    );
    expect(
      DshEntry.fromJson({...version, 'installedCommit': 'main'})!
          .installedCommit,
      isNull,
    );
    expect(
      DshEntry.fromJson({...version, 'availableCommit': 123})!.availableCommit,
      isNull,
    );
  });

  test(
    'updates use their own request and refresh the installed version',
    () async {
      final connection = _Connection();
      final app = createApp(connectionForTest: (_) => connection);
      addTearDown(app.dispose);
      connection.answer = (type, payload) async => type == 'dsh_update'
          ? {'ok': true}
          : {
              'dsh': [
                {
                  ..._circuit,
                  'installed': true,
                  'installedCommit': 'b' * 40,
                  'updateAvailable': false,
                },
              ],
            };
      expect(await app.updateDsh('m', _circuit['id']! as String), isNull);
      expect(connection.calls.map((call) => call.$1), [
        'dsh_update',
        'dsh_list',
      ]);
      expect(
        app.stateOf('m')!.dsh[_circuit['id']! as String]!.installedCommit,
        'b' * 40,
      );
    },
  );
  for (final (response, message) in <(Object, String)>[
    ({'ok': false, 'detail': 'miss compiler'}, 'miss compiler'),
    ({'ok': false}, 'Update failed on Test host'),
    (
      const WsRequestFailure(responseType: 'dsh_update', code: 'UNSUPPORTED'),
      'Update the harness CLI on Test host to update harnesses',
    ),
    (
      const WsRequestFailure(
        responseType: 'dsh_update',
        code: 'UNSUPPORTED_ON_REMOTE',
      ),
      'Update the harness CLI on Test host to update harnesses',
    ),
    (
      const WsRequestFailure(
        responseType: 'dsh_update',
        code: 'DSH_BUSY',
        detail: 'Another update is running',
      ),
      'Another update is running',
    ),
    (
      const WsRequestFailure(responseType: 'dsh_update', code: 'INTERNAL'),
      'Update failed on Test host (INTERNAL)',
    ),
    (
      const WsRequestTimeout('dsh_update'),
      'Test host is still updating. Try again in a few minutes.',
    ),
    (StateError('disconnected'), 'Update failed on Test host'),
  ]) {
    test(
      'update failure $response preserves installed versions and allows retry',
      () async {
        final connection = _Connection()
          ..answer = (_, _) async {
            if (response is Map<String, dynamic>) return response;
            throw response;
          };
        final app = createApp(connectionForTest: (_) => connection);
        addTearDown(app.dispose);
        final entry = DshEntry.fromJson({
          ..._circuit,
          'installed': true,
          'installedCommit': 'a' * 40,
          'availableCommit': 'b' * 40,
          'updateAvailable': true,
        })!;
        final catalog = app.stateOf('m')!.dsh..replace([entry]);
        expect(await app.updateDsh('m', entry.id), message);
        expect(catalog[entry.id], same(entry));
        expect(catalog[entry.id]!.hasUpdate, isTrue);
        expect(catalog.runs[entry.id]!.failed, isTrue);
        expect(connection.calls.map((call) => call.$1), ['dsh_update']);

        final failedRun = catalog.runs[entry.id];
        connection.answer = (type, _) async => type == 'dsh_update'
            ? {'ok': true}
            : {
                'dsh': [
                  {..._circuit, 'installed': true, 'installedCommit': 'b' * 40},
                ],
              };
        expect(await app.updateDsh('m', entry.id), isNull);
        expect(catalog.runs[entry.id], isNot(same(failedRun)));
        expect(catalog[entry.id]!.installedCommit, 'b' * 40);
        expect(catalog[entry.id]!.hasUpdate, isFalse);
      },
    );
  }
  test('updating a removed machine sends no request', () async {
    final connection = _Connection();
    final app = createApp(connectionForTest: (_) => connection);
    addTearDown(app.dispose);
    expect(await app.updateDsh('removed', 'acme/thing'), 'Machine not found');
    expect(connection.calls, isEmpty);
  });
  _authorAndKindTests();
  _productPageTests();
  _installRunTests();
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

void _productPageTests() {
  test('the product page reads only web links, and trims what it shows', () {
    final long = 'x' * 400;
    final entry = DshEntry.fromJson({
      'id': 'autonomous/marp',
      'engine': 'claude',
      'name': '  ${'M' * 50}  ',
      'description': '  $long  ',
      'category': ' ${'c' * 30} ',
      'author': 'a' * 100,
      'license': '  ${'L' * 60}  ',
      'tagline': '  ${'T' * 100}  ',
      'repo': ' https://github.com/autonomous-ai/autonomous-marp ',
      'homepage': 'http://marp.app',
      'upstream': 'file:///etc/passwd',
      'screenshots': [
        'https://example.com/1.png',
        'javascript:alert(1)',
        'mailto:someone@example.com',
        '//example.com/no-scheme.png',
        'https://example.com/${'p' * 2100}.png',
        42,
        for (var i = 2; i <= 10; i++) 'https://example.com/$i.png',
      ],
      'linked': true,
      'tier': 12,
    })!;
    expect(entry.name, 'M' * 40);
    expect(entry.description, 'x' * 300);
    expect(entry.category, 'c' * 24);
    expect(entry.author, 'a' * 80);
    expect(entry.license, 'L' * 40);
    expect(entry.tagline, 'T' * 80);
    expect(entry.repo, 'https://github.com/autonomous-ai/autonomous-marp');
    expect(entry.homepage, 'http://marp.app');
    expect(entry.upstream, isNull, reason: 'never a file: link');
    expect(entry.screenshots, [
      'https://example.com/1.png',
      for (var i = 2; i <= 8; i++) 'https://example.com/$i.png',
    ]);
    expect(entry.linked, isTrue);
    expect(entry.tier, 0, reason: 'a tier out of range is none');

    final bare = DshEntry.fromJson({
      'id': 'autonomous/marp',
      'engine': 'claude',
      'license': '   ',
      'tagline': 7,
      'screenshots': 'https://example.com/1.png',
      'repo': 7,
    })!;
    expect(bare.license, isNull);
    expect(bare.tagline, isNull);
    expect(bare.screenshots, isEmpty);
    expect(bare.repo, isNull);
    expect(bare.linked, isFalse);
    expect(
      DshEntry.fromJson({'id': 'a/b', 'engine': 'e' * 65}),
      isNull,
      reason: 'an engine id past 64 characters is not one',
    );
  });
}

void _installRunTests() {
  test('every phase reads as a sentence', () {
    String label(String phase, [String? detail]) =>
        DshInstallProgress(id: 'a/b', phase: phase, detail: detail).label;
    expect(label('clone'), 'Fetching…');
    expect(label('doctor'), 'Checking the machine…');
    expect(label('done'), 'Installed');
    expect(label('failed'), 'Install failed');
    expect(label('failed', ''), 'Install failed');
    expect(label('failed', 'no space left'), 'no space left');
    expect(label('queued'), 'Installing…');
    final done = DshInstallProgress.fromJson({'id': 'a/b', 'phase': 'done'})!;
    expect(done.done, isTrue);
    expect(done.inProgress, isFalse);
  });

  test('a push is read defensively: ids, phases, and lines without control characters', () {
    expect(DshInstallProgress.fromJson(null), isNull);
    expect(DshInstallProgress.fromJson({'id': '', 'phase': 'setup'}), isNull);
    expect(DshInstallProgress.fromJson({'id': 'a/b', 'phase': ''}), isNull);
    expect(DshInstallProgress.fromJson({'id': 1, 'phase': 'setup'}), isNull);
    final escape = String.fromCharCode(27);
    final bell = String.fromCharCode(7);
    final push = DshInstallProgress.fromJson({
      'id': 'a/b',
      'phase': 'setup',
      'detail': '   ',
      'line': '$escape[32madded$bell ${'n' * 300}',
    })!;
    expect(push.detail, isNull);
    expect(push.line, hasLength(200));
    expect(push.line, startsWith('[32madded  n'));
    expect(
      DshInstallProgress.fromJson({'id': 'a/b', 'phase': 'setup', 'line': 3})!
          .line,
      isNull,
    );
  });

  test(
    'a run keeps its phases in order, a bounded log, and how long each took',
    () {
      final t0 = DateTime(2026, 9, 1, 9);
      final run = DshInstallRun('a/b', startedAt: t0);
      expect(run.phase, 'clone', reason: 'nothing heard yet is the fetch');
      expect(run.inProgress, isTrue);
      expect(run.took('clone'), isNull);
      run.apply(
        const DshInstallProgress(
          id: 'a/b',
          phase: 'clone',
          detail: 'Resolving',
        ),
        now: t0,
      );
      run.apply(
        const DshInstallProgress(id: 'a/b', phase: 'clone', line: 'cloned'),
        now: t0.add(const Duration(seconds: 2)),
      );
      // The same line again is not a new line.
      run.apply(
        const DshInstallProgress(id: 'a/b', phase: 'clone', line: 'cloned'),
        now: t0.add(const Duration(seconds: 3)),
      );
      run.apply(
        const DshInstallProgress(id: 'a/b', phase: 'setup'),
        now: t0.add(const Duration(seconds: 9)),
      );
      expect(run.phases.map((p) => p.phase), ['clone', 'setup']);
      expect(
        run.detail,
        'Resolving',
        reason: 'a push without detail keeps the last',
      );
      expect(run.log, ['cloned']);
      expect(run.took('clone'), const Duration(seconds: 9));
      expect(run.took('setup'), isNull, reason: 'still under way');
      expect(run.took('doctor'), isNull, reason: 'never began');
      expect(run.reached('setup'), isTrue);
      expect(run.reached('doctor'), isFalse);

      for (var i = 0; i < DshInstallRun.maxLog + 5; i++) {
        run.apply(
          DshInstallProgress(
            id: 'a/b',
            phase: 'doctor',
            line: i.isEven ? 'ok tool$i' : 'step $i',
          ),
        );
      }
      expect(run.log, hasLength(DshInstallRun.maxLog));
      expect(run.log.first, 'step 5');
      expect(run.checks, everyElement(startsWith('ok ')));
      expect(run.checks, hasLength(20));
    },
  );

  test('a push after a finished run is a new attempt with its own clock', () {
    final catalog = MachineDsh();
    final t0 = DateTime(2026, 9, 1, 9);
    catalog.applyInstall(
      const DshInstallProgress(id: 'a/b', phase: 'setup'),
      now: t0,
    );
    final first = catalog.runs['a/b']!;
    expect(
      first.startedAt,
      t0,
      reason: 'another window started it; it is watched all the same',
    );
    catalog.applyInstall(
      const DshInstallProgress(
        id: 'a/b',
        phase: 'failed',
        detail: 'no space left',
      ),
      now: t0.add(const Duration(minutes: 1)),
    );
    expect(identical(catalog.runs['a/b'], first), isTrue);
    expect(catalog.installs['a/b']!.failed, isTrue);
    catalog.applyInstall(
      const DshInstallProgress(id: 'a/b', phase: 'clone'),
      now: t0.add(const Duration(minutes: 5)),
    );
    expect(identical(catalog.runs['a/b'], first), isFalse);
    expect(catalog.runs['a/b']!.phase, 'clone');
    expect(catalog.installs['a/b']!.inProgress, isTrue);

    catalog.error = 'UNSUPPORTED';
    catalog.replace(const [
      DshEntry(id: 'a/b', name: 'B', engine: 'claude'),
      DshEntry(id: 'a/c', name: 'C', engine: 'codex'),
    ]);
    expect(catalog.loaded, isTrue);
    expect(catalog.error, isNull, reason: 'an answer clears the refusal');
    expect(catalog.entries.map((e) => e.id), ['a/b', 'a/c']);
    expect(catalog['a/c']!.engine, 'codex');
    expect(catalog['a/z'], isNull);
  });
}
