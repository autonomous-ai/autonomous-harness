import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/agent_neighbour_warmer.dart';
import 'package:harness_mobile/phone/agent_swipe.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'agent_pager_fixture.dart';

void main() {
  group('preattachAgent', () {
    test('opens the stream at the size given, and selects nothing', () async {
      final conn = PagerConn();
      final app = pagerApp(conn);
      addTearDown(app.dispose);
      await liveAgent(app, 'a');
      final focused = app.focusedPaneId;

      await app.preattachAgent('m', 'b', cols: 46, rows: 38);

      expect(conn.opens.single['agentId'], 'b');
      expect(conn.opens.single['cols'], 46);
      expect(conn.opens.single['rows'], 38);
      expect(app.paneOfAgent('m', 'b')?.session, isNotNull);
      expect(
        app.focusedPaneId,
        focused,
        reason: 'focus stays on the agent read',
      );
      expect(app.stateOf('m')?.activeAgentId, 'a');
    });

    test('a pane already streaming is left alone', () async {
      final conn = PagerConn();
      final app = pagerApp(conn);
      addTearDown(app.dispose);

      await app.preattachAgent('m', 'b', cols: 46, rows: 38);
      await app.preattachAgent('m', 'b', cols: 46, rows: 38);

      expect(conn.opens, hasLength(1));
    });

    test('an agent that cannot be attached gets no pane', () async {
      final conn = PagerConn();
      final app = pagerApp(conn, online: false);
      addTearDown(app.dispose);

      await app.preattachAgent('m', 'b', cols: 46, rows: 38);

      expect(app.paneOfAgent('m', 'b'), isNull);
      expect(conn.opens, isEmpty);
    });
  });

  group('the pager', () {
    Future<(AppNotifier, PagerConn)> pumpPager(WidgetTester tester) async {
      final conn = PagerConn();
      final app = pagerApp(conn);
      addTearDown(app.dispose);
      final list = pagerList(app);
      await liveAgent(app, 'b');
      await tester.pumpWidget(
        MaterialApp(
          home: AgentSwipeHost(
            notifier: app,
            machineId: 'm',
            agentId: 'b',
            neighbours: list,
          ),
        ),
      );
      await tester.pump();
      return (app, conn);
    }

    testWidgets('opens the agents either side once the one on screen is live', (
      tester,
    ) async {
      final (app, conn) = await pumpPager(tester);
      expect(conn.opens, isEmpty, reason: 'not before the landed page settles');

      await tester.pump(AgentNeighbourWarmer.delay);
      await tester.pump();

      expect(
        {for (final open in conn.opens) open['agentId']},
        {'a', 'c'},
        reason: 'the pages one swipe left and one swipe right',
      );
      expect(app.stateOf('m')?.activeAgentId, 'a', reason: 'nothing selected');
    });

    testWidgets('closes what falls out of the window as the pager moves', (
      tester,
    ) async {
      final (app, _) = await pumpPager(tester);
      await tester.pump(AgentNeighbourWarmer.delay);
      await tester.pump();
      expect(app.paneOfAgent('m', 'a'), isNotNull);
      // c was warmed; its keyframe lands before the swipe reaches it, as in use.
      await goLive(app.paneOfAgent('m', 'c')!.session!);

      // One swipe right: from b to c, whose neighbours are b and d.
      await tester.fling(find.byType(PageView), const Offset(-400, 0), 1000);
      await tester.pumpAndSettle();
      await tester.pump(AgentNeighbourWarmer.delay);
      await tester.pump();

      expect(app.paneOfAgent('m', 'a'), isNull, reason: 'two swipes away now');
      expect(app.paneOfAgent('m', 'd')?.session, isNotNull);
    });
  });
}
