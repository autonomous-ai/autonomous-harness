// UTF-16LE (or single-byte) probe-output codec, independent of WSL.

import 'dart:convert';
import 'dart:typed_data';

/// Decodes a byte stream that is either UTF-16LE (what `wsl.exe` writes for its
/// wide console output) or single-byte text, decided per buffer from the bytes
/// themselves.
///
/// Decoding first with a strict UTF-8 codec — the old behavior — CORRUPTED or
/// threw on every wide buffer, and the stream error path swallowed the failure
/// while `wsl.exe` exited 0, so discovery read an empty inventory. Sniffing on
/// the DECODED string cannot recover that: the loss already happened. The bytes
/// are the only reliable evidence, so they are what is inspected here.
///
/// Wide buffers are decoded as UTF-16LE (BOM 0xFF 0xFE stripped when present).
/// Everything else keeps the plain single-byte mapping so non-UTF-8 junk still
/// round-trips byte-for-byte, matching what the old latin1-style handling did.
class Utf16LeProbeEncoding extends Encoding {
  const Utf16LeProbeEncoding();

  @override
  Converter<List<int>, String> get decoder => const Utf16LeProbeDecoder();

  @override
  Converter<String, List<int>> get encoder => throw UnsupportedError(
      'Utf16LeProbeEncoding is read-only: it decodes process output only');

  @override
  String get name => 'utf-16le-probe';
}

class Utf16LeProbeDecoder extends Converter<List<int>, String> {
  const Utf16LeProbeDecoder();

  /// Wide when NUL high bytes alternate through most of the buffer: UTF-16LE
  /// ASCII text is `[byte, 0]` pairs. Requiring the pattern through most of
  /// the buffer keeps a binary blob that merely contains short ASCII runs
  /// from flipping into a wide decode.
  ///
  /// A BOM (0xFF 0xFE = U+FEFF little-endian) is DECISIVE on its own and
  /// short-circuits the census: `wsl.exe` emits it on wide console output and
  /// a single-byte inventory does not begin with one.
  ///
  /// The NUL census alone rejects a non-Latin-dominant inventory — for a CJK
  /// name like `日本語` followed by CRLF, only 2 of 5 high bytes are NUL,
  /// because a CJK code point puts a PRINTABLE byte in the low position
  /// (本 U+672C encodes as `2c 67`). The complementary signal (review
  /// cycle-4, P2) is the LINE STRUCTURE: wsl.exe output is CRLF-terminated
  /// lines, and UTF-16LE renders one line break as the code-unit run
  /// `0d 00 0a 00` — four bytes single-byte line text cannot contain at a
  /// code-unit-aligned (even) offset. An even-ASCII/odd-non-ASCII alternation
  /// census was tried for this first and is WRONG for real CJK: the low byte
  /// of most CJK code points is printable ASCII-range, so the odd side carries
  /// printable bytes and the shape matches ordinary single-byte text.
  /// The NUL census stays for Latin-dominant buffers, where the odd
  /// bytes are mostly NUL and the strict alternation is what binary blobs
  /// with embedded ASCII runs would break.
  /// [bomIsDecisive] is false on the latin1-string seam, where the byte-level
  /// decode has already run and a surviving 0xFF 0xFE pair is PLAIN text, not
  /// a wide BOM (review cycle-5, P2).
  static bool looksUtf16Le(List<int> bytes, {bool bomIsDecisive = true}) {
    final len = bytes.length;
    if (bomIsDecisive && len >= 4 && bytes[0] == 0xff && bytes[1] == 0xfe) {
      return true;
    }
    if (len < 6) return false;
    var oddNulls = 0;
    var oddTotal = 0;
    for (var i = 1; i < len; i += 2) {
      oddTotal++;
      if (bytes[i] == 0) oddNulls++;
    }
    if (oddTotal > 0 && oddNulls >= 2 && oddNulls * 2 >= oddTotal) return true;
    // BOM-less non-Latin-dominant wide: the UTF-16LE CRLF run at an even
    // (code-unit-aligned) offset.
    for (var i = 0; i + 3 < len; i += 2) {
      if (bytes[i] == 0x0d
          && bytes[i + 1] == 0x00
          && bytes[i + 2] == 0x0a
          && bytes[i + 3] == 0x00) {
        return true;
      }
    }
    return false;
  }

  /// Re-pack UTF-16LE bytes into text, stripping a leading BOM when present.
  static String decodeUtf16LeBytes(List<int> bytes) {
    var offset = 0;
    if (bytes.length >= 2 && bytes[0] == 0xff && bytes[1] == 0xfe) {
      offset = 2;
    }
    final buffer = StringBuffer();
    for (var i = offset; i + 1 < bytes.length; i += 2) {
      buffer.writeCharCode(bytes[i] | (bytes[i + 1] << 8));
    }
    return buffer.toString();
  }

  @override
  String convert(List<int> input, [int start = 0, int? end]) {
    final bytes = input.sublist(start, end ?? input.length);
    if (looksUtf16Le(bytes)) {
      return decodeUtf16LeBytes(bytes);
    }
    // Single-byte path: one code unit per byte, no loss, no throw.
    return String.fromCharCodes(bytes);
  }

  /// Whole-buffer semantics: the wide-vs-single-byte decision needs the FULL
  /// byte sequence, so chunked conversion accumulates and emits only at
  /// close. Probe output is bounded (distro lists, version banners), so
  /// holding one probe's bytes is fine.
  @override
  ChunkedConversionSink<List<int>> startChunkedConversion(
    Sink<String> sink,
  ) {
    final bytes = BytesBuilder();
    return ChunkedConversionSink<List<int>>.withCallback((chunks) {
      // The withCallback sink fires ONCE, at close, carrying every added
      // chunk — see _SimpleCallbackSink in dart:convert.
      for (final chunk in chunks) {
        bytes.add(chunk);
      }
      sink.add(convert(bytes.takeBytes()));
      sink.close();
    });
  }
}
