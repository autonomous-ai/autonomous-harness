import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/bootstrapping_screen.dart';
import 'package:harness/widgets/login_relay_diagram.dart';

Widget _host({
  String? message,
  bool reduceMotion = false,
  double textScale = 1,
}) {
  grid.AppTheme.brightness.value = Brightness.dark;
  return MaterialApp(
    theme: grid.buildAppTheme(brightness: Brightness.dark),
    home: MediaQuery(
      data: MediaQueryData(
        size: const Size(880, 560),
        disableAnimations: reduceMotion,
        textScaler: TextScaler.linear(textScale),
      ),
      child: grid.BrightnessScope(
        child: BootstrappingScreen(statusMessage: message),
      ),
    ),
  );
}

void main() {
  testWidgets('uses the app visual language and a truthful fallback status', (
    tester,
  ) async {
    await tester.pumpWidget(_host());
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.byType(LoginAurora), findsOneWidget);
    expect(find.text('Getting Harness ready'), findsOneWidget);
    expect(find.text('Opening Harness…'), findsOneWidget);
    expect(find.textContaining('few seconds'), findsOneWidget);

    final logo = tester.widget<Image>(find.byType(Image));
    expect((logo.image as AssetImage).assetName, 'assets/app_icon.png');
  });

  testWidgets('shows the daemon status as an accessible live update', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();

    await tester.pumpWidget(_host(message: 'Starting local service…'));
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.text('Starting local service…'), findsOneWidget);
    expect(find.bySemanticsLabel('Harness startup status'), findsOneWidget);
    final node = tester.getSemantics(find.byKey(const Key('boot-status')));
    expect(node.value, 'Starting local service…');
    semantics.dispose();
  });

  testWidgets('Reduce Motion freezes the indeterminate indicator', (
    tester,
  ) async {
    await tester.pumpWidget(_host(reduceMotion: true));
    await tester.pump(const Duration(milliseconds: 300));

    final ticker = tester.widget<TickerMode>(
      find.byKey(const Key('boot-status-ticker')),
    );
    expect(ticker.enabled, isFalse);
  });

  testWidgets('fits the minimum window at the largest supported UI scale', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(880, 560);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);

    await tester.pumpWidget(_host(textScale: 19 / 14));
    await tester.pump(const Duration(milliseconds: 100));

    expect(tester.takeException(), isNull);
    expect(find.text('Getting Harness ready'), findsOneWidget);
    expect(find.text('Opening Harness…'), findsOneWidget);
  });
}
