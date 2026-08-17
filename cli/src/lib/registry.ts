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

import { mkdirSync, readFileSync, writeFileSync, renameSync, realpathSync, statSync } from 'fs'
import { randomUUID } from 'crypto'
import { join, basename, dirname, relative } from 'path'
import { uptime } from 'os'
import { env } from '../config/env.js'
import { readCodexRolloutMeta, resolveCodexRollout } from '../engines/codex/rollout.js'
import type { AgentEngine } from '../engines/types.js'
import { commandcodeTranscriptPath } from '../engines/commandcode/transcript.js'

export interface ProcessIdentity {
  pid: number
  executable: string
  startMarker: string
}

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
const NAME_OVERRIDES = new Map<string, string>()

const PANE_RE = /^%\d+$/
const GROK_SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

/** Seconds-since-epoch of the last machine boot (now − uptime). Persisted next to the registry so a
 *  reload can tell it was written BEFORE a reboot — after which every cached tmux pane id (%N) belongs to
 *  a DEAD tmux server and can FALSELY collide with a reused id in the new server (%0→%0), slipping past
 *  the pane-liveness reaper and leaving ghost agents in the list. On a boot change we drop the whole
 *  cache and start clean (live sessions re-register via the SessionStart hook). NB: a `tmux kill-server`
 *  WITHOUT a reboot isn't caught here (boot time unchanged) — that would need tmux-server-id tracking. */
const BOOT_TOLERANCE_SEC = 120 // clock/NTP drift is seconds; a reboot shifts boot time by the whole uptime
function bootTimeSec(): number {
  return Math.round(Date.now() / 1000 - uptime())
}
function readSavedBoot(): number | null {
  try { const n = Number(readFileSync(BOOT_FILE, 'utf-8').trim()); return Number.isFinite(n) ? n : null } catch { return null }
}
function writeBoot(): void {
  try { mkdirSync(env.ADAPTER_DATA_DIR, { recursive: true }); writeFileSync(BOOT_FILE, String(bootTimeSec())) } catch { /* best effort */ }
}

class Registry {
  /** agentId → record. The store. */
  private agents = new Map<string, RegisteredSession>()
  /** engine sessionId → agentId. Needed because web and device address turn control with a bare
   *  `sessionId` (`cancel`, `question_response`, `compact`, `session_get`) while everything else
   *  addresses the agent. `resolve()` is the one lookup that accepts either. */
  private sessionIndex = new Map<string, string>()

  private index(entry: RegisteredSession): void {
    this.agents.set(entry.agentId, entry)
    if (entry.sessionId) this.sessionIndex.set(entry.sessionId, entry.agentId)
  }

