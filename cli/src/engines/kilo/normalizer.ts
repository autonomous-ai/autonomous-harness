/**
 * Kilo → web ServerEvent conversion.
 *
 * Unlike claude/codex/cursor, Kilo does NOT write a per-session transcript file — it persists
 * `session`/`message`/`part` rows in a SQLite DB (`~/.local/share/kilo/kilo.db`). The live
 * tailer is `KiloReader` (polls the DB); this module holds the pure row→event mapping it shares
 * with the replay / recap paths (`session_get`, device recap).
 *
 * Kilo is a FORK of opencode (`kilo --help` still logs `opencode`, and the two CLIs' command sets match),
 * so this module is a sibling of `engines/opencode/` rather than a shared abstraction: the forks are free
 * to drift and the duplication is where that drift is allowed to land. Where the two already differ is
 * recorded at the point of difference, not assumed away.
 *
 * On-disk shapes, read off a REAL kilo 7.4.20 session in this machine's own `kilo.db`:
 *   session.id   = `ses_024a007fdffe11yG68JPxsHJly`  (the `ses_` prefix is what `RESUME_ARGS` matches)
 *   message.data = { role:'user'|'assistant', parentID?, agent:'code', mode:'code', variant?:'medium',
 *                    model:{providerID:'kilo',modelID}, path:{cwd,root}, tokens{…},
 *                    time:{created,completed}, finish:'stop' }
 *   part.data    = discriminated by `type`:
 *     text{text} · reasoning{text,time,metadata.openrouter.reasoning_details} · step-start{time} ·
 *     step-finish{reason, time, model, tokens, cost} ·
 *     tool{tool, state:{status:'completed', input, output}}
 *
 * ONE user message can produce SEVERAL assistant messages — measured: a two-tool turn wrote three, each
 * with its own step-start/step-finish pair. Only the LAST carries `reason:'stop'`; the intermediate ones
 * carry `reason:'tool-calls'` (mirrored by `message.data.finish`). That is what makes `reason === 'stop'`
 * the correct turn boundary and why counting `step-finish` parts would close the turn two steps early.
 *
 * Both stores carry the legacy `message`/`part` tables AND the newer `session_message` table; measured on
 * kilo 7.4.20, the conversation is in `message`/`part` (4 messages, 10 parts) and `session_message` held
 * only a single `model-switched` row. So `message`/`part` stay the cursor, as they are for opencode.
 */

import type { LastTurnText, SessionEvent, SubagentSummary } from '../../lib/normalize.js'

export const MAX_OUTPUT = 2_000
export const MAX_THINKING = 500

export interface KiloPart {
  id: string
  type: string
  data: Record<string, unknown>
}

export interface KiloMessage {
  id: string
  role: string
  timeCreated: number
  data: Record<string, unknown>
  parts: KiloPart[]
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

/**
 * Kilo tool ids → the Claude vocabulary the UI renders.
 *
 * CONFIRMED on a real kilo 7.4.20 turn: `read` and `todowrite` fired with exactly these ids, and
 * `todowrite`'s arguments are `{todos:[{content, status, priority}]}` — `content` is already the field
 * the device checklist reads, so the tool NAME is the only translation kilo needs and no argument
 * reshape belongs here. Tool output arrives as a plain string (`read` returns an XML-ish
 * `<path>…</path><content>…</content>` blob, `todowrite` a JSON array), which `toolOutputText` passes
 * through unchanged.
 *
 * The REMAINING ids are inherited from opencode and are not individually confirmed on kilo. The two that
 * were checked both matched, which is decent evidence for a fork — but rule zero is that a tool named by
 * analogy fails SILENTLY, so treat a surface that renders nothing as a wrong id here rather than a bug in
 * the surface. The unknown-id fall-through title-cases instead of guessing, keeping a mismatch plain
 * rather than confidently wrong.
 */
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
  // On opencode this is `question`, whose arguments already arrive in the claude shape
  // (`{questions:[{question, header, options:[{label, description}]}]}`) so the NAME is the only
  // translation needed. Whether kilo kept the id, the argument shape, or the tool at all is unmeasured —
  // and this is the entry that matters most, because a question that renders as a tool card is a dialog
  // nobody can answer, i.e. an agent that looks hung.
  question: 'AskUserQuestion',
}

