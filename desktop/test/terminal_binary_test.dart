import 'dart:convert';
import 'dart:typed_data';

import 'package:harness/terminal/terminal_binary.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const streamId = '00112233-4455-6677-8899-aabbccddeeff';

  test('accepts only empty uncompressed sync frames', () {
    expect(
      encodeTerminalPlain(
        TerminalBinaryFrame(
          kind: TerminalBinaryKind.sync,
          streamId: streamId,
          seq: 10,
          bytes: Uint8List.fromList(const [1]),
          compressed: false,
        ),
      ),
      isNull,
    );
  });

  test('local HTRL framing matches the Harness CLI golden frame', () {
    final encoded = encodeTerminalLocal(
      TerminalBinaryFrame(
        kind: TerminalBinaryKind.input,
        streamId: streamId,
        seq: 3,
        bytes: Uint8List.fromList(utf8.encode('xin chào\r')),
        compressed: false,
      ),
    )!;
    expect(
      encoded.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join(),
      '4854524c0101000000000022'
      '00112233445566778899aabbccddeeff'
      '0000000000000003'
      '78696e206368c3a06f0d',
    );
    final decoded = decodeTerminalLocal(encoded);
    expect(decoded?.streamId, streamId);
    expect(decoded?.seq, 3);
    expect(utf8.decode(decoded!.bytes), 'xin chào\r');
  });

  test('a paste carries far past the ordinary local frame ceiling', () {
    // Comfortably over the 512 KiB ceiling every other kind still has — this is the exact size
    // class that used to make a real paste fail to even reach the daemon locally.
    final bytes = Uint8List.fromList(
      List<int>.filled(1 * 1024 * 1024, 0x79), // 'y'
    );
    final frame = TerminalBinaryFrame(
      kind: TerminalBinaryKind.paste,
      streamId: streamId,
      seq: 0,
      bytes: bytes,
      compressed: false,
    );
    final encoded = encodeTerminalLocal(frame);
    expect(encoded, isNotNull);
    final decoded = decodeTerminalLocal(encoded!);
    expect(decoded?.kind, TerminalBinaryKind.paste);
    expect(decoded?.bytes, bytes);

    expect(
      encodeTerminalLocal(
        TerminalBinaryFrame(
          kind: TerminalBinaryKind.output,
          streamId: streamId,
          seq: 0,
          bytes: bytes,
          compressed: false,
        ),
      ),
      isNull,
    );
  });

  test('an image paste carries binary (non-UTF-8) bytes at its own ceiling, independent of paste', () {
    final bytes = Uint8List.fromList(
      List<int>.filled(terminalLocalImagePasteMaxPayloadBytes - 1024, 0xab),
    );
    final frame = TerminalBinaryFrame(
      kind: TerminalBinaryKind.imagePaste,
      streamId: streamId,
      seq: 0,
      bytes: bytes,
      compressed: false,
    );
    final encoded = encodeTerminalLocal(frame);
    expect(encoded, isNotNull);
    final decoded = decodeTerminalLocal(encoded!);
    expect(decoded?.kind, TerminalBinaryKind.imagePaste);
    expect(decoded?.bytes, bytes);

    // Its own ceiling, independent of paste's 6 MiB one.
    final tooBig = Uint8List(terminalLocalImagePasteMaxPayloadBytes + 1);
    expect(
      encodeTerminalLocal(
        TerminalBinaryFrame(
          kind: TerminalBinaryKind.imagePaste,
          streamId: streamId,
          seq: 0,
          bytes: tooBig,
          compressed: false,
        ),
      ),
      isNull,
    );
  });

  test('an image paste is never compressed', () {
    expect(
      encodeTerminalPlain(
        TerminalBinaryFrame(
          kind: TerminalBinaryKind.imagePaste,
          streamId: streamId,
          seq: 0,
          bytes: Uint8List.fromList(const [1, 2, 3]),
          compressed: true,
        ),
      ),
      isNull,
    );
  });

  test('a pasteFile chunk (raw bytes, seq is the chunk index) carries at its own ceiling, independent of paste/imagePaste', () {
    final content = Uint8List.fromList(
      List<int>.filled(terminalLocalPasteFileMaxPayloadBytes - 1024, 0xcd),
    );
    final frame = TerminalBinaryFrame(
      kind: TerminalBinaryKind.pasteFile,
      streamId: streamId,
      seq: 3,
      bytes: content,
      compressed: false,
    );
    final encoded = encodeTerminalLocal(frame);
    expect(encoded, isNotNull);
    final decoded = decodeTerminalLocal(encoded!);
    expect(decoded?.kind, TerminalBinaryKind.pasteFile);
    expect(decoded?.seq, 3);
    expect(decoded?.bytes, content);

    final tooBig = Uint8List(terminalLocalPasteFileMaxPayloadBytes + 1);
    expect(
      encodeTerminalLocal(
        TerminalBinaryFrame(
          kind: TerminalBinaryKind.pasteFile,
          streamId: streamId,
          seq: 0,
          bytes: tooBig,
          compressed: false,
        ),
      ),
      isNull,
    );
  });

  test('a pasteFile is never compressed', () {
    expect(
      encodeTerminalPlain(
        TerminalBinaryFrame(
          kind: TerminalBinaryKind.pasteFile,
          streamId: streamId,
          seq: 0,
          bytes: Uint8List.fromList(const [1, 2, 3]),
          compressed: true,
        ),
      ),
      isNull,
    );
  });

  test('local HTRL framing rejects truncation and reserved bytes', () {
    final encoded = encodeTerminalLocal(
      TerminalBinaryFrame(
        kind: TerminalBinaryKind.sync,
        streamId: streamId,
        seq: 4,
        bytes: Uint8List(0),
        compressed: false,
      ),
    )!;
    expect(decodeTerminalLocal(encoded.sublist(0, encoded.length - 1)), isNull);
    final invalid = Uint8List.fromList(encoded)..[7] = 1;
    expect(decodeTerminalLocal(invalid), isNull);
  });
}
