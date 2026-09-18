import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/state/session_preview.dart';

const a = (machineId: 'm', agentId: 'a', sessionId: 's1');
const b = (machineId: 'm', agentId: 'b', sessionId: 's2');
const c = (machineId: 'remote', agentId: 'c', sessionId: 's3');

void main() {
  test(
    'cached requests and saved answers remain independent, never generated',
    () async {
      var calls = 0;
      final store = SessionPreviewStore(
        canFetch: (_) => true,
        fetchRecent: (key) async {
          calls++;
          return {
            'agentId': key.agentId,
            'asks': [
              'continue',
              'Make the picker show useful existing session content.',
            ],
            'events': [
              {
                'kind': 'summary',
                'recap': 'short title',
                'text': 'short body',
                'fullText': 'Implemented the earlier task. Tests pass.',
              },
            ],
          };
        },
      );
      addTearDown(store.dispose);
      store.warm([a]);
      await Future<void>.delayed(Duration.zero);
      final record = store.read(a)!;
      expect(record.latestRequest, 'continue');
      expect(record.earlierRequest, contains('picker'));
      expect(record.response, 'Implemented the earlier task. Tests pass.');
      expect(record.currentRequest, isNull);
      for (var i = 0; i < 40; i++) {
        store.warm([a]);
        expect(store.read(a), same(record));
      }
      expect(calls, 1);
    },
  );

  test(
    'a commit receipt retains the existing explanation for context',
    () async {
      final store = SessionPreviewStore(
        canFetch: (_) => true,
        fetchRecent: (_) async => {
          'events': [
            {
              'kind': 'summary',
              'fullText': 'I’ll commit the prototype.\n\nPushing now.\n\nCommitted and pushed.\n\nThe shared comments are saved.',
            },
            {
              'kind': 'summary',
              'fullText':
                  'Highlight any message to add a shared comment thread.',
            },
            {
              'kind': 'summary',
              'fullText':
                  'Teammates can reply without sending a prompt to the agent.',
            },
          ],
        },
      );
      addTearDown(store.dispose);
      store.warm([a]);
      await Future<void>.delayed(Duration.zero);
      final preview = store.read(a)!;
      expect(
        preview.response,
        'I’ll commit the prototype.\n\nPushing now.\n\nCommitted and pushed.\n\nThe shared comments are saved.',
      );
      expect(
        preview.responseExcerpt,
        'Committed and pushed.\n\nThe shared comments are saved.',
      );
      expect(
        preview.contextResponse,
        'Highlight any message to add a shared comment thread.',
      );
      expect(preview.earlierResponses, hasLength(2));
    },
  );

  test('background work is bounded and late replies cannot replace another session', () async {
    final pending = <SessionPreviewKey, Completer<Map<String, dynamic>>>{};
    final valid = {a, b, c};
    final store = SessionPreviewStore(
      canFetch: valid.contains,
      fetchRecent: (key) => (pending[key] = Completer()).future,
    );
    addTearDown(store.dispose);
    store.warm([a, b, c]);
    expect(pending.keys, [a, b]);
    store.warm([a]);
    valid.remove(a);
    store.retainAgent('m', 'a', 'new-session');
    pending[a]!.complete({
      'asks': ['Old session contents'],
    });
    await Future<void>.delayed(Duration.zero);
    expect(store.read(a), isNull);
    expect(pending.keys, [a, b, c]);
    pending[c]!.complete({
      'agentId': 'wrong',
      'asks': ['Wrong agent'],
    });
    pending[b]!.complete({
      'asks': ['Correct agent'],
    });
    await Future<void>.delayed(Duration.zero);
    expect(store.read(b)!.latestRequest, 'Correct agent');
    expect(store.read(c)!.hasContent, isFalse);
    expect(store.read(c)!.unavailable, isTrue);
  });

  test(
    'a cached reply never overwrites a request observed after its fetch began',
    () async {
      final reply = Completer<Map<String, dynamic>>();
      final store = SessionPreviewStore(
        canFetch: (_) => true,
        fetchRecent: (_) => reply.future,
      );
      addTearDown(store.dispose);
      store.warm([a]);
      store.ingest(a, 'turn_started', {'userMessage': 'Fix the latest crash.'});
      store.ingest(a, 'text_delta', {'content': 'Checking the failing input.'});
      reply.complete({
        'asks': ['Old task'],
        'events': [
          {'kind': 'summary', 'text': 'Old result'},
        ],
      });
      await Future<void>.delayed(Duration.zero);
      expect(store.read(a)!.currentRequest, 'Fix the latest crash.');
      expect(store.read(a)!.liveText, 'Checking the failing input.');
      expect(store.read(a)!.response, isNull);
      store.ingest(a, 'text_delta', {
        'content': 'Fixed the crash. All tests pass.',
      });
      store.ingest(a, 'turn_ended', {});
      expect(store.read(a)!.response, 'Fixed the crash. All tests pass.');
      store.ingest(a, 'turn_started', {'userMessage': 'Now fix the layout.'});
      expect(store.read(a)!.liveText, isNull);
      expect(store.read(a)!.response, 'Fixed the crash. All tests pass.');
      expect(store.read(a)!.currentRequest, 'Now fix the layout.');
    },
  );

  test('live excerpts skip reasoning and tool output and stay bounded', () {
    final store = SessionPreviewStore(
      capacity: 2,
      canFetch: (_) => false,
      fetchRecent: (_) async => {},
    );
    addTearDown(store.dispose);
    store.ingest(a, 'thinking_delta', {'content': 'internal analysis'});
    expect(store.read(a), isNull);
    store.ingest(a, 'turn_started', {'userMessage': 'a' * 100000});
    store.ingest(a, 'tool_start', {
      'tool': 'Read',
      'input': {'path': '/a'},
    });
    expect(store.read(a)!.activity, 'Read');
    store.ingest(a, 'tool_end', {'tool': 'Read', 'output': 'b' * 100000});
    expect(store.read(a)!.activity, isNull);
    store.ingest(a, 'text_delta', {'content': 'A small '}, streamingText: true);
    store.ingest(a, 'text_delta', {
      'content': 'response.',
    }, streamingText: true);
    expect(store.read(a)!.liveText, 'A small response.');
    store.ingest(a, 'text_delta', {'content': 'b' * 100000});
    expect(store.read(a)!.liveText!.length, lessThanOrEqualTo(6001));
    expect(store.read(a)!.currentRequest!.length, lessThanOrEqualTo(1601));
    store.ingest(b, 'user_message', {'content': 'second'});
    store.ingest(c, 'user_message', {'content': 'third'});
    expect(store.read(a), isNull);
    store.clear();
    expect(store.read(b), isNull);
  });

  test('offline and failed refresh retain saved text; retries respect the cache age', () async {
    var now = DateTime(2026, 9, 14);
    var online = true;
    var calls = 0;
    final store = SessionPreviewStore(
      now: () => now,
      canFetch: (_) => online,
      fetchRecent: (_) async {
        if (++calls > 1) throw StateError('offline');
        return {
          'events': [
            {'kind': 'summary', 'text': 'Saved result'},
          ],
        };
      },
    );
    addTearDown(store.dispose);
    store.warm([a]);
    await Future<void>.delayed(Duration.zero);
    online = false;
    now = now.add(const Duration(minutes: 2));
    store.warm([a]);
    expect(calls, 1);
    online = true;
    store.warm([a]);
    await Future<void>.delayed(Duration.zero);
    expect(store.read(a)!.response, 'Saved result');
    expect(store.read(a)!.unavailable, isTrue);
    expect(calls, 2);
    store.warm([a]);
    expect(calls, 2);
  });

  test(
    'markStale lets a moved session be read again inside freshFor',
    () async {
      var calls = 0;
      final store = SessionPreviewStore(
        canFetch: (_) => true,
        fetchRecent: (_) async => {
          'asks': ['question ${++calls}'],
        },
      );
      addTearDown(store.dispose);
      store.warm([a]);
      await Future<void>.delayed(Duration.zero);
      store.warm([a]);
      expect(calls, 1, reason: 'fresh, so not read again');
      store.markStale(a);
      store.warm([a]);
      await Future<void>.delayed(Duration.zero);
      expect(calls, 2);
      expect(store.read(a)!.latestRequest, 'question 2');
    },
  );
}
