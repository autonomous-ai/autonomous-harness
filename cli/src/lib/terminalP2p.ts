import { randomUUID } from 'node:crypto'
import { RTCPeerConnection, type RTCDataChannel, type RTCIceCandidateInit } from 'werift'

export const TERMINAL_P2P_PROTOCOL_VERSION = 1
export const TERMINAL_P2P_CHANNEL = 'terminal-v1'
export const TERMINAL_P2P_NEGOTIATION_TIMEOUT_MS = 10_000
export const TERMINAL_P2P_MAX_BUFFERED_BYTES = 2 * 1024 * 1024

export const TERMINAL_P2P_SIGNAL_TYPES = new Set([
  'p2p_offer',
  'p2p_answer',
  'p2p_ice_candidate',
  'p2p_abort',
])

export const TERMINAL_P2P_DOWN_TYPES = new Set([
  'terminal_capabilities', 'terminal_open', 'terminal_alive', 'terminal_ack',
  'terminal_input', 'terminal_resize', 'terminal_resync', 'terminal_close', 'terminal_scroll',
])

export const TERMINAL_P2P_UP_TYPES = new Set([
  'terminal_capabilities_result', 'terminal_ready', 'terminal_keyframe',
  'terminal_output', 'terminal_closed', 'terminal_error',
])

export type TerminalP2pState = 'connecting' | 'direct' | 'failed' | 'closed'
export type TerminalP2pData = string | Buffer

export interface TerminalP2pPolicy {
  enabled: boolean
  protocolVersion: number
  stunUrls: string[]
  openWaitMs: number
}

export interface TerminalP2pSignal {
  sessionId: string
  protocolVersion: number
  sdp?: string
  candidate?: RTCIceCandidateInit | null
  reason?: string
  stunUrls?: string[]
}

export interface TerminalP2pInitiatorDeps {
  policy: TerminalP2pPolicy
  sendSignal: (type: string, payload: TerminalP2pSignal) => void
  onData: (data: TerminalP2pData) => void
  onState?: (state: TerminalP2pState, setupMs: number, reason?: string) => void
  onUnavailable?: (reason: string) => void
  now?: () => number
}

type ReadyWaiter = (ready: boolean) => void

function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)
}

function parseSignal(value: unknown): TerminalP2pSignal | null {
  if (!value || typeof value !== 'object') return null
  const payload = value as Record<string, unknown>
  if (!validSessionId(payload.sessionId)
    || payload.protocolVersion !== TERMINAL_P2P_PROTOCOL_VERSION) return null
  return payload as unknown as TerminalP2pSignal
}

function peerConfig(stunUrls: string[]): ConstructorParameters<typeof RTCPeerConnection>[0] {
  return {
    iceServers: stunUrls.length > 0 ? [{ urls: stunUrls }] : [],
    // Terminal keyframes can approach 480 KiB. SCTP fragments them, but advertise enough room so
    // the peer never rejects the message at the WebRTC API boundary before fragmentation happens.
    maxMessageSize: 512 * 1024,
  }
}

function channelCanSend(channel: RTCDataChannel | null): channel is RTCDataChannel {
  return channel?.readyState === 'open'
    && channel.bufferedAmount < TERMINAL_P2P_MAX_BUFFERED_BYTES
}

/** Source side: owns the offerer for one pooled remote-machine relay connection. */
export class TerminalP2pInitiator {
  readonly sessionId = randomUUID()
  private readonly startedAt: number
  private readonly now: () => number
  private pc: RTCPeerConnection | null = null
  private channel: RTCDataChannel | null = null
  private ready = false
  private finished = false
  private timeout: ReturnType<typeof setTimeout> | null = null
  private waiters: ReadyWaiter[] = []

  constructor(private readonly deps: TerminalP2pInitiatorDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.startedAt = this.now()
  }

  get isReady(): boolean { return this.ready && channelCanSend(this.channel) }

  start(): void {
    if (this.pc || this.finished || !this.deps.policy.enabled) return
    const pc = new RTCPeerConnection(peerConfig(this.deps.policy.stunUrls))
    const channel = pc.createDataChannel(TERMINAL_P2P_CHANNEL, { ordered: true })
    this.pc = pc
    this.channel = channel
    this.wirePeer(pc)
    this.wireChannel(channel)
    this.timeout = setTimeout(() => this.fail('negotiation_timeout'), TERMINAL_P2P_NEGOTIATION_TIMEOUT_MS)
    this.timeout.unref?.()
    this.deps.onState?.('connecting', 0)
    void this.createOffer(pc)
  }

