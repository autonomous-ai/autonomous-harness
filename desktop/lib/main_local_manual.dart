import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'auth/auth_session.dart';
import 'core/config.dart';
import 'core/desktop_window.dart';
import 'main.dart' show DesktopApp;
import 'state/app_state.dart';

/// Normal interactive macOS app wired to a disposable local test stack.
///
/// This entrypoint fails closed unless every value is supplied explicitly by
/// `scripts/start-terminal-local-manual.sh`. It is not used by release builds.
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  const enabled = bool.fromEnvironment('LOCAL_TERMINAL_MANUAL');
  const apiBaseUrl = String.fromEnvironment('LOCAL_MANUAL_API_BASE_URL');
  const apiKey = String.fromEnvironment('LOCAL_MANUAL_API_KEY');
  const machineId = String.fromEnvironment('LOCAL_MANUAL_MACHINE_ID');
  const machineName = String.fromEnvironment(
    'LOCAL_MANUAL_MACHINE_NAME',
    defaultValue: 'local-terminal-manual',
  );
  const setupToken = String.fromEnvironment('LOCAL_MANUAL_SETUP_TOKEN');

  if (!enabled ||
      !apiBaseUrl.startsWith('http://127.0.0.1:') ||
      !RegExp(r'^[a-f0-9]{64}$').hasMatch(apiKey) ||
      !RegExp(r'^[a-f0-9]{32}$').hasMatch(machineId) ||
      setupToken.isEmpty) {
    throw StateError(
      'Local manual mode requires its guarded loopback fixture configuration',
    );
  }

  final notifier = AppNotifier(
    config: const AppConfig(apiBaseUrl: apiBaseUrl),
    authSession: AuthSession(),
    localManualFixture: const LocalManualFixture(
      apiBaseUrl: apiBaseUrl,
      apiKey: apiKey,
      machineId: machineId,
      machineName: machineName,
      setupToken: setupToken,
    ),
  );
  notifier.bootstrap();
  await configureDesktopWindow();
  runApp(
    ProviderScope(
      overrides: [appStateProvider.overrideWithValue(notifier)],
      child: const DesktopApp(),
    ),
  );
}
