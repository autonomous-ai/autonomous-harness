/**
 * Devin CLI live tailer.
 *
 * Devin keeps every session's history in ONE SQLite store (`<DEVIN_HOME>/sessions.db`, WAL) and writes no
 * transcript file unless the user passes `--export`, so there is nothing to byte-offset-tail. This polls
 * the DB every ~1s through the `sqlite3` CLI (shelled out, like tmux/git — keeps the adapter's single
 * pure-JS bundle; no native SQLite dependency) and feeds the same `emitSessionEvents` funnel the
 * file-based engines use. Same shape as the opencode/hermes readers.
 *
 * Two Devin specifics:
 *  - **The store is WAL.** The DB must be read IN PLACE (`file:…?mode=ro`), never from a copy of
 *    `sessions.db` alone — a copy misses everything still in `-wal` (an in-flight session looks empty).
 *  - **Rows repeat.** `message_nodes` is a forest and Devin re-persists the whole chain per inference, so
 *    `row_id` alone is not a safe cursor. `row_id` drives the incremental read, `message_id` deduplicates:
 *    29 raw rows collapsed to 6 real messages in the captured session.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import type { LiveEvent, TurnState } from '../../lib/normalize.js'
import { newTurnState } from '../../lib/normalize.js'
import { devinMessageToEvents, type DvMessage } from './normalizer.js'
import { DevinErrorTail } from './errorLog.js'

const execFileAsync = promisify(execFile)

// Devin session ids are lowercase word slugs (`blue-agustinia`, `classy-tourmaline`). Strict, because the
// id is interpolated into SQL.
const SESSION_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_SESSION_ID_LEN = 64
const POLL_MS = 1_000
const MAX_BUFFER = 32 * 1024 * 1024

const COLUMNS = [
  'row_id',
  "json_extract(chat_message, '$.message_id') AS message_id",
  "json_extract(chat_message, '$.role') AS role",
  "coalesce(json_extract(chat_message, '$.content'), '') AS content",
  "json_extract(chat_message, '$.thinking.thinking') AS thinking",
  "json_extract(chat_message, '$.tool_calls') AS tool_calls",
  "json_extract(chat_message, '$.tool_call_id') AS tool_call_id",
  "json_extract(chat_message, '$.metadata.finish_reason') AS finish_reason",
  "json_extract(chat_message, '$.metadata.created_at') AS created_at",
].join(', ')

export class DevinSqliteMissing extends Error {
  constructor() { super('sqlite3 CLI not found on PATH — Devin sessions cannot be mirrored') }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

export function isDevinSessionId(sessionId: string): boolean {
  return sessionId.length <= MAX_SESSION_ID_LEN && SESSION_ID_RE.test(sessionId)
}

/**
 * Read a Devin session's messages, optionally only those after `afterRowId`, deduped by `message_id`
 * (first occurrence wins) and with the system prefix dropped.
 * Throws `DevinSqliteMissing` when the `sqlite3` binary is absent; returns [] on a transient error.
 */
export async function readDevinMessages(
  dbPath: string,
  sessionId: string,
  afterRowId?: number | null,
): Promise<DvMessage[]> {
  if (!isDevinSessionId(sessionId)) return []
  const after = Number.isFinite(afterRowId as number) && (afterRowId as number) > 0
    ? ` AND row_id > ${Math.trunc(afterRowId as number)}`
    : ''
  const sql = `SELECT ${COLUMNS} FROM message_nodes WHERE session_id = '${sessionId}'${after}`
    + " AND json_extract(chat_message, '$.role') <> 'system' ORDER BY row_id;"

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
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') throw new DevinSqliteMissing()
    return [] // db locked / mid-write — retry next tick
  }

  const trimmed = stdout.trim()
  if (!trimmed) return []
  let rows: Array<Record<string, unknown>>
  try { rows = JSON.parse(trimmed) } catch { return [] }

  const seen = new Set<string>()
  const out: DvMessage[] = []
  for (const row of rows) {
    const messageId = str(row.message_id)
    if (!messageId || seen.has(messageId)) continue
    seen.add(messageId)
    out.push({
      rowId: Number(row.row_id) || 0,
      messageId,
      role: typeof row.role === 'string' ? row.role : '',
      content: typeof row.content === 'string' ? row.content : '',
      thinking: str(row.thinking),
      toolCalls: str(row.tool_calls),
      toolCallId: str(row.tool_call_id),
      finishReason: str(row.finish_reason),
      createdAt: str(row.created_at),
    })
  }
  return out
}

