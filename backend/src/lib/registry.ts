/**
 * Per-instance connection registry for the backend hub.
 *
 * This is deliberately PER-PROCESS (like the old agentTargetCache) — cross-instance routing is done
 * with Redis (lib/bus.ts), never shared connection state. Each backend instance tracks only the
 * sockets it locally terminates:
 *   - client sockets (web + device/commander) it accepted, grouped by machineId
 *   - manager sockets that dialed into it, by managerId
 *   - which local manager socket owns a given machineId's node (for down routing)
 */
import { randomUUID } from 'crypto'
import type { WebSocket } from 'ws'

/** Stable id for THIS backend process — tags up-frames so the origin instance skips its own Redis
 *  loopback after delivering to local clients directly (chat-up local fast-path). */
export const PROCESS_ID = randomUUID()

export type ClientKind = 'web' | 'commander'

export interface ClientConn {
  connId: string
  machineId: string
  kind: ClientKind
  socket: WebSocket
  // Resolved from a commander socket's `device_hello` (self-reported deviceId). Lets a revoke frame
  // target exactly one device of an agent (see hub.deliverUpLocal targetDeviceId filter). Undefined for
  // web clients and for legacy firmware that doesn't report it.
  deviceId?: string
  // Multi-attach: a commander (device) holds N machines at once but RENDERS only one. `active` marks the
  // machine this connection currently renders → drives the per-machine `commanderActive` count in `__clients`
  // so the node/adapter streams full turn cards only to an actively-viewed machine, while still running the
  // (cheaper) recap for every attached commander. Always false/undefined for web + background machines.
  active?: boolean
}

export interface QueuedCommanderFrame {
  frame: unknown
  payload: string
}

// machineId → (connId → client) held on THIS instance
const clientsByAgent = new Map<string, Map<string, ClientConn>>()
// `${machineId}:${connId}` → low-priority backend→commander frames held while that device uploads voice.
const commanderVoiceQueues = new Map<string, { frames: Map<string, QueuedCommanderFrame>; order: string[] }>()
// managerId → manager socket held on THIS instance
const managerSockets = new Map<string, WebSocket>()
// machineId → managerId: which locally-held manager socket owns this agent's node (down routing)
const agentToManager = new Map<string, string>()
// managerId → set of machineIds it currently owns (for cleanup on manager disconnect)
const managerAgents = new Map<string, Set<string>>()
// machineId → the LOCAL manager socket held on THIS instance for the app-proxy / control planes, so the
// data-plane can short-circuit Redis when this instance holds both the client and the manager socket
// (co-located). Keyed by plane because app + chat ride separate pool sockets (possibly this vs another
// instance independently).
const appSocketByAgent = new Map<string, WebSocket>()
const controlSocketByAgent = new Map<string, WebSocket>()
const MAX_COMMANDER_VOICE_QUEUE = 32

// ── clients ──────────────────────────────────────────────────────────────────────────────────────

/** Returns true if this is the FIRST client for the agent on this instance (→ subscribe up:{machineId}). */
export function addClient(conn: ClientConn): boolean {
  let m = clientsByAgent.get(conn.machineId)
  const first = !m || m.size === 0
  if (!m) {
    m = new Map()
    clientsByAgent.set(conn.machineId, m)
  }
  m.set(conn.connId, conn)
  return first
}

/** Returns true if that was the LAST client for the agent on this instance (→ unsubscribe up:{machineId}). */
export function removeClient(machineId: string, connId: string): boolean {
  const m = clientsByAgent.get(machineId)
  if (!m) return false
  clearCommanderVoiceQueue(machineId, connId)
  m.delete(connId)
  if (m.size === 0) {
    clientsByAgent.delete(machineId)
    return true
  }
  return false
}

export function clientsFor(machineId: string): ClientConn[] {
  const m = clientsByAgent.get(machineId)
  return m ? [...m.values()] : []
}

/** Every local client (web + commander) across all agents — for the hub keep-alive sweep. */
export function allClients(): ClientConn[] {
  const out: ClientConn[] = []
  for (const m of clientsByAgent.values()) out.push(...m.values())
  return out
}

/** machineIds with ≥1 local client on this instance — for the hub heartbeat's client-count refresh. */
export function localAgentIds(): string[] {
  return [...clientsByAgent.keys()]
}

/** Tag a commander connection with the deviceId it reported in device_hello (for targeted delivery). */
export function setClientDeviceId(machineId: string, connId: string, deviceId: string): void {
  const c = clientsByAgent.get(machineId)?.get(connId)
  if (c) c.deviceId = deviceId
}

/** Mark/unmark a commander connection as actively RENDERING this machine. Returns true if the flag changed
 *  (so the caller re-emits `__clients` only on a real transition). */
export function setClientActive(machineId: string, connId: string, active: boolean): boolean {
  const c = clientsByAgent.get(machineId)?.get(connId)
  if (!c || !!c.active === active) return false
  c.active = active
  return true
}

export function clientCounts(machineId: string): { ui: number; commander: number; commanderActive: number } {
  const m = clientsByAgent.get(machineId)
  let ui = 0
  let commander = 0
  let commanderActive = 0
  if (m) for (const c of m.values()) {
    if (c.kind === 'commander') { commander++; if (c.active) commanderActive++ }
    else ui++
  }
  return { ui, commander, commanderActive }
}

function commanderQueueId(machineId: string, connId: string): string {
  return `${machineId}:${connId}`
}

