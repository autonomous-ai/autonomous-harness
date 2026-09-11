// Settings is a screen now, not a dialog — so what this guards is the shape a
// dialog never had: a rail you pick a section from, a pane that follows it, a
// filter over the rail, and a way back out.
//
// Deliberately never calls a mutating method on the real global
// `terminalFontStore` singleton: it persists through the real
// `HarnessFileStore` (the user's actual `~/.harness/desktop-app/state.json`).
// This only reads the store's untouched default.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:package_info_plus/package_info_plus.dart';

import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/settings/settings_screen.dart';
import 'package:harness/shared/theme/app_theme.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_font_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  // The About section prints the running version.
  PackageInfo.setMockInitialValues(
    appName: 'Harness',
    packageName: 'ai.autonomous.harness',
    version: '1.0.0',
    buildNumber: '1',
    buildSignature: '',
  );

  /// Opens Settings over a bare host screen and settles the push transition.
  Future<AppNotifier> openSettings(WidgetTester tester) async {
    final notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    addTearDown(notifier.dispose);
    // Wide enough that the rail and the pane both have room — the window's own
    // minimum is 880.
    tester.view.physicalSize = const Size(1100 * 2, 760 * 2);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(brightness: Brightness.light),
        home: Builder(
          builder: (context) {
            AppTheme.brightness.value = Brightness.light;
            return const BrightnessScope(child: Placeholder());
          },
        ),
      ),
    );
    unawaited(
      showSettingsScreen(
        tester.element(find.byType(Placeholder)),
        notifier,
        source: 'account_menu',
      ),
    );
    await tester.pumpAndSettle();
    return notifier;
  }

  testWidgets('opens on Appearance, with every section in the rail', (
    tester,
  ) async {
    await openSettings(tester);

    // The rail: every group caption and every row.
    expect(find.text('Preferences'), findsOneWidget);
    expect(find.text('Help'), findsOneWidget);
    expect(find.text('Terminal'), findsOneWidget);
    expect(find.text('Keyboard shortcuts'), findsOneWidget);
    expect(find.text('About'), findsOneWidget);
    expect(find.text('Back to app'), findsOneWidget);

    // Appearance is the section it opens on, so its name is both the rail row
    // and the pane's title.
    expect(find.text('Appearance'), findsNWidgets(2));
  });

  testWidgets('the Appearance pane is the typography controls', (tester) async {
    await openSettings(tester);

    // Typography is the whole pane now that there is no theme to choose —
    // Harness Desktop is dark-only.
    expect(find.text('Typography'), findsOneWidget);
    expect(find.text('UI font'), findsOneWidget);
    expect(find.text('UI font size'), findsOneWidget);
    expect(find.byKey(const Key('appearance-ui-size-field')), findsOneWidget);
  });

  testWidgets('picking Terminal swaps the pane for the font controls', (
    tester,
  ) async {
    await openSettings(tester);

    await tester.tap(find.text('Terminal'));
    await tester.pumpAndSettle();

    expect(find.text('Terminal'), findsNWidgets(2));
    expect(
      find.byKey(const Key('terminal-font-family-dropdown')),
      findsOneWidget,
    );
    expect(
      find.text(TerminalFontChoice.defaultForPlatform.label),
      findsOneWidget,
    );
    expect(find.text('13pt'), findsOneWidget);
    expect(
      find.byKey(const Key('terminal-font-size-decrease')),
      findsOneWidget,
    );
    expect(
      find.byKey(const Key('terminal-font-size-increase')),
      findsOneWidget,
    );
    expect(
      find.byKey(const Key('terminal-settings-reset-button')),
      findsOneWidget,
    );
    // The Appearance controls are gone with their pane.
    expect(find.byKey(const Key('appearance-ui-size-field')), findsNothing);
  });

  testWidgets('About prints the running version', (tester) async {
    await openSettings(tester);

    await tester.tap(find.text('About'));
    await tester.pumpAndSettle();

    // The version the account menu used to carry. It reads the same
    // runningAppVersion() a release does — on Linux that means version.txt
    // beside the executable first, then package metadata (mocked above), which
    // is why this passes on either build host.
    //
    // The number, not a "Version" label: this branch draws About as one card
    // where the version sits beside the update pill, so the label main's row
    // had is gone. `about_section_test.dart` owns that shape; what this test
    // owes is that the pane prints the running version at all.
    expect(find.text('1.0.0'), findsOneWidget);
  });

  testWidgets('the rail filter narrows to matching rows, and says so when '
      'nothing matches', (tester) async {
    await openSettings(tester);

    await tester.enterText(
      find.byKey(const Key('settings-search-field')),
      'key',
    );
    await tester.pumpAndSettle();

    expect(find.text('Keyboard shortcuts'), findsOneWidget);
    // Rail rows gone; the open pane's own title is what remains of
    // 'Appearance'.
    expect(find.text('Appearance'), findsOneWidget);
    expect(find.text('Terminal'), findsNothing);
    expect(find.text('Preferences'), findsNothing);

    await tester.enterText(
      find.byKey(const Key('settings-search-field')),
      'zzz',
    );
    await tester.pumpAndSettle();

    expect(find.text('No settings match'), findsOneWidget);
  });

  testWidgets('Back to app leaves Settings', (tester) async {
    await openSettings(tester);

    await tester.tap(find.text('Back to app'));
    await tester.pumpAndSettle();

    expect(find.text('Back to app'), findsNothing);
    expect(find.text('Appearance'), findsNothing);
    expect(find.byType(Placeholder), findsOneWidget);
  });
}
