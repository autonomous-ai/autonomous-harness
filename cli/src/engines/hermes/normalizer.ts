/**
 * Hermes Agent (Nous Research) → shared event vocabulary.
 *
 * Hermes has no per-session transcript file — every surface (CLI, TUI, gateway, desktop) writes to one
 * SQLite store at `<HERMES_HOME>/state.db`. `HermesReader` polls it; this module holds the pure
 * row→event mapping it shares with the replay (`session_get`) and recap paths.
 *
 * Verified against a real local session (hermes 0.19.0, schema v23, provider vibe / minimax-m3):
 *
 *   sessions(id, source, cwd, git_branch, model, …)   id = `YYYYMMDD_HHMMSS_<6hex>`, source='cli' for tmux
 *   messages(id INTEGER PK, session_id, role, content, tool_call_id, tool_calls, tool_name,
 *            finish_reason, reasoning, timestamp, active, …)
 *
 *   role 'user'      → content = the prompt, finish_reason NULL
 *   role 'assistant' → content and/or tool_calls JSON:
 *        [{"id":"call_…","call_id":"call_…","type":"function",
 *          "function":{"name":"terminal","arguments":"{\"command\":\"ls\"}"}}]
 *        finish_reason 'tool_calls' → the turn CONTINUES into the tool; 'stop' → the turn is done
 *   role 'tool'      → tool_name + tool_call_id, content = a JSON result
 *        (for `terminal`: {"output":"…","exit_code":0,"error":null})
 *
 * Turn lifecycle is derived (Hermes records no turn markers), exactly like the claude/pi normalizers:
 * a user row opens a turn; an assistant row with a terminal finish_reason closes it once every tool
 * call it made has been answered.
 */

import type { LastTurnText, LiveEvent, SessionEvent } from '../../lib/normalize.js'

export const MAX_OUTPUT = 2_000
export const MAX_THINKING = 500

/** One `messages` row, as the reader selects it. */
export interface HmMessage {
  id: number
  role: string
  content: string
  toolCallId: string | null
  toolCalls: string | null
  toolName: string | null
  finishReason: string | null
  reasoning: string | null
}

/** Hermes tool names → the vocabulary the web/device cards already render. */
const TOOL_NAMES: Record<string, string> = {
  terminal: 'Bash',
  execute_code: 'Bash',
  read_file: 'Read',
  write_file: 'Write',
  patch: 'Edit',
  edit_file: 'Edit',
  search_files: 'Grep',
  find_files: 'Glob',
  list_files: 'LS',
  web_search: 'WebSearch',
  web_extract: 'WebFetch',
  web_fetch: 'WebFetch',
  delegate_task: 'Task',
  // Hermes' planning tool is called `todo` (not `todo_write` like the others), and its items are already
  // `{id, content, status}` — the exact shape the device's todo list reads. Without this entry the
  // fallback below title-cased it to `Todo`, so `commander.ts` never recognised it: the checklist simply
  // never appeared on either UI, for an engine that supports it perfectly well.
  todo: 'TodoWrite',
  // Hermes asks the user through `clarify`. Naming it AskUserQuestion is what puts it on both UIs: the web
  // renders a question box for that tool name (eventHandlers.ts), and the device deliberately DROPS the
  // tool card for it (commander.ts) because the question belongs on its own screen, not in the tool feed.
  clarify: 'AskUserQuestion',
}

