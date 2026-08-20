/**
 * Registry of process-owned AGENTS — one per supported top-level engine process in a tmux pane.
 *
 * An agent is created the moment process discovery observes it and lives exactly as long as that process.
 * The ENGINE
 * session is a mapping bound to the agent afterwards, and rebound whenever the engine rotates it
 * (`/clear`, `/new`) — the agent, its tab, its name and its place in the list do not move.
 *
 * Two indexes, because the outside world speaks both languages: `agentId` for anything the user
 * addresses, and a bare `sessionId` for turn control (`cancel`, `question_response`, `session_get`).
 * `resolve()` accepts either. Persisted to disk so a live agent survives a self-update restart.
 *
 * Module singleton (like the ws `clients` set) — imported by routes + reaper.
 */

import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'crypto'
import { join, basename, dirname, relative } from 'path'
import { uptime } from 'os'
import { env } from '../config/env.js'
import { readCodexRolloutMeta, resolveCodexRollout } from '../engines/codex/rollout.js'
import { ENGINES, type AgentEngine } from '../engines/types.js'
import { commandcodeTranscriptPath } from '../engines/commandcode/transcript.js'
import { agyTranscriptPath } from '../engines/agy/session.js'
import { copilotTranscriptPath } from '../engines/copilot/session.js'
import { hardenPrivateStateFileIfPresent, readPrivateStateFile, secureStateDirectory } from './secureState.js'
import { mergeTerminalRuntimes, processIdentityKey, terminalPlacementKey, terminalRouteKey } from './terminalRuntime.js'
import type { HookTerminalHint, ProcessIdentity, TerminalRuntimeRef } from './terminalTypes.js'

export type { ProcessIdentity } from './terminalTypes.js'

/** Claude Code's hooks report `model` as {id, display_name}; Codex/Cursor report a plain string. This is
 *  the boundary where hook JSON becomes persisted state, so anything else is dropped rather than stored —
 *  a non-string here reaches runtimeProfile's `.toLowerCase()` and takes the daemon down AT STARTUP, which
 *  no restart can heal because the bad value is on disk. */
function modelString(value: unknown): string | null {
  if (typeof value === 'string') return value.slice(0, 200)
  const id = (value as { id?: unknown } | null)?.id
  return typeof id === 'string' ? id.slice(0, 200) : null
}

export interface RegisteredSession {
  /** Per-row marker; the top-level array is retained for backward-reader safety. */
  schemaVersion: 2
  /** Dormant records retain identity/bindings but are not advertised until a runtime is verified again. */
  active: boolean
  /**
   * THE AGENT. Public identity: this is what web tabs, device tiles and every inbound frame address.
   *
   * It is minted when a top-level engine process is first discovered. The persisted process identity lets
   * the same UUID survive daemon restarts while the engine underneath rotates sessions (`/clear`, `/new`).
   */
  agentId: string
  /**
   * The engine session currently BOUND to this agent — internal mapping, not identity. It changes on a
   * rotation and is only ever addressed through the session index.
   */
  sessionId: string
  /** When the CURRENT sessionId was bound (vs `registeredAt`, which is when the agent appeared). */
  boundAt: number | null
  engine: AgentEngine
  /**
   * Set when the engine process is pointed at an OpenRouter endpoint (`ori claude`, `ori codex`, …).
   *
   * It is NOT a second engine: the engine stays `claude`/`codex`/… and every badge, icon and wire field
   * keeps saying so. It only records HOW the pane's requests are billed, which decides two things — the
   * runtime profile becomes display-only, and the daemon's recap/route calls go direct to OpenRouter
   * instead of spawning a vendor CLI that has no credential. Re-derived from the live process on every
   * discovery, so a pane restarted without the wrapper drops it on the next scan.
   */
  gateway?: 'ori' | null
  /** Legacy launcher-owned snapshots may still contain this field. New records never write it. */
  launcherId?: string
  transcriptPath: string | null
  projectDir: string
  cwd: string | null
  /** Authoritative backend-neutral terminal placements for this one process-owned agent. */
  runtimes: TerminalRuntimeRef[]
  primaryRuntimeKey: string
  /** Additive rollback/wire projection. Empty in memory and omitted on disk for Herdr-only agents. */
  tmuxPane: string
  source: string | null
  title: string | null
  model: string | null
  cliVersion: string | null
  processIdentity: ProcessIdentity | null
  registeredAt: number
  updatedAt: number
  lastHookAt: number
  lastTranscriptAt: number
}

export interface RegisterInput {
  engine?: AgentEngine
  /** Accepted from old hook/plugin payloads for wire compatibility, but deliberately ignored. */
  launcherId?: string
  sessionId?: string
  transcriptPath?: string
  cwd?: string
  source?: string
  tmuxPane?: string
  title?: string
  model?: string
  cliVersion?: string
  processIdentity?: ProcessIdentity
  /** New authenticated hooks may supply resolved runtime hints. Legacy hooks continue to use tmuxPane. */
  runtimes?: TerminalRuntimeRef[]
  primaryRuntimeKey?: string
  runtimeHints?: HookTerminalHint[]
  callerPid?: number
  hookEvent?: string
}

/** Display name for a session's "project" tab/tile. A user rename (persisted override) is
 *  authoritative and FIXED — it must NOT drift back to the tmux pane title, which Claude keeps
 *  rewriting to the latest convo topic. Only a session the user never renamed auto-follows the title,
 *  then falls back to "<id4> · <folder>". */
export function projectDisplayName(s: RegisteredSession): string {
  return NAME_OVERRIDES.get(s.sessionId) || NAME_OVERRIDES.get(s.agentId) || titleDisplayName(s.title) || defaultProjectDisplayName(s)
}

const FILE = join(env.ADAPTER_DATA_DIR, 'registry.json')
const NAMES_FILE = join(env.ADAPTER_DATA_DIR, 'agent-names.json')
const BOOT_FILE = join(env.ADAPTER_DATA_DIR, 'registry-boot')
const LOCK_DIR = join(env.ADAPTER_DATA_DIR, 'registry.json.lock')
const PRE_V2_BACKUP_FILE = join(env.ADAPTER_DATA_DIR, 'registry.pre-v2.json')
const NAME_OVERRIDES = new Map<string, string>()

const PANE_RE = /^%\d+$/
const GROK_SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const AGENT_ENGINES: ReadonlySet<string> = new Set(ENGINES)

function normalizedAgentEngine(value: unknown): AgentEngine {
  return typeof value === 'string' && AGENT_ENGINES.has(value)
    ? value as AgentEngine
    : 'claude'
}
const LOCK_WAIT_MS = 20
const LOCK_ATTEMPTS = 100

function sleepSync(ms: number): void {
  const view = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(view, 0, 0, ms)
}

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function processStartMarker(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    if (fields[19]) return `linux:${fields[19]}`
  } catch { /* non-Linux or exited process; use ps below */ }
  try {
    const started = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', timeout: 1_000,
    }).trim()
    return started ? `ps:${started}` : null
  } catch { return null }
}

