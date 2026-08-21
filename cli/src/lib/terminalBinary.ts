import { aeadOpen, aeadSeal, utf8 } from './e2ee/core.js'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'

export const TERMINAL_BINARY_VERSION = 3
export const TERMINAL_BINARY_HEADER_BYTES = 20
export const TERMINAL_BINARY_MAX_CIPHERTEXT_BYTES = 512 * 1024
export const TERMINAL_HOP_HEADER_BYTES = 24

export const enum TerminalBinaryKind {
  input = 1,
  output = 2,
  keyframe = 3,
  sync = 4,
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
}

export function terminalBinaryType(kind: TerminalBinaryKind): string {
  if (kind === TerminalBinaryKind.input) return 'terminal_input'
  if (kind === TerminalBinaryKind.output) return 'terminal_output'
  if (kind === TerminalBinaryKind.keyframe) return 'terminal_keyframe'
  return 'terminal_sync'
}

export function encodeTerminalPlain(frame: TerminalBinaryClear): Uint8Array | null {
  const id = uuidBytes(frame.streamId)
  if (!id || !Number.isSafeInteger(frame.seq) || frame.seq < 0) return null
  if ((frame.kind === TerminalBinaryKind.input || frame.kind === TerminalBinaryKind.sync) && frame.compressed) return null
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
    || ((kind === TerminalBinaryKind.input || kind === TerminalBinaryKind.sync) && flags !== 0)) return null
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
  if (counter == null || length < 16 || length > TERMINAL_BINARY_MAX_CIPHERTEXT_BYTES
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
  if (ciphertext.length > TERMINAL_BINARY_MAX_CIPHERTEXT_BYTES) return null
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
