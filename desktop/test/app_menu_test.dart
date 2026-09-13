import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/main.dart';
import 'package:harness/settings/settings_screen.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_preset.dart';

import 'swarm_state_test.dart' show createApp;

Future<void> _menu(WidgetTester tester, String method) {
  final result = Completer<void>();
  const codec = StandardMethodCodec();
  tester.binding.defaultBinaryMessenger.handlePlatformMessage(
    'harness/app_menu',
    codec.encodeMethodCall(MethodCall(method)),
    (reply) {
      try {
        codec.decodeEnvelope(reply!);
        result.complete();
      } catch (error, stack) {
        result.completeError(error, stack);
      }
    },
  );
  return result.future;
}

Future<void> _mount(WidgetTester tester, AppNotifier app) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(1280, 800);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  app.status = AppStatus.authenticated;
  await tester.pumpWidget(
    ProviderScope(
      overrides: [appStateProvider.overrideWithValue(app)],
      child: const DesktopApp(),
    ),
  );
  await tester.pump();
}

void main() {
  testWidgets('held app menu commands open only one dialog', (tester) async {
    final app = createApp();
    await _mount(tester, app);
    final first = _menu(tester, 'showShortcuts');
    final repeated = _menu(tester, 'showShortcuts');
    await tester.pump(const Duration(milliseconds: 300));
    await repeated;
    expect(find.byType(Dialog), findsOneWidget);
    await _menu(tester, 'showLayout');
    await _menu(tester, 'flashFirmware');
    expect(find.byType(Dialog), findsOneWidget);
    Navigator.of(tester.element(find.byType(Dialog))).pop();
    await tester.pump(const Duration(milliseconds: 300));
    await first;
    expect(find.byType(Dialog), findsNothing);
    final reopened = _menu(tester, 'showShortcuts');
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byType(Dialog), findsOneWidget);
    Navigator.of(tester.element(find.byType(Dialog))).pop();
    await tester.pump(const Duration(milliseconds: 300));
    await reopened;
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets('repeated layout menu shortcut cycles the visible palette', (
    tester,
  ) async {
    final app = createApp();
    for (var i = 0; i < 3; i++) {
      await app.addAgentToSwarm('m', 'a$i');
    }
    await _mount(tester, app);
    final before = app.presetFor(3);
    final opened = _menu(tester, 'showLayout');
    final beforeFirstFrame = _menu(tester, 'showLayout');
    await tester.pump(const Duration(milliseconds: 300));
    await beforeFirstFrame;
    await _menu(tester, 'showLayout');
    await _menu(tester, 'showShortcuts');
    await tester.pump();
    expect(find.byType(Dialog), findsOneWidget);
    expect(app.presetFor(3), before);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump(const Duration(milliseconds: 300));
    await opened;
    expect(app.presetFor(3), PanePreset.forCount(3)[1]);
    expect(find.byType(Dialog), findsNothing);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets('app menu dialogs do not open over Settings', (tester) async {
    final app = createApp();
    await _mount(tester, app);
    await tester.tap(find.byTooltip('Settings  ⌘,'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byType(SettingsScreen), findsOneWidget);
    for (final method in ['showShortcuts', 'showLayout', 'flashFirmware']) {
      await _menu(tester, method);
    }
    await tester.pump();
    expect(find.byType(Dialog), findsNothing);
    expect(find.byType(SettingsScreen), findsOneWidget);
    Navigator.of(tester.element(find.byType(SettingsScreen))).pop();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });
}
