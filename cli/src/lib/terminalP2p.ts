import { randomUUID } from 'node:crypto'
import { RTCPeerConnection, type RTCDataChannel, type RTCIceCandidateInit } from 'werift'
import { env } from '../config/env.js'
import { pickTurnUrl, selectStunUrls, type StunSelector } from './stunSelect.js'

export const TERMINAL_P2P_PROTOCOL_VERSION = 1
export const TERMINAL_P2P_CHANNEL = 'terminal-v1'
/**
 * The budget covers BOTH peers' gathering, not just ours, and 10s was too tight for that.
 *
 * Measured: our own gather is 100-400ms, but a peer whose network drops UDP to the STUN server stalls
 * the full 5s werift gather timeout (`getCandidatePromises(addresses, timeout = 5)`, hard-coded, not
 * exposed through RTCPeerConnection) before it can answer — 5027ms with a dead STUN in the list versus
 * 111ms with a live one. Add a TURN allocation over TLS and one relay round trip and the answer lands
 * around 7.2s, leaving under 3s for relay-to-relay connectivity checks, which is not enough. Observed
 * exactly that: `answer-in +7208ms` then death at +10001ms still in `connecting`.
 *
 * Raising it costs nothing user-visible: a terminal that opens before the channel is ready falls back
 * to the ws relay after `openWaitMs` (2.5s) regardless, and negotiation continuing in the background
 * only means LATER opens get p2p. Whichever side fires first aborts for both, so both ends need this.
 */
export const TERMINAL_P2P_NEGOTIATION_TIMEOUT_MS = 25_000
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

/** Cloudflare hands out one credential covering several urls; werift will only ever use one of them. */
export interface TerminalP2pTurn {
  urls: string[]
  username: string
  credential: string
}

export interface TerminalP2pPolicy {
  enabled: boolean
  protocolVersion: number
  stunUrls: string[]
  openWaitMs: number
  turn?: TerminalP2pTurn
}

export interface TerminalP2pSignal {
  sessionId: string
  protocolVersion: number
  sdp?: string
  candidate?: RTCIceCandidateInit | null
  reason?: string
  stunUrls?: string[]
  /**
   * The responder is never sent a policy of its own — the backend only checks `enabled` on that side —
   * so the offer is the only way TURN credentials can reach it. Safe: this frame is E2EE between the
   * two peers, the credential is short-lived, and the backend minted it in the first place.
   */
  turn?: TerminalP2pTurn
}

export interface TerminalP2pInitiatorDeps {
  policy: TerminalP2pPolicy
  sendSignal: (type: string, payload: TerminalP2pSignal) => void
  onData: (data: TerminalP2pData) => void
  onState?: (state: TerminalP2pState, setupMs: number, reason?: string) => void
  onUnavailable?: (reason: string) => void
  now?: () => number
  selectStunUrls?: StunSelector
  /** Coarse negotiation milestones, for working out WHERE a slow setup spends its time. */
  onStep?: (step: string, elapsedMs: number) => void
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

interface TurnChoice {
  url: string
  username: string
  credential: string
}

function peerConfig(stunUrls: string[], turn?: TurnChoice): ConstructorParameters<typeof RTCPeerConnection>[0] {
  const iceServers: Array<{ urls: string[]; username?: string; credential?: string }> = []
  if (stunUrls.length > 0) iceServers.push({ urls: stunUrls })
  if (turn) iceServers.push({ urls: [turn.url], username: turn.username, credential: turn.credential })
  return {
    iceServers,
    // Diagnostic only (TERMINAL_P2P_FORCE_RELAY): drops host and srflx so nothing but a TURN
    // allocation can be nominated. Note it also skips STUN gathering entirely inside werift, which is
    // why a forced run is fast even on a network where STUN is unreachable.
    ...(env.TERMINAL_P2P_FORCE_RELAY ? { iceTransportPolicy: 'relay' as const } : {}),
    // Left at the default 'all' deliberately: that is what produces "direct first, relay only if
    // nothing else works". werift scores candidates host 126 > srflx 100 > relay 0, so a TURN relay
    // pair is only ever nominated once every direct pair has failed. Setting 'relay' here would force
    // every session through Cloudflare — and bill for it.
    // Terminal keyframes can approach 480 KiB. SCTP fragments them, but advertise enough room so
    // the peer never rejects the message at the WebRTC API boundary before fragmentation happens.
    maxMessageSize: 512 * 1024,
  }
}

/** Shared by both sides: same validation, same reason. Anything malformed degrades to STUN-only. */
export function readTurn(value: unknown): TerminalP2pTurn | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const { username, credential } = raw
  if (typeof username !== 'string' || !username || username.length > 512) return undefined
  if (typeof credential !== 'string' || !credential || credential.length > 512) return undefined
  const urls = Array.isArray(raw.urls)
    ? raw.urls.filter((url): url is string => typeof url === 'string' && /^turns?:/i.test(url)).slice(0, 8)
    : []
  if (urls.length === 0) return undefined
  return { urls, username, credential }
}