function lockOwnerAlive(pid: number, startMarker: string): boolean {
  if (!processExists(pid)) return false
  if (!startMarker) return true
  const current = processStartMarker(pid)
  return current === null || current === startMarker
}

function removeRegistryLockOwnedBy(token: string): void {
  try {
    const saved = JSON.parse(readFileSync(join(LOCK_DIR, 'owner.json'), 'utf8')) as { token?: unknown }
    if (saved.token === token) rmSync(LOCK_DIR, { recursive: true, force: true })
  } catch { /* another owner or an unsafe artifact must not be removed */ }
}

function withRegistryFileLock<T>(apply: () => T): T {
  secureStateDirectory(env.ADAPTER_DATA_DIR)
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  const processMarker = processStartMarker(process.pid) ?? ''
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    const token = randomUUID()
    let created = false
    try {
      mkdirSync(LOCK_DIR, { mode: 0o700 })
      created = true
      const owner = join(LOCK_DIR, 'owner.json')
      const fd = openSync(owner, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, startMarker: processMarker, token }))
        fsyncSync(fd)
      } finally { closeSync(fd) }
      try {
        return apply()
      } finally {
        removeRegistryLockOwnedBy(token)
      }
    } catch (error) {
      if (created) removeRegistryLockOwnedBy(token)
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let ownerPid = 0
      let ownerStartMarker = ''
      let ownerToken = ''
      try {
        const stat = lstatSync(LOCK_DIR)
        if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== null && stat.uid !== uid)
          || (stat.mode & 0o777) !== 0o700) throw new Error('registry lock has unsafe owner, mode, or type')
        const ownerStat = lstatSync(join(LOCK_DIR, 'owner.json'))
        if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || (uid !== null && ownerStat.uid !== uid)
          || (ownerStat.mode & 0o777) !== 0o600) throw new Error('registry lock owner has unsafe owner, mode, or type')
        const owner = JSON.parse(readFileSync(join(LOCK_DIR, 'owner.json'), 'utf8')) as {
          pid?: unknown; startMarker?: unknown; token?: unknown
        }
        ownerPid = Number(owner.pid)
        ownerStartMarker = typeof owner.startMarker === 'string' ? owner.startMarker : ''
        ownerToken = typeof owner.token === 'string' ? owner.token : ''
      } catch (inspectionError) {
        if (inspectionError instanceof Error && inspectionError.message.startsWith('registry lock')) throw inspectionError
      }
      if (ownerPid > 0 && ownerToken && !lockOwnerAlive(ownerPid, ownerStartMarker)) {
        try {
          const current = JSON.parse(readFileSync(join(LOCK_DIR, 'owner.json'), 'utf8')) as {
            pid?: unknown; startMarker?: unknown; token?: unknown
          }
          if (Number(current.pid) === ownerPid
            && current.startMarker === ownerStartMarker
            && current.token === ownerToken
            && !lockOwnerAlive(ownerPid, ownerStartMarker)) {
            rmSync(LOCK_DIR, { recursive: true, force: true })
            continue
          }
        } catch { /* lock changed or disappeared; retry without deleting another owner's lock */ }
      }
      sleepSync(LOCK_WAIT_MS)
    }
  }
  throw new Error('registry lock is busy')
}

function rowId(row: unknown): string {
  if (!row || typeof row !== 'object') return ''
  const candidate = row as { agentId?: unknown; launcherId?: unknown }
  return typeof candidate.agentId === 'string' && candidate.agentId
    ? candidate.agentId
    : typeof candidate.launcherId === 'string' ? candidate.launcherId : ''
}

function rowFingerprint(row: unknown): string {
  return JSON.stringify(row)
}

function atomicWriteJson(file: string, value: unknown, exclusive = false): void {
  const exists = hardenPrivateStateFileIfPresent(file)
  if (exclusive && exists) return
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  let renamed = false
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      writeFileSync(fd, JSON.stringify(value, null, 2))
      fchmodSync(fd, 0o600)
      fsyncSync(fd)
    } finally { closeSync(fd) }
    renameSync(temporary, file)
    renamed = true
    const directoryFd = openSync(dirname(file), 'r')
    try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
  } finally {
    if (!renamed) rmSync(temporary, { force: true })
  }
}

function boundedIdentityPart(value: unknown, max = 200): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
}

export function validTerminalRuntime(value: unknown): value is TerminalRuntimeRef {
  if (!value || typeof value !== 'object') return false
  const runtime = value as Partial<TerminalRuntimeRef>
  if (runtime.backend === 'tmux') return typeof runtime.paneId === 'string' && PANE_RE.test(runtime.paneId)
  return runtime.backend === 'herdr'
    && boundedIdentityPart(runtime.endpointId)
    && boundedIdentityPart(runtime.sessionName, 100)
    && boundedIdentityPart(runtime.terminalId)
    && boundedIdentityPart(runtime.paneId)
}

function normalizedRuntimes(raw: unknown, legacyTmuxPane?: unknown): TerminalRuntimeRef[] {
  const fromArray = Array.isArray(raw) ? raw.filter(validTerminalRuntime) : []
  const legacy = typeof legacyTmuxPane === 'string' && PANE_RE.test(legacyTmuxPane)
    ? [{ backend: 'tmux' as const, paneId: legacyTmuxPane }]
    : []
  return mergeTerminalRuntimes([], [...fromArray, ...legacy])
}

function tmuxProjection(runtimes: readonly TerminalRuntimeRef[]): string {
  return runtimes.find((runtime) => runtime.backend === 'tmux')?.paneId ?? ''
}

function persistedRow(entry: RegisteredSession): RegisteredSession | Omit<RegisteredSession, 'tmuxPane'> {
  if (entry.tmuxPane) return { ...entry, runtimes: entry.runtimes.map((runtime) => ({ ...runtime })) }
  const { tmuxPane: _legacy, ...row } = entry
  return { ...row, runtimes: row.runtimes.map((runtime) => ({ ...runtime })) }
}

