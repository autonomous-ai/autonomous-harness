/**
 * GitHub Copilot CLI `events.jsonl` -> Harness's shared event vocabulary.
 *
 * Measured on Copilot CLI 1.0.80. Each session writes an append-only event stream to
 * `<COPILOT_HOME>/session-state/<sessionId>/events.jsonl`. Every record is
 * `{type, data, id, timestamp, parentId}`, and the vocabulary is the most explicit of any engine here:
 * tool calls carry a real `toolCallId` on both halves, so nothing is paired by position or by guessing.
 *
 * The one thing that is NOT what it looks like:
 *
 *   `assistant.turn_start` / `assistant.turn_end` are per MODEL ROUND-TRIP, not per user exchange.
 *   One measured prompt produced turnId 0 (text + two tools) and turnId 1 (the closing sentence) —
 *   two starts and two ends for one turn. Reading the lifecycle off them splits a single exchange
 *   into several and closes the turn while the agent is still working.
 *
 * The real boundary is the `agentStop` hook (`stopReason: "end_turn"`, and it names this very file in
 * `transcriptPath`), handled in `cli.ts`. A turn opens here on `user.message`.
 */

import type { EngineNormalizer } from '../types.js'
import type { LastTurnText, LiveEvent, SessionEvent } from '../../lib/normalize.js'

type JsonObject = Record<string, unknown>

const MAX_OUTPUT = 2_000

/**
 * Only names observed in real Copilot sessions belong here; unknown tools stay visibly generic.
 *
 * Measured firing: `bash`, `create`, `view`, `sql`. Everything else falls through to Title Case rather
 * than being invented — an earlier draft mapped `todo`/`todos` from words in the system prompt and was
 * wrong: those are SQL identifiers, not tools (see below).
 *
 * **There is no TodoWrite here, and that is a measurement, not an omission.** Asked on a real session
 * to "make a todo list using your todo tool", Copilot called `sql` with
 * `INSERT INTO todos (id, title, description, status) VALUES …`. Its plan lives in an in-session SQL
 * table, not in a tool payload shaped `{todos:[{content,status}]}`, so the device checklist for this
 * engine stays empty. `sql` is a general query tool and must not be relabelled TodoWrite: the same tool
 * runs every other query too.
 */
const TOOL_NAMES: Record<string, string> = {
  bash: 'Bash',
  create: 'Write',
  view: 'Read',
  // Must be exactly `AskUserQuestion`, or the dialog renders as an ordinary card in the tool feed —
  // where nobody can answer it. Measured: it drew as "Asked user" from the Title-Case fallback.
  ask_user: 'AskUserQuestion',
}

export function copilotToolName(name: string): string {
  if (TOOL_NAMES[name]) return TOOL_NAMES[name]
  const words = name.split(/[_\s-]+/).filter(Boolean)
  return words.length ? words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') : 'Tool'
}

