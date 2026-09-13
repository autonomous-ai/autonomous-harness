// Settings ▸ About is one card, and the card's job is to answer "which build am
// I on, and is it current?" without being asked. That second half is state the
// pane reads off [AppNotifier], so it can go wrong quietly — a pill that says
// "Up to date" while an update is sitting in the notifier is worse than no pill
// at all, which is what these guard.
//
// Built directly rather than through `showSettingsScreen`: the rail and the
// route are `settings_screen_test.dart`'s subject, and this one only wants the
// pane.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:package_info_plus/package_info_plus.dart';

import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/settings/sections/about_section.dart';
import 'package:harness/shared/theme/app_theme.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/update/desktop_updater.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  // The card prints the running version, which comes from the bundle.
  PackageInfo.setMockInitialValues(
    appName: 'Harness',
    packageName: 'ai.autonomous.harness',
    version: '1.0.0',
    buildNumber: '1',
    buildSignature: '',
  );

  Future<AppNotifier> pumpAbout(
    WidgetTester tester, {
    bool updatesEnabled = true,
  }) async {
    final notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      desktopUpdater: updatesEnabled ? DesktopUpdater(enabled: true) : null,
    );
    addTearDown(notifier.dispose);
    tester.view.physicalSize = const Size(900 * 2, 700 * 2);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(brightness: Brightness.light),
        home: Builder(
          builder: (context) {
            AppTheme.brightness.value = Brightness.light;
            return BrightnessScope(
              child: Scaffold(body: AboutSection(notifier: notifier)),
            );
          },
        ),
      ),
    );
    await tester.pumpAndSettle();
    return notifier;
  }

  const update = UpdateInfo(
    version: '1.0.4',
    url: 'https://example.invalid/harness.zip',
    sha256: 'deadbeef',
    size: 48600000,
  );

  testWidgets('the preview identifies itself and explains disabled updates', (
    tester,
  ) async {
    final notifier = await pumpAbout(tester, updatesEnabled: false);
    expect(find.text('Harness V2'), findsOneWidget);
    expect(find.text('Preview · updates disabled'), findsOneWidget);
    expect(
      find.text(
        'Automatic and manual updates are disabled for this V2 preview.',
      ),
      findsOneWidget,
    );
    expect(
      find.byKey(const Key('settings-check-updates-button')),
      findsNothing,
    );
    notifier.availableUpdate = update;
    expect(await notifier.installAvailableUpdate(), isFalse);
  });

  testWidgets('names the app, its version, and says nothing is waiting', (
    tester,
  ) async {
    await pumpAbout(tester);

    expect(find.text('Harness V2'), findsOneWidget);
    expect(find.text('1.0.0'), findsOneWidget);
    expect(find.text('Up to date'), findsOneWidget);
    // Secondary actions, never a filled one — the pane is read, not operated.
    // Two of them since the merge with main: the update check, and the dial
    // flash, which on Linux and Windows has no native menu item to live in.
    expect(
      find.byKey(const Key('settings-check-updates-button')),
      findsOneWidget,
    );
    expect(
      find.byKey(const Key('settings-flash-firmware-button')),
      findsOneWidget,
    );
    expect(find.byType(OutlinedButton), findsNWidgets(2));
    expect(find.byType(FilledButton), findsNothing);
  });

  testWidgets('the pill names the waiting version', (tester) async {
    final notifier = await pumpAbout(tester);

    notifier.availableUpdate = update;
    notifier.notifyListeners();
    await tester.pump();

    expect(find.text('1.0.4 available'), findsOneWidget);
    expect(find.text('Up to date'), findsNothing);
  });

  testWidgets('an install in flight outranks the update that started it', (
    tester,
  ) async {
    final notifier = await pumpAbout(tester);

    notifier.availableUpdate = update;
    notifier.isInstallingUpdate = true;
    notifier.notifyListeners();
    await tester.pump();

    expect(find.text('Installing…'), findsOneWidget);
    expect(find.text('1.0.4 available'), findsNothing);
  });

  testWidgets('a failed install is said out loud, not swallowed', (
    tester,
  ) async {
    final notifier = await pumpAbout(tester);

    notifier.availableUpdate = update;
    notifier.updateError = 'Could not download and verify Harness 1.0.4.';
    notifier.notifyListeners();
    await tester.pump();

    expect(find.text('Update failed'), findsOneWidget);
    // Still an error about *this* update, so the version it failed on must not
    // read as if it were still simply on offer.
    expect(find.text('1.0.4 available'), findsNothing);
  });
}
