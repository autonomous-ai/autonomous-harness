// The strip along the window's bottom edge: one figure per agent account, a
// colour once a window is nearly spent, and a panel behind each figure that
// stays open long enough to be read.
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/theme/app_theme.dart';
import 'package:harness/usage/usage_controller.dart';
import 'package:harness/usage/usage_source.dart';
import 'package:harness/usage/usage_window.dart';
import 'package:harness/widgets/status_rail/rail_panel.dart';
import 'package:harness/widgets/status_rail/status_rail.dart';

/// One agent account's rate limits, fixed, so the strip can be read without
/// shelling out to a vendor CLI.
class _StubUsageSource implements UsageSource {
  _StubUsageSource(this.reading);

  final ProviderUsage reading;

  @override
  UsageProvider get provider => reading.provider;

  @override
  Future<ProviderUsage> read() async => reading;
}

/// A Claude account answering with all three of its windows.
const _claude = ProviderUsage(
  provider: UsageProvider.claude,
  status: UsageStatus.ok,
  windows: [
    UsageWindow(label: 'Session', usedPercent: 12),
    UsageWindow(label: 'Weekly', usedPercent: 42),
    UsageWindow(label: 'Fable', usedPercent: 7),
  ],
);

/// The rail at the foot of an empty [window], reading [readings].
///
/// A window the app can actually be: its own minimum is 880px, narrower than
/// the test's default of 800, and the key hints share this strip.
///
/// `autoStart: false` and one explicit [UsageController.refresh]: the live
/// controller starts a periodic timer, and a timer is a `pumpAndSettle` that
/// never settles.
Future<void> _pump(
  WidgetTester tester,
  List<ProviderUsage> readings, {
  Size window = const Size(1280, 720),
}) async {
  tester.view.physicalSize = window;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final usage = UsageController(
    sources: [for (final reading in readings) _StubUsageSource(reading)],
    autoStart: false,
  );
  addTearDown(usage.dispose);
  await usage.refresh();
  final notifier = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
  );
  addTearDown(notifier.dispose);
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Column(
          children: [
            const Spacer(),
            StatusRail(notifier: notifier, usage: usage),
          ],
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

/// Rests a mouse on the Claude figure long enough for its panel to open.
Future<TestGesture> _hoverFigure(WidgetTester tester) async {
  final gesture = await tester.createGesture(kind: PointerDeviceKind.mouse);
  await gesture.addPointer(location: Offset.zero);
  addTearDown(gesture.removePointer);
  await gesture.moveTo(tester.getCenter(find.text('42% used')));
  await tester.pump(const Duration(milliseconds: 200));
  await tester.pumpAndSettle();
  return gesture;
}

void main() {
  testWidgets('the strip reads the agent accounts', (tester) async {
    await _pump(tester, const [
      ProviderUsage(
        provider: UsageProvider.claude,
        status: UsageStatus.ok,
        windows: [UsageWindow(label: 'Session', usedPercent: 12)],
      ),
    ]);

    expect(find.text('12% used'), findsOneWidget);
    // No reset time came back, so the window's own name says which limit the
    // figure belongs to.
    expect(find.text('Session'), findsOneWidget);
  });

  testWidgets('each account prints ONE figure — its weekly window', (
    tester,
  ) async {
    // Claude answers with three windows and Codex with one, so printing them
    // all made one account three figures wide and the other one: two readouts
    // that read as different KINDS of thing rather than the same thing about
    // two accounts. The panel behind the figure still carries every window.
    await _pump(tester, const [_claude]);

    expect(find.text('42% used'), findsOneWidget);
    expect(find.text('12% used'), findsNothing);
    expect(find.text('7% used'), findsNothing);
  });

  testWidgets('a nearly-spent window colours its own figure', (tester) async {
    // The whole point of looking down here unprompted. `19% used` and
    // `92% used` used to print in exactly the same ink, which made the strip
    // useless for the one question it can answer at a glance.
    await _pump(tester, const [
      ProviderUsage(
        provider: UsageProvider.claude,
        status: UsageStatus.ok,
        windows: [UsageWindow(label: 'Weekly', usedPercent: 92)],
      ),
      ProviderUsage(
        provider: UsageProvider.codex,
        status: UsageStatus.ok,
        windows: [UsageWindow(label: 'Weekly', usedPercent: 12)],
      ),
    ]);

    Color inkOf(String text) =>
        tester.widget<Text>(find.text(text)).style!.color!;
    expect(inkOf('12% used'), grid.AppPalette.textSecondary);
    expect(inkOf('92% used'), AppColors.danger);
  });

  testWidgets('and warns in amber before it turns red', (tester) async {
    await _pump(tester, const [
      ProviderUsage(
        provider: UsageProvider.claude,
        status: UsageStatus.ok,
        windows: [UsageWindow(label: 'Weekly', usedPercent: 84)],
      ),
    ]);

    expect(
      tester.widget<Text>(find.text('84% used')).style!.color,
      grid.AppPalette.warn,
    );
  });

  testWidgets('an account nobody signed into here leaves the strip empty', (
    tester,
  ) async {
    await _pump(tester, const [
      ProviderUsage(
        provider: UsageProvider.claude,
        status: UsageStatus.signedOut,
        message: 'Sign in to Claude to see usage',
      ),
    ]);

    // A figure-shaped blank that will never fill is worse than nothing, so an
    // account with no session contributes no figures at all — the reason there
    // are none belongs in the panel, where there is room to say it.
    expect(find.textContaining('% used'), findsNothing);
  });

  group('the panel behind a figure', () {
    testWidgets('opens on hover, with every window the strip left out', (
      tester,
    ) async {
      await _pump(tester, const [_claude]);
      await _hoverFigure(tester);

      expect(find.byType(RailPanelSurface), findsOneWidget);
      expect(find.text('Claude'), findsOneWidget);
      // The strip prints the weekly window alone; the panel is where the rest
      // are.
      expect(find.text('Session'), findsOneWidget);
      expect(find.text('Fable'), findsOneWidget);
    });

    testWidgets('is a card, not the window', (tester) async {
      // The bug this pins: an OverlayEntry whose `Positioned` has no offsets is
      // a NON-positioned overlay child, and those are laid out with tight
      // constraints — the panel then covered the whole window and its own
      // width was ignored.
      await _pump(tester, const [_claude], window: const Size(1000, 460));
      await _hoverFigure(tester);

      final panel = tester.getRect(find.byType(RailPanelSurface));
      expect(panel.width, 248);
      // Its own height, not the window's — which is what the bug looked like.
      final window = tester.getRect(find.byType(MaterialApp));
      expect(panel.height, lessThan(window.height));
      // It opens UPWARD: there is nothing below a strip on the window's bottom
      // edge.
      final rail = tester.getRect(find.byType(StatusRail));
      expect(panel.bottom, lessThanOrEqualTo(rail.top + 1));
    });

    testWidgets('the pointer survives the gap between figure and panel', (
      tester,
    ) async {
      // The panel hangs 8px above the rail, and a pointer reaching it crosses
      // that band — which belongs to neither. Without a beat of grace the panel
      // closed there, so nothing inside it could be reached.
      await _pump(tester, const [_claude], window: const Size(1000, 460));
      final gesture = await _hoverFigure(tester);
      expect(find.byType(RailPanelSurface), findsOneWidget);

      // Into the dead band between the two.
      final rail = tester.getRect(find.byType(StatusRail));
      final panel = tester.getRect(find.byType(RailPanelSurface));
      await gesture.moveTo(
        Offset(panel.center.dx, (panel.bottom + rail.top) / 2),
      );
      await tester.pump(const Duration(milliseconds: 60));
      expect(find.byType(RailPanelSurface), findsOneWidget);

      // And onto the panel, which claims it before the grace runs out.
      await gesture.moveTo(panel.center);
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pumpAndSettle();
      expect(find.byType(RailPanelSurface), findsOneWidget);
    });

    testWidgets('a pointer that keeps going closes it', (tester) async {
      // The grace is a beat, not a latch.
      await _pump(tester, const [_claude]);
      final gesture = await _hoverFigure(tester);
      expect(find.byType(RailPanelSurface), findsOneWidget);

      await gesture.moveTo(const Offset(500, 20));
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pumpAndSettle();
      expect(find.byType(RailPanelSurface), findsNothing);
    });

    testWidgets('a click pins it, so the pointer can leave', (tester) async {
      await _pump(tester, const [_claude]);
      // Measured before the panel opens: the panel prints the same figure, and
      // the tap has to land on the rail's.
      final figure = tester.getCenter(find.text('42% used'));
      final gesture = await _hoverFigure(tester);
      await tester.tapAt(figure);
      await tester.pumpAndSettle();

      // Pointer well away, panel still up.
      await gesture.moveTo(const Offset(500, 20));
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pumpAndSettle();
      expect(find.byType(RailPanelSurface), findsOneWidget);
    });
  });
}
