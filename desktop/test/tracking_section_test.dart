// Settings ▸ Tracking. What matters here is the pane's job as a *reader*: the
// newest event first, a way to tell a sent event from a refused one, and a
// header that says why nothing is arriving — a screen that renders "muted" and
// "quiet" the same is the screen that sends somebody looking for a bug in the
// analytics stack.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/analytics/analytics_log.dart';
import 'package:harness/analytics/analytics_sink.dart';
import 'package:harness/settings/sections/debug_filter_bar.dart';
import 'package:harness/settings/sections/tracking_section.dart';
import 'package:harness/settings/sections/tracking_tile.dart';
import 'package:harness/settings/settings_section.dart';
import 'package:harness/shared/theme/app_theme.dart';
import 'package:harness/shared/widgets/empty_state.dart';

/// The probe every test here passes: the real one reads
/// `~/.harness/desktop-app/analytics.json`, which no widget test may do.
AnalyticsStreamStatus _live() => AnalyticsStreamStatus(
  endpoint: Uri.parse('https://example.invalid/api/v1/event_tracking'),
  offReason: null,
  deviceId: 'computer-abc',
  sessionId: 'visit-1',
);

AnalyticsStreamStatus _muted() => AnalyticsStreamStatus(
  endpoint: Uri.parse('https://example.invalid/api/v1/event_tracking'),
  offReason: 'This build carries no analytics key.',
  deviceId: 'computer-abc',
  sessionId: '',
);

/// One settled row, as the queue would have left it.
AnalyticsLogEntry _record(
  AnalyticsLogStream log,
  String name, {
  Map<String, Object?> params = const {},
  required AnalyticsEventStatus status,
  Map<String, Object?>? payload,
  String? note,
}) {
  final id = log.queued(name, params, DateTime.utc(2026, 1, 1, 9));
  if (payload != null) log.attempted(id, payload);
  log.settled(id, status, note: note);
  return log.entries.firstWhere((entry) => entry.id == id);
}

