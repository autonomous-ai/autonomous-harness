import { aeadOpen, aeadSeal, utf8 } from './e2ee/core.js'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'

export const TERMINAL_BINARY_VERSION = 3
export const TERMINAL_BINARY_HEADER_BYTES = 20
export const TERMINAL_BINARY_MAX_CIPHERTEXT_BYTES = 512 * 1024
export const TERMINAL_HOP_HEADER_BYTES = 24
export const TERMINAL_LOCAL_VERSION = 1
export const TERMINAL_LOCAL_HEADER_BYTES = 12
export const TERMINAL_LOCAL_MAX_PAYLOAD_BYTES = 512 * 1024
// A paste is delivered whole, in one frame — unlike every other kind, which is either a small
// bounded control message (keyframe/sync) or already chunked upstream to stay well under the
// keystroke ceiling (input, ≤8 KiB per frame client-side). Reusing that ceiling for paste made an
// entirely ordinary large clipboard paste (a few hundred KB of real code) bounce off a limit sized
// for a keystroke. This is a sanity ceiling against a broken/malicious client, not a real limit —
// see PASTE_MAX_BYTES's own history in terminalStreamManager.ts.
export const TERMINAL_BINARY_PASTE_MAX_CIPHERTEXT_BYTES = 6 * 1024 * 1024
export const TERMINAL_LOCAL_PASTE_MAX_PAYLOAD_BYTES = 6 * 1024 * 1024
// An image paste (a clipboard screenshot, "Copy Image", ...) is delivered whole, same shape as a
// text paste, but the bytes are already-compressed PNG data rather than text — see
// `terminalStreamManager.ts`'s `pasteImage()`. Mirrors terminal_binary.dart's
// terminalLocalImagePasteMaxPayloadBytes — keep the two in step.
export const TERMINAL_BINARY_IMAGE_PASTE_MAX_CIPHERTEXT_BYTES = 4 * 1024 * 1024
export const TERMINAL_LOCAL_IMAGE_PASTE_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024
// A dropped (non-image) file, delivered whole so its path can be pasted on the far side — see
// terminalStreamManager.ts's pasteFile(). Ordinary files run larger than a screenshot, hence its
// own, more generous ceiling; this is a modest atomic-frame limit, not a general file-transfer
// feature. Mirrors terminal_binary.dart's terminalLocalPasteFileMaxPayloadBytes — keep in step.
export const TERMINAL_BINARY_PASTE_FILE_MAX_CIPHERTEXT_BYTES = 10 * 1024 * 1024
export const TERMINAL_LOCAL_PASTE_FILE_MAX_PAYLOAD_BYTES = 10 * 1024 * 1024

export const enum TerminalBinaryKind {
  input = 1,
  output = 2,
  keyframe = 3,
  sync = 4,
  /** A clipboard paste made directly into the terminal, delivered as one atomic unit — see
   *  `pasteRawIntoTmux` in tmux.ts for why this needs its own kind instead of riding `input`. Upload
   *  (client→CLI) only; nothing ever sends this back down. */
  paste = 5,
  /** A clipboard IMAGE paste (raw PNG bytes) — same "atomic, out-of-band" shape as `paste`, but
   *  binary rather than UTF-8 text, so it can't share that kind (`paste()` requires valid UTF-8).
   *  See `terminalStreamManager.ts`'s `pasteImage()`. Upload (client→CLI) only; nothing ever sends
   *  this back down. */
  imagePaste = 6,
  /** A dropped (non-image) FILE — carries the original filename plus its bytes (see
   *  `pasteFile()`'s payload layout), so the daemon can write it to disk on its own machine and
   *  paste that path as text. Never touches the OS clipboard and never replays a keystroke, unlike
   *  `imagePaste` — the goal here is only "the pane gets a valid path". Upload (client→CLI) only;
   *  nothing ever sends this back down. */
  pasteFile = 7,
}

export interface TerminalBinaryClear {
  kind: TerminalBinaryKind
  streamId: string
  seq: number
  bytes: Uint8Array
  compressed: boolean
  cols?: number
  rows?: number
}

export interface TerminalBinaryEnvelope {
  kind: TerminalBinaryKind
  flags: number
  counter: number
  ciphertext: Uint8Array
  aad: Uint8Array
}

const MAGIC = Uint8Array.of(0x48, 0x54, 0x52, 0x4d) // HTRM
const HOP_MAGIC = Uint8Array.of(0x48, 0x54, 0x52, 0x48) // HTRH
const LOCAL_MAGIC = Uint8Array.of(0x48, 0x54, 0x52, 0x4c) // HTRL
const FLAG_ZLIB = 1
const TERMINAL_KEY_INFO = utf8('harness-terminal-binary-v3')

