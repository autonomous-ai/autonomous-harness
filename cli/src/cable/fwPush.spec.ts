// The two things about a firmware push that fail silently and at the far end.
//
//  · WHICH image gets offered. Offering the wrong one is not a crash: the dial takes it, reboots, and runs
//    software nobody chose — the sibling product lost a fresh build to an older bundle twice before anyone
//    noticed, because `idf.py flash` said Done and the panel looked fine.
//  · HOW FAST it goes out. The ESP32-S3 USB peripheral has no back-pressure, so sending past the credit
//    window does not slow this side down — the dial's ring overflows and the bytes are gone with no error.
import { describe, expect, it, vi } from 'vitest'

import { FW_SLICE_BYTES, FW_WINDOW_BYTES, FirmwareTransfer, shouldOffer } from './fwPush.js'

describe('shouldOffer', () => {
  it('offers a strictly newer release', () => {
    expect(shouldOffer('0.0.35', '0.0.36')).toBe(true)
    expect(shouldOffer('0.0.35', '0.1.0')).toBe(true)
    expect(shouldOffer('v0.0.35', '0.1.0')).toBe(true)
  })

  it('does nothing for the same version', () => {
    expect(shouldOffer('0.0.35', '0.0.35')).toBe(false)
  })

  it('never rolls a dial backwards', () => {
    // A rollback is a decision made by publishing, not by whichever daemon happens to be plugged in.
    expect(shouldOffer('0.1.0', '0.0.36')).toBe(false)
  })

  it('never touches a dev build', () => {
    // ESP-IDF stamps `git describe` when the project sets no PROJECT_VER. Offering the published image to
    // one of these is exactly how a just-flashed build gets silently replaced seconds later.
    expect(shouldOffer('v0.3.38-36-gbc64073-dirty', '9.9.9')).toBe(false)
    expect(shouldOffer('0.0.35-dirty', '0.0.36')).toBe(false)
    expect(shouldOffer('', '0.0.36')).toBe(false)
  })
})

describe('FirmwareTransfer', () => {
  /** A transfer whose slices are collected instead of written to a port. */
  function make(size: number) {
    const sent: number[] = []
    const image = Buffer.alloc(size, 7)
    const t = new FirmwareTransfer(image, '1.2.3', async (slice) => { sent.push(slice.length) }, () => {})
    return { t, sent, image }
  }

  it('stops at the credit window and goes no further until acked', async () => {
    const { t, sent } = make(1_000_000)
    await t.pump()
    const inFlight = sent.reduce((a, b) => a + b, 0)
    expect(inFlight).toBeLessThanOrEqual(FW_WINDOW_BYTES + FW_SLICE_BYTES)

    // Nothing more moves without an ack — that is the whole mechanism. Calling pump() again must not
    // sneak another slice out.
    const before = sent.length
    await t.pump()
    expect(sent.length).toBe(before)
  })

  it('each ack releases exactly as much as it retired', async () => {
    const { t, sent } = make(1_000_000)
    await t.pump()
    const first = sent.length
    await t.onProgress(FW_SLICE_BYTES) // the dial wrote one slice
    expect(sent.length).toBe(first + 1)
  })

  it('delivers the whole image, in order, in slices no larger than the agreed one', async () => {
    const size = FW_SLICE_BYTES * 5 + 123
    const { t, sent } = make(size)
    await t.pump()
    let acked = 0
    while (acked < size) {
      acked = Math.min(acked + FW_SLICE_BYTES, size)
      await t.onProgress(acked)
    }
    expect(sent.reduce((a, b) => a + b, 0)).toBe(size)
    expect(Math.max(...sent)).toBeLessThanOrEqual(FW_SLICE_BYTES)
    expect(sent.at(-1)).toBe(123) // the tail is short, not padded
  })

  it('says how far it got when it is cut off', async () => {
    const log = vi.fn()
    const image = Buffer.alloc(100_000)
    const t = new FirmwareTransfer(image, '1.2.3', async () => {}, log)
    await t.pump()
    await t.onProgress(40_000)
    t.finish('interrupted by the port closing')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('40000/100000'))
    // Finishing twice must not double-log: the port closing and the session ending both call it.
    t.finish('again')
    expect(log).toHaveBeenCalledTimes(1)
  })
})
