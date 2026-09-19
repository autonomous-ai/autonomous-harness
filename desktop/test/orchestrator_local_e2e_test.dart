import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/ws/ws_conn.dart';

void main() {
  final cli = Platform.environment['HARNESS_ORCHESTRATOR_CLI_ROOT'];
  test(
    'real local socket, background tmux specialists, live viewers, handoffs and reconnect',
    () async {
      if (cli == null) return;
      final fixture = await Process.start(
        'node',
        ['--import', 'tsx', 'scripts/orchestrator-e2e-peer.ts'],
        workingDirectory: cli,
        environment: {'HARNESS_ORCHESTRATOR_E2E': '1'},
      );
      final errors = StringBuffer();
      fixture.stderr.transform(utf8.decoder).listen(errors.write);
      final ready = Completer<Map<String, dynamic>>();
      fixture.stdout
          .transform(utf8.decoder)
          .transform(const LineSplitter())
          .listen(
            (line) {
              try {
                final value = jsonDecode(line);
                if (value is Map<String, dynamic> &&
                    value.containsKey('port') &&
                    !ready.isCompleted) {
                  ready.complete(value);
                }
              } catch (_) {
                /* daemon diagnostics */
              }
            },
            onDone: () {
              if (!ready.isCompleted) {
                ready.completeError(StateError('Fixture exited: $errors'));
              }
            },
          );
      addTearDown(() async {
        await fixture.stdin.close();
        await fixture.exitCode.timeout(
          const Duration(seconds: 30),
          onTimeout: () {
            fixture.kill();
            return -1;
          },
        );
      });
      final config = await ready.future.timeout(const Duration(seconds: 40));
      WsConn? connection;
      Future<void> connect() async {
        connection = WsConn(
          wsBaseUrl: 'ws://unused.invalid',
          autonomousEnv: 'prod',
          machineId: config['machineId'] as String,
          transportKind: WsTransportKind.localPlaintext,
          localWsUri: Uri.parse(
            'ws://127.0.0.1:${config['port']}/api/local-ws',
          ),
          accessTokenProvider: (_, _) async => 'unused',
          onAuthFailure: (_) {},
          onEvent: (_) {},
          onStatus: (_) {},
        );
        await connection!.connect();
        await connection!.waitUntilReady(timeout: const Duration(seconds: 10));
      }

      addTearDown(() async => connection?.close());
      Future<Map<String, dynamic>> ask(Map<String, dynamic> payload) =>
          connection!.request(
            'orchestrator',
            payload: payload,
            timeout: const Duration(seconds: 30),
          );
      Future<Map<String, dynamic>> until(
        String id,
        bool Function(Map<String, dynamic>) matches,
      ) async {
        final deadline = DateTime.now().add(const Duration(seconds: 90));
        Map<String, dynamic> last = {};
        while (DateTime.now().isBefore(deadline)) {
          last =
              (await ask({'action': 'status', 'id': id}))['project']
                  as Map<String, dynamic>;
          if (matches(last)) return last;
          await Future<void>.delayed(const Duration(milliseconds: 200));
        }
        fail('Project timed out: ${jsonEncode(last)}\n$errors');
      }

      await connect();
      const id = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
      final start = {
        'action': 'start',
        'id': id,
        'prompt': 'Make a shape, research its story, build a scene, and create a film',
        'engine': 'claude',
        'cwd': config['workspace'],
        'parallelism': 2,
      };
      await ask(start);
      await ask(start);
      final working = await until(
        id,
        (p) =>
            (p['tasks'] as List).where((t) => t['state'] == 'running').length >=
            2,
      );
      expect(working['directorId'], isNotNull);
      await ask({
        'action': 'message',
        'id': id,
        'messageId': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'text': 'Keep the lighting warm',
      });
      await connection!.close();
      await connect();
      final done = await until(id, (p) => p['state'] == 'completed');
      expect(
        (done['tasks'] as List).map((t) => t['state']),
        everyElement('succeeded'),
      );
      final film = (done['tasks'] as List).singleWhere(
        (t) => t['id'] == 'film',
      );
      expect(
        await File('${film['cwd']}/deliverable.txt').readAsString(),
        allOf(
          contains('shape fixture'),
          contains('research fixture'),
          contains('scene fixture'),
        ),
      );
      expect(film['inputs'], {'scene': 1});
      expect(
        (done['messages'] as List).any(
          (m) => (m['text'] as String).contains(
            'Received your direction: Keep the lighting warm',
          ),
        ),
        isTrue,
      );
      final http = HttpClient();
      addTearDown(http.close);
      final withViews = await until(
        id,
        (p) =>
            (p['tasks'] as List)
                .where((t) => t['runtime']?['viewerUrl'] != null)
                .length ==
            3,
      );
      for (final task in (withViews['tasks'] as List).where(
        (t) => t['runtime']?['viewerUrl'] != null,
      )) {
        final response = await (await http.getUrl(
          Uri.parse(task['runtime']['viewerUrl'] as String),
        )).close();
        expect(
          await response.transform(utf8.decoder).join(),
          contains('Verified ${task['id']} fixture'),
        );
      }
      final stats = jsonDecode(
        await (await (await http.getUrl(
          Uri.parse('http://127.0.0.1:${config['port']}/fixture-stats'),
        )).close()).transform(utf8.decoder).join(),
      ) as Map;
      expect(
        stats['created'],
        5,
        reason: 'One director and four specialists, despite duplicate start and reconnect.',
      );
      const cancelled = 'dddddddddddddddddddddddddddddddd';
      await ask({...start, 'id': cancelled});
      await until(
        cancelled,
        (p) => (p['tasks'] as List).any((t) => t['state'] == 'running'),
      );
      await ask({'action': 'cancel', 'id': cancelled});
      final stopped = await until(cancelled, (p) => p['state'] == 'cancelled');
      expect(
        (stopped['tasks'] as List).every((t) => t['state'] != 'running'),
        isTrue,
      );
      expect(
        (await ask({'action': 'status', 'id': id}))['project']['state'],
        'completed',
      );
    },
    skip: cli == null
        ? 'Set HARNESS_ORCHESTRATOR_CLI_ROOT to the isolated CLI checkout.'
        : false,
    timeout: const Timeout(Duration(minutes: 4)),
  );
}
