/**
 * BackendSocket — the CLI's dial-out connection to the backend's `/api/adapter-ws`.
 *
 * The adapter occupies the NODE side of its agentId on the backend hub:
 *   - `up`   { t:'up', frame }            → normalized claude events + `<x>_result` RPC replies
 *   - `down` { t:'down', connId, frame }  → web chat/control + data-plane RPC requests
 *
 * Mirrors the hosted runtime’s managerSocket: idempotent connect, exponential backoff (1s→30s),
 * WS ping/pong keep-alive + a 15s app-level `{t:'ping'}` that refreshes the backend presence
 * key, and a bounded FIFO queue for client-facing outbound frames.
 *
 * Auth: the connect token (agent apiKey) rides as the first WS subprotocol.
 */

import { WebSocket } from 'ws'
import { stat, readFile } from 'fs/promises'
import { join } from 'path'
import { hostname } from 'os'
import { createHash } from 'crypto'
import { env } from './config/env.js'
import { registry, projectDisplayName, type RegisteredSession } from './lib/registry.js'
import { routeVoiceTask } from './lib/voiceRouter.js'
import { tailFile } from './lib/sessions.js'
import { messagesToEvents, windowRawLines, subagentStatsFromRawLines, type SessionEvent } from './lib/normalize.js'
import { listFileTree, readProjectFile } from './lib/files.js'
import { sendToTmux } from './lib/tmux.js'
import { codexMessagesToEvents, windowCodexLines } from './engines/codex/normalizer.js'
import { cursorMessagesToEvents, windowCursorLines } from './engines/cursor/normalizer.js'
import { loadCursorReplayTaskLinks } from './engines/cursor/subagent.js'
import { opencodeMessagesToEvents, windowOpencodeMessages } from './engines/opencode/normalizer.js'
import { kiloMessagesToEvents, windowKiloMessages } from './engines/kilo/normalizer.js'
import { museMessagesToEvents } from './engines/muse/normalizer.js'
import { ampMessagesToEvents } from './engines/amp/normalizer.js'
import { grokMessagesToEvents } from './engines/grok/normalizer.js'
import { ampThreadToEvents, readAmpThread } from './engines/amp/threadExport.js'
import { piMessagesToEvents, windowPiLines } from './engines/pi/normalizer.js'
import { commandcodeMessagesToEvents, windowCommandCodeLines } from './engines/commandcode/normalizer.js'
import { hermesMessagesToEvents, windowHermesMessages } from './engines/hermes/normalizer.js'
import { devinMessagesToEvents, windowDevinMessages } from './engines/devin/normalizer.js'
import { readHermesMessages } from './engines/hermes/reader.js'
import { readDevinMessages } from './engines/devin/reader.js'
import { readOpencodeMessages } from './engines/opencode/reader.js'
import { readKiloMessages } from './engines/kilo/reader.js'
import { E2eeManager, type PairResult } from './lib/e2ee/manager.js'
import { ENCRYPTED_RPC_RESULT_TYPES, isEncryptedDownType, isWrapped } from './lib/e2ee/core.js'
import { DEVICE_RECENT_SAFE_FRAME_BYTES, fitRecentReplyPayloadForDevice } from './lib/deviceRecentTrim.js'
import { shouldReplayCommander } from './lib/commanderReplay.js'
import { RuntimeProfileControlError, type RuntimeProfileErrorCode } from './lib/runtimeProfileController.js'
import { parseRuntimeProfile, type RuntimeModelOption } from './lib/runtimeProfile.js'
import { sid, preview } from './lib/log.js'

// OpenCode has no per-session transcript file — its history is read from this SQLite store.
const OPENCODE_DB = join(env.OPENCODE_DATA_DIR, 'opencode.db')
// Kilo keeps history the same way opencode does, in its own store.
const KILO_DB = join(env.KILO_DATA_DIR, 'kilo.db')
const DEVIN_DB = join(env.DEVIN_HOME, 'sessions.db')
// Hermes history likewise comes from a SQLite store, not a per-session file.
const HERMES_DB = join(env.HERMES_HOME, 'state.db')

/** Answers the device `project_recent` RPC — set by cli.ts to the CommanderMirror's `recent`. */
export type RecentProvider = (sessionId: string, n: number) => Array<{ kind: string; text: string; recap?: string }>


const HEARTBEAT_MS = 20_000
const APP_PING_MS = 15_000
const BASE_DELAY_MS = 1_000
const MAX_DELAY_MS = 30_000
const QUEUE_MAX = 2_000
const DEVICE_AGENT_LIST_LIMIT = 100
const DEVICE_AGENT_NAME_MAX_CODEPOINTS = 15
const DEVICE_AGENT_NAME_MAX_BYTES = 39 // device project_t.name[40], including trailing NUL on-device.
const DEVICE_ELLIPSIS = '…'

type Frame = Record<string, unknown>
type OutboundEnvelope = Record<string, unknown>

interface QueueItem {
  id: number
  data: string
  msg: OutboundEnvelope
  attempts: number
}

