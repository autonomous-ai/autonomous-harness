import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';

void main() {
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
