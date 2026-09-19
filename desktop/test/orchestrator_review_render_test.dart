import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/orchestrator/orchestrator_launcher.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';

import 'support/real_fonts.dart';
import 'swarm_state_test.dart' show MemoryStore;

class _ReviewApp extends AppNotifier {
  _ReviewApp()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(storage: MemoryStore()),
      ) {
    const machine = Machine(
      machineId: 'review',
      name: 'Review fixture',
      authMode: MachineAuthMode.remote,
    );
    machines = [machine];
    machineStates['review'] = MachineState(machine)..localOnly = true;
  }

  @override
  Future<Map<String, dynamic>> orchestratorRequest(
    String machineId,
    Map<String, dynamic> payload,
  ) async {
    // Rendering must never start an agent or contact the user's daemon.
    expect(payload['action'], 'list');
    return {'projects': <Map<String, dynamic>>[]};
  }
}

void main() {
  setUpAll(() async {
    await loadRealFonts();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
    await (FontLoader('packages/lucide_icons_flutter/Lucide')..addFont(
          rootBundle.load('packages/lucide_icons_flutter/assets/lucide.ttf'),
        ))
        .load();
    // Widget tests disable native font fallback. Supply symbol glyphs under
    // fallback names already used by the production theme, only in this test.
    final symbols = File('/System/Library/Fonts/Apple Symbols.ttf');
    if (symbols.existsSync()) {
      for (final family in ['Helvetica Neue', 'Noto Sans']) {
        await (FontLoader(
          family,
        )..addFont(symbols.readAsBytes().then(ByteData.sublistView))).load();
      }
    }
  });

  // Match the dark-only desktop shell, including its global color tokens.
  for (final size in [const Size(1280, 850), const Size(600, 700)]) {
    testWidgets('Orchestrator launcher fits $size', (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = size;
      addTearDown(tester.view.reset);
      final app = _ReviewApp();
      final key = GlobalKey();
      addTearDown(() async {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      });
      await tester.pumpWidget(
        RepaintBoundary(
          key: key,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: Brightness.dark),
            home: Scaffold(body: OrchestratorLauncher(notifier: app)),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('orchestrator-prompt')),
        'Create a small desk token and a perfectly fitted holder. Use Solid '
        'for the token, then Workshop to build around the exact CAD output. '
        'Verify the clearance and keep each version.',
      );
      await tester.pumpAndSettle();
      final start = find.byKey(const ValueKey('orchestrator-start'));
      await tester.ensureVisible(start);
      expect(start.hitTestable(), findsOneWidget);
      expect(tester.widget<FilledButton>(start).onPressed, isNotNull);
      expect(tester.takeException(), isNull);
      final output = Platform.environment['HARNESS_ORCHESTRATOR_CAPTURE_DIR'];
      if (output != null) {
        final boundary =
            key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
        await tester.runAsync(() async {
          final image = await boundary.toImage(pixelRatio: 1);
          try {
            final bytes = await image.toByteData(
              format: ui.ImageByteFormat.png,
            );
            await Directory(output).create(recursive: true);
            await File('$output/launcher-dark-${size.width.toInt()}.png')
                .writeAsBytes(bytes!.buffer.asUint8List());
          } finally {
            image.dispose();
          }
        });
      }
    });
  }
}
