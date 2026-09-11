// Folding the rail must never strand the user.
//
// The control that folds it is IN it, so hiding the rail outright would take
// the way back with it — the failure this guards is a window with no visible
// route to its own sidebar. Both routes are checked: the button that appears in
// the folded rail, and the shortcut its tooltip promises.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:package_info_plus/package_info_plus.dart';

import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/home_screen.dart';
import 'package:harness/shared/theme/app_theme.dart';
import 'package:harness/state/app_state.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  PackageInfo.setMockInitialValues(
    appName: 'Harness',
    packageName: 'ai.autonomous.harness',
    version: '1.0.0',
    buildNumber: '1',
    buildSignature: '',
  );

  testWidgets('folding the rail leaves a way back', (tester) async {
    const machine = Machine(
      machineId: 'm1',
      apiKey: '',
      authMode: MachineAuthMode.remote,
      name: 'MacBook-Pro.local',
      status: 'online',
    );
    final notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    final state = MachineState(machine)
      ..connectionStatus = ConnectionStatus.connected
      ..nodeOnline = true
      ..terminalCapabilityLoaded = true
      ..terminalCapabilityAvailable = true
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..agents = [
        Agent.fromJson({
          'id': 'a1',
          'name': 'Worldcup dc to chuc',
          'engine': 'claude',
          'terminal': {
            'runtimes': [
              {'backend': 'tmux', 'paneId': '%1'},
            ],
          },
        }),
      ];
    notifier.machines = [machine];
    notifier.machineStates[machine.machineId] = state;
    notifier.expandedMachines.add(machine.machineId);

    tester.view.physicalSize = const Size(760 * 2, 560 * 2);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      ProviderScope(
        child: MaterialApp(
          theme: buildAppTheme(brightness: Brightness.dark),
          home: Builder(
            builder: (context) {
              AppTheme.brightness.value = Brightness.dark;
              return BrightnessScope(child: HomeScreen(notifier: notifier));
            },
          ),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 300));

    final collapse = find.byTooltip('Collapse sidebar  ⌘\\');
    expect(collapse, findsOneWidget, reason: 'nút thu gọn phải có mặt');
    await tester.tap(collapse);
    // settle, not a fixed pump: the fold is animated now, and a single frame
    // lands mid-crossfade where both rails are mounted.
    await tester.pumpAndSettle();

    expect(
      find.byTooltip('Expand sidebar  ⌘\\'),
      findsOneWidget,
      reason: 'gấp rồi vẫn phải còn đường mở lại',
    );
    // Phím tắt phải chạy thật: tooltip đang hứa ⌘\\
    await tester.sendKeyDownEvent(LogicalKeyboardKey.meta);
    await tester.sendKeyEvent(LogicalKeyboardKey.backslash);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.meta);
    await tester.pumpAndSettle();
    expect(
      find.byTooltip('Collapse sidebar  ⌘\\'),
      findsOneWidget,
      reason: '⌘\\ phải mở lại rail',
    );
  });
}
