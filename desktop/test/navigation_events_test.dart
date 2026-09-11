// Which DOOR opened a Settings pane.
//
// Settings is reachable several ways, and a bare count of a pane answers
// almost nothing: the account menu, the ⌘D shortcut and the settings rail
// itself are different visits.
//
// What is pinned here is the part a refactor breaks silently: that every door
// says which one it is.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/analytics/analytics.dart';
import 'package:harness/analytics/analytics_sink.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/settings/settings_screen.dart';
import 'package:harness/settings/settings_section.dart';
import 'package:harness/state/app_state.dart';

/// Keeps every tracked event — the same recorder `agent_events_test` uses.
class _Recording implements Analytics {
  final List<({String name, Map<String, Object?> params})> events = [];

  List<Map<String, Object?>> allOf(String name) => [
    for (final event in events)
      if (event.name == name) event.params,
  ];

  @override
  void track(String name, {Map<String, Object?> params = const {}}) =>
      events.add((name: name, params: params));

  @override
  Future<void> flush() async {}

  @override
  Future<void> close() async {}
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late _Recording tracked;

  setUp(() {
    tracked = _Recording();
    setAnalyticsForTest(tracked);
  });

  // Put back, or every later test in the run reports into this list.
  tearDown(() => setAnalyticsForTest(null));

  group('screen_view carries the door', () {
    Future<void> openSettings(
      WidgetTester tester, {
      required String source,
      SettingsSection? initialSection,
    }) async {
      final notifier = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );
      addTearDown(notifier.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () => showSettingsScreen(
                  context,
                  notifier,
                  initialSection: initialSection,
                  source: source,
                ),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
    }

    testWidgets('the pane Settings opens on names the door that opened it', (
      tester,
    ) async {
      await openSettings(
        tester,
        source: 'account_menu',
        initialSection: SettingsSection.shortcuts,
      );

      expect(tracked.allOf('screen_view'), [
        {'screen': 'settings_shortcuts', 'source': 'account_menu'},
      ]);
    });

    testWidgets('moving between panes reports the rail, not the first door', (
      tester,
    ) async {
      await openSettings(
        tester,
        source: 'account_menu',
        initialSection: SettingsSection.appearance,
      );
      await tester.tap(find.text('Terminal'));
      await tester.pumpAndSettle();

      // Two visits, two sources: the door into Settings, then the rail. A
      // second view that inherited `account_menu` would report every pane a
      // reader wandered through as having been opened from the account menu.
      expect(tracked.allOf('screen_view'), [
        {'screen': 'settings_appearance', 'source': 'account_menu'},
        {'screen': 'settings_terminal', 'source': 'rail'},
      ]);
    });
  });
}