function strictPersistedRow(value: unknown): RegisteredSession | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Partial<RegisteredSession>
  const runtimes = normalizedRuntimes(row.runtimes, row.tmuxPane)
  const primary = typeof row.primaryRuntimeKey === 'string' ? row.primaryRuntimeKey : ''
  const active = row.active === true
  const projectedTmuxPane = tmuxProjection(runtimes)
  if (row.schemaVersion !== 2
    || typeof row.active !== 'boolean'
    || typeof row.agentId !== 'string' || !row.agentId
    || typeof row.sessionId !== 'string'
    || typeof row.engine !== 'string' || !AGENT_ENGINES.has(row.engine as AgentEngine)
    || typeof row.projectDir !== 'string'
    || typeof row.primaryRuntimeKey !== 'string'
    || !Array.isArray(row.runtimes) || runtimes.length !== row.runtimes.length || !runtimes.length
    || (projectedTmuxPane ? row.tmuxPane !== projectedTmuxPane : row.tmuxPane !== undefined)
    || (active && !runtimes.some((runtime) => terminalRouteKey(runtime) === primary))
    || (!active && primary !== '')
    || (row.processIdentity !== null && !validProcessIdentity(row.processIdentity))) return null
  const placements = runtimes.map(terminalPlacementKey)
  if (new Set(placements).size !== placements.length) return null
  return {
    ...row,
    schemaVersion: 2,
    active,
    agentId: row.agentId,
    sessionId: row.sessionId,
    boundAt: typeof row.boundAt === 'number' ? row.boundAt : null,
    engine: row.engine as AgentEngine,
    transcriptPath: typeof row.transcriptPath === 'string' ? row.transcriptPath : null,
    projectDir: row.projectDir,
    cwd: typeof row.cwd === 'string' ? row.cwd : null,
    runtimes,
    primaryRuntimeKey: primary,
    tmuxPane: projectedTmuxPane,
    source: typeof row.source === 'string' ? row.source : null,
    title: typeof row.title === 'string' ? row.title : null,
    model: modelString(row.model),
    cliVersion: typeof row.cliVersion === 'string' ? row.cliVersion : null,
    processIdentity: row.processIdentity ?? null,
    registeredAt: typeof row.registeredAt === 'number' ? row.registeredAt : Date.now(),
    updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : Date.now(),
    lastHookAt: typeof row.lastHookAt === 'number' ? row.lastHookAt : Date.now(),
    lastTranscriptAt: typeof row.lastTranscriptAt === 'number' ? row.lastTranscriptAt : Date.now(),
  }
}

function validatedRows(values: readonly unknown[]): RegisteredSession[] | null {
  const rows: RegisteredSession[] = []
  const agents = new Set<string>()
  const sessions = new Set<string>()
  const processes = new Set<string>()
  const routes = new Set<string>()
  for (const value of values) {
    const row = strictPersistedRow(value)
    if (!row || agents.has(row.agentId)) return null
    agents.add(row.agentId)
    if (row.sessionId) {
      if (sessions.has(row.sessionId)) return null
      sessions.add(row.sessionId)
    }
    if (row.processIdentity) {
      const key = processIdentityKey(row.engine, row.processIdentity)
      if (processes.has(key)) return null
      processes.add(key)
    }
    for (const runtime of row.runtimes) {
      const key = terminalRouteKey(runtime)
      if (routes.has(key)) return null
      routes.add(key)
    }
    rows.push(row)
  }
  return rows
}

function hasUnknownRowSchema(value: unknown): boolean {
  return !!value && typeof value === 'object'
    && Object.hasOwn(value, 'schemaVersion')
    && (value as { schemaVersion?: unknown }).schemaVersion !== 2
}

function validLegacyRegistryRow(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.hasOwn(value, 'schemaVersion')) return false
  const row = value as Partial<RegisteredSession>
  const id = rowId(row)
  if (!boundedIdentityPart(id)) return false
  if (row.engine !== undefined && (typeof row.engine !== 'string' || !AGENT_ENGINES.has(row.engine))) return false
  if (row.tmuxPane !== undefined && (typeof row.tmuxPane !== 'string' || !PANE_RE.test(row.tmuxPane))) return false
  if (row.runtimes !== undefined
    && (!Array.isArray(row.runtimes) || !row.runtimes.length || !row.runtimes.every(validTerminalRuntime))) return false
  return normalizedRuntimes(row.runtimes, row.tmuxPane).length > 0
}

function threeWayRow(
  baselineJson: string | undefined,
  current: Record<string, unknown>,
  latest: Record<string, unknown>,
): Record<string, unknown> {
  let baseline: Record<string, unknown> = {}
  try { baseline = baselineJson ? JSON.parse(baselineJson) as Record<string, unknown> : {} } catch { /* empty */ }
  const merged: Record<string, unknown> = { ...latest }
  for (const key of Object.keys(baseline)) {
    if (!(key in current)) delete merged[key]
  }
  for (const [key, value] of Object.entries(current)) {
    if (JSON.stringify(value) !== JSON.stringify(baseline[key])) merged[key] = value
  }
  return merged
}

function selectedRuntimeKey(runtimes: readonly TerminalRuntimeRef[], requested: unknown): string {
  const keys = new Set(runtimes.map(terminalRouteKey))
  return typeof requested === 'string' && keys.has(requested)
    ? requested
    : runtimes[0] ? terminalRouteKey(runtimes[0]) : ''
}

function isWithin(root: string, file: string): boolean {
  const rel = relative(root, file)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`/`) && !rel.startsWith(`\\`))
}

export function validTranscriptPath(engine: AgentEngine, filePath: string): boolean {
  try {
    const actual = realpathSync(filePath)
    const root = realpathSync(
      // Amp's root is OURS, not Amp's: the transcript is written by the adapter's own plugin because Amp
      // keeps no conversation on disk (see installAmpPlugin).
      engine === 'amp'
        ? env.AMP_SESSIONS_DIR
        : engine === 'muse'
        ? join(env.MUSE_HOME, 'sessions')
        : engine === 'codex'
        ? join(env.CODEX_HOME, 'sessions')
        : engine === 'grok'
        ? join(env.GROK_HOME, 'sessions')
        : engine === 'agy'
        ? join(env.AGY_HOME, 'brain')
        : engine === 'copilot'
        ? join(env.COPILOT_HOME, 'session-state')
        : engine === 'cursor'
          ? join(env.CURSOR_HOME, 'projects')
          : engine === 'pi'
            ? join(env.PI_HOME, 'agent', 'sessions')
            : engine === 'commandcode'
              ? join(env.COMMANDCODE_HOME, 'projects')
              : env.CLAUDE_PROJECTS_DIR,
    )
    const st = statSync(actual)
    if (!st.isFile() || !isWithin(root, actual)) return false
    if (engine === 'cursor') {
      const id = basename(actual).replace(/\.jsonl$/, '')
      if (!id || basename(dirname(actual)) !== id || basename(dirname(dirname(actual))) !== 'agent-transcripts') return false
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    return uid === null || st.uid === uid
  } catch {
    return false
  }
}

/** Prefer the kernel boot UUID; retain numeric marker compatibility for one migration. */
const BOOT_TOLERANCE_SEC = 120 // clock/NTP drift is seconds; a reboot shifts boot time by the whole uptime
function bootTimeSec(): number {
  return Math.round(Date.now() / 1000 - uptime())
}
function currentBootId(): string {
  try {
    const value = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    if (/^[0-9a-f-]{36}$/i.test(value)) return `linux:${value}`
  } catch { /* non-Linux fallback below */ }
  return `time:${bootTimeSec()}`
}
function readSavedBoot(): string | null {
  try {
    const raw = readPrivateStateFile(BOOT_FILE, 256).trim()
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as unknown
      return typeof parsed === 'string' ? parsed : raw
    } catch { return raw }
  } catch { return null }
}
function bootChanged(saved: string | null, current: string): boolean {
  if (!saved) return false
  if (saved.startsWith('linux:')) return saved !== current
  const savedNumber = Number(saved.replace(/^time:/, ''))
  const currentNumber = current.startsWith('time:') ? Number(current.slice(5)) : bootTimeSec()
  return !Number.isFinite(savedNumber) || Math.abs(currentNumber - savedNumber) > BOOT_TOLERANCE_SEC
}
function writeBoot(bootId: string): void {
  try {
    secureStateDirectory(env.ADAPTER_DATA_DIR)
    atomicWriteJson(BOOT_FILE, bootId)
  } catch { /* registry load will remain conservative on the next restart */ }
}

