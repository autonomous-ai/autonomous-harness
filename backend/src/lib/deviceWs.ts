import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import { randomUUID } from 'crypto'
import { attachHubClient, trackSocketLiveness, DEVICE_IDLE_DEADLINE_MS, type HubClient } from './hub.js'
import {
  getAgentPresence,
  getMachineAppState,
  subscribeUp,
  setDevicePresence,
  clearDevicePresence,
  publishDeviceStatus,
  subscribeDeviceControl,
  publishDeviceControl,
  subscribeDeviceMachineListChanged,
  setDeviceLastMachine,
  getDeviceLastMachine,
  parkVoiceUpload,
  resumeVoiceUpload,
  evictVoiceUpload,
} from './bus.js'
import * as registry from './registry.js'
import { nodeRequest } from './nodeRpc.js'
import type { Frame } from './tunnel.js'
import { transcribe, MAX_PCM, normalizeLang } from './stt.js'
import { prisma } from './prisma.js'
import { deviceService } from '../services/index.js'
import { touchDeviceOnlineDay } from './dailyTracking.js'
import { utcDayKey } from '../types/analytics.js'
import { agentLimit, recordCreatedAgent } from './agentTracker.js'
import { env } from '../config/env.js'
import { logger } from '../utils/logger.js'
import { ensureMachineReady, getMachineLifecycleStatus, type MachineLifecycleStatus } from './machineLifecycle.js'
import { normalizeComputerId } from './deviceAuth.js'
import { authenticateAccessToken, SsoAuthError } from './ssoAuth.js'
import { parseAutonomousEnvironment } from './autonomousEnvironment.js'
import { AppError } from '../errors/index.js'
import type { Machine } from '@prisma/client'
import {
  VoiceQuotaExceededError,
  voiceQuotaService,
  type VoiceQuotaSnapshot,
} from './voiceQuota.js'

// Application-level relay for the device WebSocket (`/api/device-ws`).
//
// PER-USER: the device authenticates with the OWNER'S SSO ACCESS TOKEN plus a `?computer=` id, from which
// the backend resolves — and on first sight creates — the device row. MULTI-ATTACH: a `multi_machine`-capable firmware becomes a `commander` on
// ALL the user's machines at once — ONE socket holding N per-machine hub clients (`commanderClients`, keyed
// by machineId), so every machine's node sees commander>0 and runs its recap, and a background machine's
// turn-done can badge the device. `activeMachineId` is the ONE machine the device currently renders; device→
// node traffic (voice/RPC/message) routes to `activeClient()`. `machine_select {machineId}` (ownership-checked
// against `Machine.userId`) just MOVES the active pointer (no detach). Up-frames are tagged with their
// machineId at `hub.deliverUpLocal` so the device demuxes them. LEGACY firmware without the cap falls back to
// single-attach (only the selected machine is held, detach-on-switch — the web's one-machine-at-a-time model).
// `machines_watch`→`machines_status` gives the device its live machine list for the picker.
//
// The backend still SNIFFS the device-native frames: voice (`voice_start` / binary PCM / `voice_end`
// → STT → injected as a `{type:'message'}` turn on the selected machine), `device_hello` (OTA + deviceId
// tagging), and agent RPCs. Remote machines (`authMode==='remote'`) attach the same way as self/managed;
// their user content and adapter data are end-to-end encrypted between the device and the machine-adapter
// (E2EE `e2e_*` frames and data RPCs relay through the hub — backend sees ciphertext).
//
// LEGACY fallback: an old firmware's per-machine apiKey that hashes to a bound machine is pre-selected to
// that single machine (the old firmware never sends machine_select), so a rolling deploy doesn't brick it.

// Echo the offered subprotocol (the device token) so the ESP client accepts the handshake.
const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols) => {
    const first = [...protocols][0]
    return first ?? false
  },
})

// Presence refresh must beat the key TTL (45s in bus.setDevicePresence) with margin.
const DEVICE_PRESENCE_REFRESH_MS = 15_000
// How long a graceful close gets to complete before the socket is forced shut.
const CLOSE_GRACE_MS = 2_000
// Device chunks normally arrive every ~20ms. A 10s idle window tolerates transient network stalls
// while ensuring a failed upload that never sends voice_end cannot hold PCM + outbound frames forever.
const VOICE_CHUNK_IDLE_TIMEOUT_MS = 10_000
// Current firmware uploads at most 2MB at ~64KB/s (~32s). Keep a wider absolute backstop so a peer
// cannot retain the connection-scoped voice buffer indefinitely by trickling chunks under the idle limit.
// All turn voices (route / normal / goal) now stream PCM live during capture and support long "ramble" input
// (Karpathy-style), so the upload window spans the whole recording (device auto-stops at 10 min; 12 min here
// gives margin for the final chunks + voice_end). Ask-mode is short and self-limits well under this.
const VOICE_UPLOAD_MAX_MS = 12 * 60_000

function clampSr(sr: unknown): number {
  const n = parseInt(String(sr ?? 16000), 10) || 16000
  return Math.min(48000, Math.max(8000, n))
}

function safeSend(ws: WebSocket, obj: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)) } catch { /* ignore */ }
  }
}

type DeviceSend = (obj: unknown) => void

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function payloadOf(msg: CommanderMsg): Record<string, unknown> {
  return msg.payload && typeof msg.payload === 'object' ? msg.payload as Record<string, unknown> : {}
}

const DEVICE_RECENT_SAFE_FRAME_BYTES = Math.floor(16 * 1024 * 0.9)
const DEVICE_AGENT_LIST_LIMIT = 100
const DEVICE_AGENT_NAME_MAX_CODEPOINTS = 15
const DEVICE_AGENT_NAME_MAX_BYTES = 39 // device project_t.name[40], including trailing NUL on-device.
const DEVICE_ELLIPSIS = '…'

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

function truncateUtf8(input: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (byteLen(input) <= maxBytes) return input
  let out = ''
  let used = 0
  for (const ch of input) {
    const n = byteLen(ch)
    if (used + n > maxBytes) break
    out += ch
    used += n
  }
  return out
}

// ── the device picker's machine row ────────────────────────────────────────────────────────────────
export type MachineStatus = {
  machineId: string
  name: string
  online: boolean
  status?: MachineLifecycleStatus
  authMode: 'self' | 'managed' | 'remote' | 'provider'
  remote: boolean
  reason?: string
  appEngine?: string   // which desktop app this COMPUTER drives ("cursor"); NOT the per-agent engine
  appState?: string    // 'open' | 'closed' | 'missing'
}
export type MachineMeta = { name: string; authMode: MachineStatus['authMode']; remote: boolean }

/**
 * The ONE place a status row is shaped, and pure so the invariant below is directly testable.
 *
 * The app keys are emitted only when the machine is ONLINE, even if a stale app state is still known.
 * That is what stops "Cursor is open" from outliving the socket that asserted it: a client never has
 * to reason about staleness, and every row is a complete snapshot rather than a delta.
 */
export function buildMachineRow(
  machineId: string,
  online: boolean,
  meta: MachineMeta | undefined,
  app: { engine: string; state: string } | undefined,
  extra: { status?: MachineLifecycleStatus; reason?: string } = {},
): MachineStatus {
  return {
    machineId,
    name: meta?.name ?? '',
    authMode: meta?.authMode ?? 'self',
    remote: meta?.remote ?? false,
    online,
    ...(extra.status ? { status: extra.status } : {}),
    ...(extra.reason ? { reason: extra.reason } : {}),
    ...(online && app ? { appEngine: app.engine, appState: app.state } : {}),
  }
}

function clipDeviceAgentName(input: string): string {
  const chars = [...input]
  if (chars.length <= DEVICE_AGENT_NAME_MAX_CODEPOINTS && byteLen(input) <= DEVICE_AGENT_NAME_MAX_BYTES) return input
  const ellipsisBytes = byteLen(DEVICE_ELLIPSIS)
  let out = ''
  for (const ch of chars.slice(0, DEVICE_AGENT_NAME_MAX_CODEPOINTS)) {
    if (byteLen(out) + byteLen(ch) + ellipsisBytes > DEVICE_AGENT_NAME_MAX_BYTES) break
    out += ch
  }
  return `${out}${DEVICE_ELLIPSIS}`
}

function deviceAgentListItem(
  raw: unknown,
): { id: unknown; name?: string; engine?: 'claude' | 'codex' | 'cursor' | 'opencode' | 'pi' | 'hermes' | 'commandcode' | 'devin'; selectedModel?: string | null } {
  const o = (raw ?? {}) as Record<string, unknown>
  const item: { id: unknown; name?: string; engine?: 'claude' | 'codex' | 'cursor' | 'opencode' | 'pi' | 'hermes' | 'commandcode' | 'devin'; selectedModel?: string | null } = { id: o.id }
  if (typeof o.name === 'string') item.name = clipDeviceAgentName(o.name)
  if (o.engine === 'claude' || o.engine === 'codex' || o.engine === 'cursor' || o.engine === 'opencode' || o.engine === 'pi' || o.engine === 'hermes' || o.engine === 'commandcode' || o.engine === 'devin') item.engine = o.engine
  if (typeof o.selectedModel === 'string' || o.selectedModel === null) item.selectedModel = o.selectedModel
  return item
}

function deviceRecentFrameBytes(requestId: unknown, agentId: unknown, events: Array<{ kind: unknown; text: unknown; recap?: string }>): number {
  return Buffer.byteLength(JSON.stringify({ type: 'agent_recent_result', payload: { requestId, agentId, events } }), 'utf8')
}

