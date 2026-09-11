import { createHash } from 'node:crypto'
import { env } from '../config/env.js'
import { turnCredentials } from './turnCredentials.js'
import type { Frame } from './tunnel.js'

export const P2P_SIGNAL_PROTOCOL_VERSION = 1
export const P2P_SIGNAL_MAX_BYTES = 128 * 1024
export const P2P_SIGNAL_MAX_FRAMES_PER_MINUTE = 240
export const P2P_SIGNAL_MAX_BYTES_PER_MINUTE = 4 * 1024 * 1024

export const P2P_DOWN_TYPES = new Set(['p2p_offer', 'p2p_ice_candidate', 'p2p_abort'])
export const P2P_UP_TYPES = new Set(['p2p_answer', 'p2p_ice_candidate', 'p2p_abort'])

export function p2pFrameBytes(frame: Frame): number {
  return Buffer.byteLength(JSON.stringify(frame), 'utf8')
}

/** The backend may route signaling but must never learn the candidate/SDP inside it. */
export function isEncryptedP2pFrame(frame: Frame): boolean {
  const payload = frame.payload
  if (!payload || typeof payload !== 'object') return false
  const envelope = (payload as { __e2e?: unknown }).__e2e
  if (!envelope || typeof envelope !== 'object') return false
  const value = envelope as { v?: unknown; n?: unknown; k?: unknown; ct?: unknown }
  return value.v === 1
    && Number.isSafeInteger(value.n)
    && value.k === 'p'
    && typeof value.ct === 'string'
}

export class P2pSignalRateGuard {
  private startedAt = 0
  private frames = 0
  private bytes = 0

  constructor(private readonly now: () => number = () => Date.now()) {}

  allow(size: number): boolean {
    const timestamp = this.now()
    if (timestamp - this.startedAt >= 60_000) {
      this.startedAt = timestamp
      this.frames = 0
      this.bytes = 0
    }
    if (this.frames + 1 > P2P_SIGNAL_MAX_FRAMES_PER_MINUTE
      || this.bytes + size > P2P_SIGNAL_MAX_BYTES_PER_MINUTE) return false
    this.frames++
    this.bytes += size
    return true
  }
}

function rolloutBucket(userId: string, machineId: string): number {
  return createHash('sha256').update(`${userId}\0${machineId}`).digest().readUInt32BE(0) % 100
}

function stunUrls(): string[] {
  return env.TERMINAL_P2P_STUN_URLS.split(',')
    .map((url) => url.trim())
    .filter((url) => /^stuns?:/i.test(url))
    .slice(0, 8)
}

/**
 * Stays SYNCHRONOUS. Two of the three call sites are per-frame gates — one of them in adapterWs, whose
 * onMessage cannot be awaited at all — so the TURN credential is read from a warm snapshot rather than
 * fetched here. See the header of lib/turnCredentials.ts before changing this signature.
 *
 * `turn` is absent whenever TURN is unconfigured or Cloudflare is unreachable, and clients treat that
 * as STUN-only, so every failure lands on the behaviour we shipped before TURN existed.
 */
export function terminalP2pPolicy(userId: string, machineId: string): {
  enabled: boolean
  protocolVersion: number
  stunUrls: string[]
  openWaitMs: number
  turn?: { urls: string[]; username: string; credential: string }
} {
  const urls = stunUrls()
  const turn = turnCredentials()
  return {
    enabled: urls.length > 0 && rolloutBucket(userId, machineId) < env.TERMINAL_P2P_ROLLOUT_PERCENT,
    protocolVersion: P2P_SIGNAL_PROTOCOL_VERSION,
    stunUrls: urls,
    openWaitMs: env.TERMINAL_P2P_OPEN_WAIT_MS,
    ...(turn ? { turn } : {}),
  }
}