class Registry {
  /** agentId → record. The store. */
  private agents = new Map<string, RegisteredSession>()
  /** engine sessionId → agentId. Needed because web and device address turn control with a bare
   *  `sessionId` (`cancel`, `question_response`, `compact`, `session_get`) while everything else
   *  addresses the agent. `resolve()` is the one lookup that accepts either. */
  private sessionIndex = new Map<string, string>()
  /** backend-scoped route → agentId. Public Herdr pane ids are never indexed without endpointId. */
  private runtimeIndex = new Map<string, string>()
  /** engine + PID start marker → agentId. This is authoritative across nested multiplexers. */
  private processIndex = new Map<string, string>()
  private transactionDepth = 0
  private savePending = false
  /** Root corruption/unknown schemas are read-only until the operator restores valid bytes. */
  private writeBlocked = false
  /** Last committed row bytes, used for a three-way merge with daemon-down hook writes. */
  private persistedBaseline = new Map<string, string>()

  private index(entry: RegisteredSession): void {
    this.agents.set(entry.agentId, entry)
    if (entry.sessionId) this.sessionIndex.set(entry.sessionId, entry.agentId)
    for (const runtime of entry.runtimes) this.runtimeIndex.set(terminalRouteKey(runtime), entry.agentId)
    if (entry.processIdentity) this.processIndex.set(processIdentityKey(entry.engine, entry.processIdentity), entry.agentId)
  }

  private drop(entry: RegisteredSession | undefined): void {
    if (!entry) return
    this.agents.delete(entry.agentId)
    if (entry.sessionId && this.sessionIndex.get(entry.sessionId) === entry.agentId) {
      this.sessionIndex.delete(entry.sessionId)
    }
    for (const runtime of entry.runtimes) {
      const key = terminalRouteKey(runtime)
      if (this.runtimeIndex.get(key) === entry.agentId) this.runtimeIndex.delete(key)
    }
    if (entry.processIdentity) {
      const key = processIdentityKey(entry.engine, entry.processIdentity)
      if (this.processIndex.get(key) === entry.agentId) this.processIndex.delete(key)
    }
  }

  private releaseBinding(entry: RegisteredSession): void {
    if (entry.sessionId && this.sessionIndex.get(entry.sessionId) === entry.agentId) {
      this.sessionIndex.delete(entry.sessionId)
    }
    entry.sessionId = ''
    entry.boundAt = null
    entry.transcriptPath = null
    entry.source = null
    entry.lastTranscriptAt = Date.now()
  }