function frameType(frame: unknown): string {
  return typeof (frame as { type?: unknown })?.type === 'string' ? (frame as { type: string }).type : 'unknown'
}

function framePayload(frame: unknown): Record<string, unknown> {
  const payload = (frame as { payload?: unknown })?.payload
  return payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
}

function textPart(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function queueKeyForFrame(frame: unknown): string {
  const type = frameType(frame)
  const payload = framePayload(frame)
  const top = frame as { machineId?: unknown; dbSessionId?: unknown; requestId?: unknown }
  const requestId = textPart(payload.requestId) || textPart(top.requestId)
  const machineId = textPart(top.machineId) || textPart(payload.machineId)
  const sessionId = textPart(top.dbSessionId) || textPart(payload.sessionId)
  const kind = textPart(payload.kind)
  if (type.endsWith('_result') && requestId) return `${type}:req:${requestId}`
  if (type === 'commander_event') return `${type}:${machineId}:${sessionId}:${kind}`
  if (type === 'machines_status' || type === 'node_status') return type
  return `${type}:${machineId}:${sessionId}:${requestId}`
}

function isVoiceCriticalFrame(frame: unknown): boolean {
  const type = frameType(frame)
  if (type === 'device_revoked' || type === 'transcript' || type === 'too_short' || type === 'error' || type === 'empty' || type === 'dispatched') return true
  if (type !== 'commander_event') return false
  const kind = framePayload(frame).kind
  return kind === 'processing' || kind === 'done'
}

export function startCommanderVoiceQueue(machineId: string, connId: string): void {
  commanderVoiceQueues.set(commanderQueueId(machineId, connId), { frames: new Map(), order: [] })
}

export function flushCommanderVoiceQueue(machineId: string, connId: string): QueuedCommanderFrame[] {
  const id = commanderQueueId(machineId, connId)
  const q = commanderVoiceQueues.get(id)
  if (!q) return []
  commanderVoiceQueues.delete(id)
  return q.order.map((key) => q.frames.get(key)).filter((f): f is QueuedCommanderFrame => !!f)
}

export function clearCommanderVoiceQueue(machineId: string, connId: string): void {
  commanderVoiceQueues.delete(commanderQueueId(machineId, connId))
}

/** Returns true when the frame was queued instead of being sent immediately. */
export function queueCommanderFrame(machineId: string, connId: string, frame: unknown, payload: string): boolean {
  if (isVoiceCriticalFrame(frame)) return false
  const q = commanderVoiceQueues.get(commanderQueueId(machineId, connId))
  if (!q) return false
  const key = queueKeyForFrame(frame)
  if (!q.frames.has(key)) {
    q.order.push(key)
    if (q.order.length > MAX_COMMANDER_VOICE_QUEUE) {
      const dropped = q.order.shift()
      if (dropped) q.frames.delete(dropped)
    }
  }
  q.frames.set(key, { frame, payload })
  return true
}

// ── managers ─────────────────────────────────────────────────────────────────────────────────────

export function addManager(managerId: string, socket: WebSocket): void {
  managerSockets.set(managerId, socket)
  if (!managerAgents.has(managerId)) managerAgents.set(managerId, new Set())
}

export function removeManager(managerId: string): string[] {
  managerSockets.delete(managerId)
  const agents = [...(managerAgents.get(managerId) ?? [])]
  managerAgents.delete(managerId)
  for (const machineId of agents) {
    if (agentToManager.get(machineId) === managerId) agentToManager.delete(machineId)
  }
  return agents
}

export function managerSocketFor(managerId: string): WebSocket | undefined {
  return managerSockets.get(managerId)
}

export function bindAgentManager(machineId: string, managerId: string): void {
  agentToManager.set(machineId, managerId)
  let set = managerAgents.get(managerId)
  if (!set) {
    set = new Set()
    managerAgents.set(managerId, set)
  }
  set.add(machineId)
}

export function unbindAgent(machineId: string, managerId: string): void {
  if (agentToManager.get(machineId) === managerId) agentToManager.delete(machineId)
  managerAgents.get(managerId)?.delete(machineId)
}

export function agentsForManager(managerId: string): string[] {
  return [...(managerAgents.get(managerId) ?? [])]
}

// ── local manager-socket ownership (data-plane fast-path: skip Redis when co-located) ──────────────

/** The app-pool manager socket for this agent, IF held on this instance (else undefined → use Redis). */
export function appSocketFor(machineId: string): WebSocket | undefined {
  return appSocketByAgent.get(machineId)
}
export function bindAppSocket(machineId: string, ws: WebSocket): void {
  appSocketByAgent.set(machineId, ws)
}
export function unbindAppSocket(machineId: string, ws: WebSocket): void {
  if (appSocketByAgent.get(machineId) === ws) appSocketByAgent.delete(machineId)
}

/** The control manager socket for this agent, IF held on this instance (chat-down fast-path). */
export function controlSocketFor(machineId: string): WebSocket | undefined {
  return controlSocketByAgent.get(machineId)
}
/** Agents whose control socket is bound on THIS instance — i.e. the agents this instance is B_m for. */
export function controlAgentIds(): string[] {
  return [...controlSocketByAgent.keys()]
}
export function bindControlSocket(machineId: string, ws: WebSocket): void {
  controlSocketByAgent.set(machineId, ws)
}
export function unbindControlSocket(machineId: string, ws: WebSocket): void {
  if (controlSocketByAgent.get(machineId) === ws) controlSocketByAgent.delete(machineId)
}