function trimRecentEvents(raw: unknown, limit: number, requestId?: unknown, agentId?: unknown): Array<{ kind: unknown; text: unknown; recap?: string }> {
  if (!Array.isArray(raw)) return []
  const events = raw.slice(0, Math.max(1, limit)).map((e) => {
    const o = (e ?? {}) as Record<string, unknown>
    return {
      kind: o.kind,
      text: o.text,
      ...(typeof o.recap === 'string' && o.recap ? { recap: o.recap } : {}),
    }
  })
  if (deviceRecentFrameBytes(requestId, agentId, events) < DEVICE_RECENT_SAFE_FRAME_BYTES) return events
  const first = events[0] ?? { kind: 'summary', text: '' }
  const kind = typeof first.kind === 'string' && first.kind ? first.kind : 'summary'
  const text = typeof first.text === 'string' ? first.text : ''
  const recap = typeof first.recap === 'string' ? first.recap : ''
  const make = (nextText: string, nextRecap: string) => [{ kind, text: nextText || nextRecap || kind, ...(nextRecap ? { recap: nextRecap } : {}) }]
  const fitTextForRecap = (nextRecap: string): string => {
    let lo = 0, hi = byteLen(text), bestText = ''
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2)
      const candidate = truncateUtf8(text, mid)
      if (deviceRecentFrameBytes(requestId, agentId, make(candidate, nextRecap)) < DEVICE_RECENT_SAFE_FRAME_BYTES) {
        bestText = candidate
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return bestText
  }
  const bestText = fitTextForRecap(recap)
  if (deviceRecentFrameBytes(requestId, agentId, make(bestText, recap)) < DEVICE_RECENT_SAFE_FRAME_BYTES) return make(bestText, recap)
  let lo = 0, hi = byteLen(recap)
  let bestRecap = ''
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const candidate = truncateUtf8(recap, mid)
    if (deviceRecentFrameBytes(requestId, agentId, make(text, candidate)) < DEVICE_RECENT_SAFE_FRAME_BYTES) {
      bestRecap = candidate
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (bestRecap) return make(fitTextForRecap(bestRecap) || text, bestRecap)
  lo = 0; hi = byteLen(recap)
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const candidate = truncateUtf8(recap, mid)
    const candidateText = fitTextForRecap(candidate)
    const hasRequiredText = !text || candidateText.length > 0
    if (hasRequiredText && deviceRecentFrameBytes(requestId, agentId, make(candidateText, candidate)) < DEVICE_RECENT_SAFE_FRAME_BYTES) {
      bestRecap = candidate
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return make(fitTextForRecap(bestRecap), bestRecap)
}


type CommanderMsg = {
  type?: string
  payload?: unknown
  // Multi-attach: a device frame explicitly TARGETED at a specific machine's node (eager E2EE hello to a
  // BACKGROUND machine). Absent on normal frames, which route to the active machine.
  machineId?: string
  agentId?: string // workspace unit (= old wire agentId)
  sessionId?: string
  sr?: unknown
  requestId?: string
  lang?: unknown
  goal?: boolean // voice_start with goal:true → the utterance is a GOAL command (device long-press-3s)
  // voice_start with loop:true → the utterance becomes a "/loop <text>" command. A SEPARATE boolean
  // rather than a `mode` value on purpose: `mode` already carries autonomy ('plan'|'auto'), and
  // goal:true is already shipping from the square board and the OrangePi client. Additive keeps every
  // existing client correct. The two are mutually exclusive on the device; goal wins if both arrive.
  loop?: boolean
  mode?: string  // voice_start autonomy for this turn: 'plan' | 'auto' (device per-agent control; default auto)
  route?: boolean // voice_start with route:true (from the Overview tile) → the router picks the target agent
  uploadId?: string // stable per-utterance id (voice_start / voice_resume) → resume a streamed upload after a WS drop
}

interface RelayOpts {
  userId: string
  deviceId: string | null
  /** The plane the OWNER signed in against. Machines are filtered by it: the same person legitimately has
   *  separate rows per Autonomous environment, and a device must never see — or be able to select — a
   *  machine from the other one. `webWs` has always enforced this; the device plane could not, because
   *  until SSO auth landed here there was no authenticated env to compare against. */
  autonomousEnv: 'prod' | 'stag'
}

/** Hook from server.ts `upgrade` for `/api/device-ws`.
 *
 *  AUTH IS THE USER'S SSO ACCESS TOKEN, and it is the only mechanism. The token is the first (and only)
 *  WS subprotocol; `?computer=` names the machine-independent computer the dial is plugged into. There is
 *  no device token, no pairing code and no broker handshake any more: a device row is RESOLVED from the
 *  computer id, created on first sight, and owned by whoever the token says.
 *
 *  Deliberately unlike `/api/adapter-ws`, which this otherwise mirrors: no 402 and no 409. Billing gates a
 *  MACHINE, not a device; and a device is a `commander` hub client, of which N may coexist per machine, so
 *  two dials on two computers of the same account must both work. A same-computer reconnect is handled
 *  inside `relay()` by the presence-token supersede, not by refusing the upgrade. */
export function handleDeviceUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  // Explicit HTTP statuses rather than a silent destroy: the harness CLI reads "Unexpected server response:
  // 401" as a real deauthorization and stops retrying, where a close-1006 would loop forever.
  const denyWith = (status: number, text: string): void => {
    try { socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`) } catch { /* ignore */ }
    socket.destroy()
  }
  const deny = (): void => denyWith(401, 'Unauthorized')

  const accessToken = accessTokenFromProtocol(req)
  if (!accessToken) { deny(); return }

  let computerId: string | undefined
  let label: string | undefined
  let autonomousEnv: 'prod' | 'stag' = 'prod'
  try {
    const params = new URL(req.url ?? '', 'http://x').searchParams
    computerId = normalizeComputerId(params.get('computer') ?? '') ?? undefined
    label = params.get('label') || undefined
    autonomousEnv = parseAutonomousEnvironment(params.get('autonomousEnv'))
  } catch { deny(); return }
  // Required: without it there is no stable identity to hang the device row on, and every reconnect
  // would mint a new one.
  if (!computerId) { deny(); return }

  void (async () => {
    let user
    try {
      user = await authenticateAccessToken(accessToken, autonomousEnv)
    } catch (err) {
      if (err instanceof SsoAuthError && (err.code === 'AUTONOMOUS_ENV_MISMATCH' || err.code === 'AUTONOMOUS_ENV_NOT_ALLOWED')) {
        denyWith(403, 'Forbidden')
        return
      }
      deny()
      return
    }
    const device = await deviceService.resolveOrCreateForComputer(
      user.sub,
      user.autonomousEnv,
      computerId!,
      label ?? 'computer',
    )
    wss.handleUpgrade(req, socket, head, (ws) =>
      relay(ws, { userId: device.userId, deviceId: device.deviceId, autonomousEnv: user.autonomousEnv }))
  })().catch((err) => {
    if (err instanceof AppError) { denyWith(err.statusCode, 'Service Unavailable'); return }
    logger.warn('device-ws upgrade failed', { error: errMsg(err) })
    denyWith(503, 'Service Unavailable')
  })
}

/** Device authentication is SSO-only: accept precisely the first WS subprotocol, never x-api-key. */
function accessTokenFromProtocol(req: IncomingMessage): string | undefined {
  const raw = req.headers['sec-websocket-protocol']
  const first = (Array.isArray(raw) ? raw[0] : raw)?.split(',')[0]?.trim()
  return first || undefined
}


function relay(device: WebSocket, opts: RelayOpts): void {
  const { userId } = opts
  // Never arm timers/subscriptions on a socket that already died — nothing would fire to clear them.
  if (device.readyState !== WebSocket.OPEN) {
    logger.warn('device relay entered on a non-open socket — skipping', { userId, deviceId: opts.deviceId })
    return
  }
  // A device holds hub clients only once it attaches to a machine, so track the socket itself: parked on
  // the picker (or short of `device_hello`) it would otherwise never be pinged and a half-open drop would
  // never be reaped — leaving presence green, the MQTT bridge open and this relay's timers running.
  // The device pings US every 15s, so it earns a much shorter silence deadline than a browser.
  const releaseLiveness = trackSocketLiveness(device, DEVICE_IDLE_DEADLINE_MS)
  // Multi-attach: the device is a `commander` on ALL the user's machines at once — ONE per-user socket
  // holding N per-machine commander clients, keyed by machineId. Each machine's node then sees commander>0 and
  // runs its recap, so a background machine's turn-done can badge the device. `activeMachineId` is the ONE
  // machine the device currently renders/interacts with — device→node traffic (voice/RPC/message) routes
  // there. Gated on the `multi_machine` firmware cap; without it we fall back to single-attach (only the
  // selected machine is held) so an un-flashed device keeps today's behavior.
  const commanderClients = new Map<string, HubClient>() // machineId → hub client (all attached machines)
  const machineRemote = new Map<string, boolean>()        // machineId → authMode === 'remote'
  let activeMachineId: string | null = null               // the RENDERED/interacted machine (confirmed after bindMachine)
  let activeBinding: Machine | null = null
  let deviceMultiMachine = false                          // firmware cap: hold N machines at once vs single-attach
  let deviceId = opts.deviceId              // may be (re)set by device_hello
  let closed = false
  const activeClient = (): HubClient | null => (activeMachineId ? commanderClients.get(activeMachineId) ?? null : null)
  const activeRemote = (): boolean => (activeMachineId ? machineRemote.get(activeMachineId) ?? false : false)
  // Move the ACTIVE (rendered) machine pointer, flipping the `commanderActive` signal so ONLY the newly-active
  // machine's node streams full turn cards; the previous one drops back to recap-only (background badge).
  const setActiveMachine = (machineId: string | null): void => {
    if (activeMachineId === machineId) return
    const prev = activeMachineId
    activeMachineId = machineId
    if (prev) commanderClients.get(prev)?.setActive(false)
    if (machineId) commanderClients.get(machineId)?.setActive(true)
    // Mirror the pointer into the DB so a client with no socket of its own (the mobile app) can show
    // which machine this device is on. Fire-and-forget: the service swallows its own errors, and this
    // must never delay the active-machine switch the user is waiting on.
    if (deviceId) void deviceService.setActiveMachine(deviceId, machineId)
  }
  // Attach/detach a per-machine commander client onto this one device socket. attachHubClient keys clients
  // by (machineId, connId) NOT by socket, so N of them coexist on one socket (each its own up:{machineId} sub).
  const attachCommander = (machineId: string, remote: boolean): HubClient => {
    const c = attachHubClient(device, machineId, 'commander')
    commanderClients.set(machineId, c)
    machineRemote.set(machineId, remote)
    if (deviceId) registry.setClientDeviceId(machineId, c.connId, deviceId)
    logger.info('commander attached machine', { userId, machineId, connId: c.connId })
    return c
  }
  const detachCommander = (machineId: string): void => {
    const c = commanderClients.get(machineId)
    if (!c) return
    registry.clearCommanderVoiceQueue(machineId, c.connId)
    c.detach()
    commanderClients.delete(machineId)
    machineRemote.delete(machineId)
    // Through setActiveMachine rather than assigning the field, so the DB mirror has exactly ONE
    // writer. Runs after the delete above, so its setActive(false) lookup is a no-op on the client
    // we just detached.
    if (activeMachineId === machineId) { setActiveMachine(null); activeBinding = null }
  }
  // Establish the active-machine pointer + binding for a known machineId (attaching a commander client if needed).
  // Used by the auto-restore on reconnect AND by a resumed voice upload, whose finishVoice needs a machine before
  // the device fires voice_end. Mirrors the watchMachines auto-restore; returns false if the machine isn't the user's.
  const restoreActiveMachine = async (machineId: string): Promise<boolean> => {
    if (activeMachineId === machineId) return true
    const binding = await prisma.machine.findUnique({ where: { machineId } })
    if (!binding || binding.deletedAt || binding.userId !== userId) return false
    const remote = binding.authMode === 'remote'
    const c = commanderClients.get(machineId) ?? attachCommander(machineId, remote)
    machineRemote.set(machineId, remote)
    setActiveMachine(machineId)
    activeBinding = binding
    if (deviceId) registry.setClientDeviceId(machineId, c.connId, deviceId)
    return true
  }

  logger.info('device relay open (per-user)', { userId })

  // ── Device presence (per-DEVICE: one key + refresh loop per connection; token-scoped supersede) ───
  // Feeds the web's `devices_status` (webWs.watchDevices). The token makes teardown safe when the
  // same device reconnects before the old socket dies: the new socket owns the key, our conditional
  // clear no-ops and we skip the offline publish.
  const connToken = randomUUID()
  let presenceTimer: NodeJS.Timeout | null = null
  let presenceDeviceId: string | null = null
  let controlUnsub: (() => void) | null = null
  let machineListUnsub: (() => void) | null = null
  // Daily device presence: mark today online on first presence start for this connection, and
  // re-check on the existing 15s refresh tick / on close so a connection spanning UTC midnight
  // gets counted for the new day too (mirrors webWs.ts's touchUserOnlineDay/touchPresence). The
  // guard only advances on a SUCCESSFUL write, so a transient DB failure gets retried on the next
  // tick instead of being silently skipped for the rest of the day.
  let lastDevicePresenceDayKey: string | null = null
  const touchDevicePresence = (id: string, isNewConnection: boolean): void => {
    const now = new Date()
    const dayKey = utcDayKey(now)
    if (!isNewConnection && dayKey === lastDevicePresenceDayKey) return
    touchDeviceOnlineDay(userId, id, now, { isNewConnection })
      .then(() => { lastDevicePresenceDayKey = dayKey })
      .catch((err) => logger.warn('device presence tracking failed', { userId, deviceId: id, error: String(err) }))
  }
  const startPresence = (id: string): void => {
    if (closed || presenceDeviceId === id) return
    presenceDeviceId = id
    void setDevicePresence(id, connToken)
    void publishDeviceStatus(userId, { deviceId: id, online: true })
    touchDevicePresence(id, true)
    if (presenceTimer) clearInterval(presenceTimer)
    presenceTimer = setInterval(() => {
      void setDevicePresence(id, connToken)
      touchDevicePresence(id, false)
    }, DEVICE_PRESENCE_REFRESH_MS)
    // Control channel: a revoke must reach the device even when it's parked on the machine PICKER
    // (no hub attach → the machine-targeted pushDeviceRevoked can't reach it). Deliver the frame the
    // firmware already handles (wipe token + reboot to pair screen), then close the socket so a
    // firmware that misses the frame still falls into its reconnect→401→re-pair path.
    void subscribeDeviceControl(id, (msg) => {
      if (msg.action === 'superseded') {
        // A newer connection for this device authenticated. On an abrupt device-side drop (WiFi blip) our
        // socket is half-open and the hub heartbeat won't reap it for ~75-100s — long after the device has
        // reconnected and asked to resume. Close NOW so closeBoth PARKS the in-flight voice upload before the
        // device's voice_resume arrives (else it finds nothing → reject → lost recording). Ignore our own echo.
        if (msg.by && msg.by === connToken) return
        logger.info('device control: superseded by a newer connection — parking + closing', { userId, deviceId: id })
        closeBoth()
        return
      }
      if (msg.action !== 'revoked') return
      logger.info('device control: revoked — notifying + closing socket', { userId, deviceId: id })
      safeSend(device, { type: 'device_revoked' })
      setTimeout(() => closeBoth(), 250) // let the frame flush before tearing down
    }).then((unsub) => {
      if (closed) { unsub(); return }
      controlUnsub?.()
      controlUnsub = unsub
      void publishDeviceControl(id, { action: 'superseded', by: connToken }) // force any older half-open socket to park now
    })
  }
  if (deviceId) startPresence(deviceId)

  // ── Voice capture state (per connection) ─────────────────────────────────────────────────────────
  let voiceActive = false
  let voiceMode: 'turn' | 'ask' = 'turn'   // 'turn' = STT → dispatch a new message; 'ask' = STT → return transcript only
  let voiceGoal = false                    // 'turn' + goal → dispatch the transcript as a "/goal <text>" command
  let voiceLoop = false                    // 'turn' + loop → dispatch the transcript as a "/loop <text>" command
  let voiceAutonomy: 'plan' | 'auto' = 'auto' // 'turn' autonomy from the device's per-agent Mode control
  let voiceRequestId: string | null = null // the AskUserQuestion requestId, for 'ask' mode
  let voiceAgentId: string | null = null
  let voiceSessionId: string | null = null
  let voiceRoute = false                   // 'turn' + route → let the router pick the agent (voice from Overview)
  let voiceUploadId: string | null = null  // stable per-utterance id; drives park-on-drop / resume (Redis)
  let voiceMachineId: string | null = null   // machine pinned at voice_start; selection changes cannot reroute the utterance
  let voiceQuotaCheck: Promise<VoiceQuotaSnapshot> | null = null
  // Voice router: transcripts awaiting a device route_confirm (medium/low confidence). Keyed by routeId,
  // pruned by TTL on lookup. auto-dispatch (high confidence) never touches this map.
  // The device's mode select turns an utterance into a slash command. Written ONCE because the prefix is
  // applied at three separate dispatch sites (fixed agent, router auto-dispatch, route_confirm) and they
  // drifted apart easily — a second command added inline would have to be remembered in all three.
  //
  // Prepended UNCONDITIONALLY: this side does not know the target engine. On the routed path the agent is
  // picked only after transcription and `voice_route` replies without an engine. The machine-adapter strips
  // what the engine cannot take (see lib/goalCommand.ts) — it is the one place that always knows.
  const withCommand = (text: string, goal: boolean, loop: boolean): string =>
    goal ? `/goal ${text}` : loop ? `/loop ${text}` : text

  const ROUTE_AUTO_THRESHOLD = 0.75
  const ROUTE_PENDING_TTL_MS = 60_000
  const pendingRoutes = new Map<string, { text: string; goal: boolean; loop: boolean; ts: number }>()
  let voiceSr = 16000
  let voiceLang: string = 'en'   // STT language for this utterance (device Settings; see VOICE_LANGS)
  let chunks: Buffer[] = []
  let voiceSize = 0
  let voiceIdleTimer: NodeJS.Timeout | null = null
  let voiceMaxTimer: NodeJS.Timeout | null = null
  let deviceFirmwareVersion: string | null = null
  // Capability: firmware that can run device↔adapter E2EE for DATA RPCs (decrypts encrypted
  // agents_list_result / agent_recent_result / … under the pairwise/group key). Advertised in
  // device_hello (`caps: ['e2ee_data']`). For REMOTE adapter machines this cap is mandatory: without it,
  // backend refuses adapter data with E2EE_REQUIRED instead of terminating RPCs via nodeRequest and
  // reading plaintext. With it, backend RELAYS the RPCs to the machine like webWs; adapter encrypts the
  // result per connId-session and backend sees only ciphertext. See
  // docs/plans/2026-07-15_device-adapter-e2ee-comprehensive.md.
  let deviceE2eeData = false
  // Agent of the in-flight user turn (set on dispatch) so the turn_end log can name it.
  let currentTurnAgentId: string | null = null

  const sendDevice = (obj: unknown): void => {
    const payload = JSON.stringify(obj)
    const ac = activeClient()
    if (ac && activeMachineId && registry.queueCommanderFrame(activeMachineId, ac.connId, obj, payload)) return
    if (device.readyState === WebSocket.OPEN) {
      try { device.send(payload) } catch { /* ignore */ }
    }
  }
  const sendDeviceNow = (obj: unknown): void => safeSend(device, obj)
  const clearVoiceQueue = (): void => {
    const ac = activeClient()
    if (ac && activeMachineId) registry.clearCommanderVoiceQueue(activeMachineId, ac.connId)
  }
  const flushVoiceQueue = (reason: string): void => {
    const ac = activeClient()
    if (!ac || !activeMachineId) return
    const queued = registry.flushCommanderVoiceQueue(activeMachineId, ac.connId)
    if (!queued.length) return
    for (const q of queued) {
      if (device.readyState !== WebSocket.OPEN) break
      try { device.send(q.payload) } catch { /* ignore */ }
    }
    logger.info('commander voice queue flushed', { userId, machineId: activeMachineId, connId: ac.connId, frames: queued.length, reason })
  }
  const clearVoiceTimers = (): void => {
    if (voiceIdleTimer) { clearTimeout(voiceIdleTimer); voiceIdleTimer = null }
    if (voiceMaxTimer) { clearTimeout(voiceMaxTimer); voiceMaxTimer = null }
  }
  const discardVoiceUpload = (): void => {
    clearVoiceTimers()
    voiceActive = false
    chunks = []
    voiceSize = 0
    voiceMode = 'turn'
    voiceRequestId = null
    voiceAgentId = null
    voiceSessionId = null
    voiceRoute = false
    voiceUploadId = null
    voiceMachineId = null
    voiceQuotaCheck = null
  }
  const abortVoiceUpload = (reason: 'voice_idle_timeout' | 'voice_max_timeout' | 'voice_restarted'): void => {
    if (!voiceActive) { clearVoiceTimers(); return }
    const bytes = voiceSize
    const agentId = voiceAgentId
    discardVoiceUpload()
    flushVoiceQueue(reason)
    logger.warn('commander voice upload aborted', { userId, machineId: activeMachineId, agentId, bytes, reason })
  }
  const armVoiceIdleTimer = (): void => {
    if (voiceIdleTimer) clearTimeout(voiceIdleTimer)
    voiceIdleTimer = setTimeout(() => abortVoiceUpload('voice_idle_timeout'), VOICE_CHUNK_IDLE_TIMEOUT_MS)
    voiceIdleTimer.unref()
  }
  const armVoiceTimers = (): void => {
    clearVoiceTimers()
    armVoiceIdleTimer()
    voiceMaxTimer = setTimeout(() => abortVoiceUpload('voice_max_timeout'), VOICE_UPLOAD_MAX_MS)
    voiceMaxTimer.unref()
  }

  // ── Live machine-list feed for the device picker (ported from webWs.watchAgents; enriched name+authMode) ─
  const statusSubs = new Map<string, () => void>()
  // Per-machine identity, refreshed by every watchMachines pass. The subscribeUp closure below reads
  // through this map instead of capturing its machine row: subscriptions are installed once and never
  // replaced (`if (statusSubs.has(id)) continue`), so a captured row went stale on rename and every
  // partial status frame reverted the machine's name to the one it had when the device connected.
  const machineMeta = new Map<string, MachineMeta>()
  // Desktop-app presence asserted by the adapter (see machine_app_status in adapterWs).
  const machineApp = new Map<string, { engine: string; state: string }>()
  const machineRow = (
    machineId: string,
    online: boolean,
    extra: { status?: MachineLifecycleStatus; reason?: string } = {},
  ): MachineStatus =>
    buildMachineRow(machineId, online, machineMeta.get(machineId), machineApp.get(machineId), extra)
  const sendMachines = (statuses: MachineStatus[], full = false): void => {
    if (device.readyState !== WebSocket.OPEN || (!full && statuses.length === 0)) return
    sendDevice({ type: 'machines_status', payload: { ...(full ? { full: true } : {}), statuses } })
  }
  let watchGen = 0
  const watchMachines = async (): Promise<void> => {
    const gen = ++watchGen
    const machines = await deviceService.machinesForUser(userId, opts.autonomousEnv) // ALWAYS re-derived from the DB
    if (gen !== watchGen || closed) return
    const wanted = new Map(machines.map((f) => [f.machineId, f]))
    for (const [id, unsub] of statusSubs) {
      if (!wanted.has(id)) { unsub(); statusSubs.delete(id) } // machine deleted
    }
    // Drop commander clients for machines that no longer exist (deleted/unbound). detachCommander clears
    // activeMachineId when the removed machine was the active/rendered one.
    for (const id of [...commanderClients.keys()]) {
      if (!wanted.has(id)) {
        if (id === activeMachineId) { selectGen++; discardVoiceUpload(); clearVoiceQueue() }
        detachCommander(id)
      }
    }
    for (const [id, f] of wanted) machineMeta.set(id, { name: f.name, authMode: f.authMode, remote: f.remote })
    for (const id of [...machineMeta.keys()]) if (!wanted.has(id)) { machineMeta.delete(id); machineApp.delete(id) }
    for (const [id] of wanted) {
      if (statusSubs.has(id)) continue
      // Bus subscriptions are refcounted — co-existing with the commander's up:{id} sub is fine.
      const unsub = await subscribeUp(id, (msg) => {
        const fr = msg.frame as { type?: string; payload?: { online?: boolean; status?: MachineLifecycleStatus; reason?: string; engine?: string; state?: string } }
        // Desktop-app presence: one single-row status frame, the same partial path node_status uses.
        // Deliberately NOT publishDeviceMachineListChanged — that re-queries Mongo per device and
        // pushes machines_changed to every browser tab, so quitting Cursor would cost a DB round trip.
        if (fr?.type === 'machine_app_status') {
          const engine = fr.payload?.engine
          const state = fr.payload?.state
          if (!engine || !state) return
          machineApp.set(id, { engine, state })
          sendMachines([machineRow(id, true)])
          return
        }
        if (fr?.type === 'node_status') {
          const online = fr.payload?.online === true
          // A machine that went offline has no app state; drop it so a reconnect must re-assert.
          if (!online) machineApp.delete(id)
          sendMachines([machineRow(id, online, { status: fr.payload?.status, reason: fr.payload?.reason })])
          // The picker list is not this frame's only consumer. The Overview's "Node offline" guide is driven
          // by a `node_status` addressed to the DEVICE, and that was only ever sent by seedNodeStatus — which
          // runs on bindMachine and nowhere else. So a remote machine that dropped and came back updated the
          // picker while the device kept waiting for an online flip that never arrived: it sat in the join
          // guide, telling the user to run `harness join` against a machine that was already running, until
          // they re-picked it by hand. Mirror the flip for whichever machine is being rendered.
          if (id === activeMachineId) {
            const status = fr.payload?.status
            sendDevice({ type: 'node_status', payload: { online, status: online ? 'running' : !status || status === 'unknown' ? 'offline' : status } })
          }
        }
      })
      if (closed || gen !== watchGen) { unsub(); return }
      statusSubs.set(id, unsub)
    }
    // Multi-attach: hold a `commander` client on EVERY machine so each machine's node runs its recap and can
    // push its turn-done to the device (badge) even while another machine is active/rendered. Gated on the
    // firmware cap; without it only the selected machine is attached (via bindMachine), exactly like today.
    if (deviceMultiMachine && !closed) {
      for (const [id, f] of wanted) {
        if (commanderClients.has(id)) { machineRemote.set(id, f.remote); continue }
        attachCommander(id, f.remote)
      }
    }
    // Seed the full current picture (presence keys = source of truth) so the list is right immediately.
    const statuses = await Promise.all(
      [...wanted.values()].map(async (f) => {
        const online = !!(await getAgentPresence(f.machineId))
        const status = online ? 'running' : await getMachineLifecycleStatus(f.machineId)
        // Seed the app state from Redis too, so a device that connects while the Mac has been up for
        // an hour sees "Cursor open" immediately instead of waiting for the next transition. Issued
        // inside the existing Promise.all, so it adds no wall-clock latency.
        const app = online ? await getMachineAppState(f.machineId) : null
        if (app) machineApp.set(f.machineId, app); else machineApp.delete(f.machineId)
        return machineRow(f.machineId, online, { status: status === 'unknown' ? 'offline' as const : status })
      }),
    )
    if (gen === watchGen && !closed) sendMachines(statuses, true)

    // Auto-restore the active machine on (re)connect. A multi_machine device renders agents by attaching to
    // every machine WITHOUT sending machine_select, so `activeMachineId` would otherwise stay null and both voice
    // (route AND fixed-agent) and RPCs fail with "no machine selected". Rebind the device's last-selected
    // machine if it's still one of the user's machines. Single-attach firmware still sets it via its own
    // machine_select, and this no-ops once a machine is active.
    if (!activeMachineId && deviceId && gen === watchGen && !closed) {
      const last = await getDeviceLastMachine(deviceId)
      if (last && wanted.has(last)) {
        const binding = await prisma.machine.findUnique({ where: { machineId: last } })
        if (binding && !binding.deletedAt && binding.billingStatus !== 'pending' && binding.billingStatus !== 'suspended' && binding.userId === userId && !activeMachineId && gen === watchGen && !closed) {
          // LIGHTWEIGHT restore: the machine is already attached (multi-attach) and rendering, so just move the
          // active pointer + binding. Do NOT ensureMachineReady here — that provision-wakes via the manager and
          // would make reconnect fragile (a transient manager-WS blip would leave activeMachineId null). A real
          // wake still runs on the next turn dispatch (ensureActiveReady) if the node is actually stopped.
          const remote = binding.authMode === 'remote'
          const c = commanderClients.get(last) ?? attachCommander(last, remote)
          machineRemote.set(last, remote)
          setActiveMachine(last)
          activeBinding = binding
          if (deviceId) registry.setClientDeviceId(last, c.connId, deviceId)
          logger.info('commander machine auto-restored on connect', { userId, machineId: last })
        }
      }
    }
  }

  // ── Machine selection (ported from webWs.bindAgent; + remote guard + deviceId re-tag) ───────────────
  let selectGen = 0
  const seedNodeStatus = (machineId: string): void => {
    void getAgentPresence(machineId).then((mgr) => {
      if (device.readyState === WebSocket.OPEN && activeMachineId === machineId) {
        const online = !!mgr
        void getMachineLifecycleStatus(machineId).then((status) => {
          if (device.readyState === WebSocket.OPEN && activeMachineId === machineId) {
            sendDevice({ type: 'node_status', payload: { online, status: online ? 'running' : status === 'unknown' ? 'offline' : status } })
          }
        })
      }
    })
  }
  const bindMachine = async (machineIdRaw: unknown): Promise<void> => {
    if (typeof machineIdRaw !== 'string' || !machineIdRaw) return
    const machineId = machineIdRaw
    const gen = ++selectGen
    const binding = await prisma.machine.findUnique({ where: { machineId } })
    if (closed || gen !== selectGen) return // superseded by a newer select
    if (!binding || binding.deletedAt || binding.userId !== userId) {
      logger.warn('commander machine_select rejected', { userId, machineId })
      sendDeviceNow({ type: 'machine_select_error', payload: { machineId, error: 'NOT_YOUR_MACHINE' } })
      return
    }
    // Same plane, or nothing. The machine list is already filtered by environment, so reaching here with a
    // mismatch means the id was guessed or is stale — either way the token that authenticated this socket
    // cannot drive that machine, and `webWs` has always refused it for the same reason.
    if (binding.autonomousEnv !== opts.autonomousEnv) {
      logger.warn('commander machine_select rejected — environment mismatch', { userId, machineId })
      sendDeviceNow({ type: 'machine_select_error', payload: { machineId, error: 'MACHINE_ENV_MISMATCH' } })
      return
    }
    if (binding.billingStatus === 'pending') {
      sendDeviceNow({ type: 'machine_select_error', payload: { machineId, error: 'MACHINE_PAYMENT_PENDING' } })
      return
    }
    if (binding.billingStatus === 'suspended') {
      sendDeviceNow({ type: 'machine_select_error', payload: { machineId, error: 'MACHINE_SUBSCRIPTION_REQUIRED' } })
      return
    }
    try {
      await ensureMachineReady(binding)
    } catch (err) {
      if (!closed && gen === selectGen) {
        const code = err instanceof Error && 'code' in err ? String((err as { code?: unknown }).code) : 'MACHINE_START_FAILED'
        sendDeviceNow({ type: 'machine_select_error', payload: { machineId, error: code } })
      }
      return
    }
    if (closed || gen !== selectGen) return
    // Same-machine reselect still wakes a stopped machine, but preserves the existing commander connId.
    if (machineId === activeMachineId && commanderClients.has(machineId)) {
      activeBinding = binding
      sendDeviceNow({ type: 'machine_selected', payload: { machineId } })
      seedNodeStatus(machineId)
      return
    }
    // Voice belongs to the previously-active machine — discard it on switch.
    discardVoiceUpload()
    clearVoiceQueue()
    // Single-attach firmware (no multi_machine cap): only ONE machine is held at a time, so detach every other
    // machine on switch (today's behavior). Multi-machine firmware keeps ALL machines attached (watchMachines holds
    // them for their recap/badge) and just moves the ACTIVE pointer.
    if (!deviceMultiMachine) {
      for (const id of [...commanderClients.keys()]) if (id !== machineId) detachCommander(id)
    }
    // Ensure THIS machine is attached as a commander. Multi-machine: watchMachines already attached it on connect,
    // but a select can race ahead → attach on demand. Remote machines (machine-adapter) attach the SAME way as
    // self/managed: the device is a 'commander' hub client on down:{machineId}, the adapter occupies the node
    // side, and device↔adapter content is end-to-end encrypted (E2EE frames relay through the hub as
    // ciphertext). See docs/design/e2e-encrypted-client-channel.md.
    const remote = binding.authMode === 'remote'
    const c = commanderClients.get(machineId) ?? attachCommander(machineId, remote)
    machineRemote.set(machineId, remote)
    setActiveMachine(machineId) // marks this machine's commander active (stream), previous one inactive (recap-only)
    activeBinding = binding
    // Remember this selection so a reconnect (backend restart / device re-flash / WS drop) restores the
    // active machine instead of leaving it null — see the auto-restore in watchMachines.
    if (deviceId) void setDeviceLastMachine(deviceId, machineId)
    // Re-tag this connection's deviceId so a revoke can target it (connId is stable per machine now).
    if (deviceId) registry.setClientDeviceId(machineId, c.connId, deviceId)
    logger.info('commander selected machine', { userId, machineId, connId: c.connId })
    sendDeviceNow({ type: 'machine_selected', payload: { machineId } })
    seedNodeStatus(machineId)
  }

  const closeBoth = (): void => {
    if (closed) return
    closed = true
    releaseLiveness()
    if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null }
    if (controlUnsub) { controlUnsub(); controlUnsub = null }
    if (machineListUnsub) { machineListUnsub(); machineListUnsub = null }
    if (presenceDeviceId) {
      const id = presenceDeviceId
      // Conditional clear: only publish offline if the key is really gone (a superseding reconnect
      // keeps its own key → we stay silent). lastSeenAt = the moment the device actually went away.
      const seenAt = new Date()
      void clearDevicePresence(id, connToken).then((gone) => {
        if (gone) void publishDeviceStatus(userId, { deviceId: id, online: false, lastSeenAt: seenAt.toISOString() })
      })
      void prisma.deviceBinding.update({ where: { deviceId: id }, data: { lastSeenAt: seenAt } }).catch(() => { /* best effort */ })
      touchDevicePresence(id, false)
    }
    for (const [, unsub] of statusSubs) unsub()
    statusSubs.clear()
    // Resumable upload: if a streamed recording is still in flight (no voice_end seen) and the firmware sent
    // an uploadId, PARK it in Redis (grace ~60s) instead of discarding, so the device's reconnect can resume
    // it — possibly on a different backend instance. Otherwise discard as before.
    if (voiceActive && deviceId && voiceUploadId) {
      const meta = {
        uploadId: voiceUploadId, mode: voiceMode, route: voiceRoute, goal: voiceGoal, loop: voiceLoop, autonomy: voiceAutonomy,
        agentId: voiceAgentId, sessionId: voiceSessionId, requestId: voiceRequestId, sr: voiceSr,
        lang: voiceLang, size: voiceSize, machineId: voiceMachineId ?? activeMachineId,
      }
      const pcm = Buffer.concat(chunks)
      clearVoiceTimers(); voiceActive = false
      void parkVoiceUpload(deviceId, meta, pcm)
      logger.info('commander voice parked (WS drop mid-stream)', { userId, deviceId, uploadId: voiceUploadId, bytes: pcm.length })
    } else {
      discardVoiceUpload()
    }
    clearVoiceQueue()
    for (const [, c] of commanderClients) c.detach() // drop commander on EVERY attached machine (count → 0)
    commanderClients.clear()
    machineRemote.clear()
    activeMachineId = null
    // Polite close first (revoke needs its frame to land), then force it: on a half-open socket the close
    // handshake never completes and ws would hold the fd until its own timeout.
    try { device.close() } catch { /* ignore */ }
    setTimeout(() => {
      if (device.readyState !== WebSocket.CLOSED) { try { device.terminate() } catch { /* ignore */ } }
    }, CLOSE_GRACE_MS).unref?.()
  }

  // ── Device-native frames (synchronous — must stay in sync with the binary PCM frames) ─────────────
  const startVoice = (msg: CommanderMsg): void => {
    if (voiceActive) abortVoiceUpload('voice_restarted')
    voiceActive = true
    voiceMode = msg.type === 'voice_ask_start' ? 'ask' : 'turn'
    voiceGoal = voiceMode === 'turn' && msg.goal === true   // ask mode is never a goal
    // goal wins if a client somehow sets both — they are one control on the device, and a defined
    // precedence beats an arbitrary one.
    voiceLoop = voiceMode === 'turn' && msg.loop === true && !voiceGoal
    voiceAutonomy = msg.mode === 'plan' ? 'plan' : 'auto'   // device per-agent Mode (default auto/bypass)
    voiceRequestId = msg.requestId ?? null
    voiceAgentId = msg.agentId ?? null
    voiceSessionId = msg.sessionId || null
    voiceRoute = voiceMode === 'turn' && msg.route === true   // Overview voice → router picks the agent
    voiceUploadId = typeof msg.uploadId === 'string' && msg.uploadId ? msg.uploadId : randomUUID()
    voiceMachineId = activeMachineId
    voiceSr = clampSr(msg.sr)
    // Was a two-way en/vi clamp, which silently rewrote every other language the device offered to 'vi'.
    // normalizeLang gates on the SAME list Deepgram enforces; firmware older than the picker sends no
    // `lang` at all and lands on the default.
    voiceLang = normalizeLang(msg.lang)
    chunks = []; voiceSize = 0
    // A fresh utterance invalidates any parked partial from a previous (abandoned) recording on this device.
    if (deviceId) void evictVoiceUpload(deviceId)
    const ac = activeClient()
    if (ac && activeMachineId) registry.startCommanderVoiceQueue(activeMachineId, ac.connId)
    armVoiceTimers()
    logger.info('commander voice_start', {
      userId,
      machineId: voiceMachineId,
      mode: voiceMode,
      goal: voiceGoal,
      loop: voiceLoop,
      agentId: voiceAgentId,
      sr: voiceSr,
      lang: voiceLang,
      uploadId: voiceUploadId,
    })
    const startedUploadId = voiceUploadId
    const startedMachineId = voiceMachineId
    const startedBinding = activeBinding && activeBinding.machineId === startedMachineId ? activeBinding : null
    voiceQuotaCheck = startedMachineId ? voiceQuotaService.snapshotForMachine(startedMachineId) : null
    if (voiceQuotaCheck) {
      void voiceQuotaCheck.then((quota) => {
        if (!voiceActive || voiceUploadId !== startedUploadId) return
        sendDeviceNow({ type: 'voice_quota_status', payload: { ...quota, uploadId: startedUploadId } })
        if (quota.limitSeconds > 0 && quota.remainingSeconds === 0) {
          discardVoiceUpload()
          flushVoiceQueue('voice_quota_exceeded')
          sendDeviceNow({ type: 'voice_quota_exceeded', payload: { ...quota, uploadId: startedUploadId } })
          return
        }
        // A real voice turn wakes its machine only after quota passes, so an exhausted machine stays Idle.
        if (msg.type === 'voice_start' && startedBinding) {
          void ensureMachineReady(startedBinding).catch(() => { /* ensureMachineReady already logs */ })
        }
      }).catch((err) => {
        if (!voiceActive || voiceUploadId !== startedUploadId) return
        discardVoiceUpload()
        flushVoiceQueue('voice_quota_unavailable')
        logger.warn('commander voice quota precheck failed', {
          userId,
          machineId: startedMachineId,
          error: errMsg(err),
        })
        sendDeviceNow({ type: 'error', message: 'VOICE_QUOTA_UNAVAILABLE' })
      })
    }
  }

  // Device reconnected mid-stream and wants to resume its parked upload. Rehydrate this (fresh) connection's
  // voice state from Redis and tell the device the byte offset we already have so it re-sends only the gap.
  // Async (Redis read) — safe because the device WAITS for voice_resume_ack before re-sending any PCM, so no
  // binary frame races ahead of voiceActive being set here. Runs AFTER the reconnect's machine_select, so
  // activeMachineId is set for the eventual finishVoice dispatch.
  const handleVoiceResume = async (msg: CommanderMsg): Promise<void> => {
    const uploadId = typeof msg.uploadId === 'string' ? msg.uploadId : ''
    if (!uploadId || !deviceId) { sendDeviceNow({ type: 'voice_resume_reject', uploadId }); return }
    const parked = await resumeVoiceUpload(deviceId)
    if (!parked || parked.meta.uploadId !== uploadId) {
      sendDeviceNow({ type: 'voice_resume_reject', uploadId })
      if (parked) void evictVoiceUpload(deviceId)   // stale/mismatched entry → drop it
      logger.info('commander voice_resume rejected', { userId, deviceId, uploadId, found: !!parked })
      return
    }
    const m = parked.meta
    voiceActive = true
    voiceMode = m.mode; voiceRoute = m.route; voiceGoal = m.goal; voiceLoop = m.loop === true; voiceAutonomy = m.autonomy
    voiceAgentId = m.agentId; voiceSessionId = m.sessionId; voiceRequestId = m.requestId
    voiceSr = m.sr; voiceLang = m.lang; voiceUploadId = uploadId
    voiceMachineId = m.machineId
    chunks = [parked.pcm]; voiceSize = parked.pcm.length
    armVoiceTimers()   // fresh idle/max timers on this connection; incoming chunks refresh the idle one
    // This fresh relay() closure has no active machine yet (the reconnect's machine_select/auto-restore is async).
    // Restore it from the parked meta.machineId BEFORE the ack — the device gates voice_end on the ack, so doing
    // it now guarantees finishVoice has a machine (else it throws NO_MACHINE_SELECTED and loses the whole ramble).
    if (!activeMachineId && m.machineId) await restoreActiveMachine(m.machineId).catch((err) => logger.warn('voice_resume machine restore failed', { userId, deviceId, machineId: m.machineId, error: errMsg(err) }))
    voiceQuotaCheck = voiceMachineId ? voiceQuotaService.snapshotForMachine(voiceMachineId) : null
    if (voiceQuotaCheck) {
      try {
        const quota = await voiceQuotaCheck
        sendDeviceNow({ type: 'voice_quota_status', payload: { ...quota, uploadId } })
        if (quota.limitSeconds > 0 && quota.remainingSeconds === 0) {
          discardVoiceUpload()
          void evictVoiceUpload(deviceId)
          sendDeviceNow({ type: 'voice_quota_exceeded', payload: { ...quota, uploadId } })
          return
        }
      } catch (err) {
        discardVoiceUpload()
        void evictVoiceUpload(deviceId)
        logger.warn('commander voice_resume quota check failed', {
          userId,
          deviceId,
          machineId: m.machineId,
          error: errMsg(err),
        })
        sendDeviceNow({ type: 'voice_resume_reject', uploadId })
        sendDeviceNow({ type: 'error', message: 'VOICE_QUOTA_UNAVAILABLE' })
        return
      }
    }
    sendDeviceNow({ type: 'voice_resume_ack', uploadId, offset: voiceSize })
    logger.info('commander voice_resume', { userId, deviceId, uploadId, offset: voiceSize, machineId: activeMachineId })
    // The Redis entry is kept (not evicted) so if THIS connection also drops, closeBoth re-parks the fuller
    // buffer over it. finishVoice evicts on completion; a fresh voice_start evicts on a new utterance.
  }

  const handleHello = (msg: CommanderMsg): void => {
    const payload = payloadOf(msg)
    deviceFirmwareVersion = typeof payload.firmwareVersion === 'string' && payload.firmwareVersion ? payload.firmwareVersion : null
    // E2EE-for-data capability (firmware that decrypts encrypted *_result frames). When present we
    // relay agent RPCs to the machine instead of reading them at the backend (see deviceE2eeData decl).
    deviceE2eeData = Array.isArray(payload.caps) && payload.caps.includes('e2ee_data')
    // Multi-machine cap: firmware that holds N machines at once (routes frames by the machineId tag + badges a
    // background machine's turn-done). Without it we stay single-attach. device_hello arrives AFTER the
    // connect-time watchMachines ran, so flipping the cap here needs a re-run to attach every machine.
    const wasMultiMachine = deviceMultiMachine
    deviceMultiMachine = Array.isArray(payload.caps) && payload.caps.includes('multi_machine')
    // Prefer the token-resolved deviceId (trusted); fall back to the self-reported one for legacy fw.
    const reported = typeof payload.deviceId === 'string' && payload.deviceId ? payload.deviceId : null
    if (reported && !deviceId) deviceId = reported
    if (deviceId) startPresence(deviceId) // legacy fw path: deviceId only known after hello
    if (deviceId) for (const [fid, c] of commanderClients) registry.setClientDeviceId(fid, c.connId, deviceId)
    // Snapshot what the device just reported, so a client with no socket of its own (the mobile app)
    // can render firmware/chip/WiFi over REST. BOTH auth modes reach relay(), so this one call covers
    // the whole fleet — unlike attachSdsBridgeToSocket's own hello listener, which is SDS-only and
    // exists to feed the MQTT `info` payload.
    // `ssid`/`rssi` need firmware that puts them in device_hello; until then they simply never appear
    // and recordHello leaves the columns untouched rather than blanking them.
    if (deviceId) {
      const rssiRaw = typeof payload.rssi === 'number' ? payload.rssi
        : typeof payload.rssi === 'string' ? Number(payload.rssi)
          : null
      void deviceService.recordHello({
        deviceId,
        firmwareVersion: deviceFirmwareVersion,
        chip: typeof payload.chip === 'string' ? payload.chip : null,
        ssid: typeof payload.ssid === 'string' ? payload.ssid : null,
        rssi: rssiRaw !== null && Number.isFinite(rssiRaw) ? rssiRaw : null,
      })
    }
    logger.info('commander device_hello', { userId, firmwareVersion: deviceFirmwareVersion, deviceId, multiMachine: deviceMultiMachine })
    if (deviceMultiMachine && !wasMultiMachine) void watchMachines().catch((err) => logger.warn('device watchMachines failed', { userId, error: errMsg(err) }))
  }

  // ── Ordered (machine-select / RPC / chat) frames ────────────────────────────────────────────────────
  const ensureActiveReady = async (): Promise<void> => {
    if (!activeBinding) throw new Error('NO_MACHINE_SELECTED')
    await ensureMachineReady(activeBinding)
  }

  const handleFrame = async (msg: CommanderMsg): Promise<void> => {
    const type = msg.type
    if (type === 'machine_select') { await bindMachine(payloadOf(msg).machineId); return }
    if (type === 'machine_deselect') {
      selectGen++ // cancel any in-flight bindMachine
      discardVoiceUpload()
      clearVoiceQueue()
      // Multi-machine: stop RENDERING a machine but stay attached to all (background badges keep flowing) —
      // drop the active pointer so no machine streams. Single-attach: detach the one held machine (today).
      setActiveMachine(null)
      activeBinding = null
      if (!deviceMultiMachine) for (const id of [...commanderClients.keys()]) detachCommander(id)
      return
    }
    if (type === 'machines_watch') { await watchMachines(); return }
    if (type === 'route_confirm') {
      // The device confirmed (or corrected) a router pick that wasn't auto-dispatched. Dispatch the held
      // transcript to the chosen agent, resuming its latest session (same path as a fixed-agent voice turn).
      const p = payloadOf(msg)
      const routeId = typeof p.routeId === 'string' ? p.routeId : ''
      const agentId = typeof p.agentId === 'string' ? p.agentId : ''
      const now = Date.now()
      for (const [k, v] of pendingRoutes) if (now - v.ts > ROUTE_PENDING_TTL_MS) pendingRoutes.delete(k)
      const pending = routeId ? pendingRoutes.get(routeId) : undefined
      if (!pending) { sendDeviceNow({ type: 'error', message: 'route expired' }); return }
      pendingRoutes.delete(routeId)
      if (!agentId || agentId === 'new') { sendDeviceNow({ type: 'error', message: 'route needs an agent' }); return } // 'new' (create-agent) is a later phase
      const ac = activeClient()
      if (!ac) { sendDeviceNow({ type: 'error', message: 'NO_MACHINE_SELECTED' }); return }
      try {
        await ensureActiveReady()
        sendDeviceNow({ type: 'commander_event', agentId, payload: { kind: 'processing' } })
        currentTurnAgentId = agentId
        const confirmContent = withCommand(pending.text, pending.goal, pending.loop === true)
        ac.sendDown({ type: 'message', payload: { content: confirmContent, agentId, mode: 'auto', resumeLatest: true } } as Frame)
        sendDeviceNow({ type: 'dispatched' })
        logger.info('commander route_confirm dispatch', { userId, machineId: activeMachineId, agentId })
      } catch (err) {
        sendDeviceNow({ type: 'error', message: errMsg(err) })
      }
      return
    }
    // User actions must survive an idle stop. The strict frameChain holds them until the node has
    // re-registered; background multi-machine E2EE frames intentionally bypass this active-machine wake.
    if (type === 'message' || type === 'agents_list' || type === 'agent_create' || type === 'agent_recent' || type === 'agent_update' || type === 'models_list') {
      try {
        await ensureActiveReady()
      } catch (err) {
        const requestId = payloadOf(msg).requestId
        if (typeof requestId === 'string' && type !== 'message') {
          sendDeviceNow({ type: `${type}_result`, payload: { requestId, error: errMsg(err) } })
        } else {
          sendDeviceNow({ type: 'error', message: errMsg(err) })
        }
        return
      }
    }
    if (type === 'agents_list' || type === 'agent_create' || type === 'agent_recent' || type === 'agent_update' || type === 'models_list') {
      // Only remote adapter machines may use the E2EE relay path. Local managed/self machines still answer
      // through backend-owned nodeRequest; relaying these RPCs to agent-node leaves the device hanging
      // because that node path does not implement the device's agents_list RPC contract.
      //
      // Judged on the TARGET machine, not the active one. A multi_machine device (the harness daemon
      // driving a cabled dial) shows every machine's agents at once and tags each RPC with the machine it
      // is about, so reading `activeRemote()` here would send a question about machine B down machine A's
      // path — and it would be ANSWERED, with A's agents, which is indistinguishable from B having them.
      if (!targetRemote(msg)) { await handleAgentRpc(msg); return }

      // Remote adapter machines: never use backend-terminated nodeRequest here. Without E2EE-data support
      // the old plaintext bridge would let backend read adapter data, so fail closed.
      if (!deviceE2eeData) {
        const requestId = payloadOf(msg).requestId
        sendDevice({ type: `${type}_result`, payload: { requestId, error: 'E2EE_REQUIRED' } })
        return
      }
      // E2EE-capable firmware on remote adapter machines: relay the RPC to the machine like webWs
      // (fall through to sendDown below). The adapter encrypts content-bearing results per connId-session.
    }
    if (type === 'message') {
      const p = payloadOf(msg)
      currentTurnAgentId = (typeof p.agentId === 'string' ? p.agentId : undefined) ?? (typeof msg.agentId === 'string' ? msg.agentId : null)
      logger.info('commander turn_start', { userId, machineId: activeMachineId, agentId: currentTurnAgentId, source: 'typed' })
    }
    // Multi-attach: a frame the device explicitly targets at a specific machine (eager E2EE hello/handshake to a
    // BACKGROUND machine, so its recaps can be decrypted without the user opening it) routes to THAT machine's
    // node — not the active one. Ownership-safe: commanderClients only holds this user's attached machines. Only
    // device-tagged frames (e2e_*) carry msg.machineId; message/RPC never do, so the active path is unaffected.
    if (typeof msg.machineId === 'string' && commanderClients.has(msg.machineId)) {
      commanderClients.get(msg.machineId)!.sendDown(msg as Frame)
      return
    }
    const ac = activeClient()
    if (ac) { ac.sendDown(msg as Frame); return } // normal commander frame → down to the ACTIVE node
    // No machine selected: fast-fail RPCs (echo the requestId) so the device's request() doesn't hang.
    const requestId = payloadOf(msg).requestId
    if (typeof requestId === 'string' && typeof type === 'string') {
      sendDeviceNow({ type: `${type}_result`, payload: { requestId, error: 'NO_MACHINE_SELECTED' } })
    }
  }

  // Device → backend. Binary is voice PCM (buffered for STT); JSON is routed by type. Voice + hello are
  // synchronous; machine-select / RPC / chat go through a strict in-order chain (bindMachine awaits a DB
  // lookup, and a machine_select followed immediately by agents_list must not be routed by the PREVIOUS
  // selection — the same leak webWs guards against).
  let frameChain: Promise<void> = Promise.resolve()
  device.on('message', (raw: RawData, isBinary: boolean) => {
    if (isBinary) {
      if (voiceActive) {
        const buf = raw as Buffer
        if (voiceSize + buf.length <= MAX_PCM) {
          chunks.push(buf)
          voiceSize += buf.length
          armVoiceIdleTimer()
        }
      }
      return // audio is NOT forwarded upstream; non-voice binary is dropped
    }
    let msg: CommanderMsg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    if (msg.type === 'voice_start' || msg.type === 'voice_ask_start') { startVoice(msg); return }
    if (msg.type === 'voice_end') { void finishVoice(); return }
    if (msg.type === 'voice_resume') { void handleVoiceResume(msg); return }
    if (msg.type === 'device_hello') { handleHello(msg); return }
    frameChain = frameChain
      .then(() => handleFrame(msg))
      .catch((err) => logger.warn('commander frame failed', { userId, type: msg.type, error: errMsg(err) }))
  })
  device.on('close', closeBoth)
  device.on('error', closeBoth)

  // Seed the live machine list right away so the picker is instant when the user opens Settings → Machines;
  // the device then drives selection with machine_select (or its saved-machine auto-select on connect).
  void subscribeDeviceMachineListChanged(userId, (msg) => {
    logger.info('device machine list changed — refreshing picker', { userId, reason: msg.reason })
    void watchMachines().catch((err) => logger.warn('device watchMachines failed', { userId, error: errMsg(err) }))
  }).then((unsub) => {
    if (closed) { unsub(); return }
    machineListUnsub = unsub
  })
  void watchMachines().catch((err) => logger.warn('device watchMachines failed', { userId, error: errMsg(err) }))

  async function finishVoice(): Promise<void> {
    if (!voiceActive) return
    clearVoiceTimers()
    voiceActive = false
    const pcm = Buffer.concat(chunks); chunks = []; voiceSize = 0
    if (deviceId && voiceUploadId) void evictVoiceUpload(deviceId)   // finalizing → the parked copy is obsolete
    const uploadId = voiceUploadId ?? randomUUID()
    const quotaCheck = voiceQuotaCheck
    const machineId = voiceMachineId ?? activeMachineId
    voiceUploadId = null
    voiceMachineId = null
    voiceQuotaCheck = null
    const agentId = voiceAgentId
    const sessionId = voiceSessionId
    const sr = voiceSr
    const lang = voiceLang
    const mode = voiceMode
    const goal = voiceGoal
    const loop = voiceLoop
    const autonomy = voiceAutonomy
    const requestId = voiceRequestId
    const route = voiceRoute
    voiceMode = 'turn'; voiceGoal = false; voiceLoop = false; voiceAutonomy = 'auto'; voiceRequestId = null; voiceRoute = false
    const ac = machineId ? commanderClients.get(machineId) ?? null : null
    const remote = machineId ? machineRemote.get(machineId) ?? false : false
    logger.info('commander voice_end', { userId, machineId, mode, agentId, bytes: pcm.length, sr })
    flushVoiceQueue('voice_end')
    try {
      if (!machineId || !ac) throw new Error('no machine selected')
      if (!route && !agentId) throw new Error('no agentId')
      // Duration-based floor (~300 ms) — works at any sample rate; sub-300ms clips hallucinate.
      if (pcm.length < ((sr * 2) / 1000) * 300) { sendDeviceNow({ type: 'too_short', requestId }); return }
      if (!route && !remote) {
        const owned = await prisma.machineAgent.findFirst({ where: { machineId, agentId: agentId! } })
        if (!owned) throw new Error('agent not on this machine')
      }
      if (quotaCheck) await quotaCheck
      const voiceBinding = activeBinding?.machineId === machineId
        ? activeBinding
        : await prisma.machine.findUnique({ where: { machineId } })
      if (!voiceBinding || voiceBinding.deletedAt) throw new Error('machine not found')
      const durationMs = pcm.length / ((sr * 2) / 1000)
      const reservation = await voiceQuotaService.reserve(machineId, uploadId, durationMs)
      if (reservation.state !== 'reserved') {
        logger.info('commander duplicate voice upload ignored', {
          userId,
          machineId,
          uploadId,
          state: reservation.state,
        })
        sendDeviceNow({ type: 'empty' })
        return
      }
      const transcribeReserved = async (): Promise<string> => {
        try {
          const text = await transcribe(pcm, sr, lang)
          await voiceQuotaService.commit(uploadId)
          return text
        } catch (err) {
          await voiceQuotaService.release(uploadId).catch(() => { /* worker releases stale pending */ })
          throw err
        }
      }

      // Dispatch a transcribed turn to `targetId`, resuming its latest session unless a specific one is
      // given. Re-asserts the "processing" indicator on that agent while the turn's own events start.
      const dispatchTurn = async (targetId: string, content: string, sess: string | null, aut: 'plan' | 'auto'): Promise<void> => {
        sendDeviceNow({ type: 'commander_event', agentId: targetId, dbSessionId: sess ?? undefined, payload: { kind: 'processing' } })
        const payload = sess
          ? { content, agentId: targetId, mode: aut, sessionId: sess }
          : { content, agentId: targetId, mode: aut, resumeLatest: true }
        currentTurnAgentId = targetId
        await ensureMachineReady(voiceBinding)
        ac.sendDown({ type: 'message', payload } as Frame)
        sendDeviceNow({ type: 'dispatched' })
      }

      // ── ROUTE MODE (voice from Overview): transcribe, ask the router which agent should handle it, then
      // auto-dispatch on high confidence or push a `voice_routed` for the device to confirm/pick.
      if (route) {
        const text = await transcribeReserved()
        sendDeviceNow({ type: 'transcript', requestId, text })
        if (!text) { sendDeviceNow({ type: 'empty' }); return }
        const d = await nodeRequest<{ agentId?: string; agentName?: string; confidence?: number; reason?: string; needNewAgent?: boolean }>(
          machineId, 'voice_route', { transcript: text },
        )
        const agentId = typeof d.agentId === 'string' ? d.agentId : ''
        const agentName = typeof d.agentName === 'string' ? d.agentName : ''
        const confidence = typeof d.confidence === 'number' ? d.confidence : 0
        const reason = typeof d.reason === 'string' ? d.reason : ''
        const needNewAgent = d.needNewAgent === true
        logger.info('commander voice_route', { userId, machineId, agentId, agentName, confidence, needNewAgent })
        // Overview mode select: the routed transcript becomes a "/goal <text>" or "/loop <text>" command
        // on whichever agent the router picked.
        const routedContent = withCommand(text, goal, loop)
        if (agentId && !needNewAgent && confidence >= ROUTE_AUTO_THRESHOLD) {
          sendDeviceNow({ type: 'voice_routed', autoSent: true, agentId, agentName, confidence, reason })
          await dispatchTurn(agentId, routedContent, null, 'auto')
        } else {
          const routeId = randomUUID()
          pendingRoutes.set(routeId, { text, goal, loop, ts: Date.now() })
          sendDeviceNow({ type: 'voice_routed', autoSent: false, routeId, agentId, agentName, confidence, reason, needNewAgent })
        }
        return
      }

      // ── FIXED-AGENT MODE (voice from a specific tile): "processing" heartbeat over the STT gap, dispatch.
      const beat = () => sendDeviceNow({
        type: 'commander_event', agentId: agentId!, dbSessionId: sessionId ?? undefined, payload: { kind: 'processing' },
      })
      // Bare terminal 'done' (no text) = clear the "processing" busy WITHOUT a card (empty transcript / ask).
      const clearBusy = () => sendDeviceNow({
        type: 'commander_event', agentId: agentId!, dbSessionId: sessionId ?? undefined, payload: { kind: 'done' },
      })
      beat()
      const hb = setInterval(beat, 5000)
      let text: string
      try { text = await transcribeReserved() } finally { clearInterval(hb) }
      sendDeviceNow({ type: 'transcript', requestId, text })
      // 'ask' mode = answering an AskUserQuestion: just return the transcript, never dispatch a turn.
      if (mode === 'ask') { clearBusy(); return }
      if (text) {
        // GOAL command → send the transcript as the "/goal <text>" slash-command so the agent sets a
        // persistent goal instead of running it as a one-off prompt.
        const content = withCommand(text, goal, loop)
        logger.info('commander turn_start', { userId, machineId, agentId, sessionId, goal, mode: autonomy, source: 'voice' })
        await dispatchTurn(agentId!, content, sessionId, autonomy)
      } else {
        clearBusy()
        sendDeviceNow({ type: 'empty' })
      }
    } catch (err) {
      logger.warn('commander voice failed', { userId, error: errMsg(err) })
      if (agentId) sendDeviceNow({ type: 'commander_event', agentId: agentId, dbSessionId: sessionId ?? undefined, payload: { kind: 'done' } })
      if (err instanceof VoiceQuotaExceededError) {
        sendDeviceNow({ type: 'voice_quota_exceeded', payload: { ...err.snapshot, uploadId } })
      } else {
        sendDeviceNow({ type: 'error', message: errMsg(err) })
      }
    }
  }

  /** The machine a device frame is about: its own tag when it names an attached machine, else the active one. */
  function targetMachine(msg: CommanderMsg): string | null {
    const tagged = typeof msg.machineId === 'string' ? msg.machineId : ''
    // `commanderClients.has` is the ownership check: it only ever holds machines this user's socket
    // attached, so a self-declared id cannot reach anybody else's machine.
    return tagged && commanderClients.has(tagged) ? tagged : activeMachineId
  }
  const targetRemote = (msg: CommanderMsg): boolean => {
    const id = targetMachine(msg)
    return id ? machineRemote.get(id) ?? false : false
  }

  async function handleAgentRpc(msg: CommanderMsg): Promise<void> {

    const payload = payloadOf(msg)
    const requestId = payload.requestId
    const resultType =
      msg.type === 'agents_list' ? 'agents_list_result'
        : msg.type === 'agent_create' ? 'agent_create_result'
          : msg.type === 'agent_update' ? 'agent_update_result'
            : msg.type === 'models_list' ? 'models_list_result'
              : 'agent_recent_result'
    const machineId = targetMachine(msg)
    if (!machineId) { sendDeviceNow({ type: resultType, payload: { requestId, error: 'NO_MACHINE_SELECTED' } }); return }

    try {
      if (msg.type === 'agents_list') {
        const r = await nodeRequest<{ agents?: unknown }>(machineId, 'agents_list', {})
        const rawAgents = Array.isArray(r?.agents) ? r.agents : []
        // Keep the list metadata-only. The device restores recap/summary lazily via one agent_recent RPC at
        // a time so large machines never produce a giant agents_list_result frame.
        const projects = rawAgents.slice(0, DEVICE_AGENT_LIST_LIMIT).map(deviceAgentListItem)
        sendDevice({ type: 'agents_list_result', payload: { requestId, agents: projects } })
        return
      }

      if (msg.type === 'agent_create') {
        const { count, max } = await agentLimit(machineId)
        if (count >= max) {
          sendDevice({ type: 'agent_create_result', payload: { requestId, error: 'AGENT_LIMIT' } })
          return
        }
        const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name : 'Agent'
        const r = await nodeRequest<{ agent?: { id?: unknown; name?: unknown } }>(machineId, 'agent_create', { name })
        await recordCreatedAgent(machineId, r?.agent)
        const projObj = (r?.agent ?? {}) as Record<string, unknown>
        const project = r?.agent ? { id: projObj.id, name: projObj.name } : null
        sendDevice({ type: 'agent_create_result', payload: { requestId, agent: project } })
        return
      }

      if (msg.type === 'agent_update') {
        // Device per-agent Model control → persist to Project.selectedModel on the node (read back at each
        // turn for --model). Fire-and-forget from the device; we still ack so it isn't left hanging.
        const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
        if (!agentId) throw new Error('MISSING_AGENT_ID')
        const selectedModel = 'selectedModel' in payload ? (payload.selectedModel as string | null) : undefined
        await nodeRequest(machineId, 'agent_update', { agentId: agentId, selectedModel })
        sendDevice({ type: 'agent_update_result', payload: { requestId } })
        return
      }

      if (msg.type === 'models_list') {
        // Terminated HERE for the same reason the other four are, and it is not symmetry for its own
        // sake: `hub.deliverUpLocal` drops every `*_result` frame addressed to a commander client unless
        // it carries a targetConnId, and managers never set one. Relayed, this reply is eaten in transit
        // and the dial's Model picker sits empty forever with nothing logged anywhere.
        const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
        const r = await nodeRequest<{ models?: unknown }>(machineId, 'models_list', {
          agentId,
          compact: payload.compact === true,
          pickerMode: typeof payload.pickerMode === 'string' ? payload.pickerMode : undefined,
          selectedModel: typeof payload.selectedModel === 'string' ? payload.selectedModel : undefined,
        })
        const models = Array.isArray(r?.models) ? r.models : []
        sendDevice({ type: 'models_list_result', payload: { requestId, agentId, models } })
        return
      }

      if (msg.type === 'agent_recent') {
        const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
        if (!agentId) throw new Error('MISSING_AGENT_ID')
        const nRaw = typeof payload.n === 'number' || typeof payload.n === 'string' ? parseInt(String(payload.n), 10) : 2
        const n = Number.isFinite(nRaw) && nRaw > 0 ? nRaw : 2
        const r = await nodeRequest<{ events?: unknown }>(machineId, 'agent_recent', { agentId: agentId, n })
        // Trim to kind + text + optional recap headline (the device drops everything else).
        const events = trimRecentEvents(r?.events, n, requestId, agentId)
        sendDevice({ type: 'agent_recent_result', payload: { requestId, agentId: agentId, events } })
      }
    } catch (err) {
      sendDevice({ type: resultType, payload: { requestId, error: errMsg(err) } })
    }
  }
}