export function hermesToolName(name: string): string {
  const key = (name || '').toLowerCase()
  if (TOOL_NAMES[key]) return TOOL_NAMES[key]
  if (key.startsWith('browser')) return 'WebFetch'
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : 'tool'
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n…[truncated]` : value
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return null }
}

/** A turn continues while the model is calling tools; anything else terminates it. */
export function isTerminalFinish(finishReason: string | null): boolean {
  return !!finishReason && finishReason !== 'tool_calls'
}

/**
 * Hermes' `clarify` args → the AskUserQuestion shape both UIs already read.
 *
 * Hermes asks ONE question with flat string choices (`{question, choices:["S","M"]}` — read from a real
 * call in its state.db). Claude's shape is a LIST of questions whose options are objects. Renaming the
 * tool without reshaping would put the card on the web with nothing inside it, so the translation lives
 * here, next to the name mapping it belongs to.
 */
export function clarifyAsQuestions(input: unknown): unknown {
  const raw = object(input)
  if (!raw) return input
  if (Array.isArray(raw.questions)) return raw            // already shaped (a future hermes, or a replay)
  const question = str(raw.question)
  if (!question) return input
  const choices = Array.isArray(raw.choices) ? raw.choices : []
  return {
    questions: [{
      question,
      header: '',
      options: choices.map((choice) => ({ label: str(choice) || String(choice ?? ''), description: '' }))
        .filter((o) => o.label),
      // `clarify` has no multi-select: its schema is one question, one answer.
      multiSelect: false,
    }],
  }
}

export interface HmToolCall { id: string; tool: string; input: unknown }

/** Parse an assistant row's `tool_calls` JSON blob into normalized calls. */
export function parseToolCalls(toolCalls: string | null): HmToolCall[] {
  if (!toolCalls) return []
  const parsed = parseJson(toolCalls)
  if (!Array.isArray(parsed)) return []
  const out: HmToolCall[] = []
  for (const entry of parsed) {
    const call = object(entry)
    if (!call) continue
    const fn = object(call.function) ?? {}
    const id = str(call.id) || str(call.call_id)
    if (!id) continue
    const args = str(fn.arguments)
    const tool = hermesToolName(str(fn.name) || str(call.name))
    const input = (args ? parseJson(args) : null) ?? (args || {})
    out.push({ id, tool, input: tool === 'AskUserQuestion' ? clarifyAsQuestions(input) : input })
  }
  return out
}

/** A tool row's payload → display text + error flag. Hermes wraps most results in a JSON envelope. */
export function toolResultText(content: string): { output: string; isError: boolean } {
  const parsed = object(parseJson(content))
  if (!parsed) return { output: content, isError: false }
  const err = parsed.error
  const exit = parsed.exit_code
  const isError = (err !== null && err !== undefined && err !== '') || (typeof exit === 'number' && exit !== 0)
  const output = typeof parsed.output === 'string'
    ? parsed.output
    : typeof parsed.result === 'string'
      ? parsed.result
      : content
  return { output: isError && err ? `${output}${output ? '\n' : ''}${str(err)}`.trim() : output, isError }
}

export function toolSummary(name: string, output: string, isError: boolean): string {
  const first = output.split('\n').map((line) => line.trim()).find(Boolean) ?? ''
  if (isError) return first ? `${name} failed: ${first}` : `${name} failed`
  return first || `${name} completed`
}

/** Assistant thinking text (the `reasoning` column). */
export function reasoningText(msg: HmMessage): string {
  return (msg.reasoning ?? '').trim()
}

/**
 * Events for ONE row, shared by the live reader and the replay path.
 * `mode: 'live'` derives the turn lifecycle; `'replay'` emits `user_message` instead.
 * `state` tracks tool names + which calls are still unanswered so a turn closes at the right row.
 */
export interface HermesTurnState {
  open: boolean
  pendingTools: Set<string>
  toolNames: Map<string, string>
  thinkingCounter: number
  /** `delegate_task` call id → the per-task row ids it fanned out into (see delegateFanout). */
  fanout: Map<string, string[]>
  /** `delegation_id` (only known once the dispatch result lands) → those same row ids. */
  delegations: Map<string, string[]>
}

export function newHermesTurnState(): HermesTurnState {
  return {
    open: false,
    pendingTools: new Set(),
    toolNames: new Map(),
    thinkingCounter: 0,
    fanout: new Map(),
    delegations: new Map(),
  }
}

/**
 * Hermes delegation, measured on a live session (`~/.hermes/state.db`, messages 284–306):
 *
 *   assistant tool_calls  delegate_task {"tasks":[{"goal":"Đếm .md","role":"leaf"},{"goal":"Đếm .ts",…}]}
 *   tool result           {"status":"dispatched","mode":"background","count":2,"delegation_id":"deleg_3c9f8264",…}
 *   user (later)          [ASYNC DELEGATION BATCH COMPLETE — deleg_3c9f8264] … --- ✓ TASK 1/2: … (status=completed…
 *   assistant             the consolidated answer
 *
 * So ONE tool call carries N sub-agents, its result is a dispatch ACK (same trap as claude's "Async agent
 * launched successfully"), and the finish arrives as a `user` row. Rendered verbatim that produced: one
 * row labelled "sub-agent" for two agents, never ticked off, and a fake turn whose "user prompt" was the
 * batch-complete boilerplate (measured: `[recap] … ask="[ASYNC DELEGATION BATCH COMPLETE — deleg_…"`).
 */
const DELEGATION_COMPLETE = /^\[ASYNC DELEGATION BATCH COMPLETE\s*[—-]\s*([A-Za-z0-9_-]+)\]/
/** Per-task outcome inside that message: `--- ✓ TASK 1/2: <goal> (status=completed, api_calls=3, 18.27s) ---` */
const DELEGATION_TASK = /---\s*.{0,3}\s*TASK\s+(\d+)\/(\d+):[\s\S]*?\(status=([a-z_]+)[^)]*?(?:,\s*([\d.]+)s)?\)\s*---/g

/** True for the machine-written row that reports an async batch finishing — never a user prompt. */
export function delegationCompleteId(content: string): string | null {
  return DELEGATION_COMPLETE.exec(content.trim())?.[1] ?? null
}

/**
 * One `delegate_task` call → one row PER task, so two parallel sub-agents render as two lines instead of
 * one. Ids are the call id with the task index appended; the dispatch ack keeps the bare call id, which is
 * deliberately NOT one of these — that is what stops the ack ticking the rows off.
 */
function delegateFanout(call: HmToolCall): { ids: string[]; events: LiveEvent[] } | null {
  const tasks = (object(call.input) ?? {}).tasks
  if (!Array.isArray(tasks) || tasks.length === 0) return null
  const ids: string[] = []
  const events: LiveEvent[] = []
  tasks.forEach((entry, i) => {
    const task = object(entry) ?? {}
    const goal = str(task.goal) || str(task.prompt) || `sub-agent ${i + 1}`
    const id = `${call.id}#${i}`
    ids.push(id)
    events.push({ type: 'tool_start', payload: { id, tool: 'Task', input: { description: goal, role: str(task.role) } } })
  })
  return { ids, events }
}

