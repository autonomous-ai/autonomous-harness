import 'dart:convert';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/pane_grid.dart';
import 'package:xterm/xterm.dart';

import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

Future<void> _output(
  TerminalSession session,
  int sequence,
  String text, {
  bool keyframe = false,
}) => session.handleBinary(
  TerminalBinaryFrame(
    kind: keyframe ? TerminalBinaryKind.keyframe : TerminalBinaryKind.output,
    streamId: session.streamId!,
    seq: sequence,
    bytes: utf8.encode(text),
    compressed: false,
    cols: keyframe ? 80 : null,
    rows: keyframe ? 24 : null,
  ),
);

Future<Color> _firstCellColor(
  WidgetTester tester,
  TerminalViewState view,
) async {
  final boundary = tester.renderObject<RenderRepaintBoundary>(
    find.byKey(const ValueKey('terminal pixels')),
  );
  final render = view.renderTerminal;
  final sample = boundary.globalToLocal(
    render.localToGlobal(
      render.getOffset(const CellOffset(0, 0)) +
          render.cellSize.center(Offset.zero),
    ),
  );
  return (await tester.runAsync(() async {
    final image = await boundary.toImage(pixelRatio: 1);
    try {
      final rgba = (await image.toByteData(
        format: ui.ImageByteFormat.rawRgba,
      ))!;
      final index = (sample.dy.floor() * image.width + sample.dx.floor()) * 4;
      return Color.fromARGB(
        rgba.getUint8(index + 3),
        rgba.getUint8(index),
        rgba.getUint8(index + 1),
        rgba.getUint8(index + 2),
      );
    } finally {
      image.dispose();
    }
  }))!;
}