/** Keep binary terminal nonces independent from JSON control-frame nonces. */
export function deriveTerminalBinaryKey(sessionKey: Uint8Array): Uint8Array {
  return hkdf(sha256, sessionKey, new Uint8Array(), TERMINAL_KEY_INFO, 32)
}

function safeU64(view: DataView, offset: number): number | null {
  const value = view.getBigUint64(offset, false)
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null
}

function uuidBytes(id: string): Uint8Array | null {
  const hex = id.replaceAll('-', '')
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return null
  return Uint8Array.from({ length: 16 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16))
}

function uuidString(bytes: Uint8Array): string {
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function validKind(value: number): value is TerminalBinaryKind {
  return value === TerminalBinaryKind.input
    || value === TerminalBinaryKind.output
    || value === TerminalBinaryKind.keyframe
    || value === TerminalBinaryKind.sync
    || value === TerminalBinaryKind.paste
    || value === TerminalBinaryKind.imagePaste
    || value === TerminalBinaryKind.pasteFile
}

export function terminalBinaryType(kind: TerminalBinaryKind): string {
  if (kind === TerminalBinaryKind.input) return 'terminal_input'
  if (kind === TerminalBinaryKind.output) return 'terminal_output'
  if (kind === TerminalBinaryKind.keyframe) return 'terminal_keyframe'
  if (kind === TerminalBinaryKind.paste) return 'terminal_paste'
  if (kind === TerminalBinaryKind.imagePaste) return 'terminal_paste_image'
  if (kind === TerminalBinaryKind.pasteFile) return 'terminal_paste_file'
  return 'terminal_sync'
}

/** The seal/parse/encode/decode size ceiling for [kind] — paste, imagePaste and pasteFile each get
 *  a much larger one; see TERMINAL_BINARY_PASTE_MAX_CIPHERTEXT_BYTES /
 *  TERMINAL_BINARY_IMAGE_PASTE_MAX_CIPHERTEXT_BYTES / TERMINAL_BINARY_PASTE_FILE_MAX_CIPHERTEXT_BYTES. */
function maxCiphertextBytesFor(kind: TerminalBinaryKind): number {
  if (kind === TerminalBinaryKind.paste) return TERMINAL_BINARY_PASTE_MAX_CIPHERTEXT_BYTES
  if (kind === TerminalBinaryKind.imagePaste) return TERMINAL_BINARY_IMAGE_PASTE_MAX_CIPHERTEXT_BYTES
  if (kind === TerminalBinaryKind.pasteFile) return TERMINAL_BINARY_PASTE_FILE_MAX_CIPHERTEXT_BYTES
  return TERMINAL_BINARY_MAX_CIPHERTEXT_BYTES
}

function maxLocalPayloadBytesFor(kind: TerminalBinaryKind): number {
  if (kind === TerminalBinaryKind.paste) return TERMINAL_LOCAL_PASTE_MAX_PAYLOAD_BYTES
  if (kind === TerminalBinaryKind.imagePaste) return TERMINAL_LOCAL_IMAGE_PASTE_MAX_PAYLOAD_BYTES
  if (kind === TerminalBinaryKind.pasteFile) return TERMINAL_LOCAL_PASTE_FILE_MAX_PAYLOAD_BYTES
  return TERMINAL_LOCAL_MAX_PAYLOAD_BYTES
}

export function encodeTerminalPlain(frame: TerminalBinaryClear): Uint8Array | null {
  const id = uuidBytes(frame.streamId)
  if (!id || !Number.isSafeInteger(frame.seq) || frame.seq < 0) return null
  // Compression is for the SERVER's own output/keyframe frames, which the client already knows how
  // to inflate. Nothing on this side inflates an incoming frame, so a client-compressed kind (input,
  // sync, and — for now — paste too) would silently hand tmux a compressed blob instead of text.
  if ((frame.kind === TerminalBinaryKind.input || frame.kind === TerminalBinaryKind.sync
    || frame.kind === TerminalBinaryKind.paste || frame.kind === TerminalBinaryKind.imagePaste
    || frame.kind === TerminalBinaryKind.pasteFile)
    && frame.compressed) return null
  if (frame.kind === TerminalBinaryKind.sync && frame.bytes.length !== 0) return null
  const metaBytes = frame.kind === TerminalBinaryKind.keyframe ? 28 : 24
  const out = new Uint8Array(metaBytes + frame.bytes.length)
  out.set(id, 0)
  const view = new DataView(out.buffer)
  view.setBigUint64(16, BigInt(frame.seq), false)
  if (frame.kind === TerminalBinaryKind.keyframe) {
    if (!Number.isSafeInteger(frame.cols) || !Number.isSafeInteger(frame.rows)
      || frame.cols! < 1 || frame.cols! > 0xffff || frame.rows! < 1 || frame.rows! > 0xffff) return null
    view.setUint16(24, frame.cols!, false)
    view.setUint16(26, frame.rows!, false)
  }
  out.set(frame.bytes, metaBytes)
  return out
}

export function decodeTerminalPlain(kind: TerminalBinaryKind, flags: number, plaintext: Uint8Array): TerminalBinaryClear | null {
  if ((flags & ~FLAG_ZLIB) !== 0
    || ((kind === TerminalBinaryKind.input || kind === TerminalBinaryKind.sync
      || kind === TerminalBinaryKind.paste || kind === TerminalBinaryKind.imagePaste
      || kind === TerminalBinaryKind.pasteFile) && flags !== 0)) return null
  const metaBytes = kind === TerminalBinaryKind.keyframe ? 28 : 24
  if (plaintext.length < metaBytes || (kind === TerminalBinaryKind.sync && plaintext.length !== metaBytes)) return null
  const view = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength)
  const seq = safeU64(view, 16)
  if (seq == null) return null
  return {
    kind,
    streamId: uuidString(plaintext.subarray(0, 16)),
    seq,
    bytes: plaintext.slice(metaBytes),
    compressed: (flags & FLAG_ZLIB) !== 0,
    ...(kind === TerminalBinaryKind.keyframe ? { cols: view.getUint16(24, false), rows: view.getUint16(26, false) } : {}),
  }
}