  private drop(entry: RegisteredSession | undefined): void {
    if (!entry) return
    this.agents.delete(entry.agentId)
    if (entry.sessionId && this.sessionIndex.get(entry.sessionId) === entry.agentId) {
      this.sessionIndex.delete(entry.sessionId)
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
    this.loadNames()
    const savedBoot = readSavedBoot()
    const rebooted = savedBoot !== null && Math.abs(bootTimeSec() - savedBoot) > BOOT_TOLERANCE_SEC
    writeBoot() // refresh the reference so a reboot is detected exactly once, even across same-boot restarts
    try {
      const arr = JSON.parse(readFileSync(FILE, 'utf-8')) as RegisteredSession[]
      if (rebooted) {
        console.log(`[registry] machine rebooted since last run — dropping ${Array.isArray(arr) ? arr.length : 0} cached tmux session(s) (stale panes)`)
        this.save() // overwrite the stale on-disk snapshot so a same-boot restart can't reload it
        return
      }
      let changed = false
      for (const raw of Array.isArray(arr) ? arr : []) {
        const engine: AgentEngine = raw?.engine === 'codex' || raw?.engine === 'cursor' || raw?.engine === 'opencode' || raw?.engine === 'pi' || raw?.engine === 'hermes' || raw?.engine === 'commandcode' || raw?.engine === 'devin' || raw?.engine === 'muse' || raw?.engine === 'amp' || raw?.engine === 'kilo' || raw?.engine === 'grok' ? raw.engine : 'claude'
        const pane = typeof raw?.tmuxPane === 'string' && PANE_RE.test(raw.tmuxPane) ? raw.tmuxPane : ''
        let transcriptPath =
          typeof raw?.transcriptPath === 'string' && raw.transcriptPath
            ? raw.transcriptPath
            : null
        let bound = typeof raw?.sessionId === 'string' && raw.sessionId !== ''
        let repairedCodexTranscript = false
        if (engine === 'codex' && transcriptPath) {
          const meta = readCodexRolloutMeta(transcriptPath)
          if (meta?.isSubagent) {
            const repaired = meta.parentThreadId === raw.sessionId
              ? resolveCodexRollout(raw.sessionId, join(env.CODEX_HOME, 'sessions'))
              : null
            if (!repaired || !validTranscriptPath('codex', repaired) || readCodexRolloutMeta(repaired)?.isSubagent) {
              changed = true
              bound = false
              transcriptPath = null
            } else {
              console.log(`[registry] repaired Codex parent ${raw.sessionId.slice(0, 8)} transcript after child hook overwrite`)
              transcriptPath = repaired
              repairedCodexTranscript = true
              changed = true
            }
          }
        }
        // A process agent remains valid without a session. A missing/invalid transcript releases only the
        // binding so the discovery/store repair path can bind it again if appropriate.
        if (!bound) transcriptPath = null
        if (!pane) {
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
        const s: RegisteredSession = {
          agentId,
          boundAt: bound ? (typeof raw.boundAt === 'number' ? raw.boundAt : (raw.registeredAt ?? now)) : null,
          engine,
          transcriptPath,
          title: titleDisplayName(typeof raw.title === 'string' ? raw.title : null),
          sessionId: bound ? raw.sessionId : '',
          projectDir: !repairedCodexTranscript && typeof raw.projectDir === 'string' && raw.projectDir
            ? raw.projectDir
            : transcriptPath
              ? basename(dirname(transcriptPath))
              : (bound ? raw.sessionId : agentId),
          tmuxPane: pane,
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
          || raw.tmuxPane !== pane
          || raw.transcriptPath !== transcriptPath
          || raw.title !== s.title
          || raw.lastHookAt == null
          || raw.lastTranscriptAt == null
          || legacyLauncherId !== ''
        ) changed = true
        // Two records claiming one agent id cannot both be right; keep the
        // one that registered last, exactly as a re-register would.
        const clash = this.agents.get(s.agentId)
        if (clash && clash.registeredAt > s.registeredAt) { changed = true; continue }
        if (clash) { this.drop(clash); changed = true }
        this.index(s)
      }
      if (changed) this.save()
    } catch {
      // no file yet / unreadable — start empty
    }
  }

  private loadNames(): void {
    try {
      const obj = JSON.parse(readFileSync(NAMES_FILE, 'utf-8')) as Record<string, unknown>
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
    tmuxPane: string
    cwd?: string | null
    processIdentity: ProcessIdentity
    gateway?: 'ori' | null
  }):
    { entry: RegisteredSession; isNew: boolean; evicted: string | null } | null {
    const { engine, tmuxPane, processIdentity } = input
    if (!tmuxPane || !PANE_RE.test(tmuxPane) || !validProcessIdentity(processIdentity)) return null
    const existing = [...this.agents.values()].find((agent) =>
      agent.tmuxPane === tmuxPane
      && agent.engine === engine
      && (!agent.processIdentity || (
        agent.processIdentity.pid === processIdentity.pid
        && agent.processIdentity.startMarker === processIdentity.startMarker
      )))
    if (existing) {
      existing.tmuxPane = tmuxPane
      existing.cwd = input.cwd ?? existing.cwd
      existing.processIdentity = processIdentity
      // Only a successful read speaks: an undefined probe (ps failed, /proc unreadable) keeps whatever
      // the last good one said rather than silently downgrading a gateway agent to a vendor one.
      if (input.gateway !== undefined) existing.gateway = input.gateway
      existing.updatedAt = Date.now()
      this.save()
      return { entry: existing, isNew: false, evicted: null }
    }

    const agentId = input.agentId || randomUUID()
    let evicted: string | null = null
    for (const other of this.agents.values()) {
      if (other.tmuxPane === tmuxPane) { this.drop(other); evicted = other.sessionId || other.agentId; break }
    }
    const now = Date.now()
    const entry: RegisteredSession = {
      agentId,
      sessionId: '',
      boundAt: null,
      engine,
      gateway: input.gateway ?? null,
      transcriptPath: null,
      projectDir: basename(input.cwd ?? '') || agentId,
      cwd: input.cwd ?? null,
      tmuxPane,
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
    const transcriptPath = input.transcriptPath
    const sessionId =
      input.sessionId || (transcriptPath ? basename(transcriptPath).replace(/\.jsonl$/, '') : '')
    const engine: AgentEngine =
      input.engine === 'codex' || input.engine === 'cursor' || input.engine === 'opencode' || input.engine === 'pi' || input.engine === 'hermes' || input.engine === 'commandcode' || input.engine === 'devin' || input.engine === 'muse' || input.engine === 'amp' || input.engine === 'kilo' || input.engine === 'grok' ? input.engine : 'claude'
    const pane = input.tmuxPane
    // Hooks carry process metadata, not ownership. The already-discovered pane+engine process chooses the
    // agent; an optional legacy launcherId is intentionally ignored.
    const processAgent = pane ? this.byPaneEngine(pane, engine) : undefined
    const agentId = processAgent?.agentId ?? ''
    if (
      !sessionId
      || !agentId
      || !pane
      || !PANE_RE.test(pane)
      || (engine === 'grok' && !GROK_SESSION_RE.test(sessionId))
      || (engine !== 'cursor' && engine !== 'opencode' && engine !== 'kilo' && engine !== 'pi' && engine !== 'hermes' && engine !== 'commandcode' && engine !== 'devin' && engine !== 'grok' && !transcriptPath)
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
        : null
    const effectiveTranscriptPath = transcriptPath ?? existing?.transcriptPath ?? derived ?? null
    const entry: RegisteredSession = {
      agentId,
      sessionId,
      boundAt: isNew ? now : existing?.boundAt ?? now,
      engine,
      transcriptPath: effectiveTranscriptPath,
      projectDir: engine === 'grok'
        ? basename(input.cwd ?? existing?.cwd ?? '') || sessionId
        : effectiveTranscriptPath
        ? basename(dirname(effectiveTranscriptPath))
        : basename(input.cwd ?? existing?.cwd ?? '') || sessionId,
      cwd: input.cwd ?? existing?.cwd ?? null,
      tmuxPane: pane,
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
    return [...this.agents.values()].find((entry) => entry.tmuxPane === tmuxPane && entry.engine === engine)
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
    session.processIdentity = processIdentity
    // A record written before gateways existed, or by a pass whose probe failed, learns it here — the
    // env cannot change under a running process, so a successful read is always the truth for this pid.
    if (gateway !== undefined) session.gateway = gateway
    session.updatedAt = Date.now()
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

  flush(): void {
    this.save()
    this.saveNames()
  }

  private save(): void {
    try {
      mkdirSync(env.ADAPTER_DATA_DIR, { recursive: true })
      const tmp = `${FILE}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(this.list(), null, 2))
      renameSync(tmp, FILE)
    } catch (err) {
      console.error('[registry] save failed:', err)
    }
  }

  private saveNames(): void {
    try {
      mkdirSync(env.ADAPTER_DATA_DIR, { recursive: true })
      let existing: Record<string, string> = {}
      try {
        const obj = JSON.parse(readFileSync(NAMES_FILE, 'utf-8')) as Record<string, unknown>
        existing = Object.fromEntries(Object.entries(obj).filter(([, v]) => typeof v === 'string')) as Record<string, string>
      } catch {
        // no file yet / unreadable — write the in-memory overrides
      }
      writeFileSync(NAMES_FILE, JSON.stringify({ ...existing, ...Object.fromEntries(NAME_OVERRIDES) }, null, 2))
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
