import { Buffer } from 'node:buffer'

export const TERMINAL_BINARY_VERSION = 3
export const TERMINAL_BINARY_HEADER_BYTES = 20
export const TERMINAL_HOP_HEADER_BYTES = 24
export const TERMINAL_BINARY_MAX_BYTES = 512 * 1024

export const enum TerminalBinaryKind {
  input = 1,
  output = 2,
  keyframe = 3,
  sync = 4,
  // Mirrors the CLI's own copy in autonomous-harness/cli/src/lib/terminalBinary.ts — keep the two
  // in step. Without these three, a paste/imagePaste/pasteFile frame silently fails to relay: this
  // file's `parseTerminalClientFrame` rejects any other kind, and hub.ts's `sendTerminalDown` just
  // no-ops on a null `encodeTerminalHop` result, so the frame vanishes with no error anywhere.
  paste = 5,
  imagePaste = 6,
  pasteFile = 7,
}

export const enum TerminalHopDirection {
  down = 1,
  up = 2,
}

/** Kinds a web/relay-client connection may legitimately send UPWARD (client → adapter) — never
 *  `output`/`keyframe`/`sync`, which only ever flow the other way. `webWs.ts`'s per-connection binary
 *  handlers gate on this directly (their own hardcoded check, independent of `parseTerminalClientFrame`
 *  above, which just validates wire shape and accepts every kind); missing `paste`/`imagePaste`/
 *  `pasteFile` here left every such frame rejected as `TERMINAL_BINARY_REJECTED` even after those kinds
 *  were added to the enum and to `parseTerminalClientFrame` — the same silent-drop shape as the
 *  `TERMINAL_DOWN_TYPES`/`TERMINAL_UP_TYPES` gap those two already got fixed for. */
export const TERMINAL_BINARY_CLIENT_UP_KINDS: ReadonlySet<TerminalBinaryKind> = new Set([
  TerminalBinaryKind.input,
  TerminalBinaryKind.paste,
  TerminalBinaryKind.imagePaste,
  TerminalBinaryKind.pasteFile,
])

const CLIENT_MAGIC = Buffer.from('HTRM')
const HOP_MAGIC = Buffer.from('HTRH')

function uuidBytes(id: string): Buffer | null {
  const hex = id.replaceAll('-', '')
  return /^[0-9a-fA-F]{32}$/.test(hex) ? Buffer.from(hex, 'hex') : null
}

function uuidString(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function parseTerminalClientFrame(raw: Uint8Array): { kind: TerminalBinaryKind; bytes: Buffer } | null {
  const bytes = Buffer.from(raw)
  if (bytes.length < TERMINAL_BINARY_HEADER_BYTES + 16 || bytes.length > TERMINAL_BINARY_MAX_BYTES) return null
  if (!bytes.subarray(0, 4).equals(CLIENT_MAGIC) || bytes[4] !== TERMINAL_BINARY_VERSION
    || (bytes[5] !== TerminalBinaryKind.input && bytes[5] !== TerminalBinaryKind.output
      && bytes[5] !== TerminalBinaryKind.keyframe && bytes[5] !== TerminalBinaryKind.sync
      && bytes[5] !== TerminalBinaryKind.paste && bytes[5] !== TerminalBinaryKind.imagePaste
      && bytes[5] !== TerminalBinaryKind.pasteFile)
    || bytes[7] !== 0) return null
  const ciphertextLength = bytes.readUInt32BE(16)
  if (ciphertextLength < 16 || ciphertextLength !== bytes.length - TERMINAL_BINARY_HEADER_BYTES) return null
  return { kind: bytes[5], bytes }
}

export function encodeTerminalHop(direction: TerminalHopDirection, connId: string, clientFrame: Uint8Array): Buffer | null {
  const id = uuidBytes(connId)
  const parsed = parseTerminalClientFrame(clientFrame)
  if (!id || !parsed || (direction !== TerminalHopDirection.down && direction !== TerminalHopDirection.up)) return null
  const out = Buffer.allocUnsafe(TERMINAL_HOP_HEADER_BYTES + parsed.bytes.length)
  HOP_MAGIC.copy(out, 0)
  out[4] = TERMINAL_BINARY_VERSION
  out[5] = direction
  out[6] = 0
  out[7] = 0
  id.copy(out, 8)
  parsed.bytes.copy(out, TERMINAL_HOP_HEADER_BYTES)
  return out
}

export function decodeTerminalHop(raw: Uint8Array): { direction: TerminalHopDirection; connId: string; clientFrame: Buffer; kind: TerminalBinaryKind } | null {
  const bytes = Buffer.from(raw)
  if (bytes.length < TERMINAL_HOP_HEADER_BYTES + TERMINAL_BINARY_HEADER_BYTES + 16
    || !bytes.subarray(0, 4).equals(HOP_MAGIC) || bytes[4] !== TERMINAL_BINARY_VERSION
    || (bytes[5] !== TerminalHopDirection.down && bytes[5] !== TerminalHopDirection.up)
    || bytes[6] !== 0 || bytes[7] !== 0) return null
  const parsed = parseTerminalClientFrame(bytes.subarray(TERMINAL_HOP_HEADER_BYTES))
  if (!parsed) return null
  return {
    direction: bytes[5],
    connId: uuidString(bytes.subarray(8, 24)),
    clientFrame: parsed.bytes,
    kind: parsed.kind,
  }
}