  private async createOffer(pc: RTCPeerConnection): Promise<void> {
    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      if (this.pc !== pc || this.finished) return
      const local = pc.localDescription
      if (!local) throw new Error('local_description_missing')
      this.deps.sendSignal('p2p_offer', {
        sessionId: this.sessionId,
        protocolVersion: TERMINAL_P2P_PROTOCOL_VERSION,
        sdp: local.sdp,
        stunUrls: this.deps.policy.stunUrls,
      })
    } catch {
      this.fail('offer_failed')
    }
  }

  async handleSignal(type: string, value: unknown): Promise<boolean> {
    if (!TERMINAL_P2P_SIGNAL_TYPES.has(type)) return false
    const payload = parseSignal(value)
    if (!payload || payload.sessionId !== this.sessionId || this.finished) return true
    const pc = this.pc
    if (!pc) return true
    try {
      if (type === 'p2p_answer' && typeof payload.sdp === 'string') {
        await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp })
      } else if (type === 'p2p_ice_candidate') {
        await pc.addIceCandidate(payload.candidate ?? null)
      } else if (type === 'p2p_abort') {
        this.fail(payload.reason || 'peer_aborted')
      }
    } catch {
      this.fail('signal_invalid')
    }
    return true
  }

  send(data: TerminalP2pData): boolean {
    const channel = this.channel
    if (!this.isReady || !channelCanSend(channel)) return false
    try {
      channel.send(data)
      return true
    } catch {
      // Let the caller put the already-encrypted frame on WebSocket first. Failing synchronously
      // here can emit a higher-counter resync before that fallback frame and make it look replayed.
      queueMicrotask(() => this.fail('send_failed'))
      return false
    }
  }

  waitUntilReady(timeoutMs: number): Promise<boolean> {
    if (this.isReady) return Promise.resolve(true)
    if (this.finished || timeoutMs <= 0) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      let settled = false
      const done = (ready: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.waiters = this.waiters.filter((waiter) => waiter !== done)
        resolve(ready)
      }
      const timer = setTimeout(() => done(false), timeoutMs)
      timer.unref?.()
      this.waiters.push(done)
    })
  }

  async stop(reason = 'closed', notifyPeer = true): Promise<void> {
    if (this.finished) return
    this.finished = true
    this.ready = false
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = null
    for (const waiter of this.waiters.splice(0)) waiter(false)
    if (notifyPeer) {
      this.deps.sendSignal('p2p_abort', {
        sessionId: this.sessionId,
        protocolVersion: TERMINAL_P2P_PROTOCOL_VERSION,
        reason,
      })
    }
    try { this.channel?.close() } catch { /* already closed */ }
    const pc = this.pc
    this.channel = null
    this.pc = null
    if (pc) await pc.close().catch(() => { /* best effort */ })
    this.deps.onState?.('closed', this.now() - this.startedAt, reason)
  }

  private wirePeer(pc: RTCPeerConnection): void {
    pc.connectionStateChange.subscribe((state) => {
      if (this.pc !== pc || this.finished) return
      if (state === 'failed' || state === 'disconnected') this.fail(`peer_${state}`)
    })
  }

  private wireChannel(channel: RTCDataChannel): void {
    channel.bufferedAmountLowThreshold = 256 * 1024
    channel.stateChanged.subscribe((state) => {
      if (this.channel !== channel || this.finished) return
      if (state === 'open') {
        this.ready = true
        if (this.timeout) clearTimeout(this.timeout)
        this.timeout = null
        for (const waiter of this.waiters.splice(0)) waiter(true)
        this.deps.onState?.('direct', this.now() - this.startedAt)
      } else if ((state === 'closed' || state === 'closing') && this.ready) {
        this.fail('channel_closed')
      }
    })
    channel.onMessage.subscribe((data) => {
      if (this.channel === channel && !this.finished) this.deps.onData(data)
    })
    channel.error.subscribe(() => this.fail('channel_error'))
  }

  private fail(reason: string): void {
    if (this.finished) return
    const wasReady = this.ready
    this.ready = false
    this.deps.onState?.('failed', this.now() - this.startedAt, reason)
    if (wasReady) this.deps.onUnavailable?.(reason)
    void this.stop(reason)
  }
}

export interface TerminalP2pResponderPoolDeps {
  sendSignal: (connId: string, type: string, payload: TerminalP2pSignal) => void
  onData: (connId: string, data: TerminalP2pData) => void
  onUnavailable?: (connId: string, reason: string) => void
}

interface ResponderEntry {
  sessionId: string
  pc: RTCPeerConnection
  channel: RTCDataChannel | null
  ready: boolean
  timeout: ReturnType<typeof setTimeout>
  closing: boolean
}

/** Target side: one responder per authenticated source connId. */
export class TerminalP2pResponderPool {
  private readonly entries = new Map<string, ResponderEntry>()

  constructor(private readonly deps: TerminalP2pResponderPoolDeps) {}

