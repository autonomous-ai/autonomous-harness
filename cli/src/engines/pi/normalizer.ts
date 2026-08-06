/**
 * Pi (pi.dev) JSONL → shared event vocabulary.
 *
 * Pi writes one append-only JSONL per session under
 * `<PI_HOME>/agent/sessions/--<mangled-cwd>--/<ISO-ts>_<uuid>.jsonl`, so it uses the same byte-offset
 * tail as claude/codex — no custom reader. Verified against a real local session (pi 0.82.1):
 *
 *   line 1  {"type":"session","version":3,"id":"<uuid>","cwd":"/abs/path"}
 *   then    {"type":"message","id":"<8hex>","parentId":"<8hex>","message":{…}}
 *           {"type":"model_change"|"thinking_level_change"|"compaction"|"label"|…}
 *
 *   message.role "user"       content: string | [{type:'text',text}]
 *                "assistant"  content: [{type:'thinking',thinking} | {type:'text',text}
 *                                       | {type:'toolCall',id,name,arguments}]
 *                             + stopReason: 'toolUse' (continues) | 'stop' (done) | …
 *                "toolResult" {toolCallId, toolName, content:[{type:'text',text}], isError}
 *
 * Pi records NO turn markers in the file, so the lifecycle is derived exactly like the Claude
 * normalizer: a user message opens a turn; an assistant message whose stopReason is not `toolUse`
 * closes it once every tool call it made has been answered.
 *
 * NOTE: entries form a TREE (`id`/`parentId`) — `/tree` and `/fork` can branch the conversation. v1
 * reads in file order, which matches the linear case (the overwhelming majority); a leaf→root walk is
 * a follow-up.
 */

import type { EngineNormalizer } from '../types.js'
import type { LastTurnText, LiveEvent, SessionEvent } from '../../lib/normalize.js'

type JsonObject = Record<string, unknown>

const MAX_OUTPUT = 2_000
const MAX_THINKING = 500

/** Pi's built-in tools are lowercase; map them onto the vocabulary the web/device cards render. */
const TOOL_NAMES: Record<string, string> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  bash: 'Bash',
  grep: 'Grep',
  find: 'Glob',
  ls: 'LS',
  list: 'LS',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  todowrite: 'TodoWrite',
  todoread: 'TodoRead',
  task: 'Task',
}

