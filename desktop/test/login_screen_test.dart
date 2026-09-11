import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/core/config.dart';
import 'package:harness/screens/login_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/login_relay_diagram.dart';

/// Wraps the screen in the same chrome `main.dart` gives it, at the app's
/// minimum window size — 880×560 — because that is where a card gets cramped
/// and nowhere else.
Widget _host(
  AppNotifier app, {
  Brightness brightness = Brightness.light,
  bool reduceMotion = false,
}) {
  return MaterialApp(
    theme: grid.buildAppTheme(brightness: brightness),
    home: MediaQuery(
      data: MediaQueryData(
        size: const Size(880, 560),
        disableAnimations: reduceMotion,
      ),
      child: grid.BrightnessScope(child: LoginScreen(notifier: app)),
    ),
  );
}

/// A login that fails without shelling out. The real one starts a `harness`
/// process, which a unit test must never do — it would block on a binary the
/// machine may not have.
class _FailingCliLogin extends CliLogin {
  @override
  Future<void> login({
    required void Function(String url) onAuthorizeUrl,
  }) async {
    throw CliNotAvailableException('Could not run the harness CLI');
  }
}

AppNotifier _notifier(AppStatus status, {CliLogin? cliLogin}) {
  grid.AppTheme.brightness.value = Brightness.light;
  return AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
    cliLogin: cliLogin,
  )..status = status;
}

