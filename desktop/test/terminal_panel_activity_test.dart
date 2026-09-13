import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/pane_grid.dart';
import 'package:harness/widgets/terminal_panel.dart';

import 'support/periodic_timer_probe.dart';
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

void main() {
  testWidgets('retained Swarms run only the focused terminal cursor clock', (
    tester,
  ) async {
    final probe = PeriodicTimerProbe();
    await probe.run(() async {
      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      final first = app.activeSwarmId;
      for (var i = 0; i < 8; i++) {
        if (i == 4) app.newSwarm();
        app.adoptSessionForTest(terminal('a$i', []));
      }
      await tester.pumpWidget(
        MaterialApp(
          home: PaneGrid(
            notifier: app,
            swarmMode: true,
            empty: const SizedBox(),
          ),
        ),
      );
      await tester.pump();
      app.selectSwarm(first);
      await tester.pump();
      expect(find.byType(TerminalPanel, skipOffstage: false), findsNWidgets(8));
      expect(probe.active, 1);
      final oldFocus = app.panes.firstWhere((p) => app.isPaneFocused(p.id));
      await tester.pump(const Duration(milliseconds: 500));
      expect(oldFocus.session!.terminal.cursorVisibleMode, isFalse);

      app.focusPaneBy(1);
      await tester.pump();
      expect(probe.active, 1);
      expect(oldFocus.session!.terminal.cursorVisibleMode, isTrue);
      final focused = app.panes.firstWhere((p) => app.isPaneFocused(p.id));
      await tester.pump(const Duration(milliseconds: 500));
      expect(focused.session!.terminal.cursorVisibleMode, isFalse);
      app.toggleZoomPane();
      await tester.pump();
      expect(probe.active, 1);

      app.stepSwarm(1);
      await tester.pump();
      expect(probe.active, 1);
      expect(focused.session!.terminal.cursorVisibleMode, isTrue);
      app.newSwarm();
      await tester.pump();
      expect(probe.active, 0);
      final before = probe.callbacks;
      await tester.pump(const Duration(seconds: 5));
      expect(probe.callbacks, before);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    });
  });

  testWidgets(
    'window and route inactivity suspend blinking without rebuilding',
    (tester) async {
      final probe = PeriodicTimerProbe();
      await probe.run(() async {
        final app = createApp();
        final session = terminal('a0', []);
        final enabled = ValueNotifier(true);
        final panel = TerminalPanel(
          notifier: app,
          session: session,
          focused: true,
        );
        await tester.pumpWidget(
          MaterialApp(
            home: ValueListenableBuilder<bool>(
              valueListenable: enabled,
              child: panel,
              builder: (_, value, child) =>
                  TickerMode(enabled: value, child: child!),
            ),
          ),
        );
        await tester.pump();
        expect(probe.active, 1);
        await tester.pump(const Duration(milliseconds: 500));
        expect(session.terminal.cursorVisibleMode, isFalse);
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
        expect(probe.active, 0);
        expect(session.terminal.cursorVisibleMode, isTrue);
        final before = probe.callbacks;
        await tester.pump(const Duration(seconds: 5));
        expect(probe.callbacks, before);
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        expect(probe.active, 1);
        enabled.value = false;
        await tester.pump();
        expect(probe.active, 0);
        enabled.value = true;
        await tester.pump();
        expect(probe.active, 1);
        await tester.pump(const Duration(milliseconds: 500));
        expect(session.terminal.cursorVisibleMode, isFalse);
        await tester.pumpWidget(const SizedBox());
        expect(probe.active, 0);
        enabled.dispose();
        session.dispose();
        app.dispose();
      });
    },
  );

  testWidgets('cursor clocks follow session replacement and input ownership', (
    tester,
  ) async {
    final probe = PeriodicTimerProbe();
    await probe.run(() async {
      final app = createApp();
      final first = terminal('a0', []);
      final second = terminal('a1', []);
      final active = ValueNotifier((session: first, readOnly: false));
      await tester.pumpWidget(
        MaterialApp(
          home:
              ValueListenableBuilder<
                ({TerminalSession session, bool readOnly})
              >(
                valueListenable: active,
                builder: (_, value, _) => TerminalPanel(
                  notifier: app,
                  session: value.session,
                  readOnly: value.readOnly,
                  focused: true,
                ),
              ),
        ),
      );
      await tester.pump();
      expect(probe.active, 1);
      await tester.pump(const Duration(milliseconds: 500));
      first.transportLost('Test disconnect');
      expect(probe.active, 0);
      expect(first.terminal.cursorVisibleMode, isTrue);
      active.value = (session: second, readOnly: false);
      await tester.pump();
      expect(probe.active, 1);
      await tester.pump(const Duration(milliseconds: 500));
      expect(second.terminal.cursorVisibleMode, isFalse);
      active.value = (session: second, readOnly: true);
      await tester.pump();
      expect(probe.active, 0);
      expect(second.terminal.cursorVisibleMode, isTrue);
      active.value = (session: second, readOnly: false);
      await tester.pump();
      expect(probe.active, 1);
      await second.handleFrame('terminal_closed', {
        'streamId': 'stream-a1',
        'code': 'TERMINAL_TAKEN_OVER',
      });
      expect(probe.active, 0);
      await tester.pumpWidget(const SizedBox());
      active.dispose();
      first.dispose();
      second.dispose();
      app.dispose();
    });
  });
}
