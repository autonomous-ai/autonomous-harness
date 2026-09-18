import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/agent_index.dart';
import 'package:harness_mobile/phone/phone_status.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

import 'agent_pager_fixture.dart';

/// The phone's socket to the relay drops every time the app is backgrounded. That is the phone's
/// line going, not the machine — and the screen must read it that way.
void main() {
  test('a viewer keeps the machine online and its agents on screen', () async {
    final app = pagerApp(PagerConn(), viewer: true);
    addTearDown(app.dispose);
    final session = await liveAgent(app, 'b');

    app.connectionStatusForTest('m', ConnectionStatus.reconnecting);

    final machine = app.stateOf('m')!;
    expect(machine.nodeOnline, isTrue, reason: 'not "Offline"');
    expect(phoneMachineStatusOf(machine), PhoneMachineStatus.connecting);
    expect(
      agentIndex(app),
      hasLength(pagerAgentIds.length),
      reason: 'the pager is built from this list',
    );
    // Its stream went with the socket, and is put back once the socket is.
    expect(session.status, TerminalSessionStatus.error);
    expect(machine.pendingOfflineAgentId, 'b');
  });

  test('a desktop still reads its CLI socket dropping as offline', () async {
    final app = pagerApp(PagerConn());
    addTearDown(app.dispose);
    await liveAgent(app, 'b');

    app.connectionStatusForTest('m', ConnectionStatus.reconnecting);

    expect(app.stateOf('m')!.nodeOnline, isFalse);
  });

  test('a machine that has never answered lists nothing yet', () {
    final app = pagerApp(PagerConn(), viewer: true);
    addTearDown(app.dispose);
    app.stateOf('m')!
      ..connectionStatus = ConnectionStatus.connecting
      ..agentLoadStatus = AgentLoadStatus.idle;

    expect(agentIndex(app), isEmpty);
  });
}
