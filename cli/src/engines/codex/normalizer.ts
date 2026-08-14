import type { EngineNormalizer } from '../types.js'
import type { LastTurnText, LiveEvent, SessionEvent } from '../../lib/normalize.js'
import {
  codexToolDescriptor,
  isCodexInternalToolCall,
  resolveCodexSubagent,
  type CodexSubagentResolver,
} from './subagent.js'

type JsonObject = Record<string, unknown>

const MAX_OUTPUT = 2_000
const MAX_THINKING = 500
const ORCHESTRATION_TOOLS = new Set([
  'spawn_agent',
  'wait_agent',
  'list_agents',
  'send_message',
  'followup_task',
  'interrupt_agent',
  'close_agent',
  'resume_agent',
])

interface TaskInput {
  subagent_type: string
  name?: string
  title: string
  description: string
}

interface SpawnState {
  launcherId: string
  input: TaskInput
}

interface ChildResult {
  output: string
  isError: boolean
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function parse(line: string): JsonObject | null {
  try { return object(JSON.parse(line)) } catch { return null }
}

function payload(raw: JsonObject): JsonObject | null {
  const direct = object(raw.payload)
  return object(direct?.item) ?? direct
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n…[truncated]` : value
}

const TEXT_PART_TYPES = new Set(['input_text', 'output_text', 'text'])

function textContent(item: JsonObject): string {
  const content = item.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      const p = object(part)
      // Compared case-INSENSITIVELY because codex's TUI capitalises exactly one of these: an
      // `AgentMessage` part is `{"type":"Text"}` while a `UserMessage` part is `{"type":"text"}`
      // (measured 475/475 vs 107/107 across real rollouts). A case-sensitive list drops the capitalised
      // one silently — every assistant message would arrive empty rather than missing, which is the
      // harder failure to spot.
      return p && TEXT_PART_TYPES.has(string(p.type).toLowerCase()) ? string(p.text) : ''
    })
    .filter(Boolean)
    .join('')
}

/**
 * Codex speaks TWO rollout vocabularies, and which one a file uses depends on the SURFACE, not on the
 * version. Measured by correlating `session_meta.originator` with `cli_version` over every rollout on a
 * real machine:
 *
 *   codex-tui  0.146  →  event_msg/user_message   · event_msg/agent_message     (text in `item.message`)
 *   codex-tui  0.147  →  event_msg/item_completed · item.type UserMessage/AgentMessage (text in `content`)
 *   codex_exec 0.147  →  the OLD pair, still
 *
 * So the old names are NOT legacy. `codex exec` — which is what the recap, oneshot and router pools run
 * (`lib/summarize.ts`, `lib/oneshot.ts`) — keeps writing them at the very version that changed the TUI,
 * and 0.146 TUI rollouts stay on disk to be replayed as web history. Both are read; neither is dropped.
 *
 * Dual support cannot open a turn twice: the two vocabularies never appear in the same file (checked
 * across every rollout on that machine — each is exclusively one or the other).
 *
 * The names below are what `eventMessage` actually sees, because `payload()` unwraps `payload.item` —
 * the string `item_completed` is never visible to it.
 */
const USER_TURN_TYPES = new Set(['user_message', 'UserMessage'])
const AGENT_TEXT_TYPES = new Set(['agent_message', 'AgentMessage'])

/** The text of one message, from whichever vocabulary wrote it: old carries it flat, new in `content`. */
function messageText(item: JsonObject): string {
  return string(item.message) || textContent(item)
}

function parseInput(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {}
  try { return JSON.parse(value) } catch { return value }
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === 'string') return part
      const p = object(part)
      return p && typeof p.text === 'string' ? p.text : ''
    }).filter(Boolean).join('')
  }
  try { return JSON.stringify(value) ?? '' } catch { return String(value) }
}

function parseObject(value: unknown): JsonObject | null {
  const direct = object(value)
  if (direct) return direct
  if (typeof value !== 'string') return null
  try { return object(JSON.parse(value)) } catch { return null }
}

function taskInput(value: unknown): TaskInput {
  const args = object(parseInput(value)) ?? {}
  const message = string(args.message) || string(args.prompt)
  let title = string(args.title) || string(args.description)

  if (!title && Array.isArray(args.items)) {
    for (const entry of args.items) {
      const item = object(entry)
      const itemText = string(item?.text)
      const match = /(?:^|\s)description\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))/i.exec(itemText)
      if (match) { title = match[1] || match[2] || match[3]; break }
    }
  }
  if (!title && message) {
    const match = /(?:^|\s)description\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s.]+))/i.exec(message)
    if (match) title = match[1] || match[2] || match[3]
  }
  const description = message
    .replace(/(?:^|\s)description\s*=\s*(?:"[^"]+"|'[^']+'|[^\s.]+)\.?\s*/i, '')
    .trim()
    || title
    || 'Delegated task'
  title ||= description.split(/[.\n]/)[0].trim().slice(0, 80) || 'Delegated task'

  return {
    subagent_type: string(args.agent_type) || string(args.subagent_type) || 'agent',
    title,
    description,
  }
}

function childResults(value: unknown): Map<string, ChildResult> {
  const result = new Map<string, ChildResult>()
  const parsed = parseObject(value)
  const states = object(parsed?.status) ?? object(parsed?.agents_states)
  if (!states) return result

  for (const [childId, rawState] of Object.entries(states)) {
    const state = object(rawState)
    if (!state) continue
    if (typeof state.completed === 'string') {
      result.set(childId, { output: state.completed, isError: false })
    } else if (typeof state.failed === 'string') {
      result.set(childId, { output: state.failed, isError: true })
    } else if (state.status === 'completed' || state.status === 'failed') {
      result.set(childId, {
        output: string(state.message) || `Subagent ${state.status}`,
        isError: state.status === 'failed',
      })
    }
  }
  return result
}

/**
 * The failure message codex records when a turn dies, or null for anything else.
 *
 * Codex does close the turn on its own — the error rides ON the `task_complete` event rather than
 * replacing it — so nothing hangs. What was lost is the REASON: the turn ended with
 * `last_agent_message: null` and no text, so the web showed a turn that finished having said nothing:
 *
 *   {"type":"event_msg","payload":{"type":"task_complete","turn_id":"019fb768-…",
 *     "last_agent_message":null,
 *     "error":{"message":"You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage
 *              to purchase more credits or try again at Aug 5th, 2026 11:09 AM."}}}
 *
 * Verified against a real rollout (codex 0.145). `turn_aborted` carries no error of its own — a user
 * interrupt is not a failure — so only `task_complete` is read here.
 */
export function codexTaskError(rawLine: string): string | null {
  const raw = parse(rawLine)
  if (!raw || string(raw.type) !== 'event_msg') return null
  const item = payload(raw)
  if (!item || string(item.type) !== 'task_complete') return null
  const message = string(object(item.error)?.message)
  return message.trim() || null
}

/**
 * `<codex_internal_context source="goal">…<objective>x</objective>…` → the objective.
 *
 * Codex records a `/goal x` submission ONLY as this injected `response_item` user message — it emits
 * NO `event_msg/user_message` at all — and re-injects the same context at the head of every
 * continuation turn the goal drives. Everything in this normalizer keys off `user_message`, so
 * without this a goal session produced ZERO turn events: the adapter's submit-verify never saw the
 * turn open and reported "The agent did not accept the message", and every autonomous turn after
 * that was invisible to the web + device.
 */
function goalObjective(item: JsonObject): string | null {
  if (string(item.role) !== 'user') return null
  const content = Array.isArray(item.content) ? item.content : []
  const text = content.map((part) => string(object(part)?.text)).filter(Boolean).join('\n')
  if (!text.includes('<codex_internal_context source="goal">')) return null
  return text.match(/<objective>\s*([\s\S]*?)\s*<\/objective>/)?.[1]?.trim() || null
}

function subagentNotification(item: JsonObject): { childId: string; result: ChildResult } | null {
  if (item.role !== 'user') return null
  const content = textContent(item)
  const match = /<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>/.exec(content)
  if (!match) return null
  const parsed = parseObject(match[1])
  const childId = string(parsed?.agent_path) || string(parsed?.agent_id)
  const status = object(parsed?.status)
  if (!childId || !status) return null
  if (typeof status.completed === 'string') return { childId, result: { output: status.completed, isError: false } }
  if (typeof status.failed === 'string') return { childId, result: { output: status.failed, isError: true } }
  return null
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

export class CodexNormalizer implements EngineNormalizer {
  private open = false
  private pendingTask = false
  private toolNames = new Map<string, string>()
  private rawToolNames = new Map<string, string>()
  private hiddenToolCalls = new Set<string>()
  private pendingSpawns = new Map<string, SpawnState>()
  private childLaunchers = new Map<string, SpawnState>()
  private pendingChildResults = new Map<string, ChildResult>()
  private completedChildren = new Set<string>()
  private thinkingCounter = 0
  private compactJustEmitted = false
  /** Objective of the active `/goal`, so its re-injection each turn isn't read as a new submission. */
  private goalObjective: string | null = null

  constructor(
    private readonly mode: 'live' | 'replay',
    private readonly resolveSubagent: CodexSubagentResolver = resolveCodexSubagent,
  ) {}

  get turnOpen(): boolean { return this.open }

  closeTurn(): void { this.open = false; this.pendingTask = false }

  ingest(line: string): LiveEvent[] {
    const raw = parse(line)
    if (!raw) return []
    const topType = string(raw.type)
    const item = payload(raw)
    const type = string(item?.type)

    if (topType === 'compacted') {
      this.compactJustEmitted = true
      return [compactEvent()]
    }
    if (topType === 'event_msg' && type === 'context_compacted') {
      if (this.compactJustEmitted) { this.compactJustEmitted = false; return [] }
      return [compactEvent()]
    }
    if (this.compactJustEmitted && topType === 'event_msg' && type === 'token_count') return []
    this.compactJustEmitted = false
    if (!item) return []

    if (topType === 'event_msg') return this.eventMessage(type, item)
    if (topType === 'response_item') return this.responseItem(type, item)
    return []
  }

  finishReplay(): LiveEvent[] {
    if (this.mode !== 'replay') return []
    return [...this.completeOutstanding(false), { type: 'done', payload: { result: 'success' } }]
  }

  private eventMessage(type: string, item: JsonObject): LiveEvent[] {
    if (type === 'task_started') {
      this.pendingTask = true
      return []
    }

    if (USER_TURN_TYPES.has(type)) {
      const message = messageText(item)
      if (!message) return []
      if (this.mode === 'replay') return [{ type: 'user_message', payload: { content: message } }]
      const events: LiveEvent[] = []
      if (this.open) events.push({ type: 'turn_ended', payload: {} })
      this.pendingTask = false
      this.open = true
      events.push({ type: 'turn_started', payload: { userMessage: message } })
      return events
    }

    // Every `phase` streams — `commentary`, `final_answer`, and the ones that carry none. That is parity
    // rather than an expansion: the old vocabulary already emitted several `agent_message` per turn
    // (measured on a real 0.146 rollout), because codex's preambles were always part of the answer.
    if (AGENT_TEXT_TYPES.has(type)) {
      const message = messageText(item)
      return message ? [{ type: 'text_delta', payload: { content: message } }] : []
    }

    if (type === 'task_complete' || type === 'turn_aborted') {
      this.pendingTask = false
      const events = this.completeOutstanding(type === 'turn_aborted')
      if (!this.open || this.mode === 'replay') return events
      this.open = false
      return [...events, { type: 'turn_ended', payload: {} }]
    }

    return []
  }

  /**
   * A goal-context injection opens a turn. The FIRST one is the user's actual `/goal x` submission —
   * labelled `/goal <objective>` so it reproduces the injected prompt byte-for-byte and the adapter's
   * submit-verify fingerprint matches. Codex re-injects the identical context to drive each
   * continuation turn; those are labelled distinctly so they don't read as the user asking again.
   */
  private goalTurn(objective: string): LiveEvent[] {
    const submission = this.goalObjective !== objective
    this.goalObjective = objective
    const userMessage = submission ? `/goal ${objective}` : `Continuing goal: ${objective}`
    if (this.mode === 'replay') return [{ type: 'user_message', payload: { content: userMessage } }]
    const events: LiveEvent[] = []
    if (this.open) events.push({ type: 'turn_ended', payload: {} })
    this.pendingTask = false
    this.open = true
    events.push({ type: 'turn_started', payload: { userMessage } })
    return events
  }

  private responseItem(type: string, item: JsonObject): LiveEvent[] {
    // event_msg user/agent messages are authoritative and are emitted once. The one exception is an
    // internal subagent_notification, which closes the matching Task launcher and is never user text.
    if (type === 'message') {
      const objective = goalObjective(item)
      if (objective) return this.goalTurn(objective)
      const notification = subagentNotification(item)
      return notification ? this.completeChild(notification.childId, notification.result) : []
    }

    if (type === 'reasoning') {
      const summary = Array.isArray(item.summary)
        ? item.summary.map((part) => string(object(part)?.text)).filter(Boolean).join('\n')
        : string(item.summary)
      if (!summary) return []
      return [{
        type: 'thinking_delta',
        payload: { content: clip(summary, MAX_THINKING), thinkingId: `thinking-codex-${this.thinkingCounter++}` },
      }]
    }

    if (type === 'function_call' || type === 'custom_tool_call' || type === 'tool_search_call') {
      const id = string(item.call_id) || string(item.id)
      const name = string(item.name) || (type === 'tool_search_call' ? 'tool_search' : 'tool')
      if (!id) return []
      if (isCodexInternalToolCall(name, item.arguments ?? item.input)) {
        this.hiddenToolCalls.add(id)
        return []
      }
      this.rawToolNames.set(id, name)

      if (name === 'spawn_agent') {
        const input = taskInput(item.arguments ?? item.input)
        const spawn = { launcherId: id, input }
        this.pendingSpawns.set(id, spawn)
        this.toolNames.set(id, 'Task')
        return []
      }
      if (ORCHESTRATION_TOOLS.has(name)) return []

      const descriptor = codexToolDescriptor(name, item.arguments ?? item.input)
      this.toolNames.set(id, descriptor.tool)
      return [{ type: 'tool_start', payload: { id, tool: descriptor.tool, input: descriptor.input } }]
    }

    if (type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'tool_search_output') {
      const id = string(item.call_id) || string(item.id)
      if (!id) return []
      if (this.hiddenToolCalls.delete(id)) return []
      const rawName = this.rawToolNames.get(id) || ''
      this.rawToolNames.delete(id)
      if (rawName === 'spawn_agent') return this.handleSpawnOutput(id, item)
      if (ORCHESTRATION_TOOLS.has(rawName)) return this.completeFromStatus(item.output)

      const name = this.toolNames.get(id) || 'tool'
      this.toolNames.delete(id)
      const rawOutput = outputText(item.output)
      const isError = item.is_error === true || item.status === 'failed'
      return [{
        type: 'tool_end',
        payload: {
          id,
          tool: name,
          output: clip(rawOutput, MAX_OUTPUT),
          isError,
          summary: toolSummary(name, rawOutput, isError),
        },
      }]
    }

    return []
  }

  private handleSpawnOutput(id: string, item: JsonObject): LiveEvent[] {
    const spawn = this.pendingSpawns.get(id)
    if (!spawn) return []
    this.toolNames.delete(id)
    const parsed = parseObject(item.output)
    const childId = string(parsed?.agent_id) || string(parsed?.thread_id)
    if (childId) {
      const nickname = string(parsed?.nickname) || string(parsed?.name)
      if (nickname) spawn.input.name = nickname
      this.pendingSpawns.delete(id)
      this.childLaunchers.set(childId, spawn)
      const events: LiveEvent[] = [{
        type: 'tool_start',
        payload: { id: spawn.launcherId, tool: 'Task', input: spawn.input },
      }]
      const pending = this.pendingChildResults.get(childId)
      if (!pending) return events
      this.pendingChildResults.delete(childId)
      return [...events, ...this.completeChild(childId, pending)]
    }

    this.pendingSpawns.delete(id)
    const output = outputText(item.output) || 'Subagent failed to start'
    return [
      { type: 'tool_start', payload: { id: spawn.launcherId, tool: 'Task', input: spawn.input } },
      {
        type: 'tool_end',
        payload: {
          id: spawn.launcherId,
          tool: 'Task',
          output: clip(output, MAX_OUTPUT),
          isError: true,
          summary: toolSummary('Task', output, true),
        },
      },
    ]
  }

  private completeFromStatus(value: unknown): LiveEvent[] {
    const events: LiveEvent[] = []
    for (const [childId, result] of childResults(value)) events.push(...this.completeChild(childId, result))
    return events
  }

  private completeChild(childId: string, result: ChildResult): LiveEvent[] {
    if (this.completedChildren.has(childId)) return []
    const spawn = this.childLaunchers.get(childId)
    if (!spawn) {
      this.pendingChildResults.set(childId, result)
      return []
    }

    this.completedChildren.add(childId)
    this.childLaunchers.delete(childId)
    this.pendingChildResults.delete(childId)
    let info: ReturnType<CodexSubagentResolver> = null
    try { info = this.resolveSubagent(childId) } catch { /* close the Task even if history is unreadable */ }

    const events: LiveEvent[] = []
    for (const event of info?.events ?? []) {
      if (event.type === 'tool_start') {
        events.push({
          type: 'tool_start',
          payload: { ...event.payload, parentToolUseId: spawn.launcherId },
        })
      } else {
        events.push({
          type: 'tool_end',
          payload: { ...event.payload, parentToolUseId: spawn.launcherId },
        })
      }
    }
    const output = result.output || (result.isError ? 'Subagent failed' : 'Subagent completed')
    events.push({
      type: 'tool_end',
      payload: {
        id: spawn.launcherId,
        tool: 'Task',
        output: clip(output, MAX_OUTPUT),
        isError: result.isError,
        summary: toolSummary('Task', output, result.isError),
        subagent: {
          agentId: childId,
          agentType: info?.agentType ?? spawn.input.subagent_type,
          totalToolUseCount: info?.totalToolUseCount ?? 0,
          totalTokens: info?.totalTokens ?? 0,
          totalDurationMs: info?.totalDurationMs ?? 0,
        },
      },
    })
    return events
  }

  private completeOutstanding(isError: boolean): LiveEvent[] {
    const events: LiveEvent[] = []
    for (const childId of [...this.childLaunchers.keys()]) {
      events.push(...this.completeChild(childId, {
        output: isError ? 'Subagent turn aborted' : 'Subagent completed',
        isError,
      }))
    }
    for (const [callId, spawn] of this.pendingSpawns) {
      const output = isError ? 'Subagent turn aborted' : 'Subagent finished without an agent id'
      events.push(
        { type: 'tool_start', payload: { id: spawn.launcherId, tool: 'Task', input: spawn.input } },
        {
          type: 'tool_end',
          payload: {
            id: spawn.launcherId,
            tool: 'Task',
            output,
            isError: true,
            summary: toolSummary('Task', output, true),
          },
        },
      )
      this.pendingSpawns.delete(callId)
    }
    this.pendingChildResults.clear()
    return events
  }
}

export function codexMessagesToEvents(
  rawLines: string[],
  resolveSubagent: CodexSubagentResolver = resolveCodexSubagent,
): SessionEvent[] {
  const normalizer = new CodexNormalizer('replay', resolveSubagent)
  const events: SessionEvent[] = []
  for (const line of rawLines) events.push(...normalizer.ingest(line) as SessionEvent[])
  events.push(...normalizer.finishReplay() as SessionEvent[])
  return events
}

export function lastCodexTurnText(rawLines: string[]): LastTurnText | null {
  let userMessage = ''
  let assistantText = ''
  for (const line of rawLines) {
    const raw = parse(line)
    if (!raw) continue
    const item = payload(raw)
    if (!item) continue
    // A `/goal` turn has no `user_message` — its prompt lives in the injected goal context.
    if (raw.type === 'response_item' && string(item.type) === 'message') {
      const objective = goalObjective(item)
      if (objective) { userMessage = `/goal ${objective}`; assistantText = '' }
      continue
    }
    if (raw.type !== 'event_msg') continue
    const itemType = string(item.type)
    if (USER_TURN_TYPES.has(itemType)) {
      const message = messageText(item)
      if (message) { userMessage = message; assistantText = '' }
    } else if (AGENT_TEXT_TYPES.has(itemType)) {
      const message = messageText(item)
      if (message) assistantText += `${assistantText ? '\n\n' : ''}${message}`
    }
  }
  return assistantText ? { userMessage, assistantText } : null
}

export function windowCodexLines(
  rawLines: string[],
  opts: { limit: number; before?: string },
): { window: string[]; hasMore: boolean; oldestCursor: string | null; staleCursor?: boolean } {
  let endIndex = rawLines.length
  if (opts.before) {
    const match = /^codex:(\d+)$/.exec(opts.before)
    if (!match) return { window: [], hasMore: false, oldestCursor: null, staleCursor: true }
    endIndex = Number(match[1])
    if (!Number.isSafeInteger(endIndex) || endIndex < 0 || endIndex > rawLines.length) {
      return { window: [], hasMore: false, oldestCursor: null, staleCursor: true }
    }
  }

  let start = Math.max(0, endIndex - opts.limit)
  while (start > 0) {
    const raw = parse(rawLines[start])
    const item = raw ? payload(raw) : null
    if (raw?.type === 'event_msg' && item && USER_TURN_TYPES.has(string(item.type))) break
    // A goal turn starts on the injected goal context, not on a `user_message`.
    if (raw?.type === 'response_item' && item && string(item.type) === 'message' && goalObjective(item)) break
    start--
  }
  return {
    window: rawLines.slice(start, endIndex),
    hasMore: start > 0,
    oldestCursor: `codex:${start}`,
  }
}

export function codexSessionMeta(rawLines: string[]): { id: string; cwd: string; cliVersion: string } | null {
  for (const line of rawLines) {
    const raw = parse(line)
    if (raw?.type !== 'session_meta') continue
    const item = payload(raw)
    if (!item) continue
    const id = string(item.id) || string(item.session_id)
    if (id) return { id, cwd: string(item.cwd), cliVersion: string(item.cli_version) }
  }
  return null
}
