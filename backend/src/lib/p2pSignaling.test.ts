import { describe, expect, it } from 'vitest'
import {
  isEncryptedP2pFrame,
  P2P_SIGNAL_MAX_FRAMES_PER_MINUTE,
  p2pFrameBytes,
  P2pSignalRateGuard,
} from './p2pSignaling.js'

describe('P2P signaling relay guard', () => {
  it('accepts only opaque pairwise E2EE envelopes', () => {
    const encrypted = {
      type: 'p2p_offer',
      payload: { __e2e: { v: 1, n: 3, k: 'p', ct: 'opaque-ciphertext' } },
    }
    expect(isEncryptedP2pFrame(encrypted)).toBe(true)
    expect(p2pFrameBytes(encrypted)).toBe(Buffer.byteLength(JSON.stringify(encrypted)))
    expect(isEncryptedP2pFrame({ ...encrypted, payload: { sessionId: 'plaintext' } })).toBe(false)
    expect(isEncryptedP2pFrame({ ...encrypted, payload: { __e2e: { v: 1, n: 3, k: 'g', ct: 'x' } } })).toBe(false)
  })

  it('caps signaling frames per rolling minute and resets the fixed window', () => {
    let now = 1_000
    const guard = new P2pSignalRateGuard(() => now)
    for (let i = 0; i < P2P_SIGNAL_MAX_FRAMES_PER_MINUTE; i++) expect(guard.allow(1)).toBe(true)
    expect(guard.allow(1)).toBe(false)
    now += 60_000
    expect(guard.allow(1)).toBe(true)
  })
})
