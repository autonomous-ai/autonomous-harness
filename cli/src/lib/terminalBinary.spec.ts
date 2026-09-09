import { describe, expect, it } from 'vitest'
import {
  deriveTerminalBinaryKey,
  decodeTerminalLocal,
  encodeTerminalLocal,
  openTerminalBinary,
  parseTerminalBinaryEnvelope,
  sealTerminalBinary,
  TerminalBinaryKind,
  TERMINAL_BINARY_MAX_CIPHERTEXT_BYTES,
  TERMINAL_BINARY_PASTE_MAX_CIPHERTEXT_BYTES,
} from './terminalBinary.js'

const key = Uint8Array.from({ length: 32 }, (_, index) => index)
const streamId = '00112233-4455-6677-8899-aabbccddeeff'

describe('terminal binary protocol v3', () => {
  it('derives the cross-platform terminal key in its own nonce domain', () => {
    expect(Buffer.from(deriveTerminalBinaryKey(key)).toString('hex')).toBe(
      'f15a4e3a9c616916c38980baf864db0c65e282ebe7cd64a18aa0f723a6e254f5',
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

  it('round-trips an empty uncompressed sync frame', () => {
    const sealed = sealTerminalBinary(key, 10, {
      kind: TerminalBinaryKind.sync,
      streamId,
      seq: 13,
      bytes: new Uint8Array(),
      compressed: false,
    })!
    expect(openTerminalBinary(key, sealed)?.frame).toEqual({
      kind: TerminalBinaryKind.sync,
      streamId,
      seq: 13,
      bytes: new Uint8Array(),
      compressed: false,
    })
    expect(sealTerminalBinary(key, 11, {
      kind: TerminalBinaryKind.sync,
      streamId,
      seq: 14,
      bytes: Uint8Array.of(1),
      compressed: false,
    })).toBeNull()
  })

  it('round-trips an uncompressed paste at a ceiling far above ordinary input', () => {
    const bytes = new TextEncoder().encode('x'.repeat(200 * 1024))
    const sealed = sealTerminalBinary(key, 8, {
      kind: TerminalBinaryKind.paste,
      streamId,
      seq: 0,
      bytes,
      compressed: false,
    })!
    expect(sealed).not.toBeNull()
    expect(openTerminalBinary(key, sealed)?.frame).toEqual({
      kind: TerminalBinaryKind.paste,
      streamId,
      seq: 0,
      bytes,
      compressed: false,
    })

    // A frame this size is exactly what the old shared ceiling used to reject for every kind —
    // paste needs it, input/output/keyframe/sync do not, so it must stay kind-specific.
    const big = new Uint8Array(TERMINAL_BINARY_MAX_CIPHERTEXT_BYTES + 1)
    expect(sealTerminalBinary(key, 9, { kind: TerminalBinaryKind.paste, streamId, seq: 0, bytes: big, compressed: false })).not.toBeNull()
    expect(sealTerminalBinary(key, 9, { kind: TerminalBinaryKind.output, streamId, seq: 0, bytes: big, compressed: false })).toBeNull()

    // Paste's own ceiling still holds against something absurd.
    const tooBig = new Uint8Array(TERMINAL_BINARY_PASTE_MAX_CIPHERTEXT_BYTES + 1)
    expect(sealTerminalBinary(key, 9, { kind: TerminalBinaryKind.paste, streamId, seq: 0, bytes: tooBig, compressed: false })).toBeNull()
  })

  it('rejects a compressed paste — nothing on the receiving end inflates it yet', () => {
    expect(sealTerminalBinary(key, 10, {
      kind: TerminalBinaryKind.paste,
      streamId,
      seq: 0,
      bytes: Uint8Array.of(1, 2, 3),
      compressed: true,
    })).toBeNull()
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

describe('authenticated loopback terminal framing v1', () => {
  it('matches the cross-language HTRL golden frame', () => {
    const encoded = encodeTerminalLocal({
      kind: TerminalBinaryKind.input,
      streamId,
      seq: 3,
      bytes: new TextEncoder().encode('xin chào\r'),
      compressed: false,
    })!
    expect(Buffer.from(encoded).toString('hex')).toBe(
      '4854524c0101000000000022' +
      '00112233445566778899aabbccddeeff' +
      '0000000000000003' +
      '78696e206368c3a06f0d',
    )
    expect(decodeTerminalLocal(encoded)).toEqual({
      kind: TerminalBinaryKind.input,
      streamId,
      seq: 3,
      bytes: new TextEncoder().encode('xin chào\r'),
      compressed: false,
    })
  })

  it('rejects malformed local frames', () => {
    const encoded = encodeTerminalLocal({
      kind: TerminalBinaryKind.sync,
      streamId,
      seq: 4,
      bytes: new Uint8Array(),
      compressed: false,
    })!
    expect(decodeTerminalLocal(encoded.subarray(0, encoded.length - 1))).toBeNull()
    const badReserved = encoded.slice(); badReserved[7] = 1
    expect(decodeTerminalLocal(badReserved)).toBeNull()
    const badMagic = encoded.slice(); badMagic[0] = 0
    expect(decodeTerminalLocal(badMagic)).toBeNull()
  })

  it('carries a paste well past the ordinary local frame ceiling', () => {
    // Comfortably over the 512 KiB ceiling every other kind still has — this is the exact size class
    // that used to make a real paste fail to even reach the daemon over the local loopback socket.
    const bytes = new TextEncoder().encode('y'.repeat(1 * 1024 * 1024))
    const encoded = encodeTerminalLocal({
      kind: TerminalBinaryKind.paste,
      streamId,
      seq: 0,
      bytes,
      compressed: false,
    })
    expect(encoded).not.toBeNull()
    expect(decodeTerminalLocal(encoded!)).toEqual({
      kind: TerminalBinaryKind.paste,
      streamId,
      seq: 0,
      bytes,
      compressed: false,
    })

    expect(encodeTerminalLocal({
      kind: TerminalBinaryKind.output,
      streamId,
      seq: 0,
      bytes,
      compressed: false,
    })).toBeNull()
  })
})
