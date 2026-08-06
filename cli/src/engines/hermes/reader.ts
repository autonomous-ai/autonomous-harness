/**
 * Hermes live tailer.
 *
 * Hermes keeps every surface's history in ONE SQLite store (`<HERMES_HOME>/state.db`, WAL), so there is
 * no file to byte-offset-tail. This polls the DB every ~1s through the `sqlite3` CLI (shelled out, like
 * tmux/git — keeps the adapter's single pure-JS bundle; no native SQLite dependency) and feeds the same
 * `emitSessionEvents` funnel the file-based engines use.
 *
 * `messages.id` is an INTEGER primary key, which makes the incremental cursor trivial (`id > lastSeen`).
 * The connection is opened READ-ONLY: Hermes retries writes ~15 times on contention, and a long-held
 * reader would eat into that budget.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import type { LiveEvent } from '../../lib/normalize.js'
import {
  messageToEvents, newHermesTurnState, isTerminalFinish,
  type HermesTurnState, type HmMessage,
} from './normalizer.js'

const execFileAsync = promisify(execFile)

// `YYYYMMDD_HHMMSS_<hex>` — CLI/TUI use 6 hex chars, the gateway 8.
const SESSION_ID_RE = /^[0-9]{8}_[0-9]{6}_[0-9a-fA-F]{4,16}$/
const POLL_MS = 1_000
const MAX_BUFFER = 32 * 1024 * 1024

const COLUMNS =
  'id, role, coalesce(content, \'\') AS content, tool_call_id, tool_calls, tool_name, finish_reason, reasoning'

export class HermesSqliteMissing extends Error {
  constructor() { super('sqlite3 CLI not found on PATH — Hermes sessions cannot be mirrored') }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

/**
 * Read a Hermes session's messages, optionally only those after `afterId`.
 * Throws `HermesSqliteMissing` when the `sqlite3` binary is absent; returns [] on a transient error.
 */
export async function readHermesMessages(
  dbPath: string,
  sessionId: string,
  afterId?: number | null,
): Promise<HmMessage[]> {
  if (!SESSION_ID_RE.test(sessionId)) return []
  const after = Number.isFinite(afterId as number) && (afterId as number) > 0 ? ` AND id > ${Math.trunc(afterId as number)}` : ''
  const sql = `SELECT ${COLUMNS} FROM messages WHERE session_id = '${sessionId}'${after} ORDER BY id;`

  let stdout: string
  try {
    // `.timeout` is the SILENT dot-command form — `PRAGMA busy_timeout=…` prints a row under -json and
    // would corrupt the single-array parse below. `query_only` is silent and guards against writes.
    ;({ stdout } = await execFileAsync(
      'sqlite3',
      ['-json', '-cmd', '.timeout 3000', '-cmd', 'PRAGMA query_only=1', `file:${dbPath}?mode=ro`, sql],
      { maxBuffer: MAX_BUFFER },
    ))
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') throw new HermesSqliteMissing()
    return [] // db locked / mid-write — retry next tick
  }

  const trimmed = stdout.trim()
  if (!trimmed) return []
  let rows: Array<Record<string, unknown>>
  try { rows = JSON.parse(trimmed) } catch { return [] }

  return rows.map((row) => ({
    id: Number(row.id) || 0,
    role: typeof row.role === 'string' ? row.role : '',
    content: typeof row.content === 'string' ? row.content : '',
    toolCallId: str(row.tool_call_id),
    toolCalls: str(row.tool_calls),
    toolName: str(row.tool_name),
    finishReason: str(row.finish_reason),
    reasoning: str(row.reasoning),
  }))
}

/**
 * True when this session id belongs to a DELEGATION CHILD rather than to the CLI the user is looking at.
 *
 * A hermes sub-agent is a full hermes session of its own and runs the same shell hooks, so it announces
 * itself to the adapter from the parent's pane. Measured live: dispatching two sub-agents fired
 * `on_session_start` for `20260805_111618_8e3027` / `…_0777bc` 0.2s after the parent's rows appeared, the
 * pane re-bound to them, and the parent was `forgotten` mid-turn — taking its delegation bookkeeping and
 * its sub-agent list with it. `sessions.source` separates them: 'cli' for the real one, 'subagent'/'tool'
 * for the children (`cwd` also points into `/tmp`, but source is the explicit marker).
 *
 */
