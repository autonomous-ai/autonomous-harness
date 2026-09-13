// Run explicitly: flutter test test/benchmarks/swarm_benchmark.dart --reporter expanded
// These are headless CPU measurements, not network or display latency claims.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/terminal_panel.dart';

import '../swarm_screen_test.dart' show mount;
import '../swarm_state_test.dart' show createApp;

Map<String, num> distribution(List<int> microseconds) {
  microseconds.sort();
  return {
    'samples': microseconds.length,
    'medianMs': microseconds[microseconds.length ~/ 2] / 1000,
    'p95Ms': microseconds[(microseconds.length * 0.95).ceil() - 1] / 1000,
  };
}

Map<String, num> measure(void Function() operation) {
  for (var i = 0; i < 20; i++) {
    operation();
  }
  final times = <int>[];
  for (var i = 0; i < 100; i++) {
    final watch = Stopwatch()..start();
    operation();
    times.add(watch.elapsedMicroseconds);
  }
  return distribution(times);
}

void main() {
  test('large live catalog CPU benchmark', () {
    final app = AppNotifier(config: AppConfig.dev, authSession: AuthSession());
    addTearDown(app.dispose);
    for (var machine = 0; machine < 8; machine++) {
      final id = 'machine-$machine';
      app.machineStates[id] =
          MachineState(
              Machine(
                machineId: id,
                authMode: MachineAuthMode.remote,
                name: 'Machine $machine',
              ),
            )
            ..agents = [
              for (var agent = 0; agent < 250; agent++)
                Agent(
                  id: 'agent-$agent',
                  name: 'Agent $agent',
                  engine: 'codex',
                  project: AgentProject(
                    name: 'Project ${agent % 50}',
                    cwd: '/work/project-${agent % 50}',
                    remote: 'example.invalid/team/project-${agent % 50}',
                    branch: 'main',
                  ),
                ),
            ];
    }
    expect(swarmAgents(app), hasLength(2000));
    expect(swarmProjects(app, const []), hasLength(50));
    debugPrint(
      'SWARM_BENCH ${jsonEncode({'kind': 'headless_debug_cpu', 'agents': 2000, 'machines': 8, 'search': measure(() {
        swarmAgents(app, 'Agent 12 Project 12');
      }), 'projectGrouping': measure(() {
        swarmProjects(app, const []);
      })})}',
    );
  });

  for (final swarmCount in [4, 12]) {
    testWidgets('tab-switch CPU benchmark with $swarmCount retained swarms', (
      tester,
    ) async {
      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      final first = app.activeSwarmId;
      for (var swarm = 0; swarm < swarmCount; swarm++) {
        if (swarm != 0) app.newSwarm();
        for (var pane = 0; pane < 4; pane++) {
          final id = 'a${swarm * 4 + pane}';
          final session =
              TerminalSession(
                  machineId: 'm',
                  agentId: id,
                  agentName: 'Agent $id',
                  engineId: 'codex',
                  send: (_, _) async => true,
                  sendBinary: (_) async => true,
                )
                ..status = TerminalSessionStatus.controlling
                ..streamId = 'stream-$id';
          session.terminal.write(
            List.generate(
              1000,
              (line) =>
                  '\x1b[32m$line\x1b[0m  terminal output with project context\r\n',
            ).join(),
          );
          app.adoptSessionForTest(session);
        }
      }
      app.selectSwarm(first);
      await mount(tester, app);
      for (var warmup = 0; warmup < swarmCount * 3; warmup++) {
        app.stepSwarm(1);
        await tester.pump();
      }
      final times = <int>[];
      for (var sample = 0; sample < 60; sample++) {
        final watch = Stopwatch()..start();
        app.stepSwarm(1);
        await tester.pump();
        times.add(watch.elapsedMicroseconds);
      }
      expect(find.byType(TerminalPanel), findsNWidgets(4));
      expect(
        find.byType(TerminalPanel, skipOffstage: false),
        findsNWidgets(swarmCount * 4),
      );
      final rebuilds = <String, int>{};
      debugOnRebuildDirtyWidget = (element, _) {
        final type = element.widget.runtimeType.toString();
        rebuilds.update(type, (count) => count + 1, ifAbsent: () => 1);
      };
      try {
        app.stepSwarm(1);
        await tester.pump();
      } finally {
        debugOnRebuildDirtyWidget = null;
      }
      final largest = rebuilds.entries.toList()
        ..sort((a, b) => b.value.compareTo(a.value));
      debugPrint(
        'SWARM_BENCH ${jsonEncode({'kind': 'headless_debug_cpu', 'swarms': swarmCount, 'terminals': swarmCount * 4, 'scrollbackLinesPerTerminal': 1000, 'viewport': '1280x800', 'tabSwitchAndFrame': distribution(times), 'rebuildsPerSwitch': rebuilds.values.fold(0, (total, count) => total + count), 'mostRebuiltWidgets': Map.fromEntries(largest.take(12))})}',
      );
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    });
  }
}
