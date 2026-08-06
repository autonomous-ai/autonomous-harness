/**
 * Command Code (commandcode.ai) JSONL → shared event vocabulary.
 *
 * Command Code writes an append-only JSONL per session at
 * `<COMMANDCODE_HOME>/projects/<cwd-slug>/<session-uuid>.jsonl`, so it reuses the byte-offset tail
 * (`Watcher`) like claude/codex/pi — no custom reader.
 *
 * The happy accident (verified against real captured sessions, commandcode 1.4.4): its **content blocks
 * are byte-for-byte Claude's**, wrapped in Pi's envelope:
 *
 *   line 1  {"type":"session","version":3,"id":"<uuid>","timestamp":"…","cwd":"/abs/path"}
 *   then    {"type":"message","id":"<8hex>","parentId":null|"<8hex>","timestamp":"…",
 *            "message":{"role":…,"content":[…],"meta":{"source":"user"|"model"|"tool",…}}}
 *
 *   content parts: {"type":"thinking","thinking":…,"signature":…}
 *                  {"type":"text","text":…}
 *                  {"type":"tool_use","id":"call_…","name":"shell_command","input":{…}}
 *                  {"type":"tool_result","tool_use_id":"call_…","content":[{"type":"text","text":…}]}
 *
 * So instead of re-implementing a normalizer we **reshape each line into the Claude raw shape** and hand
 * it to the existing, battle-tested `lineToEvents`/`messagesToEvents` (`src/lib/normalize.ts`) — which
 * already do thinking ids, tool-name tracking, `tool_result`→`tool_end` joining, truncation and tool
 * summaries.
 *
 * Three Command Code specifics the reshape encodes:
 *  - **`message.meta.source`** (`user` | `model` | `tool`) is an explicit role discriminator — better than
 *    Claude's sniffing. A `tool` row is a `role:"user"` message carrying only `tool_result` blocks.
 *  - **There is no `stop_reason`.** A turn continues while the assistant is calling tools, so we synthesize
 *    `'tool_use'` when the message contains a `tool_use` block and `'end_turn'` otherwise — exactly the
 *    values Claude's `TERMINAL_STOP_REASONS` already discriminates on.
 *  - **A failed turn appends a source-LESS user row** — see `commandCodeRunError`.
 */

import type { EngineNormalizer } from '../types.js'
import {
  lastTurnTextFromRawLines,
  lineToEvents,
  messagesToEvents,
  newTurnState,
  type LastTurnText,
  type LiveEvent,
  type SessionEvent,
  type TurnState,
} from '../../lib/normalize.js'

type JsonObject = Record<string, unknown>

/** Command Code tool ids → the vocabulary the web/device cards render. */
const TOOL_NAMES: Record<string, string> = {
  shell_command: 'Bash',
  bash_output: 'Bash',
  read_file: 'Read',
  read_multiple_files: 'Read',
  read_directory: 'LS',
  write_file: 'Write',
  edit_file: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  todo_write: 'TodoWrite',
  agent: 'Task',
  agent_output: 'Task',
  activate_skill: 'Task',
}