  /** Load persisted process agents. Invalid session bindings are released without dropping their agent;
   *  a reboot still drops all cached pane identities because no process can survive it. */
  load(): void {
    this.agents.clear()
    this.sessionIndex.clear()
    this.runtimeIndex.clear()
    this.processIndex.clear()
    this.writeBlocked = false
    this.persistedBaseline.clear()
    try {
      secureStateDirectory(env.ADAPTER_DATA_DIR)
    } catch (error) {
      this.writeBlocked = true
      console.error('[registry] unsafe state directory; refusing to load or write state:', error)
      return
    }
    this.loadNames()
    const savedBoot = readSavedBoot()
    const bootId = currentBootId()
    const rebooted = bootChanged(savedBoot, bootId)
    writeBoot(bootId) // refresh the reference so a reboot is detected exactly once, even across same-boot restarts
    try {
      const parsed = JSON.parse(readPrivateStateFile(FILE)) as unknown
      if (!Array.isArray(parsed)) {
        this.writeBlocked = true
        console.error('[registry] registry root is not an array; refusing to overwrite it')
        return
      }
      if (parsed.some(hasUnknownRowSchema)) {
        this.writeBlocked = true
        console.error('[registry] registry contains an unknown row schema; refusing to overwrite it')
        return
      }
      const legacyRows = parsed.filter((row) => !row || typeof row !== 'object' || !Object.hasOwn(row, 'schemaVersion'))
      if (legacyRows.some((row) => !validLegacyRegistryRow(row))) {
        this.writeBlocked = true
        console.error('[registry] registry contains a malformed legacy row; refusing to overwrite it')
        return
      }
      const v2Rows = parsed.filter((row) => !!row && typeof row === 'object'
        && (row as { schemaVersion?: unknown }).schemaVersion === 2)
      if (v2Rows.length && !validatedRows(v2Rows)) {
        this.writeBlocked = true
        console.error('[registry] registry contains a malformed v2 row; refusing to overwrite it')
        return
      }
      const arr = parsed as Array<Partial<RegisteredSession>>
      for (const row of arr) {
        const id = rowId(row)
        if (id) this.persistedBaseline.set(id, rowFingerprint(row))
      }
      if (arr.some((row) => row.schemaVersion !== 2)) {
        atomicWriteJson(PRE_V2_BACKUP_FILE, arr, true)
      }
      if (rebooted) {
        console.log(`[registry] machine rebooted since last run — dropping ${Array.isArray(arr) ? arr.length : 0} cached tmux session(s) (stale panes)`)
        this.save() // overwrite the stale on-disk snapshot so a same-boot restart can't reload it
        return
      }
      let changed = false
      for (const raw of Array.isArray(arr) ? arr : []) {
        const engine = normalizedAgentEngine(raw?.engine)
        const runtimes = normalizedRuntimes(raw?.runtimes, raw?.tmuxPane)
        const pane = tmuxProjection(runtimes)
        let transcriptPath =
          typeof raw?.transcriptPath === 'string' && raw.transcriptPath
            ? raw.transcriptPath
            : null
        let bound = typeof raw?.sessionId === 'string' && raw.sessionId !== ''
        const rawSessionId = typeof raw?.sessionId === 'string' ? raw.sessionId : ''
        let repairedCodexTranscript = false
        if (engine === 'codex' && transcriptPath) {
          const meta = readCodexRolloutMeta(transcriptPath)
          if (meta?.isSubagent) {
            const repaired = meta.parentThreadId === rawSessionId
              ? resolveCodexRollout(rawSessionId, join(env.CODEX_HOME, 'sessions'))
              : null
            if (!repaired || !validTranscriptPath('codex', repaired) || readCodexRolloutMeta(repaired)?.isSubagent) {
              changed = true
              bound = false
              transcriptPath = null
            } else {
              console.log(`[registry] repaired Codex parent ${rawSessionId.slice(0, 8)} transcript after child hook overwrite`)
              transcriptPath = repaired
              repairedCodexTranscript = true
              changed = true
            }
          }
        }
        // A process agent remains valid without a session. A missing/invalid transcript releases only the
        // binding so the discovery/store repair path can bind it again if appropriate.
        if (!bound) transcriptPath = null
        if (!runtimes.length) {
          changed = true
          continue
        }
        if (
          (bound && engine !== 'cursor' && engine !== 'opencode' && engine !== 'kilo' && engine !== 'pi' && engine !== 'hermes' && engine !== 'commandcode' && engine !== 'devin' && !transcriptPath)
          || (bound && transcriptPath !== null && !validTranscriptPath(engine, transcriptPath))
        ) {
          bound = false
          transcriptPath = null
          changed = true
        }
        // Old launcher-owned records used launcherId as the public id. Preserve it while process discovery
        // validates/adopts the live runtime, then save the record without the legacy ownership field.
        const legacyLauncherId = typeof raw?.launcherId === 'string' ? raw.launcherId : ''
        const agentId = typeof raw.agentId === 'string' && raw.agentId ? raw.agentId : legacyLauncherId
        if (!agentId) { changed = true; continue }
        if (agentId !== raw.agentId) changed = true
        const now = Date.now()
        const active = raw.active !== false
        const s: RegisteredSession = {
          schemaVersion: 2,
          active,
          agentId,
          boundAt: bound ? (typeof raw.boundAt === 'number' ? raw.boundAt : (raw.registeredAt ?? now)) : null,
          engine,
          transcriptPath,
          title: titleDisplayName(typeof raw.title === 'string' ? raw.title : null),
          sessionId: bound ? rawSessionId : '',
          projectDir: !repairedCodexTranscript && typeof raw.projectDir === 'string' && raw.projectDir
            ? raw.projectDir
            : transcriptPath
              ? basename(dirname(transcriptPath))
              : (bound ? rawSessionId : agentId),
          tmuxPane: pane,
          runtimes,
          primaryRuntimeKey: active ? selectedRuntimeKey(runtimes, raw.primaryRuntimeKey) : '',
          cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
          source: bound && typeof raw.source === 'string' ? raw.source : null,
          cliVersion: typeof raw.cliVersion === 'string' ? raw.cliVersion : null,
          model: modelString(raw.model),
          processIdentity: validProcessIdentity(raw.processIdentity) ? raw.processIdentity : null,
          registeredAt: typeof raw.registeredAt === 'number' ? raw.registeredAt : now,
          updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
          lastHookAt: typeof raw.lastHookAt === 'number' ? raw.lastHookAt : (raw.updatedAt ?? now),
          lastTranscriptAt: typeof raw.lastTranscriptAt === 'number' ? raw.lastTranscriptAt : (raw.updatedAt ?? now),
        }
        if (
          raw.engine !== engine
          || raw.schemaVersion !== 2
          || typeof raw.active !== 'boolean'
          || raw.tmuxPane !== pane
          || JSON.stringify(raw.runtimes) !== JSON.stringify(runtimes)
          || raw.primaryRuntimeKey !== s.primaryRuntimeKey
          || raw.transcriptPath !== transcriptPath
          || raw.title !== s.title
          || raw.lastHookAt == null
          || raw.lastTranscriptAt == null
          || legacyLauncherId !== ''
        ) changed = true
        if (this.agents.has(s.agentId)) {
          this.agents.clear()
          this.sessionIndex.clear()
          this.runtimeIndex.clear()
          this.processIndex.clear()
          this.writeBlocked = true
          console.error('[registry] registry contains duplicate agent identities; refusing to load or overwrite it')
          return
        }
        this.index(s)
      }
      if (!validatedRows(this.list().map(persistedRow))) {
        this.agents.clear()
        this.sessionIndex.clear()
        this.runtimeIndex.clear()
        this.processIndex.clear()
        this.writeBlocked = true
        console.error('[registry] registry violates global identity invariants; refusing to load or overwrite it')
        return
      }
      if (changed) this.save()
    } catch (error) {
      if (existsSync(FILE)) {
        this.writeBlocked = true
        console.error('[registry] registry is unreadable; refusing to overwrite it:', error instanceof Error ? error.message : error)
      }
      // A genuinely absent file starts empty. Any existing unreadable file is preserved byte-for-byte.
    }
  }

  private loadNames(): void {
    try {
      const obj = JSON.parse(readPrivateStateFile(NAMES_FILE, 1024 * 1024)) as Record<string, unknown>
      for (const [id, name] of Object.entries(obj)) {
        if (typeof name === 'string' && name.trim()) NAME_OVERRIDES.set(id, name.trim())
      }
    } catch {
      // no file yet / unreadable — start without display-name overrides
    }
  }

  /** Create/adopt a process agent before any engine session exists. */
  openProcessAgent(input: {
    agentId?: string
    engine: AgentEngine
    tmuxPane?: string
    runtimes?: TerminalRuntimeRef[]
    primaryRuntimeKey?: string
    cwd?: string | null
    processIdentity: ProcessIdentity
    gateway?: 'ori' | null
  }):
    { entry: RegisteredSession; isNew: boolean; evicted: string | null } | null {
    if (this.writeBlocked) return null
    const { engine, processIdentity } = input
    const runtimes = normalizedRuntimes(input.runtimes, input.tmuxPane)
    if (!runtimes.length || !validProcessIdentity(processIdentity)) return null
    const processAgentId = this.processIndex.get(processIdentityKey(engine, processIdentity))
    const processAgent = processAgentId ? this.agents.get(processAgentId) : undefined
    const routeAgent = runtimes
      .map((runtime) => this.byRuntimeEngine(runtime, engine))
      .find((agent) => !agent?.processIdentity || (
        agent.processIdentity.pid === processIdentity.pid
        && agent.processIdentity.startMarker === processIdentity.startMarker
      ))
    const existing = processAgent ?? routeAgent
    if (existing) {
      this.drop(existing)
      existing.runtimes = mergeTerminalRuntimes(existing.runtimes, runtimes)
      existing.tmuxPane = tmuxProjection(existing.runtimes)
      existing.primaryRuntimeKey = selectedRuntimeKey(existing.runtimes, input.primaryRuntimeKey || existing.primaryRuntimeKey)
      existing.cwd = input.cwd ?? existing.cwd
      existing.processIdentity = processIdentity
      existing.active = true
      // Only a successful read speaks: an undefined probe (ps failed, /proc unreadable) keeps whatever
      // the last good one said rather than silently downgrading a gateway agent to a vendor one.
      if (input.gateway !== undefined) existing.gateway = input.gateway
      existing.updatedAt = Date.now()
      this.index(existing)
      this.save()
      return { entry: existing, isNew: false, evicted: null }
    }

    const agentId = input.agentId || randomUUID()
    let evicted: string | null = null
    for (const runtime of runtimes) {
      const otherId = this.runtimeIndex.get(terminalRouteKey(runtime))
      const other = otherId ? this.agents.get(otherId) : undefined
      if (!other) continue
      this.drop(other)
      other.runtimes = other.runtimes.filter((candidate) => terminalRouteKey(candidate) !== terminalRouteKey(runtime))
      other.tmuxPane = tmuxProjection(other.runtimes)
      other.primaryRuntimeKey = selectedRuntimeKey(other.runtimes, other.primaryRuntimeKey)
      other.active = other.runtimes.length > 0
      if (other.runtimes.length) this.index(other)
      evicted ??= other.sessionId || other.agentId
    }
    const now = Date.now()
    const entry: RegisteredSession = {
      schemaVersion: 2,
      active: true,
      agentId,
      sessionId: '',
      boundAt: null,
      engine,
      gateway: input.gateway ?? null,
      transcriptPath: null,
      projectDir: basename(input.cwd ?? '') || agentId,
      cwd: input.cwd ?? null,
      runtimes,
      primaryRuntimeKey: selectedRuntimeKey(runtimes, input.primaryRuntimeKey),
      tmuxPane: tmuxProjection(runtimes),
      source: null,
      title: null,
      model: null,
      cliVersion: null,
      processIdentity,
      registeredAt: now,
      updatedAt: now,
      lastHookAt: now,
      lastTranscriptAt: now,
    }
    this.index(entry)
    this.save()
    return { entry, isNew: true, evicted }
  }

