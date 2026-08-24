// The TypeScript half of the framing agreement — see cableFrame.ts.
//
// The vectors in vectors/cable_frame.txt are a COPY. They are generated in the autonomous-code
// repository (apps/esp32-circle/scripts/gen_cable_vectors.py) by an implementation that is neither this
// one nor the firmware's, and the firmware's own host test asserts against the same file. Refresh the
// copy with scripts/sync-cable-vectors.sh; a stale copy makes this suite pass while the real link
// disagrees, which is the failure this whole arrangement exists to prevent.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { CABLE_FRAME_VERSION, CableDecoder, cableCrc16, encodeCableFrame } from './cableFrame.js'

const VECTORS = join(__dirname, 'vectors', 'cable_frame.txt')

function unhex(hex: string): Uint8Array {
  if (hex === '-' || hex === '') return new Uint8Array(0)
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

interface EncodeCase {
  name: string
  type: number
  payload: string
  frame: string
}
interface StreamCase {
  name: string
  input: string
  frames: string
  discarded: number
  corrupt: number
}

function load() {
  const encode: EncodeCase[] = []
  const stream: StreamCase[] = []
  for (const line of readFileSync(VECTORS, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue
    const f = line.split('\t')
    if (f[0] === 'encode') encode.push({ name: f[1], type: Number(f[2]), payload: f[3], frame: f[4] })
    else if (f[0] === 'stream') {
      stream.push({ name: f[1], input: f[2], frames: f[3], discarded: Number(f[4]), corrupt: Number(f[5]) })
    }
  }
  return { encode, stream }
}

const { encode: encodeCases, stream: streamCases } = load()

/** Decode `input`, handing the decoder `chunk` bytes at a time. */
function decode(input: Uint8Array, chunk: number) {
  const d = new CableDecoder()
  const got: Array<{ type: number; payload: string }> = []
  for (let i = 0; i < input.length; i += chunk) {
    d.feed(input.subarray(i, Math.min(i + chunk, input.length)), (frame) => {
      expect(frame.version).toBe(CABLE_FRAME_VERSION)
      got.push({ type: frame.type, payload: hex(frame.payload) })
    })
  }
  return { got, discarded: d.discardedBytes, corrupt: d.corruptFrames }
}

describe('cable framing', () => {
  it('is CRC-16/CCITT-FALSE', () => {
    // If this is wrong every vector below is wrong, and the failures would read as unrelated bugs.
    expect(cableCrc16(new TextEncoder().encode('123456789'))).toBe(0x29b1)
  })

  it('has vectors to check against', () => {
    // A path typo would otherwise show up as a suite that passes by testing nothing at all.
    expect(encodeCases.length).toBeGreaterThan(5)
    expect(streamCases.length).toBeGreaterThan(5)
  })

  describe.each(encodeCases)('encode $name', (c) => {
    it('matches the vector byte for byte', () => {
      expect(hex(encodeCableFrame(c.type, unhex(c.payload)))).toBe(c.frame)
    })
  })

  describe.each(streamCases)('stream $name', (c) => {
    const want =
      c.frames === '-'
        ? []
        : c.frames.split(',').map((part) => {
            const [type, payload] = part.split(':')
            return { type: Number(type), payload: payload ?? '' }
          })

    // Both feeds, for the same reason the firmware's test runs both: the split that matters is a magic
    // pair straddling two reads, and on a real cable it happens whenever the kernel feels like it.
    it('decodes the whole buffer at once', () => {
      const { got, discarded, corrupt } = decode(unhex(c.input), Number.MAX_SAFE_INTEGER)
      expect(got).toEqual(want)
      expect({ discarded, corrupt }).toEqual({ discarded: c.discarded, corrupt: c.corrupt })
    })

    it('decodes a byte at a time', () => {
      const { got, discarded, corrupt } = decode(unhex(c.input), 1)
      expect(got).toEqual(want)
      expect({ discarded, corrupt }).toEqual({ discarded: c.discarded, corrupt: c.corrupt })
    })
  })
})
