/**
 * Shared client-hub plumbing used by both terminating endpoints — web (`lib/webWs.ts`) and device
 * (`lib/deviceWs.ts`). A client (web or commander) attaches here; the hub:
 *   - registers it (so client-counts + the `__clients` presence signal to the node are right),
 *   - ensures ONE up:{machineId} Redis subscription per agent on this instance that fans events to all
 *     local clients (web get everything with webEligible; commander gets commanderEligible only),
 *   - exposes publishClientDown for the caller to send client→node messages.
 */
import { WebSocket } from 'ws'
import { randomUUID } from 'crypto'
import {
  bumpCommanderJoinGeneration,
  getAgentClientTotals,
  getCommanderJoinGeneration,
  publishDown,
  publishTerminalDown,
  publishUp,
  setAgentClientCount,
  subscribeUp,
  subscribeTerminalUp,
} from './bus.js'
import { INSTANCE_ID } from './instance.js'
import * as registry from './registry.js'
import type { ClientKind } from './registry.js'
import type { Frame, UpBusMsg } from './tunnel.js'
import { routeDown } from './providerLink.js'
import { logger } from '../utils/logger.js'
import { decodeTerminalHop, encodeTerminalHop, TerminalHopDirection } from './terminalBinary.js'

// Reserved inner-frame type: backend→node client-presence signal (drives the node's event buffering
// and replay-on-connect + commander recap warm). Never surfaced to a real client.
export const CLIENTS_FRAME = '__clients'

// Reserved down-frame type: a client-holding backend pokes B_m (the manager-socket owner) to recompute
// + re-emit CLIENTS_FRAME from the GLOBAL total. Intercepted in managerWs's down subscription — never
// forwarded to the node.
export const CLIENTS_DIRTY = '__clients_dirty'

// machineId → unsubscribe for the single up:{machineId} subscription held while ≥1 local client exists.
const upSubs = new Map<string, () => void>()
const terminalUpSubs = new Map<string, () => void>()

export function deliverTerminalUpLocal(machineId: string, packet: Uint8Array): void {
  const decoded = decodeTerminalHop(packet)
  if (!decoded || decoded.direction !== TerminalHopDirection.up) return
  const client = registry.clientsFor(machineId).find((candidate) => candidate.kind === 'web' && candidate.connId === decoded.connId)
  if (!client || client.socket.readyState !== WebSocket.OPEN) return
  try { client.socket.send(decoded.clientFrame) } catch { /* ignore */ }
}

/** Deliver an up-frame to every local client of the agent (device/exclude filters applied). Called both
 *  directly by the manager-ws 'up' handler (co-located fast-path) and from the Redis up subscription. */
export function deliverUpLocal(machineId: string, msg: UpBusMsg): void {
  const payload = JSON.stringify(msg.frame)
  const frameType = (msg.frame as { type?: string }).type
  // A device (commander) socket holds N machines at once (multi-attach) → tag the OUTER frame with its
  // machineId (= machineId) so the device can route/badge/pick-its-E2EE-key WITHOUT decrypting the payload.
  // The payload itself is untouched (stays E2EE-encrypted for remote machines). Web sockets re-attach per
  // agent (one machine at a time) so they never need it — keep their wire byte-identical. Computed lazily.
  let commanderPayload: string | null = null
  for (const c of registry.clientsFor(machineId)) {
    if (msg.excludeConnId && c.connId === msg.excludeConnId) continue
    // Device-targeted push (e.g. device_revoked): only the commander socket whose reported deviceId
    // matches. A socket that hasn't reported one (legacy fw / pre-hello) never matches — harmless.
    if (msg.targetDeviceId && c.deviceId !== msg.targetDeviceId) continue
    // Connection-targeted push (E2EE pairing/welcome + per-client encrypted RPC replies): only the
    // one web socket that owns this connId. Absent ⇒ normal fan-out.
    if (msg.targetConnId && c.connId !== msg.targetConnId) continue
    if (msg.targetKind && c.kind !== msg.targetKind) continue
    // A `targetConnId`-addressed frame is E2EE traffic for exactly ONE connection (pairing/welcome/rekey,
    // per-client encrypted RPC replies) — for a WEB browser OR a hardware device. It bypasses the
    // kind/eligibility/`_result` filters below: those trim the broadcast fan-out, but a connId-targeted
    // frame is not a broadcast. Without this, `e2e_status_result` etc. never reach a paired device
    // (commanders are filtered by `!commanderEligible` and by the `_result` suppression).
    if (!msg.targetConnId) {
      if (c.kind === 'web' && msg.webEligible === false) continue        // device-only frame (forwardToCommander)
      if (c.kind === 'commander' && !msg.commanderEligible) continue     // preserve COMMANDER_FORWARD filter
      // RPC replies (`<x>_result`) are answered to the device directly by deviceWs (trimmed); the
      // raw node reply must never reach a device — it's only for the backend nodeRequest awaiter / web.
      if (c.kind === 'commander' && typeof frameType === 'string' && frameType.endsWith('_result')) continue
    }
    // Commander gets the machineId-tagged frame; web gets the untagged one.
    const out = c.kind === 'commander'
      ? (commanderPayload ??= JSON.stringify({ ...(msg.frame as Record<string, unknown>), machineId: machineId }))
      : payload
    if (c.kind === 'commander' && registry.queueCommanderFrame(machineId, c.connId, msg.frame, out)) continue
    if (c.socket.readyState === WebSocket.OPEN) {
      try { c.socket.send(out) } catch { /* ignore */ }
    }
  }
}

