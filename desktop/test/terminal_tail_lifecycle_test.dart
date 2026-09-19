import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/pane_preset.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_font_store.dart';
import 'package:harness/terminal/terminal_session.dart';

import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;
import 'terminal_find_test.dart' show terminalView;

Future<void> snapshot(
  TerminalSession session,
  int seq,
  int lines,
) => session.handleBinary(
  TerminalBinaryFrame(
    kind: TerminalBinaryKind.keyframe,
    streamId: session.streamId!,
    seq: seq,
    cols: 100,
    rows: 40,
    compressed: false,
    bytes: utf8.encode(
      '${List.generate(lines, (i) => 'History line $i\r\n').join()}LATEST OUTPUT',
    ),
  ),
);

void atBottom(WidgetTester tester, TerminalSession session) {
  final view = terminalView(tester, session);
  final position = view.widget.scrollController!.position;
  expect(position.maxScrollExtent, greaterThan(1000));
  expect(
    position.pixels,
    closeTo(position.maxScrollExtent, 0.5),
    reason: '${session.agentId} should show its latest output',
  );
  final cursor = view.renderTerminal.cursorOffset;
  expect(cursor.dy, greaterThanOrEqualTo(0));
  expect(cursor.dy, lessThan(view.renderTerminal.size.height));
}

