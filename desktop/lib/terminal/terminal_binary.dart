import 'dart:typed_data';

const terminalLocalVersion = 1;
const terminalLocalHeaderBytes = 12;
const terminalLocalMaxPayloadBytes = 512 * 1024;
// A paste is delivered whole, in one frame — unlike every other kind, which is either a small
// bounded control message (keyframe/sync) or already chunked upstream to stay well under the
// keystroke ceiling (input, ≤8 KiB per frame). Mirrors TERMINAL_LOCAL_PASTE_MAX_PAYLOAD_BYTES in
// the harness CLI's terminalBinary.ts — keep the two in step.
const terminalLocalPasteMaxPayloadBytes = 6 * 1024 * 1024;
// An image paste (a clipboard screenshot, "Copy Image", ...) is delivered whole, same as a text
// paste — but the bytes are already-compressed PNG data, not text, so the ceiling is sized for a
// reasonable screenshot rather than a large source-code paste. Mirrors
// TERMINAL_LOCAL_IMAGE_PASTE_MAX_PAYLOAD_BYTES in the harness CLI's terminalBinary.ts — keep the
// two in step.
const terminalLocalImagePasteMaxPayloadBytes = 8 * 1024 * 1024;
// A dropped (non-image) file, delivered whole so its path can be pasted on the far side — see
// TerminalSession.pasteFile. Ordinary files run larger than a screenshot, hence its own, more
// generous ceiling; this is a modest atomic-frame limit, not a general file-transfer feature — a
// bigger file is rejected client-side rather than chunked. Mirrors
// TERMINAL_LOCAL_PASTE_FILE_MAX_PAYLOAD_BYTES in the harness CLI's terminalBinary.ts — keep the
// two in step.
const terminalLocalPasteFileMaxPayloadBytes = 20 * 1024 * 1024;

enum TerminalBinaryKind {
  input(1),
  output(2),
  keyframe(3),
  sync(4),

  /// A clipboard paste made directly into the terminal, delivered as one atomic unit instead of
  /// going through the chunked keystroke pipeline — see [TerminalSession.pasteText]. Upload
  /// (client→CLI) only; nothing ever sends this back down.
  paste(5),

  /// A clipboard IMAGE paste (raw PNG bytes) — same "atomic, out-of-band" shape as [paste], but
  /// carrying binary image data instead of UTF-8 text, so it cannot share that kind (the CLI's
  /// paste handler requires valid UTF-8). See [TerminalSession.pasteImage]. Upload (client→CLI)
  /// only; nothing ever sends this back down.
  imagePaste(6),

  /// A dropped (non-image) FILE — carries the original filename plus its bytes, so the daemon can
  /// write it to disk on its own machine and paste that path as text (never the OS clipboard, and
  /// never a Ctrl+V replay — unlike [imagePaste], the goal here is only "the pane gets a valid
  /// path"). See [TerminalSession.pasteFile]. Upload (client→CLI) only; nothing ever sends this
  /// back down.
  pasteFile(7);

  final int code;
  const TerminalBinaryKind(this.code);

  static TerminalBinaryKind? fromCode(int code) {
    for (final kind in values) {
      if (kind.code == code) return kind;
    }
    return null;
  }
}

int _maxLocalPayloadBytesFor(TerminalBinaryKind kind) {
  switch (kind) {
    case TerminalBinaryKind.paste:
      return terminalLocalPasteMaxPayloadBytes;
    case TerminalBinaryKind.imagePaste:
      return terminalLocalImagePasteMaxPayloadBytes;
    case TerminalBinaryKind.pasteFile:
      return terminalLocalPasteFileMaxPayloadBytes;
    default:
      return terminalLocalMaxPayloadBytes;
  }
}

class TerminalBinaryFrame {
  final TerminalBinaryKind kind;
  final String streamId;
  final int seq;
  final Uint8List bytes;
  final bool compressed;
  final int? cols;
  final int? rows;

  const TerminalBinaryFrame({
    required this.kind,
    required this.streamId,
    required this.seq,
    required this.bytes,
    required this.compressed,
    this.cols,
    this.rows,
  });
}

final _localMagic = Uint8List.fromList(const [0x48, 0x54, 0x52, 0x4c]);
const _flagZlib = 1;

Uint8List? _uuidBytes(String id) {
  final hex = id.replaceAll('-', '');
  if (!RegExp(r'^[0-9a-fA-F]{32}$').hasMatch(hex)) return null;
  return Uint8List.fromList([
    for (var index = 0; index < 16; index++)
      int.parse(hex.substring(index * 2, index * 2 + 2), radix: 16),
  ]);
}

String _uuidString(Uint8List bytes) {
  final hex = bytes
      .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
      .join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}