/**
 * Push a `device_revoked` frame to the ONE just-revoked device so it wipes its pairing and reboots to
 * the pair screen. Targeted by deviceId (set on the ClientConn from device_hello), so sibling devices of
 * the same agent are untouched. Published to up:{machineId} → every instance delivers, but the
 * targetDeviceId filter in deliverUpLocal means only the instance holding that socket actually sends it.
 */
export function pushDeviceRevoked(machineId: string, deviceId: string): void {
  void publishUp(machineId, {
    webEligible: false,
    commanderEligible: true,
    targetDeviceId: deviceId,
    frame: { type: 'device_revoked' },
  })
}

/**
 * Publish this instance's local client counts and make the node's `__clients` frame reflect the GLOBAL
 * total. `registry.clientCounts` is per-process, so a naive publish would let another instance's snapshot
 * clobber ours at the node (last-writer-wins). Instead: write our field to Redis, then have exactly ONE
 * writer — B_m, the instance holding this agent's manager control socket — emit the summed frame in-order
 * over that socket. If we're not B_m, poke B_m (via down:{machineId}, whose sole subscriber IS B_m).
 * Call after the local registry mutation (attach/detach) so clientCounts reflects the new state.
 */
export async function sendClientsControl(machineId: string, commanderJoined = false): Promise<void> {
  const { ui, commander, commanderActive } = registry.clientCounts(machineId) // capture sync (post-mutation), before await
  await setAgentClientCount(machineId, INSTANCE_ID, ui, commander, commanderActive)
  // Count snapshots can coalesce (1→0→1 may be observed as 1→1). Persist a separate join generation so
  // every real commander attach still forces the node/adapter to replay its live state.
  if (commanderJoined) await bumpCommanderJoinGeneration(machineId)
  if (registry.controlSocketFor(machineId)) { await recomputeAndSendClients(machineId); return }
  void publishDown(machineId, { connId: '', frame: { type: CLIENTS_DIRTY } })
}

/** B_m-only: read the cross-instance total and emit `__clients` down the local manager control socket
 *  (single in-order writer → the node's last frame is always the true global state). */
export async function recomputeAndSendClients(machineId: string): Promise<void> {
  const [{ ui, commander, commanderActive }, commanderJoinGeneration] = await Promise.all([
    getAgentClientTotals(machineId),
    getCommanderJoinGeneration(machineId),
  ])
  const frame = {
    type: CLIENTS_FRAME,
    payload: { ui, commander, commanderActive, ...(commanderJoinGeneration != null ? { commanderJoinGeneration } : {}) },
  }
  const local = registry.controlSocketFor(machineId)
  if (local && local.readyState === WebSocket.OPEN) {
    try { local.send(JSON.stringify({ t: 'down', machineId: machineId, connId: '', frame })) } catch { /* ignore */ }
    return
  }
  // B_m's control socket briefly gone (mid-failover) → best-effort via Redis (sole subscriber is B_m).
  void publishDown(machineId, { connId: '', frame })
}

