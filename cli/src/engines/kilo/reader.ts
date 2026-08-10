/**
 * Kilo live tailer.
 *
 * Kilo has no per-session transcript file — it writes `message`/`part` rows to a SQLite DB. We
 * cannot byte-offset-tail it, so this reader **polls** the DB every ~1s via the `sqlite3` CLI (shelled
 * out, like tmux/git — keeps the adapter's single pure-JS bundle intact; no native SQLite dependency)
 * and diffs against per-part state to emit incremental `LiveEvent`s into the same
 * `emitSessionEvents` funnel the file-based engines use.
 *
 * Measured on kilo 7.4.20: the conversation is written to the legacy `message`/`part` tables, so those
 * are the primary cursor. Unlike opencode's store, kilo's `session_message` table is NOT empty — it held
 * one `model-switched` row — but it carries session METADATA, not turns, so the cursor does not move to
 * it. Its `seq` column is also nullable here where opencode's is `NOT NULL`, which is the reason not to
 * reach for it as an ordering key if that ever looks tempting.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import type { LiveEvent } from '../../lib/normalize.js'
import {
  MAX_OUTPUT, MAX_THINKING, clip, object, str,
  kiloToolName, toolOutputText, toolResultText, toolSummary, userMessageText,
  isTaskPart, isPermissionRejection, taskStartEvent, taskEndEvent,
  type KiloMessage, type KiloPart, type ChildStats,
} from './normalizer.js'

const execFileAsync = promisify(execFile)

const ID_RE = /^[A-Za-z0-9_]+$/
const POLL_MS = 1_000
const MAX_BUFFER = 32 * 1024 * 1024

function parseJson(text: unknown): Record<string, unknown> {
  if (typeof text !== 'string') return object(text) ?? {}
  try { return object(JSON.parse(text)) ?? {} } catch { return {} }
}

interface Cursor { tc: number; id: string }

/**
 * Read messages (+ their parts) for one session from kilo.db via the `sqlite3` CLI.
 * `after` restricts to messages strictly after that boundary (for incremental polling).
 * Opens the DB with `query_only` + a busy timeout so it never contends with kilo's writer.
 * Throws `KiloSqliteMissing` if the `sqlite3` binary is absent.
 */
export async function readKiloMessages(
  dbPath: string,
  sessionId: string,
  after?: Cursor | null,
): Promise<KiloMessage[]> {
  if (!ID_RE.test(sessionId)) return []
  const cond = after && ID_RE.test(after.id) && Number.isFinite(after.tc)
    ? `AND (m.time_created > ${Math.trunc(after.tc)} OR (m.time_created = ${Math.trunc(after.tc)} AND m.id > '${after.id}'))`
    : ''
  const sql =
    `SELECT m.id AS mid, m.time_created AS mtc, m.data AS mdata, p.id AS pid, p.data AS pdata ` +
    `FROM message m LEFT JOIN part p ON p.message_id = m.id ` +
    `WHERE m.session_id = '${sessionId}' ${cond} ` +
    `ORDER BY m.time_created, m.id, p.time_created, p.id;`

  let stdout: string
  try {
    // `.timeout` is the silent dot-command form (the `PRAGMA busy_timeout=…` form prints a JSON row
    // under -json, which would corrupt the single-array parse below). query_only guards against writes.
    ({ stdout } = await execFileAsync(
      'sqlite3',
      ['-json', '-cmd', '.timeout 3000', '-cmd', 'PRAGMA query_only=1', dbPath, sql],
      { maxBuffer: MAX_BUFFER },
    ))
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') throw new KiloSqliteMissing()
    return [] // db locked / transient — retry next tick
  }

  const trimmed = stdout.trim()
  if (!trimmed) return []
  let rows: Array<Record<string, unknown>>
  try { rows = JSON.parse(trimmed) } catch { return [] }

  const byId = new Map<string, KiloMessage>()
  const order: string[] = []
  for (const row of rows) {
    const mid = str(row.mid)
    if (!mid) continue
    let msg = byId.get(mid)
    if (!msg) {
      const mdata = parseJson(row.mdata)
      msg = { id: mid, role: str(mdata.role), timeCreated: Number(row.mtc) || 0, data: mdata, parts: [] }
      byId.set(mid, msg)
      order.push(mid)
    }
    const pid = str(row.pid)
    if (pid) {
      const pdata = parseJson(row.pdata)
      msg.parts.push({ id: pid, type: str(pdata.type), data: pdata })
    }
  }
  return order.map((id) => byId.get(id)!)
}