Uint8List? encodeTerminalPlain(TerminalBinaryFrame frame) {
  final id = _uuidBytes(frame.streamId);
  if (id == null || frame.seq < 0) return null;
  if ((frame.kind == TerminalBinaryKind.input ||
          frame.kind == TerminalBinaryKind.sync ||
          frame.kind == TerminalBinaryKind.paste ||
          frame.kind == TerminalBinaryKind.imagePaste ||
          frame.kind == TerminalBinaryKind.pasteFile) &&
      frame.compressed) {
    return null;
  }
  if (frame.kind == TerminalBinaryKind.sync && frame.bytes.isNotEmpty) {
    return null;
  }
  final metaBytes = frame.kind == TerminalBinaryKind.keyframe ? 28 : 24;
  final output = Uint8List(metaBytes + frame.bytes.length)..setRange(0, 16, id);
  final view = ByteData.sublistView(output)
    ..setUint64(16, frame.seq, Endian.big);
  if (frame.kind == TerminalBinaryKind.keyframe) {
    final cols = frame.cols;
    final rows = frame.rows;
    if (cols == null ||
        rows == null ||
        cols < 1 ||
        cols > 0xffff ||
        rows < 1 ||
        rows > 0xffff) {
      return null;
    }
    view.setUint16(24, cols, Endian.big);
    view.setUint16(26, rows, Endian.big);
  }
  output.setRange(metaBytes, output.length, frame.bytes);
  return output;
}

TerminalBinaryFrame? decodeTerminalPlain(
  TerminalBinaryKind kind,
  int flags,
  Uint8List plaintext,
) {
  if ((flags & ~_flagZlib) != 0 ||
      ((kind == TerminalBinaryKind.input ||
              kind == TerminalBinaryKind.sync ||
              kind == TerminalBinaryKind.paste ||
              kind == TerminalBinaryKind.imagePaste ||
              kind == TerminalBinaryKind.pasteFile) &&
          flags != 0)) {
    return null;
  }
  final metaBytes = kind == TerminalBinaryKind.keyframe ? 28 : 24;
  if (plaintext.length < metaBytes ||
      (kind == TerminalBinaryKind.sync && plaintext.length != metaBytes)) {
    return null;
  }
  final view = ByteData.sublistView(plaintext);
  return TerminalBinaryFrame(
    kind: kind,
    streamId: _uuidString(Uint8List.sublistView(plaintext, 0, 16)),
    seq: view.getUint64(16, Endian.big),
    bytes: Uint8List.fromList(plaintext.sublist(metaBytes)),
    compressed: (flags & _flagZlib) != 0,
    cols: kind == TerminalBinaryKind.keyframe
        ? view.getUint16(24, Endian.big)
        : null,
    rows: kind == TerminalBinaryKind.keyframe
        ? view.getUint16(26, Endian.big)
        : null,
  );
}

/// Plain terminal framing for the loopback CLI transport. The CLI now terminates E2EE itself for
/// every machine (own or relayed) — see the harness CLI's lib/remoteRelay.ts — so this is the only
/// wire format the app ever needs; there is no separate encrypted variant anymore.
Uint8List? encodeTerminalLocal(TerminalBinaryFrame frame) {
  final payload = encodeTerminalPlain(frame);
  if (payload == null ||
      payload.length > _maxLocalPayloadBytesFor(frame.kind)) {
    return null;
  }
  final header = Uint8List(terminalLocalHeaderBytes)
    ..setRange(0, 4, _localMagic);
  header[4] = terminalLocalVersion;
  header[5] = frame.kind.code;
  header[6] = frame.compressed ? _flagZlib : 0;
  ByteData.sublistView(header).setUint32(8, payload.length, Endian.big);
  return Uint8List.fromList([...header, ...payload]);
}

TerminalBinaryFrame? decodeTerminalLocal(List<int> raw) {
  final bytes = Uint8List.fromList(raw);
  if (bytes.length < terminalLocalHeaderBytes) return null;
  for (var index = 0; index < _localMagic.length; index++) {
    if (bytes[index] != _localMagic[index]) return null;
  }
  final kind = TerminalBinaryKind.fromCode(bytes[5]);
  if (bytes[4] != terminalLocalVersion || kind == null || bytes[7] != 0) {
    return null;
  }
  final length = ByteData.sublistView(bytes).getUint32(8, Endian.big);
  if (length > _maxLocalPayloadBytesFor(kind) ||
      bytes.length != terminalLocalHeaderBytes + length) {
    return null;
  }
  return decodeTerminalPlain(
    kind,
    bytes[6],
    Uint8List.fromList(bytes.sublist(terminalLocalHeaderBytes)),
  );
}

/// Per-chunk size for a chunked image/file upload — comfortably under the 512 KiB per-binary-message
/// ceiling shared by the backend relay and the P2P data channel (with AEAD/framing overhead room to
/// spare). Every chunk but the last is exactly this size; `seq` is the chunk index. Mirrors the
/// harness CLI's `UPLOAD_CHUNK_BYTES` in terminalStreamManager.ts — keep the two in step.
const terminalUploadChunkBytes = 256 * 1024;
