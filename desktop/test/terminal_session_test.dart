import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const streamId = '00112233-4455-6677-8899-aabbccddeeff';
  late List<({String type, Map<String, dynamic> payload})> sent;
  late List<TerminalBinaryFrame> binarySent;
  late TerminalSession session;

  setUp(() {
    sent = [];
    binarySent = [];
    session = TerminalSession(
      machineId: 'machine-1',
      agentId: 'agent-1',
      agentName: 'backend-api',
      engineId: 'codex',
      send: (type, payload) async {
        sent.add((type: type, payload: Map<String, dynamic>.from(payload)));
        return true;
      },
      sendBinary: (frame) async {
        binarySent.add(frame);
        return true;
      },
    );
  });

  tearDown(() => session.dispose());

  Future<void> ready() async {
    await session.open(initialCols: 100, initialRows: 30);
    final requestId = sent.single.payload['requestId'];
    await session.handleFrame('terminal_ready', {
      'requestId': requestId,
      'protocolVersion': 3,
      'streamId': streamId,
      'agentId': 'agent-1',
    });
  }

  TerminalBinaryFrame output(
    int seq,
    List<int> bytes, {
    bool compress = false,
    bool keyframe = false,
    int? cols,
    int? rows,
  }) {
    final body = compress ? ZLibEncoder(level: 1).convert(bytes) : bytes;
    return TerminalBinaryFrame(
      kind: keyframe ? TerminalBinaryKind.keyframe : TerminalBinaryKind.output,
      streamId: streamId,
      seq: seq,
      bytes: Uint8List.fromList(body),
      compressed: compress,
      cols: cols,
      rows: rows,
    );
  }

  test('a renderer fault resyncs instead of freezing the pane', () async {
    await ready();
    await session.handleBinary(
      output(0, 'hello'.codeUnits, keyframe: true, cols: 100, rows: 30),
    );
    expect(session.status, TerminalSessionStatus.controlling);
    final before = session.terminal;

    // The exception itself comes from deep inside the emulator on some specific
    // content — what matters here is that the ANSWER to one is recovery, not a
    // frozen tile demanding a manual reattach.
    await session.onRendererFailure();

    expect(session.status, TerminalSessionStatus.resyncing);
    expect(sent.any((frame) => frame.type == 'terminal_resync'), isTrue);
    expect(session.errorCode, 'TERMINAL_RENDERER_FAILED');
    // The damaged emulator is not written to again: the keyframe that answers
    // the resync builds a fresh one, and output frames are dropped until then.
    await session.handleBinary(output(1, 'more'.codeUnits));
    expect(identical(session.terminal, before), isTrue);
  });

  test(
    'a renderer that keeps failing still gives up rather than looping',
    () async {
      await ready();
      await session.handleBinary(
        output(0, 'hello'.codeUnits, keyframe: true, cols: 100, rows: 30),
      );

      for (var attempt = 0; attempt < 8; attempt++) {
        await session.onRendererFailure();
      }

      // Bounded by the existing ladder: three resyncs, then a reopen.
      final resyncs = sent.where((f) => f.type == 'terminal_resync').length;
      expect(resyncs, lessThanOrEqualTo(3));
    },
  );

  test('a tmux passthrough sequence is swallowed, not painted', () async {
    await ready();

    // Verbatim shape of what Claude Code emits inside tmux to ask the OUTER
    // terminal for its background colour: OSC 11 wrapped in tmux's DCS
    // passthrough, which doubles every ESC in the body.
    //
    //   ESC P tmux; ESC ESC ] 11 ; ? BEL ESC \
    //
    // Untreated it reached the screen as `tmux;]11;?` in the middle of Claude's
    // theme picker, because ESC P was an unknown escape and the body then fell
    // through to the text path one fragment at a time.
    await session.handleBinary(
      output(
        0,
        utf8.encode('1. \x1bPtmux;\x1b\x1b]11;?\x07\x1b\\(match terminal)'),
        keyframe: true,
        cols: 80,
        rows: 24,
      ),
    );

    final text = session.terminal.buffer.getText();
    expect(text, startsWith('1. (match terminal)'));
    expect(text, isNot(contains('tmux;')));
    expect(text, isNot(contains(']11;?')));
  });

  test('an unterminated string sequence never leaks its body', () async {
    await ready();

    // Split across two writes with no ST in sight: the parser must hold the body
    // back rather than print what it has, the same contract OSC keeps.
    await session.handleBinary(
      output(
        0,
        utf8.encode('A\x1bPtmux;partial'),
        keyframe: true,
        cols: 80,
        rows: 24,
      ),
    );
    expect(session.terminal.buffer.getText(), isNot(contains('partial')));

    await session.handleBinary(output(1, utf8.encode('\x1b\\B')));
    final text = session.terminal.buffer.getText();
    expect(text, startsWith('AB'));
    expect(text, isNot(contains('tmux;')));
  });

  test('CSI erase-left at column zero renders without a resync', () async {
    await ready();

    await session.handleBinary(
      output(
        0,
        utf8.encode('abc\x1b[1G\x1b[1K'),
        keyframe: true,
        cols: 80,
        rows: 24,
      ),
    );

    expect(session.status, TerminalSessionStatus.controlling);
    // Cell 0 is now blank (erased), not gone — it copies as a literal leading space, the same as
    // any other blank cell with real content after it. See the getText() whitespace test below.
    expect(session.terminal.buffer.getText(), startsWith(' bc'));
    expect(sent.where((frame) => frame.type == 'terminal_resync'), isEmpty);
  });

  test('copied text keeps cursor-positioned gaps as spaces instead of gluing words together', () async {
    await ready();

    // TUI-style output (Claude Code, Codex, …) lays out text with cursor-forward moves (CSI C)
    // rather than printing literal space bytes — those cells are never written to, so their
    // stored codePoint is 0, the same value an erased cell has. Line 1: 3-column indent before
    // "indented". Line 2: a 5-column gap between two words.
    await session.handleBinary(
      output(
        0,
        utf8.encode('\x1b[3Cindented\r\nfirst\x1b[5Csecond'),
        keyframe: true,
        cols: 80,
        rows: 24,
      ),
    );

    final lines = session.terminal.buffer.getText().split('\n');
    expect(lines[0], '   indented');
    expect(lines[1], 'first     second');
    // A line with no real content anywhere must still copy as empty, not as columns of padding —
    // only the gap BEFORE real content becomes spaces, not blank cells with nothing after them.
    expect(lines[2], isEmpty);
  });

  test(
    'uses measured viewport geometry for the initial terminal_open',
    () async {
      final opening = session.open(
        initialCols: 80,
        initialRows: 24,
        waitForViewportSize: true,
      );
      await Future<void>.delayed(Duration.zero);
      expect(sent, isEmpty);

      session.reportViewport(168, 54);
      await opening;

      expect(sent.single.type, 'terminal_open');
      expect(sent.single.payload['cols'], 168);
      expect(sent.single.payload['rows'], 54);
      expect(session.cols, 168);
      expect(session.rows, 54);
    },
  );

  test('opens immediately at fallback size and flushes measured resize after first keyframe', () async {
    await session.open();
    expect(sent.single.type, 'terminal_open');
    expect(sent.single.payload, containsPair('cols', 80));
    final requestId = sent.single.payload['requestId'];

    session.reportViewport(120, 40);
    expect(sent.where((frame) => frame.type == 'terminal_resize'), isEmpty);
    await session.handleFrame('terminal_ready', {
      'requestId': requestId,
      'protocolVersion': 3,
      'streamId': streamId,
      'agentId': 'agent-1',
    });
    await session.handleBinary(
      output(0, const [], keyframe: true, cols: 80, rows: 24),
    );
    await Future<void>.delayed(Duration.zero);

    expect(
      sent.where((frame) => frame.type == 'terminal_resize').single.payload,
      containsPair('cols', 120),
    );
  });

  test(
    'keyframe + split UTF-8 output render in FIFO order and ACK quickly',
    () async {
      await ready();
      final before = session.terminal;
      await session.handleBinary(
        output(
          0,
          utf8.encode('hello '),
          compress: true,
          keyframe: true,
          cols: 100,
          rows: 30,
        ),
      );
      expect(session.status, TerminalSessionStatus.controlling);
      expect(identical(before, session.terminal), isFalse);

      final emoji = utf8.encode('😀');
      await session.handleBinary(output(1, emoji.sublist(0, 2)));
      await session.handleBinary(
        output(2, [...emoji.sublist(2), ...utf8.encode(' world')]),
      );
      expect(session.terminal.buffer.getText(), startsWith('hello 😀 world'));

      await Future<void>.delayed(const Duration(milliseconds: 70));
      final ack = sent.lastWhere((frame) => frame.type == 'terminal_ack');
      expect(ack.payload['lastSeq'], 2);
    },
  );

  test(
    'terminal input batches, preserves Enter boundary and is never retried',
    () async {
      await ready();
      await session.handleBinary(
        output(0, utf8.encode(r'prompt> '), keyframe: true, cols: 80, rows: 24),
      );

      // Leading edge: the first keystroke after a pause is not held for the batching window.
      session.terminal.onOutput?.call('abc');
      await Future<void>.delayed(const Duration(milliseconds: 1));
      expect(binarySent, hasLength(1));
      expect(utf8.decode(binarySent.single.bytes), 'abc');

      // Anything arriving inside the window is batched behind the trailing timer instead.
      session.terminal.onOutput?.call('d');
      session.terminal.onOutput?.call('ef');
      expect(binarySent, hasLength(1));
      await Future<void>.delayed(const Duration(milliseconds: 12));
      session.terminal.onOutput?.call('\r');
      await Future<void>.delayed(const Duration(milliseconds: 12));

      final inputs = binarySent;
      expect(inputs, hasLength(3));
      expect(utf8.decode(inputs[0].bytes), 'abc');
      expect(utf8.decode(inputs[1].bytes), 'def');
      expect(utf8.decode(inputs[2].bytes), '\r');
      expect(inputs.map((frame) => frame.seq), [0, 1, 2]);
      expect(
        inputs.every((frame) => frame.kind == TerminalBinaryKind.input),
        isTrue,
      );

      final paste = '\x1b[200~${'x' * 20000}\x1b[201~';
      session.terminal.onOutput?.call(paste);
      await Future<void>.delayed(const Duration(milliseconds: 12));
      final pasteFrames = binarySent.skip(3).toList();
      expect(pasteFrames, hasLength(3));
      final pasteBytes = <int>[for (final frame in pasteFrames) ...frame.bytes];
      expect(
        pasteFrames.every((frame) => frame.bytes.length <= 8 * 1024),
        isTrue,
      );
      expect(utf8.decode(pasteBytes), paste);

      session.transportLost();
      session.terminal.onOutput?.call('must-not-send');
      await Future<void>.delayed(const Duration(milliseconds: 8));
      expect(binarySent, hasLength(6));
      expect(session.status, TerminalSessionStatus.error);
    },
  );

  test(
    'terminal input preserves committed IME Unicode as UTF-8 bytes',
    () async {
      await ready();
      await session.handleBinary(
        output(0, utf8.encode('prompt> '), keyframe: true, cols: 80, rows: 24),
      );
      const committed = 'Tiếng Việt 日本語 中文';

      session.terminal.onOutput?.call(committed);
      await Future<void>.delayed(const Duration(milliseconds: 12));

      expect(binarySent, hasLength(1));
      expect(binarySent.single.bytes, orderedEquals(utf8.encode(committed)));
      expect(utf8.decode(binarySent.single.bytes), committed);
    },
  );

  test('malformed PTY UTF-8 renders replacement text without resync', () async {
    await ready();
    await session.handleBinary(
      output(0, utf8.encode('screen '), keyframe: true, cols: 80, rows: 24),
    );

    await session.handleBinary(output(1, [0x80, ...utf8.encode('tail')]));

    expect(session.status, TerminalSessionStatus.controlling);
    expect(session.terminal.buffer.getText(), contains('\uFFFDtail'));
    expect(sent.where((frame) => frame.type == 'terminal_resync'), isEmpty);
  });

  test(
    'local cursor blink preserves the remote cursor visibility state',
    () async {
      await ready();
      await session.handleBinary(
        output(
          0,
          utf8.encode('prompt\x1b[?25h'),
          keyframe: true,
          cols: 80,
          rows: 24,
        ),
      );

      session.setCursorBlinkPhase(false);
      expect(session.terminal.cursorVisibleMode, isFalse);

      // Ordinary output while the paint phase is dark must not become a remote
      // cursor-hide command. The next bright phase restores the cursor.
      await session.handleBinary(output(1, utf8.encode('x')));
      expect(session.terminal.cursorVisibleMode, isFalse);
      session.setCursorBlinkPhase(true);
      expect(session.terminal.cursorVisibleMode, isTrue);

      // An explicit remote hide stays hidden through later blink phases.
      await session.handleBinary(output(2, utf8.encode('\x1b[?25l')));
      session.setCursorBlinkPhase(false);
      session.setCursorBlinkPhase(true);
      expect(session.terminal.cursorVisibleMode, isFalse);
    },
  );

  test('remote history keyframe survives viewport resize without circular-buffer reflow', () async {
    await ready();
    final oldStyleHistory = List.generate(
      1000,
      (index) => '\x1b[3${index % 8}mremote-history-$index\x1b[0m\r\n',
    ).join();
    final keyframe = utf8.encode(
      '\x1bc\x1b[?25l\x1b[?7l\x1b[H\x1b[2J\x1b[3J'
      '$oldStyleHistory\x1b[1;1Hremote-current-screen\x1b[0m'
      '\x1b[20;7H\x1b[?7h\x1b[?25h',
    );

    await session.handleBinary(
      output(0, keyframe, keyframe: true, cols: 154, rows: 48),
    );

    expect(session.terminal.reflowEnabled, isFalse);
    expect(
      session.terminal.buffer.getText(),
      contains('remote-current-screen'),
    );
    expect(() => session.terminal.resize(235, 52), returnsNormally);
    expect(() => session.terminal.resize(154, 48), returnsNormally);
    expect(session.status, TerminalSessionStatus.controlling);
  });

  test(
    'scroll-region output keeps buffer lines attached across frames',
    () async {
      await ready();
      await session.handleBinary(
        output(
          0,
          utf8.encode(
            'one\r\ntwo\r\nthree\r\nfour\r\nfive'
            '\x1b[2;5r\x1b[5;1H\n',
          ),
          keyframe: true,
          cols: 80,
          rows: 24,
        ),
      );

      // The first partial-region scroll used to leave duplicated, detached
      // BufferLine objects. A later top-anchored scroll then crashed inside
      // IndexAwareCircularBuffer.insert, matching the Grok live failure.
      await session.handleBinary(
        output(1, utf8.encode('\x1b[1;5r\x1b[5;1H\nnext')),
      );

      expect(session.status, TerminalSessionStatus.controlling);
      expect(session.terminal.buffer.getText(), contains('next'));
      expect(sent.where((frame) => frame.type == 'terminal_resync'), isEmpty);
    },
  );

  test(
    'reverse-index scroll keeps buffer lines attached across frames',
    () async {
      await ready();
      await session.handleBinary(
        output(
          0,
          utf8.encode(
            'one\r\ntwo\r\nthree\r\nfour\r\nfive'
            '\x1b[2;5r\x1b[2;1H\x1bM',
          ),
          keyframe: true,
          cols: 80,
          rows: 24,
        ),
      );

      await session.handleBinary(
        output(1, utf8.encode('\x1b[1;5r\x1b[5;1H\nnext')),
      );

      expect(session.status, TerminalSessionStatus.controlling);
      expect(session.terminal.buffer.getText(), contains('next'));
      expect(sent.where((frame) => frame.type == 'terminal_resync'), isEmpty);
    },
  );

  test('Grok keyframes use remote-owned alternate-buffer scrolling', () async {
    session.dispose();
    session = TerminalSession(
      machineId: 'machine-1',
      agentId: 'agent-1',
      agentName: 'grok-agent',
      engineId: 'grok',
      send: (type, payload) async {
        sent.add((type: type, payload: Map<String, dynamic>.from(payload)));
        return true;
      },
      sendBinary: (frame) async {
        binarySent.add(frame);
        return true;
      },
    );
    await ready();

    final staleRepaints = List.generate(
      80,
      (index) => '\x1b[31mstale-grok-frame-$index\x1b[0m\r\n',
    ).join();
    await session.handleBinary(
      output(
        0,
        utf8.encode(
          '\x1bc\x1b[?25l\x1b[?7l\x1b[H\x1b[2J'
          '$staleRepaints'
          '\x1b[H\x1b[2J\x1b[?1003h\x1b[?1006h'
          '\x1b[1;1Hcurrent-grok-screen\x1b[0m'
          '\x1b[5;7H\x1b[?7h\x1b[?25h',
        ),
        keyframe: true,
        cols: 80,
        rows: 24,
      ),
    );

    expect(session.terminal.isUsingAltBuffer, isTrue);
    expect(session.terminal.buffer.getText(), contains('current-grok-screen'));
    expect(
      session.terminal.buffer.getText(),
      isNot(contains('stale-grok-frame')),
    );
  });

  test('scrollViaTmuxCopyMode is true only for grok, mirroring _prepareKeyframeBytes', () {
    expect(
      session.scrollViaTmuxCopyMode,
      isFalse,
    ); // engineId: 'codex' from setUp
  });

  group('sendScrollCommand (grok only)', () {
    Future<void> readyGrokSession() async {
      session.dispose();
      session = TerminalSession(
        machineId: 'machine-1',
        agentId: 'agent-1',
        agentName: 'grok-agent',
        engineId: 'grok',
        send: (type, payload) async {
          sent.add((type: type, payload: Map<String, dynamic>.from(payload)));
          return true;
        },
        sendBinary: (frame) async {
          binarySent.add(frame);
          return true;
        },
      );
      await ready();
      // acceptsInput (which _flushScrollCommand requires) only becomes true once a keyframe has
      // been applied — terminal_ready alone leaves status at `opening`.
      await session.handleBinary(
        output(0, utf8.encode('grok'), keyframe: true, cols: 100, rows: 30),
      );
    }

    test(
      'is a no-op for a non-grok session — codex still uses raw mouseInput',
      () async {
        await ready();
        session.sendScrollCommand(true, 5);
        await Future<void>.delayed(const Duration(milliseconds: 30));
        expect(sent.where((f) => f.type == 'terminal_scroll'), isEmpty);
      },
    );

    test('coalesces a burst of same-direction deltas into one frame', () async {
      await readyGrokSession();
      sent.clear();

      for (var i = 0; i < 5; i++) {
        session.sendScrollCommand(true, 1);
      }
      expect(
        sent.where((f) => f.type == 'terminal_scroll'),
        isEmpty,
      ); // still coalescing

      await Future<void>.delayed(const Duration(milliseconds: 30));
      final scrolls = sent.where((f) => f.type == 'terminal_scroll').toList();
      expect(scrolls, hasLength(1));
      expect(scrolls.single.payload['direction'], 'up');
      expect(scrolls.single.payload['lines'], 5);
      expect(scrolls.single.payload['streamId'], streamId);
    });

    test(
      'a direction reversal mid-burst flushes the first batch separately',
      () async {
        await readyGrokSession();
        sent.clear();

        session.sendScrollCommand(true, 3);
        session.sendScrollCommand(true, 2);
        session.sendScrollCommand(
          false,
          1,
        ); // reverses direction — flushes the 5 "up" first
        await Future<void>.delayed(const Duration(milliseconds: 30));

        final scrolls = sent
            .where((f) => f.type == 'terminal_scroll')
            .map((f) => f.payload)
            .toList();
        expect(scrolls, hasLength(2));
        expect(scrolls[0]['direction'], 'up');
        expect(scrolls[0]['lines'], 5);
        expect(scrolls[1]['direction'], 'down');
        expect(scrolls[1]['lines'], 1);
      },
    );
  });

  test('Ctrl+C (0x03) is forwarded like any other keystroke', () async {
    await ready();
    await session.handleBinary(
      output(0, utf8.encode(r'prompt> '), keyframe: true, cols: 80, rows: 24),
    );

    session.terminal.onOutput?.call('\x03');
    await Future<void>.delayed(const Duration(milliseconds: 12));
    expect(binarySent, hasLength(1));
    expect(utf8.decode(binarySent.single.bytes), '\x03');

    session.terminal.onOutput?.call('a\x03b');
    await Future<void>.delayed(const Duration(milliseconds: 12));
    expect(binarySent, hasLength(2));
    expect(utf8.decode(binarySent[1].bytes), 'a\x03b');
  });

  test(
    'sequence gap emits one resync and next keyframe replaces state',
    () async {
      await ready();
      await session.handleBinary(
        output(
          0,
          utf8.encode('old screen'),
          keyframe: true,
          cols: 80,
          rows: 24,
        ),
      );
      final oldTerminal = session.terminal;

      await session.handleBinary(output(2, utf8.encode('gap')));
      await session.handleBinary(output(3, utf8.encode('ignored')));
      expect(session.status, TerminalSessionStatus.resyncing);
      expect(
        sent.where((frame) => frame.type == 'terminal_resync'),
        hasLength(1),
      );

      await session.handleBinary(
        output(
          9,
          utf8.encode('new screen'),
          keyframe: true,
          cols: 90,
          rows: 28,
        ),
      );
      expect(session.status, TerminalSessionStatus.controlling);
      expect(session.errorCode, isNull);
      expect(identical(oldTerminal, session.terminal), isFalse);
      expect(session.terminal.buffer.getText(), startsWith('new screen'));
      expect(session.cols, 90);
      expect(session.rows, 28);
    },
  );

  test(
    'idle sync advances sequence and is acknowledged after render',
    () async {
      await ready();
      await session.handleBinary(
        output(0, utf8.encode('screen'), keyframe: true, cols: 80, rows: 24),
      );
      await session.handleBinary(
        TerminalBinaryFrame(
          kind: TerminalBinaryKind.sync,
          streamId: streamId,
          seq: 1,
          bytes: Uint8List(0),
          compressed: false,
        ),
      );
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(session.status, TerminalSessionStatus.controlling);
      expect(
        sent
            .lastWhere((frame) => frame.type == 'terminal_ack')
            .payload['lastSeq'],
        1,
      );
    },
  );

  test(
    'takeover freezes the rendered terminal until the user reconnects',
    () async {
      await ready();
      await session.handleBinary(
        output(
          0,
          utf8.encode('last screen'),
          keyframe: true,
          cols: 80,
          rows: 24,
        ),
      );

      await session.handleFrame('terminal_closed', {
        'streamId': streamId,
        'code': 'TERMINAL_TAKEN_OVER',
        'reason': 'another client connected',
      });

      expect(session.status, TerminalSessionStatus.takenOver);
      expect(session.acceptsInput, isFalse);
      expect(session.errorCode, 'TERMINAL_TAKEN_OVER');
      expect(session.errorMessage, contains('Another client'));
      expect(session.terminal.buffer.getText(), contains('last screen'));

      // A WS hiccup on this machine (node offline/online) must not turn a takeover into a plain
      // `error`, which auto-reattach would then silently reopen — re-stealing the terminal back
      // from whoever took it over.
      session.transportLost('Harness reconnected; restoring terminal…');
      expect(session.status, TerminalSessionStatus.takenOver);
    },
  );

  test(
    'terminal_link_mode updates linkMode, ignoring a stale stream id',
    () async {
      await ready();
      expect(session.linkMode, isNull);

      await session.handleFrame('terminal_link_mode', {
        'streamId': streamId,
        'mode': 'p2p',
      });
      expect(session.linkMode, 'p2p');

      await session.handleFrame('terminal_link_mode', {
        'streamId': streamId,
        'mode': 'relay',
      });
      expect(session.linkMode, 'relay');

      // A frame for a DIFFERENT (stale) stream id must not touch this session's state.
      await session.handleFrame('terminal_link_mode', {
        'streamId': 'some-other-stream',
        'mode': 'p2p',
      });
      expect(session.linkMode, 'relay');
    },
  );

  test('terminal_link_mode accepts turn, the third transport, alongside the other two', () async {
    await ready();

    // 'turn' is additive: 'relay' keeps meaning the backend WebSocket, so a build that predates TURN
    // can never read a Cloudflare-relayed session as a WS-relayed one.
    for (final mode in ['p2p', 'turn', 'relay']) {
      await session.handleFrame('terminal_link_mode', {
        'streamId': streamId,
        'mode': mode,
      });
      expect(session.linkMode, mode);
    }
  });

  test(
    'a mode this build cannot draw leaves the last known one alone',
    () async {
      await ready();
      await session.handleFrame('terminal_link_mode', {
        'streamId': streamId,
        'mode': 'turn',
      });
      expect(session.linkMode, 'turn');

      // A newer CLI inventing a fourth value must not blank the badge or set a value the header has no
      // icon for — the allow-list is what keeps linkMode drawable.
      await session.handleFrame('terminal_link_mode', {
        'streamId': streamId,
        'mode': 'quic',
      });
      expect(session.linkMode, 'turn');
    },
  );

  test(
    'linkMode resets whenever streamId resets (reopen/close/error)',
    () async {
      await ready();
      await session.handleFrame('terminal_link_mode', {
        'streamId': streamId,
        'mode': 'p2p',
      });
      expect(session.linkMode, 'p2p');

      await session.handleFrame('terminal_closed', {
        'streamId': streamId,
        'reason': 'closed by peer',
      });
      expect(session.streamId, isNull);
      expect(session.linkMode, isNull);
    },
  );

  test('resync retries three times, reopens once, then fails closed', () async {
    session.dispose();
    session = TerminalSession(
      machineId: 'machine-1',
      agentId: 'agent-1',
      agentName: 'backend-api',
      engineId: 'codex',
      resyncTimeout: const Duration(milliseconds: 5),
      send: (type, payload) async {
        sent.add((type: type, payload: Map<String, dynamic>.from(payload)));
        return true;
      },
      sendBinary: (frame) async {
        binarySent.add(frame);
        return true;
      },
    );
    await ready();
    await session.handleBinary(
      output(0, utf8.encode('screen'), keyframe: true, cols: 80, rows: 24),
    );
    await session.handleBinary(output(2, utf8.encode('gap')));

    await Future<void>.delayed(const Duration(milliseconds: 45));

    expect(
      sent.where((frame) => frame.type == 'terminal_resync'),
      hasLength(3),
    );
    expect(sent.where((frame) => frame.type == 'terminal_open'), hasLength(2));
    expect(sent.where((frame) => frame.type == 'terminal_close'), hasLength(1));
    expect(session.status, TerminalSessionStatus.error);
    expect(session.errorCode, 'TERMINAL_RESYNC_TIMEOUT');
  });

  group('composer', () {
    /// The `message` frames this session put on the wire.
    List<Map<String, dynamic>> messages() => [
      for (final frame in sent)
        if (frame.type == 'message') frame.payload,
    ];

    Future<void> live() async {
      await ready();
      await session.handleBinary(
        output(0, utf8.encode(r'$ '), keyframe: true, cols: 100, rows: 30),
      );
      sent.clear();
    }

    test('drives a turn with the same frame the web client uses', () async {
      await live();

      expect(await session.sendComposerText('run the tests'), isTrue);

      expect(messages(), hasLength(1));
      expect(messages().single['content'], 'run the tests');
      expect(messages().single['agentId'], 'agent-1');
      expect(messages().single['mode'], 'auto');
      // Nothing is typed into the pane: injection is the machine's job, and doing it here is what
      // left a composed line sitting unsent in Codex.
      expect(binarySent, isEmpty);
    });

    test('carries a multi-line body through verbatim', () async {
      await live();

      expect(await session.sendComposerText('first line\nsecond line'), isTrue);

      // No bracketed-paste wrapping of our own — the machine decides how to inject it.
      expect(messages().single['content'], 'first line\nsecond line');
      expect(messages().single['content'], isNot(contains('\x1b[200~')));
    });

    test('drops a trailing newline so it cannot double the submit', () async {
      await live();

      expect(await session.sendComposerText('ship it\n'), isTrue);

      expect(messages().single['content'], 'ship it');
    });

    test('forwards Ctrl+C in composed text rather than stripping it', () async {
      await live();

      expect(await session.sendComposerText('a\x03b'), isTrue);

      expect(messages().single['content'], 'a\x03b');
    });

    test('sends nothing while the stream is not accepting input', () async {
      expect(session.acceptsInput, isFalse);
      expect(await session.sendComposerText('should not go'), isFalse);
      expect(messages(), isEmpty);
    });

    test('sends nothing for a body that is only whitespace', () async {
      await live();

      expect(await session.sendComposerText(''), isFalse);
      expect(await session.sendComposerText('   \n  '), isFalse);
      expect(messages(), isEmpty);
    });
  });

  group('pasteText', () {
    /// The `TerminalBinaryKind.paste` frames this session put on the wire.
    List<TerminalBinaryFrame> pastes() => [
      for (final frame in binarySent)
        if (frame.kind == TerminalBinaryKind.paste) frame,
    ];

    Future<void> live() async {
      await ready();
      await session.handleBinary(
        output(0, utf8.encode(r'$ '), keyframe: true, cols: 100, rows: 30),
      );
      sent.clear();
      binarySent.clear();
    }

    test(
      'sends the whole clipboard as one binary frame, not chunked',
      () async {
        await live();
        final big = List.generate(200, (i) => 'line $i').join('\n');

        expect(await session.pasteText(big), isTrue);

        expect(pastes(), hasLength(1));
        expect(utf8.decode(pastes().single.bytes), big);
        expect(pastes().single.streamId, streamId);
        expect(pastes().single.compressed, isFalse);
        // Never through the ordinary keystroke pipeline this feature exists to avoid, and never as JSON.
        expect(
          binarySent.where((f) => f.kind == TerminalBinaryKind.input),
          isEmpty,
        );
        expect(sent, isEmpty);
      },
    );

    test('forwards Ctrl+C in a paste rather than stripping it', () async {
      await live();

      expect(await session.pasteText('a\x03b'), isTrue);

      expect(utf8.decode(pastes().single.bytes), 'a\x03b');
    });

    test('sends nothing while the stream is not accepting input', () async {
      expect(session.acceptsInput, isFalse);
      expect(await session.pasteText('should not go'), isFalse);
      expect(pastes(), isEmpty);
    });

    test('sends nothing for an empty paste', () async {
      await live();

      expect(await session.pasteText(''), isFalse);
      expect(pastes(), isEmpty);
    });

    test('a rejected paste (too large/empty) leaves the stream alive, unlike every other terminal_error', () async {
      await live();

      final handled = await session.handleFrame('terminal_error', {
        'streamId': streamId,
        'code': 'TERMINAL_PASTE_INVALID',
        'message': 'paste too large',
      });

      expect(handled, isTrue);
      expect(session.status, TerminalSessionStatus.controlling);
      expect(session.streamId, streamId);
      expect(session.errorCode, isNull);
    });

    test('a real paste delivery failure still freezes the stream, like resize/input failures do', () async {
      await live();

      await session.handleFrame('terminal_error', {
        'streamId': streamId,
        'code': 'TERMINAL_PASTE_FAILED',
        'message': 'tmux paste-buffer could not be sent',
      });

      expect(session.status, TerminalSessionStatus.error);
      expect(session.errorCode, 'TERMINAL_PASTE_FAILED');
    });
  });

  group('pasteImage / pasteFile — chunked upload', () {
    List<TerminalBinaryFrame> imagePastes() => [
      for (final frame in binarySent)
        if (frame.kind == TerminalBinaryKind.imagePaste) frame,
    ];
    List<TerminalBinaryFrame> filePastes() => [
      for (final frame in binarySent)
        if (frame.kind == TerminalBinaryKind.pasteFile) frame,
    ];

    Future<void> live() async {
      await ready();
      await session.handleBinary(
        output(0, utf8.encode(r'$ '), keyframe: true, cols: 100, rows: 30),
      );
      sent.clear();
      binarySent.clear();
    }

    /// Lets the microtasks/event-loop turns between `session.pasteImage`/`pasteFile`'s internal
    /// awaits (send → await begin_result → send chunks → await the result frame) actually run,
    /// so the test can inject the simulated server replies in between.
    Future<void> pump() => Future<void>.delayed(Duration.zero);

    Future<void> acceptBegin() async {
      await pump();
      expect(sent.single.type, 'terminal_chunked_upload_begin');
      await session.handleFrame('terminal_chunked_upload_begin_result', {
        'streamId': streamId,
        'accepted': true,
      });
    }

    test(
      'image: begin → one chunk → result, and reports live progress',
      () async {
        await live();
        final png = Uint8List.fromList(const [
          0x89,
          0x50,
          0x4e,
          0x47,
          0x0d,
          0x0a,
          0x1a,
          0x0a,
          0xff,
        ]);

        final future = session.pasteImage(png);
        await acceptBegin();
        expect(sent.single.payload, containsPair('uploadKind', 'image'));
        expect(sent.single.payload, containsPair('totalBytes', png.length));
        expect(sent.single.payload, isNot(contains('filename')));

        await pump();
        expect(imagePastes(), hasLength(1));
        expect(imagePastes().single.bytes, png);
        expect(imagePastes().single.seq, 0);
        expect(imagePastes().single.compressed, isFalse);
        // Never through the ordinary keystroke pipeline or the text-paste kind.
        expect(
          binarySent.where((f) => f.kind == TerminalBinaryKind.input),
          isEmpty,
        );
        expect(
          binarySent.where((f) => f.kind == TerminalBinaryKind.paste),
          isEmpty,
        );

        expect(session.uploadProgress, isNotNull);
        await session.handleFrame('terminal_chunked_upload_progress', {
          'streamId': streamId,
          'bytesWritten': png.length,
          'totalBytes': png.length,
        });
        expect(session.uploadProgress!.percent, 1.0);

        await session.handleFrame('terminal_paste_image_result', {
          'streamId': streamId,
          'outcome': 'clipboard',
        });
        expect(await future, isTrue);
        expect(session.uploadProgress, isNull); // cleared once finished
      },
    );

    test(
      'file: begin carries the filename, and the result frame finishes it',
      () async {
        await live();
        final content = Uint8List.fromList(const [0x25, 0x50, 0x44, 0x46]);

        final future = session.pasteFile('report.pdf', content);
        await acceptBegin();
        expect(sent.single.payload, containsPair('uploadKind', 'file'));
        expect(sent.single.payload, containsPair('filename', 'report.pdf'));

        await pump();
        expect(filePastes(), hasLength(1));
        expect(filePastes().single.bytes, content);

        await session.handleFrame('terminal_paste_file_result', {
          'streamId': streamId,
          'path': '/remote/path/report.pdf',
        });
        expect(await future, isTrue);
      },
    );

    test(
      'splits a large image across several chunks, indexed by seq',
      () async {
        await live();
        final big = Uint8List(terminalUploadChunkBytes * 2 + 100)
          ..fillRange(0, terminalUploadChunkBytes * 2 + 100, 0xab);

        final future = session.pasteImage(big);
        await acceptBegin();
        await pump();

        expect(imagePastes(), hasLength(3));
        expect(imagePastes().map((f) => f.seq), [0, 1, 2]);
        expect(imagePastes()[0].bytes, hasLength(terminalUploadChunkBytes));
        expect(imagePastes()[1].bytes, hasLength(terminalUploadChunkBytes));
        expect(imagePastes()[2].bytes, hasLength(100));

        await session.handleFrame('terminal_paste_image_result', {
          'streamId': streamId,
          'outcome': 'clipboard',
        });
        expect(await future, isTrue);
      },
    );

    test(
      'resolves false, with no chunks sent, when begin is not accepted',
      () async {
        await live();
        final png = Uint8List.fromList(const [1, 2, 3]);

        final future = session.pasteImage(png);
        await pump();
        await session.handleFrame('terminal_chunked_upload_begin_result', {
          'streamId': streamId,
          'accepted': false,
          'reason': 'an upload is already in progress on this pane',
        });

        expect(await future, isFalse);
        expect(imagePastes(), isEmpty);
        expect(session.uploadProgress, isNull);
      },
    );

    test(
      'a malformed-chunk error clears the upload without freezing the session',
      () async {
        await live();
        final png = Uint8List.fromList(const [1, 2, 3]);

        final future = session.pasteImage(png);
        await acceptBegin();
        await pump();

        await session.handleFrame('terminal_error', {
          'streamId': streamId,
          'code': 'TERMINAL_CHUNKED_UPLOAD_INVALID',
          'message': 'malformed upload chunk',
        });

        expect(await future, isFalse);
        expect(session.status, TerminalSessionStatus.controlling);
        expect(session.uploadProgress, isNull);
      },
    );

    test('a genuine mid-transfer failure freezes the session, like TERMINAL_PASTE_FAILED does', () async {
      await live();
      final png = Uint8List.fromList(const [1, 2, 3]);

      final future = session.pasteImage(png);
      await acceptBegin();
      await pump();

      await session.handleFrame('terminal_error', {
        'streamId': streamId,
        'code': 'TERMINAL_PASTE_IMAGE_FAILED',
        'message': 'xclip exited with code 1',
      });

      expect(await future, isFalse);
      expect(session.status, TerminalSessionStatus.error);
      expect(session.errorCode, 'TERMINAL_PASTE_IMAGE_FAILED');
      expect(session.uploadProgress, isNull);
    });

    test('cancelUpload stops the transfer and tells the daemon', () async {
      await live();
      final png = Uint8List.fromList(const [1, 2, 3]);

      final future = session.pasteImage(png);
      await acceptBegin();
      await pump();
      expect(session.uploadProgress, isNotNull);

      await session.cancelUpload();
      expect(await future, isFalse);
      expect(session.uploadProgress, isNull);
      expect(sent.last, isA<Object>());
      expect(sent.last.type, 'terminal_chunked_upload_cancel');
      expect(sent.last.payload['streamId'], streamId);
    });

    test(
      'rejects a second upload while one is already in flight on this session',
      () async {
        await live();
        final png = Uint8List.fromList(const [1, 2, 3]);

        final first = session.pasteImage(png);
        await acceptBegin();
        await pump();

        expect(
          await session.pasteFile('a.txt', Uint8List.fromList(const [1])),
          isFalse,
        );

        await session.handleFrame('terminal_paste_image_result', {
          'streamId': streamId,
          'outcome': 'clipboard',
        });
        expect(await first, isTrue);
      },
    );

    test('sends nothing while the stream is not accepting input', () async {
      expect(session.acceptsInput, isFalse);
      expect(
        await session.pasteImage(Uint8List.fromList(const [1, 2, 3])),
        isFalse,
      );
      expect(
        await session.pasteFile('a.txt', Uint8List.fromList(const [1])),
        isFalse,
      );
      expect(imagePastes(), isEmpty);
      expect(filePastes(), isEmpty);
    });

    test(
      'sends nothing for an empty image or an empty filename/content',
      () async {
        await live();

        expect(await session.pasteImage(Uint8List(0)), isFalse);
        expect(
          await session.pasteFile('', Uint8List.fromList(const [1])),
          isFalse,
        );
        expect(await session.pasteFile('a.txt', Uint8List(0)), isFalse);
        expect(imagePastes(), isEmpty);
        expect(filePastes(), isEmpty);
        expect(sent, isEmpty);
      },
    );
  });
}