export function parseTerminalBinaryEnvelope(raw: Uint8Array): TerminalBinaryEnvelope | null {
  const bytes = Uint8Array.from(raw)
  if (bytes.length < TERMINAL_BINARY_HEADER_BYTES + 16) return null
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return null
  if (bytes[4] !== TERMINAL_BINARY_VERSION || !validKind(bytes[5]) || bytes[7] !== 0) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const counter = safeU64(view, 8)
  const length = view.getUint32(16, false)
  if (counter == null || length < 16 || length > maxCiphertextBytesFor(bytes[5])
    || bytes.length !== TERMINAL_BINARY_HEADER_BYTES + length) return null
  return {
    kind: bytes[5],
    flags: bytes[6],
    counter,
    ciphertext: bytes.slice(TERMINAL_BINARY_HEADER_BYTES),
    aad: bytes.slice(0, 16),
  }
}

export function sealTerminalBinary(key: Uint8Array, counter: number, frame: TerminalBinaryClear): Uint8Array | null {
  if (!Number.isSafeInteger(counter) || counter < 0) return null
  const plaintext = encodeTerminalPlain(frame)
  if (!plaintext) return null
  const flags = frame.compressed ? FLAG_ZLIB : 0
  const header = new Uint8Array(TERMINAL_BINARY_HEADER_BYTES)
  header.set(MAGIC, 0)
  header[4] = TERMINAL_BINARY_VERSION
  header[5] = frame.kind
  header[6] = flags
  const view = new DataView(header.buffer)
  view.setBigUint64(8, BigInt(counter), false)
  const ciphertext = aeadSeal(key, counter, header.subarray(0, 16), plaintext)
  if (ciphertext.length > maxCiphertextBytesFor(frame.kind)) return null
  view.setUint32(16, ciphertext.length, false)
  const out = new Uint8Array(header.length + ciphertext.length)
  out.set(header)
  out.set(ciphertext, header.length)
  return out
}

export function openTerminalBinary(key: Uint8Array, raw: Uint8Array): { counter: number; frame: TerminalBinaryClear } | null {
  const envelope = parseTerminalBinaryEnvelope(raw)
  if (!envelope) return null
  const plaintext = aeadOpen(key, envelope.counter, envelope.aad, envelope.ciphertext)
  if (!plaintext) return null
  const frame = decodeTerminalPlain(envelope.kind, envelope.flags, plaintext)
  return frame ? { counter: envelope.counter, frame } : null
}

/** Plain terminal framing for the authenticated loopback desktop transport. */
export function encodeTerminalLocal(frame: TerminalBinaryClear): Uint8Array | null {
  const payload = encodeTerminalPlain(frame)
  if (!payload || payload.length > maxLocalPayloadBytesFor(frame.kind)) return null
  const flags = frame.compressed ? FLAG_ZLIB : 0
  const header = new Uint8Array(TERMINAL_LOCAL_HEADER_BYTES)
  header.set(LOCAL_MAGIC, 0)
  header[4] = TERMINAL_LOCAL_VERSION
  header[5] = frame.kind
  header[6] = flags
  const view = new DataView(header.buffer)
  view.setUint32(8, payload.length, false)
  const out = new Uint8Array(header.length + payload.length)
  out.set(header)
  out.set(payload, header.length)
  return out
}