function obj(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n...[truncated]`
}

export interface CopilotEvent {
  type: string
  data: JsonObject
  id: string
  parentId: string
}

export function copilotEvent(line: string): CopilotEvent | null {
  let raw: JsonObject | null
  try { raw = obj(JSON.parse(line)) } catch { return null }
  const type = str(raw?.type)
  if (!raw || !type) return null
  return { type, data: obj(raw.data) ?? {}, id: str(raw.id), parentId: str(raw.parentId) }
}

/**
 * The prompt as the user typed it.
 *
 * `content` is that; `transformedContent` is the same text wrapped in `<current_datetime>` and
 * `<system_reminder>` blocks for the model. Showing the transformed one would put Copilot's own
 * scaffolding in the user's bubble.
 */
export function copilotUserText(data: JsonObject): string {
  return str(data.content).trim()
}

/** Tool results are `{result: {content, detailedContent}}`; `content` is the human-sized one. */
export function copilotToolOutput(data: JsonObject): string {
  const result = obj(data.result)
  const text = str(result?.content) || str(result?.detailedContent)
  return clip(text.trim(), MAX_OUTPUT)
}

interface CopilotTurnState {
  open: boolean
  /** toolCallId -> shared tool name, so `tool.execution_complete` can close the row it opened. */
  openRows: Map<string, string>
}

export function newCopilotTurnState(): CopilotTurnState {
  return { open: false, openRows: new Map() }
}

function closeRows(state: CopilotTurnState, events: LiveEvent[], status: string): void {
  for (const [id, tool] of state.openRows) {
    events.push({ type: 'tool_end', payload: { id, tool, output: `Tool ${status}`, isError: status === 'failed', summary: '' } })
  }
  state.openRows.clear()
}

/** Records that exist for Copilot's own bookkeeping and carry nothing a person reads. */
const IGNORED = new Set([
  'session.start',
  'session.shutdown',
  'session.usage_checkpoint',
  'session.auto_mode_resolved',
  'session.model_change',
  'session.info',
  // Our own hooks, logged back into the stream. Rendering them would mirror Harness at the user.
  'hook.start',
  'hook.end',
  // The system prompt. Never the user's.
  'system.message',
])

export function copilotEventToEvents(event: CopilotEvent, state: CopilotTurnState, mode: 'live' | 'replay'): LiveEvent[] {
  const events: LiveEvent[] = []
  const { type, data } = event

  if (IGNORED.has(type)) return events

  if (type === 'user.message') {
    const userMessage = copilotUserText(data)
    if (mode === 'live') {
      if (state.open) {
        closeRows(state, events, 'interrupted')
        events.push({ type: 'turn_ended', payload: {} })
      }
      state.open = true
      events.push({ type: 'turn_started', payload: { userMessage } })
    }
    events.push({ type: 'user_message', payload: { content: userMessage } })
    return events
  }

  if (type === 'assistant.message') {
    // `toolRequests` announces the calls, but `tool.execution_start` carries the same ids a moment
    // later — opening rows from both would double every card.
    const text = str(data.content).trim()
    if (text) events.push({ type: 'text_delta', payload: { content: text } })
    return events
  }

  if (type === 'tool.execution_start') {
    const id = str(data.toolCallId)
    if (!id) return events
    const tool = copilotToolName(str(data.toolName))
    state.openRows.set(id, tool)
    events.push({ type: 'tool_start', payload: { id, tool, input: obj(data.arguments) ?? {} } })
    return events
  }

  if (type === 'tool.execution_complete') {
    const id = str(data.toolCallId)
    const tool = state.openRows.get(id)
    if (!id || !tool) return events
    state.openRows.delete(id)
    events.push({
      type: 'tool_end',
      payload: { id, tool, output: copilotToolOutput(data), isError: data.success === false, summary: '' },
    })
    return events
  }

  // assistant.turn_start / assistant.turn_end deliberately fall through: see the header. They mark
  // model round-trips, and one user exchange contains several.
  return events
}

export class CopilotNormalizer implements EngineNormalizer {
  private state = newCopilotTurnState()

  get turnOpen(): boolean { return this.state.open }

  /** The `agentStop` hook fired: close every row this turn opened, then the turn. */
  closeTurn(): LiveEvent[] {
    if (!this.state.open) return []
    const events: LiveEvent[] = []
    closeRows(this.state, events, 'completed')
    this.state.open = false
    events.push({ type: 'turn_ended', payload: {} })
    return events
  }

  abortTurn(): LiveEvent[] {
    if (!this.state.open) return []
    const events: LiveEvent[] = []
    closeRows(this.state, events, 'failed')
    this.state.open = false
    events.push({ type: 'turn_ended', payload: { aborted: true } })
    return events
  }

  ingest(line: string): LiveEvent[] {
    const event = copilotEvent(line)
    return event ? copilotEventToEvents(event, this.state, 'live') : []
  }

  finishReplay(): LiveEvent[] { return [] }
}

export function copilotMessagesToEvents(lines: string[]): SessionEvent[] {
  const state = newCopilotTurnState()
  const events: SessionEvent[] = []
  for (const line of lines) {
    const event = copilotEvent(line)
    if (event) events.push(...copilotEventToEvents(event, state, 'replay') as SessionEvent[])
  }
  events.push({ type: 'done', payload: { result: 'success' } })
  return events
}

export function lastCopilotTurnText(lines: string[]): LastTurnText | null {
  let userMessage = ''
  let assistantText = ''
  for (const line of lines) {
    const event = copilotEvent(line)
    if (!event) continue
    if (event.type === 'user.message') {
      userMessage = copilotUserText(event.data)
      assistantText = ''
    } else if (event.type === 'assistant.message') {
      const text = str(event.data.content).trim()
      if (text) assistantText += `${assistantText ? '\n\n' : ''}${text}`
    }
  }
  return assistantText ? { userMessage, assistantText } : null
}

/**
 * Is the LAST exchange in a recorded conversation still running?
 *
 * The live path never asks this — a turn opens on `user.message` and closes on the `agentStop` hook.
 * But `--resume` folds an existing file at attach, and a turn opened by that fold has no hook coming
 * to close it: the device sat on "busy loading" for a conversation that finished hours ago. (agy had
 * the same failure and had to ask the PANE, because its transcript records no end at all. Copilot's
 * does, so this is answerable from the file.)
 *
 * `assistant.turn_end` marks a model round-trip, not the exchange — but its POSITION still settles the
 * question: a turn is only unfinished if something started after the last one ended.
 */
export function copilotHistoryTurnOpen(lines: string[]): boolean {
  let lastOpener = -1
  let lastEnd = -1
  let shutdown = -1
  lines.forEach((line, index) => {
    const event = copilotEvent(line)
    if (!event) return
    if (event.type === 'user.message' || event.type === 'assistant.turn_start') lastOpener = index
    else if (event.type === 'assistant.turn_end') lastEnd = index
    else if (event.type === 'session.shutdown') shutdown = index
  })
  // A shutdown after the last activity ends the conversation whatever came before it.
  if (shutdown > lastOpener && shutdown > lastEnd) return false
  return lastOpener > lastEnd
}

/** The model Copilot resolved for this session — `session.model_change`, then each assistant message. */
export function copilotSessionModel(lines: string[]): string | null {
  let model = ''
  for (const line of lines) {
    const event = copilotEvent(line)
    if (!event) continue
    if (event.type === 'session.model_change') model = str(event.data.newModel) || model
    // `auto` resolves to a concrete model per message; the concrete one is what the user is billed for.
    if (event.type === 'assistant.message' && str(event.data.model)) model = str(event.data.model)
  }
  return model || null
}
