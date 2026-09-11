import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/harness_join_guide_screen.dart';

void main() {
  const machine = Machine(
    machineId: 'machine-offline',
    apiKey: '',
    authMode: MachineAuthMode.remote,
    name: 'offline-mac',
    status: 'offline',
  );

  MachineState stateFor({required bool isLocal}) {
    final state = MachineState(machine)
      ..localOnly = isLocal
      ..nodeOnline = false
      ..pendingOfflineAgentId = 'agent-1'
      ..agents = [
        Agent.fromJson({
          'id': 'agent-1',
          'name': 'claude-session',
          'engine': 'claude',
          'terminal': {
            'runtimes': [
              {'backend': 'tmux', 'paneId': '%1'},
            ],
          },
        }),
      ];
    return state;
  }

  testWidgets('renders a harness start command for this computer', (
    tester,
  ) async {
    final notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    final state = stateFor(isLocal: true);
    expect(state.isLocalMachine, isTrue);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: HarnessJoinGuideScreen(
            notifier: notifier,
            machineState: state,
            agentName: 'claude-session',
          ),
        ),
      ),
    );

    expect(find.text('Harness is offline'), findsOneWidget);
    expect(find.text('offline-mac · claude-session'), findsOneWidget);
    expect(find.text('harness start'), findsOneWidget);
    expect(find.text('harness login'), findsNothing);
    expect(find.text('harness status'), findsNothing);
    expect(find.text('Checking every 5s…'), findsOneWidget);
    expect(find.byKey(const Key('offline-retry-now')), findsOneWidget);
    notifier.dispose();
  });

  testWidgets('renders a harness start command for a remote machine', (
    tester,
  ) async {
    final notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    final state = stateFor(isLocal: false);
    expect(state.isLocalMachine, isFalse);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: HarnessJoinGuideScreen(
            notifier: notifier,
            machineState: state,
            agentName: 'claude-session',
          ),
        ),
      ),
    );

    expect(find.text('Harness is offline'), findsOneWidget);
    expect(find.text('offline-mac · claude-session'), findsOneWidget);
    expect(find.text('harness start'), findsOneWidget);
    expect(find.text('harness login'), findsNothing);
    expect(find.text('harness status'), findsNothing);
    expect(find.text('Checking every 5s…'), findsOneWidget);
    expect(find.byKey(const Key('offline-retry-now')), findsOneWidget);
    notifier.dispose();
  });
}
