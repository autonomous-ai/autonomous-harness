// Settings ▸ Debug. What matters here is the pane's job as a *reader*: the
// newest line first, a way to narrow five hundred rows to the one that failed,
// and two different empty states — nothing logged yet, and a filter that hid
// everything — since a screen that renders those the same is the screen that
// sends somebody looking for a bug in the log stack.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/harness_cli_runner.dart';
import 'package:harness/logging/app_log.dart';
import 'package:harness/logging/log_stream.dart';
import 'package:harness/settings/sections/debug_detail_dialog.dart';
import 'package:harness/settings/sections/debug_filter_bar.dart';
import 'package:harness/settings/sections/debug_log_tile.dart';
import 'package:harness/settings/sections/debug_paths_card.dart';
import 'package:harness/settings/sections/debug_section.dart';
import 'package:harness/settings/settings_section.dart';
import 'package:harness/shared/theme/app_theme.dart';
import 'package:harness/shared/widgets/empty_state.dart';

/// The probe every test here passes: the real one reads `~/.harness`, which no
/// widget test may do.
Future<DebugEnvironment> _fakeProbe() async => const DebugEnvironment(
  harnessCommand: '/tmp/node /tmp/cli.js',
  harnessSource: HarnessCliSource.managed,
  logsDirectory: '/tmp/logs',
);

void main() {
  Future<void> pumpDebug(WidgetTester tester, LogStream stream) async {
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
                body: DebugSection(stream: stream, probe: _fakeProbe),
              ),
            );
          },
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('lists what was logged, newest first', (tester) async {
    final stream = LogStream()
      ..add(AppLogLevel.info, 'app', 'launched')
      ..add(AppLogLevel.debug, 'ws', '→ agent_create {engine: codex}');
    await pumpDebug(tester, stream);

    final tiles = tester.widgetList<DebugLogTile>(find.byType(DebugLogTile));
    expect(tiles.map((tile) => tile.entry.message), [
      '→ agent_create {engine: codex}',
      'launched',
    ]);
    expect(find.text('2 entries'), findsOneWidget);
  });

  testWidgets('the Failed lens keeps the failures and the warnings', (
    tester,
  ) async {
    final stream = LogStream()
      ..add(AppLogLevel.debug, 'ws', '→ agent_create')
      ..add(AppLogLevel.warn, 'ws', '← agent_create failed')
      ..add(AppLogLevel.error, 'api', 'GET /api/machines → failed');
    await pumpDebug(tester, stream);

    await tester.tap(find.text('Failed'));
    await tester.pumpAndSettle();

    final tiles = tester.widgetList<DebugLogTile>(find.byType(DebugLogTile));
    expect(tiles.map((tile) => tile.entry.message), [
      'GET /api/machines → failed',
      '← agent_create failed',
    ]);
  });

  testWidgets('a category lens narrows to that category', (tester) async {
    final stream = LogStream()
      ..add(AppLogLevel.info, 'cli', 'harness auth status --json')
      ..add(AppLogLevel.debug, 'ws', '→ agents_list');
    await pumpDebug(tester, stream);

    // The lens, not the `cli` a row prints in its own meta column.
    await tester.tap(
      find.descendant(
        of: find.byType(DebugFilterBar),
        matching: find.text('cli'),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(DebugLogTile), findsOneWidget);
    expect(find.textContaining('harness auth status'), findsOneWidget);
  });

  testWidgets('search narrows on the message, and says when nothing matches', (
    tester,
  ) async {
    final stream = LogStream()
      ..add(AppLogLevel.info, 'app', 'launched')
      ..add(AppLogLevel.debug, 'ws', '→ agents_list');
    await pumpDebug(tester, stream);

    await tester.enterText(find.byType(TextField), 'agents');
    await tester.pumpAndSettle();
    expect(find.byType(DebugLogTile), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'nothing like this');
    await tester.pumpAndSettle();
    expect(find.text('No matches'), findsOneWidget);
  });

  testWidgets('an empty log says nothing has been logged, not "no matches"', (
    tester,
  ) async {
    await pumpDebug(tester, LogStream());

    expect(find.text('Nothing logged yet'), findsOneWidget);
    expect(find.byType(EmptyState), findsOneWidget);
  });

  testWidgets('Clear empties the list, and is dead while it is empty', (
    tester,
  ) async {
    final stream = LogStream()..add(AppLogLevel.info, 'app', 'launched');
    await pumpDebug(tester, stream);

    await tester.tap(find.text('Clear'));
    await tester.pumpAndSettle();

    expect(stream.entries, isEmpty);
    expect(find.byType(DebugLogTile), findsNothing);
    // Pressing it again is a no-op rather than an error.
    await tester.tap(find.text('Clear'));
    await tester.pumpAndSettle();
    expect(find.text('0 entries'), findsOneWidget);
  });

  testWidgets('a row opens the transcript the line could not hold', (
    tester,
  ) async {
    final stream = LogStream();
    final id = stream.add(
      AppLogLevel.info,
      'cli',
      'harness link list',
      command: LogCommand(),
    );
    stream.appendOutput(id, 'one link');
    stream.finish(id, exitCode: 0, duration: const Duration(milliseconds: 40));
    await pumpDebug(tester, stream);

    await tester.tap(find.byType(DebugLogTile));
    await tester.pumpAndSettle();

    expect(find.byType(Dialog), findsOneWidget);
    expect(find.textContaining('one link'), findsOneWidget);
  });

  group('the copied text', () {
    test('carries the command, how it ended, and its output', () {
      final stream = LogStream();
      final id = stream.add(
        AppLogLevel.info,
        'cli',
        'harness link create',
        command: LogCommand(),
      );
      stream.appendOutput(id, 'joined');
      stream.finish(id, exitCode: 1, duration: const Duration(seconds: 2));

      final text = debugEntryAsText(stream.entries.single);

      expect(text, contains('harness link create'));
      expect(text, contains('FAILED exit=1 (2s)'));
      expect(text, contains('joined'));
    });
  });

  group('the section itself', () {
    test('is listed where the debug surface is on, which a test build is', () {
      final sections = [for (final group in settingsGroups) ...group.sections];
      expect(sections, contains(SettingsSection.debug));
    });
  });
}
