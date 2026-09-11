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
import { sid } from './log.js'
import type { MachinePeerStore } from './e2ee/machinePeers.js'
import { RelaySessionCrypto } from './e2ee/relayClient.js'
import { encodeTerminalLocal, TerminalBinaryKind, type TerminalBinaryClear } from './terminalBinary.js'
import {
  TerminalP2pInitiator,
  TERMINAL_P2P_PROTOCOL_VERSION,
  TERMINAL_P2P_SIGNAL_TYPES,
  TERMINAL_P2P_UP_TYPES,
  readTurn,
  type TerminalP2pData,
  type TerminalP2pPolicy,
} from './terminalP2p.js'
import { warmStunUrls } from './stunSelect.js'

const CONNECT_TIMEOUT_MS = 15_000
const LINGER_MS = 30_000
// Same convention/value as localWsServer.ts's app<->daemon heartbeat. Without this, a machine-node
// cycling (e.g. `harness start` on the OTHER end after a crash/restart) can leave this daemon holding
// an upstream socket the backend silently dropped with no close frame — every RPC sent through it then
// times out client-side forever, since nothing ever removes the dead entry to let the next select
// redial. `ws.terminate()` on a missed pong forces the existing `close` handler to run cleanup.
const HEARTBEAT_MS = 20_000

// A p2p attempt that never reaches 'direct', or one that did and then got demoted mid-session, both
// leave the stream(s) on the ws relay with nothing to bring them back — see scheduleP2pRetry(). One
// policy for both cases: retry every 60s, capped at P2P_RETRY_HOURLY_CAP attempts within any trailing
// hour (tracked in p2pRetryTimestamps, not a plain counter) — a ROLLING window rather than a lifetime
// total, deliberately: the underlying reason a connection can't reach p2p is often transient at the
// scale of hours (the machine's public IP changed, a router rebooted, a NAT binding thawed), so a
// connection that burned its whole budget hours ago should still get to try again now rather than
// staying stuck on relay for the rest of the daemon's uptime. Old attempts simply age out of the
// lookback on their own, which is also why there is no separate "reset on a success" step any more —
// a connection that's been healthy for a while naturally has an empty recent window already.
const P2P_RETRY_DELAY_MS = 60_000
const P2P_RETRY_WINDOW_MS = 60 * 60 * 1000
const P2P_RETRY_HOURLY_CAP = 10
// How long a stream may sit in p2pMigrating before the sweep (piggybacked on heartbeatTimer) gives up
// on it and lets the ordinary demote-on-mismatch rule apply again.
const P2P_MIGRATION_TTL_MS = 30_000

// A connection that reached 'direct' only via a Cloudflare TURN relay pair still costs per GB — worth
// trying, periodically, for a truly direct pair instead. Unlike p2pRetry* above this NEVER touches the
// live connection until a replacement has already proven itself: see scheduleUpgradeAttempt() and
// promoteToDirect(). Capped at 3 tries and never reset (no success to reset it FOR — reaching direct
// ends the attempts for good, and 3 relay results in a row is treated as "this path is what it is").
const P2P_UPGRADE_MAX_ATTEMPTS = 3
const P2P_UPGRADE_RETRY_DELAY_MS = 60_000
// Shorter than TERMINAL_P2P_NEGOTIATION_TIMEOUT_MS's 25s: the network has already proven itself capable
// of a full negotiation (that's how the current TURN connection exists at all), so this trial doesn't
// need the first-contact worst-case budget.
const P2P_UPGRADE_ATTEMPT_TIMEOUT_MS = 15_000
// Both phases of the cutover (drain confirmation, then promote ack) wait on one round trip over an
// already-live channel — 5s is generous for that, not for a cold negotiation.
const P2P_UPGRADE_DRAIN_TIMEOUT_MS = 5_000
const P2P_PROMOTE_ACK_TIMEOUT_MS = 5_000

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
  p2p: TerminalP2pInitiator | null
  p2pPolicy: TerminalP2pPolicy | null
  p2pPendingOpens: Set<string>
  p2pStreams: Set<string>
  /** Every streamId currently open on this entry, regardless of transport — the superset p2pStreams
   *  is drawn from, and what promoteOpenStreams() walks to find migration candidates. */
  streams: Set<string>
  /** streamId -> when its migration to p2p started, so a stuck one can be swept off the heartbeat. */
  p2pMigrating: Map<string, number>
  /** Timestamps (ms epoch) of retry attempts within the trailing P2P_RETRY_WINDOW_MS — see
   *  scheduleP2pRetry(). A rolling window, not a lifetime counter: old attempts age out on their own. */
  p2pRetryTimestamps: number[]
  p2pRetryTimer: ReturnType<typeof setTimeout> | null
  /** TURN-to-direct upgrade trials — see scheduleUpgradeAttempt()/attemptUpgrade()/promoteToDirect().
   *  Entirely separate bookkeeping from p2pMigrating/p2pRetry*: this never touches entry.p2p (the live,
   *  working connection) until a replacement has already proven itself direct AND drained. */
  upgradeAttempts: number
  upgradeTimer: ReturnType<typeof setTimeout> | null
  upgradeShadow: TerminalP2pInitiator | null
  /** streamId -> when its drain-barrier resync went out, RIGHT before a cutover — distinct from
   *  p2pMigrating (that one is for WS->p2p; this is for p2p(turn)->p2p(direct), and the confirmation for
   *  each arrives over a different transport, so sharing one map would let the two migrations cross-talk. */
  upgradeDraining: Map<string, number>
  /** Resolves whichever of the two sequential waits (drain-complete, then promote-ack) is currently
   *  outstanding — the two never overlap, so one field is enough. */
  upgradeWaitResolve: (() => void) | null
  /** Set only when a promote_ack never arrived: the old connection was intentionally left open rather
   *  than guessed closed (see promoteToDirect()) — cleaned up wherever the entry itself is torn down. */
  upgradeOrphan: TerminalP2pInitiator | null
  /** True once this entry has either cut over to a true direct pair, or spent all 3 attempts without
   *  one — either way, stop trying. Never reset (unlike p2pRetryTimestamps' rolling window): there is
   *  no "next demote" to re-arm a budget for here, since staying on direct or giving up are both
   *  permanent for this entry. */
  upgradeDone: boolean
}

