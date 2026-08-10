/**
 * Grok Build `updates.jsonl` -> Harness's shared event vocabulary.
 *
 * Measured on Grok 1.0.0. Each line is an ACP envelope whose discriminator lives at
 * `params.update.sessionUpdate`. The persisted stream is the authority for both live tailing and
 * history; `chat_history.jsonl` is the model-facing representation and omits UI-specific lifecycle
 * records such as `subagent_spawned`, `subagent_finished`, `plan`, and `turn_completed`.
 */

import type { EngineNormalizer } from '../types.js'
import type { LastTurnText, LiveEvent, SessionEvent } from '../../lib/normalize.js'

type JsonObject = Record<string, unknown>

const MAX_OUTPUT = 2_000
const MAX_THINKING = 500

/** Only names observed in real Grok sessions belong here. Unknown tools stay visibly generic. */
const TOOL_NAMES: Record<string, string> = {
  read_file: 'Read',
  todo_write: 'TodoWrite',
  spawn_subagent: 'Task',
  get_command_or_subagent_output: 'TaskWait',
  ask_user_question: 'AskUserQuestion',
}

export function grokToolName(name: string): string {
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

export interface GrokRecord {
  sessionId: string
  kind: string
  update: JsonObject
  meta: JsonObject
}

export function grokRecord(line: string): GrokRecord | null {
  let envelope: JsonObject | null
  try { envelope = obj(JSON.parse(line)) } catch { return null }
  const params = obj(envelope?.params)
  const update = obj(params?.update)
  const kind = str(update?.sessionUpdate)
  if (!params || !update || !kind) return null
  return {
    sessionId: str(params.sessionId),
    kind,
    update,
    meta: obj(params._meta) ?? {},
  }
}

/** Normalize the few measured argument differences that otherwise render blank shared cards. */
export function grokToolInput(tool: string, value: unknown): unknown {
  const input = obj(value)
  if (!input) return value ?? {}
  if (tool === 'Read' && str(input.target_file) && !str(input.file_path)) {
    return { ...input, file_path: str(input.target_file) }
  }
  // Grok already writes `{todos:[{content,status}]}`, exactly what the device consumes.
  return input
}

function nestedText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(nestedText).filter(Boolean).join('\n')
  const valueObj = obj(value)
  if (!valueObj) return ''
  if (typeof valueObj.text === 'string') return valueObj.text
  if ('content' in valueObj) return nestedText(valueObj.content)
  return ''
}

/** Unwrap the result shapes observed across Read, Todo, Task, TaskOutput and AskUserQuestion. */
export function grokToolOutput(update: JsonObject): string {
  const content = nestedText(update.content)
  if (content) return content
  const raw = obj(update.rawOutput)
  if (!raw) return typeof update.rawOutput === 'string' ? update.rawOutput : ''

  const file = obj(raw.FileContent)
  if (file) return str(file.raw_output) || str(file.content)
  const todos = obj(raw.TodosUpdated)
  if (todos) return str(todos.summary_for_prompt)
  const task = obj(raw.Result)
  if (task) return str(task.output) || str(task.command)
  const answered = obj(raw.UserAnswered)
  if (answered) return str(answered.message)
  if (typeof raw.text === 'string') return raw.text

  try { return JSON.stringify(raw) } catch { return '' }
}

function contentText(update: JsonObject): string {
  return str(obj(update.content)?.text)
}

interface SpawnRow {
  id: string
  description: string
}

interface GrokTurnState {
  open: boolean
  toolNames: Map<string, string>
  endedTools: Set<string>
  pendingSpawns: SpawnRow[]
  subagentRows: Map<string, string>
  openRows: Set<string>
}

function newGrokTurnState(): GrokTurnState {
  return {
    open: false,
    toolNames: new Map(),
    endedTools: new Set(),
    pendingSpawns: [],
    subagentRows: new Map(),
    openRows: new Set(),
  }
}

function childIdFromSpawnOutput(output: string): string {
  return /^subagent_id:\s*([^\s]+)$/m.exec(output)?.[1] ?? ''
}

function closeRows(state: GrokTurnState, events: LiveEvent[], status: string): void {
  for (const id of state.openRows) events.push({ type: 'subagent_finished', payload: { id, status } })
  state.openRows.clear()
  state.pendingSpawns = []
  state.subagentRows.clear()
}

