// A harness's viewer tile: opened to the left of its agent's terminal when the
// agent's frame names a viewer, navigated when that URL changes, left closed
// once the person closes it, and taken down with the agent.

import 'package:flutter/material.dart';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/web_pane_panel.dart';

import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

Map<String, dynamic> _frame(
  String id, {
  String? viewerUrl,
  Map<String, dynamic>? verdict,
}) => {
  'id': id,
  'name': 'Agent $id',
  'engine': 'claude',
  'dsh': 'autonomous/autonomous-circuit',
  'dshName': 'Autonomous Circuit',
  'viewerUrl': ?viewerUrl,
  'verdict': ?verdict,
  'terminal': {
    'available': true,
    'runtimes': [
      {'backend': 'tmux', 'paneId': '%1'},
    ],
  },
};

Future<void> _synced(
  AppNotifier app,
  String id, {
  String? viewerUrl,
  Map<String, dynamic>? verdict,
}) => app.handleEventForTest('m', {
  'type': 'agent_synced',
  'payload': {'agent': _frame(id, viewerUrl: viewerUrl, verdict: verdict)},
});

List<TerminalPane> _viewers(AppNotifier app) =>
    app.panes.where((pane) => pane.isWeb).toList();

void main() {
  test('a viewer opens to the left of its agent and follows the URL', () async {
    final app = createApp();
    addTearDown(app.dispose);
    final input = <TerminalBinaryFrame>[];
    final first = app.adoptSessionForTest(terminal('a0', input));
    final second = app.adoptSessionForTest(terminal('a1', input));
    app.focusPane(first.id);

    // A frame with no viewer opens nothing.
    await _synced(app, 'a0');
    expect(_viewers(app), isEmpty);

    await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
    final viewer = _viewers(app).single;
    expect(viewer.ownerAgentId, 'a0');
    expect(viewer.agentId, isNull, reason: 'a viewer is not the agent\'s tile');
    expect(viewer.url, 'http://127.0.0.1:4179/');
    expect(app.panes.map((p) => p.id), [viewer.id, first.id, second.id]);
    expect(app.focusedPaneId, first.id, reason: 'never steals focus');
    expect(
      app.activeSwarm.paneSizes['2:manual'],
      isNull,
      reason: 'three tiles: the grid decides, not the harness split',
    );

    // The same URL again is nothing new; a different one navigates in place.
    await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
    expect(_viewers(app).single.id, viewer.id);
    await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/?file=a.step');
    expect(_viewers(app).single.id, viewer.id);
    expect(_viewers(app).single.url, 'http://127.0.0.1:4179/?file=a.step');
    expect(app.panes.length, 3);

    // A frame that drops the viewer takes the tile down.
    await _synced(app, 'a0');
    expect(_viewers(app), isEmpty);
    expect(app.panes.map((p) => p.id), [first.id, second.id]);
  });

  test('alone with its terminal, the viewer takes two thirds', () async {
    final app = createApp();
    addTearDown(app.dispose);
    final input = <TerminalBinaryFrame>[];
    final terminalPane = app.adoptSessionForTest(terminal('a0', input));
    await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
    final viewer = _viewers(app).single;
    expect(app.panes.map((p) => p.id), [viewer.id, terminalPane.id]);
    final split = app.activeSwarm.paneSizes['2:manual'];
    expect(split, isNotNull);
    expect(split!.tiles.map((t) => t.left), [0, 2 / 3]);
    expect(split.tiles.map((t) => t.right), [2 / 3, 1]);
    expect(split.tiles.map((t) => t.height), [1, 1]);
    // The viewer going away takes the pair's layout with it, the way any
    // removal does; a new viewer starts the split afresh.
    await _synced(app, 'a0');
    expect(app.activeSwarm.paneSizes['2:manual'], isNull);
    expect(app.panes.map((p) => p.id), [terminalPane.id]);
  });

  test('a pair the user sized by hand keeps its sizes', () async {
    final app = createApp();
    addTearDown(app.dispose);
    final input = <TerminalBinaryFrame>[];
    app.adoptSessionForTest(terminal('a0', input));
    final theirs = PaneArrangement(const [
      Rect.fromLTRB(0, 0, 0.5, 1),
      Rect.fromLTRB(0.5, 0, 1, 1),
    ]);
    app.activeSwarm.savePaneSizes('2:manual', theirs);
    await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
    expect(_viewers(app), hasLength(1));
    expect(app.activeSwarm.paneSizes['2:manual'], same(theirs));
  });

  test(
    'the viewer is beside the terminal in every tab that shows it',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      final input = <TerminalBinaryFrame>[];
      final first = app.adoptSessionForTest(terminal('a0', input));
      final one = app.activeSwarm;
      app.newSwarm(name: 'Second');
      final second = app.adoptSessionForTest(terminal('a0', input));
      final two = app.activeSwarm;
      await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
      expect(app.allPanes.where((p) => p.isWeb), hasLength(2));
      expect(one.panes.map((p) => p.isWeb), [true, false]);
      expect(two.panes.map((p) => p.isWeb), [true, false]);
      expect(one.panes.last, same(first));
      expect(two.panes.last, same(second));
      // A tab that loses the terminal loses the viewer on the next frame; the
      // other tab keeps its pair.
      two.remove(second);
      await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
      expect(two.panes, isEmpty);
      expect(one.panes.map((p) => p.isWeb), [true, false]);
    },
  );

  test('closing the terminal by hand takes its viewer with it', () async {
    final app = createApp();
    addTearDown(app.dispose);
    final input = <TerminalBinaryFrame>[];
    final terminalPane = app.adoptSessionForTest(terminal('a0', input));
    await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
    expect(_viewers(app), hasLength(1));
    await app.closePane(terminalPane.id);
    expect(app.panes, isEmpty);
    // Not a dismissal: the next open of the agent brings the viewer back.
    app.adoptSessionForTest(terminal('a0', input));
    await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
    expect(_viewers(app), hasLength(1));
  });

  test('the header control hides the viewer and brings it back', () async {
    final app = createApp();
    addTearDown(app.dispose);
    final input = <TerminalBinaryFrame>[];
    app.adoptSessionForTest(terminal('a0', input));
    await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
    expect(app.viewerPaneShown('m', 'a0'), isTrue);
    await app.toggleViewerPane('m', 'a0');
    expect(app.viewerPaneShown('m', 'a0'), isFalse);
    // Hidden is a dismissal: the same page does not creep back on a frame.
    await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
    expect(app.viewerPaneShown('m', 'a0'), isFalse);
    await app.toggleViewerPane('m', 'a0');
    expect(app.viewerPaneShown('m', 'a0'), isTrue);
    expect(app.panes.map((p) => p.isWeb), [true, false]);
  });

  test('a viewer closed by hand stays closed until the URL changes', () async {
    final app = createApp();
    addTearDown(app.dispose);
    final input = <TerminalBinaryFrame>[];
    app.adoptSessionForTest(terminal('a0', input));
    await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
    final viewer = _viewers(app).single;
    await app.closePane(viewer.id);
    expect(_viewers(app), isEmpty);
    await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
    expect(_viewers(app), isEmpty, reason: 'the same page does not pop back');
    await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4180/');
    expect(_viewers(app).single.url, 'http://127.0.0.1:4180/');
  });

  test('a viewer is never persisted, and goes with its agent', () async {
    final app = createApp();
    addTearDown(app.dispose);
    final input = <TerminalBinaryFrame>[];
    app.adoptSessionForTest(terminal('a0', input));
    await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
    expect(_viewers(app), hasLength(1));
    final saved = app.activeSwarm.toJson();
    expect((saved['panes'] as List).length, 1);
    expect(saved.toString(), isNot(contains('4179')));

    await app.handleEventForTest('m', {
      'type': 'agent_deleted',
      'agentId': 'a0',
      'payload': {'agentId': 'a0'},
    });
    expect(app.panes, isEmpty);
  });

  test('a viewer waits for a terminal tile to hang beside', () async {
    final app = createApp();
    addTearDown(app.dispose);
    await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
    expect(app.panes, isEmpty, reason: 'no terminal on any desk');
    await app.addAgentToSwarm('m', 'a0');
    expect(app.panes.map((p) => p.isWeb), [true, false]);
  });

  testWidgets('the tile renders a header and, under test, the URL in words', (
    tester,
  ) async {
    final app = createApp();
    addTearDown(app.dispose);
    app.stateOf('m')!.nodeOnline = true;
    final input = <TerminalBinaryFrame>[];
    app.adoptSessionForTest(terminal('a0', input));
    await mount(tester, app);
    await _synced(app, 'a0', viewerUrl: 'http://127.0.0.1:4179/');
    await tester.pump();
    expect(WebPanePanel.webviewAvailable, isFalse);
    expect(find.byType(WebPanePanel), findsOneWidget);
    expect(find.byKey(const ValueKey('web-pane-placeholder')), findsOneWidget);
    expect(find.text('http://127.0.0.1:4179/'), findsOneWidget);
    // Its own close control, and no way to end an agent from it.
    expect(find.byTooltip('Close viewer'), findsOneWidget);
    expect(
      find.byTooltip('Stop Harness'),
      findsOneWidget,
      reason: 'the terminal keeps its own',
    );
    // The verdict is the viewer's to show — chip and strip in its header,
    // nothing on the terminal's — and the terminal's header carries the
    // control that hides and shows the viewer.
    expect(find.byKey(const ValueKey('pane-status')), findsNothing);
    await _synced(
      app,
      'a0',
      viewerUrl: 'http://127.0.0.1:4179/',
      verdict: {
        'ready': false,
        'warnings': 1,
        'phases': [
          {'name': 'Build', 'state': 'done'},
          {'name': 'Checks', 'state': 'active'},
        ],
      },
    );
    await tester.pump();
    // One status in the viewer's title, and nothing on the terminal's: the
    // phase under way here, since the deck is neither ready nor failing.
    final viewerHeader = find.ancestor(
      of: find.byTooltip('Close viewer'),
      matching: find.byType(WebPanePanel),
    );
    expect(
      find.descendant(
        of: viewerHeader,
        matching: find.byKey(const ValueKey('pane-status')),
      ),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('pane-status')), findsOneWidget);
    expect(find.text('Checks'), findsOneWidget);
    expect(find.text('Build'), findsNothing);
    expect(find.text('1 warning'), findsNothing, reason: 'the phase wins');
    expect(find.textContaining('·  Viewer'), findsNothing);
    expect(find.byTooltip('Hide viewer'), findsOneWidget);
    await tester.tap(find.byTooltip('Close viewer'));
    await tester.pump();
    expect(_viewers(app), isEmpty);
    expect(tester.takeException(), isNull);
  });
}
