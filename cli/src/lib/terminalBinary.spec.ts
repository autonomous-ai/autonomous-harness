import { describe, expect, it } from 'vitest'
import {
  deriveTerminalBinaryKey,
  openTerminalBinary,
  parseTerminalBinaryEnvelope,
  sealTerminalBinary,
  TerminalBinaryKind,
} from './terminalBinary.js'

const key = Uint8Array.from({ length: 32 }, (_, index) => index)
const streamId = '00112233-4455-6677-8899-aabbccddeeff'

describe('terminal binary protocol v2', () => {
  it('derives the cross-platform terminal key in its own nonce domain', () => {
    expect(Buffer.from(deriveTerminalBinaryKey(key)).toString('hex')).toBe(
      '319355ec420991f1458c3a0fb5e4b38a6475f227ec166cd8754e721ab827a733',
    )
  })

  it('round-trips raw input without JSON or base64', () => {
    const sealed = sealTerminalBinary(key, 7, {
      kind: TerminalBinaryKind.input,
      streamId,
      seq: 3,
      bytes: new TextEncoder().encode('xin chào\r'),
      compressed: false,
    })!
    expect(Buffer.from(sealed.subarray(0, 4)).toString()).toBe('HTRM')
    expect(openTerminalBinary(key, sealed)).toEqual({
      counter: 7,
      frame: {
        kind: TerminalBinaryKind.input,
        streamId,
        seq: 3,
        bytes: new TextEncoder().encode('xin chào\r'),
        compressed: false,
      },
    })
  })

  it('round-trips a compressed keyframe with dimensions', () => {
    const sealed = sealTerminalBinary(key, 9, {
      kind: TerminalBinaryKind.keyframe,
      streamId,
      seq: 12,
      cols: 144,
      rows: 43,
      bytes: Uint8Array.of(0x78, 0x9c, 0x03),
      compressed: true,
    })!
    expect(openTerminalBinary(key, sealed)?.frame).toMatchObject({
      kind: TerminalBinaryKind.keyframe,
      streamId,
      seq: 12,
      cols: 144,
      rows: 43,
      compressed: true,
    })
  })

  it('rejects tamper, truncation and unsupported flags', () => {
    const sealed = sealTerminalBinary(key, 1, {
      kind: TerminalBinaryKind.output,
      streamId,
      seq: 0,
      bytes: Uint8Array.of(1, 2, 3),
      compressed: false,
    })!
    const tampered = sealed.slice(); tampered[tampered.length - 1] ^= 1
    expect(openTerminalBinary(key, tampered)).toBeNull()
    expect(parseTerminalBinaryEnvelope(sealed.subarray(0, sealed.length - 1))).toBeNull()
    const badFlags = sealed.slice(); badFlags[6] = 0x80
    expect(openTerminalBinary(key, badFlags)).toBeNull()
  })
})