export async function isHermesSubagentSession(dbPath: string, sessionId: string): Promise<boolean> {
  const source = await hermesSessionSource(dbPath, sessionId)
  return source !== null && source !== '' && source !== 'cli'
}

/**
 * `sessions.source` for one id, or null when the row is not there YET — which is a real state, not an
 * error: measured, a delegation child's `on_session_start` hook reached the adapter 110ms BEFORE hermes
 * inserted its row, so an immediate lookup said "not a sub-agent" and the child took over the pane.
 * Callers that can afford to wait should treat null as "ask again shortly".
 *
 * Async, like every other query against this store: `.timeout 3000` means a contended read can park for
 * seconds, and hermes writes to this DB constantly — a synchronous spawn here would freeze the whole
 * daemon (every engine's poll, every socket, the device stream) for as long as the lock is held.
 */
export async function hermesSessionSource(dbPath: string, sessionId: string): Promise<string | null> {
  if (!SESSION_ID_RE.test(sessionId)) return ''
  try {
    const { stdout: raw } = await execFileAsync(
      'sqlite3',
      ['-json', '-cmd', '.timeout 3000', '-cmd', 'PRAGMA query_only=1', `file:${dbPath}?mode=ro`,
        `SELECT source FROM sessions WHERE id = '${sessionId}';`],
      { maxBuffer: 1 << 20, timeout: 5_000 },
    )
    const stdout = raw.trim()
    if (!stdout) return null
    const rows = JSON.parse(stdout) as Array<{ source?: unknown }>
    if (rows.length === 0) return null
    return typeof rows[0]?.source === 'string' ? rows[0].source : ''
  } catch {
    return '' // sqlite3 missing / db locked — treat as a normal session, exactly as before
  }
}

export interface HermesReaderDeps {
  dbPath: string
  sessionId: string
  onEvents: (events: LiveEvent[]) => void
  /** Reports the one-time fatal "sqlite3 missing" so the caller can warn + stop the reader. */
  onFatal?: (err: Error) => void
  pollMs?: number
}

export class HermesReader {
  private timer: NodeJS.Timeout | null = null
  private polling = false
  private cursor = 0
  private state: HermesTurnState = newHermesTurnState()

  constructor(private readonly deps: HermesReaderDeps) {}

  get turnOpen(): boolean { return this.state.open }
  closeTurn(): void { this.state.open = false; this.state.pendingTools.clear() }

  /** Hydrate silently (no replay), then start polling. */
  async start(): Promise<void> {
    try {
      const all = await readHermesMessages(this.deps.dbPath, this.deps.sessionId)
      this.hydrate(all)
    } catch (err) {
      if (err instanceof HermesSqliteMissing) { this.deps.onFatal?.(err); return }
    }
    this.timer = setInterval(() => { void this.tick() }, this.deps.pollMs ?? POLL_MS)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  /** Seed state from existing rows without emitting, so only NEW activity streams after attach. */
  private hydrate(messages: HmMessage[]): void {
    for (const msg of messages) {
      this.cursor = Math.max(this.cursor, msg.id)
      messageToEvents(msg, this.state, 'live') // advances turn/tool state; output discarded
    }
    // A trailing user row (or an assistant still calling tools) means we attached mid-turn.
    const tail = messages[messages.length - 1]
    if (!tail) return
    this.state.open = tail.role === 'user'
      || this.state.pendingTools.size > 0
      || (tail.role === 'assistant' && !isTerminalFinish(tail.finishReason))
  }

  private async tick(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      const batch = await readHermesMessages(this.deps.dbPath, this.deps.sessionId, this.cursor)
      if (batch.length === 0) return
      const events: LiveEvent[] = []
      for (const msg of batch) {
        this.cursor = Math.max(this.cursor, msg.id)
        events.push(...messageToEvents(msg, this.state, 'live'))
      }
      if (events.length) this.deps.onEvents(events)
    } catch (err) {
      if (err instanceof HermesSqliteMissing) { this.stop(); this.deps.onFatal?.(err) }
    } finally {
      this.polling = false
    }
  }
}
