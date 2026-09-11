import { describe, expect, it } from 'vitest'
import {
  isEncryptedTerminalFrame,
  TERMINAL_DOWN_TYPES,
  TERMINAL_UP_TYPES,
  terminalFrameBytes,
  terminalFrameNeedsWake,
  TerminalRateGuard,
} from './terminalRelay.js'

describe('terminal opaque relay contract', () => {
  it('keeps the expected direction allowlists disjoint', () => {
    expect([...TERMINAL_DOWN_TYPES].sort()).toEqual([
      'terminal_ack', 'terminal_alive', 'terminal_capabilities', 'terminal_chunked_upload_begin',
      'terminal_chunked_upload_cancel', 'terminal_close', 'terminal_input', 'terminal_open',
      'terminal_resize', 'terminal_resync', 'terminal_scroll',
    ])
    expect([...TERMINAL_UP_TYPES].sort()).toEqual([
      'terminal_capabilities_result', 'terminal_chunked_upload_begin_result',
      'terminal_chunked_upload_progress', 'terminal_closed', 'terminal_error',
      'terminal_keyframe', 'terminal_output', 'terminal_paste_file_result',
      'terminal_paste_image_result', 'terminal_ready',
    ])
    expect([...TERMINAL_DOWN_TYPES].some((type) => TERMINAL_UP_TYPES.has(type))).toBe(false)
    expect(TERMINAL_DOWN_TYPES.has('terminal_future_unreviewed')).toBe(false)
    expect(TERMINAL_UP_TYPES.has('terminal_future_unreviewed')).toBe(false)
  })

  it('accepts only structurally valid ciphertext without opening it', () => {
    const frame = {
      type: 'terminal_input',
      payload: { __e2e: { v: 1, k: 'p', n: 7, ct: 'opaque-ciphertext' } },
    }
    expect(isEncryptedTerminalFrame(frame)).toBe(true)
    expect(terminalFrameBytes(frame)).toBe(Buffer.byteLength(JSON.stringify(frame)))
    expect(isEncryptedTerminalFrame({ type: 'terminal_input', payload: { data: 'plaintext' } })).toBe(false)
    expect(isEncryptedTerminalFrame({ type: 'terminal_input', payload: { __e2e: null } })).toBe(false)
    expect(isEncryptedTerminalFrame({ type: 'terminal_input', payload: { __e2e: { v: 1, k: 'p', n: '7', ct: 'x' } } })).toBe(false)
  })

  it('rate-limits per type in a bounded one-minute window', () => {
    let now = 1_000
    const guard = new TerminalRateGuard(() => now)
    for (let i = 0; i < 60; i++) expect(guard.allow('terminal_open', 100)).toBe(true)
    expect(guard.allow('terminal_open', 100)).toBe(false)
    expect(guard.allow('terminal_input', 100)).toBe(true)
    now += 60_000
    expect(guard.allow('terminal_open', 100)).toBe(true)
  })

  it('lets a busy renderer ack for a whole window without losing its stream', () => {
    let now = 1_000
    const guard = new TerminalRateGuard(() => now)
    // What the desktop client actually emits under sustained output: one ack per 16ms render
    // window for a full minute. Every one of them has to pass — a rejected ack is reported as
    // transport loss, so tripping this limit kills the pane rather than throttling it.
    const acksPerMinute = Math.ceil(60_000 / 16)
    for (let i = 0; i < acksPerMinute; i++) {
      expect(guard.allow('terminal_ack', 120)).toBe(true)
    }
    // Heartbeats and user-driven frames keep the tighter, unrelated budget.
    for (let i = 0; i < 1_200; i++) expect(guard.allow('terminal_alive', 100)).toBe(true)
    expect(guard.allow('terminal_alive', 100)).toBe(false)
    expect(guard.allow('terminal_ack', 120)).toBe(true)
  })

  it('wakes only for terminal_open, never per input/mouse/resize/ack frame', () => {
    expect(terminalFrameNeedsWake('terminal_open')).toBe(true)
    for (const type of TERMINAL_DOWN_TYPES) {
      if (type !== 'terminal_open') expect(terminalFrameNeedsWake(type)).toBe(false)
    }
  })
})