/** Per-task finishes carried by a batch-complete row, in task order. */
function delegationFinishEvents(content: string, ids: string[]): LiveEvent[] {
  const events: LiveEvent[] = []
  const seen = new Set<number>()
  for (const m of content.matchAll(DELEGATION_TASK)) {
    const index = Number(m[1]) - 1
    if (!Number.isInteger(index) || index < 0 || index >= ids.length || seen.has(index)) continue
    seen.add(index)
    events.push({ type: 'subagent_finished', payload: { id: ids[index], status: m[3] } })
  }
  // A batch reports as a whole: anything the text didn't itemise still finished with it, and a row left
  // running would hold the turn open until the 10-minute backstop.
  ids.forEach((id, i) => {
    if (!seen.has(i)) events.push({ type: 'subagent_finished', payload: { id, status: 'completed' } })
  })
  return events
}

export function messageToEvents(msg: HmMessage, state: HermesTurnState, mode: 'live' | 'replay'): LiveEvent[] {
  const events: LiveEvent[] = []

  if (msg.role === 'user') {
    const text = (msg.content || '').trim()
    if (!text) return []
    // Async batch finished. This row is written by hermes, not typed by anyone: it must not open a turn
    // (that recapped the boilerplate as if it were the prompt) and it is the ONLY signal the sub-agents
    // are done. The assistant's consolidated answer then streams under the turn the mirror is holding.
    const delegationId = delegationCompleteId(text)
    if (delegationId) {
      const ids = state.delegations.get(delegationId) ?? []
      state.delegations.delete(delegationId)
      return mode === 'replay' ? [] : delegationFinishEvents(text, ids)
    }
    if (mode === 'replay') return [{ type: 'user_message', payload: { content: text } }]
    if (state.open) events.push({ type: 'turn_ended', payload: {} })
    state.open = true
    state.pendingTools.clear()
    events.push({ type: 'turn_started', payload: { userMessage: text } })
    return events
  }

  if (msg.role === 'assistant') {
    const thinking = reasoningText(msg)
    if (thinking) {
      events.push({
        type: 'thinking_delta',
        payload: { content: clip(thinking, MAX_THINKING), thinkingId: `thinking-hermes-${state.thinkingCounter++}` },
      })
    }
    const text = (msg.content || '').trim()
    if (text) events.push({ type: 'text_delta', payload: { content: text } })
    for (const call of parseToolCalls(msg.toolCalls)) {
      state.toolNames.set(call.id, call.tool)
      state.pendingTools.add(call.id)
      const fan = call.tool === 'Task' ? delegateFanout(call) : null
      if (fan) {
        state.fanout.set(call.id, fan.ids)
        events.push(...fan.events)
        continue
      }
      events.push({ type: 'tool_start', payload: { id: call.id, tool: call.tool, input: call.input } })
    }
    if (mode === 'live' && state.open && isTerminalFinish(msg.finishReason) && state.pendingTools.size === 0) {
      state.open = false
      events.push({ type: 'turn_ended', payload: {} })
    }
    return events
  }

  if (msg.role === 'tool') {
    const id = msg.toolCallId || ''
    if (!id) return []
    state.pendingTools.delete(id)
    const tool = state.toolNames.get(id) || hermesToolName(msg.toolName ?? '')
    state.toolNames.delete(id)
    const { output, isError } = toolResultText(msg.content || '')
    const events: LiveEvent[] = [{
      type: 'tool_end',
      payload: { id, tool, output: clip(output, MAX_OUTPUT), isError, summary: toolSummary(tool, output, isError) },
    }]
    const ids = state.fanout.get(id)
    if (ids) {
      state.fanout.delete(id)
      const result = object(parseJson(msg.content || '')) ?? {}
      const delegationId = str(result.delegation_id)
      // Background fan-out: this result is only the dispatch ACK, so hold the rows open and remember which
      // batch they belong to. Foreground (or a failed dispatch): nothing else is coming — close them now.
      if (delegationId && str(result.mode) === 'background' && !isError) state.delegations.set(delegationId, ids)
      else for (const rowId of ids) events.push({ type: 'subagent_finished', payload: { id: rowId, status: isError ? 'failed' : 'completed' } })
    }
    return events
  }

  return [] // system / other roles are not surfaced
}