interface DownEnvelope {
  t: 'down'
  connId?: string
  frame?: Frame
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8')
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

/**
 * Amp history comes from AMP's store, not from ours.
 *
 * The plugin's JSONL is a record of what the plugin saw; a thread that ran before the integration existed
 * — or in a pane still holding an older plugin — is simply not in it, and no local file can rebuild those
 * turns. `amp threads export` returns the thread complete, including the tools Amp runs server-side.
 *
 * The local file stays as the FALLBACK, because an export is a network call and a pane with no history at
 * all is worse than a partial one. Which source answered is logged either way: silently serving the lesser
 * record is exactly how the missing tool cards went unnoticed for a day.
 */
async function ampHistory(sessionId: string, lines: string[]): Promise<SessionEvent[]> {
  const messages = await readAmpThread(sessionId)
  if (messages) {
    console.log(`[history] ${sessionId.slice(0, 12)} amp · ${messages.length} message(s) from amp's own store`)
    return ampThreadToEvents(messages)
  }
  console.warn(`[history] ${sessionId.slice(0, 12)} amp · export unavailable — falling back to the local transcript`)
  return ampMessagesToEvents(lines)
}

/** Grok has no transcript windower yet. Keep BOTH `session_get` shapes on the same real-record replay:
 * web always sends a limit, while legacy callers omit it. Returning the whole small transcript for a
 * page is honest (`hasMore:false`) and cannot fall through to Claude's incompatible line cursor. */
export function grokHistoryPage(lines: string[], paginated: boolean):
  { events: SessionEvent[]; hasMore?: false; oldestCursor?: null } {
  const events = grokMessagesToEvents(lines)
  return paginated ? { events, hasMore: false, oldestCursor: null } : { events }
}

export function deviceAgentListItem(
  raw: unknown,
): { id: unknown; name?: string; engine?: 'claude' | 'codex' | 'cursor' | 'opencode' | 'pi' | 'hermes' | 'commandcode' | 'devin' | 'muse' | 'amp' | 'kilo' | 'grok'; selectedModel?: string | null } {
  const o = (raw ?? {}) as Record<string, unknown>
  const item: { id: unknown; name?: string; engine?: 'claude' | 'codex' | 'cursor' | 'opencode' | 'pi' | 'hermes' | 'commandcode' | 'devin' | 'muse' | 'amp' | 'kilo' | 'grok'; selectedModel?: string | null } = { id: o.id }
  if (typeof o.name === 'string') item.name = clipDeviceAgentName(o.name)
  if (o.engine === 'claude' || o.engine === 'codex' || o.engine === 'cursor' || o.engine === 'opencode' || o.engine === 'pi' || o.engine === 'hermes' || o.engine === 'commandcode' || o.engine === 'devin' || o.engine === 'muse' || o.engine === 'amp' || o.engine === 'kilo' || o.engine === 'grok') item.engine = o.engine
  // Runtime model/effort profile (opaque runtime-v1:...) — lets the device render + change model/effort.
  if (typeof o.selectedModel === 'string' || o.selectedModel === null) item.selectedModel = o.selectedModel
  return item
}

/**
 * How many models the DEVICE picker may receive. Matches its own PICK_MAX (ui_screens.c) so the wheel
 * never renders more rows than it was built for; the web picker is unbounded and still gets everything.
 */
const DEVICE_PICKER_MAX_MODELS = 24

export function compactRuntimePickerModels(
  models: RuntimeModelOption[],
  sessionId: string | undefined,
  pickerMode: unknown,
  selectedModel: unknown,
): Array<{ id: string }> {
  const compact = models.map(({ id }) => ({ id }))
  if ((pickerMode !== 'model' && pickerMode !== 'effort') || !sessionId) return compact

  const profiles = models.flatMap((item) => {
    const profile = parseRuntimeProfile(item.id)
    return profile?.sessionId === sessionId ? [{ item, profile }] : []
  })
  const selected = parseRuntimeProfile(selectedModel)
  const current = selected?.sessionId === sessionId ? selected : null

  if (pickerMode === 'effort') {
    if (!current) return []
    const seen = new Set<string>()
    return profiles.flatMap(({ item, profile }) => {
      if (profile.model !== current.model || profile.effort === 'auto' || seen.has(profile.effort)) return []
      seen.add(profile.effort)
      return [{ id: item.id }]
    })
  }

  const byModel = new Map<string, typeof profiles>()
  for (const entry of profiles) {
    const group = byModel.get(entry.profile.model) ?? []
    group.push(entry)
    byModel.set(entry.profile.model, group)
  }
  const rows = [...byModel.values()].map((group) => {
    const target = group.find(({ profile }) => current && profile.effort === current.effort)
      ?? group.find(({ profile }) => profile.effort === 'auto')
      ?? group[0]
    return { id: target.item.id, model: target.profile.model }
  })
  // Top N only. The picker is a scroll wheel on a 1.9" round screen, and a 49-row one was enough to stall
  // the device's the device UI task into a task-watchdog reset; devin alone publishes 72
  // models. The catalog arrives in the engine's own order — its curated/most-used first — so "top" is that
  // order, with the model the agent is RUNNING pinned in front so the list can never hide it.
  const ordered = current
    ? [...rows].sort((a, b) => Number(b.model === current.model) - Number(a.model === current.model))
    : rows
  return ordered.slice(0, DEVICE_PICKER_MAX_MODELS).map(({ id }) => ({ id }))
}

/** Fill in missing sub-agent aggregates on tool_end events by reading the sub-agent's own transcript
 *  (`<session>/subagents/agent-<id>.jsonl`). Async/background launchers only record
 *  `{status:'async_launched', agentId}` in the main transcript — without this join the delegation
 *  card shows "0 tools · worked for 0s" forever. Best-effort per agent; missing files are skipped. */
async function enrichSubagentStats(events: SessionEvent[], transcriptPath: string): Promise<void> {
  const subagentsDir = join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents')
  for (const e of events) {
    if (e.type !== 'tool_end') continue
    const sub = e.payload.subagent
    if (!sub?.agentId || typeof sub.totalToolUseCount === 'number') continue
    try {
      const txt = await readFile(join(subagentsDir, `agent-${sub.agentId}.jsonl`), 'utf8')
      const stats = subagentStatsFromRawLines(txt.split('\n'))
      sub.totalToolUseCount = stats.totalToolUseCount
      if (sub.totalDurationMs === undefined) sub.totalDurationMs = stats.totalDurationMs
      if (sub.totalTokens === undefined) sub.totalTokens = stats.totalTokens
    } catch { /* subagent transcript absent (still spawning / pruned) — leave as-is */ }
  }
}

export class BackendSocket {
  private ws: WebSocket | null = null
  private token: string
  private url: string
  private attempts = 0
  private closed = false
  private queue: QueueItem[] = []
  private draining = false
  private nextQueueId = 1
  private droppedSinceLog = 0
  private heartbeat: NodeJS.Timeout | null = null
  private appPing: NodeJS.Timeout | null = null
  private isAlive = true
  private onStatus: (connected: boolean) => void
  /** Cross-instance commander (device) client count, from backend `__clients` frames. */
  private commanderCount = 0
  /** Subset of commanderCount whose device is ACTIVELY rendering this machine (multi-attach). null = the
   *  backend doesn't send the signal (old build) → fall back to hasCommander so streaming isn't gated off. */
  private commanderActive: number | null = null
  private replayedCommanderGeneration: number | undefined
  private replayCommanderOnNextSnapshot = true
  /** Called when a commander attach is observed — cli.ts replays live state. */
  onCommanderJoin: (() => void) | null = null
  /** Called only when commander presence crosses zero; drives the disposable recap-worker grace. */
  onCommanderPresenceChanged: ((connected: boolean) => void) | null = null
  /** Called when the web cancels a turn (C-c) — cli.ts stops that session's turn heartbeat. */
  onCancel: ((sessionId: string) => void) | null = null
  /** Called when the web deletes an agent (`agent_delete`) — cli.ts kills the tmux pane (if any) and
   *  forgets the session (removes it from the list + emits `agent_deleted`). Keeps recap + agent name. */
  onDeleteAgent: ((sessionId: string) => void) | null = null
  /** Called when the web/device sends a chat `message` to inject into a session's tmux pane — cli.ts does
   *  the bracketed-paste inject + a watcher-confirmed Enter retry so long/multi-line text always submits. */
  onMessage: ((sessionId: string, content: string) => void) | null = null
  /** Called when a device answers an AskUserQuestion (`question_response`) — cli.ts drives the CLI's own
   *  question dialog in that session's tmux pane (option digit / free text), since a remote machine has no
   *  programmatic answer channel the way the hosted runtime’s brain does. */
  onQuestionAnswer: ((payload: { requestId?: string; sessionId?: string; agentId?: string; answers?: Record<string, string> }) => void) | null = null
  /** Called when this machine was deleted/revoked (a `machine_revoked` down-frame, or a 401/403 on the
   *  upgrade) — cli clears the saved token and shuts the adapter down instead of retrying forever. */
  onRevoked: (() => void) | null = null
  /** Called with the machine's display name (`machine_meta` down-frame: seeded on connect, pushed on a
   *  web rename; null = unnamed) — cli mirrors it to a local file for `harness status`. */
  onMachineMeta: ((name: string | null) => void) | null = null
  /** Called when this machine is already connected from ANOTHER machine (HTTP 409 on the upgrade) — the
   *  credential is valid, just in use elsewhere, so cli keeps the token and stops (no retry loop). */
  onBusy: (() => void) | null = null
  /** Answers the device `project_recent` RPC (cli.ts wires this to CommanderMirror.recent). */
  recentProvider: RecentProvider | null = null
  /** Runtime Model/Effort integration, wired by cli.ts for registered tmux sessions. */
  runtimeModelsProvider: ((sessionId?: string) => Promise<RuntimeModelOption[]>) | null = null
  runtimeProfileProvider: ((session: RegisteredSession) => string | null) | null = null
  onRuntimeProfileUpdate: ((sessionId: string, selectedModel: string) => Promise<void>) | null = null
  /** Web↔adapter E2EE: group-encrypts user events, runs the CPace pairing, holds per-conn sessions. */
  readonly e2ee: E2eeManager
  /** agentId = sha256(token)[:32] — exposed for the local dashboard status. */
  readonly machineId: string