export interface DevinReaderDeps {
  dbPath: string
  /** Devin state root — used to find this session's log for turn-failure detection. */
  devinHome: string
  sessionId: string
  onEvents: (events: LiveEvent[]) => void
  /**
   * A turn died on a provider error. Devin writes no assistant row and fires no Stop hook for this, so
   * without it the turn never closes and the web spins forever.
   */
  onTurnAborted?: (message: string) => void
  /** Reports the one-time fatal "sqlite3 missing" so the caller can warn + stop the reader. */
  onFatal?: (err: Error) => void
  pollMs?: number
}

export class DevinReader {
  private timer: NodeJS.Timeout | null = null
  private polling = false
  private cursor = 0
  /** message_ids already emitted — survives across polls, unlike readDevinMessages' per-call dedupe. */
  private readonly seen = new Set<string>()
  private state: TurnState = newTurnState()
  private lastMessageAt: string | null = null
  private readonly errors: DevinErrorTail

  constructor(private readonly deps: DevinReaderDeps) {
    this.errors = new DevinErrorTail(deps.devinHome, deps.sessionId)
  }

  get turnOpen(): boolean { return this.state.turnOpen }
  closeTurn(): void { this.state.turnOpen = false; this.state.pendingTools.clear() }

  /** Hydrate silently (no replay), then start polling. */
  async start(): Promise<void> {
    try {
      const all = await readDevinMessages(this.deps.dbPath, this.deps.sessionId)
      this.hydrate(all)
    } catch (err) {
      if (err instanceof DevinSqliteMissing) { this.deps.onFatal?.(err); return }
    }
    this.errors.seekToEnd() // never replay a failure logged before we attached
    // …except the one case where replaying matters: we attached to a turn that is ALREADY stuck open
    // because it died before the daemon (re)started. Its failure is in the log but behind our offset, so
    // look back explicitly — otherwise a restart leaves the web spinning exactly as it was.
    this.healStuckTurn()
    this.timer = setInterval(() => { void this.tick() }, this.deps.pollMs ?? POLL_MS)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  /** Seed state from existing rows without emitting, so only NEW activity streams after attach. */
  private hydrate(messages: DvMessage[]): void {
    for (const msg of messages) {
      this.cursor = Math.max(this.cursor, msg.rowId)
      this.seen.add(msg.messageId)
      devinMessageToEvents(msg, this.state) // advances turn/tool state; output discarded
    }
    // A trailing user row (or an assistant still calling tools) means we attached mid-turn.
    const tail = messages[messages.length - 1]
    if (!tail) return
    this.lastMessageAt = tail.createdAt ?? null
    this.state.turnOpen = tail.role === 'user'
      || this.state.pendingTools.size > 0
      || (tail.role === 'assistant' && tail.finishReason === 'tool_calls')
  }

  /** Close a turn that was already dead when we attached (failure logged before our offset). */
  private healStuckTurn(): void {
    if (!this.state.turnOpen || !this.lastMessageAt) return
    const failures = this.errors.scanSince(this.lastMessageAt)
    if (!failures.length) return
    this.closeTurn()
    this.deps.onTurnAborted?.(failures[failures.length - 1])
  }

  /**
   * Drain the log tail every tick — even when idle, so a stale failure can never fire into the NEXT turn —
   * but only act while a turn is actually open.
   */
  private checkTurnFailure(): void {
    const failures = this.errors.poll()
    if (!failures.length || !this.state.turnOpen) return
    this.closeTurn()
    this.deps.onTurnAborted?.(failures[failures.length - 1])
  }

  private async tick(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      const batch = await readDevinMessages(this.deps.dbPath, this.deps.sessionId, this.cursor)
      const events: LiveEvent[] = []
      for (const msg of batch) {
        this.cursor = Math.max(this.cursor, msg.rowId)
        if (this.seen.has(msg.messageId)) continue
        this.seen.add(msg.messageId)
        events.push(...devinMessageToEvents(msg, this.state))
      }
      if (events.length) this.deps.onEvents(events)
      // NOT gated on `batch.length`: a failed turn is precisely the case where no new row ever arrives.
      this.checkTurnFailure()
    } catch (err) {
      if (err instanceof DevinSqliteMissing) { this.stop(); this.deps.onFatal?.(err) }
    } finally {
      this.polling = false
    }
  }
}
