/**
 * Relay from the local WS API (`/api/local-ws`) to backend's `/api/web-ws` for a machine this daemon
 * does NOT itself own — e.g. a cloud machine, or a different paired computer, that the same signed-in
 * user also has. One pooled upstream connection per foreign machineId, reused across quick local
 * reconnects (a short linger window before actually tearing it down).
 *
 * This daemon now TERMINATES E2EE on the relay itself (see lib/e2ee/relayClient.ts), playing the
 * "client" role a browser (or the old Flutter app) used to play, toward whichever remote machine
 * `lib/e2ee/machinePeers.ts` has a pinned trust for (established out of band via `harness
 * remote-password set` on the target machine + `harness link connect` here). The local app therefore
 * only ever sees plaintext — the exact same shape it already gets for this daemon's own machine — for
 * every machine, relayed or not. A machine with no pinned peer fails the relay with `NO_PEER_LINK`
 * instead of ever reaching pipe mode.
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
// Same convention/value as localWsServer.ts's app<->daemon heartbeat. Without this, a machine-node
// cycling (e.g. `harness start` on the OTHER end after a crash/restart) can leave this daemon holding
// an upstream socket the backend silently dropped with no close frame — every RPC sent through it then
// times out client-side forever, since nothing ever removes the dead entry to let the next select
// redial. `ws.terminate()` on a missed pong forces the existing `close` handler to run cleanup.
const HEARTBEAT_MS = 20_000

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
  alive: boolean
  heartbeatTimer: ReturnType<typeof setInterval> | null
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

  /** Force-drops a pooled entry so the next `acquire()` dials fresh instead of reusing it. For when
   *  the transport itself never closed but the app-level session behind it is known dead anyway — e.g.
   *  the relayed machine's own Harness process restarted, dropping its in-memory E2EE session state
   *  without ever touching this socket (nothing else — not even the heartbeat, since backend itself
   *  keeps answering pings fine — would ever notice on its own). Signalled by the local client sending
   *  `forceReconnect: true` on a fresh `machine_select` after observing a live RPC time out. */
  invalidate(machineId: string): void {
    const entry = this.entries.get(machineId)
    if (!entry) return
    this.entries.delete(machineId)
    if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer)
    if (entry.lingerTimer) clearTimeout(entry.lingerTimer)
    // The caller is invalidating so it can immediately acquire() a fresh entry on the SAME local
    // connection (it just got a forceReconnect select) — null this out first so the generic
    // `ws.on('close', ...)` cleanup below doesn't turn around and close that same local socket via a
    // now-stale onClosed callback.
    entry.onClosed = null
    try { entry.ws.terminate() } catch { /* already gone */ }
  }

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
    const entry: Entry = {
      ws,
      crypto,
      sink: null,
      onClosed: null,
      lingerTimer: null,
      alive: true,
      heartbeatTimer: null,
    }
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
              // The peer no longer trusts our identity — most commonly `harness unpair` run on ITS
              // side. Our own pinned trust is now stale too; drop it so the next attempt fails fast
              // with NO_PEER_LINK (same close-code-4404 mapping in localWsServer.ts) instead of
              // repeating a handshake that will only be denied again. The handshake never got as far
              // as being usable, so there is nothing more to read from this socket — close it rather
              // than leaving it dangling open.
              this.peers.unlink(machineId)
              try { ws.close(1000, 'peer denied') } catch { ws.terminate() }
              reject(new RelayConnectError('NO_PEER_LINK'))
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
        if (frame.type === 'e2e_denied') {
          // Mid-session revoke (e.g. `harness unpair` run on the peer while this relay was already
          // live) — the peer proactively sends this instead of just going silent. Drop our now-stale
          // trust and close with the same 4404 the app already knows how to turn into "needs to be
          // linked": the `ws.on('close', ...)` handler below forwards this code verbatim to
          // `entry.onClosed`, which `localWsServer.ts` wires straight to the local client's own close.
          this.peers.unlink(machineId)
          try { ws.close(4404, 'peer revoked trust') } catch { ws.terminate() }
          return
        }
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
      if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer)
      this.entries.delete(machineId)
      entry.onClosed?.(code, reasonBuf?.toString() ?? '')
    })
    ws.on('pong', () => { entry.alive = true })
    entry.heartbeatTimer = setInterval(() => {
      if (!entry.alive) { ws.terminate(); return }
      entry.alive = false
      try { ws.ping() } catch { ws.terminate() }
    }, HEARTBEAT_MS)
    entry.heartbeatTimer.unref?.()
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
