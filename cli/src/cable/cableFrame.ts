// Framing for the USB link to the dial — turns a byte stream into messages, and messages back into bytes.
//
// The mirror image of apps/esp32-circle/main/cable_frame.c in the autonomous-code repository. Both halves
// are checked against ONE shared vector file (vectors/cable_frame.txt here, generated there by
// scripts/gen_cable_vectors.py from the format description rather than from either implementation), so a
// shared misreading shows up as a disagreement instead of being blessed by both. The two halves live in
// two repositories and cannot import each other; the vectors are the only thing they share.
//
// Wire format, little-endian throughout:
//
//   A5 5A | ver:u8 | type:u8 | len:u16 | payload[len] | crc16:u16
//
// The magic is what the reader scans for after losing its place; the CRC is what separates a real frame
// from two bytes of noise that happened to look like the magic. That matters more here than on most
// links, and for a reason specific to this board: it has exactly ONE USB port, so the console and this
// protocol share a wire. The ROM, the second-stage bootloader and the panic handler all write plain text
// to it, and this reader walks into the middle of a stream at every boot.
//
// That is also why `Log` is a frame type: an ESP_LOG line arrives framed and can be filed, and only what
// the firmware cannot route — ROM chatter, a panic dump — comes as bare text, which the decoder steps
// over a byte at a time and counts.

export const CABLE_MAGIC_0 = 0xa5
export const CABLE_MAGIC_1 = 0x5a

/** Bumped only when the ENVELOPE changes. The vocabulary carries its own version in `hello`. */
export const CABLE_FRAME_VERSION = 1

export const CABLE_HEADER_BYTES = 6 // magic(2) + ver(1) + type(1) + len(2)
export const CABLE_CRC_BYTES = 2

/**
 * A bound on damage, not a capacity target. A corrupt length field can claim up to 65535 bytes, and with
 * no ceiling the reader would sit waiting for a frame that is never coming while real frames pile up
 * behind it — a hang, not a dropped message.
 */
export const CABLE_MAX_PAYLOAD = 8192

export const CABLE_MAX_FRAME = CABLE_HEADER_BYTES + CABLE_MAX_PAYLOAD + CABLE_CRC_BYTES

/** Payload kinds. An unknown code is handed up with its raw byte, never dropped. */
export const CableType = {
  Json: 0x01, // UTF-8 JSON object with a "t" discriminator — the vocabulary
  Pcm: 0x02, // one chunk of 16-bit mono PCM, dial → daemon, during a voice turn
  Fw: 0x03, // one slice of a firmware image, daemon → dial only
  Log: 0x04, // one ESP_LOG line, dial → daemon, raw bytes (no JSON escaping)
} as const

/**
 * CRC-16/CCITT-FALSE — poly 0x1021, init 0xFFFF, no reflection, no final xor.
 *
 * Named exactly because several 16-bit CRCs share the 0x1021 polynomial and differ only in init or
 * reflection; the published check value for "123456789" is 0x29B1, which both test suites assert.
 */
export function cableCrc16(data: Uint8Array, from = 0, to = data.length): number {
  let crc = 0xffff
  for (let i = from; i < to; i++) {
    crc ^= data[i] << 8
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }
  return crc
}

/**
 * Frame `payload`. Throws when it is over the cap rather than truncating: an oversized message is a bug
 * on this side, and the far end could only ever report it as noise.
 */
export function encodeCableFrame(type: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (payload.length > CABLE_MAX_PAYLOAD) {
    throw new Error(`cable frame payload ${payload.length} over the ${CABLE_MAX_PAYLOAD} cap`)
  }
  const out = new Uint8Array(CABLE_HEADER_BYTES + payload.length + CABLE_CRC_BYTES)
  out[0] = CABLE_MAGIC_0
  out[1] = CABLE_MAGIC_1
  out[2] = CABLE_FRAME_VERSION
  out[3] = type
  out[4] = payload.length & 0xff
  out[5] = (payload.length >> 8) & 0xff
  out.set(payload, CABLE_HEADER_BYTES)
  // Covers ver..payload. The magic is a marker, not data — including a constant would add nothing to
  // detect.
  const crc = cableCrc16(out, 2, CABLE_HEADER_BYTES + payload.length)
  out[out.length - 2] = crc & 0xff
  out[out.length - 1] = (crc >> 8) & 0xff
  return out
}

export interface CableFrame {
  version: number
  type: number
  payload: Uint8Array
}

/**
 * Reassembles frames from a byte stream that may start anywhere and contain anything.
 *
 * Never throws: everything arriving on this port is untrusted, and the only useful response to a byte
 * that makes no sense is to step over it.
 */
export class CableDecoder {
  private buf = new Uint8Array(CABLE_MAX_FRAME)
  private len = 0