/// WCAG 2.x relative luminance and contrast — the same arithmetic as
/// `tool/contrast.py`, inlined so the guard runs in the normal suite.
double _luminance(Color c) {
  double channel(double v) =>
      v <= 0.03928 ? v / 12.92 : math.pow((v + 0.055) / 1.055, 2.4).toDouble();
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

double _contrast(Color a, Color b) {
  final la = _luminance(a);
  final lb = _luminance(b);
  final (hi, lo) = la > lb ? (la, lb) : (lb, la);
  return (hi + 0.05) / (lo + 0.05);
}

void main() {
  testWidgets('idle offers the action and says what it costs', (tester) async {
    final app = _notifier(AppStatus.unauthenticated);
    await tester.pumpWidget(_host(app));
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.text('All your agents, on one screen'), findsOneWidget);
    expect(find.text('Sign in'), findsOneWidget);
    expect(find.byType(LoginRelayDiagram), findsOneWidget);
    // The real mark, from the bundle — `Icons.memory` used to stand here and
    // appeared nowhere else in the app.
    final logo = tester.widget<Image>(find.byType(Image));
    expect((logo.image as AssetImage).assetName, 'assets/app_icon.png');
    // The promise the screen exists to make, in words with no jargon in them.
    expect(find.textContaining('one window onto all of them'), findsOneWidget);
    expect(find.textContaining('SSO'), findsOneWidget);
    expect(find.textContaining('End-to-end encrypted'), findsOneWidget);
  });

  testWidgets('the browser wait is a state of the button, not a new screen', (
    tester,
  ) async {
    // `signingIn` is what `main.dart` routes on — see the note there.
    final app = _notifier(AppStatus.bootstrapping)..signingIn = true;
    await tester.pumpWidget(_host(app));
    await tester.pump(const Duration(milliseconds: 100));

    // Still the same card — the diagram never leaves, so the frame can't jump.
    expect(find.byType(LoginRelayDiagram), findsOneWidget);
    expect(find.text('Waiting for your browser'), findsOneWidget);
    expect(find.text('Cancel'), findsOneWidget);
    // The idle label is gone, so the two states cannot both be on screen.
    expect(find.text('Sign in'), findsNothing);

    final button = tester.widget<FilledButton>(find.byType(FilledButton));
    expect(button.onPressed, isNull, reason: 'in-flight, so not pressable');
  });

  testWidgets('a failure names itself and offers a way on', (tester) async {
    final app = _notifier(
      AppStatus.unauthenticated,
      cliLogin: _FailingCliLogin(),
    );
    // Drive the notifier's real failure path rather than setting the field, so
    // the test breaks if that path ever stops recording the error.
    await app.login();
    await tester.pumpWidget(_host(app));
    await tester.pump(const Duration(milliseconds: 100));

    expect(app.lastError, isNotNull, reason: 'the fake CLI always fails');
    expect(find.text('Could not sign in'), findsOneWidget);
    expect(find.text('Try again'), findsOneWidget);
  });

  testWidgets('the diagram keeps running, frame after frame', (tester) async {
    final app = _notifier(AppStatus.unauthenticated);
    await tester.pumpWidget(_host(app));

    // ⚠️ NEVER `pumpAndSettle` on this screen. The diagram and the aurora both
    // repeat forever — deliberately — and `pumpAndSettle` waits for a frame
    // that never comes. Pump fixed durations instead, the same way the app's
    // other endless animations (`Pulse`, a `CircularProgressIndicator`) are
    // tested. Reduce Motion is the one case that does settle; see below.
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Sign in'), findsOneWidget);

    // Still animating a full cycle later, rather than having stopped.
    await tester.pump(const Duration(milliseconds: 3200));
    expect(find.text('Sign in'), findsOneWidget);
    expect(tester.binding.hasScheduledFrame, isTrue);
  });

  testWidgets('Reduce Motion still shows the picture, not a blank', (
    tester,
  ) async {
    final app = _notifier(AppStatus.unauthenticated);
    await tester.pumpWidget(_host(app, reduceMotion: true));
    // The one case that DOES settle: with animations disabled both clocks are
    // parked, so there is no endless frame loop to wait on.
    await tester.pumpAndSettle();

    // The point of the parked frame: it is mid-story, so a still viewer still
    // sees packets on the wires rather than an empty diagram.
    expect(find.byType(LoginRelayDiagram), findsOneWidget);
    expect(find.text('Sign in'), findsOneWidget);
  });

  testWidgets('holds at the 880x560 minimum window without overflowing', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(880, 560);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    final app = _notifier(AppStatus.unauthenticated);
    await tester.pumpWidget(_host(app));
    await tester.pump(const Duration(milliseconds: 100));

    expect(tester.takeException(), isNull);
    expect(find.text('Sign in'), findsOneWidget);
  });

  test('the diagram\'s caption clears the body-text contrast floor', () {
    // Measured with tool/contrast.py, pinned here so a later "let\'s soften
    // that grey" is caught by the suite rather than by a user who cannot read
    // the one sentence the drawing exists to make. WCAG 1.4.3 asks 4.5:1.
    //
    // `textFaint` was the first choice and measured 3.33:1 light / 3.18:1 dark
    // against the hub — under the floor in BOTH themes.
    for (final (name, brightness, ink, ground) in [
      (
        'light',
        Brightness.light,
        const Color(0xFF62615B),
        const Color(0xFFFFFFFF),
      ),
      (
        'dark',
        Brightness.dark,
        const Color(0xFFA8A8A2),
        const Color(0xFF202020),
      ),
    ]) {
      grid.AppTheme.brightness.value = brightness;
      expect(
        grid.AppPalette.textSecondary,
        ink,
        reason: '$name: the caption token moved',
      );
      expect(
        _contrast(ink, ground),
        greaterThanOrEqualTo(4.5),
        reason: '$name: caption fell under the body-text floor',
      );
    }
    grid.AppTheme.brightness.value = Brightness.light;
  });

  testWidgets('the card survives the whole sign-in, URL or no URL', (
    tester,
  ) async {
    // The regression this guards: `RootShell` and this screen both used to key
    // the wait off `pendingAuthorizeUrl`, which only exists for the MIDDLE of
    // the flow. The CLI has to start before it can print a URL, and the URL is
    // cleared again while the post-login restore runs — so the user's own
    // screen was replaced by a bare full-screen spinner twice per sign-in.
    final app = _notifier(AppStatus.bootstrapping)..signingIn = true;
    await tester.pumpWidget(_host(app));
    await tester.pump(const Duration(milliseconds: 100));

    // Just pressed: in flight, no URL yet.
    expect(app.pendingAuthorizeUrl, isNull);
    expect(find.text('Waiting for your browser'), findsOneWidget);
    expect(find.byType(LoginRelayDiagram), findsOneWidget);

    // The CLI hands one over; nothing about the screen should change.
    app.pendingAuthorizeUrl = 'https://auth.example/authorize';
    app.notifyListeners();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('Waiting for your browser'), findsOneWidget);
    expect(find.byType(LoginRelayDiagram), findsOneWidget);

    // Signed in: the URL goes while the restore is still running. The card has
    // to hold until the shell is actually ready.
    app.pendingAuthorizeUrl = null;
    app.notifyListeners();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.byType(LoginRelayDiagram), findsOneWidget);
  });

  test('every frame of the diagram carries a sealed packet', () {
    // The seal — plaintext dot becoming a glowing block — is the one beat this
    // drawing exists to make, so it must be on screen whenever someone looks.
    //
    // The first stagger (0.075) bunched all three lanes into the same state:
    // half of every cycle had no sealed packet at all, and only 4% of frames
    // showed a plain dot and a sealed block together. These are the constants
    // from `login_relay_diagram.dart`, checked here because they are a
    // relationship between four numbers rather than one value to eyeball.
    const stagger = 1 / 3;
    const sealStart = 0.26, sealEnd = 0.38, travelEnd = 0.72, gone = 0.88;

    var framesWithoutSeal = 0;
    var framesShowingBoth = 0;
    for (var i = 0; i < 200; i++) {
      final t = i / 200;
      final phases = [
        for (var lane = 0; lane < 3; lane++) (t - lane * stagger) % 1.0,
      ];
      final sealed = phases.where((p) => p >= sealEnd && p < travelEnd).length;
      final plain = phases.where((p) => p > 0 && p < sealStart).length;
      if (sealed == 0) framesWithoutSeal++;
      if (sealed >= 1 && plain >= 1) framesShowingBoth++;
      expect(
        phases.where((p) => p > 0 && p < gone).length,
        greaterThan(0),
        reason: 'the diagram went empty at t=\$t',
      );
    }

    expect(framesWithoutSeal, 0, reason: 'a frame had no sealed packet');
    expect(
      framesShowingBoth / 200,
      greaterThan(0.6),
      reason: 'too few frames show plaintext and ciphertext side by side',
    );
  });

  testWidgets('dark is drawn deliberately, not inherited', (tester) async {
    final app = _notifier(AppStatus.unauthenticated);
    // After the notifier, which resets the global to light for the other tests.
    grid.AppTheme.brightness.value = Brightness.dark;
    addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
    await tester.pumpWidget(_host(app, brightness: Brightness.dark));
    await tester.pump(const Duration(milliseconds: 100));

    final scaffold = tester.widget<Scaffold>(find.byType(Scaffold));
    // Law 5: the screen wears the dark panel, not a frozen light constant.
    // `panelBg`, not `windowBg` — in light the two ends of that pair are pure
    // white and the card would have nothing to sit on.
    expect(scaffold.backgroundColor, const Color(0xFF141414));
    expect(find.text('Sign in'), findsOneWidget);
  });
}
