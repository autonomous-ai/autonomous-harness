// The pane header's transport badge: which of the three paths carries this
// pane's bytes, drawn by shape as well as colour, and absent where there is no
// such choice to report.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/theme/app_theme.dart';
import 'package:harness/widgets/terminal_panel.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

void main() {
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
}
