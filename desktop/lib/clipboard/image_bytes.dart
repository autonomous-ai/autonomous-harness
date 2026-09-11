import 'dart:typed_data';
import 'dart:ui' as ui;

/// Whether `bytes` looks like a real image file, decided by sniffing its own header rather than
/// trusting a dropped file's extension — an extension is a lie a rename or an attacker can tell
/// easily, and this decides which pipeline a drop takes (the clipboard-image one vs. plain-text
/// path pasting), so it should not be spoofable by e.g. a `.png` that isn't one.
bool looksLikeImage(Uint8List bytes) {
  if (isPng(bytes)) return true;
  // JPEG: FF D8 FF
  if (bytes.length >= 3 &&
      bytes[0] == 0xFF &&
      bytes[1] == 0xD8 &&
      bytes[2] == 0xFF) {
    return true;
  }
  // GIF: "GIF8"
  if (bytes.length >= 4 &&
      bytes[0] == 0x47 &&
      bytes[1] == 0x49 &&
      bytes[2] == 0x46 &&
      bytes[3] == 0x38) {
    return true;
  }
  // BMP: "BM"
  if (bytes.length >= 2 && bytes[0] == 0x42 && bytes[1] == 0x4D) return true;
  // WebP: "RIFF"...."WEBP"
  if (bytes.length >= 12 &&
      bytes[0] == 0x52 &&
      bytes[1] == 0x49 &&
      bytes[2] == 0x46 &&
      bytes[3] == 0x46 &&
      bytes[8] == 0x57 &&
      bytes[9] == 0x45 &&
      bytes[10] == 0x42 &&
      bytes[11] == 0x50) {
    return true;
  }
  return false;
}

const _pngSignature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

bool isPng(Uint8List bytes) {
  if (bytes.length < _pngSignature.length) return false;
  for (var i = 0; i < _pngSignature.length; i++) {
    if (bytes[i] != _pngSignature[i]) return false;
  }
  return true;
}

/// Returns `bytes` unchanged if already PNG (the common case — a screenshot file needs no
/// conversion); otherwise decodes it (JPEG/GIF/WebP/BMP — whatever Skia, already linked into every
/// Flutter app, supports) and re-encodes the first frame as PNG, since the wire protocol
/// ([TerminalBinaryKind.imagePaste]) and the daemon's OS-clipboard write both assume PNG bytes.
/// Returns `null` if the bytes can't be decoded as an image at all.
Future<Uint8List?> ensurePngBytes(Uint8List bytes) async {
  if (isPng(bytes)) return bytes;
  ui.Codec codec;
  try {
    codec = await ui.instantiateImageCodec(bytes);
  } catch (_) {
    return null;
  }
  try {
    final frame = await codec.getNextFrame();
    final data = await frame.image.toByteData(format: ui.ImageByteFormat.png);
    return data?.buffer.asUint8List();
  } catch (_) {
    return null;
  } finally {
    codec.dispose();
  }
}
