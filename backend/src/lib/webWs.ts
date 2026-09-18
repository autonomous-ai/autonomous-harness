/**
 * Backend hub — web client terminating endpoint (`/api/web-ws`).
 *
 * Two auth modes share the path (the subprotocol carries the credential — browsers can't set WS headers):
 *
 *  - PER-USER (current): the subprotocol is the user's SSO access token → ONE socket per user.
 *    The socket starts UNATTACHED; the client scopes it with `machine_select {machineId}` (ownership-checked
 *    against `agentBinding.userId`), which detaches the previous hub client and attaches a fresh one
 *    (new connId — keeps the (agent, connId) invariant that E2EE and reply-targeting rely on). While
 *    attached, frames flow exactly like the legacy mode (sendDown / up:{machineId} fan-out). The socket
 *    also live-watches ALL the user's agents and pushes `machines_status` frames (node_status transitions
 *    tagged with machineId) so the Machines list stays live without REST polling.
 *
 *  - LEGACY (fallback): the subprotocol is an agent apiKey → the socket is bound to that ONE agent for
 *    its whole life. Kept for stale tabs running the old bundle during a rolling deploy. Collision-safe:
 *    a 64-hex apiKey is recognized before any SSO profile request, so agent keys are never sent to
 *    the external identity service.
 */
import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import { WebSocket, type RawData } from 'ws'
import { createWss, WS_LIMITS } from './wsServer.js'
import { extractKey } from '../utils/crypto.js'
import { machineIdFromKey } from '../utils/crypto.js'
import { prisma, machineAlive } from './prisma.js'
import { getAgentPresence, getAgentPresenceMany, subscribeStatus, getDevicePresence, subscribeDeviceStatus, subscribeDeviceMachineListChanged, subscribeDeviceE2eePair } from './bus.js'
import { attachHubClient, trackSocketLiveness, type HubClient } from './hub.js'
import { authenticateAccessToken, SsoAuthError, type AuthUser } from './ssoAuth.js'
import type { Frame } from './tunnel.js'
import { machineOnline } from './providerLink.js'
import { logger } from '../utils/logger.js'
import { fireAndForget } from '../utils/async.js'
import { guardedSendJson } from './wsSend.js'
import { createOrderedInbox } from './orderedInbox.js'
import { ensureMachineReady, getMachineLifecycleStatus, type MachineLifecycleStatus } from './machineLifecycle.js'
import type { Machine } from '@prisma/client'
import { machineBillingAllowsDataPlane } from './billingState.js'
import { parseAutonomousEnvironment, storedAutonomousEnvironment } from './autonomousEnvironment.js'
import {
  isEncryptedTerminalFrame,
  TERMINAL_DOWN_TYPES,
  TERMINAL_ENVELOPE_MAX_BYTES,
  terminalFrameBytes,
  terminalFrameNeedsWake,
  TerminalRateGuard,
} from './terminalRelay.js'
import { parseTerminalClientFrame, TerminalBinaryKind, TERMINAL_BINARY_CLIENT_UP_KINDS } from './terminalBinary.js'
import {
  isEncryptedP2pFrame,
  P2P_DOWN_TYPES,
  P2P_SIGNAL_MAX_BYTES,
  p2pFrameBytes,
  P2pSignalRateGuard,
  terminalP2pPolicy,
} from './p2pSignaling.js'
import { recordRemoteUsage } from './dailyTracking.js'

/**
 * Down-frames the backend mints for an adapter, which a web client must never be able to forge.
 *
 * The `__` prefix already marks most of these; these two predate that convention and are not
 * prefixed, so they fell through this handler's namespace checks into the verbatim forward at the
 * bottom. See the block in `handleFrame` for what each one does when forged.
 *
 * Senders, all backend-side: `lib/adapterWs.ts` (on connect) and `services/MachineService.ts`
 * (rename, revoke).
 */
export const BACKEND_ONLY_DOWN_TYPES = new Set(['machine_meta', 'machine_revoked'])

const wss = createWss(WS_LIMITS.web, { echoFirstProtocol: true })