void main() {
  testWidgets(
    'incremental resize repaint cannot start a scroll bounce',
    (tester) async {
      final app = createApp();
      final session = terminal('a0', []);
      await snapshot(session, 0, 900);
      app.adoptSessionForTest(session);
      await mount(tester, app);
      final view = terminalView(tester, session);
      // Codex clears history and redraws in separate output frames. There is no
      // further keyframe to cancel a bounce created by the temporary small buffer.
      session.terminal.write('\x1b[3J\x1b[H\x1b[2JRepainting');
      await tester.pump();
      for (var chunk = 0; chunk < 5; chunk++) {
        session.terminal.write(
          '\r\n${'Repainted history\r\n' * 200}LATEST OUTPUT',
        );
        await tester.pump(const Duration(milliseconds: 16));
      }
      await tester.pump(const Duration(seconds: 2));
      expect(
        view.widget.scrollController!.position.isScrollingNotifier.value,
        isFalse,
      );
      atBottom(tester, session);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
    variant: TargetPlatformVariant({
      TargetPlatform.macOS,
      TargetPlatform.linux,
    }),
  );

  testWidgets('relayout cancels scrolling that was already in flight', (
    tester,
  ) async {
    final app = createApp();
    final sessions = [terminal('a0', []), terminal('a1', [])];
    for (final session in sessions) {
      await snapshot(session, 0, 800);
      app.adoptSessionForTest(session);
    }
    await mount(tester, app);
    for (final session in sessions) {
      unawaited(
        terminalView(tester, session).widget.scrollController!.animateTo(
          0,
          duration: const Duration(milliseconds: 600),
          curve: Curves.linear,
        ),
      );
    }
    await tester.pump(const Duration(milliseconds: 60));
    app.setPreset(2, PanePreset.rows);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    for (final session in sessions) {
      await snapshot(session, 1, 1000);
    }
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    for (final session in sessions) {
      atBottom(tester, session);
    }
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets('applying a layout resets panes whose size stays the same', (
    tester,
  ) async {
    final app = createApp();
    final sessions = [terminal('a0', []), terminal('a1', [])];
    for (final session in sessions) {
      await snapshot(session, 0, 800);
      app.adoptSessionForTest(session);
    }
    await mount(tester, app);
    app.setPreset(2, PanePreset.columns);
    await tester.pump();
    for (final session in sessions) {
      terminalView(tester, session).widget.scrollController!.jumpTo(100);
    }
    await tester.pump();
    app.setPreset(2, PanePreset.columns);
    await tester.pump();
    for (final session in sessions) {
      atBottom(tester, session);
    }
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets(
    'resize redraws and delayed captures keep following live output',
    (tester) async {
      final app = createApp();
      final sessions = [terminal('a0', []), terminal('a1', [])];
      for (final session in sessions) {
        await snapshot(session, 0, 1000);
        app.adoptSessionForTest(session);
      }
      await mount(tester, app);
      var sequence = 1;
      for (final preset in [
        PanePreset.rows,
        PanePreset.columns,
        PanePreset.rows,
      ]) {
        await chord(tester, LogicalKeyboardKey.keyS);
        await tester.pump(const Duration(milliseconds: 200));
        await tester.tap(find.text(preset.label));
        await tester.pump();
        for (final session in sessions) {
          atBottom(tester, session);
          // Codex can clear its scrollback while repainting after SIGWINCH.
          // A delayed tmux capture then seeds the full history again.
          session.terminal.write('\x1b[3J\x1b[H\x1b[2JRepainting');
        }
        await tester.pump();
        for (final session in sessions) {
          await snapshot(session, sequence, 400);
        }
        sequence++;
        await tester.pump(const Duration(milliseconds: 100));
        for (final session in sessions) {
          atBottom(tester, session);
          await snapshot(session, sequence, 1200);
        }
        sequence++;
        await tester.pump();
        for (final session in sessions) {
          atBottom(tester, session);
        }
      }
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
    variant: TargetPlatformVariant({
      TargetPlatform.macOS,
      TargetPlatform.linux,
    }),
  );

  testWidgets(
    'returning to live output before a layout follows the new extent',
    (tester) async {
      final app = createApp();
      final session = terminal('a0', []);
      await snapshot(session, 0, 800);
      app.adoptSessionForTest(session);
      await mount(tester, app);
      terminalView(tester, session).widget.scrollController!.jumpTo(100);
      await tester.pump();
      session.terminal.write('\r\n${'Burst output\r\n' * 200}LATEST');
      // Input and output can arrive between frames. The old extent is stale.
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      atBottom(tester, session);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  for (final local in [true, false]) {
    testWidgets(
      'all delayed ${local ? 'local' : 'remote'} panes start at bottom',
      (tester) async {
        final app = createApp();
        app.stateOf('m')!.localOnly = local;
        final sessions = [for (var i = 0; i < 3; i++) terminal('a$i', [])];
        for (final session in sessions) {
          app.adoptSessionForTest(session);
        }
        await mount(tester, app);
        for (var i = 0; i < sessions.length; i++) {
          await tester.pump(const Duration(milliseconds: 200));
          await snapshot(sessions[i], 0, 600 + i * 100);
          await tester.pump();
          atBottom(tester, sessions[i]);
        }
        // A resize response can replace every snapshot before the next frame.
        tester.view.physicalSize = const Size(860, 520);
        for (final session in sessions) {
          await snapshot(session, 1, 1100);
        }
        await tester.pump();
        for (final session in sessions) {
          atBottom(tester, session);
        }
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets(
    'adding a retained pane to a new agent reveals the latest output',
    (tester) async {
      final app = createApp();
      final session = terminal('a0', []);
      await snapshot(session, 0, 900);
      app.adoptSessionForTest(session);
      await mount(tester, app);
      final view = terminalView(tester, session);
      view.widget.scrollController!.jumpTo(100);
      await tester.pump();
      await chord(tester, LogicalKeyboardKey.keyT);
      // The pane-choosing picker is the Open Agent chooser; New Agent opens
      // its dialog directly without a session list.
      await chord(tester, LogicalKeyboardKey.keyO);
      await tester.enterText(
        find.byKey(const ValueKey('swarm-search-input')),
        'Agent 0',
      );
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(terminalView(tester, session), same(view));
      atBottom(tester, session);
      // Shared panes can remain visible with exactly the same geometry while
      // switching agents, so visibility/size alone cannot detect a reveal.
      view.widget.scrollController!.jumpTo(100);
      await tester.pump();
      app.selectSwarm(app.swarms.first.id);
      await tester.pump();
      expect(terminalView(tester, session), same(view));
      atBottom(tester, session);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'relayout, adding, zoom and returning reveal the tail of every pane',
    (tester) async {
      final app = createApp();
      final sessions = [terminal('a0', []), terminal('a1', [])];
      for (final session in sessions) {
        await snapshot(session, 0, 800);
        app.adoptSessionForTest(session);
      }
      await mount(tester, app);
      void scrollUp() {
        for (final session in sessions) {
          terminalView(tester, session).widget.scrollController!.jumpTo(100);
        }
      }

      scrollUp();
      await tester.pump();
      app.setPreset(2, PanePreset.rows);
      await tester.pump();
      for (final session in sessions) {
        atBottom(tester, session);
      }
      scrollUp();
      final third = terminal('a2', []);
      await snapshot(third, 0, 1200);
      app.adoptSessionForTest(third);
      sessions.add(third);
      // The adoption seam only inserts the session; publish a session update
      // as the real attach path does, so every retained pane is rebuilt.
      await snapshot(third, 1, 1200);
      await tester.pump();
      for (final session in sessions) {
        atBottom(tester, session);
      }
      scrollUp();
      app.toggleZoomPane();
      await tester.pump();
      atBottom(tester, third);
      app.toggleZoomPane();
      await tester.pump();
      for (final session in sessions) {
        atBottom(tester, session);
      }
      scrollUp();
      final original = app.activeSwarmId;
      app.newSwarm();
      await tester.pump();
      for (final session in sessions) {
        session.terminal.write('\r\n${'Hidden output\r\n' * 200}LATEST');
      }
      app.selectSwarm(original);
      await tester.pump();
      for (final session in sessions) {
        atBottom(tester, session);
      }
      final font = terminalFontStore.value;
      addTearDown(() => terminalFontStore.value = font);
      scrollUp();
      terminalFontStore.value = font.copyWith(fontSize: font.fontSize + 2);
      await tester.pump();
      for (final session in sessions) {
        atBottom(tester, session);
      }
      // Ordinary output must still allow deliberate reading within this view.
      final reading = terminalView(tester, third).widget.scrollController!;
      reading.jumpTo(100);
      await tester.pump();
      third.terminal.write('\r\nMore output');
      await tester.pump();
      expect(reading.offset, 100);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );
}
