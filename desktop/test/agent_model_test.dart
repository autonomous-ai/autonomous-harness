import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';

void main() {
  _dshTests();
  test('uses explicit terminal availability from a new CLI', () {
    final dormantPane = Agent.fromJson({
      'id': 'agent-1',
      'name': 'Agent',
      'status': 'offline',
      'terminal': {
        'available': true,
        'runtimes': [
          {'backend': 'tmux', 'paneId': '%1'},
        ],
      },
    });
    final stalePane = Agent.fromJson({
      'id': 'agent-2',
      'name': 'Stale',
      'terminal': {
        'available': false,
        'runtimes': [
          {'backend': 'tmux', 'paneId': '%2'},
        ],
      },
    });

    expect(dormantPane.terminalAvailable, isTrue);
    expect(stalePane.terminalAvailable, isFalse);
  });

  test('falls back to tmux runtime presence for an older CLI', () {
    final agent = Agent.fromJson({
      'id': 'agent-1',
      'name': 'Legacy',
      'terminal': {
        'runtimes': [
          {'backend': 'tmux', 'paneId': '%1'},
        ],
      },
    });

    expect(agent.terminalAvailable, isTrue);
    expect(agent.launchState, 'ready');
  });

  test('parses a sanitized asynchronous launch failure', () {
    final agent = Agent.fromJson({
      'id': 'agent-1',
      'name': 'Failed agent',
      'launch': {
        'state': 'failed',
        'error': 'ENGINE_DID_NOT_START',
        'detail': 'Engine exited\nsee terminal',
      },
    });

    expect(agent.launchState, 'failed');
    expect(agent.launchError, 'ENGINE_DID_NOT_START');
    expect(agent.launchDetail, 'Engine exited see terminal');
  });
}

// ── domain-specific harness fields ────────────────────────────────────────────

void _dshTests() {
  test('parses the harness, viewer and verdict off an agent frame', () {
    final agent = Agent.fromJson({
      'id': 'agent-1',
      'name': 'Board',
      'engine': 'claude',
      'dsh': 'autonomous/autonomous-circuit',
      'dshName': 'Autonomous Circuit',
      'viewerUrl': 'http://127.0.0.1:4179/?workspace=1',
      'verdict': {
        'ready': false,
        'summary': '2 errors, 1 warning',
        'errors': 2,
        'warnings': 1,
        'artifact': 'boards/main.board.json',
        'updatedAt': '2026-09-14T20:00:00Z',
      },
    });
    expect(agent.engine, 'claude');
    expect(agent.dsh, 'autonomous/autonomous-circuit');
    expect(agent.dshName, 'Autonomous Circuit');
    expect(agent.identityEngine, 'autonomous/autonomous-circuit');
    expect(agent.identityDisplayName, 'Autonomous Circuit');
    expect(agent.viewerUrl, 'http://127.0.0.1:4179/?workspace=1');
    final verdict = agent.verdict!;
    expect(verdict.ready, isFalse);
    expect(verdict.summary, '2 errors, 1 warning');
    expect(verdict.errors, 2);
    expect(verdict.warnings, 1);
    expect(verdict.artifact, 'boards/main.board.json');
    expect(verdict.updatedAt, DateTime.utc(2026, 9, 14, 20));
    expect(agent.copyWith(name: 'Renamed').verdict, verdict);
    expect(agent.copyWith(name: 'Renamed').dsh, 'autonomous/autonomous-circuit');
  });

  test('a plain engine agent has none of them and draws as its engine', () {
    final agent = Agent.fromJson({
      'id': 'agent-1',
      'name': 'a',
      'engine': 'codex',
    });
    expect(agent.dsh, isNull);
    expect(agent.viewerUrl, isNull);
    expect(agent.verdict, isNull);
    expect(agent.identityEngine, 'codex');
  });

  test(
    'refuses a harness id, viewer URL or verdict outside the spec shape',
    () {
      Agent parse(Map<String, dynamic> extra) =>
          Agent.fromJson({'id': 'agent-1', 'name': 'a', ...extra});
      // The id is owner/name; a bare word, a deeper path, or an upper-case one is not.
      expect(parse({'dsh': 'circuit'}).dsh, isNull);
      expect(parse({'dsh': 'a/b/c'}).dsh, isNull);
      expect(parse({'dsh': 'Autonomous/Circuit'}).dsh, isNull);
      expect(parse({'dsh': 'autonomous/../etc'}).dsh, isNull);
      // The viewer URL lands in a webview: http(s) with a host, no whitespace, no control bytes.
      expect(parse({'viewerUrl': 'file:///etc/passwd'}).viewerUrl, isNull);
      expect(parse({'viewerUrl': 'javascript:alert(1)'}).viewerUrl, isNull);
      expect(
        parse({'viewerUrl': 'http://127.0.0.1:4179/a b'}).viewerUrl,
        isNull,
      );
      expect(parse({'viewerUrl': 'http://\n127.0.0.1/'}).viewerUrl, isNull);
      expect(
        parse({'viewerUrl': 'https://viewer.local/x'}).viewerUrl,
        'https://viewer.local/x',
      );
      // A verdict without the one required fact is no verdict; counts never go negative or absurd.
      expect(
        parse({
          'verdict': {'summary': 'x'},
        }).verdict,
        isNull,
      );
      expect(parse({'verdict': 'ready'}).verdict, isNull);
      final odd = parse({
        'verdict': {
          'ready': true,
          'errors': -3,
          'warnings': 1e9,
          'summary': 'ok\u0000\u0001',
        },
      }).verdict!;
      expect(odd.errors, 0);
      expect(odd.warnings, 9999);
      expect(odd.summary, 'ok');
      expect(odd.updatedAt, isNull);
    },
  );
}