export interface HubClient {
  connId: string
  /** Send a client→node message (chat/control). */
  sendDown: (frame: Frame) => void
  /** Send an opaque E2EE terminal input frame over the binary relay. */
  sendTerminalDown: (clientFrame: Uint8Array) => void
  /** Mark this client as the actively-rendered machine (commander multi-attach) → re-emits `__clients` with
   *  the updated `commanderActive` count so the node/adapter can gate full-stream cards. No-op if unchanged. */
  setActive: (active: boolean) => void
  /** Call on socket close/error. */
  detach: () => void
}

type Alive = WebSocket & {
  __hubLastAlive?: number
  __hubLastPing?: number
  __hubDeadlineMs?: number
  __hubLivenessWired?: boolean
}

// Liveness is a DEADLINE ON SILENCE, not a count of sweeps. Counting tied how fast a dead peer is noticed
// to how often we ping, so making detection quicker also meant pinging every client harder. Splitting the
// two lets the tick be short (prompt detection, no 25s rounding) while each socket keeps its own patience.
/** How often liveness is evaluated. Cheap — it only walks local sockets. */
export const LIVENESS_TICK_MS = 5_000
/** Silence tolerated from a BROWSER. It cannot ping on its own, sits behind proxies/LBs, and a tab in a
 *  background window gets throttled — so it keeps the long-standing generous window. */
export const CLIENT_IDLE_DEADLINE_MS = 75_000
/** Silence tolerated from a DEVICE. The firmware opens the socket with `ping_interval_sec = 15`
 *  (apps/esp32-circle/main/commander_client.c), so it proves itself every 15s without us asking. Two missed
 *  device pings is already conclusive; waiting out the browser-sized window just left the web showing a
 *  green dot for a device that had been unplugged for over a minute. */
export const DEVICE_IDLE_DEADLINE_MS = 35_000

/** Wire the once-per-socket liveness listeners. Any inbound frame proves the peer and path are alive:
 *  application messages (including device PCM chunks) and peer ping frames count as well as pong, so a
 *  delayed control-frame pong cannot terminate a socket that is actively sending data. */
function wireLiveness(socket: WebSocket): void {
  if ((socket as Alive).__hubLivenessWired) return
  ;(socket as Alive).__hubLivenessWired = true
  const markAlive = (): void => { (socket as Alive).__hubLastAlive = Date.now() }
  socket.on('message', markAlive)
  socket.on('ping', markAlive)
  socket.on('pong', markAlive)
}

// Sockets that must be kept alive even while they hold ZERO hub clients: a device socket only enters the
// client registry once it attaches to a machine (deviceWs.attachCommander), and a web socket parked on
// the Machines page has no agent selected. Neither was reachable by a registry-driven sweep, so a
// half-open drop (WiFi cut / power loss, no FIN) left 'close' unfired forever — presence key refreshed on
// a timer, MQTT bridge held, web dot green. Tracked sockets ride the SAME sweep, so policy lives in one
// place instead of each endpoint growing its own heartbeat.
const trackedSockets = new Set<WebSocket>()

/** Keep `socket` in the liveness sweep regardless of hub-client attachment, with an optional custom
 *  silence deadline (the deadline is stored ON the socket, so it still applies once clients attach).
 *  Returns the release fn. */
export function trackSocketLiveness(socket: WebSocket, deadlineMs?: number): () => void {
  ;(socket as Alive).__hubLastAlive ??= Date.now()
  if (deadlineMs != null) (socket as Alive).__hubDeadlineMs = deadlineMs
  wireLiveness(socket)
  trackedSockets.add(socket)
  return () => { trackedSockets.delete(socket) }
}

/** Ping the socket, or terminate it once it has been silent past its deadline. Returns false when the
 *  socket is not OPEN — the caller decides what that means for the thing holding it. */
function pingOrTerminate(ws: Alive, info: Record<string, unknown>): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false
  const now = Date.now()
  const deadline = ws.__hubDeadlineMs ?? CLIENT_IDLE_DEADLINE_MS
  const idleMs = now - (ws.__hubLastAlive ??= now)
  if (idleMs >= deadline) {
    logger.warn('hub client heartbeat timed out', { ...info, idleMs, deadline })
    try { ws.terminate() } catch { /* ignore */ }
    return true
  }
  // Three chances to answer inside the window, so a single lost control frame is never fatal.
  const pingEvery = Math.max(LIVENESS_TICK_MS, Math.floor(deadline / 3))
  if (now - (ws.__hubLastPing ?? 0) >= pingEvery) {
    ws.__hubLastPing = now
    try { ws.ping() } catch { /* ignore */ }
  }
  return true
}

