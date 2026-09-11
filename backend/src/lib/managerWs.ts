/**
 * Backend hub — manager-facing terminating endpoint (`/api/manager-ws`). Managers DIAL IN and
 * multiplex all their agents over one socket, so the backend no longer needs `Manager.publicHost`
 * or any manager address. Auth = the manager's own key (`x-api-key` + `managerId`), validated
 * against the `managers` collection.
 *
 * Per agent this backend instance becomes `B_m` (the single owner of that agent's manager socket):
 *   - on `register machineId`  → subscribeDown(machineId) so any client-holding backend's publishDown
 *     reaches this manager socket → node; only then set the agent→manager presence key.
 *   - on `up`   → publishUp(machineId) so every client-holding backend fans it to its clients.
 */
import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import { randomUUID } from 'crypto'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import { prisma } from './prisma.js'
import {
  publishUp,
  subscribeDown,
  setAgentPresence,
  clearAgentPresence,
  subscribeMgr,
  publishReply,
  subscribeAppDown,
  publishAppUp,
  setAppInstance,
  clearAppInstance,
} from './bus.js'
import { env } from '../config/env.js'
import { INSTANCE_ID } from './instance.js'
import * as registry from './registry.js'
import { deliverAppUpLocal } from './appTunnel.js'
import { deliverUpLocal, recomputeAndSendClients, CLIENTS_DIRTY } from './hub.js'
import { recordCreatedAgent, recordDeletedAgent } from './agentTracker.js'
import type { ManagerFrame, DownBusMsg } from './tunnel.js'
import { logger } from '../utils/logger.js'
import { getMachineLifecycleState } from './machineLifecycle.js'

const PRESENCE_TTL_SEC = 30

const wss = new WebSocketServer({ noServer: true })

/** Fastify/http upgrade hook for `/api/manager-ws`. Auth = manager apiKey (`x-api-key`) + `managerId`. */
export function handleManagerUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const apiKey = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined
  const url = new URL(req.url ?? '', 'http://localhost')
  const managerId = url.searchParams.get('managerId') ?? ''
  // Dedicated app-proxy pool sockets dial with ?pool=app (observability only — subscriptions are driven
  // by the register / app_register frames the manager sends, not by this).
  const poolKind = url.searchParams.get('pool') === 'app' ? 'app' : 'control'
  if (!apiKey || !managerId) { socket.destroy(); return }
  void (async () => {
    const m = await prisma.manager.findUnique({ where: { managerId } })
    if (!m || !m.apiKey || m.apiKey !== apiKey) { socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, (ws) => attachManager(ws, managerId, poolKind))
  })().catch((err) => { logger.warn('manager-ws upgrade failed', { error: String(err) }); socket.destroy() })
}

