/**
 * OpenCode → web ServerEvent conversion.
 *
 * Unlike claude/codex/cursor, OpenCode does NOT write a per-session transcript file — it persists
 * `session`/`message`/`part` rows in a SQLite DB (`~/.local/share/opencode/opencode.db`). The live
 * tailer is `OpencodeReader` (polls the DB); this module holds the pure row→event mapping it shares
 * with the replay / recap paths (`session_get`, device recap).
 *
 * On-disk shapes (validated against opencode 1.18.6):
 *   message.data = { role:'user'|'assistant', model:{providerID,modelID}, parentID?, path:{cwd,root}, tokens{…} }
 *   part.data    = discriminated by `type`:
 *     text{text} · reasoning{text} · step-start{} · step-finish{reason:'stop',…} ·
 *     tool{tool, state:{status:'pending'|'running'|'completed'|'error', input, output, title}}
 */

import type { LastTurnText, SessionEvent, SubagentSummary } from '../../lib/normalize.js'

export const MAX_OUTPUT = 2_000
export const MAX_THINKING = 500

export interface OcPart {
  id: string
  type: string
  data: Record<string, unknown>
}

export interface OcMessage {
  id: string
  role: string
  timeCreated: number
  data: Record<string, unknown>
  parts: OcPart[]
}

