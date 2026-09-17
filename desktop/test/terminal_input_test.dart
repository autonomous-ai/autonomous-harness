import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_input.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/terminal_panel.dart';
import 'package:xterm/xterm.dart';

Terminal _pane() => Terminal(
  maxLines: 20,
  platform: TerminalTargetPlatform.macos,
  reflowEnabled: false,
  inputHandler: harnessInputHandler,
)..resize(80, 4);

/// A pane on THIS computer, which is the case with no composer in front of it: the keystroke goes
/// straight into the terminal, which is the path ⌥⏎ has to survive.
AppNotifier _localNotifier() {
  final app = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
  );
  final machine = Machine(
    machineId: 'm1',
    apiKey: '',
    authMode: MachineAuthMode.remote,
    name: 'm1',
    status: 'online',
  );
  app.machines = [machine];
  app.machineStates['m1'] = MachineState(machine)..localOnly = true;
  return app;
}

const _streamId = '00112233-4455-6677-8899-aabbccddeeff';

/// A session past `terminal_ready` and its first keyframe, so it accepts input and the pane is
/// live rather than frozen behind the ATTACHING overlay.
Future<TerminalSession> _liveSession(List<TerminalBinaryFrame> wire) async {
  Object? openRequestId;
  final session = TerminalSession(
    machineId: 'm1',
    agentId: 'a1',
    agentName: 'a1',
    engineId: 'claude',
    send: (type, payload) async {
      if (type == 'terminal_open') openRequestId = payload['requestId'];
      return true;
    },
    sendBinary: (frame) async {
      wire.add(frame);
      return true;
    },
  );
  await session.open(initialCols: 80, initialRows: 24);
  await session.handleFrame('terminal_ready', {
    'requestId': openRequestId,
    'protocolVersion': 3,
    'streamId': _streamId,
    'agentId': 'a1',
  });
  await session.handleBinary(
    TerminalBinaryFrame(
      kind: TerminalBinaryKind.keyframe,
      streamId: _streamId,
      seq: 0,
      bytes: Uint8List.fromList(utf8.encode(r'$ ')),
      compressed: false,
      cols: 80,
      rows: 24,
    ),
  );
  return session;
}

Widget _host(AppNotifier app, TerminalSession session) => MaterialApp(
  home: Scaffold(
    body: SizedBox(
      width: 900,
      height: 400,
      child: TerminalPanel(
        notifier: app,
        session: session,
        focused: true,
        composerVisible: false,
        onToggleComposer: () {},
      ),
    ),
  ),
);

/// What the input batcher actually put on the wire, joined — typing is coalesced behind a trailing
/// timer, so the bytes are asserted after it fires rather than per frame.
String _typed(List<TerminalBinaryFrame> wire) => utf8.decode([
  for (final frame in wire)
    if (frame.kind == TerminalBinaryKind.input) ...frame.bytes,
]);