  /** Discovered process agents that have no engine session bound yet. */
  unbound(): RegisteredSession[] {
    return this.list().filter((s) => !s.sessionId)
  }

  /**
   * Upsert a session. Idempotent — a re-register (e.g. from the UserPromptSubmit catch hook) just
   * refreshes `updatedAt`. Deduped by tmux pane: one session per pane, so a `/clear` rotation
   * (SessionEnd of the old id → SessionStart of a new id, same pane) evicts the old one instead of
   * showing two tiles. Returns { entry, isNew, evicted } — isNew=false on a re-register (so callers
   * can skip re-announcing), evicted = the sessionId displaced from this pane (caller removes it).
   */
  register(input: RegisterInput): { entry: RegisteredSession; isNew: boolean; evicted: string | null; rebound: string | null } | null {
    if (this.writeBlocked) return null
    const transcriptPath = input.transcriptPath
    const sessionId =
      input.sessionId || (transcriptPath ? basename(transcriptPath).replace(/\.jsonl$/, '') : '')
    const engine = normalizedAgentEngine(input.engine)
    const pane = input.tmuxPane
    // Hooks carry process metadata, not ownership. The already-discovered pane+engine process chooses the
    // agent; an optional legacy launcherId is intentionally ignored.
    const inputRuntimes = normalizedRuntimes(input.runtimes, pane)
    const processAgent = (validProcessIdentity(input.processIdentity)
      ? this.byProcess(engine, input.processIdentity)
      : undefined)
      ?? inputRuntimes.map((runtime) => this.byRuntimeEngine(runtime, engine)).find(Boolean)
    const agentId = processAgent?.agentId ?? ''
    if (
      !sessionId
      || !agentId
      || !inputRuntimes.length
      || (engine === 'grok' && !GROK_SESSION_RE.test(sessionId))
      // agy's session id IS its conversation id, and it names the directory the transcript lives in.
      || (engine === 'agy' && !GROK_SESSION_RE.test(sessionId))
      // Copilot's session id is a uuid and names the directory its event stream lives in.
      || (engine === 'copilot' && !GROK_SESSION_RE.test(sessionId))
      || (engine !== 'cursor' && engine !== 'opencode' && engine !== 'kilo' && engine !== 'pi' && engine !== 'hermes' && engine !== 'commandcode' && engine !== 'devin' && engine !== 'grok' && engine !== 'agy' && engine !== 'copilot' && !transcriptPath)
      || (transcriptPath && !validTranscriptPath(engine, transcriptPath))
    ) return null
    if (engine === 'codex' && transcriptPath && readCodexRolloutMeta(transcriptPath)?.isSubagent) return null

    const now = Date.now()
    const existing = this.agents.get(agentId)
    // `isNew` still means "this SESSION id was not bound here before" — a rotation counts as new, which is
    // what makes the caller announce the newly bound session. The agent itself may be long-lived.
    const isNew = !existing || existing.sessionId !== sessionId
    // A rotation: the same process agent and pane swapping the engine session underneath it.
    const rebound = existing && existing.sessionId && existing.sessionId !== sessionId ? existing.sessionId : null

    const evicted: string | null = rebound
    // The same engine session cannot belong to two agents — `claude --resume X` in a second pane. The
    // newest bind wins; the old process agent remains visible but becomes unbound.
    const stolenFrom = this.bySession(sessionId)
    if (stolenFrom && stolenFrom.agentId !== agentId) {
      console.log(`[registry] session ${sessionId.slice(0, 8)} moved from agent ${stolenFrom.agentId.slice(0, 8)} to ${agentId.slice(0, 8)}`)
      this.releaseBinding(stolenFrom)
    }

    // Command Code announces SessionStart BEFORE writing its transcript, and validTranscriptPath stats the
    // file — so a real path is rejected at that moment and only arrives with the first Stop hook, AFTER the
    // first turn. Nothing tailed the transcript for that turn, and a transcript-derived turn_started is the
    // ONLY thing that tells Command Code a message was accepted: every new session's first message reported
    // "the agent did not accept this message" and produced no recap. Its layout is deterministic, so derive
    // the path rather than wait to be told. A file that does not exist yet is fine — the watcher starts at
    // offset 0 and chokidar fires when it appears.
    const derived = !transcriptPath && engine === 'commandcode'
      ? commandcodeTranscriptPath(input.cwd ?? existing?.cwd, sessionId)
      : !transcriptPath && engine === 'grok' && (input.cwd ?? existing?.cwd)
        ? join(env.GROK_HOME, 'sessions', encodeURIComponent((input.cwd ?? existing?.cwd)!), sessionId, 'updates.jsonl')
        // agy's layout is deterministic from the conversation id alone, and its `PreInvocation` hook can
        // land before the first line is flushed — derive rather than wait a turn for the path.
        : !transcriptPath && engine === 'agy'
          ? agyTranscriptPath(env.AGY_HOME, sessionId)
          // Copilot announces its session before the first event is flushed; its layout is
          // deterministic, so derive rather than wait a turn for the path.
          : !transcriptPath && engine === 'copilot'
            ? copilotTranscriptPath(env.COPILOT_HOME, sessionId)
            : null
    const effectiveTranscriptPath = transcriptPath ?? existing?.transcriptPath ?? derived ?? null
    const entry: RegisteredSession = {
      schemaVersion: 2,
      active: existing?.active ?? true,
      agentId,
      sessionId,
      boundAt: isNew ? now : existing?.boundAt ?? now,
      engine,
      transcriptPath: effectiveTranscriptPath,
      projectDir: engine === 'grok' || engine === 'agy' || engine === 'copilot'
        ? basename(input.cwd ?? existing?.cwd ?? '') || sessionId
        : effectiveTranscriptPath
        ? basename(dirname(effectiveTranscriptPath))
        : basename(input.cwd ?? existing?.cwd ?? '') || sessionId,
      cwd: input.cwd ?? existing?.cwd ?? null,
      runtimes: mergeTerminalRuntimes(existing?.runtimes ?? [], inputRuntimes),
      primaryRuntimeKey: '',
      tmuxPane: '',
      source: input.source ?? existing?.source ?? null,
      title: titleDisplayName(input.title ?? existing?.title ?? null),
      model: modelString(input.model) ?? existing?.model ?? null,
      cliVersion: input.cliVersion ?? existing?.cliVersion ?? null,
      processIdentity: validProcessIdentity(input.processIdentity) ? input.processIdentity : existing?.processIdentity ?? null,
      registeredAt: existing?.registeredAt ?? now,
      updatedAt: now,
      lastHookAt: now,
      lastTranscriptAt: existing?.lastTranscriptAt ?? now,
    }
    entry.tmuxPane = tmuxProjection(entry.runtimes)
    entry.primaryRuntimeKey = selectedRuntimeKey(entry.runtimes, input.primaryRuntimeKey || existing?.primaryRuntimeKey)
    if (rebound) this.sessionIndex.delete(rebound)
    this.index(entry)
    this.save()
    return { entry, isNew, evicted, rebound }
  }

