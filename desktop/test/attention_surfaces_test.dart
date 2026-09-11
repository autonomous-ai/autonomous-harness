// Where a blocked agent may and may NOT show itself.
//
// The rail deliberately says nothing: its badge means "a turn is running", and
// that is the only thing it is for. An agent waiting on an answer is a fact
// about the TILE you are looking at, so the tile rings itself and the list
// stays quiet. These pin that split, because the tempting change is to let the
// rail speak too.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pending_question.dart';
import 'package:harness/widgets/machine_rail.dart';

const _machine = Machine(
  machineId: 'm1',
  authMode: MachineAuthMode.remote,
  name: 'prod-mac',
  status: 'online',
);

Agent _agent(String id, String name) => Agent.fromJson({
  'id': id,
  'sessionId': 'session-$id',
  'name': name,
  'engine': 'claude',
  'status': 'active',
  'terminal': {'available': true},
});

AppNotifier notifierWithAgents(List<Agent> agents) {
  final notifier = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
  );
  final state = MachineState(_machine)
    ..connectionStatus = ConnectionStatus.connected
    ..terminalCapabilityLoaded = true
    ..terminalCapabilityAvailable = true
    ..agentLoadStatus = AgentLoadStatus.loaded
    ..agents = agents;
  notifier.machines = [_machine];
  notifier.machineStates[_machine.machineId] = state;
  notifier.expandedMachines.add(_machine.machineId);
  return notifier;
}

PendingQuestion question({String agentId = 'a1'}) => PendingQuestion(
  machineId: 'm1',
  agentId: agentId,
  requestId: 'q_1',
  answerKey: 'Which colour theme do you want?',
  prompt: 'Which colour theme do you want?',
  options: const ['Blue', 'Red'],
  multi: false,
  since: DateTime.now(),
);

Future<void> pumpRail(WidgetTester tester, AppNotifier notifier) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SizedBox(width: 320, child: MachineRail(notifier: notifier)),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  testWidgets('a blocked agent keeps the rail exactly as it was', (
    tester,
  ) async {
    final notifier = notifierWithAgents([_agent('a1', 'payments')]);
    final state = notifier.machineStates['m1']!;
    state.processingAgentIds.add('a1');
    // Both are true at once — the turn stays open while the dialog waits — and
    // the row shows only the one it has always shown.
    state.blockedAgents['a1'] = question();

    await pumpRail(tester, notifier);

    expect(
      find.byKey(const ValueKey('agent-processing-indicator')),
      findsOneWidget,
      reason: 'the spinner is the rail badge, blocked or not',
    );
    expect(
      find.text('Which colour theme do you want?'),
      findsNothing,
      reason: 'the question belongs to the tile, not to the list',
    );
  });

  testWidgets('and an idle blocked agent adds no mark either', (tester) async {
    final notifier = notifierWithAgents([_agent('a1', 'payments')]);
    notifier.machineStates['m1']!.blockedAgents['a1'] = question();

    await pumpRail(tester, notifier);

    expect(find.text('payments'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('agent-processing-indicator')),
      findsNothing,
    );
  });

  test('the tile can see what the rail will not', () {
    // The one reader. If this goes, nothing draws the ring and the whole
    // question path becomes dead weight.
    final notifier = notifierWithAgents([_agent('a1', 'payments')]);
    notifier.machineStates['m1']!.blockedAgents['a1'] = question();
    expect(notifier.questionFor('m1', 'a1'), isNotNull);
    expect(notifier.questionFor('m1', 'nobody'), isNull);
    expect(notifier.questionFor('nowhere', 'a1'), isNull);
  });
}