export function kiloToolName(name: string): string {
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

/**
 * The text a finished tool card shows.
 *
 * Kilo puts a FAILURE's explanation in `state.error` and leaves `state.output` empty — measured on a
 * refused permission, where reading `output` alone drew a red card with nothing written on it. Prefer the
 * output, fall back to the error, so a failure always says why.
 */
export function toolResultText(state: Record<string, unknown>): string {
  return toolOutputText(state.output) || str(state.error)
}

export function toolSummary(name: string, output: string, isError: boolean): string {
  const first = output.split('\n').map((line) => line.trim()).find(Boolean) ?? ''
  if (isError) return first ? `${name} failed: ${first}` : `${name} failed`
  return first || `${name} completed`
}

/** The plain text of a user message (its `text` parts joined). */
export function userMessageText(msg: KiloMessage): string {
  return msg.parts
    .filter((p) => p.type === 'text')
    .map((p) => str(p.data.text))
    .filter(Boolean)
    .join('\n')
    .trim()
}

/** Assistant text (its `text` parts joined) — for recap. */
export function assistantMessageText(msg: KiloMessage): string {
  return msg.parts
    .filter((p) => p.type === 'text')
    .map((p) => str(p.data.text))
    .filter(Boolean)
    .join('')
    .trim()
}

/** A completed assistant message has a `step-finish` part with reason `stop`. */
export function isAssistantDone(msg: KiloMessage): boolean {
  return msg.parts.some((p) => p.type === 'step-finish' && str(p.data.reason) === 'stop')
}

/** Aggregates read from a sub-agent's OWN (child) kilo session. */
export interface ChildStats { totalToolUseCount: number; totalTokens?: number }

/**
 * A tool part that failed because the person said no.
 *
 * This is a turn BOUNDARY on kilo, which is why it needs naming. Measured on a live pane: refusing a
 * permission prompt leaves the tool part `status:'error'` with this message, the enclosing step finishes
 * with `reason:'tool-calls'`, the agent goes idle — and NO `step-finish reason:'stop'` is ever written.
 * Read only by the `stop` rule, that turn stays open forever: the device tile spins on `processing`, no
 * recap runs, and the store looks identical to a turn that is still thinking. Confirmed by re-reading the
 * store minutes later with the composer back at idle.
 *
 * Deliberately narrower than "the tool errored". An ordinary tool failure (missing file, bad command) is
 * handed back to the model and it carries on, so closing on any error would end turns mid-flight. Only a
 * refusal stops kilo, which is also what the headless path reports in its own words: `run ended with an
 * auto-rejected permission`.
 */
const PERMISSION_REJECTED_RE = /rejected permission|permission (?:was )?denied|auto-rejected permission/i

export function isPermissionRejection(part: KiloPart): boolean {
  if (part.type !== 'tool') return false
  const state = object(part.data.state) ?? {}
  if (str(state.status) !== 'error') return false
  return PERMISSION_REJECTED_RE.test(str(state.error))
}

export function isTaskPart(part: KiloPart): boolean {
  return part.type === 'tool' && str(part.data.tool).toLowerCase() === 'task'
}

/** The `<task_result>…</task_result>` body of a Task tool's output, else the raw text. */
export function extractTaskResult(output: string): string {
  const m = /<task_result>\s*([\s\S]*?)\s*<\/task_result>/.exec(output)
  return (m ? m[1] : output).trim()
}

/** Kilo's `task` tool spawns a sub-agent (a child session). Render it like Claude/Codex Task cards. */
export function taskStartEvent(part: KiloPart): SessionEvent {
  const input = object((object(part.data.state) ?? {}).input) ?? {}
  const description = str(input.description) || str(input.prompt).slice(0, 80) || 'Delegated task'
  const subagentType = str(input.subagent_type) || 'agent'
  return { type: 'tool_start', payload: { id: part.id, tool: 'Task', input: { subagent_type: subagentType, description } } }
}

export function taskEndEvent(part: KiloPart, childStats?: ChildStats): SessionEvent {
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
export function toolPartEvents(part: KiloPart): SessionEvent[] {
  const state = object(part.data.state) ?? {}
  const status = str(state.status)
  const done = status === 'completed' || status === 'error'
  if (isTaskPart(part)) return done ? [taskStartEvent(part), taskEndEvent(part)] : [taskStartEvent(part)]
  const name = kiloToolName(str(part.data.tool))
  const id = part.id
  const start: SessionEvent = {
    type: 'tool_start',
    payload: { id, tool: name, input: state.input ?? {} },
  }
  if (!done) return [start]
  const output = toolResultText(state)
  const isError = status === 'error'
  return [start, {
    type: 'tool_end',
    payload: { id, tool: name, output: clip(output, MAX_OUTPUT), isError, summary: toolSummary(name, output, isError) },
  }]
}

/** Replay events for one part (assistant blocks only). */
function partReplayEvents(part: KiloPart, thinking: { n: number }): SessionEvent[] {
  if (part.type === 'text') {
    const text = str(part.data.text)
    return text ? [{ type: 'text_delta', payload: { content: text } }] : []
  }
  if (part.type === 'reasoning') {
    const text = str(part.data.text)
    return text
      ? [{ type: 'thinking_delta', payload: { content: clip(text, MAX_THINKING), thinkingId: `thinking-kilo-${thinking.n++}` } }]
      : []
  }
  if (part.type === 'tool') return toolPartEvents(part)
  return []
}

/** Full-session replay (session_get) — same render path as the live stream. */
export function kiloMessagesToEvents(messages: KiloMessage[]): SessionEvent[] {
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
export function lastKiloTurnText(messages: KiloMessage[]): LastTurnText | null {
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
 * `before` = `kilo:<index>` (exclusive upper bound = message index the client already holds).
 * The window start snaps back to a user message so a turn is never split.
 */
export function windowKiloMessages(
  messages: KiloMessage[],
  opts: { limit: number; before?: string },
): { window: KiloMessage[]; hasMore: boolean; oldestCursor: string | null; staleCursor?: boolean } {
  let endIndex = messages.length
  if (opts.before) {
    const match = /^kilo:(\d+)$/.exec(opts.before)
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
    oldestCursor: `kilo:${start}`,
  }
}