export class KiloSqliteMissing extends Error {
  constructor() { super('sqlite3 CLI not found on PATH — Kilo sessions cannot be mirrored') }
}

export interface KiloReaderDeps {
  dbPath: string
  sessionId: string
  onEvents: (events: LiveEvent[]) => void
  /** Reports the one-time fatal "sqlite3 missing" so the caller can warn + stop the reader. */
  onFatal?: (err: Error) => void
  pollMs?: number
}

/**
 * Is a message a closed boundary? user messages always are; assistants when `step-finish reason:stop` —
 * OR when a permission was refused, which is the other way a kilo turn ends and the only one that leaves
 * no `stop` behind (see `isPermissionRejection`). Without the second clause the cursor never advances
 * past a refused turn and the reader re-reads it on every poll.
 */
function isDone(msg: KiloMessage): boolean {
  if (msg.role !== 'assistant') return true
  if (msg.parts.some(isPermissionRejection)) return true
  return msg.parts.some((p) => p.type === 'step-finish' && str(p.data.reason) === 'stop')
}

export class KiloReader {
  private timer: NodeJS.Timeout | null = null
  private polling = false
  private open = false
  private thinking = 0
  private cursor: Cursor | null = null
  private readonly emittedText = new Map<string, number>() // partId → chars already emitted
  private readonly thinkingIds = new Map<string, string>() // reasoning partId → stable thinkingId
  private readonly toolStarted = new Set<string>()
  private readonly toolEnded = new Set<string>()
  private readonly seenUser = new Set<string>()

  constructor(private readonly deps: KiloReaderDeps) {}

  get turnOpen(): boolean { return this.open }
  closeTurn(): void { this.open = false }

  /** Hydrate silently (no replay), then start polling. */
  async start(): Promise<void> {
    try {
      const all = await readKiloMessages(this.deps.dbPath, this.deps.sessionId, null)
      this.hydrate(all)
    } catch (err) {
      if (err instanceof KiloSqliteMissing) { this.deps.onFatal?.(err); return }
    }
    this.timer = setInterval(() => { void this.tick() }, this.deps.pollMs ?? POLL_MS)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  /** Seed state from existing rows without emitting, so we only stream NEW activity after attach. */
  private hydrate(messages: KiloMessage[]): void {
    if (messages.length === 0) return
    // Find the last closed boundary; everything up to it is "already seen".
    let boundary = -1
    for (let i = messages.length - 1; i >= 0; i--) { if (isDone(messages[i])) { boundary = i; break } }
    const done = boundary >= 0 ? messages[boundary] : null
    this.cursor = done ? { tc: done.timeCreated, id: done.id } : null
    for (const msg of messages) {
      if (msg.role === 'user') this.seenUser.add(msg.id)
      for (const part of msg.parts) this.seedPart(part)
    }
    // A trailing in-flight assistant means a turn is open (attached mid-turn).
    const tail = messages[messages.length - 1]
    this.open = tail.role === 'assistant' && !isDone(tail)
  }

  private seedPart(part: KiloPart): void {
    if (part.type === 'text' || part.type === 'reasoning') {
      this.emittedText.set(part.id, str(part.data.text).length)
    } else if (part.type === 'tool') {
      this.toolStarted.add(part.id)
      const status = str((object(part.data.state) ?? {}).status)
      if (status === 'completed' || status === 'error') this.toolEnded.add(part.id)
    }
  }

  private async tick(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      const batch = await readKiloMessages(this.deps.dbPath, this.deps.sessionId, this.cursor)
      if (batch.length === 0) return
      const events: LiveEvent[] = []
      for (const msg of batch) events.push(...await this.processMessage(msg))
      // Advance the cursor past the trailing run of closed messages; keep an in-flight tail for re-read.
      for (let i = batch.length - 1; i >= 0; i--) {
        if (isDone(batch[i])) { this.cursor = { tc: batch[i].timeCreated, id: batch[i].id }; break }
      }
      if (events.length) this.deps.onEvents(events)
    } catch (err) {
      if (err instanceof KiloSqliteMissing) { this.stop(); this.deps.onFatal?.(err) }
    } finally {
      this.polling = false
    }
  }