// Liveness sweep. Deliberately separate from the count refresh below: this one wants to run often (a
// deadline you only check every 25s is really a deadline plus up to 25s), while the Redis writes down
// there must NOT get 5× more frequent.
setInterval(() => {
  // Evaluate each SOCKET once per tick. Under device multi-attach ONE socket backs N commander
  // ClientConns (one per machine), so a per-client loop would ping the same socket N times a tick.
  const swept = new Set<WebSocket>()
  const clients = registry.allClients()
  const orphaned = new Set<WebSocket>() // closed sockets whose clients were never detached
  for (const c of clients) {
    const ws = c.socket as Alive
    if (swept.has(ws)) continue
    swept.add(ws)
    if (!pingOrTerminate(ws, { machineId: c.machineId, kind: c.kind, connId: c.connId })) orphaned.add(ws)
  }
  // Sockets kept alive on their own (a device holding no machine, a web tab with no agent selected).
  for (const ws of trackedSockets) {
    if ((ws as Alive).readyState !== WebSocket.OPEN) { trackedSockets.delete(ws); continue }
    if (swept.has(ws)) continue
    swept.add(ws)
    pingOrTerminate(ws as Alive, { kind: 'tracked' })
  }
  // A ClientConn on an already-CLOSED socket means its 'close' handler never ran (it was wired after the
  // socket died). Nothing else would ever remove it, while the count refresh keeps re-publishing it — so
  // an adapter/node would hold a ghost commander forever (recap warm, cards streamed to nobody).
  for (const c of clients) {
    if (!orphaned.has(c.socket)) continue
    logger.warn('hub reaping client on a closed socket', { machineId: c.machineId, kind: c.kind, connId: c.connId })
    detachConn(c.machineId, c.connId)
  }
}, LIVENESS_TICK_MS).unref?.()

// Client-count upkeep. Cadence is bound to the Redis field TTL, NOT to how fast a dead peer is noticed.
export const CLIENT_HEARTBEAT_MS = 25_000
setInterval(() => {
  // Refresh this instance's client-count fields (25s < 45s TTL) so an idle client isn't garbage-collected
  // out of the global total. A crashed instance simply stops refreshing → its fields expire.
  for (const machineId of registry.localAgentIds()) {
    const { ui, commander, commanderActive } = registry.clientCounts(machineId)
    void setAgentClientCount(machineId, INSTANCE_ID, ui, commander, commanderActive)
  }
  // B_m periodic resync: re-emit the summed `__clients` for every agent whose control socket lives
  // here. Field EXPIRY (a client-holding instance crashed — its fields age out of the hash after 45s)
  // has no attach/detach event to poke a recompute, so without this the node keeps the ghost count
  // forever (brain recap stays warm for a device that's gone). Receivers apply the absolute value
  // idempotently, so re-sending an unchanged count is a no-op — and doubles as self-heal for any
  // `__clients` frame lost to a pub/sub drop. Converges ≤ TTL(45s) + sweep(25s).
  for (const machineId of registry.controlAgentIds()) {
    void recomputeAndSendClients(machineId)
  }
}, CLIENT_HEARTBEAT_MS).unref?.()

