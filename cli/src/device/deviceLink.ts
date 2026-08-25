// The daemon as a DEVICE on the backend's device plane, held on the dial's behalf.
//
// This is the only thing in the CLI that reaches a machine that is not this computer. It exists because
// the dial has no network of its own: everything it can ask for about another machine is asked here and
// answered back over the cable.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────────────────────────────
// It is NOT the daemon's own backend socket. `BackendSocket` (/api/adapter-ws) holds the NODE role for
// this computer's machine and is the sole writer of its down-channel; this holds the COMMANDER role on
// somebody else's. Different endpoint, different role, different lifetime — and no conflict, because the
// backend keys hub clients by (machineId, kind).
//
// Three rules, each paid for:
//
//   1. THE LOCAL MACHINE NEVER COMES THROUGH HERE. Its agents are in this process. Routing them to a dial
//      plugged into this very computer via the cloud would add a round trip, a failure mode and an
//      audience, for nothing. `attach()` refuses it outright rather than trusting callers.
//
//   2. NEVER CLEAR THE AUTH SESSION. `BackendSocket.onRevoked` owns that decision. Two sockets racing to
//      wipe a session on the same 401 is a bug waiting for a bad afternoon; a dead DeviceLink must
//      degrade to "other machines unavailable" and leave the cabled machine working.
//
//   3. LOG EVERY ERROR AND EVERY DROPPED FRAME. This feature's characteristic bug is SILENT EMPTINESS —
//      an RPC answered with an error nobody printed, a card arriving in a shape nobody recognised. All of
//      them render as "the carousel is empty", and none of them says so anywhere by default.
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'

import WebSocket from 'ws'

import type { AuthSessionManager } from '../lib/authSession.js'
import { b64d, type Identity } from '../lib/e2ee/core.js'
import { RelaySessionCrypto } from '../lib/e2ee/relayClient.js'
import type { MachinePeer } from '../lib/e2ee/machinePeers.js'
import { VERSION } from '../version.js'

/** One frame on the wire. The backend's own vocabulary, unchanged. */
export interface DeviceFrame {
  type?: string
  machineId?: string
  agentId?: string
  payload?: Record<string, unknown>
  [key: string]: unknown
}

const RPC_TIMEOUT_MS = 15_000
const PING_EVERY_MS = 15_000
const BASE_DELAY_MS = 1_000
const MAX_DELAY_MS = 30_000

export type DeviceLinkStatus = 'idle' | 'connecting' | 'ready' | 'error'

export interface DeviceLinkOpts {
  auth: AuthSessionManager
  backendWsBase: string
  computerId: string
  autonomousEnv: string
  /** This daemon's own E2EE identity — the same one `harness link create/import` signs with. */
  identity: Identity
  /** The pinned key for a machine, read FRESH: `harness link import` runs as a separate process. */
  peer: (machineId: string) => MachinePeer | null
  log: (line: string) => void
}