export interface RelaySession {
  send: (frame: Frame) => Promise<void>
  sendBinary: (clear: TerminalBinaryClear) => Promise<void>
  detach: () => void
}

function p2pPolicy(value: unknown): TerminalP2pPolicy | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (raw.enabled !== true || raw.protocolVersion !== TERMINAL_P2P_PROTOCOL_VERSION) return null
  // Regression: this used to cap at 4 while the responder's own parsing of the resulting offer
  // (buildResponderEntry in terminalP2p.ts) caps at 10 — since the offer only ever carries what THIS
  // cap let through, half of whatever the backend configured was silently dropped before an offer was
  // ever built, and the responder's higher ceiling was unreachable in practice. Kept in step with that
  // one and with the backend's own default list length (backend/src/config/env.ts).
  const stunUrls = Array.isArray(raw.stunUrls)
    ? raw.stunUrls.filter((url): url is string => typeof url === 'string' && /^stuns?:/i.test(url)).slice(0, 10)
    : []
  const openWaitMs = typeof raw.openWaitMs === 'number' && Number.isSafeInteger(raw.openWaitMs)
    ? Math.max(0, Math.min(5_000, raw.openWaitMs))
    : 1_500
  const turn = readTurn(raw.turn)
  return {
    enabled: true,
    protocolVersion: TERMINAL_P2P_PROTOCOL_VERSION,
    stunUrls,
    openWaitMs,
    ...(turn ? { turn } : {}),
  }
}