/** Register a client socket into the hub. The caller still owns the socket's 'message' handler. */
export function attachHubClient(socket: WebSocket, machineId: string, kind: ClientKind): HubClient {
  const connId = randomUUID()
  ;(socket as Alive).__hubLastAlive = Date.now()
  // Wired ONCE per socket because a web socket re-attaches on every agent switch. Note this does NOT
  // touch __hubDeadlineMs: a device sets its own (shorter) deadline before any machine attaches.
  wireLiveness(socket)
  const first = registry.addClient({ connId, machineId, kind, socket })

  if (first) {
    void subscribeUp(machineId, (msg) => {
      // Skip our OWN publish looping back — the manager-ws 'up' handler already delivered to local
      // clients directly before publishing (only remote instances need the Redis copy).
      if (msg.originPid === registry.PROCESS_ID) return
      deliverUpLocal(machineId, msg)
    })
      .then((unsub) => {
        // Drop this subscription instead of publishing it when either:
        //  - every client left while the Redis SUBSCRIBE was in flight, or
        //  - another attach already owns this agent's slot. Overwriting there would orphan the
        //    incumbent's unsub handle, leaving TWO callbacks on up:{machineId} forever — every frame
        //    would then fan out twice (each streamed delta rendered twice in the UI).
        // A detach→re-attach inside the pending window (webWs.bindAgent does exactly that on every
        // agent switch) makes this race routine, not theoretical.
        if (registry.clientsFor(machineId).length === 0 || upSubs.has(machineId)) unsub()
        else upSubs.set(machineId, unsub)
      })
      .catch(() => { /* logged in bus */ })
    void subscribeTerminalUp(machineId, (packet) => deliverTerminalUpLocal(machineId, packet))
      .then((unsub) => {
        if (registry.clientsFor(machineId).length === 0 || terminalUpSubs.has(machineId)) unsub()
        else terminalUpSubs.set(machineId, unsub)
      })
      .catch(() => { /* logged in bus */ })
  }
  void sendClientsControl(machineId, kind === 'commander')

  const sendDown = (frame: Frame): void => {
    // Fast-path: if THIS instance holds the agent's control manager socket (co-located), send the
    // down frame straight to it — no Redis. Local delivery is guaranteed reachable (socket open).
    const local = registry.controlSocketFor(machineId)
    if (local && local.readyState === WebSocket.OPEN) {
      try { local.send(JSON.stringify({ t: 'down', machineId: machineId, connId, frame })) } catch { /* ignore */ }
      return
    }
    // publishDown returns the Redis subscriber count. 0 = no backend holds this agent's manager
    // socket right now (node offline, or a mid-failover gap where B_m crashed and the manager hasn't
    // re-registered on a new instance) → the message was NOT delivered. Tell the client so it flips
    // offline instead of showing a stale-green while messages are silently dropped.
    void routeDown(machineId, { connId, frame }, () => publishDown(machineId, { connId, frame })).then((n) => {
      // HANDLED_IN_PROCESS = a provider machine, which has no socket to count. Only a real zero
      // means "nobody holds this machine right now".
      if (n === 0 && socket.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify({ type: 'node_status', payload: { online: false, reason: 'unreachable' } })) } catch { /* ignore */ }
      }
    }).catch(() => { /* ignore */ })
  }

  return {
    connId,
    sendDown,
    sendTerminalDown: (clientFrame: Uint8Array) => {
      const packet = encodeTerminalHop(TerminalHopDirection.down, connId, clientFrame)
      if (!packet) return
      void publishTerminalDown(machineId, packet).then((subscribers) => {
        if (subscribers === 0 && socket.readyState === WebSocket.OPEN) {
          try { socket.send(JSON.stringify({ type: 'terminal_transport_error', payload: { code: 'TERMINAL_UNREACHABLE' } })) } catch { /* ignore */ }
        }
      }).catch(() => { /* ignore */ })
    },
    setActive: (active: boolean) => {
      if (registry.setClientActive(machineId, connId, active)) void sendClientsControl(machineId)
    },
    detach: () => {
      // The Harness owns per-connection E2EE state and terminal controller
      // leases. Aggregate __clients counts cannot identify which connId left,
      // so send an authoritative backend-only teardown frame before removing
      // the route. This makes a real transport drop release the lease promptly
      // instead of waiting for the 30-second heartbeat expiry.
      sendDown({ type: '__client_disconnected', payload: {} })
      detachConn(machineId, connId)
    },
  }
}

/** Remove one client and republish the count. Dropping the LAST client for an agent also releases its
 *  `up:{machineId}` subscription — the heartbeat reaper needs the same teardown, so it lives here rather
 *  than inside the HubClient closure. */
function detachConn(machineId: string, connId: string): void {
  const last = registry.removeClient(machineId, connId)
  if (last) {
    const unsub = upSubs.get(machineId)
    if (unsub) { unsub(); upSubs.delete(machineId) }
    const terminalUnsub = terminalUpSubs.get(machineId)
    if (terminalUnsub) { terminalUnsub(); terminalUpSubs.delete(machineId) }
  }
  void sendClientsControl(machineId)
}