  /** The ONE place commander presence changes. Both callers — the `__clients` snapshot and `onGone` (our
   *  own backend link died) — mean the same thing when the count reaches zero: nobody is watching. They
   *  used to differ, and `onGone` forgot to drop the device's E2EE session, so `deviceE2eeConnected()`
   *  stayed true and the local dashboard kept a green "device connected" dot for a device long gone. */
  private setCommanderCount(commander: number, active: number | null): void {
    const hadCommander = this.commanderCount > 0
    this.commanderCount = commander
    this.commanderActive = active
    if (hadCommander !== (commander > 0)) this.onCommanderPresenceChanged?.(commander > 0)
    if (commander <= 0) this.e2ee.dropSessionsByRole('device')
  }

  /** True while at least one device (commander) client is connected — gates the LLM recap. */
  hasCommander(): boolean {
    return this.commanderCount > 0
  }

  /** True while at least one connected device is ACTIVELY rendering this machine — gates the full turn-card
   *  STREAM (processing/tool/todos). The recap still runs on hasCommander(), so a BACKGROUND machine gets its
   *  turn-done `summary` card (badge) without the live stream. Falls back to hasCommander() against a
   *  backend that doesn't emit the signal (commanderActive === null). */
  hasActiveCommander(): boolean {
    return this.commanderActive == null ? this.hasCommander() : this.commanderActive > 0
  }

  /** True after a paired device has completed the E2EE hello/welcome session. */
  deviceE2eeConnected(): boolean {
    return this.e2ee.deviceConnected()
  }

  /** Live backend link state (local dashboard + E2EE gating). */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  /** A browser waiting to pair (local dashboard), or null. */
  pendingPair(): ReturnType<E2eeManager['pendingPair']> {
    return this.e2ee.pendingPair()
  }

  /** Record the local dashboard port so it's surfaced to the web (in e2e_status) for approve-via-web. */
  setDashboardPort(port: number): void {
    this.e2ee.dashboardPort = port
  }

  constructor(token: string, onStatus: (connected: boolean) => void = () => {}, computerId = '') {
    this.token = token
    // `?label=<hostname>` lets the backend record which machine connected (shown on the machine card);
    // `?computer=<stable id>` enforces one-computer-per-computer (a 2nd computer is rejected with HTTP 409).
    const base = `${env.BACKEND_WS_URL.replace(/\/$/, '')}/api/adapter-ws?label=${encodeURIComponent(hostname())}`
    this.url = computerId ? `${base}&computer=${encodeURIComponent(computerId)}` : base
    this.onStatus = onStatus
    this.machineId = createHash('sha256').update(token).digest('hex').slice(0, 32)
    this.e2ee = new E2eeManager({
      machineId: this.machineId,
      sendTo: (connId, frame) => this.sendTo(connId, frame),
      sendUser: (frame) => this.sendUser(frame),
      isConnected: () => this.isConnected(),
    })
  }

  /** Run CPace pairing for a code entered via `harness pair <code>` (delegated to the manager). */
  pair(code: string): Promise<PairResult> {
    return this.e2ee.onPair(code)
  }
  e2eeFingerprint(): string {
    return this.e2ee.fingerprint()
  }
  createSetupToken(): ReturnType<E2eeManager['createSetupToken']> {
    return this.e2ee.createSetupToken()
  }
  /** `harness pairings` — list paired clients. */
  listPairs(): ReturnType<E2eeManager['listPaired']> {
    return this.e2ee.listPaired()
  }
  /** `harness unpair <id>` — unpair one client (signals it to re-pair if online). */
  revoke(id: string): ReturnType<E2eeManager['revoke']> {
    return this.e2ee.revoke(id)
  }
  /** `harness unpair --all` — unpair every client. */
  revokeAll(): ReturnType<E2eeManager['revokeAll']> {
    return this.e2ee.revokeAll()
  }

