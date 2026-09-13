import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/pane_preset.dart';
import 'package:harness/terminal/terminal_font_store.dart';
import 'package:harness/widgets/pane_grid.dart';
import 'package:harness/widgets/terminal_panel.dart';
import 'package:xterm/xterm.dart';

import 'swarm_state_test.dart' show createApp;
import 'swarm_screen_test.dart' show terminal;

void main() {
  testWidgets(
    'changed terminal metrics update the grid without a font-size change',
    (tester) async {
      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      for (var i = 0; i < 6; i++) {
        app.adoptSessionForTest(terminal('a$i', []));
      }
      app.setPreset(6, PanePreset.cols2);
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1000, 800);
      addTearDown(tester.view.reset);
      final previous = terminalFontStore.value;
      // Change only the in-memory ValueNotifier; no persistence method is called.
      addTearDown(() => terminalFontStore.value = previous);
      await tester.pumpWidget(
        MaterialApp(home: PaneGrid(notifier: app, swarmMode: true)),
      );
      await tester.pump();
      final scroll = tester
          .widget<SingleChildScrollView>(
            find.byType(SingleChildScrollView).first,
          )
          .controller!;
      final before = scroll.position.maxScrollExtent;
      terminalFontStore.value = TerminalStyle(
        fontSize: previous.fontSize,
        fontFamily: previous.fontFamily,
        fontFamilyFallback: previous.fontFamilyFallback,
        height: 4,
      );
      await tester.pump();
      expect(scroll.position.maxScrollExtent, greaterThan(before + 500));
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'scroll positions restore on the first frame across different Swarm sizes',
    (tester) async {
      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      for (var i = 0; i < 12; i++) {
        app.adoptSessionForTest(terminal('a$i', []));
      }
      app.setPreset(12, PanePreset.cols2);
      final first = app.activeSwarmId;
      app.newSwarm();
      for (var i = 12; i < 18; i++) {
        app.adoptSessionForTest(terminal('a$i', []));
      }
      app.setPreset(6, PanePreset.cols2);
      final second = app.activeSwarmId;
      app.selectSwarm(first);
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1000, 500);
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(home: PaneGrid(notifier: app, swarmMode: true)),
      );
      await tester.pump();
      final scroll = tester
          .widget<SingleChildScrollView>(
            find.byType(SingleChildScrollView).first,
          )
          .controller!;
      scroll.jumpTo(600);
      await tester.pump();
      expect(scroll.position.maxScrollExtent, greaterThan(600));
      app.selectSwarm(second);
      await tester.pump();
      expect(scroll.offset, 0);
      scroll.jumpTo(120);
      await tester.pump();
      app.selectSwarm(first);
      await tester.pump();
      expect(scroll.offset, 600);
      app.selectSwarm(second);
      await tester.pump();
      expect(scroll.offset, 120);
      app.newSwarm();
      await tester.pump();
      expect(scroll.offset, 0);
      expect(scroll.position.maxScrollExtent, 0);
      app.selectSwarm(first);
      await tester.pump();
      expect(scroll.offset, 600);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'tab, zoom and preset changes keep each terminal under the same ancestors',
    (tester) async {
      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      for (var i = 0; i < 4; i++) {
        app.adoptSessionForTest(terminal('a$i', []));
      }
      final first = app.activeSwarmId;
      final pane = app.panes.first;
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1280, 800);
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(home: PaneGrid(notifier: app, swarmMode: true)),
      );
      await tester.pump();
      final cell = tester.element(find.byKey(pane.cellKey));
      List<Element> ancestors() {
        final result = <Element>[];
        cell.visitAncestorElements((e) {
          result.add(e);
          return e.widget is! PaneGrid;
        });
        return result;
      }

      final before = ancestors();
      final renderer = tester.state(
        find.byWidgetPredicate(
          (w) => w is TerminalView && w.terminal == pane.session!.terminal,
        ),
      );
      app.newSwarm();
      app.adoptSessionForTest(terminal('a5', []));
      app.dismissError();
      await tester.pump();
      expect(ancestors(), before);
      expect(find.byType(TerminalPanel), findsOneWidget);
      app.selectSwarm(first);
      await tester.pump();
      app.focusPane(pane.id);
      app.toggleZoomPane();
      await tester.pump();
      expect(ancestors(), before);
      expect(find.byType(TerminalPanel), findsOneWidget);
      app.toggleZoomPane();
      app.setPreset(4, PanePreset.mainAndStack);
      await tester.pump();
      expect(ancestors(), before);
      expect(
        tester.state(
          find.byWidgetPredicate(
            (w) => w is TerminalView && w.terminal == pane.session!.terminal,
          ),
        ),
        same(renderer),
      );
      expect(find.byType(TerminalPanel), findsNWidgets(4));
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'automatic split follows a tall viewport and a resize keeps hidden geometry',
    (tester) async {
      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      app.adoptSessionForTest(terminal('a0', []));
      app.adoptSessionForTest(terminal('a1', []));
      final first = app.activeSwarmId;
      final panes = [...app.panes];
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(800, 1200);
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(home: PaneGrid(notifier: app, swarmMode: true)),
      );
      await tester.pump();
      final upper = tester.getRect(find.byKey(panes.first.cellKey));
      final lower = tester.getRect(find.byKey(panes.last.cellKey));
      expect(upper.left, lower.left);
      expect(lower.top - upper.bottom, closeTo(kPaneGap, 0.001));
      final hiddenSize = panes.first.lastViewSize;
      app.newSwarm();
      await tester.pump();
      tester.view.physicalSize = const Size(1400, 800);
      await tester.pump();
      expect(panes.first.lastViewSize, hiddenSize);
      app.selectSwarm(first);
      await tester.pump();
      final left = tester.getRect(find.byKey(panes.first.cellKey));
      final right = tester.getRect(find.byKey(panes.last.cellKey));
      expect(left.top, right.top);
      expect(right.left - left.right, closeTo(kPaneGap, 0.001));
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );
}