export function attachManager(ws: WebSocket, managerId: string, poolKind: 'control' | 'app'): void {
  // Managers run as a PM2 cluster sharing one MANAGER_ID, so key the registry by a UNIQUE
  // per-connection id (else cluster instances collide). `managerId` stays the logical value used
  // for presence + provisioning placement.
  const connKey = `${managerId}#${randomUUID()}`
  registry.addManager(connKey, ws)
  logger.info('manager connected', { managerId, connKey, pool: poolKind })

  // machineId → unsubscribe for its down:{machineId} subscription (this instance is B_m for that agent).
  const downSubs = new Map<string, () => void>()
  // machineId → unsubscribe for its appdown:{machineId} subscription (app-proxy tunnel client→app frames).
  const appDownSubs = new Map<string, () => void>()
  // machineIds whose subscribe is IN FLIGHT. Reserved synchronously because `downSubs.set` only happens
  // after the Redis SUBSCRIBE resolves: without this, two `register` frames for the same agent arriving
  // inside that window both pass the `has()` check, and the second unsub overwrites (and orphans) the
  // first — leaving two live callbacks, so every down-frame reaches the node TWICE (one user message
  // → two agent turns). The manager does send `register` twice back-to-back: attachNode queues one
  // while the socket is still connecting, then onOpen re-registers AND flushes the queued copy.
  const downSubPending = new Set<string>()
  const appDownSubPending = new Set<string>()

  // Liveness: the manager app-pings every ~15s. If we hear NOTHING for 45s the socket is half-open →
  // terminate so the manager's backendSocket reconnects and re-registers its nodes.
  let lastSeen = Date.now()
  const staleSweep = setInterval(() => {
    if (Date.now() - lastSeen > 45_000) { try { ws.terminate() } catch { /* ignore */ } }
  }, 20_000)

  // Provisioning RPC: forward mgr:{managerId} commands over THIS socket. Subscribed ONLY on the
  // manager→backend pool's CONTROL socket (`hello.control`), so a provision command is forwarded once,
  // not once per pool socket. The manager replies with a provision_result frame, which we republish to
  // mgrreply:{requestId} for the requesting backend.
  let unsubMgr: (() => void) | null = null
  const subscribeProvisioning = (): void => {
    if (unsubMgr) return
    void subscribeMgr(managerId, (msg) => {
      const cmd = msg as { requestId?: string; cmd?: 'create' | 'start' | 'stop' | 'destroy' | 'app_create' | 'app_delete'; payload?: Record<string, unknown> }
      if (!cmd?.requestId || !cmd.cmd) return
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ t: 'provision', requestId: cmd.requestId, cmd: cmd.cmd, payload: cmd.payload ?? {} })) } catch { /* ignore */ }
      }
    }).then((u) => { unsubMgr = u }).catch((err) => logger.error('manager-ws subscribeMgr failed', err, { managerId }))
  }

  const refreshPresence = (): void => {
    for (const machineId of registry.agentsForManager(connKey)) {
      // Control socket → node-liveness presence; app socket → instance-affinity for the mesh (Phase 2).
      if (poolKind === 'app') { if (env.MESH_ENABLED) void setAppInstance(machineId, INSTANCE_ID, PRESENCE_TTL_SEC) }
      // Presence is also the cross-instance down-route readiness gate used by ensureMachineReady(). Do
      // not refresh it while Redis SUBSCRIBE is still pending, or a client on another backend can
      // publish into that gap and lose its message (Redis Pub/Sub has no backlog).
      else if (downSubs.has(machineId)) void setAgentPresence(machineId, managerId, PRESENCE_TTL_SEC)
    }
  }

  const announceControlReady = (machineId: string): void => {
    if (!downSubs.has(machineId) || registry.controlSocketFor(machineId) !== ws ||
      !registry.agentsForManager(connKey).includes(machineId)) return
    void setAgentPresence(machineId, managerId, PRESENCE_TTL_SEC)
    // Node came online AND its cross-instance down route is live. Clients may now safely release
    // messages that were held by ensureMachineReady() during an idle wake.
    void publishUp(machineId, { webEligible: true, commanderEligible: true, frame: { type: 'node_status', payload: { online: true, status: 'running' } } })
    // Resync client counts over the local control socket, avoiding another Redis round-trip.
    void recomputeAndSendClients(machineId)
    logger.info('node registered', { managerId, machineId })
  }

  // Chat/control register — arrives on the manager's CONTROL-pool socket for this agent.
  const register = (machineId: string): void => {
    registry.bindAgentManager(machineId, connKey)
    registry.bindControlSocket(machineId, ws) // local chat-down fast-path
    if (downSubs.has(machineId)) {
      announceControlReady(machineId)
      return
    }
    if (!downSubs.has(machineId) && !downSubPending.has(machineId)) {
      downSubPending.add(machineId)
      void subscribeDown(machineId, (msg: DownBusMsg) => {
        // A client-holding backend pokes us (B_m) to recompute the GLOBAL client total — don't forward
        // it to the node; re-emit the summed `__clients` frame over this control socket instead.
        if ((msg.frame as { type?: string })?.type === CLIENTS_DIRTY) { void recomputeAndSendClients(machineId); return }
        // Forward a client message down this manager socket → manager → node.
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({ t: 'down', machineId: machineId, connId: msg.connId, frame: msg.frame })) } catch { /* ignore */ }
        }
      }).then((unsub) => {
        downSubPending.delete(machineId)
        // Drop it if the agent left this manager meanwhile, or if another register already claimed
        // the slot — overwriting would orphan the incumbent callback and double-deliver every frame.
        if (!registry.agentsForManager(connKey).includes(machineId) ||
          registry.controlSocketFor(machineId) !== ws || downSubs.has(machineId)) {
          unsub()
        } else {
          downSubs.set(machineId, unsub)
          announceControlReady(machineId)
        }
      }).catch((err) => {
        downSubPending.delete(machineId)
        logger.error('manager-ws subscribeDown failed', err, { machineId })
      })
    }
  }

  const unregister = (machineId: string): void => {
    registry.unbindAgent(machineId, connKey)
    registry.unbindControlSocket(machineId, ws)
    const unsub = downSubs.get(machineId)
    if (unsub) { unsub(); downSubs.delete(machineId) }
    void clearAgentPresence(machineId)
    // Intentional manual/idle stop is a first-class lifecycle state; unexpected detach remains `offline`.
    void getMachineLifecycleState(machineId).then(({ status: rawStatus, stopReason }) => {
      const stopped = rawStatus === 'stopping' || rawStatus === 'stopped'
      return publishUp(machineId, {
        webEligible: true,
        commanderEligible: true,
        frame: {
          type: 'node_status',
          payload: stopped
            ? { online: false, status: 'stopped', reason: stopReason ?? 'stopped' }
            : { online: false, status: 'offline', reason: 'node offline' },
        },
      })
    })
    logger.info('node unregistered', { managerId, machineId })
  }

  // App-proxy register — arrives on the manager's APP-pool socket for this agent (or the CONTROL socket
  // when the manager runs no dedicated app pool, MANAGER_APP_POOL_SIZE=0). Subscribes client→app frames
  // (app_req/app_body/app_ws_*/app_abort) to forward down THIS socket → manager appTunnel → container app.
  // Single subscriber per agent (no dup under clustering); the app stream rides the agent's app-shard socket.
  const appRegister = (machineId: string): void => {
    registry.bindAgentManager(machineId, connKey)
    registry.bindAppSocket(machineId, ws) // local app-proxy fast-path (skip Redis when co-located)
    if (env.MESH_ENABLED) void setAppInstance(machineId, INSTANCE_ID, PRESENCE_TTL_SEC) // affinity for the mesh
    if (!appDownSubs.has(machineId) && !appDownSubPending.has(machineId)) {
      appDownSubPending.add(machineId)
      void subscribeAppDown(machineId, (frame) => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify(frame)) } catch { /* ignore */ }
        }
      }).then((unsub) => {
        appDownSubPending.delete(machineId)
        // Same reservation rule as the control plane: never overwrite an incumbent subscription.
        if (!registry.agentsForManager(connKey).includes(machineId) || appDownSubs.has(machineId)) unsub()
        else appDownSubs.set(machineId, unsub)
      }).catch((err) => {
        appDownSubPending.delete(machineId)
        logger.error('manager-ws subscribeAppDown failed', err, { machineId })
      })
    }
  }

  const appUnregister = (machineId: string): void => {
    registry.unbindAgent(machineId, connKey)
    registry.unbindAppSocket(machineId, ws)
    if (env.MESH_ENABLED) void clearAppInstance(machineId)
    const appUnsub = appDownSubs.get(machineId)
    if (appUnsub) { appUnsub(); appDownSubs.delete(machineId) }
  }

  ws.on('message', (raw: RawData) => {
    lastSeen = Date.now()
    let env: ManagerFrame
    try { env = JSON.parse(raw.toString()) as ManagerFrame } catch { return }
    switch (env.t) {
      case 'up': {
        // Tap project lifecycle to maintain machine_agents (plan cap) — replaces the old /proxy
        // response tap; works for BOTH web and device WS create/delete.
        const f = env.frame as { type?: string; payload?: { agent?: { id?: unknown; name?: unknown }; agentId?: unknown; machineId?: unknown } }
        if (f?.type === 'agent_synced') {
          void recordCreatedAgent(env.machineId, f.payload?.agent).catch(() => { /* best effort */ })
        } else if (f?.type === 'agent_deleted' && typeof f.payload?.agentId === 'string') {
          // See adapterWs.ts: producers send `agentId`, so reading `machineId` recorded nothing.
          void recordDeletedAgent(env.machineId, f.payload.agentId).catch(() => { /* best effort */ })
        }
        const upMsg = {
          excludeConnId: env.excludeConnId,
          webEligible: env.webEligible,
          commanderEligible: env.commanderEligible,
          frame: env.frame,
          originPid: registry.PROCESS_ID,
        }
        // Fast-path: hand straight to THIS instance's local clients (no Redis round-trip); the tagged
        // publish still fans out to clients on other instances, which won't double-deliver here.
        deliverUpLocal(env.machineId, upMsg)
        void publishUp(env.machineId, upMsg)
        break
      }
      case 'register':
        register(env.machineId)
        break
      case 'unregister':
        unregister(env.machineId)
        break
      case 'app_register':
        appRegister(env.machineId)
        break
      case 'app_unregister':
        appUnregister(env.machineId)
        break
      case 'hello':
        // capacity advertised for placement; presence refreshed opportunistically. Only the pool's
        // CONTROL socket subscribes provisioning (so a provision command isn't forwarded N times).
        if (env.control) subscribeProvisioning()
        refreshPresence()
        break
      case 'ping':
        refreshPresence()
        break
      case 'provision_result':
        void publishReply(env.requestId, { ok: env.ok, data: env.data, error: env.error })
        break
      case 'app_res':
      case 'app_body':
      case 'app_res_body':
      case 'app_ws_msg':
      case 'app_ws_close':
      case 'app_abort':
        // App-proxy tunnel app→client frame. Fast-path: if the origin client stream is on THIS instance
        // (co-located), hand it straight to the local handler — no Redis. Else republish by streamId.
        if (!deliverAppUpLocal(env.streamId, env)) void publishAppUp(env.streamId, env)
        break
      default:
        break
    }
  })

  const cleanup = (): void => {
    clearInterval(staleSweep)
    if (unsubMgr) { unsubMgr(); unsubMgr = null }
    const agents = registry.removeManager(connKey)
    for (const machineId of agents) {
      registry.unbindControlSocket(machineId, ws)
      registry.unbindAppSocket(machineId, ws)
      if (env.MESH_ENABLED && poolKind === 'app') void clearAppInstance(machineId)
      const unsub = downSubs.get(machineId)
      if (unsub) { unsub(); downSubs.delete(machineId) }
      const appUnsub = appDownSubs.get(machineId)
      if (appUnsub) { appUnsub(); appDownSubs.delete(machineId) }
      void clearAgentPresence(machineId)
      // Manager socket dropped → its nodes are unreachable; tell clients they're offline.
      void publishUp(machineId, { webEligible: true, commanderEligible: true, frame: { type: 'node_status', payload: { online: false, status: 'offline', reason: 'manager offline' } } })
    }
    logger.info('manager disconnected', { managerId, agents: agents.length })
  }
  ws.on('close', cleanup)
  ws.on('error', cleanup)
}
