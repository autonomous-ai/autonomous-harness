/**
 * Relay from the local WS API (`/api/local-ws`) to backend's `/api/web-ws` for a machine this daemon
 * does NOT itself own — e.g. a cloud machine, or a different paired computer, that the same signed-in
 * user also has. One pooled upstream connection per foreign machineId, reused across quick local
 * reconnects (a short linger window before actually tearing it down).
 *
 * This daemon now TERMINATES E2EE on the relay itself (see lib/e2ee/relayClient.ts), playing the
 * "client" role a browser (or the old Flutter app) used to play, toward whichever remote machine
 * `lib/e2ee/machinePeers.ts` has a pinned trust for (established out of band via `harness link
 * create`/`harness link import`). The local app therefore only ever sees plaintext — the exact same
 * shape it already gets for this daemon's own machine — for every machine, relayed or not. A machine
 * with no pinned peer fails the relay with `NO_PEER_LINK` instead of ever reaching pipe mode.
 */
import { WebSocket, type RawData } from 'ws'
import type { Frame, LocalClientSink } from '../backendSocket.js'
import type { AuthSessionManager } from './authSession.js'
import { b64d, type Identity } from './e2ee/core.js'
import type { MachinePeerStore } from './e2ee/machinePeers.js'
import { RelaySessionCrypto } from './e2ee/relayClient.js'
import { encodeTerminalLocal, type TerminalBinaryClear } from './terminalBinary.js'

const CONNECT_TIMEOUT_MS = 15_000
const LINGER_MS = 30_000

export class RelayConnectError extends Error {
  constructor(message: string, readonly closeCode?: number) {
    super(message)
    this.name = 'RelayConnectError'
  }
}