export function commandCodeToolName(name: string): string {
  const key = (name || '').toLowerCase()
  if (TOOL_NAMES[key]) return TOOL_NAMES[key]
  if (!name) return 'tool'
  // snake_case → TitleCase so an unmapped/new tool still reads well on a card.
  return name.split('_').filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('')
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function parse(line: string): JsonObject | null {
  try { return object(JSON.parse(line)) } catch { return null }
}

/** Rewrite `tool_use.name` in place (on a copy) so downstream tool cards use the shared vocabulary. */
function mapParts(content: unknown): unknown[] {
  if (!Array.isArray(content)) return []
  return content.map((part) => {
    const p = object(part)
    if (!p || p.type !== 'tool_use') return part
    return { ...p, name: commandCodeToolName(str(p.name)) }
  })
}

/**
 * The failure text of a Command Code **run-error** record, or null for anything else.
 *
 * When a turn dies (`stopReason === 'run_error'`) the TUI appends the error as a `role:"user"` message
 * carrying only `meta.messageId` — **no `meta.source`** — so that typing "continue" replays it to the
 * model. It is feedback, NOT a prompt, and it is the ONLY record Command Code writes without a source
 * (verified in commandcode 1.5.0: `buildRunErrorFeedbackContent` feeds the bundle's single
 * `appendMessage({message:{role:"user",…,meta:{messageId}}})` call site; and across every transcript
 * captured on this computer — 96 records — the only two source-less rows were `Error: 500 [object Object]`
 * and `Insufficient credits`).
 *
 * Reshaping it as a prompt is what left the web spinning forever: it closed the real turn and opened a
 * phantom one that nothing could ever close. Nothing else can close it either — Command Code's hook set
 * is exactly `PreToolUse|PostToolUse|Stop|SessionStart`, with no `StopFailure`, and it fires **no** `Stop`
 * for a failed turn (audit log: Stop for all three successful turns, none for the errored one). So this
 * record is the only end-of-turn signal that exists, and the reader must act on it.
 */
export function commandCodeRunError(line: string): string | null {
  const raw = parse(line)
  if (!raw || str(raw.type) !== 'message') return null
  const message = object(raw.message)
  return message ? runErrorText(message) : null
}

function runErrorText(message: JsonObject): string | null {
  if (str(message.role) !== 'user') return null
  if (str(object(message.meta)?.source)) return null // a real prompt or a tool_result carrier
  const content = Array.isArray(message.content) ? message.content : []
  // Defensive: a source-less row carrying tool output is not a notice — leave it on the normal path.
  if (content.some((part) => object(part)?.type === 'tool_result')) return null
  const text = content
    .map((part) => (object(part)?.type === 'text' ? str(object(part)?.text) : ''))
    .filter(Boolean)
    .join('\n')
    .trim()
  return text || null
}

/**
 * Device-sized version of a run error: its first line. Command Code appends a support URL and a trace id
 * ("Type \"continue\" to try again. … Trace ID: 932a…") that are noise on a 1.9" screen, while the first
 * line is always the error itself (`Error: 500 [object Object]`, `Insufficient credits`).
 */
export function commandCodeRunErrorSummary(text: string): string {
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? text.trim()
}

/**
 * One Command Code line → one Claude-shaped raw line (or null for the header / unknown entries).
 * Exported for tests; the normalizer and the replay/recap helpers all funnel through it.
 */
export function reshapeLine(line: string): string | null {
  const raw = parse(line)
  if (!raw || str(raw.type) !== 'message') return null // session header, and any future entry type
  const message = object(raw.message)
  if (!message) return null
  // Keep the run-error record out of the render path entirely: as a prompt it would open a phantom turn
  // live, show up as a user bubble on replay, and become the recap's "ask". The turn close it implies is
  // derived in `ingest` (live) — replay/recap only need it gone.
  if (runErrorText(message) !== null) return null

  const source = str(object(message.meta)?.source)
  const role = str(message.role)
  const content = mapParts(message.content)
  const common = { uuid: raw.id, parentUuid: raw.parentId, timestamp: raw.timestamp }

  // `tool` rows are role:"user" messages carrying tool_result blocks — Claude's path turns those into
  // tool_end and never mistakes them for a prompt.
  if (source === 'user' || source === 'tool' || role === 'user') {
    return JSON.stringify({ ...common, type: 'user', message: { role: 'user', content } })
  }
  if (source === 'model' || role === 'assistant') {
    const hasToolUse = content.some((part) => object(part)?.type === 'tool_use')
    return JSON.stringify({
      ...common,
      type: 'assistant',
      message: { role: 'assistant', content, stop_reason: hasToolUse ? 'tool_use' : 'end_turn' },
    })
  }
  return null
}

function reshapeAll(rawLines: string[]): string[] {
  const out: string[] = []
  for (const line of rawLines) {
    const reshaped = reshapeLine(line)
    if (reshaped) out.push(reshaped)
  }
  return out
}

export class CommandCodeNormalizer implements EngineNormalizer {
  private readonly state: TurnState = newTurnState()

  constructor(private readonly mode: 'live' | 'replay' = 'live') {}

  get turnOpen(): boolean { return this.state.turnOpen }

  closeTurn(): void { this.state.turnOpen = false; this.state.pendingTools.clear() }

  /**
   * Open a turn from OUTSIDE the transcript, driven by the PreToolUse hook.
   *
   * Every other engine opens its turn from a live signal — a prompt-submit hook, or a user line landing
   * in the transcript while the turn runs. Command Code has neither: it has no UserPromptSubmit, and it
   * flushes the whole turn to the JSONL at the end (the user and assistant lines share a timestamp). So
   * by the time anything is readable the turn is already over, and the device went idle → recap with no
   * "working" in between.
   *
   * Idempotent because PreToolUse fires per tool call: only the first one in a turn opens it. The user
   * text is not available yet — the transcript has not been written — so the ask arrives later with the
   * recap, which is where the device reads it from anyway.
   */
  openTurn(): LiveEvent[] {
    if (this.state.turnOpen) return []
    this.state.turnOpen = true
    this.state.pendingTools.clear()
    return [{ type: 'turn_started', payload: { userMessage: '' } }]
  }

  ingest(line: string): LiveEvent[] {
    // A run error ends the turn — it is the only signal there is (see `commandCodeRunError`). Emitting
    // turn_ended here also heals on attach: a daemon restarting onto an already-failed session folds this
    // record during hydration and comes up with the turn closed instead of stuck.
    if (commandCodeRunError(line) !== null) {
      if (!this.state.turnOpen) return []
      this.closeTurn()
      return [{ type: 'turn_ended', payload: {} }]
    }
    const reshaped = reshapeLine(line)
    return reshaped ? lineToEvents(reshaped, this.state) : []
  }

  finishReplay(): LiveEvent[] {
    return this.mode === 'replay' ? [{ type: 'done', payload: { result: 'success' } }] : []
  }
}

/** Full-session replay (session_get) — same render path as the live stream. */
export function commandcodeMessagesToEvents(rawLines: string[]): SessionEvent[] {
  return messagesToEvents(reshapeAll(rawLines))
}

/** Last user prompt + the assistant text that followed it — the recap source of truth. */
export function lastCommandCodeTurnText(rawLines: string[]): LastTurnText | null {
  return lastTurnTextFromRawLines(reshapeAll(rawLines))
}

/** Session id + cwd from the header line. */
export function commandCodeSessionMeta(rawLines: string[]): { id: string; cwd: string } | null {
  for (const line of rawLines) {
    const raw = parse(line)
    if (!raw || str(raw.type) !== 'session') continue
    const id = str(raw.id)
    if (id) return { id, cwd: str(raw.cwd) }
  }
  return null
}

/** True for a line that starts a turn (a real user prompt, not a tool_result carrier). */
function isUserPromptLine(line: string): boolean {
  const raw = parse(line)
  if (!raw || str(raw.type) !== 'message') return false
  const message = object(raw.message)
  if (!message) return false
  return str(object(message.meta)?.source) === 'user'
}

/**
 * Turn-snapped pagination window for `session_get {limit, before}`; cursor `commandcode:<lineIndex>`.
 * The window start snaps back to a user prompt so a turn is never split (replay is stateful: a
 * tool_use's name must still be known when its tool_result renders).
 */
export function windowCommandCodeLines(
  rawLines: string[],
  opts: { limit: number; before?: string },
): { window: string[]; hasMore: boolean; oldestCursor: string | null; staleCursor?: boolean } {
  let endIndex = rawLines.length
  if (opts.before) {
    const match = /^commandcode:(\d+)$/.exec(opts.before)
    if (!match) return { window: [], hasMore: false, oldestCursor: null, staleCursor: true }
    endIndex = Number(match[1])
    if (!Number.isSafeInteger(endIndex) || endIndex < 0 || endIndex > rawLines.length) {
      return { window: [], hasMore: false, oldestCursor: null, staleCursor: true }
    }
  }
  let start = Math.max(0, endIndex - opts.limit)
  while (start > 0 && !isUserPromptLine(rawLines[start])) start--
  return {
    window: rawLines.slice(start, endIndex),
    hasMore: start > 0,
    oldestCursor: `commandcode:${start}`,
  }
}