// Device-status re-seed: covers the silent-offline case (worker crash → presence TTL 45s ages out
// with no transition published) — the watcher re-reads presence keys on this cadence.
const DEVICE_RESEED_MS = 30_000
// Trailing debounce for list re-derivations poked by machines_watch (see scheduleWatchAgents).
const WATCH_DEBOUNCE_MS = 250

/** HTTP upgrade hook for `/api/web-ws`. Subprotocol = SSO access token or legacy agent apiKey. */
export function handleWebUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const cred = extractKey(req)
  if (!cred) { socket.destroy(); return }

  // LEGACY per-agent mode: classify the fixed 64-hex key first so it is never sent to SSO.
  if (/^[a-f0-9]{64}$/i.test(cred)) {
    const machineId = machineIdFromKey(cred)
    void (async () => {
      const binding = await prisma.machine.findUnique({ where: { machineId: machineId } })
      if (!binding || binding.deletedAt || !machineBillingAllowsDataPlane(binding)) { socket.destroy(); return }
      wss.handleUpgrade(req, socket, head, (ws) => attachWebClient(ws, machineId))
    })().catch((err) => { logger.warn('web-ws legacy upgrade failed', { error: String(err) }); socket.destroy() })
    return
  }

  // PER-USER mode: profile validation is async, so authenticate before completing the upgrade.
  void (async () => {
    try {
      const requestedEnvironment = parseAutonomousEnvironment(
        new URL(req.url ?? '/api/web-ws', 'http://backend.local').searchParams.get('autonomousEnv'),
      )
      const user = await authenticateAccessToken(cred, requestedEnvironment)
      if (socket.destroyed) return
      wss.handleUpgrade(req, socket, head, (ws) => attachUserClient(ws, user))
    } catch (err) {
      if (socket.destroyed) return
      const invalid = err instanceof SsoAuthError && err.code === 'INVALID_TOKEN'
      const mismatch = err instanceof SsoAuthError &&
        (err.code === 'AUTONOMOUS_ENV_MISMATCH' || err.code === 'AUTONOMOUS_ENV_NOT_ALLOWED')
      const code = invalid ? 4401 : mismatch ? 4403 : 1013
      const reason = invalid
        ? 'auth expired'
        : mismatch
          ? `env:${err.requiredEnv ?? 'prod'}`
          : 'auth service unavailable'
      wss.handleUpgrade(req, socket, head, (ws) => { try { ws.close(code, reason) } catch { /* ignore */ } })
    }
  })().catch((err) => { logger.warn('web-ws upgrade failed', { error: String(err) }); socket.destroy() })
}

