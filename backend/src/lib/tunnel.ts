/**
 * Tunnel envelope types for the inverted WS transport.
 *
 * The inverted chain is: node ─dial▶ manager ─dial▶ backend; web/device ─dial▶ backend.
 * The inner "frame" is the existing client/server WS message ({ type, dbSessionId?, payload? }) —
 * opaque at the transport layer. These envelopes wrap it as it is tunnelled up/down the chain and
 * as it crosses backend instances via Redis (see lib/bus.ts).
 *
 * Directions:
 *  - up   = node → manager → backend → clients (brain events, acks)
 *  - down = clients → backend → manager → node (chat messages, control)
 */

/** The inner WS message (existing ClientEvent / BrainEvent shape). Opaque here. */
export type Frame = Record<string, unknown>

// ── Frames on the manager↔backend socket (multiplexed: many agents over one socket) ──────────────

/** node/brain event travelling toward clients. `machineId` (= routing key, sha256(apiKey)[:32]) carried because the socket is multiplexed. */
export interface UpEnvelope {
  t: 'up'
  machineId: string
  /** origin client connId to skip when re-delivering (preserves broadcastToOthers). */
  excludeConnId?: string
  /** deliver to web/UI sockets (default true when absent). false = device-only (forwardToCommander). */
  webEligible?: boolean
  /** deliver to device/commander sockets (COMMANDER_FORWARD set, or curated commander frames). */
  commanderEligible?: boolean
  frame: Frame
}

/** client message travelling toward the node. */
export interface DownEnvelope {
  t: 'down'
  machineId: string
  /** originating client connId (so the node can tag its emitted events with excludeConnId). */
  connId: string
  frame: Frame
}

/** manager tells its backend a node connected/disconnected → backend (un)subscribes down:{machineId}.
 *  `app_register`/`app_unregister` are the app-proxy variant, sent on the APP-pool socket (or the control
 *  socket when no dedicated app pool) → backend (un)subscribes appdown:{machineId} on that socket. */
export interface RegisterEnvelope {
  t: 'register' | 'unregister' | 'app_register' | 'app_unregister'
  machineId: string
}

/** manager identifies itself + advertises capacity on connect and on heartbeat. */
export interface HelloEnvelope {
  t: 'hello'
  managerId: string
  capacity?: number
  nodeCount?: number
  // The manager→backend pool's CONTROL socket sets this; the backend subscribes mgr:{managerId} only
  // for control sockets, so provisioning isn't forwarded once per pool socket.
  control?: boolean
  // Set by the manager's dedicated APP-pool sockets (cosmetic/observability — routing is driven by the
  // app_register frame + machineId, not this flag).
  app?: boolean
}

export interface PingEnvelope {
  t: 'ping'
}

/** backend→manager provisioning command over the manager socket (Phase 3; replaces control HTTP).
 *  `app_create`/`app_delete` register/remove a public app deployment (subdomain → node app port). */
export interface ProvisionEnvelope {
  t: 'provision'
  requestId: string
  cmd: 'create' | 'start' | 'stop' | 'destroy' | 'app_create' | 'app_delete'
  payload: Record<string, unknown>
}

// ── App-proxy tunnel: transparent HTTP/WS reverse proxy for public app hosting, streamed over the
//    manager socket so the backend never needs the manager's address. Multiplexed by `streamId`
//    (one stream = one client connection). down = backend→manager; up = manager→backend.
export interface AppReqEnvelope {
  t: 'app_req'
  streamId: string
  subdomain: string
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
}
export interface AppBodyEnvelope {
  t: 'app_body' | 'app_res_body'
  streamId: string
  chunk?: string // base64
  end?: boolean
}
export interface AppResEnvelope {
  t: 'app_res'
  streamId: string
  status: number
  headers: Record<string, string | string[] | undefined>
}
export interface AppWsOpenEnvelope {
  t: 'app_ws_open'
  streamId: string
  subdomain: string
  url: string
  headers: Record<string, string | string[] | undefined>
}
export interface AppWsMsgEnvelope {
  t: 'app_ws_msg'
  streamId: string
  data: string // base64
  binary: boolean
}
export interface AppWsCloseEnvelope {
  t: 'app_ws_close'
  streamId: string
  code?: number
  ok?: boolean
}
export interface AppAbortEnvelope {
  t: 'app_abort'
  streamId: string
  reason?: string
}
export type AppDownFrame = AppReqEnvelope | AppBodyEnvelope | AppWsOpenEnvelope | AppWsMsgEnvelope | AppWsCloseEnvelope | AppAbortEnvelope
export type AppUpFrame = AppResEnvelope | AppBodyEnvelope | AppWsMsgEnvelope | AppWsCloseEnvelope | AppAbortEnvelope

/** manager→backend provisioning result. */
export interface ProvisionResultEnvelope {
  t: 'provision_result'
  requestId: string
  ok: boolean
  data?: unknown
  error?: string
}

/** backend informs the node of its current client counts so it can gate event buffering/replay. */
export interface ClientsEnvelope {
  t: 'clients'
  machineId: string
  ui: number
  commander: number
}

export type ManagerFrame =
  | UpEnvelope
  | DownEnvelope
  | RegisterEnvelope
  | HelloEnvelope
  | PingEnvelope
  | ClientsEnvelope
  | ProvisionResultEnvelope // manager → backend (reply to a ProvisionEnvelope sent down)
  | AppResEnvelope // app-proxy tunnel: manager → backend (response head/body/ws/abort), keyed by streamId
  | AppBodyEnvelope
  | AppWsMsgEnvelope
  | AppWsCloseEnvelope
  | AppAbortEnvelope

// ── Frames on the node↔manager socket (single machine per socket: machineId implicit) ────────────────

export type NodeUpFrame = Omit<UpEnvelope, 'machineId'>
export type NodeDownFrame = Omit<DownEnvelope, 'machineId'>
export type NodeFrame = NodeUpFrame | NodeDownFrame | ClientsEnvelope | PingEnvelope

// ── Redis bus payloads (machineId is encoded in the channel name, not the body) ────────────────────

export interface UpBusMsg {
  excludeConnId?: string
  webEligible?: boolean
  commanderEligible?: boolean
  // Deliver ONLY to the commander socket whose resolved deviceId matches (device-targeted push, e.g.
  // `device_revoked`). Absent ⇒ normal per-machine fan-out.
  targetDeviceId?: string
  // Deliver ONLY to the client socket with this connId (adapter-targeted push: E2EE pairing/welcome
  // and per-client RPC replies). Absent ⇒ normal per-machine fan-out.
  targetConnId?: string
  /** Optional kind constraint for connId-targeted traffic. Terminal streams are web/Desktop-only. */
  targetKind?: 'web' | 'commander'
  frame: Frame
  // Publisher's PROCESS_ID — the origin instance already delivered to its local clients directly, so its
  // own Redis loopback delivery is skipped (chat-up local fast-path). Absent on legacy/other publishers.
  originPid?: string
}

export interface DownBusMsg {
  connId: string
  frame: Frame
}