function binaryBytes(raw: RawData): Uint8Array {
  if (Buffer.isBuffer(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
  if (Array.isArray(raw)) return new Uint8Array(Buffer.concat(raw))
  return new Uint8Array()
}

interface Entry {
  ws: WebSocket
  crypto: RelaySessionCrypto
  sink: LocalClientSink | null
  onClosed: ((code: number, reason: string) => void) | null
  lingerTimer: ReturnType<typeof setTimeout> | null
}

export interface RelaySession {
  send: (frame: Frame) => void
  sendBinary: (clear: TerminalBinaryClear) => void
  detach: () => void
}

export class RemoteRelayPool {
  private entries = new Map<string, Entry>()
  private pending = new Map<string, Promise<Entry>>()

  constructor(
    private readonly auth: AuthSessionManager,
    private readonly backendWsBase: string,
    private readonly selfIdentity: Identity,
    private readonly peers: MachinePeerStore,
  ) {}

  /** Attach `sink` to the (possibly newly-created, possibly reused) upstream connection for
   *  `machineId`. `selectFrame` is the local client's own `machine_select` frame, forwarded upstream
   *  verbatim on a fresh connect — backend only reads its `.machineId`, so the local protocol's extra
   *  `localProtocolVersion` field is harmless. */
  async acquire(
    machineId: string,
    autonomousEnv: string,
    selectFrame: Frame,
    sink: LocalClientSink,
    onClosed: (code: number, reason: string) => void,
  ): Promise<RelaySession> {
    const existing = this.entries.get(machineId)
    if (existing) {
      if (existing.lingerTimer) { clearTimeout(existing.lingerTimer); existing.lingerTimer = null }
      existing.sink = sink
      existing.onClosed = onClosed
      sink.sendFrame({ type: 'connected', payload: { machineId, e2ee: false } })
      return this.sessionFor(machineId, existing)
    }
    const inFlight = this.pending.get(machineId)
    const entry = await (inFlight ?? this.connect(machineId, autonomousEnv, selectFrame))
    entry.sink = sink
    // The real backend `connected{machineId}` ack that resolved the connect above was consumed
    // internally by dial()'s handshake logic, not forwarded — this local client (whether it triggered
    // the dial or joined one already in flight) still needs its own ack to know the select succeeded.
    sink.sendFrame({ type: 'connected', payload: { machineId, e2ee: false } })
    entry.onClosed = onClosed
    return this.sessionFor(machineId, entry)
  }

  private connect(machineId: string, autonomousEnv: string, selectFrame: Frame): Promise<Entry> {
    const attempt = (forceRefresh: boolean): Promise<Entry> => this.dial(machineId, autonomousEnv, selectFrame, forceRefresh)
    // A stale access token is the single most likely reason the very first select fails (4401 on the
    // upgrade) — one retry with a freshly-refreshed token is cheap next to surfacing that as a hard
    // error to the user. Any other failure (env mismatch, not-your-machine, timeout) is not helped by
    // a token refresh, so it is not retried.
    const promise = attempt(false).catch((err) => {
      if (err instanceof RelayConnectError && err.closeCode === 4401) return attempt(true)
      throw err
    })
    this.pending.set(machineId, promise)
    // `.finally()` re-throws on rejection, producing a SECOND promise distinct from the one returned
    // below (which callers already await/catch) — left un-caught, every failed dial (e.g. NO_PEER_LINK
    // on an unlinked machine) becomes an unhandledRejection, one per attempt.
    void promise
      .finally(() => { if (this.pending.get(machineId) === promise) this.pending.delete(machineId) })
      .catch(() => {})
    return promise
  }

  private async dial(machineId: string, autonomousEnv: string, selectFrame: Frame, forceRefresh: boolean): Promise<Entry> {
    const peer = this.peers.get(machineId)
    if (!peer) throw new RelayConnectError('NO_PEER_LINK')
    const token = await this.auth.accessToken({ force: forceRefresh })
    const url = `${this.backendWsBase}/api/web-ws?autonomousEnv=${encodeURIComponent(autonomousEnv)}`
    const ws = new WebSocket(url, [token])
    const crypto = new RelaySessionCrypto({ machineId, selfIdentity: this.selfIdentity, peerPub: b64d(peer.pub) })
    const entry: Entry = { ws, crypto, sink: null, onClosed: null, lingerTimer: null }
    // Two phases before this connection is usable: (1) machine_select ack, (2) this daemon's own
    // e2e_hello/e2e_welcome as the "client" role — see lib/e2ee/relayClient.ts. Only once BOTH are done
    // does the app's onOutgoing/sink start receiving anything, so it never sees a half-encrypted stream.
    let selected = false
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timeout = setTimeout(() => {
        if (!settled) { settled = true; reject(new RelayConnectError('relay connect timed out')) }
      }, CONNECT_TIMEOUT_MS)
      ws.once('open', () => {
        try { ws.send(JSON.stringify(selectFrame)) } catch { /* the close handler below rejects */ }
      })
      ws.on('message', (raw, isBinary) => {
        if (!crypto.ready) {
          if (isBinary) return
          let frame: Frame
          try { frame = JSON.parse(raw.toString()) as Frame } catch { return }
          const payload = frame.payload as { machineId?: unknown; error?: unknown } | undefined
          if (!selected) {
            // The socket's very first frame, before any select, is {type:'connected',payload:{userId}} —
            // pure backend bookkeeping with no machineId. Swallow it; it answers nothing this relay asked.
            if (frame.type === 'connected' && payload?.machineId === undefined) return
            if (frame.type === 'connected' && payload?.machineId === machineId) {
              selected = true
              try { ws.send(JSON.stringify(crypto.helloFrame())) } catch { /* the close handler below rejects */ }
              return
            }
            if (frame.type === 'machine_select_error' && payload?.machineId === machineId) {
              if (!settled) {
                settled = true; clearTimeout(timeout)
                reject(new RelayConnectError(typeof payload.error === 'string' ? payload.error : 'machine_select_error'))
              }
              return
            }
            return // anything else before the select ack is unexpected — drop it
          }
          if (frame.type === 'e2e_welcome') {
            const ok = crypto.handleWelcome((frame.payload ?? {}) as Record<string, unknown>)
            if (!ok) { if (!settled) { settled = true; clearTimeout(timeout); reject(new RelayConnectError('E2EE_WELCOME_INVALID')) } ; return }
            if (!settled) { settled = true; clearTimeout(timeout); resolve() }
            return
          }
          if (frame.type === 'e2e_denied') {
            if (!settled) {
              settled = true; clearTimeout(timeout)
              const reason = (frame.payload as { reason?: unknown } | undefined)?.reason
              reject(new RelayConnectError(typeof reason === 'string' ? `E2EE_DENIED:${reason}` : 'E2EE_DENIED'))
            }
            return
          }
          return // anything else before the E2EE session is up is unexpected — drop it
        }
        // Session established — decrypt-then-forward / encrypt-then-send from here on.
        if (isBinary) {
          const clear = crypto.decryptTerminal(binaryBytes(raw))
          if (!clear) return // undecryptable/stale — drop, never forward ciphertext or garbage to the app
          const local = encodeTerminalLocal(clear)
          if (local) entry.sink?.sendBinary(local)
          return
        }
        let frame: Frame
        try { frame = JSON.parse(raw.toString()) as Frame } catch { return }
        if (frame.type === 'e2e_rekey') { crypto.handleRekey((frame.payload ?? {}) as Record<string, unknown>); return }
        const plain = crypto.unwrapIncoming(frame)
        if (plain) entry.sink?.sendFrame(plain)
      })
      ws.once('close', (code, reasonBuf) => {
        if (!settled) {
          settled = true; clearTimeout(timeout)
          reject(new RelayConnectError(`relay closed before session ready: ${reasonBuf?.toString() ?? ''}`, code))
        }
      })
      ws.once('error', (err) => {
        if (!settled) { settled = true; clearTimeout(timeout); reject(err instanceof Error ? err : new Error(String(err))) }
      })
    })
    // Handshake done — from here on, a close is the entry's real end-of-life, not a handshake failure.
    ws.on('close', (code, reasonBuf) => {
      this.entries.delete(machineId)
      entry.onClosed?.(code, reasonBuf?.toString() ?? '')
    })
    this.entries.set(machineId, entry)
    return entry
  }

  private sessionFor(machineId: string, entry: Entry): RelaySession {
    return {
      send: (frame) => {
        try { entry.ws.send(JSON.stringify(entry.crypto.wrapOutgoing(frame))) } catch { /* closed — onClosed will fire */ }
      },
      sendBinary: (clear) => {
        const sealed = entry.crypto.encryptTerminal(clear)
        if (!sealed) return
        try { entry.ws.send(sealed, { binary: true }) } catch { /* closed — onClosed will fire */ }
      },
      detach: () => {
        entry.sink = null
        entry.onClosed = null
        entry.lingerTimer = setTimeout(() => {
          if (!entry.sink) {
            try { entry.ws.close(1000, 'idle') } catch { /* ignore */ }
            this.entries.delete(machineId)
          }
        }, LINGER_MS)
        entry.lingerTimer.unref?.()
      },
    }
  }
}
