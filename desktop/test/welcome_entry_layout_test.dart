import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;

import 'support/real_fonts.dart';
import 'swarm_state_test.dart' show createApp;
import 'swarm_screen_test.dart' show terminal;

import 'package:harness/core/models.dart';

void main() {
  setUpAll(() async {
    await loadRealFonts();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
    await (FontLoader('packages/lucide_icons_flutter/Lucide300')..addFont(
          rootBundle.load(
            'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w300.ttf',
          ),
        ))
        .load();
  });
  for (final (width, height, scale) in [
    (1280.0, 800.0, 1.0),
    (760.0, 900.0, 1.0),
    (880.0, 560.0, 1.0),
    (600.0, 900.0, 1.7),
  ]) {
    testWidgets(
      'start page and inline search remain usable at $width with text scale $scale',
      (tester) async {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = Size(width, height);
        addTearDown(tester.view.reset);
        final app = createApp();
        app.machineStates['m']!.nodeOnline = true;
        for (var i = 0; i < 6; i++) {
          final name = [
            'Harness desktop',
            'NYC chess set',
            'Marketing',
            'Landing page',
            'Training H1',
            'New onboarding',
          ][i];
          app.machineStates['m']!.agents[i] = Agent(
            id: 'a$i',
            name: name,
            engine: i.isEven ? 'codex' : 'claude',
            terminalAvailable: true,
            project: const AgentProject(
              name: 'autonomous-harness',
              branch: 'main',
              cwd: '/work/autonomous-harness',
            ),
          );
          app.adoptSessionForTest(terminal('a$i', []));
        }
        app.newSwarm();
        final boundaryKey = GlobalKey();
        await tester.pumpWidget(
          RepaintBoundary(
            key: boundaryKey,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: grid.buildAppTheme(brightness: Brightness.dark),
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(context)
                    .copyWith(textScaler: TextScaler.linear(scale)),
                child: child!,
              ),
              home: SwarmScreen(notifier: app, nativeTabs: false),
            ),
          ),
        );
        await tester.pumpAndSettle();
        if (Platform.environment['HARNESS_ENTRY_CAPTURE_DIR'] != null) {
          await tester.runAsync(() async {
            final context = tester.element(find.byType(SwarmScreen));
            // Only the device image: the ground behind the page is drawn
            // (swarm_wallpaper.dart), not loaded.
            await precacheImage(
              const AssetImage('assets/harness_device_studio.png'),
              context,
            );
          });
          await tester.pump();
        }
        final field = find.byKey(const ValueKey('harness-start-search'));
        final create = find.byKey(const ValueKey('harness-start-new'));
        final open = find.byKey(const ValueKey('harness-start-open'));
        final device = find.byKey(const ValueKey('harness-device-link'));
        final store = find.byKey(const ValueKey('harness-store-link'));
        expect(find.text('Harness'), findsNothing);
        expect(
          tester.widget<TextField>(field).decoration!.hintText,
          'Find a harness',
        );
        expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
        expect(find.byType(ListTile), findsNothing);
        final fieldRect = tester.getRect(field);
        final createRect = tester.getRect(create);
        final openRect = tester.getRect(open);
        final deviceRect = tester.getRect(device);
        final storeRect = tester.getRect(store);
        expect(createRect.center.dy, closeTo(openRect.center.dy, 1));
        expect(openRect.top, greaterThan(fieldRect.bottom));
        expect(openRect.left, closeTo(fieldRect.left, 1));
        expect(createRect.left, greaterThan(openRect.right));
        expect(fieldRect.center.dx, closeTo(width / 2, 1));
        // The store card leads the footer row under the search; the device
        // card follows it on the same row, never wrapped below it.
        expect(storeRect.left, closeTo(fieldRect.left, 1));
        expect(deviceRect.left, closeTo(storeRect.right + 16, 1));
        expect(deviceRect.bottom, closeTo(height - 80, 1));
        expect(storeRect.bottom, closeTo(height - 80, 1));
        expect(find.text('Meet the\nHarness device'), findsOneWidget);
        expect(create.hitTestable(), findsOneWidget);
        expect(open.hitTestable(), findsOneWidget);
        expect(createRect.bottom, lessThanOrEqualTo(height));
        expect(openRect.bottom, lessThanOrEqualTo(height));
        expect(deviceRect.top, greaterThanOrEqualTo(createRect.bottom + 24));
        final output = Platform.environment['HARNESS_ENTRY_CAPTURE_DIR'];
        if (output != null) {
          final boundary =
              boundaryKey.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          await tester.runAsync(() async {
            final image = await boundary.toImage(pixelRatio: 1);
            final bytes = await image.toByteData(
              format: ui.ImageByteFormat.png,
            );
            await Directory(output).create(recursive: true);
            await File(
              '$output/entry-${width.toInt()}-${scale.toStringAsFixed(1)}.png',
            ).writeAsBytes(bytes!.buffer.asUint8List());
            image.dispose();
          });
        }
        expect(tester.takeException(), isNull);
        await tester.tap(field);
        await tester.enterText(field, 'Test host');
        await tester.pump();
        final results = find.byKey(const ValueKey('harness-start-results'));
        expect(results, findsOneWidget);
        expect(tester.getRect(results).height, greaterThan(140));
        expect(tester.getRect(results).width, tester.getRect(field).width);
        expect(tester.getRect(field).left, closeTo(fieldRect.left, 1));
        expect(tester.getRect(field).right, closeTo(fieldRect.right, 1));
        expect(tester.getRect(field).top, closeTo(fieldRect.top, 1));
        expect(tester.getRect(device), deviceRect);
        expect(
          tester.getRect(results).bottom,
          lessThanOrEqualTo(deviceRect.top - 24),
        );
        expect(create, findsNothing);
        expect(open, findsNothing);
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pump();
        expect(tester.getRect(field).width, closeTo(fieldRect.width, 1));
        expect(tester.getRect(device), deviceRect);
        await tester.ensureVisible(create);
        expect(create.hitTestable(), findsOneWidget);
        await tester.tap(create);
        await tester.pumpAndSettle();
        expect(find.byType(AlertDialog), findsOneWidget);
        expect(results, findsNothing);
        expect(tester.takeException(), isNull);
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        expect(find.byType(AlertDialog), findsNothing);
        expect(tester.widget<TextField>(field).focusNode!.hasFocus, isFalse);
        await tester.ensureVisible(device);
        await tester.pumpAndSettle();
        expect(device.hitTestable(), findsOneWidget);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      },
    );
  }
}