  async handleSignal(connId: string, type: string, value: unknown): Promise<boolean> {
    if (!TERMINAL_P2P_SIGNAL_TYPES.has(type)) return false
    const payload = parseSignal(value)
    if (!payload) return true
    if (type === 'p2p_offer' && typeof payload.sdp === 'string') {
      await this.acceptOffer(connId, payload)
      return true
    }
    const entry = this.entries.get(connId)
    if (!entry || entry.sessionId !== payload.sessionId) return true
    try {
      if (type === 'p2p_ice_candidate') await entry.pc.addIceCandidate(payload.candidate ?? null)
      else if (type === 'p2p_abort') await this.closeConnection(connId, payload.reason || 'peer_aborted', false)
    } catch {
      await this.closeConnection(connId, 'signal_invalid')
    }
    return true
  }

  send(connId: string, data: TerminalP2pData): boolean {
    const entry = this.entries.get(connId)
    const channel = entry?.channel ?? null
    if (!entry?.ready || !channelCanSend(channel)) return false
    try {
      channel.send(data)
      return true
    } catch {
      void this.closeConnection(connId, 'send_failed')
      return false
    }
  }

  async closeConnection(connId: string, reason = 'closed', notifyPeer = true): Promise<void> {
    const entry = this.entries.get(connId)
    if (!entry || entry.closing) return
    entry.closing = true
    this.entries.delete(connId)
    clearTimeout(entry.timeout)
    if (notifyPeer) {
      this.deps.sendSignal(connId, 'p2p_abort', {
        sessionId: entry.sessionId,
        protocolVersion: TERMINAL_P2P_PROTOCOL_VERSION,
        reason,
      })
    }
    try { entry.channel?.close() } catch { /* already closed */ }
    await entry.pc.close().catch(() => { /* best effort */ })
  }

  async stop(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((connId) => this.closeConnection(connId, 'shutdown', false)))
  }

  private async acceptOffer(connId: string, payload: TerminalP2pSignal): Promise<void> {
    await this.closeConnection(connId, 'superseded', false)
    const offeredStunUrls = Array.isArray(payload.stunUrls)
      ? payload.stunUrls.filter((url): url is string => typeof url === 'string' && /^stuns?:/i.test(url)).slice(0, 4)
      : []
    const pc = new RTCPeerConnection(peerConfig(offeredStunUrls))
    const entry: ResponderEntry = {
      sessionId: payload.sessionId,
      pc,
      channel: null,
      ready: false,
      closing: false,
      timeout: setTimeout(() => {
        this.deps.onUnavailable?.(connId, 'negotiation_timeout')
        void this.closeConnection(connId, 'negotiation_timeout')
      }, TERMINAL_P2P_NEGOTIATION_TIMEOUT_MS),
    }
    entry.timeout.unref?.()
    this.entries.set(connId, entry)
    pc.connectionStateChange.subscribe((state) => {
      if (this.entries.get(connId) !== entry || entry.closing) return
      if (state === 'failed' || state === 'disconnected') {
        if (entry.ready) this.deps.onUnavailable?.(connId, `peer_${state}`)
        void this.closeConnection(connId, `peer_${state}`)
      }
    })
    pc.onDataChannel.subscribe((channel) => {
      if (this.entries.get(connId) !== entry || channel.label !== TERMINAL_P2P_CHANNEL) {
        channel.close()
        return
      }
      entry.channel = channel
      channel.bufferedAmountLowThreshold = 256 * 1024
      channel.stateChanged.subscribe((state) => {
        if (this.entries.get(connId) !== entry || entry.closing) return
        if (state === 'open') {
          entry.ready = true
          clearTimeout(entry.timeout)
        } else if ((state === 'closed' || state === 'closing') && entry.ready) {
          entry.ready = false
          this.deps.onUnavailable?.(connId, 'channel_closed')
          void this.closeConnection(connId, 'channel_closed')
        }
      })
      channel.onMessage.subscribe((data) => {
        if (this.entries.get(connId) === entry && !entry.closing) this.deps.onData(connId, data)
      })
      channel.error.subscribe(() => {
        if (entry.ready) this.deps.onUnavailable?.(connId, 'channel_error')
        void this.closeConnection(connId, 'channel_error')
      })
    })
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp! })
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      if (this.entries.get(connId) !== entry || entry.closing) return
      const local = pc.localDescription
      if (!local) throw new Error('local_description_missing')
      this.deps.sendSignal(connId, 'p2p_answer', {
        sessionId: payload.sessionId,
        protocolVersion: TERMINAL_P2P_PROTOCOL_VERSION,
        sdp: local.sdp,
      })
    } catch {
      await this.closeConnection(connId, 'answer_failed')
    }
  }
}
