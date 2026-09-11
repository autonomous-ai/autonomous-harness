import 'package:flutter_test/flutter_test.dart';
import 'package:harness/widgets/task_palette.dart';

/// The dial is holding a "sending" overlay open on every one of these, and the daemon is holding a
/// pending request. EXACTLY ONE final answer has to go back, whichever way the palette is left — and
/// never two, because the second would settle a spoken task that a different agent already took.
void main() {
  ({List<String> log, SpokenTask task}) make() {
    final log = <String>[];
    return (
      log: log,
      task: SpokenTask(
        voiceId: 'v1',
        text: 'fix the webhook retry',
        cmd: '',
        report: (voiceId, state, agentId) =>
            log.add('$voiceId/$state${agentId.isEmpty ? '' : '/$agentId'}'),
      ),
    );
  }

  test(
    'acks without settling — the daemon may still be waiting on a person',
    () {
      final it = make();
      it.task.taken();
      expect(it.log, ['v1/taken']);
      // …and an answer still lands afterwards.
      it.task.sent('a7');
      expect(it.log, ['v1/taken', 'v1/sent/a7']);
    },
  );

  test('names the agent that took the work', () {
    final it = make();
    it.task.sent('a7');
    expect(it.log, ['v1/sent/a7']);
  });

  test('a close after a send changes nothing', () {
    final it = make();
    it.task.sent('a7');
    it.task.cancelled();
    expect(it.log, ['v1/sent/a7']);
  });

  test('a close on its own is the answer', () {
    final it = make();
    it.task.cancelled();
    expect(it.log, ['v1/cancelled']);
  });

  test('two closes still answer once — every exit path calls it', () {
    final it = make();
    it.task.cancelled();
    it.task.cancelled();
    expect(it.log, ['v1/cancelled']);
  });

  test('a late send cannot overturn a close', () {
    final it = make();
    it.task.cancelled();
    it.task.sent('a7');
    expect(it.log, ['v1/cancelled']);
  });
}
