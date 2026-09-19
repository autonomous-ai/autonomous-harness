import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/utf16_probe_encoding.dart';
import 'package:harness/core/wsl_runtime.dart';

/// Pins the review cycle-2 P2 fix at the BYTE boundary: production decodes
/// `wsl.exe` output with [Utf16LeProbeEncoding], which sniffs the NUL
/// alternation in the RAW bytes. The old path ran the strict UTF-8 stream
/// codec first, so a non-ASCII distro name failed or corrupted inside the
/// decoder and the swallowed stream error yielded an EMPTY inventory while
/// `wsl.exe` exited 0.
///
/// Review cycle-3 P2 adds two pins: a BOM is decisive wide evidence on its
/// own (a non-Latin-dominant buffer fails the NUL census but still starts
/// with 0xFF 0xFE), and a CJK-dominant buffer with NO ASCII prefix round-trips.

void main() {
  group('Utf16LeProbeEncoding (byte-level, review cycle-2 P2)', () {
    List<int> utf16le(String text) {
      final bytes = <int>[];
      for (final cu in text.codeUnits) {
        bytes..add(cu & 0xff)..add(cu >> 8);
      }
      return bytes;
    }

    test('decodes wide output with a non-ASCII distro name intact', () {
      const name = 'Ubuntu-é';
      final bytes = utf16le('$name\r\n');
      final text = const Utf16LeProbeEncoding().decoder.convert(bytes);
      expect(text.replaceAll('\r\n', '\n').trim(), name);
    });

    test('decodes wide output with CJK distro names intact', () {
      const name = 'Ubuntu-任';
      final bytes = utf16le('$name\r\n');
      final text = const Utf16LeProbeEncoding().decoder.convert(bytes);
      expect(text.replaceAll('\r\n', '\n').trim(), name);
    });

    test('a BOM forces the wide decode even for a CJK-dominant inventory (review cycle-3 P2)', () {
      // A non-Latin-dominant buffer fails the NUL census - for one short line of
      // Japanese only 2 of 5 high bytes are NUL - so before this fix the decoder
      // fell through to the byte-mapped single-byte path and produced mojibake.
      // wsl.exe's BOM (0xFF 0xFE) is decisive wide evidence on its own, and real
      // wide console output always begins with one. No ASCII prefix here: the old
      // 'Ubuntu-X' shape masked the failure with its Latin head.
      const name = '日本語';
      final bytes = <int>[0xff, 0xfe]..addAll(utf16le('$name\r\n'));
      final text = const Utf16LeProbeEncoding().decoder.convert(bytes);
      expect(text.replaceAll('\r\n', '\n').trim(), name);
    });

    test('a CJK inventory with mixed lines decodes through the BOM path (review cycle-3 P2)', () {
      final bytes = <int>[0xff, 0xfe]
        ..addAll(utf16le('日本語\r\nUbuntu-24.04\r\n'));
      final text = const Utf16LeProbeEncoding().decoder.convert(bytes);
      expect(
        text.replaceAll('\r\n', '\n').split('\n').where((l) => l.trim().isNotEmpty).toList(),
        ['日本語', 'Ubuntu-24.04'],
      );
    });

    test('decodes a BOM-LESS CJK-dominant inventory (review cycle-4 P2)', () {
      // wsl.exe documentedly emits BOM-less wide output (WSL issue 4607). For one short line of
      // Japanese only 2 of 5 high bytes are NUL, so the NUL census rejects the buffer — and the
      // old fallthrough decoded it as byte-mapped mojibake. No BOM and no ASCII prefix here:
      // the exact shape the census missed.
      const name = '日本語';
      final bytes = utf16le('$name\r\n');
      final text = const Utf16LeProbeEncoding().decoder.convert(bytes);
      expect(text.replaceAll('\r\n', '\n').trim(), name);
    });

    test('a BOM-less mixed CJK inventory decodes wide through the alternation census', () {
      final bytes = utf16le('日本語\r\nUbuntu-24.04\r\n');
      final text = const Utf16LeProbeEncoding().decoder.convert(bytes);
      expect(
        text.replaceAll('\r\n', '\n').split('\n').where((l) => l.trim().isNotEmpty).toList(),
        ['日本語', 'Ubuntu-24.04'],
      );
    });

    test('decodes ASCII wide output (NUL high bytes) with a BOM', () {
      final bytes = <int>[0xff, 0xfe]..addAll(utf16le('Ubuntu\r\nDebian\r\n'));
      final text = const Utf16LeProbeEncoding().decoder.convert(bytes);
      expect(
        text.replaceAll('\r\n', '\n').split('\n').where((l) => l.trim().isNotEmpty).toList(),
        ['Ubuntu', 'Debian'],
      );
    });

    test('keeps single-byte output byte-faithful', () {
      const text = 'Ubuntu\r\nDebian\r\n';
      final decoded = const Utf16LeProbeEncoding().decoder.convert(utf8.encode(text));
      expect(decoded.replaceAll('\r\n', '\n').trim(), 'Ubuntu\nDebian');
    });

    test('chunked conversion emits at close (stream pipeline shape)', () async {
      final bytes = utf16le('Ubuntu-é\r\n');
      final chunks = [bytes.sublist(0, 5), bytes.sublist(5)];
      final out = <String>[];
      final sink = const Utf16LeProbeEncoding().decoder
          .startChunkedConversion(_CollectingSink(out));
      for (final chunk in chunks) {
        sink.add(chunk);
      }
      sink.close();
      expect(out.single.replaceAll('\r\n', '\n').trim(), 'Ubuntu-é');
    });

    test('a streamed strict-UTF-8 pipeline used to fail on these bytes', () {
      // Documents the OLD failure mode: utf8.decode on a wide buffer throws
      // (0x9f/0xc3 sequences), which the stream error handler swallowed.
      final bytes = utf16le('Ubuntu-é' + String.fromCharCode(13) + String.fromCharCode(10));
      expect(() => utf8.decode(bytes), throwsFormatException);
      // The new decoder handles exactly those bytes.
      expect(
        const Utf16LeProbeEncoding().decoder.convert(bytes).trim(),
        'Ubuntu-é',
      );
    });
  });

  group('listDistros string-seam decode (injected runProcess, review cycle-5 P2)', () {
    /// A fake [_runProcess] seam handing back an already-decoded PLAIN string —
    /// the production shape, since `_runBounded`'s [Utf16LeProbeEncoding] has
    /// already decoded the wide bytes by the time they reach the seam.
    Future<List<String>> distrosFrom(String plainStdout) async {
      final runtime = WslRuntime(
        runProcess: (executable, arguments, {environment}) async =>
            ProcessResult(0, 0, plainStdout, ''),
      );
      return runtime.listDistros();
    }

    test('preserves already-decoded Unicode distribution names', () async {
      expect(await distrosFrom('Ubuntu-任\r\n日本語\r\n'), ['Ubuntu-任', '日本語']);
    });

    test('decodes Unicode names through the owned process pipeline', () async {
      const inventory = 'Ubuntu-任\r\n日本語\r\n';
      final bytes = <int>[
        0xff, 0xfe,
        for (final unit in inventory.codeUnits) ...[unit & 0xff, unit >> 8],
      ];
      final runtime = WslRuntime(
        startProcess: (executable, arguments, {environment}) async =>
            _ProbeProcess(bytes),
      );
      expect(await runtime.listDistros(), ['Ubuntu-任', '日本語']);
    });

    test('never double-decodes plain text that merely starts with a BOM-shaped pair', () async {
      // A distro name beginning with U+00FF U+00FE reached the seam as PLAIN
      // text; the old BOM short-circuit sniffed it as wide and re-decoded it
      // into mojibake (code units [25173, 28277, 30068, 2573]). The seam must
      // pin the plain-text identity: on this seam a genuine wide BOM cannot
      // survive the byte-level decode as these code units.
      final distros = await distrosFrom('\u00ff\u00feUbuntu' + String.fromCharCode(13) + String.fromCharCode(10));
      expect(distros, ['\u00ff\u00feUbuntu']);
    });

    test('still decodes NUL-alternation wide text through the seam', () async {
      final distros = await distrosFrom('U\u0000b\u0000u\u0000n\u0000t\u0000u\u0000'
          + String.fromCharCode(13) + '\u0000' + String.fromCharCode(10) + '\u0000');
      expect(distros, ['Ubuntu']);
    });
  });
}

class _CollectingSink implements Sink<String> {
  final List<String> out;
  _CollectingSink(this.out);
  @override
  void add(String data) => out.add(data);
  @override
  void close() {}
}

class _ProbeProcess implements Process {
  _ProbeProcess(this.bytes);
  final List<int> bytes;
  @override
  Stream<List<int>> get stdout => Stream.fromIterable([
    bytes.sublist(0, 5), bytes.sublist(5),
  ]);
  @override
  Stream<List<int>> get stderr => const Stream.empty();
  @override
  Future<int> get exitCode async => 0;
  @override
  int get pid => 4242;
  @override
  IOSink get stdin => throw UnimplementedError();
  @override
  bool kill([ProcessSignal signal = ProcessSignal.sigterm]) => true;
}
