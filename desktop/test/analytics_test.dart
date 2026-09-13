import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/analytics/analytics_client.dart';
import 'package:harness/analytics/analytics_config.dart';
import 'package:harness/analytics/analytics_event.dart';
import 'package:harness/analytics/analytics_identity.dart';
import 'package:harness/analytics/analytics_log.dart';
import 'package:harness/analytics/analytics_sink.dart';
import 'package:harness/analytics/analytics_service.dart';

/// Records what it was asked to send and answers with a scripted result, so
/// every branch of the queue is reachable without a socket.
class FakeAnalyticsClient implements AnalyticsClient {
  FakeAnalyticsClient([this.answer = AnalyticsSendResult.sent]);

  AnalyticsSendResult answer;
  final List<Map<String, Object?>> sent = [];
  int disposed = 0;

  @override
  Future<AnalyticsSendResult> send(Map<String, Object?> payload) async {
    sent.add(payload);
    return answer;
  }

  @override
  void dispose() => disposed++;
}

/// The params list of a captured payload, flattened back to a map.
Map<String, Object?> paramsOf(Map<String, Object?> payload) {
  final data = payload['data']! as Map<String, Object?>;
  final entries = data['event_params']! as List<Map<String, Object?>>;
  return {for (final entry in entries) entry['key']! as String: entry['value']};
}

