// Escape out of "Edit name" took the whole window to a red screen. The dialog
// made its controller beside `showDialog` and disposed it the moment that
// future resolved — which is when the route STARTS animating out, with the
// dialog still on screen and still rebuilding. The first rebuild after the
// dispose threw "A TextEditingController was used after being disposed".
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/rename_agent_dialog.dart';

void main() {
  testWidgets('escaping the rename dialog does not use a disposed controller', (
    tester,
  ) async {
    final notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    addTearDown(notifier.dispose);
    notifier.machineStates['m1'] = MachineState(
      const Machine(
        machineId: 'm1',
        apiKey: '',
        authMode: MachineAuthMode.remote,
        name: 'm1',
        status: 'online',
      ),
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showAgentRenameDialog(
                context,
                notifier,
                'm1',
                'a1',
                'agent-one',
              ),
              child: const Text('rename'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('rename'));
    await tester.pumpAndSettle();
    expect(find.text('Edit name'), findsOneWidget);

    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    // Pumped through the WHOLE exit transition, which is the window the bug
    // lived in: one pump would settle before the rebuild that threw.
    await tester.pumpAndSettle();

    expect(find.text('Edit name'), findsNothing);
    expect(
      tester.takeException(),
      isNull,
      reason: 'a dialog closing must not take the app down with it',
    );
  });

  testWidgets('the name it opens on is the one it was given', (tester) async {
    final notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    addTearDown(notifier.dispose);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showAgentRenameDialog(
                context,
                notifier,
                'm1',
                'a1',
                'agent-one',
              ),
              child: const Text('rename'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('rename'));
    await tester.pumpAndSettle();

    expect(find.text('agent-one'), findsOneWidget);

    // Left closed the same way the bug was found: through the key, not a pop.
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
  });
}
