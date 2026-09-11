import { describe, expect, it } from 'vitest'
import {
  decodeTerminalHop,
  encodeTerminalHop,
  parseTerminalClientFrame,
  TERMINAL_BINARY_CLIENT_UP_KINDS,
  TerminalBinaryKind,
  TerminalHopDirection,
} from './terminalBinary.js'

function opaque(kind: TerminalBinaryKind): Buffer {
  const out = Buffer.alloc(36)
  out.write('HTRM')
  out[4] = 3
  out[5] = kind
  out.writeUInt32BE(16, 16)
  return out
}

describe('opaque terminal binary relay codec', () => {
  it('routes a valid encrypted client frame without changing it', () => {
    const frame = opaque(TerminalBinaryKind.output)
    const packet = encodeTerminalHop(TerminalHopDirection.up, '00112233-4455-6677-8899-aabbccddeeff', frame)!
    expect(decodeTerminalHop(packet)).toMatchObject({
      direction: TerminalHopDirection.up,
      connId: '00112233-4455-6677-8899-aabbccddeeff',
      kind: TerminalBinaryKind.output,
      clientFrame: frame,
    })
  })

  it('routes an encrypted sync frame without changing it', () => {
    const frame = opaque(TerminalBinaryKind.sync)
    const packet = encodeTerminalHop(TerminalHopDirection.up, '00112233-4455-6677-8899-aabbccddeeff', frame)!
    expect(decodeTerminalHop(packet)).toMatchObject({
      direction: TerminalHopDirection.up,
      connId: '00112233-4455-6677-8899-aabbccddeeff',
      kind: TerminalBinaryKind.sync,
      clientFrame: frame,
    })
  })

  it('rejects malformed lengths and unsupported kinds', () => {
    const frame = opaque(TerminalBinaryKind.input)
    frame.writeUInt32BE(15, 16)
    expect(parseTerminalClientFrame(frame)).toBeNull()
    frame.writeUInt32BE(16, 16); frame[5] = 9
    expect(parseTerminalClientFrame(frame)).toBeNull()
  })

  // Regression for a real bug: this file's TerminalBinaryKind used to lag the CLI's copy by three
  // kinds, so a paste/imagePaste/pasteFile frame relayed toward a remote machine parsed as null and
  // hub.ts's sendTerminalDown silently no-op'd on it — no error, nothing ever arrived.
  it('routes paste/imagePaste/pasteFile frames, mirroring the CLI kinds added for remote copy-paste', () => {
    for (const kind of [TerminalBinaryKind.paste, TerminalBinaryKind.imagePaste, TerminalBinaryKind.pasteFile]) {
      const frame = opaque(kind)
      const packet = encodeTerminalHop(TerminalHopDirection.down, '00112233-4455-6677-8899-aabbccddeeff', frame)!
      expect(packet).not.toBeNull()
      expect(decodeTerminalHop(packet)).toMatchObject({
        direction: TerminalHopDirection.down,
        connId: '00112233-4455-6677-8899-aabbccddeeff',
        kind,
        clientFrame: frame,
      })
    }
  })

  // Regression: webWs.ts's own binary handlers gate on this set with a hardcoded check independent
  // of the kind enum/parser above — paste/imagePaste/pasteFile landed in both of those but were never
  // added here, so every such frame from a web/relay client was rejected as TERMINAL_BINARY_REJECTED
  // (freezing the whole pane) even though the wire-level parsing above was already correct.
  it('accepts every client-originated kind a web/relay connection may send up, and no others', () => {
    expect(TERMINAL_BINARY_CLIENT_UP_KINDS.has(TerminalBinaryKind.input)).toBe(true)
    expect(TERMINAL_BINARY_CLIENT_UP_KINDS.has(TerminalBinaryKind.paste)).toBe(true)
    expect(TERMINAL_BINARY_CLIENT_UP_KINDS.has(TerminalBinaryKind.imagePaste)).toBe(true)
    expect(TERMINAL_BINARY_CLIENT_UP_KINDS.has(TerminalBinaryKind.pasteFile)).toBe(true)
    expect(TERMINAL_BINARY_CLIENT_UP_KINDS.has(TerminalBinaryKind.output)).toBe(false)
    expect(TERMINAL_BINARY_CLIENT_UP_KINDS.has(TerminalBinaryKind.keyframe)).toBe(false)
    expect(TERMINAL_BINARY_CLIENT_UP_KINDS.has(TerminalBinaryKind.sync)).toBe(false)
  })
})
