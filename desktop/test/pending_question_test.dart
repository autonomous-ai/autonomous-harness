// The window learning that an agent is blocked. Everything here is the
// bookkeeping around two frames — `commander_question` and its close — which is
// what decides whether a row can lie: a question that outlives its dialog, a
// wait clock that resets itself, a stale close wiping a live question.
import 'package:flutter_test/flutter_test.dart';

import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pending_question.dart';

const _machine = Machine(
  machineId: 'm1',
  authMode: MachineAuthMode.remote,
  name: 'MacBook-Pro.local',
);

AppNotifier notifierWithMachine() {
  final notifier = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
  );
  notifier.machineStates[_machine.machineId] = MachineState(_machine);
  return notifier;
}

Map<String, dynamic> asked({
  String agentId = 'a1',
  String requestId = 'q_1',
  String prompt = 'Which colour theme do you want?',
  List<String> options = const ['Blue', 'Red'],
  bool multi = false,
}) => {
  'type': 'commander_question',
  'agentId': agentId,
  'dbSessionId': 's1',
  'payload': {
    'requestId': requestId,
    'questions': [
      {'key': prompt, 'q': prompt, 'options': options, 'multi': multi},
    ],
  },
};

Map<String, dynamic> closed({
  String agentId = 'a1',
  String requestId = 'q_1',
}) => {
  'type': 'commander_question_close',
  'agentId': agentId,
  'dbSessionId': 's1',
  'payload': {'requestId': requestId},
};

void main() {
  group('shaping', () {
    test('reads the prompt, its options and its answer key', () {
      final question = PendingQuestion.fromPayload(
        machineId: 'm1',
        agentId: 'a1',
        payload: asked()['payload'] as Map<String, dynamic>,
        now: DateTime(2026),
      )!;
      expect(question.prompt, 'Which colour theme do you want?');
      expect(question.options, ['Blue', 'Red']);
      // The daemon keys the answer by the question's own text for a
      // pane-derived dialog; kept so a client that answers has the key.
      expect(question.answerKey, 'Which colour theme do you want?');
    });

    test('refuses a payload with nothing to draw', () {
      for (final payload in <Map<String, dynamic>>[
        {'questions': <dynamic>[]},
        {'requestId': 'q', 'questions': <dynamic>[]},
        {
          'requestId': 'q',
          'questions': [
            {'q': '   ', 'options': []},
          ],
        },
      ]) {
        expect(
          PendingQuestion.fromPayload(
            machineId: 'm1',
            agentId: 'a1',
            payload: payload,
            now: DateTime(2026),
          ),
          isNull,
        );
      }
    });
  });

  group('the window following a dialog', () {
    test(
      'a question makes its agent blocked, and the close clears it',
      () async {
        final n = notifierWithMachine();
        await n.handleMachineEventForTest('m1', asked());
        expect(n.questionFor('m1', 'a1')!.agentId, 'a1');
        expect(n.questionFor('m1', 'a1')!.prompt, contains('colour theme'));

        await n.handleMachineEventForTest('m1', closed());
        expect(n.questionFor('m1', 'a1'), isNull);
      },
    );

    test('a re-announce of the same question keeps the original clock', () async {
      // The daemon re-announces an open question on reconnect and on attaching
      // to a turn that was already mid-dialog. If that reset the clock, an
      // agent blocked for ten minutes would read as new after every hiccup.
      final n = notifierWithMachine();
      await n.handleMachineEventForTest('m1', asked());
      final first = n.questionFor('m1', 'a1')!.since;
      await Future<void>.delayed(const Duration(milliseconds: 5));
      await n.handleMachineEventForTest('m1', asked());
      expect(n.questionFor('m1', 'a1')!.since, first);
    });

    test(
      'the next page of a dialog replaces it, and starts its own clock',
      () async {
        final n = notifierWithMachine();
        await n.handleMachineEventForTest('m1', asked());
        final first = n.questionFor('m1', 'a1')!.since;
        await Future<void>.delayed(const Duration(milliseconds: 5));
        await n.handleMachineEventForTest(
          'm1',
          asked(
            requestId: 'q_2',
            prompt: 'Which font?',
            options: ['Mono', 'Sans'],
          ),
        );
        final now = n.questionFor('m1', 'a1')!;
        expect(now.prompt, 'Which font?');
        expect(now.since.isAfter(first), isTrue);
      },
    );

    test('a close for a question that already moved on is ignored', () async {
      // Ordering on the wire is not guaranteed, and the close for page one can
      // arrive after page two is already up. Wiping the live one would leave an
      // agent blocked with nothing anywhere saying so.
      final n = notifierWithMachine();
      await n.handleMachineEventForTest('m1', asked());
      await n.handleMachineEventForTest(
        'm1',
        asked(requestId: 'q_2', prompt: 'Which font?'),
      );
      await n.handleMachineEventForTest('m1', closed(requestId: 'q_1'));
      expect(n.questionFor('m1', 'a1')!.prompt, 'Which font?');
    });

    test('the turn ending clears it even with no close frame', () async {
      // A question cannot outlive its own turn — the daemon's watcher is torn
      // down at turn_ended and says the same thing from its end. This side does
      // not depend on that frame surviving the trip.
      final n = notifierWithMachine();
      await n.handleMachineEventForTest('m1', asked());
      await n.handleMachineEventForTest('m1', {
        'type': 'turn_ended',
        'agentId': 'a1',
        'payload': <String, dynamic>{},
      });
      expect(n.questionFor('m1', 'a1'), isNull);
    });

    test('deleting the agent takes its question with it', () async {
      final n = notifierWithMachine();
      await n.handleMachineEventForTest('m1', asked());
      await n.handleMachineEventForTest('m1', {
        'type': 'agent_deleted',
        'agentId': 'a1',
        'payload': <String, dynamic>{},
      });
      expect(n.questionFor('m1', 'a1'), isNull);
    });
  });
}