  connect(): void {
    if (this.closed || this.ws) return
    const ws = new WebSocket(this.url, [this.token])
    this.ws = ws

    ws.on('open', () => {
      this.attempts = 0
      this.isAlive = true
      console.log(`[backend] connected → ${this.url}`)
      this.onStatus(true)
      this.drainQueue()

      this.heartbeat = setInterval(() => {
        if (!this.isAlive) {
          try { ws.terminate() } catch { /* ignore */ }
          return
        }
        this.isAlive = false
        try { ws.ping() } catch { /* ignore */ }
      }, HEARTBEAT_MS)
      ws.on('pong', () => { this.isAlive = true })

      // App-level ping refreshes the backend's presence key (TTL 30s).
      this.appPing = setInterval(() => this.sendBestEffort({ t: 'ping' }), APP_PING_MS)
    })

    ws.on('message', (raw) => {
      let env_: DownEnvelope
      try { env_ = JSON.parse(raw.toString()) as DownEnvelope } catch { return }
      if (env_.t === 'down' && env_.frame) {
        // A malformed/hostile down-frame (bad __e2e envelope, bad ephemeral key) can throw in the
        // pre-`try` part of dispatchDown; without this .catch that becomes an unhandledRejection and the
        // daemon exits. Contain it: log, drop the frame, keep the socket alive.
        void this.dispatchDown(env_.frame, env_.connId ?? '').catch((err) =>
          console.error('[backend] down-frame dispatch failed:', err instanceof Error ? err.message : err))
      }
    })

    const onGone = (why: string): void => {
      if (this.ws !== ws) return
      this.ws = null
      if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null }
      if (this.appPing) { clearInterval(this.appPing); this.appPing = null }
      this.draining = false
      // While the backend link is down we can neither observe device presence nor deliver a card, so
      // default the recap gate to OFF (safe value) instead of holding a stale count — otherwise a turn
      // completing during the gap burns a `claude -p` recap that goes nowhere. attachAdapter always
      // re-pushes the true count via recomputeAndSendClients on reconnect (and 0→N re-fires the replay).
      this.setCommanderCount(0, null) // active count is unknown until the next __clients snapshot
      this.replayCommanderOnNextSnapshot = true
      this.onStatus(false)
      if (this.closed) return
      const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(this.attempts++, 5))
      console.log(`[backend] disconnected (${why}) — retrying in ${Math.round(delay / 1000)}s (attempt ${this.attempts})`)
      setTimeout(() => this.connect(), delay)
    }
    ws.on('close', (code) => onGone(`close ${code}`))
    ws.on('error', (err) => {
      const e = err as Error & { code?: string }
      const msg = e.message || e.code || String(err)
      console.error('[backend] socket error:', msg)
      // 401/403 on the upgrade = this machine is gone/invalid (deleted while we were offline, or a bad
      // token). Retrying can't help → stop for good and let the CLI clear the saved token + shut down.
      if (/Unexpected server response: 40[13]\b/.test(msg)) {
        this.closed = true
        this.onRevoked?.()
      }
      // 409 = one machine per machine: another computer already holds this machine. Keep the token; stop
      // retrying (the 40[13] regex above deliberately excludes 409, so without this it would loop).
      else if (/Unexpected server response: 409\b/.test(msg)) {
        this.closed = true
        this.onBusy?.()
      }
      try { ws.close() } catch { /* ignore */ }
    })
  }

  async stop(): Promise<void> {
    this.closed = true
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.appPing) clearInterval(this.appPing)
    try { this.ws?.close() } catch { /* ignore */ }
    this.ws = null
  }

  /** Send an up-frame (event or RPC reply) to the WEB audience. Queued while disconnected.
   *  User-content events are group-encrypted (E2EE) here; system frames pass through as plaintext. */
  send(frame: Frame): void {
    this.enqueue({ t: 'up', frame: this.e2ee.wrapUp(frame) })
  }

  /** Send an up-frame to exactly ONE web connection (E2EE pairing/welcome + targeted RPC replies). */
  sendTo(connId: string, frame: Frame): void {
    this.enqueue({ t: 'up', targetConnId: connId, frame })
  }

  /** Send a user-level notification to every logged-in browser that owns this machine. */
  sendUser(frame: Frame): void {
    this.enqueue({ t: 'up', userEligible: true, webEligible: false, frame })
  }

  /** Send a DEVICE-audience frame (commanderEligible, not web). User/data frames are group-encrypted
   *  (E2EE) here so the backend relays only ciphertext; system/presence frames pass through. */
  sendCommander(frame: Frame): void {
    this.enqueue({ t: 'up', webEligible: false, commanderEligible: true, frame: this.e2ee.wrapCommander(frame) })
  }

  private enqueue(msg: OutboundEnvelope): void {
    const item: QueueItem = { id: this.nextQueueId++, data: JSON.stringify(msg), msg, attempts: 0 }
    if (this.queue.length >= QUEUE_MAX) this.dropOneQueued()
    if (this.queue.length >= QUEUE_MAX) {
      this.droppedSinceLog++
      this.logQueueDrops()
      return
    }
    this.queue.push(item)
    this.drainQueue()
  }

  private sendBestEffort(msg: OutboundEnvelope): void {
    const data = JSON.stringify(msg)
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(data) } catch { /* ignore */ }
    }
  }

  private drainQueue(): void {
    if (this.draining || !this.queue.length) return
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const item = this.queue[0]
    this.draining = true
    try {
      ws.send(item.data, (err?: Error) => {
        if (this.ws !== ws) return
        if (err) {
          item.attempts++
          this.draining = false
          console.error(`[backend] queued send failed (id=${item.id}, attempts=${item.attempts}):`, err.message)
          try { ws.close() } catch { /* ignore */ }
          return
        }
        if (this.queue[0] === item) this.queue.shift()
        this.draining = false
        this.drainQueue()
      })
    } catch (err) {
      item.attempts++
      this.draining = false
      console.error(`[backend] queued send threw (id=${item.id}, attempts=${item.attempts}):`, err instanceof Error ? err.message : err)
      try { ws.close() } catch { /* ignore */ }
    }
  }

  private dropOneQueued(): void {
    const idx = this.queue.findIndex((item) => !('targetConnId' in item.msg))
    const dropAt = idx >= 0 ? idx : 0
    if (this.queue.splice(dropAt, 1).length) {
      this.droppedSinceLog++
      this.logQueueDrops()
    }
  }

  private logQueueDrops(): void {
    if (this.droppedSinceLog === 1 || this.droppedSinceLog % 100 === 0) {
      console.warn(`[backend] outbound queue full; dropped ${this.droppedSinceLog} frame(s) so far`)
    }
  }

  // ── down-frame dispatch (the hosted runtime-role RPC switch) ────────────────────────────────────────────

  /** Emit an RPC reply. For an E2EE-session requester whose result carries user content, the reply is
   *  encrypted with that connection's session key and delivered ONLY to it. Content-bearing adapter data
   *  is never returned plaintext: even legacy backend nodeRequest (`connId === ''`) gets only an error. */
  private emitReply(connId: string, type: string, requestId: unknown, payload: Record<string, unknown>): void {
    const resultType = `${type}_result`
    if (connId && this.e2ee.hasSession(connId) && ENCRYPTED_RPC_RESULT_TYPES.has(resultType)) {
      let replyPayload = payload
      if (resultType === 'agent_recent_result') {
        const trim = fitRecentReplyPayloadForDevice(
          payload,
          (candidate) => this.e2ee.rpcReplyFrameBytes(connId, resultType, requestId, candidate),
        )
        replyPayload = trim.payload
        if (trim.trimmed) {
          console.warn(
            `[recent-trim] agent=${String(payload.agentId ?? '')} originalFrame=${trim.originalBytes ?? 'unknown'} ` +
            `finalFrame=${trim.finalBytes ?? 'unknown'} target=${DEVICE_RECENT_SAFE_FRAME_BYTES} ` +
            `textBytes=${trim.textBytes} recapBytes=${trim.recapBytes}`,
          )
        }
      }
      const wrapped = this.e2ee.wrapRpcReply(connId, resultType, requestId, replyPayload)
      if (wrapped) { this.sendTo(connId, wrapped); return }
    }
    // Enforcement ("no E2EE ⇒ no adapter data"): content-bearing RPC replies must never leave the
    // adapter plaintext. A real client gets a targeted error; the legacy backend nodeRequest awaiter
    // (`connId === ''`) gets a broadcast error with the same requestId so it fails closed without data.
    // 
    if (ENCRYPTED_RPC_RESULT_TYPES.has(resultType)) {
      const errorFrame = { type: resultType, payload: { requestId, error: 'E2EE_REQUIRED' } }
      if (connId) this.sendTo(connId, errorFrame)
      else this.send(errorFrame)
      return
    }
    this.send({ type: resultType, payload: { requestId, ...payload } })
  }

  private async dispatchDown(frame: Frame, connId: string): Promise<void> {
    const type = frame.type as string | undefined
    if (!type) return
    // E2EE control frames (pairing/handshake) are handled by the manager, never as node RPCs.
    if (type.startsWith('e2e_')) { this.e2ee.handleFrame(connId, frame); return }
    // Client→adapter encrypted frames: chat messages plus trusted web control actions. Plaintext
    // passes through for legacy/device transition paths; undecryptable ciphertext is dropped.
    if (isEncryptedDownType(type)) {
      if (type !== 'message' && type !== 'question_response' && !isWrapped(frame.payload)) {
        const requestId = (frame.payload as { requestId?: unknown } | undefined)?.requestId
        if (requestId !== undefined) this.emitReply(connId, type, requestId, { error: 'E2EE_REQUIRED' })
        return
      }
      const dec = this.e2ee.unwrapDown(connId, frame)
      if (!dec) return
      frame = dec
    }
    const reply = (t: string, rid: unknown, p: Record<string, unknown>): void => this.emitReply(connId, t, rid, p)
    // Cross-instance client snapshot. Generation detects leave/join cycles that coalesce to the same
    // count; count rise remains the compatibility fallback for older backends.
    if (type === '__clients') {
      const payload = (frame.payload ?? {}) as { commander?: number; commanderActive?: number; commanderJoinGeneration?: number }
      const commander = Number(payload.commander ?? 0)
      const rawGeneration = payload.commanderJoinGeneration
      const generation = typeof rawGeneration === 'number' && Number.isSafeInteger(rawGeneration) && rawGeneration >= 0
        ? rawGeneration
        : undefined
      const replay = shouldReplayCommander(
        this.commanderCount,
        commander,
        this.replayedCommanderGeneration,
        generation,
        this.replayCommanderOnNextSnapshot,
      )
      this.setCommanderCount(commander, payload.commanderActive != null ? Number(payload.commanderActive) : null)
      if (replay) {
        this.replayCommanderOnNextSnapshot = false
        if (generation != null) this.replayedCommanderGeneration = generation
        this.onCommanderJoin?.()
      }
      return
    }
    // Other backend-hub internal control frames (__clients_dirty) — not for us; drop silently.
    if (type.startsWith('__')) return

    // The machine was deleted/revoked from the web → stop for good (don't reconnect) and let the CLI
    // clear the saved token. `closed` blocks the reconnect that would otherwise fire on socket drop.
    if (type === 'machine_revoked') { this.closed = true; this.onRevoked?.(); return }

    // Machine display name (seed on connect + web renames) — mirrored locally for `harness status`.
    if (type === 'machine_meta') {
      const name = (frame.payload as { name?: unknown } | undefined)?.name
      this.onMachineMeta?.(typeof name === 'string' && name.trim() ? name.trim() : null)
      return
    }

    const payload = (frame.payload ?? {}) as Record<string, unknown>
    const requestId = payload.requestId

    try {
      switch (type) {
        case 'device_e2ee_pair':
          await this.e2ee.pairDeviceFromTrustedWeb(connId, payload)
          return

        case 'e2ee_pairings_list':
          reply(type, requestId, { pairs: this.e2ee.listPaired(connId) })
          return

        case 'e2ee_pairing_unpair':
          this.e2ee.revokeFromTrustedWeb(connId, payload)
          return

        case 'e2ee_pairings_unpair_all':
          this.e2ee.revokeAllFromTrustedWeb(connId, requestId)
          return

        case 'e2ee_browser_link_create': {
          const setup = this.e2ee.createSetupToken()
          reply(type, requestId, setup)
          return
        }

        case 'agents_list': {
          const projects = await Promise.all(registry.list().map((s) => this.toProject(s)))
          // Ordered by creation time, oldest → newest — a stable tab order that doesn't reshuffle as
          // sessions become active (createdAt = the session's registeredAt).
          projects.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
          if (this.e2ee.sessionRole(connId) === 'device') {
            reply(type, requestId, { agents: projects.slice(0, DEVICE_AGENT_LIST_LIMIT).map(deviceAgentListItem) })
            return
          }
          reply(type, requestId, { agents: projects })
          return
        }

        case 'sessions_list': {
          const projectId = payload.agentId as string | undefined
          if (!projectId) { reply(type, requestId, { error: 'MISSING_AGENT_ID' }); return }
          const s = registry.resolve(projectId)
          // An agent whose engine has not reported a session yet has no transcript to list. Saying so
          // plainly beats inventing one: the web then shows the tab with an empty thread until the bind
          // lands, instead of pinning `currentSessionId` to an id no event will ever carry.
          if (!s || !s.sessionId) { reply(type, requestId, { sessions: [] }); return }
          const lines = s.transcriptPath ? await tailFile(s.transcriptPath, Infinity) : []
          const st = s.transcriptPath ? await stat(s.transcriptPath).catch(() => null) : null
          reply(type, requestId, {
            sessions: [{
              id: s.sessionId,
              title: projectDisplayName(s),
              timestamp: new Date(s.registeredAt).toISOString(),
              messageCount: lines.length,
              lastActivity: new Date(st?.mtimeMs ?? s.updatedAt).toISOString(),
              participants: [],
            }],
          })
          return
        }

        case 'session_get': {
          const sessionId = payload.sessionId as string | undefined
          if (!sessionId) { reply(type, requestId, { error: 'MISSING_SESSION_ID' }); return }
          // Only serve transcripts for a REGISTERED tmux session, read from its own trusted
          // transcriptPath — never resolve an arbitrary request-supplied id to a file (that let a
          // caller read any *.jsonl on the computer, incl. unshared claude history / traversal).
          const s = registry.resolve(sessionId)
          if (!s) { reply(type, requestId, { error: 'NOT_FOUND' }); return }
          if (s.engine === 'devin') {
            // Devin history comes from its SQLite store (no transcript file). Same replay/window shape.
            const rawLimit = payload.limit
            const limit = typeof rawLimit === 'number' && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : undefined
            const before = typeof payload.before === 'string' ? payload.before : undefined
            const messages = await readDevinMessages(DEVIN_DB, sessionId)
            const timestamp = new Date(s.updatedAt).toISOString()
            if (!limit) {
              reply(type, requestId, { id: sessionId, title: projectDisplayName(s), events: devinMessagesToEvents(messages), timestamp, engine: s.engine })
              return
            }
            const w = windowDevinMessages(messages, { limit, before })
            if (w.staleCursor) {
              reply(type, requestId, { id: sessionId, title: projectDisplayName(s), events: [], timestamp, engine: s.engine, hasMore: false, oldestCursor: null, staleCursor: true })
              return
            }
            const events = devinMessagesToEvents(w.window)
            if (before && events[events.length - 1]?.type === 'done') events.pop()
            reply(type, requestId, { id: sessionId, title: projectDisplayName(s), events, timestamp, engine: s.engine, hasMore: w.hasMore, oldestCursor: w.oldestCursor })
            return
          }
          if (s.engine === 'hermes') {
            // Hermes history lives in its SQLite store (no transcript file). Same replay/window shape.
            const rawLimit = payload.limit
            const limit = typeof rawLimit === 'number' && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : undefined
            const before = typeof payload.before === 'string' ? payload.before : undefined
            const messages = await readHermesMessages(HERMES_DB, sessionId)
            const timestamp = new Date(s.updatedAt).toISOString()
            if (!limit) {
              reply(type, requestId, { id: sessionId, title: projectDisplayName(s), events: hermesMessagesToEvents(messages), timestamp, engine: s.engine })
              return
            }
            const w = windowHermesMessages(messages, { limit, before })
            if (w.staleCursor) {
              reply(type, requestId, { id: sessionId, title: projectDisplayName(s), events: [], timestamp, engine: s.engine, hasMore: false, oldestCursor: null, staleCursor: true })
              return
            }
            const events = hermesMessagesToEvents(w.window)
            if (before && events[events.length - 1]?.type === 'done') events.pop()
            reply(type, requestId, { id: sessionId, title: projectDisplayName(s), events, timestamp, engine: s.engine, hasMore: w.hasMore, oldestCursor: w.oldestCursor })
            return
          }
          if (s.engine === 'opencode') {
            // OpenCode history comes from its SQLite DB (no transcript file). Same replay/window shape.
            const rawLimit = payload.limit
            const limit = typeof rawLimit === 'number' && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : undefined
            const before = typeof payload.before === 'string' ? payload.before : undefined
            const messages = await readOpencodeMessages(OPENCODE_DB, sessionId)
            const timestamp = new Date(s.updatedAt).toISOString()
            if (!limit) {
              reply(type, requestId, { id: sessionId, title: projectDisplayName(s), events: opencodeMessagesToEvents(messages), timestamp, engine: s.engine })
              return
            }
            const w = windowOpencodeMessages(messages, { limit, before })
            if (w.staleCursor) {
              reply(type, requestId, { id: sessionId, title: projectDisplayName(s), events: [], timestamp, engine: s.engine, hasMore: false, oldestCursor: null, staleCursor: true })
              return
            }
            const events = opencodeMessagesToEvents(w.window)
            if (before && events[events.length - 1]?.type === 'done') events.pop()
            reply(type, requestId, { id: sessionId, title: projectDisplayName(s), events, timestamp, engine: s.engine, hasMore: w.hasMore, oldestCursor: w.oldestCursor })
            return
          }
          if (s.engine === 'kilo') {
            // Kilo history likewise comes from its SQLite DB. BOTH branches below are load-bearing: the
            // web client always sends a `limit`, so handling only the full-transcript one opens an empty
            // pane — the exact half-dispatch this file has been caught on before. Cursors are namespaced
            // `kilo:<index>` by `windowKiloMessages`, so a cursor from another engine reads as stale
            // rather than silently indexing into the wrong conversation.
            const rawLimit = payload.limit
            const limit = typeof rawLimit === 'number' && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : undefined
            const before = typeof payload.before === 'string' ? payload.before : undefined
            const messages = await readKiloMessages(KILO_DB, sessionId)
            const timestamp = new Date(s.updatedAt).toISOString()
            if (!limit) {
              reply(type, requestId, { id: sessionId, title: projectDisplayName(s), events: kiloMessagesToEvents(messages), timestamp, engine: s.engine })
              return
            }
            const w = windowKiloMessages(messages, { limit, before })
            if (w.staleCursor) {
              reply(type, requestId, { id: sessionId, title: projectDisplayName(s), events: [], timestamp, engine: s.engine, hasMore: false, oldestCursor: null, staleCursor: true })
              return
            }
            const events = kiloMessagesToEvents(w.window)
            if (before && events[events.length - 1]?.type === 'done') events.pop()
            reply(type, requestId, { id: sessionId, title: projectDisplayName(s), events, timestamp, engine: s.engine, hasMore: w.hasMore, oldestCursor: w.oldestCursor })
            return
          }
          if (!s.transcriptPath) {
            reply(type, requestId, {
              id: sessionId,
              title: projectDisplayName(s),
              events: [],
              timestamp: new Date(s.updatedAt).toISOString(),
              engine: s.engine,
              hasMore: false,
              oldestCursor: null,
            })
            return
          }
          // Optional pagination: `limit` = window size; `before` = uuid cursor (oldest line the
          // client already holds). Absent → full transcript (legacy). Clamp limit defensively.
          const rawLimit = payload.limit
          const limit = typeof rawLimit === 'number' && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : undefined
          const before = typeof payload.before === 'string' ? payload.before : undefined
          const lines = await tailFile(s.transcriptPath, Infinity)
          const st = await stat(s.transcriptPath).catch(() => null)
          const timestamp = new Date(st?.mtimeMs ?? Date.now()).toISOString()

          if (!limit) {
            const fullEvents = s.engine === 'codex'
              ? codexMessagesToEvents(lines)
              : s.engine === 'cursor'
                ? cursorMessagesToEvents(lines, sessionId, await loadCursorReplayTaskLinks(env.CURSOR_HOME, sessionId))
                : s.engine === 'muse'
                  ? museMessagesToEvents(lines)
                  : s.engine === 'amp'
                  ? await ampHistory(sessionId, lines)
                  : s.engine === 'grok'
                    ? grokHistoryPage(lines, false).events
                  : s.engine === 'pi'
                  ? piMessagesToEvents(lines)
                  : s.engine === 'commandcode'
                    ? commandcodeMessagesToEvents(lines)
                    : messagesToEvents(lines)
            if (s.engine !== 'cursor' && s.engine !== 'pi' && s.engine !== 'commandcode' && s.engine !== 'muse' && s.engine !== 'amp' && s.engine !== 'grok') await enrichSubagentStats(fullEvents, s.transcriptPath)
            reply(type, requestId, {
              id: sessionId,
              title: projectDisplayName(s),
              events: fullEvents,
              timestamp,
              engine: s.engine,
            })
            return
          }

          // Muse has no windower, so it must not fall through to the raw one: that pairs claude's
          // line-uuid cursor with claude's normalizer, and a muse transcript comes back EMPTY — the web
          // pane opened blank with no error anywhere. Until a muse window exists, answer the page with
          // the whole transcript (`hasMore: false` ends the scroll honestly, and these sessions are
          // small: a real one measured 271 lines).
          // Amp is in the same position as muse and for the same reason: no windower, so falling
          // through would pair claude's line-uuid cursor with claude's normalizer and return nothing.
          if (s.engine === 'muse' || s.engine === 'amp' || s.engine === 'grok') {
            const grokPage = s.engine === 'grok' ? grokHistoryPage(lines, true) : null
            reply(type, requestId, {
              id: sessionId,
              title: projectDisplayName(s),
              events: s.engine === 'amp'
                ? await ampHistory(sessionId, lines)
                : s.engine === 'grok'
                  ? grokPage!.events
                  : museMessagesToEvents(lines),
              timestamp,
              engine: s.engine,
              hasMore: grokPage?.hasMore ?? false,
              oldestCursor: grokPage?.oldestCursor ?? null,
            })
            return
          }
          const w = s.engine === 'codex'
            ? windowCodexLines(lines, { limit, before })
            : s.engine === 'cursor'
              ? windowCursorLines(lines, { limit, before })
              : s.engine === 'pi'
                ? windowPiLines(lines, { limit, before })
                : s.engine === 'commandcode'
                  ? windowCommandCodeLines(lines, { limit, before })
                  : windowRawLines(lines, { limit, before })
          if (w.staleCursor) {
            reply(type, requestId, { id: sessionId, title: projectDisplayName(s), events: [], timestamp, engine: s.engine, hasMore: false, oldestCursor: null, staleCursor: true })
            return
          }
          const events = s.engine === 'codex'
            ? codexMessagesToEvents(w.window)
            : s.engine === 'cursor'
              ? cursorMessagesToEvents(
                  w.window,
                  sessionId,
                  await loadCursorReplayTaskLinks(env.CURSOR_HOME, sessionId),
                  'startIndex' in w && typeof w.startIndex === 'number' ? w.startIndex : 0,
                  'initialTodos' in w && Array.isArray(w.initialTodos) ? w.initialTodos : [],
                )
              : s.engine === 'pi'
                ? piMessagesToEvents(w.window)
                : s.engine === 'commandcode'
                  ? commandcodeMessagesToEvents(w.window)
                  : messagesToEvents(w.window)
          // muse and amp are answered above and never reach here, so both are absent by design.
          if (s.engine !== 'cursor' && s.engine !== 'pi' && s.engine !== 'commandcode') await enrichSubagentStats(events, s.transcriptPath)
          // Older pages must not inject a spurious end-of-transcript marker mid-scroll.
          if (before && events[events.length - 1]?.type === 'done') events.pop()
          reply(type, requestId, {
            id: sessionId,
            title: projectDisplayName(s),
            events,
            timestamp,
            engine: s.engine,
            hasMore: w.hasMore,
            oldestCursor: w.oldestCursor,
          })
          return
        }

        case 'models_list': {
          const sessionId = typeof payload.agentId === 'string' && payload.agentId
            ? payload.agentId
            : undefined
          const models = this.runtimeModelsProvider
            ? await this.runtimeModelsProvider(sessionId)
            : [{ id: 'default', displayName: 'Remote CLI default' }]
          reply(type, requestId, {
            // The device derives labels from the opaque runtime-v1 id. Omitting the duplicate
            // displayName keeps the encrypted picker response below its 16 KiB decrypt cap.
            models: payload.compact === true
              ? compactRuntimePickerModels(models, sessionId, payload.pickerMode, payload.selectedModel)
              : models,
          })
          return
        }

        case 'agent_recent': {
          // Device tile restore at boot: the session's persisted LLM turn-summary (recap + body),
          // mirroring the hosted runtime’s SessionService.getRecentEvents. Empty until a turn was summarized
          // (device-gated) — never a resurrected full-text card.
          const projectId = payload.agentId as string | undefined
          if (!projectId) { reply(type, requestId, { error: 'MISSING_AGENT_ID' }); return }
          const n = Math.max(1, Math.min(5, Number(payload.n) || 2))
          const events = this.recentProvider ? this.recentProvider(projectId, n) : []
          reply(type, requestId, { agentId: projectId, events })
          return
        }

        case 'voice_route': {
          // Voice router (REMOTE machine): pick the best-fit agent for a transcribed Overview voice task,
          // using each agent's name + recent-turn recap. Backend-originated (connId===''), so the transcript
          // is plaintext and the reply falls through emitReply's plaintext path (voice_route is not E2EE-gated).
          const transcript = typeof payload.transcript === 'string' ? payload.transcript : ''
          if (!transcript.trim()) {
            console.log('[voice-route] backend sent an empty transcript — nothing to route')
            reply(type, requestId, { error: 'MISSING_TRANSCRIPT' })
            return
          }
          const projects = (await Promise.all(registry.list().map((s) => this.toProject(s)))).slice(0, 24) // cap the router prompt (mirror the hosted runtime path)
          const agents = projects.map((p) => {
            // Use the last 3 turns' recaps (not just 1) — a single turn can misrepresent what the agent is
            // actually working on; 3 gives the router a more stable picture.
            const recents = this.recentProvider?.(p.id, 3) ?? []
            const recentSummary = recents.map((r) => r?.recap || r?.text || '').filter(Boolean).join(' · ')
            // engine: the router classifies with a CLI the machine actually runs (a live agent proves it is
            // installed and logged in), so it has to travel with the agent.
            return { id: p.id, name: p.name, recentSummary, engine: registry.resolve(p.id)?.engine }
          })
          const decision = await routeVoiceTask(transcript, agents)   // logs the task, candidates and pick
          const chosen = projects.find((p) => p.id === decision.agentId)
          reply(type, requestId, { ...decision, agentName: chosen?.name ?? '' })
          return
        }

        case 'agent_update': {
          const projectId = payload.agentId as string | undefined
          if (!projectId) { reply(type, requestId, { error: 'MISSING_AGENT_ID' }); return }
          const hasName = Object.prototype.hasOwnProperty.call(payload, 'name')
          const hasProfile = Object.prototype.hasOwnProperty.call(payload, 'selectedModel')
          if (!hasName && !hasProfile) { reply(type, requestId, { error: 'MISSING_UPDATE' }); return }
          const name = typeof payload.name === 'string' ? payload.name.trim() : ''
          if (hasName && !name) { reply(type, requestId, { error: 'MISSING_NAME' }); return }
          let s = registry.resolve(projectId)
          if (!s) { reply(type, requestId, { error: 'AGENT_NOT_FOUND' }); return }
          if (hasProfile) {
            if (typeof payload.selectedModel !== 'string' || !this.onRuntimeProfileUpdate) {
              reply(type, requestId, { error: 'INVALID_RUNTIME_PROFILE' })
              return
            }
            try {
              await this.onRuntimeProfileUpdate(projectId, payload.selectedModel)
            } catch (error) {
              const code: RuntimeProfileErrorCode | 'INTERNAL' = error instanceof RuntimeProfileControlError ? error.code : 'INTERNAL'
              reply(type, requestId, { error: code })
              return
            }
          }
          if (hasName) s = registry.rename(projectId, name) ?? s
          const agent = await this.toProject(s)
          reply(type, requestId, { agent })
          if (hasName) {
            const renamed = { type: 'agent_renamed', payload: { agentId: s.agentId, name, engine: s.engine } }
            this.send(renamed)          // every OTHER web client on this machine (group-encrypted)
            this.sendCommander(renamed) // and the device
            // The whole rename path was silent end to end, which is why "web1 renamed it, web2 never saw
            // it" had no evidence to work from: nothing said whether the request even arrived. One line
            // here splits the question in two — no line means it never reached the adapter, a line means
            // the fan-out is downstream.
            console.log(`[rename] ${sid(projectId)} → "${preview(name, 40)}" · broadcast to web + device`)
          }
          return
        }

        // A project IS a tmux session; the web/device can't CREATE one remotely.
        case 'agent_create':
          reply(type, requestId, { error: 'UNSUPPORTED_ON_REMOTE' })
          return

        // Delete an agent: kill its tmux pane (if any) + drop it from the list. Idempotent — an already
        // gone target still acks + re-emits agent_deleted so the web/device converge. E2EE-gated (the
        // frame arrived decrypted). Keeps the persisted recap + agent name for a later resume.
        case 'agent_delete': {
          const target = (payload.agentId as string | undefined) || (payload.sessionId as string | undefined)
          if (!target) { reply(type, requestId, { error: 'MISSING_AGENT_ID' }); return }
          this.onDeleteAgent?.(target)
          reply(type, requestId, { deleted: true })
          return
        }

        case 'agent_files': {
          // SourceTree list — rooted at the tmux session's working dir.
          const projectId = payload.agentId as string | undefined
          if (!projectId) { reply(type, requestId, { error: 'MISSING_AGENT_ID' }); return }
          const s = registry.resolve(projectId)
          if (!s?.cwd) { reply(type, requestId, { error: 'AGENT_NOT_FOUND' }); return }
          try { reply(type, requestId, { files: listFileTree(s.cwd) }) }
          catch (e) { reply(type, requestId, { error: e instanceof Error ? e.message : 'FILE_TREE_ERROR' }) }
          return
        }

        case 'agent_read_file': {
          // View one file — ≤5MB, text-only (mirror the hosted runtime’s guard).
          const projectId = payload.agentId as string | undefined
          const path = payload.path as string | undefined
          if (!projectId || !path) { reply(type, requestId, { error: 'MISSING_AGENT_OR_PATH' }); return }
          const s = registry.resolve(projectId)
          if (!s?.cwd) { reply(type, requestId, { error: 'AGENT_NOT_FOUND' }); return }
          try { reply(type, requestId, { path, content: readProjectFile(s.cwd, path) }) }
          catch (e) { reply(type, requestId, { error: e instanceof Error ? e.message : 'NOT_FOUND' }) }
          return
        }

        case 'claude_login_status':
          // Legacy RPC name; report the selected agent's actual engine when one was supplied.
          {
            const target = (payload.agentId as string | undefined) || (payload.sessionId as string | undefined)
            reply(type, requestId, { loggedIn: true, engine: (target ? registry.resolve(target)?.engine : undefined) ?? 'claude', account: hostname() })
          }
          return

        case 'message': {
          const content = payload.content as string | undefined
          const target = (payload.agentId as string | undefined) || (payload.sessionId as string | undefined)
          if (!content || !target) return
          // Inject into the pane; the resulting JSONL user/assistant lines drive the turn lifecycle back
          // to the web (mirror-all) — no synthetic events here. Prefer cli.ts's handler (inject + Enter
          // retry); fall back to a direct inject when unwired (isolation/tests).
          if (this.onMessage) this.onMessage(target, content)
          else { const s = registry.resolve(target); if (s?.tmuxPane) void sendToTmux(s.tmuxPane, content) }
          return
        }

        case 'cancel': {
          const target = (payload.agentId as string | undefined) || (payload.sessionId as string | undefined)
          if (target) this.onCancel?.(target)
          return
        }

        case 'speaking': {
          // A device is capturing a voice instruction. Mirror the hosted runtime: re-broadcast the presence
          // signal to the web (indicator) + other devices. Ephemeral, no requestId.
          const p = payload as { speaking?: boolean; agentId?: string; sessionId?: string }
          const sessionId = p.sessionId ?? p.agentId
          const projectId = p.agentId ?? p.sessionId ?? null
          const on = p.speaking !== false
          // Echo the canonical agent id, whichever id the sender used to address it.
          const speaker = projectId ? registry.resolve(projectId) : undefined
          const speakerAgentId = speaker?.agentId ?? projectId
          const evt = { type: 'speaking', dbSessionId: speaker?.sessionId ?? sessionId, agentId: speakerAgentId, payload: { speaking: on, agentId: speakerAgentId, sessionId: speaker?.sessionId ?? sessionId } }
          this.send(evt) // web
          this.sendCommander(evt) // other devices (firmware ignores its own echo; matches node forwardToCommander)
          return
        }

        case 'question_response': {
          // A device answered an AskUserQuestion. There's no control channel into an interactive CLI, so
          // cli.ts keys the answer straight into that session's tmux dialog.
          const p = payload as { requestId?: string; sessionId?: string; agentId?: string; answers?: Record<string, string> }
          this.onQuestionAnswer?.(p)
          return
        }

        // v1 no-ops: no programmatic session control over an interactive tmux claude.
        case 'new_chat':
        case 'compact':
        case 'permission_response':
          return

        default:
          // Unknown RPC with a requestId: reject fast so the web promise doesn't wait out its 20s.
          if (requestId !== undefined) reply(type, requestId, { error: 'UNSUPPORTED' })
          return
      }
    } catch (err) {
      console.error(`[backend] dispatch ${type} failed:`, err)
      if (requestId !== undefined) reply(type, requestId, { error: 'INTERNAL' })
    }
  }

  /** Map a registered tmux session onto the web's Project shape (tabs in ProjectTabs). */
  private async toProject(s: RegisteredSession): Promise<{
    id: string; userId: string; name: string; status: string
    createdAt: string; updatedAt: string; tmuxPane: string | null; engine: RegisteredSession['engine']; selectedModel: string | null
  }> {
    const st = s.transcriptPath ? await stat(s.transcriptPath).catch(() => null) : null
    return {
      id: s.agentId,
      userId: '',
      name: projectDisplayName(s),
      status: 'active',
      createdAt: new Date(s.registeredAt).toISOString(),
      updatedAt: new Date(st?.mtimeMs ?? s.updatedAt).toISOString(),
      tmuxPane: s.tmuxPane,
      engine: s.engine,
      selectedModel: this.runtimeProfileProvider?.(s) ?? null,
    }
  }
}
