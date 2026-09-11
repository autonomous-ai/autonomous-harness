import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart';
import 'package:harness/shared/widgets/app_menu.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/account_footer.dart';

/// The account menu's rows.
///
/// Only the destructive treatment is asserted here, and deliberately so: it is
/// the one property of this menu that carries *meaning* rather than taste. Sign
/// out ends the session, and it sat for a long time in exactly the same ink as
/// Settings — the row above it, which does nothing of the kind. A test that
/// pinned the padding or the font size would fail on every future tune-up
/// without ever catching that.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<AppNotifier> pumpMenu(
    WidgetTester tester, {
    required Brightness brightness,
  }) async {
    final notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    notifier.currentUser = const CurrentUserProfile(
      name: 'Tony at Autonomous',
      email: 'tony@autonomous.ai',
    );
    addTearDown(notifier.dispose);

    tester.view.physicalSize = const Size(900 * 2, 700 * 2);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(brightness: brightness),
        home: Scaffold(
          // The footer sits at the bottom of a rail; the menu opens upward, so
          // it needs room above it to land in.
          body: Align(
            alignment: Alignment.bottomLeft,
            child: SizedBox(
              width: 240,
              child: AccountFooter(notifier: notifier),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.byKey(const Key('account-menu-button')));
    await tester.pumpAndSettle();
    return notifier;
  }

  AppMenuItem itemByKey(WidgetTester tester, String key) =>
      tester.widget<AppMenuItem>(find.byKey(Key(key)));

  for (final brightness in Brightness.values) {
    final label = brightness == Brightness.dark ? 'dark' : 'light';

    testWidgets('sign out is the only destructive row ($label)', (
      tester,
    ) async {
      await pumpMenu(tester, brightness: brightness);

      expect(itemByKey(tester, 'sign-out-menu-item').danger, isTrue);
      // The two rows that merely NAVIGATE must not borrow the treatment — a
      // menu where everything is red says nothing is.
      expect(itemByKey(tester, 'settings-menu-item').danger, isFalse);
      expect(itemByKey(tester, 'link-a-machine-menu-item').danger, isFalse);
    });

    testWidgets('sign out draws in the error ink ($label)', (tester) async {
      await pumpMenu(tester, brightness: brightness);

      final context = tester.element(
        find.byKey(const Key('sign-out-menu-item')),
      );
      final error = Theme.of(context).colorScheme.error;
      final text = tester.widget<Text>(
        find.descendant(
          of: find.byKey(const Key('sign-out-menu-item')),
          matching: find.text('Sign out'),
        ),
      );

      expect(text.style?.color, error);
      // Not the ink every other row takes — the assertion above would pass by
      // accident if the two ever resolved to the same value.
      expect(text.style?.color, isNot(AppPalette.textPrimary));
    });
  }

  // The provider pill used to stand on the rail's floor; a row here briefly
  // replaced it, and that went too. Settings is the one door onto the pane —
  // two rows opening one screen, one directly above the other, is two rows that
  // are both right and neither of which says which to press.
  testWidgets('no provider row: Settings is the only way to that pane', (
    tester,
  ) async {
    await pumpMenu(tester, brightness: Brightness.dark);

    expect(find.byKey(const Key('providers-menu-item')), findsNothing);
    expect(find.text('Where new agents run…'), findsNothing);
    expect(find.text('Providers'), findsNothing);
    expect(find.byKey(const Key('settings-menu-item')), findsOneWidget);
  });

  testWidgets('the summary names the account above its address', (
    tester,
  ) async {
    await pumpMenu(tester, brightness: Brightness.dark);

    expect(find.text('Tony at Autonomous'), findsOneWidget);
    // Twice: once in the pill that opened the menu, once in the panel's summary.
    expect(find.text('tony@autonomous.ai'), findsNWidgets(2));
  });
}