  private async processMessage(msg: KiloMessage): Promise<LiveEvent[]> {
    if (msg.role === 'user') {
      if (this.seenUser.has(msg.id)) return []
      this.seenUser.add(msg.id)
      const events: LiveEvent[] = []
      if (this.open) events.push({ type: 'turn_ended', payload: {} })
      this.open = true
      events.push({ type: 'turn_started', payload: { userMessage: userMessageText(msg) } })
      return events
    }
    const events: LiveEvent[] = []
    for (const part of msg.parts) {
      if (isTaskPart(part)) events.push(...await this.processTaskPart(part))
      else events.push(...this.processPart(part))
    }
    return events
  }

  /** A `task` tool part spawns a sub-agent child session — emit Task start/end, reading the child
   *  session for its tool-call count so the device/web Task card shows "N toolcalls" like the others. */
  private async processTaskPart(part: KiloPart): Promise<LiveEvent[]> {
    const state = object(part.data.state) ?? {}
    const events: LiveEvent[] = []
    const status = str(state.status)
    // kilo writes the part as soon as the tool call starts streaming, BEFORE its arguments are
    // filled in — so announcing on first sight labelled every sub-agent with the `Delegated task`
    // fallback (measured live: two parallel sub-agents, two identical rows). Wait for the input; the row
    // is worth nothing without its description, and it lands within the same poll or the next.
    const described = Object.keys(object(state.input) ?? {}).length > 0
    const settled = status === 'completed' || status === 'error'
    if (!this.toolStarted.has(part.id) && (described || settled)) {
      this.toolStarted.add(part.id)
      events.push(taskStartEvent(part))
    }
    if (settled && !this.toolEnded.has(part.id)) {
      this.toolEnded.add(part.id)
      const childId = str((object(state.metadata) ?? {}).sessionId)
      const childStats = childId ? await this.childStats(childId) : undefined
      events.push(taskEndEvent(part, childStats))
    }
    return events
  }

  private async childStats(childId: string): Promise<ChildStats> {
    try {
      const msgs = await readKiloMessages(this.deps.dbPath, childId)
      let tools = 0
      let tokens = 0
      for (const m of msgs) {
        for (const p of m.parts) if (p.type === 'tool' && !isTaskPart(p)) tools++
        const t = object(m.data.tokens) ?? {}
        tokens += (Number(t.input) || 0) + (Number(t.output) || 0)
      }
      return { totalToolUseCount: tools, totalTokens: tokens || undefined }
    } catch { return { totalToolUseCount: 0 } }
  }

  private processPart(part: KiloPart): LiveEvent[] {
    if (part.type === 'text') {
      const full = str(part.data.text)
      const seen = this.emittedText.get(part.id) ?? 0
      if (full.length <= seen) return []
      this.emittedText.set(part.id, full.length)
      return [{ type: 'text_delta', payload: { content: full.slice(seen) } }]
    }
    if (part.type === 'reasoning') {
      const full = str(part.data.text)
      const seen = this.emittedText.get(part.id) ?? 0
      if (full.length <= seen) return []
      this.emittedText.set(part.id, full.length)
      let thinkingId = this.thinkingIds.get(part.id)
      if (!thinkingId) { thinkingId = `thinking-kilo-${this.thinking++}`; this.thinkingIds.set(part.id, thinkingId) }
      return [{ type: 'thinking_delta', payload: { content: clip(full.slice(seen), MAX_THINKING), thinkingId } }]
    }
    if (part.type === 'tool') {
      const events: LiveEvent[] = []
      const state = object(part.data.state) ?? {}
      const name = kiloToolName(str(part.data.tool))
      if (!this.toolStarted.has(part.id)) {
        this.toolStarted.add(part.id)
        events.push({ type: 'tool_start', payload: { id: part.id, tool: name, input: state.input ?? {} } })
      }
      const status = str(state.status)
      if ((status === 'completed' || status === 'error') && !this.toolEnded.has(part.id)) {
        this.toolEnded.add(part.id)
        const output = toolResultText(state)
        const isError = status === 'error'
        events.push({
          type: 'tool_end',
          payload: { id: part.id, tool: name, output: clip(output, MAX_OUTPUT), isError, summary: toolSummary(name, output, isError) },
        })
        // A refusal ends the turn, and kilo writes no `stop` to say so — close it here or the tile spins.
        if (this.open && isPermissionRejection(part)) {
          this.open = false
          events.push({ type: 'turn_ended', payload: {} })
        }
      }
      return events
    }
    if (part.type === 'step-finish' && str(part.data.reason) === 'stop') {
      if (!this.open) return []
      this.open = false
      return [{ type: 'turn_ended', payload: {} }]
    }
    return []
  }
}