export class DeviceLink {
  private ws: WebSocket | null = null
  private attached = ''
  private wanted = ''
  private attempts = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private state: DeviceLinkStatus = 'idle'
  private readonly pending = new Map<string, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private readonly listeners = new Set<(frame: DeviceFrame) => void>()
  /** Resolves when `machine_selected` lands, so callers can await the attach rather than poll for it. */
  private selectWaiter: { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null
  /**
   * The session for the attached machine, or null when none is needed.
   *
   * Only REMOTE machines (another computer running this same daemon) require one: a cloud machine's RPCs
   * are answered by the backend itself and its cards are plaintext, so there is nothing to establish and
   * nobody at the far end to establish it with.
   */
  private crypto: RelaySessionCrypto | null = null
  private cryptoWaiter: { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null

  constructor(private readonly opts: DeviceLinkOpts) {}

  status(): DeviceLinkStatus { return this.state }
  get selectedMachine(): string { return this.attached }

  onFrame(cb: (frame: DeviceFrame) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** Dial if needed, then select `machineId`. Rejects with a plain Error the caller maps to a code. */
  async attach(machineId: string): Promise<void> {
    if (!machineId) throw new Error('no machine to attach to')
    this.wanted = machineId
    if (this.attached === machineId && this.ws?.readyState === WebSocket.OPEN) return
    await this.connect()
    await this.select(machineId)
    await this.establish(machineId)
  }

  /**
   * Bring up the E2EE session for a machine that needs one.
   *
   * The trust anchor is the PINNED key from `harness link import`, never anything the backend hands over:
   * a key directory would make the relay the trust anchor, which is the exact property end-to-end
   * encryption exists to deny it.
   */
  private async establish(machineId: string): Promise<void> {
    this.crypto = null
    const peer = this.opts.peer(machineId)
    if (!peer) return   // a cloud machine, or one whose RPCs the backend answers itself
    const crypto = new RelaySessionCrypto({ machineId, selfIdentity: this.opts.identity, peerPub: b64d(peer.pub) })
    this.crypto = crypto
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.cryptoWaiter = null
        reject(new Error('the machine did not answer the E2EE hello'))
      }, RPC_TIMEOUT_MS)
      this.cryptoWaiter = { resolve, reject, timer }
      this.send(crypto.helloFrame() as DeviceFrame)
    })
    this.opts.log(`device: e2e session ready ${machineId}`)
  }

  /** Let go of whatever is attached. The socket is closed: nothing else on it is being watched. */
  release(): void {
    this.wanted = ''
    this.attached = ''
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: 'machine_deselect' })
    }
    this.teardown('released')
  }

  stop(): void {
    this.wanted = ''
    this.teardown('daemon stopping')
  }

  /** Fire-and-forget. Dropped with a line rather than thrown: a turn is not worth an unhandled rejection. */
  send(frame: DeviceFrame): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.opts.log(`device: dropped ${frame.type ?? '?'} — no link`)
      return
    }
    // Wrapped only once the session is up. `e2e_*` frames are the handshake itself and must go in clear,
    // or the far end would need the key to learn the key.
    const out = this.crypto?.ready && !String(frame.type ?? '').startsWith('e2e_')
      ? (this.crypto.wrapOutgoing(frame as Record<string, unknown>) as DeviceFrame)
      : frame
    try { this.ws.send(JSON.stringify(out)) } catch (err) {
      this.opts.log(`device: send ${frame.type ?? '?'} failed (${(err as Error).message})`)
    }
  }

  /** One request/response, correlated by `requestId`. Rejects on timeout or an `error` in the reply. */
  async rpc(type: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error('not connected')
    const requestId = randomUUID()
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        this.opts.log(`device: ${type} timed out after ${RPC_TIMEOUT_MS} ms`)
        reject(new Error(`${type} timed out`))
      }, RPC_TIMEOUT_MS)
      this.pending.set(requestId, { resolve, reject, timer })
      this.send({ type, payload: { ...payload, requestId } })
    })
  }

  // ── connection ──────────────────────────────────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return
    if (this.ws?.readyState === WebSocket.CONNECTING) return this.waitOpen()
    this.state = 'connecting'
    const base = this.opts.backendWsBase.replace(/\/$/, '')
    const url = `${base}/api/device-ws?computer=${encodeURIComponent(this.opts.computerId)}`
      + `&label=${encodeURIComponent(hostname())}`
      + `&autonomousEnv=${encodeURIComponent(this.opts.autonomousEnv)}`

    let token = await this.opts.auth.accessToken()
    this.opts.log(`device: connecting → ${base}/api/device-ws`)
    try {
      await this.open(url, token)
    } catch (err) {
      // Exactly ONE forced refresh, and only for a 401. Anything else is not a token problem, and a
      // refresh loop against a backend that is simply down burns the refresh token for nothing.
      if (!/401/.test(String((err as Error).message))) throw err
      token = await this.opts.auth.accessToken({ force: true, failedToken: token })
      await this.open(url, token)
    }
  }

  private open(url: string, token: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, [token])
      this.ws = ws
      const onError = (err: Error): void => { cleanup(); reject(err) }
      const onOpen = (): void => {
        cleanup()
        this.attempts = 0
        this.state = 'ready'
        // `e2ee_data` says this side can decrypt an encrypted `*_result` — which it can, via
        // RelaySessionCrypto below. Advertising it before that was true would turn a clean
        // E2EE_REQUIRED error into a hang, which is why it went in only once the session did.
        //
        // `multi_machine` is deliberately NOT advertised: it would attach a commander to EVERY machine,
        // including this computer's own, whose daemon would then burn an LLM recap on turns nobody is
        // watching and echo its own cards back to itself through the cloud.
        this.send({
          type: 'device_hello',
          payload: { chip: 'harness-cli', firmwareVersion: VERSION, caps: ['e2ee_data'] },
        })
        this.armPing()
        resolve()
      }
      const cleanup = (): void => {
        ws.off('error', onError)
        ws.off('open', onOpen)
      }
      ws.once('error', onError)
      ws.once('open', onOpen)
      ws.on('message', (raw) => this.onMessage(raw))
      ws.on('close', (code) => this.onClose(code))
    })
  }

  private waitOpen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = this.ws
      if (!ws) return reject(new Error('no socket'))
      ws.once('open', () => resolve())
      ws.once('error', (err) => reject(err))
    })
  }

  private select(machineId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.selectWaiter = null
        reject(new Error('the machine did not answer'))
      }, RPC_TIMEOUT_MS)
      this.selectWaiter = { resolve, reject, timer }
      this.send({ type: 'machine_select', payload: { machineId } })
    })
  }

  private onWelcome(payload: Record<string, unknown>): void {
    if (!this.crypto) return
    if (!this.crypto.handleWelcome(payload)) { this.failCrypto(new Error('E2EE_HANDSHAKE_FAILED')); return }
    if (this.cryptoWaiter) { clearTimeout(this.cryptoWaiter.timer); this.cryptoWaiter.resolve(); this.cryptoWaiter = null }
  }

  private failCrypto(err: Error): void {
    this.crypto = null
    if (this.cryptoWaiter) { clearTimeout(this.cryptoWaiter.timer); this.cryptoWaiter.reject(err); this.cryptoWaiter = null }
  }

  private armPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    // App-level, not a WS ping: the backend refreshes device presence on any inbound frame, and a socket
    // that stops being present is dropped from every machine it is attached to.
    this.pingTimer = setInterval(() => this.send({ type: 'ping' }), PING_EVERY_MS)
  }

  private teardown(why: string): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(why)) }
    this.pending.clear()
    if (this.selectWaiter) { clearTimeout(this.selectWaiter.timer); this.selectWaiter.reject(new Error(why)); this.selectWaiter = null }
    this.failCrypto(new Error(why))
    const ws = this.ws
    this.ws = null
    this.attached = ''
    this.state = 'idle'
    try { ws?.close() } catch { /* already gone */ }
  }

  private onClose(code: number): void {
    this.opts.log(`device: closed (${code})`)
    const wanted = this.wanted
    this.teardown(`socket closed (${code})`)
    if (!wanted) return
    // 401/403 after the one refresh above is a decision, not a hiccup: stop, and let the cabled machine
    // carry on. Clearing the session here is NOT this class's call — see rule 2 in the header.
    if (code === 4401 || code === 4403) {
      this.state = 'error'
      this.opts.log('device: not authorized — other machines are unavailable until the next sign-in')
      return
    }
    const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(this.attempts++, 5))
    this.reconnectTimer = setTimeout(() => {
      void this.attach(wanted).catch((err) => this.opts.log(`device: reattach failed (${(err as Error).message})`))
    }, delay)
  }

  private onMessage(raw: WebSocket.RawData): void {
    let frame: DeviceFrame
    try { frame = JSON.parse(raw.toString()) as DeviceFrame } catch { return }

    if (frame.type === 'e2e_welcome') { this.onWelcome((frame.payload ?? {}) as Record<string, unknown>); return }
    if (frame.type === 'e2e_rekey') { this.crypto?.handleRekey((frame.payload ?? {}) as Record<string, unknown>); return }
    if (frame.type === 'e2e_denied') {
      // The far end knows this daemon's key and rejected it — the pin is stale, not merely missing.
      this.opts.log('device: e2e denied — re-run `harness link import` for this machine')
      this.failCrypto(new Error('E2EE_DENIED'))
      return
    }

    if (this.crypto?.ready) {
      const plain = this.crypto.unwrapIncoming(frame as Record<string, unknown>)
      if (!plain) {
        // The single most misleading failure this lane has: an undecryptable card is indistinguishable
        // from no card at all, and the dial just sits through a whole turn showing nothing.
        this.opts.log(`device: could not decrypt ${frame.type ?? '?'} — dropped`)
        return
      }
      frame = plain as DeviceFrame
    }
    const type = frame.type ?? ''
    const payload = (frame.payload ?? {}) as Record<string, unknown>

    if (type === 'machine_selected') {
      this.attached = typeof payload.machineId === 'string' ? payload.machineId : this.wanted
      this.opts.log(`device: machine_selected ${this.attached}`)
      if (this.selectWaiter) { clearTimeout(this.selectWaiter.timer); this.selectWaiter.resolve(); this.selectWaiter = null }
      return
    }
    if (type === 'machine_select_error') {
      const code = typeof payload.error === 'string' ? payload.error : 'SELECT_FAILED'
      this.opts.log(`device: machine_select_error ${code}`)
      if (this.selectWaiter) { clearTimeout(this.selectWaiter.timer); this.selectWaiter.reject(new Error(code)); this.selectWaiter = null }
      return
    }
    if (type === 'device_revoked') {
      this.opts.log('device: revoked — this dial was removed from the account')
      this.wanted = ''
      this.teardown('revoked')
      return
    }

    if (type.endsWith('_result')) {
      const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
      const waiter = requestId ? this.pending.get(requestId) : undefined
      if (!waiter) {
        // Not noise worth suppressing: a reply nobody is waiting for is either a timeout that already
        // fired or a frame the hub filtered and re-sent, and both are worth seeing while this is young.
        this.opts.log(`device: unmatched ${type}`)
        return
      }
      this.pending.delete(requestId)
      clearTimeout(waiter.timer)
      if (typeof payload.error === 'string') {
        this.opts.log(`device: ${type} error=${payload.error}`)
        waiter.reject(new Error(payload.error))
        return
      }
      waiter.resolve(payload)
      return
    }

    for (const cb of this.listeners) cb(frame)
  }
}