export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n…[truncated]` : value
}

/** OpenCode tool ids are lowercase (`bash`, `edit`, …). Map to the Claude vocabulary the UI renders. */
const TOOL_NAMES: Record<string, string> = {
  bash: 'Bash',
  edit: 'Edit',
  multiedit: 'Edit',
  patch: 'Edit',
  write: 'Write',
  read: 'Read',
  grep: 'Grep',
  glob: 'Glob',
  list: 'LS',
  ls: 'LS',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  todowrite: 'TodoWrite',
  todoread: 'TodoRead',
  task: 'Task',
  // OpenCode asks the user through `question`, and its arguments are already the claude shape
  // (`{questions:[{question, header, options:[{label, description}]}]}` — read from its own DB), so the
  // name is the only translation needed for the web's question box and the device's question screen.
  question: 'AskUserQuestion',
}

export function opencodeToolName(name: string): string {
  const key = name.toLowerCase()
  if (TOOL_NAMES[key]) return TOOL_NAMES[key]
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : 'tool'
}

export function toolOutputText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  const o = object(value)
  if (o && typeof o.text === 'string') return o.text
  try { return JSON.stringify(value) ?? '' } catch { return String(value) }
}

export function toolSummary(name: string, output: string, isError: boolean): string {
  const first = output.split('\n').map((line) => line.trim()).find(Boolean) ?? ''
  if (isError) return first ? `${name} failed: ${first}` : `${name} failed`
  return first || `${name} completed`
}

/** The plain text of a user message (its `text` parts joined). */
export function userMessageText(msg: OcMessage): string {
  return msg.parts
    .filter((p) => p.type === 'text')
    .map((p) => str(p.data.text))
    .filter(Boolean)
    .join('\n')
    .trim()
}

/** Assistant text (its `text` parts joined) — for recap. */
export function assistantMessageText(msg: OcMessage): string {
  return msg.parts
    .filter((p) => p.type === 'text')
    .map((p) => str(p.data.text))
    .filter(Boolean)
    .join('')
    .trim()
}

/** A completed assistant message has a `step-finish` part with reason `stop`. */
export function isAssistantDone(msg: OcMessage): boolean {
  return msg.parts.some((p) => p.type === 'step-finish' && str(p.data.reason) === 'stop')
}

/** Aggregates read from a sub-agent's OWN (child) opencode session. */
export interface ChildStats { totalToolUseCount: number; totalTokens?: number }

export function isTaskPart(part: OcPart): boolean {
  return part.type === 'tool' && str(part.data.tool).toLowerCase() === 'task'
}

/** The `<task_result>…</task_result>` body of a Task tool's output, else the raw text. */
export function extractTaskResult(output: string): string {
  const m = /<task_result>\s*([\s\S]*?)\s*<\/task_result>/.exec(output)
  return (m ? m[1] : output).trim()
}

/** OpenCode's `task` tool spawns a sub-agent (a child session). Render it like Claude/Codex Task cards. */
export function taskStartEvent(part: OcPart): SessionEvent {
  const input = object((object(part.data.state) ?? {}).input) ?? {}
  const description = str(input.description) || str(input.prompt).slice(0, 80) || 'Delegated task'
  const subagentType = str(input.subagent_type) || 'agent'
  return { type: 'tool_start', payload: { id: part.id, tool: 'Task', input: { subagent_type: subagentType, description } } }
}

export function taskEndEvent(part: OcPart, childStats?: ChildStats): SessionEvent {
  const state = object(part.data.state) ?? {}
  const input = object(state.input) ?? {}
  const meta = object(state.metadata) ?? {}
  const time = object(state.time) ?? {}
  const durationMs = (Number(time.end) || 0) - (Number(time.start) || 0)
  const output = extractTaskResult(toolOutputText(state.output))
  const isError = str(state.status) === 'error'
  const subagent: SubagentSummary = {
    agentId: str(meta.sessionId) || undefined,
    agentType: str(input.subagent_type) || 'agent',
    totalToolUseCount: childStats?.totalToolUseCount ?? 0,
    totalTokens: childStats?.totalTokens ?? 0,
    totalDurationMs: durationMs > 0 ? durationMs : 0,
  }
  return {
    type: 'tool_end',
    payload: { id: part.id, tool: 'Task', output: clip(output, MAX_OUTPUT), isError, summary: toolSummary('Task', output, isError), subagent },
  }
}

/** Replay events for one assistant `tool` part. In-flight tools emit only `tool_start`. */
export function toolPartEvents(part: OcPart): SessionEvent[] {
  const state = object(part.data.state) ?? {}
  const status = str(state.status)
  const done = status === 'completed' || status === 'error'
  if (isTaskPart(part)) return done ? [taskStartEvent(part), taskEndEvent(part)] : [taskStartEvent(part)]
  const name = opencodeToolName(str(part.data.tool))
  const id = part.id
  const start: SessionEvent = {
    type: 'tool_start',
    payload: { id, tool: name, input: state.input ?? {} },
  }
  if (!done) return [start]
  const output = toolOutputText(state.output)
  const isError = status === 'error'
  return [start, {
    type: 'tool_end',
    payload: { id, tool: name, output: clip(output, MAX_OUTPUT), isError, summary: toolSummary(name, output, isError) },
  }]
}

/** Replay events for one part (assistant blocks only). */
function partReplayEvents(part: OcPart, thinking: { n: number }): SessionEvent[] {
  if (part.type === 'text') {
    const text = str(part.data.text)
    return text ? [{ type: 'text_delta', payload: { content: text } }] : []
  }
  if (part.type === 'reasoning') {
    const text = str(part.data.text)
    return text
      ? [{ type: 'thinking_delta', payload: { content: clip(text, MAX_THINKING), thinkingId: `thinking-opencode-${thinking.n++}` } }]
      : []
  }
  if (part.type === 'tool') return toolPartEvents(part)
  return []
}

/** Full-session replay (session_get) — same render path as the live stream. */
export function opencodeMessagesToEvents(messages: OcMessage[]): SessionEvent[] {
  const events: SessionEvent[] = []
  const thinking = { n: 0 }
  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = userMessageText(msg)
      if (text) events.push({ type: 'user_message', payload: { content: text } })
      continue
    }
    for (const part of msg.parts) events.push(...partReplayEvents(part, thinking))
  }
  events.push({ type: 'done', payload: { result: 'success' } })
  return events
}

/** Last user prompt + the assistant text that followed it — the recap source of truth. */
export function lastOpencodeTurnText(messages: OcMessage[]): LastTurnText | null {
  let userMessage = ''
  let assistantText = ''
  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = userMessageText(msg)
      if (text) { userMessage = text; assistantText = '' }
      continue
    }
    const text = assistantMessageText(msg)
    if (text) assistantText += `${assistantText ? '\n\n' : ''}${text}`
  }
  return assistantText ? { userMessage, assistantText } : null
}

/**
 * Turn-snapped pagination window over the message list, for `session_get {limit, before}`.
 * `before` = `opencode:<index>` (exclusive upper bound = message index the client already holds).
 * The window start snaps back to a user message so a turn is never split.
 */
export function windowOpencodeMessages(
  messages: OcMessage[],
  opts: { limit: number; before?: string },
): { window: OcMessage[]; hasMore: boolean; oldestCursor: string | null; staleCursor?: boolean } {
  let endIndex = messages.length
  if (opts.before) {
    const match = /^opencode:(\d+)$/.exec(opts.before)
    if (!match) return { window: [], hasMore: false, oldestCursor: null, staleCursor: true }
    endIndex = Number(match[1])
    if (!Number.isSafeInteger(endIndex) || endIndex < 0 || endIndex > messages.length) {
      return { window: [], hasMore: false, oldestCursor: null, staleCursor: true }
    }
  }
  let start = Math.max(0, endIndex - opts.limit)
  while (start > 0 && messages[start].role !== 'user') start--
  return {
    window: messages.slice(start, endIndex),
    hasMore: start > 0,
    oldestCursor: `opencode:${start}`,
  }
}
