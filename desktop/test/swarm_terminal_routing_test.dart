import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';

import 'swarm_state_test.dart' show createApp;

const _streamA = '00000000-0000-0000-0000-000000000001';
const _streamB = '00000000-0000-0000-0000-000000000002';

TerminalSession _session(
  String agentId,
  String streamId, {
  String machineId = 'm',
}) =>
    TerminalSession(
        machineId: machineId,
        agentId: agentId,
        agentName: agentId,
        engineId: 'codex',
        send: (_, _) async => true,
        sendBinary: (_) async => true,
      )
      ..streamId = streamId
      ..status = TerminalSessionStatus.controlling;

TerminalBinaryFrame _frame(
  String stream,
  int sequence,
  String text, {
  bool keyframe = false,
}) => TerminalBinaryFrame(
  kind: keyframe ? TerminalBinaryKind.keyframe : TerminalBinaryKind.output,
  streamId: stream,
  seq: sequence,
  bytes: Uint8List.fromList(utf8.encode(text)),
  compressed: false,
  cols: keyframe ? 80 : null,
  rows: keyframe ? 24 : null,
);

void main() {
  test(
    'reordering swarms between incoming frames preserves stream order',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      app.adoptSessionForTest(_session('a0', _streamA));
      app.newSwarm();
      final destination = app.activeSwarmId;
      final terminal = _session('a1', _streamB);
      app.adoptSessionForTest(terminal);
      await terminal.handleBinary(_frame(_streamB, 0, '', keyframe: true));

      // WsConn serializes socket delivery. Deliberately overlap this lower
      // dispatcher too: unrelated sessions must not delay reaching the
      // matching stream's own FIFO queue when the view order changes.
      final first = app.handleTerminalBinaryForTest(
        'm',
        encodeTerminalLocal(_frame(_streamB, 1, 'first '))!,
      );
      app.reorderSwarm(destination, 0);
      final second = app.handleTerminalBinaryForTest(
        'm',
        encodeTerminalLocal(_frame(_streamB, 2, 'second'))!,
      );
      await Future.wait([first, second]);
      expect(terminal.terminal.buffer.getText(), contains('first second'));
      expect(terminal.status, TerminalSessionStatus.controlling);
    },
  );

  test(
    'a hidden shared view receives a frame once, scoped to its machine',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      final first = app.activeSwarmId;
      final terminal = _session('a0', _streamA);
      final pane = app.adoptSessionForTest(terminal);
      app.newSwarm();
      await app.addAgentToSwarm('m', 'a0');
      expect(app.panes.single, same(pane));
      app.newSwarm();
      final peer = _session('a0', _streamA, machineId: 'peer');
      app.adoptSessionForTest(peer);
      await peer.handleBinary(_frame(_streamA, 0, 'peer data', keyframe: true));
      await app.handleTerminalBinaryForTest(
        'm',
        encodeTerminalLocal(_frame(_streamA, 0, 'hidden ', keyframe: true))!,
      );
      await app.handleTerminalBinaryForTest(
        'm',
        encodeTerminalLocal(_frame(_streamA, 1, 'output'))!,
      );
      expect(terminal.terminal.buffer.getText(), contains('hidden output'));
      expect(terminal.status, TerminalSessionStatus.controlling);
      expect(peer.terminal.buffer.getText(), contains('peer data'));
      expect(peer.terminal.buffer.getText(), isNot(contains('hidden')));
      app.selectSwarm(first);
      expect(app.panes.single.session, same(terminal));
      await app.handleTerminalBinaryForTest(
        'm',
        encodeTerminalLocal(_frame(_streamB, 50, 'unknown stream'))!,
      );
      expect(
        terminal.terminal.buffer.getText(),
        isNot(contains('unknown stream')),
      );
      expect(terminal.status, TerminalSessionStatus.controlling);
    },
  );

  test('a corrupt frame marks all views on its machine unreachable, including hidden views', () async {
    final app = createApp();
    addTearDown(app.dispose);
    final first = _session('a0', _streamA);
    app.adoptSessionForTest(first);
    app.newSwarm();
    final second = _session('a1', _streamB);
    app.adoptSessionForTest(second);
    app.newSwarm();
    final peer = _session('a0', _streamA, machineId: 'peer');
    app.adoptSessionForTest(peer);
    await app.handleTerminalBinaryForTest('m', Uint8List.fromList([0, 1, 2]));
    expect(first.status, TerminalSessionStatus.error);
    expect(second.status, TerminalSessionStatus.error);
    expect(peer.status, TerminalSessionStatus.controlling);
    expect(first.errorMessage, contains('could not be decoded'));
  });
}
