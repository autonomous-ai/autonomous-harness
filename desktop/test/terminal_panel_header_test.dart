// The pane header's transport badge: which of the three paths carries this
// pane's bytes, drawn by shape as well as colour, and absent where there is no
// such choice to report.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/theme/app_theme.dart';
import 'package:harness/widgets/terminal_panel.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'support/real_fonts.dart';

void main() {
  setUpAll(loadRealFonts);
  TerminalSession sessionNamed(String name) {
    final session = TerminalSession(
      machineId: 'local',
      agentId: 'agent-1',
      agentName: name,
      engineId: 'codex',
      send: (_, _) async => true,
      sendBinary: (_) async => true,
    );
    session.status = TerminalSessionStatus.controlling;
    session.streamId = 'stream-1';
    return session;
  }

  Future<void> pump(WidgetTester tester, TerminalSession session) async {
    // Wider than the pane, and stated: the default test window is 800px, and a
    // `SizedBox(width: 900)` inside it is silently clamped to 800.
    tester.view.physicalSize = const Size(1200, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    notifier.machineStates['local'] =
        MachineState(
            const Machine(
              machineId: 'local',
              name: 'Office',
              authMode: MachineAuthMode.remote,
            ),
          )
          ..agents = const [
            Agent(
              id: 'agent-1',
              name: 'Desktop',
              engine: 'codex',
              project: AgentProject(
                name: 'autonomous-harness',
                branch: 'main',
                cwd: '/work/autonomous-harness',
              ),
            ),
          ];
    addTearDown(notifier.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 900,
            height: 320,
            child: TerminalPanel(
              notifier: notifier,
              session: session,
              focused: true,
            ),
          ),
        ),
      ),
    );
    await tester.pump();
  }

  // Each shape describes the path topology, not an assumed speed: direct link, intermediate hop,
  // backend server. Tooltip and semantics use the protocol names people will diagnose with.
  testWidgets(
    'connection status follows the session name without moving project details',
    (tester) async {
      final session = sessionNamed('Desktop');
      addTearDown(session.dispose);
      await pump(tester, session);
      final project = find.text('autonomous-harness');
      final projectRect = tester.getRect(project);
      for (final (status, label) in [
        (TerminalSessionStatus.opening, 'Connecting'),
        (TerminalSessionStatus.resyncing, 'Restoring'),
        (TerminalSessionStatus.closed, 'Reconnect'),
        (TerminalSessionStatus.error, 'Reconnect'),
      ]) {
        session.status = status;
        await pump(tester, session);
        final nameRect = tester.getRect(find.text('Desktop'));
        final statusRect = tester.getRect(find.text(label));
        expect(statusRect.left, greaterThan(nameRect.right));
        expect(statusRect.right, lessThan(projectRect.left));
        expect(tester.getRect(project), projectRect);
        expect(tester.takeException(), isNull);
      }
    },
  );

  testWidgets(
    'the transport badge describes each link mode by shape, colour, and label',
    (tester) async {
      final marks = {
        'p2p': (
          icon: LucideIcons.link2,
          color: AppColors.success,
          label: 'P2P · Direct peer connection',
        ),
        'turn': (
          icon: LucideIcons.waypoints,
          color: AppColors.warning,
          label: 'TURN · Via Cloudflare relay',
        ),
        'relay': (
          icon: LucideIcons.server,
          color: AppColors.mutedStrong,
          label: 'WS · Via Harness WebSocket relay',
        ),
      };

      for (final entry in marks.entries) {
        final session = sessionNamed('a');
        addTearDown(session.dispose);
        session.linkMode = entry.key;
        await pump(tester, session);

        final mark = find.byIcon(entry.value.icon);
        expect(
          mark,
          findsOneWidget,
          reason: 'link mode ${entry.key} has the wrong topology',
        );
        expect(tester.widget<Icon>(mark).color, entry.value.color);
        expect(tester.widget<Icon>(mark).size, 14);
        expect(find.byTooltip(entry.value.label), findsOneWidget);
        expect(find.bySemanticsLabel(entry.value.label), findsOneWidget);
        // Exactly one of the three, never two at once.
        for (final other in marks.values.where(
          (value) => value.icon != entry.value.icon,
        )) {
          expect(find.byIcon(other.icon), findsNothing);
        }
      }
    },
  );

  testWidgets('a terminal with no link mode gets no badge at all', (
    tester,
  ) async {
    // This is the local-machine case: the CLI never sends terminal_link_mode for a terminal on this
    // same computer, because there is no transport choice to report.
    final session = sessionNamed('a');
    addTearDown(session.dispose);
    expect(session.linkMode, isNull);
    await pump(tester, session);

    for (final icon in [
      LucideIcons.link2,
      LucideIcons.waypoints,
      LucideIcons.server,
    ]) {
      expect(find.byIcon(icon), findsNothing);
    }
  });

  testWidgets('a live transport change replaces the badge in place', (
    tester,
  ) async {
    final session = sessionNamed('a');
    addTearDown(session.dispose);
    session.linkMode = 'p2p';
    await pump(tester, session);

    expect(find.byIcon(LucideIcons.link2), findsOneWidget);
    final position = tester.getCenter(find.byIcon(LucideIcons.link2));
    session.linkMode = 'turn';
    await pump(tester, session);
    expect(find.byIcon(LucideIcons.link2), findsNothing);
    expect(find.byIcon(LucideIcons.waypoints), findsOneWidget);
    expect(tester.getCenter(find.byIcon(LucideIcons.waypoints)), position);

    session.linkMode = 'relay';
    await pump(tester, session);
    expect(find.byIcon(LucideIcons.waypoints), findsNothing);
    expect(find.byIcon(LucideIcons.server), findsOneWidget);
    expect(tester.getCenter(find.byIcon(LucideIcons.server)), position);
  });

  // ── the harness verdict chip ─────────────────────────────────────────────

  Future<AppNotifier> pumpWithAgent(
    WidgetTester tester,
    TerminalSession session,
    Agent agent, {
    AppNotifier? app,
  }) async {
    tester.view.physicalSize = const Size(1200, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final notifier =
        app ??
        AppNotifier(
          config: AppConfig.dev,
          authSession: AuthSession(),
          configStore: null,
        );
    if (app == null) addTearDown(notifier.dispose);
    notifier.machineStates['local'] = MachineState(
      const Machine(
        machineId: 'local',
        authMode: MachineAuthMode.remote,
        name: 'This Mac',
      ),
    )..agents = [agent];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 900,
            height: 320,
            child: TerminalPanel(
              notifier: notifier,
              session: session,
              focused: true,
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    return notifier;
  }

  Agent agentWith(AgentVerdict? verdict) => Agent(
    id: 'agent-1',
    name: 'a',
    engine: 'claude',
    dsh: 'autonomous/autonomous-circuit',
    dshName: 'Autonomous Circuit',
    terminalAvailable: true,
    verdict: verdict,
  );

  testWidgets(
    'a harness agent is drawn as its harness, with no chip of its own',
    (tester) async {
      final chip = find.byKey(const ValueKey('pane-verdict-chip'));
      final session = sessionNamed('a');
      addTearDown(session.dispose);
      final notifier = await pumpWithAgent(
        tester,
        session,
        agentWith(
          const AgentVerdict(ready: true, summary: 'Board is fab-ready'),
        ),
      );
      // Its harness — icon and name, like every other pane; no second mark
      // for the engine underneath (owner, 2026-09-15).
      expect(
        find.byKey(const ValueKey('engine-icon-autonomous/autonomous-circuit')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('pane-header-base-engine')),
        findsNothing,
      );
      // The verdict is the viewer pane's to show (owner, 2026-09-15): the
      // terminal header carries none, before or after a verdict arrives.
      expect(chip, findsNothing);
      await pumpWithAgent(
        tester,
        session,
        agentWith(const AgentVerdict(ready: false, errors: 2)),
        app: notifier,
      );
      expect(chip, findsNothing);
      expect(find.text('2 errors'), findsNothing);
    },
  );
}