function framePayload(frame: Frame): Record<string, unknown> {
  return frame.payload && typeof frame.payload === 'object'
    ? frame.payload as Record<string, unknown>
    : {}
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
    if (entry.p2pRetryTimer) clearTimeout(entry.p2pRetryTimer)
    if (entry.upgradeTimer) clearTimeout(entry.upgradeTimer)
    void entry.upgradeShadow?.stop('invalidated', false)
    void entry.upgradeOrphan?.stop('invalidated', false)
    // The caller is invalidating so it can immediately acquire() a fresh entry on the SAME local
    // connection (it just got a forceReconnect select) — null this out first so the generic
    // `ws.on('close', ...)` cleanup below doesn't turn around and close that same local socket via a
    // now-stale onClosed callback.
    entry.onClosed = null
    void entry.p2p?.stop('invalidated', false)
    entry.p2p = null
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
      p2p: null,
      p2pPolicy: null,
      p2pPendingOpens: new Set(),
      p2pStreams: new Set(),
      streams: new Set(),
      p2pMigrating: new Map(),
      p2pRetryTimestamps: [],
      p2pRetryTimer: null,
      upgradeAttempts: 0,
      upgradeTimer: null,
      upgradeShadow: null,
      upgradeDraining: new Map(),
      upgradeWaitResolve: null,
      upgradeOrphan: null,
      upgradeDone: false,
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
          const payload = frame.payload as { machineId?: unknown; error?: unknown; p2p?: unknown } | undefined
          if (!selected) {
            // The socket's very first frame, before any select, is {type:'connected',payload:{userId}} —
            // pure backend bookkeeping with no machineId. Swallow it; it answers nothing this relay asked.
            if (frame.type === 'connected' && payload?.machineId === undefined) return
            if (frame.type === 'connected' && payload?.machineId === machineId) {
              selected = true
              entry.p2pPolicy = p2pPolicy(payload.p2p)
              // Earliest instant the url list exists. startP2p() fires one round trip later on
              // e2e_welcome, so the cache is usually still cold — what actually pays off is the
              // in-flight dedupe: begin() joins THIS race instead of starting a second one, and its
              // cost hides behind the welcome round trip. Nothing here is load-bearing for
              // correctness; drop it and the only change is a slightly later first terminal.
              // Unconditional, one line per machine select. Whether the backend actually handed us a
              // TURN credential is invisible everywhere else — not in LOG_FRAMES (which only covers
              // backendSocket, never this relay client), not in the badge, not in p2p_result — and its
              // absence is indistinguishable from "TURN is configured but ICE preferred direct".
              // Names only, never the credential itself.
              if (entry.p2pPolicy) {
                const p = entry.p2pPolicy
                console.log(`[p2p] policy · machine=${sid(machineId)} stun=${p.stunUrls.length}`
                  + ` turn=${p.turn ? `${p.turn.urls.length} urls` : 'NONE'} openWait=${p.openWaitMs}ms`)
                warmStunUrls(p.stunUrls)
              }
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
            // Three ways p2p never even starts, and until now all three looked identical from outside —
            // the terminal just quietly stayed on the ws relay. The peer-version case is the important
            // one: a machine whose CLI predates p2p answers no offer, so NO amount of STUN or TURN can
            // help it. That is a very different problem from "ICE tried and failed".
            if (!entry.p2pPolicy) {
              console.log(`[p2p] off · machine=${sid(machineId)} backend sent no policy (rollout or kill switch)`)
            } else if (crypto.terminalP2pVersion !== TERMINAL_P2P_PROTOCOL_VERSION) {
              console.log(`[p2p] off · machine=${sid(machineId)} peer speaks p2p v${crypto.terminalP2pVersion},`
                + ` we speak v${TERMINAL_P2P_PROTOCOL_VERSION} — no data channel is possible, ws relay only`)
            } else {
              this.startP2p(machineId, entry)
            }
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
          if (clear.kind === TerminalBinaryKind.keyframe && entry.p2pMigrating.has(clear.streamId)
            && !entry.p2pStreams.has(clear.streamId)) {
            // Phase 1 of a live migration completing: the responder's reply to our WS-side terminal_resync
            // proves it has drained/snapshotted this stream as of now, so it is safe to trigger phase 2.
            this.commitMigration(machineId, entry, clear.streamId)
          } else if (entry.p2pStreams.has(clear.streamId) && !entry.p2pMigrating.has(clear.streamId)) {
            // Suppressed while p2pMigrating holds this streamId: during phase 2 the responder may still
            // legitimately emit relay-routed output for it until ITS OWN flip lands, and that must not be
            // read as p2p having broken.
            this.demoteP2p(machineId, entry, 'relay_binary_received')
          }
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
        if (!plain) return
        const type = typeof plain.type === 'string' ? plain.type : ''
        if (TERMINAL_P2P_SIGNAL_TYPES.has(type)) {
          // p2p_promote/p2p_promote_ack belong to the upgrade orchestration below, not to
          // TerminalP2pInitiator's own protocol — it would just silently no-op on them.
          if (type === 'p2p_promote_ack') {
            const ackPayload = plain.payload as { sessionId?: unknown } | undefined
            if (typeof ackPayload?.sessionId === 'string' && ackPayload.sessionId === entry.p2p?.sessionId) {
              entry.upgradeWaitResolve?.()
            }
            return
          }
          // A shadow trial negotiates its OWN session alongside entry.p2p (the live primary) — route by
          // sessionId so its answer/candidates/abort reach it instead of being checked against (and
          // silently dropped by) the primary's handleSignal, which only matches its own sessionId.
          const signalSessionId = (plain.payload as { sessionId?: unknown } | undefined)?.sessionId
          if (entry.upgradeShadow && typeof signalSessionId === 'string' && signalSessionId === entry.upgradeShadow.sessionId) {
            void entry.upgradeShadow.handleSignal(type, plain.payload)
          } else {
            void entry.p2p?.handleSignal(type, plain.payload)
          }
          return
        }
        // Forward the real frame FIRST: for `terminal_ready`, the Desktop app's TerminalSession learns
        // its streamId from THIS frame — noteTerminalResponse's own terminal_link_mode frame (sent
        // synchronously inside it) must arrive after, or the app-side stream-id match silently drops it
        // (streamId is still null at that point, since terminal_ready — the thing that sets it — has
        // not been delivered yet).
        entry.sink?.sendFrame(plain)
        this.noteTerminalResponse(entry, plain, 'relay')
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
      if (entry.p2pRetryTimer) clearTimeout(entry.p2pRetryTimer)
      if (entry.upgradeTimer) clearTimeout(entry.upgradeTimer)
      void entry.upgradeShadow?.stop('relay_closed', false)
      void entry.upgradeOrphan?.stop('relay_closed', false)
      void entry.p2p?.stop('relay_closed', false)
      entry.p2p = null
      this.entries.delete(machineId)
      entry.onClosed?.(code, reasonBuf?.toString() ?? '')
    })
    ws.on('pong', () => { entry.alive = true })
    entry.heartbeatTimer = setInterval(() => {
      if (!entry.alive) { ws.terminate(); return }
      entry.alive = false
      try { ws.ping() } catch { ws.terminate() }
      // Piggybacked sweep for a migration that never completed (pane closed mid-flight, responder never
      // answered, etc.) — no dedicated timer needed, this tick is frequent enough (20s) against the 30s TTL.
      if (entry.p2pMigrating.size > 0) {
        const cutoff = Date.now() - P2P_MIGRATION_TTL_MS
        for (const [streamId, startedAt] of entry.p2pMigrating) {
          if (startedAt < cutoff) entry.p2pMigrating.delete(streamId)
        }
      }
    }, HEARTBEAT_MS)
    entry.heartbeatTimer.unref?.()
    this.entries.set(machineId, entry)
    return entry
  }

  private sessionFor(machineId: string, entry: Entry): RelaySession {
    return {
      send: async (frame) => {
        const payload = framePayload(frame)
        let useP2p = typeof payload.streamId === 'string' && entry.p2pStreams.has(payload.streamId)
        if (frame.type === 'terminal_open' && typeof payload.requestId === 'string' && entry.p2p) {
          useP2p = entry.p2p.isReady || await entry.p2p.waitUntilReady(entry.p2pPolicy?.openWaitMs ?? 1_500)
          if (useP2p) entry.p2pPendingOpens.add(payload.requestId)
          else this.reportP2pResult(entry, 'relay', undefined, 'open_wait_elapsed')
        }
        const wrapped = entry.crypto.wrapOutgoing(frame)
        const closingStreamId = frame.type === 'terminal_close' && typeof payload.streamId === 'string'
          ? payload.streamId
          : null
        if (useP2p && entry.p2p?.send(JSON.stringify(wrapped))) {
          if (closingStreamId) {
            entry.p2pStreams.delete(closingStreamId)
            entry.streams.delete(closingStreamId)
            entry.p2pMigrating.delete(closingStreamId)
          }
          return
        }
        try { entry.ws.send(JSON.stringify(wrapped)) } catch { /* closed — onClosed will fire */ }
        if (useP2p) this.demoteP2p(machineId, entry, 'send_failed')
        if (closingStreamId) {
          entry.streams.delete(closingStreamId)
          entry.p2pMigrating.delete(closingStreamId)
        }
      },
      sendBinary: async (clear) => {
        const sealed = entry.crypto.encryptTerminal(clear)
        if (!sealed) return
        const wantsP2p = entry.p2pStreams.has(clear.streamId)
        // A burst of large frames (a chunked upload's chunks, fired back-to-back) can push the data
        // channel's send buffer over TERMINAL_P2P_MAX_BUFFERED_BYTES well before the real network has
        // drained it — sendWithBackpressureRetry gives that ONE bounded chance to clear before this
        // falls through to relay-and-demote, instead of misreading a busy channel as a dead one. A
        // plain successful send resolves in microseconds, so timing the call is enough to tell "it had
        // to wait" apart from the ordinary case without threading a reporting hook through the p2p class.
        const startedAt = Date.now()
        const p2pSent = wantsP2p && await entry.p2p?.sendWithBackpressureRetry(Buffer.from(sealed))
        const waited = Date.now() - startedAt >= 50
        if (waited) {
          console.log(`[p2p] backpressure · machine=${sid(machineId)} drained=${p2pSent ? 'yes' : 'no'} after=${Date.now() - startedAt}ms`)
        }
        if (p2pSent) return
        const p2pFailed = wantsP2p
        try { entry.ws.send(sealed, { binary: true }) } catch { /* closed — onClosed will fire */ }
        if (p2pFailed) this.demoteP2p(machineId, entry, 'send_failed')
      },
      detach: () => {
        entry.sink = null
        entry.onClosed = null
        entry.lingerTimer = setTimeout(() => {
          if (!entry.sink) {
            if (entry.p2pRetryTimer) clearTimeout(entry.p2pRetryTimer)
            if (entry.upgradeTimer) clearTimeout(entry.upgradeTimer)
            void entry.upgradeShadow?.stop('idle', false)
            void entry.upgradeOrphan?.stop('idle', false)
            void entry.p2p?.stop('idle', false)
            entry.p2p = null
            try { entry.ws.close(1000, 'idle') } catch { /* ignore */ }
            this.entries.delete(machineId)
          }
        }, LINGER_MS)
        entry.lingerTimer.unref?.()
      },
    }
  }

  private startP2p(machineId: string, entry: Entry): void {
    const policy = entry.p2pPolicy
    if (!policy || entry.p2p) return
    let wasDirect = false
    const p2p = new TerminalP2pInitiator({
      policy,
      sendSignal: (type, payload) => {
        const wrapped = entry.crypto.wrapOutgoing({ type, payload })
        try { entry.ws.send(JSON.stringify(wrapped)) } catch { /* relay close handles cleanup */ }
      },
      onData: (data) => this.handleP2pData(entry, data),
      // Milestones, so a slow setup can be attributed instead of guessed at: our own gather runs from
      // start to `offer-sent` (setLocalDescription awaits gathering — nothing here trickles), the peer's
      // gather plus one relay round trip lands on `answer-in`, and everything after that is ICE
      // connectivity checks. A 10s failure looks completely different depending on which gap owns it.
      onStep: (step, elapsedMs) => {
        console.log(`[p2p] step · machine=${sid(machineId)} ${step} +${Math.round(elapsedMs)}ms`)
      },
      onState: (state, setupMs, reason) => {
        if (state === 'direct') {
          wasDirect = true
          // No explicit retry-budget reset here any more: p2pRetryTimestamps is a rolling window, so a
          // connection that's been healthy for a while already has an empty recent window on its own.
          // 'relayed' distinguishes a Cloudflare TURN path from a truly direct one. Both are "p2p" as far
          // as the terminal is concerned, but only one of them is billed per GB.
          const relayed = p2p.transport === 'relay'
          console.log(`[p2p] connected · machine=${sid(machineId)} via=${relayed ? 'turn' : 'direct'} setup=${Math.round(setupMs)}ms`)
          this.reportP2pResult(entry, 'direct', setupMs, relayed ? 'relayed' : undefined)
          this.promoteOpenStreams(machineId, entry)
          if (relayed && !entry.upgradeDone) this.scheduleUpgradeAttempt(machineId, entry)
        } else if (state === 'failed' && !wasDirect) {
          console.log(`[p2p] gave up · machine=${sid(machineId)} reason=${reason ?? 'unknown'} after=${Math.round(setupMs)}ms`
            + ` · ${p2p.negotiationDetail} — terminals stay on the ws relay`)
          this.reportP2pResult(entry, reason === 'negotiation_timeout' ? 'timeout' : 'failed', setupMs, reason)
          // Without this the entry is stuck: entry.p2p still points at this now-finished instance, and
          // startP2p()'s own guard (`if (!policy || entry.p2p) return`) would block every future attempt
          // forever — previously the only way out was a full entry teardown (network drop).
          entry.p2p = null
          this.scheduleP2pRetry(machineId, entry)
        }
      },
      onUnavailable: (reason) => this.demoteP2p(machineId, entry, reason),
    })
    entry.p2p = p2p
    p2p.start()
  }

  private handleP2pData(entry: Entry, data: TerminalP2pData): void {
    if (typeof data !== 'string') {
      const clear = entry.crypto.decryptTerminal(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
      if (!clear) return
      if (clear.kind !== TerminalBinaryKind.output && clear.kind !== TerminalBinaryKind.keyframe
        && clear.kind !== TerminalBinaryKind.sync) return
      // Phase 2 of a live migration confirmed: the responder has committed its own flip and this
      // stream's bytes are now genuinely arriving over p2p — safe to re-arm the ordinary
      // demote-on-mismatch rule for it (see the guard in the ws binary handler above).
      entry.p2pMigrating.delete(clear.streamId)
      // Drain-barrier confirmation for a TURN-to-direct upgrade in flight (promoteToDirect() phase 1):
      // this keyframe is the OLD (still-primary) connection's answer to the resync it sent to itself
      // over p2p, proving everything before that point has been accounted for.
      if (entry.upgradeDraining.delete(clear.streamId) && entry.upgradeDraining.size === 0) {
        entry.upgradeWaitResolve?.()
      }
      const local = encodeTerminalLocal(clear)
      if (local) entry.sink?.sendBinary(local)
      return
    }
    let wrapped: Frame
    try { wrapped = JSON.parse(data) as Frame } catch { return }
    if (typeof wrapped.type !== 'string' || !TERMINAL_P2P_UP_TYPES.has(wrapped.type)) return
    const plain = entry.crypto.unwrapIncoming(wrapped)
    if (!plain) return
    entry.sink?.sendFrame(plain) // real frame before the derived terminal_link_mode — see comment above
    this.noteTerminalResponse(entry, plain, 'p2p')
  }

  /**
   * Which of the three paths this stream's bytes are on, for the local app's badge.
   *
   *   'p2p'   — ICE nominated a direct candidate pair.
   *   'turn'  — there IS a data channel, but ICE could only nominate a relay pair, so every byte goes
   *             through Cloudflare TURN. Still WebRTC, still E2EE, but billed per GB.
   *   'relay' — no data channel at all; the bytes are riding the backend WebSocket.
   *
   * 'turn' is additive: 'relay' keeps the exact meaning it has always had, so an older Desktop simply
   * drops the unknown value and shows no badge rather than mislabelling a TURN session as a WS one.
   *
   * A null `transport` (channel open but werift exposed no candidate pair yet) reads as 'p2p' — the
   * same optimistic answer this frame already gave before TURN existed.
   */
  private linkMode(entry: Entry, streamId: string): 'p2p' | 'turn' | 'relay' {
    if (!entry.p2pStreams.has(streamId)) return 'relay'
    return entry.p2p?.transport === 'relay' ? 'turn' : 'p2p'
  }

  private noteTerminalResponse(entry: Entry, frame: Frame, transport: 'p2p' | 'relay'): void {
    const payload = framePayload(frame)
    const streamId = typeof payload.streamId === 'string' ? payload.streamId : ''
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
    // Any p2p-delivered frame for a stream still being migrated is itself proof the responder has
    // committed its flip — re-arm the ordinary demote-on-mismatch rule below for it.
    if (transport === 'p2p' && streamId) entry.p2pMigrating.delete(streamId)
    if (frame.type === 'terminal_ready' && requestId && streamId) {
      entry.streams.add(streamId) // the full "open, any transport" registry promoteOpenStreams() walks
      if (entry.p2pPendingOpens.delete(requestId) && transport === 'p2p') entry.p2pStreams.add(streamId)
      // Tell the local app (Desktop) which transport this stream just came up on — derived from
      // entry.p2pStreams' own post-update membership (the routing source of truth just above), not a
      // naive echo of `transport`, so a stale/duplicate terminal_ready can never report a mode that
      // doesn't match what's actually routing.
      entry.sink?.sendFrame({ type: 'terminal_link_mode', payload: { streamId, mode: this.linkMode(entry, streamId) } })
    } else if (frame.type === 'terminal_error' && requestId) {
      entry.p2pPendingOpens.delete(requestId)
    } else if (frame.type === 'terminal_closed' && streamId) {
      entry.p2pStreams.delete(streamId)
      entry.streams.delete(streamId)
      entry.p2pMigrating.delete(streamId)
    }
    // A non-terminal_ready frame for a stream still marked p2p but physically delivered over relay: a
    // quieter, single-stream demotion than demoteP2p() (which also tears down the whole p2p connection)
    // — still worth telling the local app about, since its badge would otherwise go stale. Suppressed
    // while p2pMigrating holds this streamId — see the ws binary handler's matching guard.
    if (transport === 'relay' && streamId && !entry.p2pMigrating.has(streamId) && entry.p2pStreams.delete(streamId)) {
      entry.sink?.sendFrame({ type: 'terminal_link_mode', payload: { streamId, mode: 'relay' } })
    }
  }

  private demoteP2p(machineId: string, entry: Entry, reason: string): void {
    // The ONE place every demotion converges, regardless of cause (a bad send, ICE failing outright,
    // or ICE failing after this connection had already been direct for a while) — log here rather than
    // at each call site so none of them can silently fall through with zero trace. This was the exact
    // gap that made a real production case ("machine-remote-2 stuck on relay, remote-1 stayed p2p")
    // untraceable: the connection HAD been direct, then failed, and nothing printed a single line
    // about it — 'failed && !wasDirect' in startP2p()'s onState is the only sibling that already logs,
    // and it deliberately does not cover this case (see that method's own comment).
    console.log(`[p2p] demoted · machine=${sid(machineId)} reason=${reason} streams=${entry.p2pStreams.size}`)
    // The primary just died (or is dying) — an upgrade trial in flight for it no longer means anything,
    // and scheduleP2pRetry() below is about to take over recovery via the normal path anyway.
    if (entry.upgradeTimer) { clearTimeout(entry.upgradeTimer); entry.upgradeTimer = null }
    if (entry.upgradeShadow) { void entry.upgradeShadow.stop('primary_demoted', true); entry.upgradeShadow = null }
    entry.upgradeDraining.clear()
    entry.upgradeWaitResolve = null
    const p2p = entry.p2p
    entry.p2p = null
    const streamIds = [...entry.p2pStreams]
    entry.p2pStreams.clear()
    entry.p2pPendingOpens.clear()
    for (const streamId of streamIds) {
      entry.p2pMigrating.delete(streamId)
      const resync = entry.crypto.wrapOutgoing({ type: 'terminal_resync', payload: { streamId } })
      try { entry.ws.send(JSON.stringify(resync)) } catch { /* relay close handles cleanup */ }
      entry.sink?.sendFrame({ type: 'terminal_link_mode', payload: { streamId, mode: 'relay' } })
    }
    if (streamIds.length > 0) this.reportP2pResult(entry, 'dropped', undefined, reason)
    void p2p?.stop(reason)
    this.scheduleP2pRetry(machineId, entry)
  }

  /**
   * One retry policy for both ways an entry ends up needing p2p back: never reached 'direct' at all,
   * or reached it once and then got demoted. Either way `entry.p2p` is null here (the failed/demoted
   * instance already cleared it) so `startP2p`'s own guard will accept the retry once the timer fires.
   *
   * The budget is a ROLLING window (P2P_RETRY_HOURLY_CAP attempts within the trailing
   * P2P_RETRY_WINDOW_MS), not a lifetime total — see the constants' own comment for why: the reason a
   * connection can't reach p2p right now is often no longer true an hour from now (a changed IP, a
   * router reboot, a NAT binding that thawed), and a connection that burned its whole budget hours ago
   * should still get another shot rather than being stuck on relay for the rest of the daemon's uptime.
   */
  private scheduleP2pRetry(machineId: string, entry: Entry): void {
    // Every outcome below gets a line — this used to be silent end to end, which is exactly what made
    // "did it even try to retry?" unanswerable from harness.log for the machine-remote-2 case this
    // was added for: a retry can be skipped (already pending, or budget spent this hour) or scheduled
    // and then orphaned by the time it fires (the entry it was scheduled for got replaced), and each of
    // those needs to be a different, findable line rather than three ways to produce the same silence.
    if (entry.p2pRetryTimer) {
      console.log(`[p2p] retry already pending · machine=${sid(machineId)}`)
      return
    }
    const windowStart = Date.now() - P2P_RETRY_WINDOW_MS
    entry.p2pRetryTimestamps = entry.p2pRetryTimestamps.filter((t) => t > windowStart)
    if (entry.p2pRetryTimestamps.length >= P2P_RETRY_HOURLY_CAP) {
      console.log(`[p2p] retry budget exhausted · machine=${sid(machineId)} (${entry.p2pRetryTimestamps.length}/${P2P_RETRY_HOURLY_CAP} in the last hour)`)
      return
    }
    entry.p2pRetryTimestamps.push(Date.now())
    console.log(`[p2p] retry scheduled · machine=${sid(machineId)} in ${P2P_RETRY_DELAY_MS / 1000}s`
      + ` (${entry.p2pRetryTimestamps.length}/${P2P_RETRY_HOURLY_CAP} this hour)`)
    entry.p2pRetryTimer = setTimeout(() => {
      entry.p2pRetryTimer = null
      if (this.entries.get(machineId) !== entry) {
        console.log(`[p2p] retry orphaned · machine=${sid(machineId)} — entry was torn down/replaced meanwhile`)
        return
      }
      entry.p2p = null
      this.startP2p(machineId, entry)
    }, P2P_RETRY_DELAY_MS)
    entry.p2pRetryTimer.unref?.()
  }

  /**
   * Migrate every stream already open on this entry (any transport) onto p2p, once it reaches
   * 'direct' — whether that is the very first success or a later retry succeeding. Two phases, both
   * reusing the existing terminal_resync frame rather than inventing a new signal:
   *
   *   1. Here: send terminal_resync over whichever transport the stream is CURRENTLY on (relay, since
   *      it is not yet in p2pStreams) — a drain barrier. The responder answers with a fresh keyframe
   *      over that same relay path once it has processed everything before this point.
   *   2. commitMigration(): once that keyframe arrives back over relay, THAT is the proof the drain
   *      landed, and only then do we flip this side to p2p and send a second terminal_resync — this
   *      time over p2p — which is what makes the responder flip its own routing table too.
   *
   * Never both transports live for the same direction at once: input keeps going over relay until
   * commitMigration flips p2pStreams, and output only starts riding p2p once the responder's own flip
   * (triggered by that second resync) lands.
   */
  private promoteOpenStreams(machineId: string, entry: Entry): void {
    for (const streamId of entry.streams) {
      if (entry.p2pStreams.has(streamId) || entry.p2pMigrating.has(streamId)) continue
      entry.p2pMigrating.set(streamId, Date.now())
      void this.sessionFor(machineId, entry).send({ type: 'terminal_resync', payload: { streamId } })
    }
  }

  /** Phase 2 of promoteOpenStreams() — see its doc comment. Sends directly on entry.p2p rather than
   *  through sessionFor().send(): a failure here should only abandon THIS stream's migration, not tear
   *  down the whole p2p connection the way sessionFor's own failure handling would. */
  private commitMigration(machineId: string, entry: Entry, streamId: string): void {
    if (!entry.p2p?.isReady) { entry.p2pMigrating.delete(streamId); return }
    const wrapped = entry.crypto.wrapOutgoing({ type: 'terminal_resync', payload: { streamId } })
    if (!entry.p2p.send(JSON.stringify(wrapped))) { entry.p2pMigrating.delete(streamId); return }
    entry.p2pStreams.add(streamId)
    // p2pMigrating is deliberately NOT cleared yet — that happens only once a p2p-delivered frame for
    // this stream actually arrives (handleP2pData / noteTerminalResponse), which is the real proof the
    // responder committed its own flip. Until then the demote-on-mismatch rule stays suppressed for it.
  }

  /**
   * Kicks off a periodic attempt to replace a TURN-relayed p2p connection with a true direct one.
   * Never touches entry.p2p until attemptUpgrade()'s shadow has already proven itself — see the Entry
   * interface's doc on upgradeShadow/upgradeDraining.
   */
  private scheduleUpgradeAttempt(machineId: string, entry: Entry): void {
    if (entry.upgradeTimer || entry.upgradeShadow || entry.upgradeDone) return
    if (entry.upgradeAttempts >= P2P_UPGRADE_MAX_ATTEMPTS) { entry.upgradeDone = true; return }
    entry.upgradeTimer = setTimeout(() => {
      entry.upgradeTimer = null
      if (this.entries.get(machineId) !== entry) return // entry was torn down/replaced meanwhile
      this.attemptUpgrade(machineId, entry)
    }, P2P_UPGRADE_RETRY_DELAY_MS)
    entry.upgradeTimer.unref?.()
  }

  /** One trial: negotiate a brand-new (shadow) p2p connection from scratch, entirely independent of the
   *  live primary, and see whether IT lands on a direct pair. The primary keeps serving traffic exactly
   *  as before for the whole trial — nothing here is wired into entry.p2pStreams/sessionFor() routing
   *  until promoteToDirect() has already proven success, so nothing here can disrupt it. */
  private attemptUpgrade(machineId: string, entry: Entry): void {
    if (entry.upgradeDone || !entry.p2p?.isReady || entry.p2p.transport !== 'relay' || !entry.p2pPolicy) return
    entry.upgradeAttempts++
    const policy = entry.p2pPolicy
    const shadow: TerminalP2pInitiator = new TerminalP2pInitiator({
      policy,
      upgrade: true,
      sendSignal: (type, payload) => {
        const wrapped = entry.crypto.wrapOutgoing({ type, payload })
        try { entry.ws.send(JSON.stringify(wrapped)) } catch { /* relay close handles cleanup */ }
      },
      // Identical to the primary's own wiring — correct both before promotion (nothing routes real data
      // here yet, so this never actually fires) and after (once promoted, this IS the primary).
      onData: (data) => this.handleP2pData(entry, data),
      onStep: (step, elapsedMs) => {
        console.log(`[p2p-upgrade] step · machine=${sid(machineId)} attempt=${entry.upgradeAttempts} ${step} +${Math.round(elapsedMs)}ms`)
      },
      onState: (state, setupMs, reason) => {
        console.log(`[p2p-upgrade] ${state} · machine=${sid(machineId)} attempt=${entry.upgradeAttempts}`
          + ` +${Math.round(setupMs)}ms${reason ? ` reason=${reason}` : ''}`)
      },
      onUnavailable: (reason) => {
        if (entry.p2p === shadow) {
          // Already promoted and now failing for real — an ordinary primary failure from here on.
          this.demoteP2p(machineId, entry, reason)
        } else if (entry.upgradeShadow === shadow) {
          // Died as a trial, before cutover — the primary was never touched. Just abandon this attempt.
          entry.upgradeShadow = null
          entry.upgradeDraining.clear()
          entry.upgradeWaitResolve = null
          this.finishUpgradeAttempt(machineId, entry)
        }
      },
    })
    entry.upgradeShadow = shadow
    shadow.start()
    void this.runUpgradeAttempt(machineId, entry, shadow)
  }

  private async runUpgradeAttempt(machineId: string, entry: Entry, shadow: TerminalP2pInitiator): Promise<void> {
    const ok = await shadow.waitUntilReady(P2P_UPGRADE_ATTEMPT_TIMEOUT_MS)
    if (entry.upgradeShadow !== shadow || this.entries.get(machineId) !== entry) return // superseded/torn down meanwhile
    if (!ok || shadow.transport === 'relay') {
      entry.upgradeShadow = null
      void shadow.stop('upgrade_no_gain', true)
      this.finishUpgradeAttempt(machineId, entry)
      return
    }
    await this.promoteToDirect(machineId, entry, shadow)
  }

  private finishUpgradeAttempt(machineId: string, entry: Entry): void {
    if (entry.upgradeAttempts >= P2P_UPGRADE_MAX_ATTEMPTS) {
      entry.upgradeDone = true
      console.log(`[p2p-upgrade] giving up · machine=${sid(machineId)} staying on turn after ${entry.upgradeAttempts} attempts`)
      return
    }
    this.scheduleUpgradeAttempt(machineId, entry)
  }

  /**
   * Cuts entry.p2p over to `shadow`, which has already proven itself a true direct pair. Every bail-out
   * before the actual swap (the `entry.p2p = shadow` line) leaves the primary completely untouched —
   * that line is the one moment this can no longer be undone, and everything before it is written to
   * make that moment as late and as certain as possible.
   */
  private async promoteToDirect(machineId: string, entry: Entry, shadow: TerminalP2pInitiator): Promise<void> {
    const old = entry.p2p
    if (!old || entry.upgradeShadow !== shadow || this.entries.get(machineId) !== entry) {
      void shadow.stop('upgrade_stale', true)
      if (entry.upgradeShadow === shadow) entry.upgradeShadow = null
      this.finishUpgradeAttempt(machineId, entry)
      return
    }
    const streamIds = [...entry.p2pStreams]
    if (streamIds.length > 0) {
      // Phase 1 — drain barrier over the OLD (still-primary, still fully live) connection.
      const drained = await this.waitForUpgradeMilestone(entry, () => {
        for (const streamId of streamIds) entry.upgradeDraining.set(streamId, Date.now())
        for (const streamId of streamIds) {
          void this.sessionFor(machineId, entry).send({ type: 'terminal_resync', payload: { streamId } })
        }
      }, P2P_UPGRADE_DRAIN_TIMEOUT_MS)
      if (entry.upgradeShadow !== shadow || this.entries.get(machineId) !== entry) {
        // Torn down/superseded while draining — old was never touched either way, just clean up.
        entry.upgradeDraining.clear()
        void shadow.stop('upgrade_stale', true)
        return
      }
      if (!drained) {
        // Timed out — OLD IS STILL COMPLETELY UNTOUCHED. Abandon just this attempt.
        entry.upgradeDraining.clear()
        entry.upgradeShadow = null
        void shadow.stop('upgrade_drain_timeout', true)
        this.finishUpgradeAttempt(machineId, entry)
        return
      }
    }
    // Phase 2 — the actual cutover. entry.p2pStreams is untouched: every streamId in it was already
    // p2p and stays p2p, only the object behind entry.p2p changes.
    entry.p2p = shadow
    entry.upgradeShadow = null
    const acked = await this.waitForUpgradeMilestone(entry, () => {
      for (const streamId of streamIds) {
        void this.sessionFor(machineId, entry).send({ type: 'terminal_resync', payload: { streamId } })
      }
      const wrapped = entry.crypto.wrapOutgoing({
        type: 'p2p_promote',
        payload: { sessionId: shadow.sessionId, protocolVersion: TERMINAL_P2P_PROTOCOL_VERSION },
      })
      try { entry.ws.send(JSON.stringify(wrapped)) } catch { /* relay close handles cleanup */ }
    }, P2P_PROMOTE_ACK_TIMEOUT_MS)
    entry.upgradeDone = true // either way, this entry is done trying — see the field's own doc comment
    if (acked) {
      void old.stop('upgraded', false)
      console.log(`[p2p-upgrade] promoted · machine=${sid(machineId)} attempt=${entry.upgradeAttempts}`)
    } else {
      // Ack never arrived — keep OLD alive rather than guess it is safe to close; entry.upgradeOrphan is
      // closed wherever the entry itself is torn down (invalidate/ws-close/idle-linger).
      entry.upgradeOrphan = old
      console.log(`[p2p-upgrade] promote ack timeout · machine=${sid(machineId)} — keeping the old connection`
        + ' open until this entry is torn down')
    }
  }

  /** One shared waiter shape for promoteToDirect()'s two sequential phases (drain-complete, then
   *  promote-ack) — they never overlap, so entry.upgradeWaitResolve is reused rather than doubled.
   *  `start` runs AFTER the timeout/resolver are armed, so a same-tick resolve inside it can never race
   *  past a listener that is not wired up yet. */
  private waitForUpgradeMilestone(entry: Entry, start: () => void, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false
      const done = (ok: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        entry.upgradeWaitResolve = null
        resolve(ok)
      }
      const timer = setTimeout(() => done(false), timeoutMs)
      timer.unref?.()
      entry.upgradeWaitResolve = () => done(true)
      start()
    })
  }

  private reportP2pResult(entry: Entry, outcome: string, setupMs?: number, reason?: string): void {
    try {
      entry.ws.send(JSON.stringify({
        type: 'p2p_result',
        payload: {
          outcome,
          ...(Number.isFinite(setupMs) ? { setupMs: Math.max(0, Math.round(setupMs!)) } : {}),
          ...(reason ? { reason: reason.slice(0, 64) } : {}),
        },
      }))
    } catch { /* diagnostics must never affect terminal transport */ }
  }
}
