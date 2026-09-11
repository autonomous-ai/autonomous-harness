// Every screen that waits on a call now waits in the SHAPE of its answer.
//
// These guard the property that makes a skeleton worth having and a spinner
// not: the placeholder occupies the same room as the content it stands in
// for, so nothing on the page moves when the answer lands. They also guard
// the two states that must never look alike — "still loading" and "answered
// with nothing" — which is the bug a bare empty list always has.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart';
import 'package:harness/shared/widgets/skeleton.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/machine_rail.dart';

Widget _themed(Widget child) => MaterialApp(
  home: Builder(
    builder: (context) {
      AppTheme.brightness.value = Brightness.light;
      return BrightnessScope(child: Scaffold(body: child));
    },
  ),
);

const _machine = Machine(
  machineId: 'm-1',
  apiKey: '',
  authMode: MachineAuthMode.remote,
  name: 'prod-mac',
  status: 'online',
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('the machine rail', () {
    AppNotifier notifier() => AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );

    testWidgets('an empty list that is still loading does not say "none"', (
      tester,
    ) async {
      final app = notifier()..status = AppStatus.authenticated;
      addTearDown(app.dispose);
      app.machinesLoading = true;

      await tester.pumpWidget(
        _themed(SizedBox(width: 320, child: MachineRail(notifier: app))),
      );
      await tester.pump();

      expect(find.byKey(const ValueKey('machines-loading')), findsOneWidget);
      // The sentence that means something else entirely.
      expect(find.text('no remote machines'), findsNothing);
    });

    testWidgets('an empty list that has answered says so', (tester) async {
      final app = notifier()..status = AppStatus.authenticated;
      addTearDown(app.dispose);

      await tester.pumpWidget(
        _themed(SizedBox(width: 320, child: MachineRail(notifier: app))),
      );
      await tester.pump();

      expect(find.byKey(const ValueKey('machines-loading')), findsNothing);
      expect(find.text('no remote machines'), findsOneWidget);
    });

    testWidgets('a placeholder machine row is the height of a real one', (
      tester,
    ) async {
      final loading = notifier()..status = AppStatus.authenticated;
      addTearDown(loading.dispose);
      loading.machinesLoading = true;
      await tester.pumpWidget(
        _themed(SizedBox(width: 320, child: MachineRail(notifier: loading))),
      );
      await tester.pump();
      final placeholder = tester
          .getRect(
            find
                .descendant(
                  of: find.byKey(const ValueKey('machines-loading')),
                  matching: find.byType(SkeletonText),
                )
                .first,
          )
          .height;

      final ready = notifier()..status = AppStatus.authenticated;
      addTearDown(ready.dispose);
      ready.machines = [_machine];
      ready.machineStates[_machine.machineId] = MachineState(_machine);
      await tester.pumpWidget(
        _themed(SizedBox(width: 320, child: MachineRail(notifier: ready))),
      );
      await tester.pump();

      // Rows are 36px boxes either way, so the rail does not resize under the
      // pointer when the list lands.
      expect(
        tester.getSize(find.text('prod-mac')).height,
        closeTo(placeholder, 0.01),
      );
    });
  });
}