void main() {
  Future<void> pumpTracking(
    WidgetTester tester,
    AnalyticsLogStream log, {
    AnalyticsStreamStatus Function() probe = _live,
  }) async {
    tester.view.physicalSize = const Size(1000 * 2, 760 * 2);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(brightness: Brightness.light),
        home: Builder(
          builder: (context) {
            AppTheme.brightness.value = Brightness.light;
            return BrightnessScope(
              child: Scaffold(
                body: TrackingSection(log: log, probe: probe),
              ),
            );
          },
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('lists what was tracked, newest first', (tester) async {
    final log = AnalyticsLogStream();
    _record(log, 'app_opened', status: AnalyticsEventStatus.sent);
    _record(
      log,
      'screen_view',
      params: const {'screen': 'settings_tracking'},
      status: AnalyticsEventStatus.sent,
    );
    await pumpTracking(tester, log);

    final tiles = tester.widgetList<TrackingTile>(find.byType(TrackingTile));
    expect(tiles.map((tile) => tile.entry.name), ['screen_view', 'app_opened']);
    expect(find.text('2 events'), findsOneWidget);
    // The params are on the row, because thirty `screen_view`s are otherwise
    // one row repeated.
    expect(find.textContaining('screen=settings_tracking'), findsOneWidget);
  });

  testWidgets('the Failed lens keeps the refused and the dropped', (
    tester,
  ) async {
    final log = AnalyticsLogStream();
    _record(log, 'app_opened', status: AnalyticsEventStatus.sent);
    _record(
      log,
      'signed_in',
      status: AnalyticsEventStatus.refused,
      note: 'the server refused it',
    );
    _record(
      log,
      'agent_created',
      status: AnalyticsEventStatus.dropped,
      note: 'the queue was full',
    );
    await pumpTracking(tester, log);

    await tester.tap(
      find.descendant(
        of: find.byType(DebugFilterBar),
        matching: find.text('Failed'),
      ),
    );
    await tester.pumpAndSettle();

    final tiles = tester.widgetList<TrackingTile>(find.byType(TrackingTile));
    expect(tiles.map((tile) => tile.entry.name), [
      'agent_created',
      'signed_in',
    ]);
  });

  testWidgets('Waiting keeps only what has not settled', (tester) async {
    final log = AnalyticsLogStream();
    log.queued('signed_in', const {}, DateTime.utc(2026, 1, 1, 9));
    _record(log, 'app_opened', status: AnalyticsEventStatus.sent);
    await pumpTracking(tester, log);

    await tester.tap(
      find.descendant(
        of: find.byType(DebugFilterBar),
        matching: find.text('Waiting'),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(TrackingTile), findsOneWidget);
    expect(
      tester.widget<TrackingTile>(find.byType(TrackingTile)).entry.name,
      'signed_in',
    );
  });

  testWidgets('an empty list says nothing was tracked, not "no matches"', (
    tester,
  ) async {
    await pumpTracking(tester, AnalyticsLogStream());

    expect(find.text('No events yet'), findsOneWidget);
    expect(find.byType(EmptyState), findsOneWidget);
  });

  testWidgets('a filter that hides everything says so instead', (tester) async {
    final log = AnalyticsLogStream();
    _record(log, 'app_opened', status: AnalyticsEventStatus.sent);
    await pumpTracking(tester, log);

    await tester.tap(
      find.descendant(
        of: find.byType(DebugFilterBar),
        matching: find.text('Waiting'),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('No matches'), findsOneWidget);
    expect(find.text('No events yet'), findsNothing);
  });

  testWidgets('Clear empties the list, and is dead while it is empty', (
    tester,
  ) async {
    final log = AnalyticsLogStream();
    _record(log, 'app_opened', status: AnalyticsEventStatus.sent);
    await pumpTracking(tester, log);

    await tester.tap(find.text('Clear'));
    await tester.pumpAndSettle();

    expect(log.entries, isEmpty);
    expect(find.byType(TrackingTile), findsNothing);
    // Pressing it again is a no-op rather than an error.
    await tester.tap(find.text('Clear'));
    await tester.pumpAndSettle();
    expect(find.text('0 events'), findsOneWidget);
  });

  testWidgets('a row opens the payload the line could not hold', (
    tester,
  ) async {
    final log = AnalyticsLogStream();
    _record(
      log,
      'agent_created',
      params: const {'engine': 'claude'},
      status: AnalyticsEventStatus.sent,
      payload: const {
        'event_name': 'agent_created',
        'data': {'session_id': 'visit-1'},
      },
    );
    await pumpTracking(tester, log);

    await tester.tap(find.byType(TrackingTile));
    await tester.pumpAndSettle();

    expect(find.byType(Dialog), findsOneWidget);
    // The body as it went out — which is the difference between this dialog
    // and the row above it.
    expect(find.textContaining('"session_id": "visit-1"'), findsOneWidget);
  });

  group('the header card', () {
    testWidgets('says the stream is reporting, and under which ids', (
      tester,
    ) async {
      await pumpTracking(tester, AnalyticsLogStream());

      expect(find.text('Reporting'), findsOneWidget);
      expect(find.text('computer-abc'), findsOneWidget);
      expect(find.text('visit-1'), findsOneWidget);
    });

    testWidgets('a muted build says so in a sentence, not by staying empty', (
      tester,
    ) async {
      await pumpTracking(tester, AnalyticsLogStream(), probe: _muted);

      expect(find.text('Off'), findsOneWidget);
      expect(find.text('This build carries no analytics key.'), findsOneWidget);
      // "Not yet" and "we could not read it" must not print the same.
      expect(find.text('starts with the first event'), findsOneWidget);
    });
  });

  group('the section itself', () {
    test('is listed where the debug surface is on, which a test build is', () {
      final sections = [for (final group in settingsGroups) ...group.sections];
      expect(sections, contains(SettingsSection.tracking));
    });
  });
}