void main() {
  testWidgets('background terminal output is coalesced before repainting', (
    tester,
  ) async {
    final buffer = Terminal()..write('\x1b[41m \x1b[0m');
    final interval = ValueNotifier<Duration?>(const Duration(milliseconds: 80));
    await tester.pumpWidget(
      MaterialApp(
        home: RepaintBoundary(
          key: const ValueKey('terminal pixels'),
          child: ValueListenableBuilder<Duration?>(
            valueListenable: interval,
            builder: (_, value, _) =>
                TerminalView(buffer, outputRepaintInterval: value),
          ),
        ),
      ),
    );
    await tester.pump();
    final view = tester.state<TerminalViewState>(find.byType(TerminalView));
    expect(await _firstCellColor(tester, view), view.widget.theme.red);

    buffer.write('\x1b[H\x1b[42m \x1b[0m');
    expect(view.renderTerminal.debugNeedsLayout, isFalse);
    expect(tester.binding.hasScheduledFrame, isFalse);
    expect(await _firstCellColor(tester, view), view.widget.theme.red);

    // Focusing this tile removes the coalescing delay and paints output that
    // arrived while it was in the background without waiting for another
    // terminal chunk.
    interval.value = null;
    await tester.pump();
    expect(await _firstCellColor(tester, view), view.widget.theme.green);
    await tester.pumpWidget(const SizedBox());
    interval.dispose();
  });

  testWidgets(
    'hidden output does no rendering and reveals the latest on return',
    (tester) async {
      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      final a = terminal('a0', []);
      final b = terminal('a1', []);
      final history = List.generate(200, (i) => 'history line $i\r\n').join();
      await _output(a, 0, history, keyframe: true);
      await _output(b, 0, history, keyframe: true);
      app.adoptSessionForTest(a);
      app.adoptSessionForTest(b);
      final first = app.activeSwarmId;
      await tester.pumpWidget(
        MaterialApp(
          home: PaneGrid(
            notifier: app,
            swarmMode: true,
            empty: const SizedBox(),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));
      final viewA = tester.state<TerminalViewState>(
        find.byWidgetPredicate(
          (w) => w is TerminalView && w.terminal == a.terminal,
        ),
      );
      final viewB = tester.state<TerminalViewState>(
        find.byWidgetPredicate(
          (w) => w is TerminalView && w.terminal == b.terminal,
        ),
      );
      final renderA = viewA.renderTerminal;
      final scrollA = viewA.widget.scrollController!;
      final scrollB = viewB.widget.scrollController!;
      final selection = viewA.widget.controller!;
      scrollA.jumpTo(100);
      selection.setSelection(
        a.terminal.buffer.createAnchor(0, 3),
        a.terminal.buffer.createAnchor(7, 3),
      );
      await tester.pump();
      final selected = a.terminal.buffer.getText(selection.selection);
      final oldExtent = scrollB.position.maxScrollExtent;
      app.newSwarm();
      await tester.pump();
      await tester.pump();
      for (var i = 1; i <= 30; i++) {
        await _output(a, i, 'hidden output $i\r\n');
        await _output(b, i, 'hidden output $i\r\n');
      }
      expect(renderA.debugNeedsLayout, isFalse);
      expect(viewB.renderTerminal.debugNeedsLayout, isFalse);
      expect(tester.binding.hasScheduledFrame, isFalse);
      expect(a.terminal.buffer.getText(), contains('hidden output 30'));
      expect(scrollA.offset, 100);
      expect(scrollB.position.maxScrollExtent, oldExtent);
      app.selectSwarm(first);
      await tester.pump();
      expect(viewA.renderTerminal, same(renderA));
      expect(scrollA.offset, scrollA.position.maxScrollExtent);
      expect(a.terminal.buffer.getText(selection.selection), selected);
      expect(scrollB.position.maxScrollExtent, greaterThan(oldExtent));
      expect(scrollB.offset, scrollB.position.maxScrollExtent);
      expect(a.status, TerminalSessionStatus.controlling);
      expect(b.status, TerminalSessionStatus.controlling);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'resuming reconciles changed terminal dimensions and preserves unchanged scroll regions',
    (tester) async {
      final buffer = Terminal();
      final enabled = ValueNotifier(true);
      await tester.pumpWidget(
        MaterialApp(
          home: ValueListenableBuilder<bool>(
            valueListenable: enabled,
            builder: (_, value, _) => Offstage(
              offstage: !value,
              child: TerminalView(buffer, renderingEnabled: value),
            ),
          ),
        ),
      );
      final columns = buffer.viewWidth;
      final rows = buffer.viewHeight;
      final resizes = <(int, int)>[];
      buffer.onResize = (w, h, _, _) => resizes.add((w, h));
      enabled.value = false;
      await tester.pump();
      // A remote keyframe can change the emulator's dimensions while the view
      // retains the same pixel size. Showing it must still reconcile the grid.
      buffer.resize(10, 5);
      buffer.write('new screen');
      resizes.clear();
      await tester.pump();
      expect(buffer.viewWidth, 10);
      expect(buffer.viewHeight, 5);
      expect(resizes, isEmpty);
      enabled.value = true;
      await tester.pump();
      expect((buffer.viewWidth, buffer.viewHeight), (columns, rows));
      expect(resizes, [(columns, rows)]);
      expect(buffer.buffer.getText(), contains('new screen'));

      buffer.write('\x1b[3;7r');
      await tester.pump();
      expect((buffer.buffer.marginTop, buffer.buffer.marginBottom), (2, 6));
      resizes.clear();
      enabled.value = false;
      await tester.pump();
      enabled.value = true;
      await tester.pump();
      expect(resizes, isEmpty);
      expect((buffer.buffer.marginTop, buffer.buffer.marginBottom), (2, 6));
      await tester.pumpWidget(const SizedBox());
      enabled.dispose();
    },
  );

  testWidgets('covered routes suspend a retained terminal widget until shown', (
    tester,
  ) async {
    final buffer = Terminal()..write('\x1b[41m \x1b[0m');
    final enabled = ValueNotifier(true);
    await tester.pumpWidget(
      MaterialApp(
        home: RepaintBoundary(
          key: const ValueKey('terminal pixels'),
          child: ValueListenableBuilder<bool>(
            valueListenable: enabled,
            child: TerminalView(buffer),
            builder: (_, value, child) => TickerMode(
              enabled: value,
              child: Offstage(offstage: !value, child: child),
            ),
          ),
        ),
      ),
    );
    final view = tester.state<TerminalViewState>(find.byType(TerminalView));
    final render = view.renderTerminal;
    expect(await _firstCellColor(tester, view), view.widget.theme.red);
    enabled.value = false;
    await tester.pump();
    for (var i = 0; i < 20; i++) {
      buffer.write('covered output $i\r\n');
    }
    buffer.write('\x1b[H\x1b[42m \x1b[0m');
    expect(render.debugNeedsLayout, isFalse);
    expect(tester.binding.hasScheduledFrame, isFalse);
    enabled.value = true;
    await tester.pump();
    expect(view.renderTerminal, same(render));
    expect(await _firstCellColor(tester, view), view.widget.theme.green);
    expect(buffer.buffer.getText(), contains('covered output 19'));
    buffer.write('visible output');
    expect(render.debugNeedsLayout, isTrue);
    await tester.pump();
    await tester.pumpWidget(const SizedBox());
    enabled.dispose();
  });

  testWidgets(
    'native caret updates coalesce and refresh on the first resumed frame',
    (tester) async {
      final buffer = Terminal();
      final enabled = ValueNotifier(true);
      await tester.pumpWidget(
        MaterialApp(
          home: ValueListenableBuilder<bool>(
            valueListenable: enabled,
            builder: (_, value, _) => Offstage(
              offstage: !value,
              child: TerminalView(
                buffer,
                autofocus: true,
                renderingEnabled: value,
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      final view = tester.state<TerminalViewState>(find.byType(TerminalView));
      expect(tester.testTextInput.hasAnyClients, isTrue);
      expect(
        tester.testTextInput.log.where(
          (call) => call.method == 'TextInput.setCaretRect',
        ),
        isNotEmpty,
      );
      tester.testTextInput.log.clear();
      for (var i = 1; i <= 30; i++) {
        buffer.write('\r${List.filled(i, 'x').join()}');
      }
      expect(tester.testTextInput.log, isEmpty);
      await tester.pump();
      final rects = tester.testTextInput.log
          .where((call) => call.method == 'TextInput.setCaretRect')
          .toList();
      expect(rects, hasLength(1));
      final expected = view.renderTerminal.localToGlobal(
        view.renderTerminal.cursorOffset,
      );
      expect(rects.single.arguments['x'], expected.dx);
      expect(rects.single.arguments['y'], expected.dy);

      enabled.value = false;
      await tester.pump();
      tester.testTextInput.log.clear();
      buffer.write('\rhidden cursor');
      expect(tester.testTextInput.log, isEmpty);
      enabled.value = true;
      await tester.pump();
      final resumed = tester.testTextInput.log
          .where((call) => call.method == 'TextInput.setCaretRect')
          .toList();
      expect(resumed, hasLength(1));
      final current = view.renderTerminal.localToGlobal(
        view.renderTerminal.cursorOffset,
      );
      expect(resumed.single.arguments['x'], current.dx);
      expect(resumed.single.arguments['y'], current.dy);
      await tester.pumpWidget(const SizedBox());
      enabled.dispose();
    },
  );
}