/** Decode a terminal frame only after the WebSocket peer passed loopback API-key authentication. */
export function decodeTerminalLocal(raw: Uint8Array): TerminalBinaryClear | null {
  const bytes = Uint8Array.from(raw)
  if (bytes.length < TERMINAL_LOCAL_HEADER_BYTES) return null
  for (let index = 0; index < LOCAL_MAGIC.length; index++) if (bytes[index] !== LOCAL_MAGIC[index]) return null
  const kind = bytes[5]
  const flags = bytes[6]
  if (bytes[4] !== TERMINAL_LOCAL_VERSION || !validKind(kind) || bytes[7] !== 0) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const length = view.getUint32(8, false)
  if (length > maxLocalPayloadBytesFor(kind) || bytes.length !== TERMINAL_LOCAL_HEADER_BYTES + length) return null
  return decodeTerminalPlain(kind, flags, bytes.slice(TERMINAL_LOCAL_HEADER_BYTES))
}

/** `pasteFile`'s payload (the frame's opaque `bytes`) is itself a tiny sub-format: a 2-byte
 *  big-endian filename length, the UTF-8 filename, then the file's own content — one small header
 *  inside the existing opaque `bytes` field, so the outer frame format needs no changes for this. */
export function encodePasteFilePayload(filename: string, content: Uint8Array): Uint8Array | null {
  const nameBytes = utf8(filename)
  if (nameBytes.length === 0 || nameBytes.length > 0xffff) return null
  const out = new Uint8Array(2 + nameBytes.length + content.length)
  const view = new DataView(out.buffer)
  view.setUint16(0, nameBytes.length, false)
  out.set(nameBytes, 2)
  out.set(content, 2 + nameBytes.length)
  return out
}

export function decodePasteFilePayload(payload: Uint8Array): { filename: string; content: Uint8Array } | null {
  if (payload.length < 2) return null
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const nameLength = view.getUint16(0, false)
  if (nameLength === 0 || payload.length < 2 + nameLength) return null
  let filename: string
  try {
    filename = new TextDecoder('utf-8', { fatal: true }).decode(payload.subarray(2, 2 + nameLength))
  } catch {
    return null
  }
  return { filename, content: payload.subarray(2 + nameLength) }
}

export const enum TerminalHopDirection {
  down = 1,
  up = 2,
}

export function encodeTerminalHop(direction: TerminalHopDirection, connId: string, clientFrame: Uint8Array): Uint8Array | null {
  const id = uuidBytes(connId)
  if (!id || (direction !== TerminalHopDirection.down && direction !== TerminalHopDirection.up)) return null
  const out = new Uint8Array(TERMINAL_HOP_HEADER_BYTES + clientFrame.length)
  out.set(HOP_MAGIC, 0)
  out[4] = TERMINAL_BINARY_VERSION
  out[5] = direction
  out.set(id, 8)
  out.set(clientFrame, TERMINAL_HOP_HEADER_BYTES)
  return out
}

export function decodeTerminalHop(raw: Uint8Array): { direction: TerminalHopDirection; connId: string; clientFrame: Uint8Array } | null {
  const bytes = Uint8Array.from(raw)
  if (bytes.length < TERMINAL_HOP_HEADER_BYTES + TERMINAL_BINARY_HEADER_BYTES + 16) return null
  for (let index = 0; index < HOP_MAGIC.length; index++) if (bytes[index] !== HOP_MAGIC[index]) return null
  if (bytes[4] !== TERMINAL_BINARY_VERSION || bytes[6] !== 0 || bytes[7] !== 0
    || (bytes[5] !== TerminalHopDirection.down && bytes[5] !== TerminalHopDirection.up)) return null
  const clientFrame = bytes.slice(TERMINAL_HOP_HEADER_BYTES)
  if (!parseTerminalBinaryEnvelope(clientFrame)) return null
  return {
    direction: bytes[5],
    connId: uuidString(bytes.subarray(8, 24)),
    clientFrame,
  }
}

/** Stable bytes used by cross-language golden tests and protocol diagnostics. */
export function terminalBinaryAadLabel(kind: TerminalBinaryKind): Uint8Array {
  return utf8(`HTRM|${TERMINAL_BINARY_VERSION}|${terminalBinaryType(kind)}`)
}
