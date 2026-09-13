import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/widgets/terminal_panel.dart';

import '../support/periodic_timer_probe.dart';
import '../swarm_screen_test.dart' show mount, terminal;
import '../swarm_state_test.dart' show createApp;

/// Structural idle-work measurement, separate from wall-clock CPU benchmarks.
/// Isolated sessions have no network heartbeat or real terminal connection.
/// The empty Swarm count includes the focused welcome search field's caret.
void main() {
  for (final count in [16, 48]) {
    testWidgets('idle cursor work with $count retained terminals', (
      tester,
    ) async {
      final probe = PeriodicTimerProbe();
      await probe.run(() async {
        final app = createApp();
        app.machineStates['m']!.nodeOnline = true;
        for (var i = 0; i < count; i++) {
          if (i > 0 && i % 4 == 0) app.newSwarm();
          app.adoptSessionForTest(terminal('a$i', []));
        }
        await mount(tester, app);
        for (var i = 0; i < count ~/ 4; i++) {
          app.stepSwarm(1);
          await tester.pump();
        }
        expect(find.byType(TerminalPanel), findsNWidgets(4));
        expect(
          find.byType(TerminalPanel, skipOffstage: false),
          findsNWidgets(count),
        );
        final active = probe.active;
        var before = probe.callbacks;
        await tester.pump(const Duration(seconds: 5));
        final foreground = probe.callbacks - before;
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
        final inactive = probe.active;
        before = probe.callbacks;
        await tester.pump(const Duration(seconds: 5));
        final background = probe.callbacks - before;
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        app.newSwarm();
        await tester.pump();
        final empty = probe.active;
        before = probe.callbacks;
        await tester.pump(const Duration(seconds: 5));
        final emptyCallbacks = probe.callbacks - before;
        debugPrint(
          'TERMINAL_IDLE_BENCH ${jsonEncode({
            'kind': 'headless_fake_clock_timer_activity',
            'retainedTerminals': count,
            'observationSeconds': 5,
            'foreground': {'timers': active, 'callbacks': foreground},
            'inactiveWindow': {'timers': inactive, 'callbacks': background},
            'emptySwarm': {'timers': empty, 'callbacks': emptyCallbacks},
          })}',
        );
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        expect(probe.active, 0);
      });
    });
  }
}