  remove(sessionId: string): boolean {
    const entry = this.bySession(sessionId)
    if (!entry) return false
    this.drop(entry)
    this.save()
    return true
  }

  /** Release only the mutable session binding; the process-backed agent remains addressable. */
  unbindSession(sessionId: string): boolean {
    const entry = this.bySession(sessionId)
    if (!entry) return false
    this.releaseBinding(entry)
    entry.updatedAt = Date.now()
    this.save()
    return true
  }

  /** Drop an agent outright, bound or not. */
  removeAgent(agentId: string): boolean {
    const entry = this.agents.get(agentId)
    if (!entry) return false
    this.drop(entry)
    this.save()
    return true
  }

  has(sessionId: string): boolean {
    return this.sessionIndex.has(sessionId)
  }

  byAgent(agentId: string): RegisteredSession | undefined {
    return this.agents.get(agentId)
  }

  bySession(sessionId: string): RegisteredSession | undefined {
    const agentId = this.sessionIndex.get(sessionId)
    return agentId ? this.agents.get(agentId) : undefined
  }

  byPaneEngine(tmuxPane: string, engine: AgentEngine): RegisteredSession | undefined {
    return this.byRuntimeEngine({ backend: 'tmux', paneId: tmuxPane }, engine)
  }

  byRuntimeEngine(runtime: TerminalRuntimeRef, engine: AgentEngine): RegisteredSession | undefined {
    const agentId = this.runtimeIndex.get(terminalRouteKey(runtime))
    const entry = agentId ? this.agents.get(agentId) : undefined
    return entry?.engine === engine ? entry : undefined
  }

  byProcess(engine: AgentEngine, identity: ProcessIdentity): RegisteredSession | undefined {
    const agentId = this.processIndex.get(processIdentityKey(engine, identity))
    return agentId ? this.agents.get(agentId) : undefined
  }

  updateRuntimes(agentId: string, runtimes: readonly TerminalRuntimeRef[], primaryRuntimeKey?: string): boolean {
    const entry = this.agents.get(agentId)
    const normalized = normalizedRuntimes(runtimes)
    if (!entry || !normalized.length) return false
    this.drop(entry)
    entry.runtimes = normalized
    entry.tmuxPane = tmuxProjection(normalized)
    entry.primaryRuntimeKey = selectedRuntimeKey(normalized, primaryRuntimeKey)
    entry.active = true
    entry.updatedAt = Date.now()
    this.index(entry)
    this.save()
    return true
  }

  setActive(agentId: string, active: boolean): boolean {
    const entry = this.agents.get(agentId)
    if (!entry || entry.active === active) return !!entry
    entry.active = active
    entry.primaryRuntimeKey = active ? selectedRuntimeKey(entry.runtimes, entry.primaryRuntimeKey) : ''
    entry.updatedAt = Date.now()
    this.save()
    return true
  }

  /** The one lookup for anything that arrives from outside: web and device address an agent by `agentId`
   *  for most things but by a bare `sessionId` for turn control, and both must land on the same record. */
  resolve(id: string): RegisteredSession | undefined {
    return this.agents.get(id) ?? this.bySession(id)
  }

  get(sessionId: string): RegisteredSession | undefined {
    return this.bySession(sessionId)
  }

  updateProcessIdentity(sessionId: string, processIdentity: ProcessIdentity, gateway?: 'ori' | null): boolean {
    const session = this.resolve(sessionId)
    if (!session || !validProcessIdentity(processIdentity)) return false
    this.drop(session)
    session.processIdentity = processIdentity
    // A record written before gateways existed, or by a pass whose probe failed, learns it here — the
    // env cannot change under a running process, so a successful read is always the truth for this pid.
    if (gateway !== undefined) session.gateway = gateway
    session.updatedAt = Date.now()
    this.index(session)
    this.save()
    return true
  }

  touchTranscript(sessionId: string, at = Date.now()): boolean {
    const session = this.bySession(sessionId)
    if (!session) return false
    session.lastTranscriptAt = at
    session.updatedAt = Math.max(session.updatedAt, at)
    this.save()
    return true
  }

  updateTitle(sessionId: string, title: string | null): RegisteredSession | null {
    const session = this.resolve(sessionId)
    if (!session) return null
    const next = titleDisplayName(title)
    const current = titleDisplayName(session.title)
    if (next === current) return session
    session.title = next
    session.updatedAt = Date.now()
    this.save()
    return session
  }

  displayName(s: RegisteredSession): string {
    return projectDisplayName(s)
  }

  /**
   * Carry a user-chosen name from one session id to another.
   *
   * For a session ROTATION: `/clear` in claude (and `/new` in opencode) ends one session id and starts
   * another under the same live process in the same pane. That is the same agent to the person watching it,
   * so the name they gave it has to come along — otherwise clearing the context silently renames their
   * agent back to a default.
   */
  inheritName(fromSessionId: string, toSessionId: string): void {
    const name = NAME_OVERRIDES.get(fromSessionId)
    if (!name || NAME_OVERRIDES.has(toSessionId)) return
    NAME_OVERRIDES.set(toSessionId, name)
    this.saveNames()
  }