  /**
   * The RATE is what matters, which is why these are counters and not booleans: a handful of discarded
   * bytes at every boot is the bootloader's parting words and is expected, while a steady trickle during
   * a session means the two sides disagree about the format or the cable is bad. Those are very
   * different problems and look identical without a count.
   */
  discardedBytes = 0
  corruptFrames = 0

  /**
   * Forget any partial frame. Call when the port is reopened: leftover bytes belong to a session that has
   * ended, and carrying them across would put a stale half-frame in front of the next real one.
   *
   * The counters deliberately survive — they exist to show a trend across the whole run.
   */
  reset(): void {
    this.len = 0
  }

  /** Feed bytes and emit every frame they complete, in order. */
  feed(data: Uint8Array, onFrame: (frame: CableFrame) => void): void {
    for (let i = 0; i < data.length; i++) {
      // Full and still no frame means the head was never a real one. Making room by dropping the oldest
      // byte keeps the link alive; refusing the new byte instead would wedge it permanently.
      if (this.len === this.buf.length) this.discard(1)

      this.buf[this.len++] = data[i]

      // Only worth attempting once a header could be complete. This also keeps the magic scan amortised:
      // it runs on resync, not per byte.
      if (this.len >= CABLE_HEADER_BYTES) {
        while (this.takeFront(onFrame)) {
          // keep going: one read can complete several frames
        }
      }
    }
  }

  /** Take `count` bytes off the front, keeping the rest. Says nothing about why. */
  private consume(count: number): void {
    if (count <= 0) return
    if (count >= this.len) {
      this.len = 0
      return
    }
    this.buf.copyWithin(0, count, this.len)
    this.len -= count
  }

  /**
   * Consume bytes that turned out not to be a frame, and say so.
   *
   * Split from consume() rather than counting inside it: the bytes of a frame that decoded fine are also
   * consumed, and counting those as discarded would make the health number read as "this link is full of
   * noise" on a link that is working perfectly.
   */
  private discard(count: number): void {
    this.discardedBytes += Math.min(count, this.len)
    this.consume(count)
  }

  /**
   * Offset of the next complete magic, or -1.
   *
   * Stops one short of the end on purpose: a final lone byte cannot be judged yet, and the caller keeps
   * it in case the next read completes the pair.
   */
  private indexOfMagic(): number {
    for (let i = 0; i + 1 < this.len; i++) {
      if (this.buf[i] === CABLE_MAGIC_0 && this.buf[i + 1] === CABLE_MAGIC_1) return i
    }
    return -1
  }

  /**
   * Try to take one frame off the front. True when one was emitted (so try again), false when more bytes
   * are needed. Noise is consumed internally rather than reported, so the caller never has to tell "wait"
   * from "that was rubbish".
   */
  private takeFront(onFrame: (frame: CableFrame) => void): boolean {
    for (;;) {
      const headIsMagic =
        this.len >= 2 && this.buf[0] === CABLE_MAGIC_0 && this.buf[1] === CABLE_MAGIC_1

      if (!headIsMagic) {
        const at = this.indexOfMagic()
        if (at < 0) {
          // Keep a trailing A5: the 5A may simply not have arrived yet.
          const keep = this.len > 0 && this.buf[this.len - 1] === CABLE_MAGIC_0 ? 1 : 0
          this.discard(this.len - keep)
          return false
        }
        this.discard(at)
        continue
      }

      if (this.len < CABLE_HEADER_BYTES) return false

      const payloadLen = this.buf[4] | (this.buf[5] << 8)

      // A length this large cannot be real, so those two bytes were noise rather than a header. Step over
      // one byte and keep hunting; waiting for 64 KB that is never coming would stall the link.
      if (payloadLen > CABLE_MAX_PAYLOAD) {
        this.discard(1)
        continue
      }

      const total = CABLE_HEADER_BYTES + payloadLen + CABLE_CRC_BYTES
      if (this.len < total) return false

      const expected = this.buf[total - 2] | (this.buf[total - 1] << 8)
      const actual = cableCrc16(this.buf, 2, CABLE_HEADER_BYTES + payloadLen)

      if (actual !== expected) {
        // Drop ONE byte, not the whole frame: the magic may have been a coincidence inside noise, and a
        // genuine frame can begin one byte further in. Dropping the lot would swallow it.
        this.corruptFrames++
        this.discard(1)
        continue
      }

      onFrame({
        version: this.buf[2],
        type: this.buf[3],
        // Copied, not a view: the caller keeps PCM and firmware payloads across ticks, and the buffer
        // underneath is about to be shifted by the next frame.
        payload: this.buf.slice(CABLE_HEADER_BYTES, CABLE_HEADER_BYTES + payloadLen),
      })
      this.consume(total)
      return true
    }
  }
}