void main() {
  late Directory scratch;

  setUp(() async {
    scratch = await Directory.systemTemp.createTemp('harness-analytics-test-');
  });

  tearDown(() async {
    if (await scratch.exists()) await scratch.delete(recursive: true);
  });

  AnalyticsIdentityStore storeIn(Directory dir, {String? computerId}) {
    final computerIdFile = File('${dir.path}/computer-id');
    if (computerId != null) computerIdFile.writeAsStringSync('$computerId\n');
    return AnalyticsIdentityStore(
      file: File('${dir.path}/analytics.json'),
      computerIdFile: computerIdFile,
      random: Random(7),
    );
  }

  QueuedAnalytics queueOn(
    FakeAnalyticsClient client, {
    AnalyticsIdentityStore? identity,
    ({String? id, String? email}) user = (id: null, email: null),
    AnalyticsLog recorder = const NoopAnalyticsLog(),
    DateTime Function()? clock,
  }) => QueuedAnalytics(
    client: client,
    identityStore: identity ?? storeIn(scratch),
    contextFuture: Future.value(AnalyticsContext.unknown),
    userLookup: () => user,
    recorder: recorder,
    clock: clock ?? DateTime.now,
  );

  // --- the wire ------------------------------------------------------------

  test('the payload is the web client shape, and says which app sent it', () {
    final event = AnalyticsEvent(
      name: 'agent_created',
      params: const {'engine': 'claude', 'bypass_permission': true},
      at: DateTime.fromMillisecondsSinceEpoch(1700000000000, isUtc: true),
      identity: const AnalyticsIdentity(
        pseudoId: 'device-1',
        sessionId: 'visit-1',
        userId: 'user-1',
        userEmail: 'someone@example.test',
      ),
    );

    final payload = analyticsPayload(event, AnalyticsContext.unknown);
    final data = payload['data']! as Map<String, Object?>;
    final params = paramsOf(payload);

    expect(payload['event_name'], 'agent_created');
    // Seconds, not milliseconds — the web client's unit.
    expect(payload['event_timestamp'], 1700000000);
    expect(data['session_id'], 'visit-1');
    expect(data['user_pseudo_id'], 'device-1');
    // In BOTH places, as on the web: most queries read the params table.
    expect(data['user_id'], 'user-1');
    expect(params['user_id'], 'user-1');
    expect(params['user_email'], 'someone@example.test');
    expect(params['engine'], 'claude');
    expect(params['bypass_permission'], true);
    // Without this every stream in the shared project looks like one app.
    expect(params['category'], 'harness-desktop-v2');
  });

  test('params drop nothing meaningful and carry nothing unbounded', () {
    final long = 'x' * (AnalyticsLimits.paramsMaxStringLength + 50);
    final params = analyticsParams({
      'kept': 'value',
      'zero': 0,
      'off': false,
      'null_goes': null,
      'empty_goes': '',
      'nested': {'a': 1},
      'long': long,
    });
    final byKey = {
      for (final entry in params) entry['key']! as String: entry['value'],
    };

    expect(byKey.containsKey('null_goes'), isFalse);
    expect(byKey.containsKey('empty_goes'), isFalse);
    // A zero and a false are measurements, not absences.
    expect(byKey['zero'], 0);
    expect(byKey['off'], false);
    expect(byKey['nested'], '{"a":1}');
    expect(
      (byKey['long']! as String).length,
      AnalyticsLimits.paramsMaxStringLength,
    );
  });

  test('more params than the cap are cut, not sent for the server to drop', () {
    final params = analyticsParams({
      for (var i = 0; i < AnalyticsLimits.paramsMaxKeys + 10; i++) 'k$i': i,
    });

    expect(params, hasLength(AnalyticsLimits.paramsMaxKeys));
  });

  // --- the queue -----------------------------------------------------------

  test(
    'a name that is not snake_case is refused before it is queued',
    () async {
      final client = FakeAnalyticsClient();
      final analytics = queueOn(client);

      analytics.track('Agent Created');
      analytics.track('no');
      await analytics.flush();

      expect(client.sent, isEmpty);
      expect(analytics.pending, 0);
    },
  );

  test('a sent event leaves the queue; a refused one is dropped', () async {
    final client = FakeAnalyticsClient();
    final analytics = queueOn(client);

    analytics.track('agent_created');
    await analytics.flush();
    expect(client.sent, hasLength(1));
    expect(analytics.pending, 0);

    client.answer = AnalyticsSendResult.rejected;
    analytics.track('agent_created');
    await analytics.flush();
    // Sending it again would fail identically, so it goes.
    expect(analytics.pending, 0);
  });

  test('a transport failure keeps the event for the next attempt', () async {
    final client = FakeAnalyticsClient(AnalyticsSendResult.retry);
    final analytics = queueOn(client);

    analytics.track('agent_created');
    await analytics.flush();

    expect(analytics.pending, 1, reason: 'a 5xx must not lose the event');

    client.answer = AnalyticsSendResult.sent;
    await analytics.flush();
    expect(analytics.pending, 0);
  });

  test('a full queue drops its OLDEST, keeping what describes now', () async {
    final client = FakeAnalyticsClient(AnalyticsSendResult.retry);
    final analytics = queueOn(client);

    for (var i = 0; i < AnalyticsLimits.queueCap + 5; i++) {
      analytics.track('signed_in');
    }
    await analytics.flush();

    expect(analytics.pending, AnalyticsLimits.queueCap);
  });

  test('the account is read per event, not per launch', () async {
    final client = FakeAnalyticsClient();
    var user = (id: null, email: null) as ({String? id, String? email});
    final analytics = QueuedAnalytics(
      client: client,
      identityStore: storeIn(scratch),
      contextFuture: Future.value(AnalyticsContext.unknown),
      userLookup: () => user,
    );

    analytics.track('app_opened');
    user = (id: 'user-9', email: 'someone@example.test');
    analytics.track('signed_in');
    await analytics.flush();

    expect(paramsOf(client.sent[0])['user_id'], isNull);
    expect(paramsOf(client.sent[1])['user_id'], 'user-9');
  });

  test('close drains once, then the sink is spent', () async {
    final client = FakeAnalyticsClient();
    final analytics = queueOn(client);

    analytics.track('app_closed');
    await analytics.close();
    analytics.track('app_opened');

    expect(client.sent, hasLength(1));
    expect(client.disposed, 1);
  });

  // --- identity ------------------------------------------------------------

  test('the device id is this machine\'s Harness id when it has one', () {
    final store = storeIn(scratch, computerId: 'computer-abc');

    expect(store.peek().pseudoId, 'computer-abc');
  });

  test('with no computer-id it mints a v4 UUID and keeps it', () {
    final store = storeIn(scratch);
    final first = store.touch(DateTime.now()).pseudoId;

    expect(
      first,
      matches(
        r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
      ),
    );
    // A second store over the same file reads the id back rather than minting.
    expect(storeIn(scratch).peek().pseudoId, first);
  });

  test('the visit rotates after quiet and holds through activity', () {
    final store = storeIn(scratch, computerId: 'computer-abc');
    final start = DateTime.utc(2026, 1, 1, 9);

    final first = store.touch(start).sessionId;
    final same = store.touch(start.add(const Duration(minutes: 5))).sessionId;
    final after = store
        .touch(start.add(AnalyticsLimits.sessionIdle * 2))
        .sessionId;

    expect(first, isNotEmpty);
    expect(same, first);
    expect(after, isNot(first));
  });

  test('an opt-out is honoured and survives every write', () {
    final file = File('${scratch.path}/analytics.json')
      ..writeAsStringSync(jsonEncode({'enabled': false}));
    final store = AnalyticsIdentityStore(
      file: file,
      computerIdFile: File('${scratch.path}/computer-id'),
    );

    expect(store.optedOut, isTrue);

    store.touch(DateTime.utc(2026, 1, 1, 9));
    final written = jsonDecode(file.readAsStringSync()) as Map<String, Object?>;
    expect(
      written['enabled'],
      false,
      reason: 'turning tracking off has to stay off across a write',
    );
  });

  test('a corrupt file starts over rather than failing the launch', () {
    File('${scratch.path}/analytics.json').writeAsStringSync('not json {');
    final store = storeIn(scratch, computerId: 'computer-abc');

    expect(store.peek().pseudoId, 'computer-abc');
    expect(store.optedOut, isFalse);
  });

  // --- the switch ----------------------------------------------------------

  test('a test run is muted, and says why', () {
    final config = AnalyticsConfig.resolve();

    expect(config.enabled, isFalse);
    expect(config.offReason, isNotNull);
    // The sink every test gets: no socket, no queue, no Harness home. It is
    // MutedAnalytics rather than NoopAnalytics because a test VM has the debug
    // surface, so the events still land in the buffer Settings ▸ Tracking
    // reads — a screen whose whole job is to explain a stream going nowhere
    // cannot be blank in the state that makes it most needed. A release build
    // has no such screen and gets the Noop.
    expect(analytics, isA<MutedAnalytics>());
    expect((analytics as MutedAnalytics).reason, config.offReason);
  });

  // --- the Tracking screen's buffer ----------------------------------------

  test('a muted sink records the event it did not send', () {
    final log = AnalyticsLogStream();
    MutedAnalytics(
      log,
      'This build carries no analytics key.',
    ).track('screen_view', params: const {'screen': 'settings_tracking'});

    final entry = log.entries.single;
    expect(entry.name, 'screen_view');
    expect(entry.params, const {'screen': 'settings_tracking'});
    expect(entry.status, AnalyticsEventStatus.dropped);
    expect(entry.note, 'This build carries no analytics key.');
    expect(
      entry.payload,
      isNull,
      reason: 'nothing went on the wire, so there is no body to show',
    );
  });

  test('the queue records an event from queued to sent', () async {
    final log = AnalyticsLogStream();
    final client = FakeAnalyticsClient();
    final analytics = queueOn(client, recorder: log);

    analytics.track('agent_created', params: const {'engine': 'claude'});
    expect(log.entries.single.status, AnalyticsEventStatus.queued);

    await analytics.flush();

    final entry = log.entries.single;
    expect(entry.status, AnalyticsEventStatus.sent);
    expect(entry.attempts, 1);
    expect(entry.took, isNotNull);
    // The payload, not the params: the gap between what the call site passed
    // and what actually left is the bug this screen is opened to find.
    expect(entry.payload, contains('"event_name": "agent_created"'));
    expect(entry.payload, contains('harness-desktop-v2'));
  });

  test('a retry shows as one row with two attempts, not two rows', () async {
    final log = AnalyticsLogStream();
    final client = FakeAnalyticsClient(AnalyticsSendResult.retry);
    final analytics = queueOn(client, recorder: log);

    analytics.track('signed_in');
    await analytics.flush();
    expect(log.entries.single.status, AnalyticsEventStatus.queued);
    expect(log.entries.single.attempts, 1);

    client.answer = AnalyticsSendResult.sent;
    await analytics.flush();

    expect(log.entries, hasLength(1));
    expect(log.entries.single.status, AnalyticsEventStatus.sent);
    expect(
      log.entries.single.attempts,
      2,
      reason: 'the retry is the thing this screen exists to make visible',
    );
  });

  test('a refusal and a bad name are told apart on the row', () async {
    final log = AnalyticsLogStream();
    final analytics = queueOn(
      FakeAnalyticsClient(AnalyticsSendResult.rejected),
      recorder: log,
    );

    analytics.track('Agent Created');
    analytics.track('signed_in');
    await analytics.flush();

    // Newest first, so the refused one leads.
    expect(log.entries.first.name, 'signed_in');
    expect(log.entries.first.status, AnalyticsEventStatus.refused);
    // Dropped before the queue, so it never reached the wire — and it is on
    // the screen at all, which is the point: an event the app itself refused
    // is otherwise indistinguishable from one nobody tracked.
    expect(log.entries.last.name, 'Agent Created');
    expect(log.entries.last.status, AnalyticsEventStatus.dropped);
    expect(log.entries.last.payload, isNull);
  });

  test('the buffer keeps the newest and drops the rest', () {
    final log = AnalyticsLogStream(maxEntries: 3);
    for (var i = 0; i < 5; i++) {
      log.queued('event_$i', const {}, DateTime.utc(2026, 1, 1, 9, i));
    }

    expect(log.entries.map((e) => e.name), ['event_4', 'event_3', 'event_2']);

    log.clear();
    expect(log.entries, isEmpty);
  });
}