void main() {
  test('⌥⏎ reaches the engine as a Meta-prefixed Return, not a submit', () {
    final out = <String>[];
    final terminal = _pane()..onOutput = out.add;

    terminal.keyInput(TerminalKey.enter, alt: true);

    expect(out, ['\x1b\r']);
  });

  test('plain Enter still submits', () {
    final out = <String>[];
    final terminal = _pane()..onOutput = out.add;

    terminal.keyInput(TerminalKey.enter);

    expect(out, ['\r']);
  });

  test('⌥⏎ prefixes the numpad Return too', () {
    final out = <String>[];
    final terminal = _pane()..onOutput = out.add;

    terminal.keyInput(TerminalKey.numpadEnter, alt: true);

    expect(out, ['\x1b\r']);
  });

  test('⌥⇧⏎ breaks the line rather than sending SS3 M', () {
    final out = <String>[];
    final terminal = _pane()..onOutput = out.add;

    terminal.keyInput(TerminalKey.enter, alt: true, shift: true);

    expect(out, ['\x1b\r']);
  });

  test('the prefix follows the keytab under LNM, not a hardcoded \\r', () {
    final out = <String>[];
    final terminal = _pane()..onOutput = out.add;
    terminal.write('\x1b[20h'); // LNM on: Return is \r\n from here.

    terminal.keyInput(TerminalKey.enter, alt: true);

    expect(out, ['\x1b\r\n']);
  });

  test('⌃⌥⏎ is left to whatever is running', () {
    final out = <String>[];
    final terminal = _pane()..onOutput = out.add;

    terminal.keyInput(TerminalKey.enter, alt: true, ctrl: true);

    expect(out, ['\r'], reason: 'the plain Return the keytab would have sent');
  });

  test('⌥⌫ reaches the engine as Meta + DEL, the word-kill a prompt reads', () {
    final out = <String>[];
    final terminal = _pane()..onOutput = out.add;

    terminal.keyInput(TerminalKey.backspace, alt: true);

    expect(out, ['\x1b\x7f']);
  });

  test('a plain ⌫ still erases one character', () {
    final out = <String>[];
    final terminal = _pane()..onOutput = out.add;

    terminal.keyInput(TerminalKey.backspace);

    expect(out, ['\x7f']);
  });

  test('⌃⌫ keeps the ^H the keytab gives it', () {
    final out = <String>[];
    final terminal = _pane()..onOutput = out.add;

    terminal.keyInput(TerminalKey.backspace, ctrl: true);

    expect(out, ['\b']);
  });

  test('⌃⌥⌫ is left to whatever is running', () {
    final out = <String>[];
    final terminal = _pane()..onOutput = out.add;

    terminal.keyInput(TerminalKey.backspace, alt: true, ctrl: true);

    expect(out, ['\x17'], reason: "the keytab's own ⌥⌫ rule, untranslated");
  });

  test('⇧⌥⌫ kills the word rather than inventing a chord', () {
    final out = <String>[];
    final terminal = _pane()..onOutput = out.add;

    terminal.keyInput(TerminalKey.backspace, alt: true, shift: true);

    expect(out, ['\x1b\x7f']);
  });

  test('⌥ stays the compose key for every other letter', () {
    final out = <String>[];
    final terminal = _pane()..onOutput = out.add;

    terminal.keyInput(TerminalKey.keyA, alt: true);

    expect(out, isEmpty, reason: 'macOS composes å here; it is not Meta+a');
  });

  // The tests above call `keyInput` directly, which is the one step of this journey that was never
  // in doubt. These drive a REAL key event through a REAL pane instead — xterm's shortcut map, the
  // `_isPrintableText` deferral to the macOS IME, the ⌘ and ⌃⇥ escapes, `TerminalPanel._onTerminalKey`,
  // then the session's input batcher — and assert the bytes that would leave for the daemon. That is
  // the whole distance between the key and the engine's prompt.

  testWidgets('⌥⏎ leaves a live pane as ESC + Return', (tester) async {
    final wire = <TerminalBinaryFrame>[];
    final app = _localNotifier();
    final session = await _liveSession(wire);
    await tester.pumpWidget(_host(app, session));
    await tester.pump();

    await tester.sendKeyDownEvent(
      LogicalKeyboardKey.altLeft,
      platform: 'macos',
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.enter, platform: 'macos');
    await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft, platform: 'macos');
    await tester.pump(const Duration(milliseconds: 30));

    expect(_typed(wire), '\x1b\r');
    session.dispose();
    app.dispose();
  });

  testWidgets('⌥⏎ survives the character macOS attaches to Return', (
    tester,
  ) async {
    final wire = <TerminalBinaryFrame>[];
    final app = _localNotifier();
    final session = await _liveSession(wire);
    await tester.pumpWidget(_host(app, session));
    await tester.pump();

    // Return can arrive carrying `\r` as its character. `_isPrintableText` must not mistake that
    // for IME text and hand it to the platform, which would drop the key on the floor.
    await tester.sendKeyDownEvent(
      LogicalKeyboardKey.altLeft,
      platform: 'macos',
    );
    await tester.sendKeyEvent(
      LogicalKeyboardKey.enter,
      character: '\r',
      platform: 'macos',
    );
    await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft, platform: 'macos');
    await tester.pump(const Duration(milliseconds: 30));

    expect(_typed(wire), '\x1b\r');
    session.dispose();
    app.dispose();
  });

  testWidgets('a plain Return off the same pane still submits', (tester) async {
    final wire = <TerminalBinaryFrame>[];
    final app = _localNotifier();
    final session = await _liveSession(wire);
    await tester.pumpWidget(_host(app, session));
    await tester.pump();

    await tester.sendKeyEvent(LogicalKeyboardKey.enter, platform: 'macos');
    await tester.pump(const Duration(milliseconds: 30));

    expect(_typed(wire), '\r');
    session.dispose();
    app.dispose();
  });

  testWidgets('⌥⌫ leaves a live pane as ESC + DEL', (tester) async {
    // Told it is on a Mac, `TerminalView` hands Backspace to the native text input client — the
    // very rule ⌥⌫ has to be excluded from. Without this override the test runs the Linux path,
    // where the key reaches `keyInput` no matter what, and proves nothing about the bug.
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    final wire = <TerminalBinaryFrame>[];
    final app = _localNotifier();
    final session = await _liveSession(wire);
    await tester.pumpWidget(_host(app, session));
    await tester.pump();

    // macOS hands a bare Backspace to the native text input client, which answers `deleteBackward:`
    // — a bargain that only holds for the bare key. ⌥⌫ arrives as `deleteWordBackward:`, which
    // nothing answers, so the pane has to keep this one for itself.
    await tester.sendKeyDownEvent(
      LogicalKeyboardKey.altLeft,
      platform: 'macos',
    );
    await tester.sendKeyEvent(
      LogicalKeyboardKey.backspace,
      character: '\b',
      platform: 'macos',
    );
    await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft, platform: 'macos');
    await tester.pump(const Duration(milliseconds: 30));

    expect(_typed(wire), '\x1b\x7f');
    debugDefaultTargetPlatformOverride = null;
    session.dispose();
    app.dispose();
  });

  testWidgets('⌘⌫ leaves a live pane as ^U, the kill to the line start', (
    tester,
  ) async {
    // ⌘⌫ is Apple's chord, and [TerminalPanel] asks the platform before taking it.
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    final wire = <TerminalBinaryFrame>[];
    final app = _localNotifier();
    final session = await _liveSession(wire);
    await tester.pumpWidget(_host(app, session));
    await tester.pump();

    await tester.sendKeyDownEvent(
      LogicalKeyboardKey.metaLeft,
      platform: 'macos',
    );
    await tester.sendKeyEvent(
      LogicalKeyboardKey.backspace,
      character: '\b',
      platform: 'macos',
    );
    await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft, platform: 'macos');
    await tester.pump(const Duration(milliseconds: 30));

    expect(_typed(wire), '\x15');
    debugDefaultTargetPlatformOverride = null;
    session.dispose();
    app.dispose();
  });

  testWidgets('a held ⌘⌫ keeps killing lines', (tester) async {
    // ⌘⌫ is Apple's chord, and [TerminalPanel] asks the platform before taking it.
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    final wire = <TerminalBinaryFrame>[];
    final app = _localNotifier();
    final session = await _liveSession(wire);
    await tester.pumpWidget(_host(app, session));
    await tester.pump();

    await tester.sendKeyDownEvent(
      LogicalKeyboardKey.metaLeft,
      platform: 'macos',
    );
    await tester.sendKeyDownEvent(
      LogicalKeyboardKey.backspace,
      platform: 'macos',
    );
    await tester.sendKeyRepeatEvent(
      LogicalKeyboardKey.backspace,
      platform: 'macos',
    );
    await tester.sendKeyUpEvent(
      LogicalKeyboardKey.backspace,
      platform: 'macos',
    );
    await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft, platform: 'macos');
    await tester.pump(const Duration(milliseconds: 30));

    expect(_typed(wire), '\x15\x15');
    debugDefaultTargetPlatformOverride = null;
    session.dispose();
    app.dispose();
  });

  testWidgets('⌃⌘⌫ is nobody\'s idea of either kill', (tester) async {
    // ⌘⌫ is Apple's chord, and [TerminalPanel] asks the platform before taking it.
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    final wire = <TerminalBinaryFrame>[];
    final app = _localNotifier();
    final session = await _liveSession(wire);
    await tester.pumpWidget(_host(app, session));
    await tester.pump();

    await tester.sendKeyDownEvent(
      LogicalKeyboardKey.controlLeft,
      platform: 'macos',
    );
    await tester.sendKeyDownEvent(
      LogicalKeyboardKey.metaLeft,
      platform: 'macos',
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.backspace, platform: 'macos');
    await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft, platform: 'macos');
    await tester.sendKeyUpEvent(
      LogicalKeyboardKey.controlLeft,
      platform: 'macos',
    );
    await tester.pump(const Duration(milliseconds: 30));

    expect(_typed(wire), isEmpty, reason: 'a ⌘ chord goes back to the app');
    debugDefaultTargetPlatformOverride = null;
    session.dispose();
    app.dispose();
  });

  testWidgets('⌥ + a letter is still composed, not sent as Meta', (
    tester,
  ) async {
    final wire = <TerminalBinaryFrame>[];
    final app = _localNotifier();
    final session = await _liveSession(wire);
    await tester.pumpWidget(_host(app, session));
    await tester.pump();

    await tester.sendKeyDownEvent(
      LogicalKeyboardKey.altLeft,
      platform: 'macos',
    );
    await tester.sendKeyEvent(
      LogicalKeyboardKey.keyA,
      character: 'a',
      platform: 'macos',
    );
    await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft, platform: 'macos');
    await tester.pump(const Duration(milliseconds: 30));

    expect(_typed(wire), isEmpty, reason: 'the IME owns ⌥a, and it makes å');
    session.dispose();
    app.dispose();
  });
}