function grokRecordToEvents(
  record: GrokRecord,
  state: GrokTurnState,
  mode: 'live' | 'replay',
): LiveEvent[] {
  const events: LiveEvent[] = []
  const { kind, update } = record

  if (kind === 'user_message_chunk') {
    const prompt = contentText(update).trim()
    if (!prompt) return events
    if (mode === 'replay') {
      events.push({ type: 'user_message', payload: { content: prompt } })
      return events
    }
    // One persisted user_message_chunk per measured prompt. If a prior boundary was lost, close it before
    // opening the next one rather than merging two user turns into a permanently-open turn.
    if (state.open) events.push({ type: 'turn_ended', payload: { aborted: true } })
    state.open = true
    state.toolNames.clear()
    state.endedTools.clear()
    state.pendingSpawns = []
    state.subagentRows.clear()
    state.openRows.clear()
    events.push({ type: 'turn_started', payload: { userMessage: prompt } })
    return events
  }

  if (kind === 'agent_thought_chunk') {
    const text = contentText(update)
    if (text) events.push({ type: 'thinking_delta', payload: { content: clip(text, MAX_THINKING) } })
    return events
  }

  if (kind === 'agent_message_chunk') {
    const text = contentText(update)
    if (text) events.push({ type: 'text_delta', payload: { content: text } })
    return events
  }

  if (kind === 'tool_call') {
    const id = str(update.toolCallId)
    if (!id || state.toolNames.has(id)) return events
    const tool = grokToolName(str(update.title))
    const input = grokToolInput(tool, update.rawInput)
    state.toolNames.set(id, tool)
    if (tool === 'Task') {
      const description = str(obj(input)?.description) || 'sub-agent'
      state.pendingSpawns.push({ id, description })
      state.openRows.add(id)
    }
    events.push({ type: 'tool_start', payload: { id, tool, input } })
    return events
  }

  if (kind === 'subagent_spawned') {
    const child = str(update.subagent_id) || str(update.child_session_id)
    if (!child) return events
    const description = str(update.description)
    const index = state.pendingSpawns.findIndex((row) => !description || row.description === description)
    const row = index >= 0 ? state.pendingSpawns.splice(index, 1)[0] : state.pendingSpawns.shift()
    if (row) state.subagentRows.set(child, row.id)
    return events
  }

  if (kind === 'subagent_finished') {
    if (mode === 'replay') return events
    const child = str(update.subagent_id) || str(update.child_session_id)
    const rowId = state.subagentRows.get(child)
    if (!rowId || !state.openRows.delete(rowId)) return events
    state.subagentRows.delete(child)
    events.push({
      type: 'subagent_finished',
      payload: { id: rowId, status: str(update.status) || 'completed', summary: str(update.output) || undefined },
    })
    return events
  }

  if (kind === 'tool_call_update') {
    const id = str(update.toolCallId)
    const status = str(update.status).toLowerCase()
    if (!id || !status || state.endedTools.has(id)) return events
    if (!['completed', 'failed', 'error', 'cancelled'].includes(status)) return events
    state.endedTools.add(id)
    const tool = state.toolNames.get(id) ?? 'Tool'
    const output = grokToolOutput(update)
    const isError = status !== 'completed'

    // `subagent_spawned` normally arrives before the spawn tool's completed update. The output carries the
    // same child id as a fallback, so reordered streams still pair the async completion with its Task row.
    if (tool === 'Task') {
      const child = childIdFromSpawnOutput(output)
      if (child && !state.subagentRows.has(child)) state.subagentRows.set(child, id)
      if (isError && state.openRows.delete(id) && mode === 'live') {
        events.push({ type: 'subagent_finished', payload: { id, status: 'failed' } })
      }
    }
    events.push({
      type: 'tool_end',
      payload: {
        id,
        tool,
        output: clip(output, MAX_OUTPUT),
        isError,
        summary: isError ? status : '',
      },
    })
    return events
  }

  if (kind === 'turn_completed') {
    if (mode === 'replay' || !state.open) return events
    const failed = str(update.stop_reason) !== 'end_turn'
    closeRows(state, events, failed ? 'failed' : 'completed')
    state.open = false
    state.toolNames.clear()
    state.endedTools.clear()
    events.push({ type: 'turn_ended', payload: failed ? { aborted: true } : {} })
    return events
  }

  return events
}

export class GrokNormalizer implements EngineNormalizer {
  private state = newGrokTurnState()

  get turnOpen(): boolean { return this.state.open }

  closeTurn(): void {
    this.state.open = false
    this.state.toolNames.clear()
    this.state.endedTools.clear()
    this.state.pendingSpawns = []
    this.state.subagentRows.clear()
    this.state.openRows.clear()
  }

  abortTurn(): LiveEvent[] {
    if (!this.state.open) return []
    const events: LiveEvent[] = []
    closeRows(this.state, events, 'failed')
    this.state.open = false
    this.state.toolNames.clear()
    this.state.endedTools.clear()
    events.push({ type: 'turn_ended', payload: { aborted: true } })
    return events
  }

  ingest(line: string): LiveEvent[] {
    const record = grokRecord(line)
    return record ? grokRecordToEvents(record, this.state, 'live') : []
  }

  finishReplay(): LiveEvent[] { return [] }
}

export function grokMessagesToEvents(lines: string[]): SessionEvent[] {
  const state = newGrokTurnState()
  const events: SessionEvent[] = []
  for (const line of lines) {
    const record = grokRecord(line)
    if (record) events.push(...grokRecordToEvents(record, state, 'replay') as SessionEvent[])
  }
  events.push({ type: 'done', payload: { result: 'success' } })
  return events
}

export function lastGrokTurnText(lines: string[]): LastTurnText | null {
  let userMessage = ''
  let assistantText = ''
  for (const line of lines) {
    const record = grokRecord(line)
    if (!record) continue
    if (record.kind === 'user_message_chunk') {
      userMessage = contentText(record.update).trim()
      assistantText = ''
    } else if (record.kind === 'agent_message_chunk') {
      const text = contentText(record.update).trim()
      if (text) assistantText += `${assistantText ? '\n\n' : ''}${text}`
    }
  }
  return assistantText ? { userMessage, assistantText } : null
}