/** PER-USER socket: starts unattached; `machine_select` scopes it to one owned machine at a time. */
function attachUserClient(ws: WebSocket, user: AuthUser): void {
  let client: HubClient | null = null
  let currentAgentId: string | null = null
  let currentBinding: Machine | null = null
  let closed = false
  // Monotonic guards: async lookups from two rapid selects (or watch refreshes) must not finish
  // out of order and leave the socket bound to the older target.
  let selectGen = 0
  let watchGen = 0
  const terminalRate = new TerminalRateGuard()
  const p2pSignalRate = new P2pSignalRateGuard()

  const send = (obj: unknown): boolean => guardedSendJson(ws, obj, 'must', { userId: user.sub })
  logger.info('web user connected', { userId: user.sub })
  send({ type: 'connected', payload: { userId: user.sub } })

  // No daily-presence write here. This socket is not the person: the desktop app never dials it (the
  // local daemon does, one per FOREIGN machine it relays), so counting upgrades measured relay
  // reconnects and missed every single-machine user. `user_daily_presence` is fed by the app's own
  // `app_presence` ping through the daemon's adapter-ws instead (lib/adapterWs.ts).

  // An unattached socket (user parked on the Machines page, no agent selected) holds no hub client, so a
  // registry-driven sweep can't see it — it would be killed by LB idle timeouts, or never reaped when
  // dead. This used to be a second heartbeat loop here, carefully disabled while attached so the two
  // sweeps couldn't race; the hub now tracks the socket itself, which is one sweep for both states.
  const releaseLiveness = trackSocketLiveness(ws)

  // ── Live Machines-list feed ──────────────────────────────────────────────────────────────────
  // Subscribe node_status for EVERY agent the user owns and forward it tagged with the machineId (the
  // raw node_status frame doesn't carry one). Re-armed via `machines_watch` (sent after create/delete).
  // The agent set is ALWAYS re-derived from the DB — the client never supplies it.
  const statusSubs = new Map<string, () => void>()
  const sendStatuses = (statuses: Array<{ machineId: string; online: boolean; status?: MachineLifecycleStatus; reason?: string }>): void => {
    if (ws.readyState !== WebSocket.OPEN || statuses.length === 0) return
    send({ type: 'machines_status', payload: { statuses } })
  }
  const watchAgents = async (): Promise<void> => {
    const gen = ++watchGen
    const bindings = await prisma.machine.findMany({
      where: { userId: user.sub, autonomousEnv: user.autonomousEnv, ...machineAlive },
      select: { machineId: true, billingStatus: true },
    })
    if (gen !== watchGen || closed) return // superseded / socket gone
    const wanted = new Set(bindings.filter(machineBillingAllowsDataPlane).map((b) => b.machineId))
    for (const [id, unsub] of statusSubs) {
      if (!wanted.has(id)) { unsub(); statusSubs.delete(id) } // agent deleted
    }
    for (const id of wanted) {
      if (statusSubs.has(id)) continue
      // `status:{machineId}` carries only node_status / machine_app_status transitions — not the
      // machine's whole turn stream, which is what subscribing `up:` here used to pull in for every
      // machine the user owns, whether or not anyone was looking at it.
      const unsub = await subscribeStatus(id, (frame) => {
        const f = frame as { type?: string; payload?: { online?: boolean; status?: MachineLifecycleStatus; reason?: string } }
        if (f?.type === 'node_status') {
          sendStatuses([{ machineId: id, online: f.payload?.online === true, ...(f.payload?.status ? { status: f.payload.status } : {}), ...(f.payload?.reason ? { reason: f.payload.reason } : {}) }])
        }
      })
      if (closed || gen !== watchGen) { unsub(); return } // raced a close / newer watch reconciles
      statusSubs.set(id, unsub)
    }
    // Seed the full current picture (presence keys = source of truth) so the list is right immediately.
    // One MGET for every presence key, not one GET per machine.
    const ids = [...wanted]
    const presence = await getAgentPresenceMany(ids)
    const statuses = await Promise.all(
      ids.map(async (id) => {
        // Same assertion as the per-agent seeds: a provider machine has no presence key and is always
        // online, so reading presence alone would list it as offline on the machine cards too.
        const online = await machineOnline(id, !!presence.get(id))
        const lifecycle = online ? 'running' : await getMachineLifecycleStatus(id)
        return { machineId: id, online, status: lifecycle === 'unknown' ? 'offline' as const : lifecycle }
      }),
    )
    if (gen === watchGen && !closed) sendStatuses(statuses)
  }
  // A machine create/rename/delete pokes every open tab of the user at once (`machines_changed` +
  // the client's `machines_watch` reply); several in a row (a bulk rename) must not re-derive the
  // list each time. Trailing debounce: the last poke wins, ≤250ms later.
  let watchAgentsTimer: NodeJS.Timeout | null = null
  const scheduleWatchAgents = (): void => {
    if (watchAgentsTimer) clearTimeout(watchAgentsTimer)
    watchAgentsTimer = setTimeout(() => {
      watchAgentsTimer = null
      if (closed) return
      void watchAgents().catch((err) => logger.warn('web-ws watchAgents failed', { userId: user.sub, error: String(err) }))
    }, WATCH_DEBOUNCE_MS)
  }
  void watchAgents().catch((err) => logger.warn('web-ws watchAgents failed', { userId: user.sub, error: String(err) }))

  // ── Live device-status feed (mirror of watchAgents; per-DEVICE statuses over one per-user sub) ──
  // Transitions ride the user-scoped `devstatus:{userId}` channel (deviceWs publishes on connect/
  // disconnect), so a device paired AFTER the watch armed still reports without re-deriving the set.
  // The 30s re-seed poll covers the silent case: a worker holding a device socket crashes → nobody
  // publishes offline, the presence key just ages out (TTL 45s) — the poll notices within ~30s.
  const sendDeviceStatuses = (statuses: Array<{ deviceId: string; online: boolean; lastSeenAt?: string | null }>): void => {
    if (ws.readyState !== WebSocket.OPEN || statuses.length === 0) return
    send({ type: 'devices_status', payload: { statuses } })
  }
  let deviceStatusUnsub: (() => void) | null = null
  let deviceSeedTimer: NodeJS.Timeout | null = null
  const seedDeviceStatuses = async (): Promise<void> => {
    const rows = await prisma.deviceBinding.findMany({ where: { userId: user.sub }, select: { deviceId: true, lastSeenAt: true } })
    if (closed) return
    const statuses = await Promise.all(
      rows.map(async (d) => ({ deviceId: d.deviceId, online: await getDevicePresence(d.deviceId), lastSeenAt: d.lastSeenAt?.toISOString() ?? null })),
    )
    if (!closed) sendDeviceStatuses(statuses)
  }
  const watchDevices = async (): Promise<void> => {
    if (!deviceStatusUnsub) {
      deviceStatusUnsub = await subscribeDeviceStatus(user.sub, (msg) => {
        sendDeviceStatuses([{ deviceId: msg.deviceId, online: msg.online === true, ...(msg.lastSeenAt ? { lastSeenAt: msg.lastSeenAt } : {}) }])
      })
      if (closed) { deviceStatusUnsub(); deviceStatusUnsub = null; return }
    }
    if (!deviceSeedTimer) {
      deviceSeedTimer = setInterval(() => {
        void seedDeviceStatuses().catch(() => { /* ignore */ })
      }, DEVICE_RESEED_MS)
    }
    await seedDeviceStatuses()
  }
  void watchDevices().catch((err) => logger.warn('web-ws watchDevices failed', { userId: user.sub, error: String(err) }))

  // ── Live machine-LIST invalidation ─────────────────────────────────────────────────────────────
  // The `devmachines:{userId}` channel (despite the device-era name) is the per-user "machine list
  // changed" bus: create/delete/rename publish here from whatever worker served the REST call.
  // Forward it as `machines_changed` so every open tab re-fetches the list (names stay in sync
  // across tabs without F5).
  let machineListUnsub: (() => void) | null = null
  void (async () => {
    machineListUnsub = await subscribeDeviceMachineListChanged(user.sub, (msg) => {
      if (ws.readyState !== WebSocket.OPEN) return
      if (msg.reason === 'environment_changed' && msg.autonomousEnv && msg.autonomousEnv !== user.autonomousEnv) {
        try { ws.close(4403, `env:${msg.autonomousEnv}`) } catch { /* ignore */ }
        return
      }
      send({ type: 'machines_changed', payload: { reason: msg.reason } })
    })
    if (closed) { machineListUnsub(); machineListUnsub = null }
  })().catch((err) => logger.warn('web-ws machine-list watch failed', { userId: user.sub, error: String(err) }))

  // ── User-level E2EE device-pair requests ─────────────────────────────────────────────────────
  // Not tied to current machine selection: any logged-in page can receive the notice, then the frontend
  // checks whether this browser already trusts the target machine before showing the global popup.
  let deviceE2eePairUnsub: (() => void) | null = null
  void (async () => {
    deviceE2eePairUnsub = await subscribeDeviceE2eePair(user.sub, (msg) => {
      if (ws.readyState !== WebSocket.OPEN) return
      const { kind, ...payload } = msg
      const type = kind === 'cleared' ? 'device_e2ee_pair_cleared' : 'device_e2ee_pair_pending'
      send({ type, payload })
    })
    if (closed) { deviceE2eePairUnsub(); deviceE2eePairUnsub = null }
  })().catch((err) => logger.warn('web-ws device-e2ee-pair watch failed', { userId: user.sub, error: String(err) }))

  // ── Agent selection ──────────────────────────────────────────────────────────────────────────
  const ack = (machineId: string): void => {
    send({
      type: 'connected',
      payload: { machineId: machineId, p2p: terminalP2pPolicy(user.sub, machineId) },
    })
    // Authoritative node-liveness for the newly-scoped agent (same seed the legacy mode sends).
    fireAndForget((async () => {
      const mgr = await getAgentPresence(machineId)
      if (ws.readyState !== WebSocket.OPEN || currentAgentId !== machineId) return
      const online = await machineOnline(machineId, !!mgr)
      const lifecycle = await getMachineLifecycleStatus(machineId)
      if (ws.readyState !== WebSocket.OPEN || currentAgentId !== machineId) return
      send({ type: 'node_status', payload: { online, status: online ? 'running' : lifecycle === 'unknown' ? 'offline' : lifecycle } })
    })(), 'web-ws seed node_status', { userId: user.sub, machineId })
  }
  const bindAgent = async (machineIdRaw: unknown): Promise<void> => {
    if (typeof machineIdRaw !== 'string' || !machineIdRaw) return
    const machineId = machineIdRaw
    const gen = ++selectGen
    const binding = await prisma.machine.findUnique({ where: { machineId: machineId } })
    if (closed || gen !== selectGen) return // superseded by a newer select
    if (!binding || binding.deletedAt || binding.userId !== user.sub) {
      logger.warn('machine_select rejected', { userId: user.sub, machineId })
      send({ type: 'machine_select_error', payload: { machineId: machineId, error: 'NOT_YOUR_MACHINE' } })
      return
    }
    if (storedAutonomousEnvironment(binding.autonomousEnv) !== user.autonomousEnv) {
      logger.warn('machine_select environment rejected', { userId: user.sub, machineId, autonomousEnv: user.autonomousEnv })
      send({ type: 'machine_select_error', payload: { machineId: machineId, error: 'MACHINE_ENV_MISMATCH' } })
      return
    }
    if (binding.billingStatus === 'pending') {
      send({ type: 'machine_select_error', payload: { machineId: machineId, error: 'MACHINE_PAYMENT_PENDING' } })
      return
    }
    if (binding.billingStatus === 'suspended') {
      send({ type: 'machine_select_error', payload: { machineId: machineId, error: 'MACHINE_SUBSCRIPTION_REQUIRED' } })
      return
    }
    try {
      await ensureMachineReady(binding)
    } catch (err) {
      if (!closed && gen === selectGen) {
        const code = err instanceof Error && 'code' in err ? String((err as { code?: unknown }).code) : 'MACHINE_START_FAILED'
        send({ type: 'machine_select_error', payload: { machineId: machineId, error: code } })
      }
      return
    }
    if (closed || gen !== selectGen) return
    // Idempotent same-agent re-select keeps the connId, but still passed through ensureMachineReady so
    // selecting a deliberately stopped machine wakes it before the readiness ack.
    if (client && machineId === currentAgentId) { currentBinding = binding; ack(machineId); return }
    client?.detach()
    client = attachHubClient(ws, machineId, 'web')
    currentAgentId = machineId
    currentBinding = binding
    logger.info('web user selected agent', { userId: user.sub, machineId, connId: client.connId })
    ack(machineId)
  }

  // Presence, remembered briefly. Every non-terminal frame used to cost one Redis GET on the hot path;
  // the key itself has a 30s TTL, so a 2s memory of "it was there" is well inside its own staleness.
  // Only a POSITIVE answer is cached — an absent key must keep triggering the wake path.
  const PRESENCE_MEMORY_MS = 2_000
  let presenceSeen: { machineId: string; at: number } | null = null
  const presentRecently = async (machineId: string): Promise<boolean> => {
    const now = Date.now()
    if (presenceSeen && presenceSeen.machineId === machineId && now - presenceSeen.at < PRESENCE_MEMORY_MS) return true
    const present = !!(await getAgentPresence(machineId))
    presenceSeen = present ? { machineId, at: now } : null
    return present
  }

  const handleFrame = async (frame: Frame): Promise<void> => {
    const type = frame.type as string | undefined
    // Double-underscore frames are backend-to-Harness control messages. A web
    // client must never be able to forge its own lifecycle notification.
    if (typeof type === 'string' && type.startsWith('__')) return
    // ⚠️ Same rule, for the two control frames that are NOT `__`-prefixed and so escaped it. Anything
    // reaching this handler holds a valid access token for the account and nothing more, while the
    // frames below are instructions the adapter obeys as the backend's own — everything else here
    // falls through to `client.sendDown(frame)`, which forwards verbatim:
    //   - `machine_meta` names the account's private grid, i.e. the inference endpoint every agent on
    //     that computer is then pointed at. Forged, it redirects the account's work.
    //   - `machine_revoked` makes the adapter clear its stored session and exit.
    // Both are minted here (`adapterWs.ts`, `services/MachineService.ts`); no client in this
    // repository sends either, so refusing them costs nothing. The adapter refuses them from
    // non-backend transports too (`cli/src/backendSocket.ts`, BACKEND_ONLY_DOWN_TYPES) — but it
    // cannot tell a frame the backend decided on from one the backend relayed for a web client, so
    // that check alone does not cover this path. This is where that distinction still exists.
    if (typeof type === 'string' && BACKEND_ONLY_DOWN_TYPES.has(type)) return
    const isTerminal = typeof type === 'string' && TERMINAL_DOWN_TYPES.has(type)
    const terminalNamespace = typeof type === 'string' && type.startsWith('terminal_')
    if (terminalNamespace && !isTerminal) {
      send({ type: 'terminal_transport_error', payload: { code: 'TERMINAL_TYPE_REJECTED' } })
      return
    }
    if (isTerminal) {
      const bytes = terminalFrameBytes(frame)
      if (bytes > TERMINAL_ENVELOPE_MAX_BYTES || !isEncryptedTerminalFrame(frame) || !terminalRate.allow(type!, bytes)) {
        send({ type: 'terminal_transport_error', payload: { code: 'TERMINAL_FRAME_REJECTED' } })
        return
      }
    }
    const p2pNamespace = typeof type === 'string' && type.startsWith('p2p_')
    const isP2pSignal = typeof type === 'string' && P2P_DOWN_TYPES.has(type)
    if (type === 'p2p_result') {
      const payload = (frame.payload ?? {}) as Record<string, unknown>
      const outcome = typeof payload.outcome === 'string' ? payload.outcome : ''
      const allowed = new Set(['direct', 'timeout', 'failed', 'dropped', 'relay'])
      if (client && currentBinding && allowed.has(outcome)) {
        const setupMs = Number(payload.setupMs)
        logger.info('terminal p2p result', {
          userId: user.sub,
          machineId: currentBinding.machineId,
          outcome,
          ...(Number.isFinite(setupMs) && setupMs >= 0 && setupMs <= 60_000 ? { setupMs: Math.round(setupMs) } : {}),
          ...(typeof payload.reason === 'string' ? { reason: payload.reason.slice(0, 64) } : {}),
        })
      }
      return
    }
    if (p2pNamespace && !isP2pSignal) {
      send({ type: 'p2p_transport_error', payload: { code: 'P2P_TYPE_REJECTED' } })
      return
    }
    if (isP2pSignal) {
      const bytes = p2pFrameBytes(frame)
      const policyEnabled = currentBinding
        ? terminalP2pPolicy(user.sub, currentBinding.machineId).enabled
        : false
      if (!policyEnabled || bytes > P2P_SIGNAL_MAX_BYTES
        || !isEncryptedP2pFrame(frame) || !p2pSignalRate.allow(bytes)) {
        send({ type: 'p2p_transport_error', payload: { code: 'P2P_SIGNAL_REJECTED' } })
        return
      }
      // Remote-usage signal: a p2p_offer actually starts a new p2p session (vs. the ICE/abort
      // frames that follow one), so it's the one point that means "used remote to stream terminal".
      if (type === 'p2p_offer' && currentBinding) {
        recordRemoteUsage(user.sub, currentBinding.machineId, new Date())
          .catch((err) => logger.warn('remote usage tracking failed', { userId: user.sub, machineId: currentBinding?.machineId, error: String(err) }))
      }
    }
    if (type === 'machine_select') {
      const machineId = (frame.payload as { machineId?: unknown } | undefined)?.machineId
      await bindAgent(machineId)
      return
    }
    if (type === 'machine_deselect') {
      selectGen++ // cancel any in-flight bindAgent
      client?.detach()
      client = null
      currentAgentId = null
      currentBinding = null
      return
    }
    if (type === 'machines_watch') {
      scheduleWatchAgents()
      return
    }
    if (type === 'devices_watch') {
      void watchDevices().catch(() => { /* logged above */ })
      return
    }
    if (client && currentBinding) {
      // A selected machine can idle-stop while the tab remains open. Turn-producing messages always
      // refresh the wake lease; other frames wake only when presence says the node is down.
      try {
        if ((isTerminal && terminalFrameNeedsWake(type!)) || (!isTerminal && (type === 'message' || !(await presentRecently(currentBinding.machineId))))) {
          await ensureMachineReady(currentBinding)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Machine could not be started'
        send({ type: 'error', payload: { message } })
        return
      }
      client.sendDown(frame)
      return
    }
    // No agent selected: fast-fail RPCs (echo the requestId) so wsClient.request doesn't burn its
    // 20s timeout; drop fire-and-forget frames.
    const requestId = (frame.payload as { requestId?: unknown } | undefined)?.requestId
    if (typeof requestId === 'string' && typeof type === 'string') {
      send({ type: `${type}_result`, payload: { requestId, error: 'NO_MACHINE_SELECTED' } })
    }
  }

  // STRICT in-order frame processing. `bindAgent` awaits a DB lookup; without this chain a frame
  // arriving in that gap (the web sends `agent_select` then its RPCs back-to-back) would be routed
  // by the PREVIOUS selection's client — an agent-switch could leak the old agent's projects/replies
  // into the new view, or lose the RPC entirely. The chain makes every frame wait for the frames
  // (incl. selects) before it, restoring the single-socket ordering guarantee end-to-end.
  // Bounded (see orderedInbox.ts): past the ceiling a frame is refused and answered right away.
  let lastOverflowLogAt = 0
  const inbox = createOrderedInbox<Frame>(
    handleFrame,
    (err, frame) => logger.warn('web-ws frame failed', { userId: user.sub, type: frame.type, error: String(err) }),
    (frame, inflight) => {
      const type = frame.type as string | undefined
      const requestId = (frame.payload as { requestId?: unknown } | undefined)?.requestId
      if (typeof requestId === 'string' && typeof type === 'string') {
        send({ type: `${type}_result`, payload: { requestId, error: 'INBOUND_OVERFLOW' } })
      } else {
        send({ type: 'error', payload: { code: 'INBOUND_OVERFLOW', message: 'too many frames in flight' } })
      }
      const now = Date.now()
      if (now - lastOverflowLogAt > 10_000) {
        lastOverflowLogAt = now
        logger.warn('web-ws inbound overflow — refusing frames', { userId: user.sub, machineId: currentAgentId ?? undefined, inflight, type })
      }
    },
  )
  ws.on('message', (raw: RawData, isBinary: boolean) => {
    if (isBinary) {
      const parsed = parseTerminalClientFrame(new Uint8Array(raw as Buffer))
      // A web/relay client only ever originates input, or a paste/imagePaste/pasteFile chunk —
      // output/keyframe/sync flow the other way. This gate is `parseTerminalClientFrame`'s own kind
      // check (which just validates wire shape and accepts every kind) plus that directionality —
      // paste/imagePaste/pasteFile were missing here even after being added to the kind enum and to
      // that parser, so every such frame was rejected as TERMINAL_BINARY_REJECTED, freezing the pane.
      const rateKey = parsed?.kind === TerminalBinaryKind.input ? 'terminal_input' : 'terminal_paste'
      if (!client || !currentBinding || !parsed || !TERMINAL_BINARY_CLIENT_UP_KINDS.has(parsed.kind)
        || !terminalRate.allow(rateKey, parsed.bytes.length)) {
        send({ type: 'terminal_transport_error', payload: { code: 'TERMINAL_BINARY_REJECTED' } })
        return
      }
      client.sendTerminalDown(parsed.bytes)
      return
    }
    let frame: Frame
    try { frame = JSON.parse(raw.toString()) as Frame } catch { return }
    inbox.enqueue(frame)
  })

  const cleanup = (): void => {
    if (closed) return
    closed = true
    releaseLiveness()
    client?.detach()
    client = null
    currentBinding = null
    for (const [, unsub] of statusSubs) unsub()
    statusSubs.clear()
    if (watchAgentsTimer) { clearTimeout(watchAgentsTimer); watchAgentsTimer = null }
    if (deviceSeedTimer) { clearInterval(deviceSeedTimer); deviceSeedTimer = null }
    if (deviceStatusUnsub) { deviceStatusUnsub(); deviceStatusUnsub = null }
    if (machineListUnsub) { machineListUnsub(); machineListUnsub = null }
    if (deviceE2eePairUnsub) { deviceE2eePairUnsub(); deviceE2eePairUnsub = null }
    logger.info('web user disconnected', { userId: user.sub, machineId: currentAgentId ?? undefined })
  }
  ws.on('close', cleanup)
  ws.on('error', cleanup)
}

/** LEGACY per-agent socket (old bundle during rolling deploys): bound to one agent for life. */
function attachWebClient(ws: WebSocket, machineId: string): void {
  const client = attachHubClient(ws, machineId, 'web')
  const terminalRate = new TerminalRateGuard()
  const send = (obj: unknown): boolean => guardedSendJson(ws, obj, 'must', { machineId, connId: client.connId })
  logger.info('web client connected (legacy)', { machineId, connId: client.connId })

  send({ type: 'connected', payload: { machineId: machineId } })

  // Authoritative node-liveness signal on connect (presence key = source of truth, set on register +
  // refreshed by the manager ping). Explicit BOTH ways so a client that connects while the node is
  // already up gets `online:true` immediately, not just inferred from the absence of an offline event.
  fireAndForget((async () => {
    const mgr = await getAgentPresence(machineId)
    const online = await machineOnline(machineId, !!mgr)
    if (ws.readyState === WebSocket.OPEN) {
      send({ type: 'node_status', payload: { online } })
    }
  })(), 'web-ws seed node_status (legacy)', { machineId })

  ws.on('message', (raw: RawData, isBinary: boolean) => {
    if (isBinary) {
      const parsed = parseTerminalClientFrame(new Uint8Array(raw as Buffer))
      // Same client-originated kinds as the current per-user handler above — see its comment.
      const rateKey = parsed?.kind === TerminalBinaryKind.input ? 'terminal_input' : 'terminal_paste'
      if (parsed && TERMINAL_BINARY_CLIENT_UP_KINDS.has(parsed.kind) && terminalRate.allow(rateKey, parsed.bytes.length)) {
        client.sendTerminalDown(parsed.bytes)
      }
      return
    }
    let frame: Frame
    try { frame = JSON.parse(raw.toString()) as Frame } catch { return }
    const type = frame.type as string | undefined
    if (typeof type === 'string' && type.startsWith('__')) return
    if (typeof type === 'string' && type.startsWith('terminal_') && !TERMINAL_DOWN_TYPES.has(type)) return
    if (typeof type === 'string' && TERMINAL_DOWN_TYPES.has(type)) {
      const bytes = terminalFrameBytes(frame)
      if (bytes > TERMINAL_ENVELOPE_MAX_BYTES || !isEncryptedTerminalFrame(frame) || !terminalRate.allow(type, bytes)) return
    }
    client.sendDown(frame)
  })

  let closed = false
  const cleanup = (): void => {
    if (closed) return // 'error' is followed by 'close': detach (and its __client_disconnected) only once
    closed = true
    client.detach()
    logger.info('web client disconnected (legacy)', { machineId, connId: client.connId })
  }
  ws.on('close', cleanup)
  ws.on('error', cleanup)
}