export function piToolName(name: string): string {
  const key = name.toLowerCase()
  if (TOOL_NAMES[key]) return TOOL_NAMES[key]
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : 'tool'
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

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n…[truncated]` : value
}

/** `content` is either a plain string or an array of typed parts — flatten the text of both. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      const p = object(part)
      return p && p.type === 'text' ? str(p.text) : ''
    })
    .filter(Boolean)
    .join('')
}

function contentParts(content: unknown): JsonObject[] {
  if (Array.isArray(content)) return content.map(object).filter((p): p is JsonObject => p !== null)
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return []
}

function toolSummary(name: string, output: string, isError: boolean): string {
  const first = output.split('\n').map((line) => line.trim()).find(Boolean) ?? ''
  if (isError) return first ? `${name} failed: ${first}` : `${name} failed`
  return first || `${name} completed`
}

function compactEvent(): LiveEvent {
  return {
    type: 'context_compact',
    payload: { message: 'Context was compacted — the previous conversation has been summarized to free up space.' },
  }
}

/** A turn ends on any stop reason other than `toolUse` (which means the assistant is calling a tool). */
function isTerminalStop(stopReason: string): boolean {
  return !!stopReason && stopReason !== 'toolUse'
}

export class PiNormalizer implements EngineNormalizer {
  private open = false
  private pendingTools = new Set<string>()
  private toolNames = new Map<string, string>()
  private thinkingCounter = 0

  constructor(private readonly mode: 'live' | 'replay') {}

  get turnOpen(): boolean { return this.open }

  closeTurn(): void { this.open = false; this.pendingTools.clear() }

  ingest(line: string): LiveEvent[] {
    const raw = parse(line)
    if (!raw) return []
    const type = str(raw.type)
    if (type === 'compaction') return [compactEvent()]
    if (type !== 'message') return [] // session header, model_change, thinking_level_change, label, …
    const message = object(raw.message)
    if (!message) return []

    const role = str(message.role)
    if (role === 'user') return this.userMessage(message)
    if (role === 'assistant') return this.assistantMessage(message)
    if (role === 'toolResult') return this.toolResult(message)
    if (role === 'bashExecution') return this.bashExecution(raw, message)
    return []
  }

  finishReplay(): LiveEvent[] {
    return this.mode === 'replay' ? [{ type: 'done', payload: { result: 'success' } }] : []
  }

  private userMessage(message: JsonObject): LiveEvent[] {
    const text = contentText(message.content).trim()
    if (!text) return []
    if (this.mode === 'replay') return [{ type: 'user_message', payload: { content: text } }]
    const events: LiveEvent[] = []
    if (this.open) events.push({ type: 'turn_ended', payload: {} })
    this.open = true
    this.pendingTools.clear()
    events.push({ type: 'turn_started', payload: { userMessage: text } })
    return events
  }

  private assistantMessage(message: JsonObject): LiveEvent[] {
    const events: LiveEvent[] = []
    for (const part of contentParts(message.content)) {
      const type = str(part.type)
      if (type === 'thinking') {
        const thinking = str(part.thinking)
        if (!thinking) continue
        events.push({
          type: 'thinking_delta',
          payload: { content: clip(thinking, MAX_THINKING), thinkingId: `thinking-pi-${this.thinkingCounter++}` },
        })
      } else if (type === 'text') {
        const text = str(part.text)
        if (text) events.push({ type: 'text_delta', payload: { content: text } })
      } else if (type === 'toolCall') {
        const id = str(part.id)
        if (!id) continue
        const tool = piToolName(str(part.name))
        this.toolNames.set(id, tool)
        this.pendingTools.add(id)
        events.push({ type: 'tool_start', payload: { id, tool, input: part.arguments ?? {} } })
      }
    }
    if (this.mode !== 'replay' && this.open && isTerminalStop(str(message.stopReason)) && this.pendingTools.size === 0) {
      this.open = false
      events.push({ type: 'turn_ended', payload: {} })
    }
    return events
  }

  private toolResult(message: JsonObject): LiveEvent[] {
    const id = str(message.toolCallId)
    if (!id) return []
    this.pendingTools.delete(id)
    const tool = this.toolNames.get(id) || piToolName(str(message.toolName))
    this.toolNames.delete(id)
    const output = contentText(message.content)
    const isError = message.isError === true
    return [{
      type: 'tool_end',
      payload: { id, tool, output: clip(output, MAX_OUTPUT), isError, summary: toolSummary(tool, output, isError) },
    }]
  }

  /** `!cmd` typed directly in the TUI — render it as a Bash card so the remote sees what ran. */
  private bashExecution(raw: JsonObject, message: JsonObject): LiveEvent[] {
    const command = str(message.command)
    if (!command) return []
    const id = `bash-${str(raw.id) || this.thinkingCounter++}`
    const output = str(message.output)
    const isError = typeof message.exitCode === 'number' && message.exitCode !== 0
    return [
      { type: 'tool_start', payload: { id, tool: 'Bash', input: { command } } },
      {
        type: 'tool_end',
        payload: { id, tool: 'Bash', output: clip(output, MAX_OUTPUT), isError, summary: toolSummary('Bash', output, isError) },
      },
    ]
  }
}

/** Full-session replay (session_get) — same render path as the live stream. */
export function piMessagesToEvents(rawLines: string[]): SessionEvent[] {
  const normalizer = new PiNormalizer('replay')
  const events: SessionEvent[] = []
  for (const line of rawLines) events.push(...normalizer.ingest(line) as SessionEvent[])
  events.push(...normalizer.finishReplay() as SessionEvent[])
  return events
}

/** Last user prompt + the assistant text that followed it — the recap source of truth. */
export function lastPiTurnText(rawLines: string[]): LastTurnText | null {
  let userMessage = ''
  let assistantText = ''
  for (const line of rawLines) {
    const raw = parse(line)
    if (!raw || str(raw.type) !== 'message') continue
    const message = object(raw.message)
    if (!message) continue
    const role = str(message.role)
    if (role === 'user') {
      const text = contentText(message.content).trim()
      if (text) { userMessage = text; assistantText = '' }
    } else if (role === 'assistant') {
      const text = contentParts(message.content)
        .filter((part) => str(part.type) === 'text')
        .map((part) => str(part.text))
        .join('')
        .trim()
      if (text) assistantText += `${assistantText ? '\n\n' : ''}${text}`
    }
  }
  return assistantText ? { userMessage, assistantText } : null
}

/** Session id + cwd from the header line, for registration/repair. */
export function piSessionMeta(rawLines: string[]): { id: string; cwd: string } | null {
  for (const line of rawLines) {
    const raw = parse(line)
    if (!raw || str(raw.type) !== 'session') continue
    const id = str(raw.id)
    if (id) return { id, cwd: str(raw.cwd) }
  }
  return null
}

/**
 * Turn-snapped pagination window for `session_get {limit, before}`; cursor format `pi:<lineIndex>`.
 * The start snaps back to a user message so a window never splits a turn (the replay is stateful:
 * a tool_start's name must still be known when its tool_end is rendered).
 */
export function windowPiLines(
  rawLines: string[],
  opts: { limit: number; before?: string },
): { window: string[]; hasMore: boolean; oldestCursor: string | null; staleCursor?: boolean } {
  let endIndex = rawLines.length
  if (opts.before) {
    const match = /^pi:(\d+)$/.exec(opts.before)
    if (!match) return { window: [], hasMore: false, oldestCursor: null, staleCursor: true }
    endIndex = Number(match[1])
    if (!Number.isSafeInteger(endIndex) || endIndex < 0 || endIndex > rawLines.length) {
      return { window: [], hasMore: false, oldestCursor: null, staleCursor: true }
    }
  }

  let start = Math.max(0, endIndex - opts.limit)
  while (start > 0) {
    const raw = parse(rawLines[start])
    if (raw && str(raw.type) === 'message' && str(object(raw.message)?.role) === 'user') break
    start--
  }
  return {
    window: rawLines.slice(start, endIndex),
    hasMore: start > 0,
    oldestCursor: `pi:${start}`,
  }
}