  rename(id: string, name: string): RegisteredSession | null {
    const s = this.resolve(id)
    if (!s) return null
    const trimmed = name.trim()
    if (!trimmed) return null
    // Names are stored under the ENGINE session id on purpose: that is what makes `claude --resume <id>`
    // come back wearing the name the user gave it, even though the resume is a brand-new agent.
    NAME_OVERRIDES.set(s.sessionId || s.agentId, trimmed)
    this.saveNames()
    return s
  }

  list(): RegisteredSession[] {
    return Array.from(this.agents.values())
  }

  active(): RegisteredSession[] {
    return this.list().filter((entry) => entry.active)
  }

  async transaction<T>(apply: () => T | Promise<T>): Promise<T> {
    this.transactionDepth++
    try {
      return await apply()
    } finally {
      this.transactionDepth--
      if (this.transactionDepth === 0 && this.savePending) {
        this.savePending = false
        this.save()
      }
    }
  }

  flush(): void {
    this.save()
    this.saveNames()
  }

  private save(): void {
    if (this.transactionDepth > 0) {
      this.savePending = true
      return
    }
    if (this.writeBlocked) {
      console.error('[registry] save skipped because the loaded registry requires operator repair')
      return
    }
    try {
      secureStateDirectory(env.ADAPTER_DATA_DIR)
      withRegistryFileLock(() => {
        const currentRows = new Map(this.list().map((entry) => {
          const row = persistedRow(entry) as unknown as Record<string, unknown>
          return [entry.agentId, row] as const
        }))
        const latestValues: unknown[] = (() => {
          if (!existsSync(FILE)) return []
          const parsed = JSON.parse(readPrivateStateFile(FILE)) as unknown
          if (!Array.isArray(parsed)) throw new Error('registry root changed to a non-array value')
          if (parsed.some(hasUnknownRowSchema)) {
            throw new Error('registry contains an unknown row schema')
          }
          const legacyRows = parsed.filter((row) => !row || typeof row !== 'object' || !Object.hasOwn(row, 'schemaVersion'))
          if (legacyRows.some((row) => !validLegacyRegistryRow(row))) {
            throw new Error('registry contains a malformed legacy row')
          }
          const v2Rows = parsed.filter((row) => !!row && typeof row === 'object'
            && (row as { schemaVersion?: unknown }).schemaVersion === 2)
          if (v2Rows.length && !validatedRows(v2Rows)) throw new Error('registry contains a malformed v2 row')
          return parsed
        })()
        const latest = new Map<string, Record<string, unknown>>()
        for (const value of latestValues) {
          const id = rowId(value)
          if (id) latest.set(id, value as Record<string, unknown>)
        }

        const merged = new Map(latest)
        for (const baselineId of this.persistedBaseline.keys()) {
          if (!currentRows.has(baselineId)) merged.delete(baselineId)
        }
        for (const [agentId, current] of currentRows) {
          const baseline = this.persistedBaseline.get(agentId)
          if (baseline === rowFingerprint(current)) continue
          let candidate = latest.has(agentId)
            ? threeWayRow(baseline, current, latest.get(agentId)!)
            : current
          const process = strictPersistedRow(candidate)?.processIdentity
          const engine = candidate.engine
          const sessionId = typeof candidate.sessionId === 'string' ? candidate.sessionId : ''
          const routes = new Set(normalizedRuntimes(candidate.runtimes, candidate.tmuxPane).map(terminalRouteKey))
          for (const [otherId, other] of [...merged]) {
            if (otherId === agentId) continue
            const otherRow = strictPersistedRow(other)
            if (!otherRow) continue
            const sameProcess = !!process && !!otherRow.processIdentity && otherRow.engine === engine
              && process.pid === otherRow.processIdentity.pid
              && process.startMarker === otherRow.processIdentity.startMarker
            const sameSession = !!sessionId && otherRow.sessionId === sessionId
            const sameRoute = otherRow.runtimes.some((runtime) => routes.has(terminalRouteKey(runtime)))
            if (!sameProcess && !sameSession && !sameRoute) continue
            // A daemon-down hook may bind a session while startup discovery is opening the same process.
            // Preserve that binding, then let the scanner-owned agent id/runtime state win deterministically.
            if (sameProcess && !candidate.sessionId && otherRow.sessionId) {
              candidate = {
                ...candidate,
                sessionId: otherRow.sessionId,
                boundAt: otherRow.boundAt,
                transcriptPath: otherRow.transcriptPath,
                source: otherRow.source,
                lastHookAt: otherRow.lastHookAt,
              }
            }
            merged.delete(otherId)
          }
          merged.set(agentId, candidate)
        }

        const rows = validatedRows([...merged.values()])
        if (!rows) throw new Error('registry transaction would violate global identity invariants')
        const serialized = rows.map(persistedRow)
        atomicWriteJson(FILE, serialized)

        // Refresh external daemon-down writes into the in-memory revision without replacing object
        // identities already held by controllers.
        const previous = new Map(this.agents)
        this.agents.clear()
        this.sessionIndex.clear()
        this.runtimeIndex.clear()
        this.processIndex.clear()
        for (const row of rows) {
          const entry = previous.get(row.agentId) ?? row
          if (entry !== row) Object.assign(entry, row)
          this.index(entry)
        }
        this.persistedBaseline = new Map(serialized.map((row) => [rowId(row), rowFingerprint(row)]))
      })
    } catch (err) {
      console.error('[registry] save failed:', err)
    }
  }

  private saveNames(): void {
    try {
      secureStateDirectory(env.ADAPTER_DATA_DIR)
      let existing: Record<string, string> = {}
      try {
        const obj = JSON.parse(readPrivateStateFile(NAMES_FILE, 1024 * 1024)) as Record<string, unknown>
        existing = Object.fromEntries(Object.entries(obj).filter(([, v]) => typeof v === 'string')) as Record<string, string>
      } catch {
        // no file yet / unreadable — write the in-memory overrides
      }
      atomicWriteJson(NAMES_FILE, { ...existing, ...Object.fromEntries(NAME_OVERRIDES) })
    } catch (err) {
      console.error('[registry] save names failed:', err)
    }
  }
}

export const registry = new Registry()

function defaultProjectDisplayName(s: RegisteredSession): string {
  const folder = s.cwd ? s.cwd.split('/').filter(Boolean).pop() || s.cwd : s.projectDir
  return `${(s.sessionId || s.agentId).slice(0, 4)} · ${folder}`
}

function titleDisplayName(title: string | null | undefined): string | null {
  const cleaned = title
    ?.trim()
    .replace(/^[\s\p{Mark}\p{Punctuation}\p{Symbol}]+/u, '')
    .trim()
    .slice(0, 80)
  return cleaned || null
}

function validProcessIdentity(value: unknown): value is ProcessIdentity {
  const p = value as Partial<ProcessIdentity> | null | undefined
  return !!p && Number.isSafeInteger(p.pid) && (p.pid ?? 0) > 0 && typeof p.executable === 'string' && typeof p.startMarker === 'string'
}