function turnChoice(turn: TerminalP2pTurn | undefined, udpReachable: boolean | null): TurnChoice | undefined {
  if (!turn) return undefined
  const url = pickTurnUrl(turn.urls, udpReachable)
  return url ? { url, username: turn.username, credential: turn.credential } : undefined
}

/**
 * Does the nominated pair send its bytes through a TURN allocation?
 *
 * BOTH ends decide this, not just ours. One relay candidate is enough for ICE to connect, so a pair of
 * our srflx with the peer's relay is fully relayed by Cloudflare — and reading only the local side
 * (which is what this did at first) reports it as 'direct' and under-counts exactly the traffic that
 * gets billed per GB. werift's RTCIceCandidate carries only the SDP line, so the type comes out of
 * the string.
 */
export function isRelayedPair(local: string, remote?: string): boolean {
  const relay = /\btyp relay\b/
  return relay.test(local) || (typeof remote === 'string' && relay.test(remote))
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
  private readonly selectStunUrls: StunSelector
  private pc: RTCPeerConnection | null = null
  private channel: RTCDataChannel | null = null
  private ready = false
  private starting = false
  private finished = false
  private timeout: ReturnType<typeof setTimeout> | null = null
  private waiters: ReadyWaiter[] = []
  private sawAnswer = false

  constructor(private readonly deps: TerminalP2pInitiatorDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.selectStunUrls = deps.selectStunUrls ?? selectStunUrls
    this.startedAt = this.now()
  }

  private step(label: string): void {
    this.deps.onStep?.(label, this.now() - this.startedAt)
  }

  get isReady(): boolean { return this.ready && channelCanSend(this.channel) }

  /**
   * Which path ICE actually nominated, once the channel is open. 'relay' means the bytes are going
   * through Cloudflare TURN, which is billed per GB — without reporting this we would have no idea how
   * much of the traffic costs money. `null` while still negotiating, or if werift exposes no pair.
   */
  /**
   * Why a negotiation went nowhere, in one line. The distinction that matters is `answer=no`: it means
   * the peer never replied to our offer, so no candidate of ours — STUN or TURN — was ever going to be
   * tried. That is a peer problem, not a connectivity one, and no amount of relay fixes it.
   */
  get negotiationDetail(): string {
    // Both sides gather before signalling (nothing subscribes to onIceCandidate), so the candidate
    // types live in the descriptions, NOT in the trickle frames — counting those would always read 0
    // and hide exactly the asymmetry that matters: whether the PEER managed a relay candidate too.
    const types = (sdp: string): string =>
      [...new Set([...sdp.matchAll(/typ (\w+)/g)].map((m) => m[1]))].join('/') || 'none'
    return `answer=${this.sawAnswer ? 'yes' : 'no'}`
      + ` ours=${types(this.pc?.localDescription?.sdp ?? '')}`
      + ` peer=${types(this.pc?.remoteDescription?.sdp ?? '')}`
      + ` ice=${this.pc?.connectionState ?? '-'}`
  }

  get transport(): 'direct' | 'relay' | null {
    const pc = this.pc
    if (!pc || !this.ready) return null
    for (const iceTransport of pc.iceTransports) {
      const pair = iceTransport.getSelectedCandidatePair?.()
      if (!pair?.local?.candidate) continue
      return isRelayedPair(pair.local.candidate, pair.remote?.candidate) ? 'relay' : 'direct'
    }
    return null
  }

  start(): void {
    // `starting`, not `this.pc`: the peer connection is only built after the STUN race below, so for
    // those few hundred ms `this.pc` is still null and would let a second start() build a second one.
    if (this.starting || this.pc || this.finished || !this.deps.policy.enabled) return
    this.starting = true
    // Armed here rather than in begin() so the race runs INSIDE the 10s budget instead of on top of
    // it, and so a selector that somehow never settles still fails this initiator instead of hanging
    // it forever. It also keeps setupMs on the same origin as before (startedAt, set in the ctor).
    this.timeout = setTimeout(() => this.fail('negotiation_timeout'), TERMINAL_P2P_NEGOTIATION_TIMEOUT_MS)
    this.timeout.unref?.()
    this.deps.onState?.('connecting', 0)
    void this.begin()
  }

  private async begin(): Promise<void> {
    let stunUrls = this.deps.policy.stunUrls
    let udpReachable: boolean | null = null
    try {
      const selection = await this.selectStunUrls(stunUrls)
      stunUrls = selection.urls
      udpReachable = selection.udpReachable
    } catch { /* the selector contract is that it never rejects; keep the policy order regardless */ }
    // stop()/fail() may have run while the race was in flight. Building the peer connection now would
    // strand it: nothing holds a reference any more, so its UDP sockets would never be closed.
    if (this.finished) return
    this.step('stun-raced')
    const pc = new RTCPeerConnection(peerConfig(stunUrls, turnChoice(this.deps.policy.turn, udpReachable)))
    const channel = pc.createDataChannel(TERMINAL_P2P_CHANNEL, { ordered: true })
    this.pc = pc
    this.channel = channel
    this.wirePeer(pc)
    this.wireChannel(channel)
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
        // The RAW policy list, not the raced order: the responder runs its own race, and the two peers
        // need not agree on a server — a srflx candidate is each peer's own public address.
        stunUrls: this.deps.policy.stunUrls,
        ...(this.deps.policy.turn ? { turn: this.deps.policy.turn } : {}),
      })
      this.step('offer-sent')
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
        this.sawAnswer = true
        this.step('answer-in')
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
      this.step(`ice-${state}`)
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
  selectStunUrls?: StunSelector
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
  /** Per-connId offer generation. acceptOffer() awaits twice before it publishes its entry, so two
   *  offers arriving back to back can interleave (handleSignal is dispatched, not serialised) and the
   *  loser's peer connection would be orphaned by the winner's entries.set(). Bump on entry, re-check
   *  after every await. Pre-existing race — the STUN selection below only widens the window. */
  private readonly offerSeq = new Map<string, number>()
  private readonly selectStunUrls: StunSelector

  constructor(private readonly deps: TerminalP2pResponderPoolDeps) {
    this.selectStunUrls = deps.selectStunUrls ?? selectStunUrls
  }

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
    // Every reason but 'superseded' retires the connId for good, so drop its generation counter too or
    // the map grows for the life of the daemon. 'superseded' is excluded because that call comes from
    // acceptOffer itself, which has already claimed the current generation and still needs it as its
    // own liveness check across the awaits that follow.
    if (reason !== 'superseded') this.offerSeq.delete(connId)
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
    // Also drops generations for offers still inside their STUN race, which makes them bail instead of
    // building a peer connection nothing would ever close.
    this.offerSeq.clear()
  }

  private async acceptOffer(connId: string, payload: TerminalP2pSignal): Promise<void> {
    const seq = (this.offerSeq.get(connId) ?? 0) + 1
    this.offerSeq.set(connId, seq)
    await this.closeConnection(connId, 'superseded', false)
    if (this.offerSeq.get(connId) !== seq) return
    const offeredStunUrls = Array.isArray(payload.stunUrls)
      ? payload.stunUrls.filter((url): url is string => typeof url === 'string' && /^stuns?:/i.test(url)).slice(0, 4)
      : []
    // The offerer raced these too, and may well have landed on a different server. That is fine: a
    // srflx candidate is each peer's own public address, so the two sides need not agree on who to ask.
    const selection = await this.selectStunUrls(offeredStunUrls)
    if (this.offerSeq.get(connId) !== seq) return
    const turn = turnChoice(readTurn(payload.turn), selection.udpReachable)
    const pc = new RTCPeerConnection(peerConfig(selection.urls, turn))
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