/** Full-session replay (session_get) — same render path as the live stream. */
export function hermesMessagesToEvents(messages: HmMessage[]): SessionEvent[] {
  const state = newHermesTurnState()
  const events: SessionEvent[] = []
  for (const msg of messages) events.push(...messageToEvents(msg, state, 'replay') as SessionEvent[])
  events.push({ type: 'done', payload: { result: 'success' } })
  return events
}

/** Last user prompt + the assistant text that followed it — the recap source of truth. */
export function lastHermesTurnText(messages: HmMessage[]): LastTurnText | null {
  let userMessage = ''
  let assistantText = ''
  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = (msg.content || '').trim()
      // A batch-complete row is hermes talking to itself. Treating it as a new prompt made the recap lead
      // with "[ASYNC DELEGATION BATCH COMPLETE — deleg_…]" and threw away the answer to what was ASKED;
      // the consolidated reply that follows belongs to the prompt that dispatched the batch.
      if (text && !delegationCompleteId(text)) { userMessage = text; assistantText = '' }
    } else if (msg.role === 'assistant') {
      const text = (msg.content || '').trim()
      if (text) assistantText += `${assistantText ? '\n\n' : ''}${text}`
    }
  }
  return assistantText ? { userMessage, assistantText } : null
}

/**
 * Turn-snapped pagination window for `session_get {limit, before}`; cursor `hermes:<index>`.
 * The start snaps back to a user row so a window never splits a turn (a tool_start's name must still
 * be known when its tool_end renders).
 */
export function windowHermesMessages(
  messages: HmMessage[],
  opts: { limit: number; before?: string },
): { window: HmMessage[]; hasMore: boolean; oldestCursor: string | null; staleCursor?: boolean } {
  let endIndex = messages.length
  if (opts.before) {
    const match = /^hermes:(\d+)$/.exec(opts.before)
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
    oldestCursor: `hermes:${start}`,
  }
}
