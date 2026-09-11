import { describe, expect, it } from 'vitest'
import {
  deriveTerminalBinaryKey,
  decodeTerminalLocal,
  encodeTerminalLocal,
  openTerminalBinary,
  parseTerminalBinaryEnvelope,
  sealTerminalBinary,
  TerminalBinaryKind,
  TERMINAL_BINARY_IMAGE_PASTE_MAX_CIPHERTEXT_BYTES,
  TERMINAL_BINARY_MAX_CIPHERTEXT_BYTES,
  TERMINAL_BINARY_PASTE_FILE_MAX_CIPHERTEXT_BYTES,
  TERMINAL_BINARY_PASTE_MAX_CIPHERTEXT_BYTES,
  TERMINAL_LOCAL_IMAGE_PASTE_MAX_PAYLOAD_BYTES,
  TERMINAL_LOCAL_PASTE_FILE_MAX_PAYLOAD_BYTES,
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

  it('round-trips a binary image paste (not valid UTF-8) at its own ceiling', () => {
    // A PNG magic number plus garbage — the point is that this is NOT valid UTF-8, unlike `paste`,
    // and must still round-trip untouched.
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00])
    const sealed = sealTerminalBinary(key, 20, {
      kind: TerminalBinaryKind.imagePaste,
      streamId,
      seq: 0,
      bytes,
      compressed: false,
    })!
    expect(sealed).not.toBeNull()
    expect(openTerminalBinary(key, sealed)?.frame).toEqual({
      kind: TerminalBinaryKind.imagePaste,
      streamId,
      seq: 0,
      bytes,
      compressed: false,
    })

    // Its own ceiling, independent of paste's.
    const tooBig = new Uint8Array(TERMINAL_BINARY_IMAGE_PASTE_MAX_CIPHERTEXT_BYTES + 1)
    expect(sealTerminalBinary(key, 21, { kind: TerminalBinaryKind.imagePaste, streamId, seq: 0, bytes: tooBig, compressed: false })).toBeNull()
  })

  it('rejects a compressed image paste, same reason as paste', () => {
    expect(sealTerminalBinary(key, 22, {
      kind: TerminalBinaryKind.imagePaste,
      streamId,
      seq: 0,
      bytes: Uint8Array.of(1, 2, 3),
      compressed: true,
    })).toBeNull()
  })

  it('round-trips a pasteFile chunk (raw bytes, seq is the chunk index) at its own ceiling', () => {
    const chunk = Uint8Array.of(0x25, 0x50, 0x44, 0x46)

    const sealed = sealTerminalBinary(key, 30, {
      kind: TerminalBinaryKind.pasteFile,
      streamId,
      seq: 3,
      bytes: chunk,
      compressed: false,
    })!
    expect(sealed).not.toBeNull()
    expect(openTerminalBinary(key, sealed)?.frame).toEqual({
      kind: TerminalBinaryKind.pasteFile,
      streamId,
      seq: 3,
      bytes: chunk,
      compressed: false,
    })

    // Its own ceiling, independent of paste/imagePaste.
    const tooBig = new Uint8Array(TERMINAL_BINARY_PASTE_FILE_MAX_CIPHERTEXT_BYTES + 1)
    expect(sealTerminalBinary(key, 31, { kind: TerminalBinaryKind.pasteFile, streamId, seq: 0, bytes: tooBig, compressed: false })).toBeNull()
  })

  it('rejects a compressed pasteFile, same reason as paste/imagePaste', () => {
    expect(sealTerminalBinary(key, 32, {
      kind: TerminalBinaryKind.pasteFile,
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
    // Metadata via deep-equal, payload via native memcmp: vitest's toEqual walks a typed array one
    // element at a time, and on a multi-MiB payload that alone took ~1-3s on a fast laptop and blew
    // through the 5s test timeout on a CI runner (v0.2.16_cli release run).
    const decoded = decodeTerminalLocal(encoded!)!
    expect(decoded).toMatchObject({ kind: TerminalBinaryKind.paste, streamId, seq: 0, compressed: false })
    expect(Buffer.compare(decoded.bytes, bytes)).toBe(0)

    expect(encodeTerminalLocal({
      kind: TerminalBinaryKind.output,
      streamId,
      seq: 0,
      bytes,
      compressed: false,
    })).toBeNull()
  })

  it('carries an image paste well past the ordinary local frame ceiling, independent of paste', () => {
    // Comfortably over the 512 KiB generic ceiling, well under imagePaste's own 4 MiB one — big
    // enough to prove the kind-specific ceiling applies, small enough that a byte-for-byte
    // deep-equal below stays fast.
    const bytes = new Uint8Array(1.5 * 1024 * 1024).fill(0xab)
    const encoded = encodeTerminalLocal({
      kind: TerminalBinaryKind.imagePaste,
      streamId,
      seq: 0,
      bytes,
      compressed: false,
    })
    expect(encoded).not.toBeNull()
    const decoded = decodeTerminalLocal(encoded!)!
    expect(decoded).toMatchObject({ kind: TerminalBinaryKind.imagePaste, streamId, seq: 0, compressed: false })
    expect(Buffer.compare(decoded.bytes, bytes)).toBe(0) // memcmp, not element-wise — see the paste test above

    const tooBig = new Uint8Array(TERMINAL_LOCAL_IMAGE_PASTE_MAX_PAYLOAD_BYTES + 1)
    expect(encodeTerminalLocal({
      kind: TerminalBinaryKind.imagePaste,
      streamId,
      seq: 0,
      bytes: tooBig,
      compressed: false,
    })).toBeNull()
  })

  it('carries a pasteFile chunk well past the ordinary local frame ceiling, independent of paste/imagePaste', () => {
    // A single chunk is capped at UPLOAD_CHUNK_BYTES (256 KiB) in practice, but the WIRE ceiling
    // itself is still the whole-upload one — this proves the kind-specific ceiling still applies
    // at the framing layer regardless of how the CLI's application logic chunks it.
    const content = new Uint8Array(2 * 1024 * 1024).fill(0xcd)
    const encoded = encodeTerminalLocal({
      kind: TerminalBinaryKind.pasteFile,
      streamId,
      seq: 2,
      bytes: content,
      compressed: false,
    })
    expect(encoded).not.toBeNull()
    const decoded = decodeTerminalLocal(encoded!)!
    expect(decoded).toMatchObject({ kind: TerminalBinaryKind.pasteFile, seq: 2 })
    expect(Buffer.compare(decoded.bytes, content)).toBe(0) // memcmp, not element-wise — see the paste test above

    const tooBig = new Uint8Array(TERMINAL_LOCAL_PASTE_FILE_MAX_PAYLOAD_BYTES + 1)
    expect(encodeTerminalLocal({
      kind: TerminalBinaryKind.pasteFile,
      streamId,
      seq: 0,
      bytes: tooBig,
      compressed: false,
    })).toBeNull()
  })
})
