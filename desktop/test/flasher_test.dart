import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/flash/flasher.dart';

/// A process whose output is a script, so the parsing rules can be exercised
/// without a board, a cable, or a shell.
class _FakeProcess implements Process {
  _FakeProcess({
    required this.out,
    this.err = const [],
    this.code = 0,
    this.waitForKill = false,
  });

  final List<String> out;
  final List<String> err;
  final int code;

  /// Keeps running until something signals it — the only way to exercise a
  /// cancel, since a process that has already exited cannot be cancelled.
  final bool waitForKill;
  final List<ProcessSignal> signals = [];
  final Completer<int> _exit = Completer<int>();

  @override
  Stream<List<int>> get stdout =>
      Stream.value(utf8.encode(out.map((l) => '$l\n').join()));

  @override
  Stream<List<int>> get stderr =>
      Stream.value(utf8.encode(err.map((l) => '$l\n').join()));

  @override
  Future<int> get exitCode => waitForKill ? _exit.future : Future.value(code);

  @override
  bool kill([ProcessSignal signal = ProcessSignal.sigterm]) {
    signals.add(signal);
    if (!_exit.isCompleted) _exit.complete(code);
    return true;
  }

  @override
  int get pid => 4242;

  @override
  IOSink get stdin => throw UnimplementedError();
}

void main() {
  group('classifyFlashLine', () {
    test('a >> line opens a step, and loses its marker in the title', () {
      final line = classifyFlashLine(
        '>> flashing 0.0.39 → /dev/cu.usbmodem',
        stderr: false,
      );
      expect(line.kind, FlashLineKind.step);
      expect(line.title, 'flashing 0.0.39 → /dev/cu.usbmodem');
    });

    test('an indented line details the step it follows', () {
      expect(
        classifyFlashLine('   write app (0x10000)', stderr: false).kind,
        FlashLineKind.detail,
      );
    });

    test('error: wins over the stream it arrived on', () {
      // The script writes `die` to stderr, but a line that names itself an
      // error must read as one from either stream — the prefix is the claim.
      expect(
        classifyFlashLine('error: cancelled', stderr: true).kind,
        FlashLineKind.error,
      );
      expect(
        classifyFlashLine('error: cancelled', stderr: false).kind,
        FlashLineKind.error,
      );
    });

    test('anything else on stderr is a warning, not routine detail', () {
      expect(
        classifyFlashLine(
          '   sha256 mismatch — not installing',
          stderr: true,
        ).kind,
        FlashLineKind.warning,
      );
    });
  });

  group('probe', () {
    test('reads the port the script settled on', () async {
      final flasher = Flasher(
        startProcess: (_) async => _FakeProcess(
          out: [
            '>> probing 2 serial port(s)…',
            '>> board: /dev/cu.usbmodem2101',
            '>> detect-only: nothing was written.',
          ],
        ),
      );
      final probe = await flasher.probe();
      expect(probe.found, isTrue);
      expect(probe.ports, ['/dev/cu.usbmodem2101']);
      expect(probe.problem, isNull);
    });

    test('a bare exit 1 still yields a reason to show', () async {
      final flasher = Flasher(
        startProcess: (_) async => _FakeProcess(
          out: ['>> probing 1 serial port(s)…'],
          err: ['error: no ESP32-S3 found'],
          code: 1,
        ),
      );
      final probe = await flasher.probe();
      expect(probe.found, isFalse);
      // Stripped of the prefix: the dialog puts it under a heading that already
      // says something went wrong.
      expect(probe.problem, 'no ESP32-S3 found');
    });

    test(
      'names the permission case rather than calling it "not found"',
      () async {
        final flasher = Flasher(
          startProcess: (_) async => _FakeProcess(
            out: ['>> probing 1 serial port(s)…'],
            err: ['   /dev/cu.usbmodem2101 — no permission'],
            code: 1,
          ),
        );
        expect(
          (await flasher.probe()).problem,
          'no permission to open the serial port',
        );
      },
    );
  });

  test('cancel asks with SIGTERM so the script can run its trap', () async {
    // SIGKILL would skip `trap start_harness_after_flash EXIT INT TERM`, which
    // is the only thing that restarts the daemon the script stopped.
    late _FakeProcess spawned;
    final flasher = Flasher(
      startProcess: (_) async {
        spawned = _FakeProcess(
          out: ['>> flashing…'],
          code: 143,
          waitForKill: true,
        );
        return spawned;
      },
    );
    final run = flasher.flash();
    await Future<void>.delayed(Duration.zero);
    flasher.cancel();
    final result = await run;

    expect(spawned.signals, [ProcessSignal.sigterm]);
    expect(result.cancelled, isTrue);
    expect(result.ok, isFalse);
  });

  test('a port stays one literal argv value', () async {
    List<String>? seen;
    final flasher = Flasher(
      startProcess: (arguments) async {
        seen = arguments;
        return _FakeProcess(out: const []);
      },
    );
    await flasher.flash(port: "/dev/cu.o'dd");
    expect(seen, ['flash', '--yes', '--port', "/dev/cu.o'dd"]);
  });
}
