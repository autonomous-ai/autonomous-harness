/**
 * Antigravity CLI (`agy`) `transcript_full.jsonl` -> Harness's shared event vocabulary.
 *
 * Measured on agy 1.1.14. The engine appends one JSON "step" per line to
 * `<AGY_HOME>/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`. Read the `_full`
 * file, not its `transcript.jsonl` sibling: the short one re-quotes tool arguments
 * (`"query": "\"bitcoin…\""`) and truncates long content.
 *
 * The shape is regular and positional:
 *
 *   USER_INPUT                          the turn opens; content is wrapped in <USER_REQUEST>
 *   PLANNER_RESPONSE  tool_calls:[…]    the model's text/thinking, plus N tool calls
 *   <RESULT>                            exactly N result steps follow, in call order
 *   …
 *   PLANNER_RESPONSE                    closing prose, no tool_calls
 *
 * A result step's `type` is the tool's own step type — `run_command` answers as `RUN_COMMAND`,
 * `search_web` as `SEARCH_WEB` — but the mapping is NOT a round-trip: `list_dir` answers as
 * `LIST_DIRECTORY`, and any failed call answers as `ERROR_MESSAGE` whatever the tool was. Pairing is
 * therefore by POSITION against the calls queued by the preceding PLANNER_RESPONSE, never by name.
 *
 * Two things that are deliberately NOT turn boundaries:
 *
 *  - `status: "RUNNING"`. A backgrounded tool (`schedule`, long shell) writes its result step as
 *    RUNNING and, because the file is strictly append-only, that line is never rewritten to DONE.
 *    Holding a turn open on it pins the device tile on "Processing" forever. It still CLOSES its tool
 *    row — the step is the call's result, it just says the work continues elsewhere.
 *  - `CHECKPOINT`. Despite a body that says the conversation "has been truncated", `{{ CHECKPOINT 0 }}`
 *    is written into EVERY conversation near its start — see the branch below. Only a higher counter
 *    is treated as a compaction, and even then it must not touch turn state.
 *
 * The real close is agy's `Stop` hook, handled in `cli.ts` (drain → grace → drain → force-close).
 */

import type { EngineNormalizer } from '../types.js'
import type { LastTurnText, LiveEvent, SessionEvent } from '../../lib/normalize.js'

type JsonObject = Record<string, unknown>

const MAX_OUTPUT = 2_000
const MAX_THINKING = 500

/**
 * Only tool names observed in real agy sessions belong here; unknown tools stay visibly generic.
 *
 * There is no planning tool to map. Asked three times on a real pane to "make a todo list and do it,
 * do not just describe it", agy wrote markdown checkboxes in prose and called nothing — and the full
 * `CORTEX_STEP_TYPE_*` vocabulary in the binary contains no todo/task-list step. The device checklist
 * for this engine is empty by measurement.
 */
const TOOL_NAMES: Record<string, string> = {
  run_command: 'Bash',
  view_file: 'Read',
  list_dir: 'ListDir',
  grep_search: 'Grep',
  codebase_search: 'Grep',
  find_by_name: 'Glob',
  search_web: 'WebSearch',
  read_url_content: 'WebFetch',
  write_to_file: 'Write',
  replace_file_content: 'Edit',
  edit_file: 'Edit',
  ask_question: 'AskUserQuestion',
  invoke_subagent: 'Task',
  manage_subagents: 'TaskWait',
  send_message: 'SendMessage',
  schedule: 'Schedule',
}

export function agyToolName(name: string): string {
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

export interface AgyStep {
  stepIndex: number
  source: string
  type: string
  status: string
  content: string
  thinking: string
  toolCalls: Array<{ name: string; args: JsonObject }>
  exitCode: number | null
}

export function agyStep(line: string): AgyStep | null {
  let raw: JsonObject | null
  try { raw = obj(JSON.parse(line)) } catch { return null }
  if (!raw) return null
  const type = str(raw.type)
  if (!type) return null
  const calls: Array<{ name: string; args: JsonObject }> = []
  if (Array.isArray(raw.tool_calls)) {
    for (const entry of raw.tool_calls) {
      const call = obj(entry)
      const name = str(call?.name)
      if (name) calls.push({ name, args: obj(call?.args) ?? {} })
    }
  }
  return {
    stepIndex: typeof raw.step_index === 'number' ? raw.step_index : -1,
    source: str(raw.source),
    type,
    status: str(raw.status),
    content: str(raw.content),
    thinking: str(raw.thinking),
    toolCalls: calls,
    exitCode: typeof raw.exit_code === 'number' ? raw.exit_code : null,
  }
}

/**
 * Steps that carry no user-visible content and must not be mistaken for a tool result.
 *
 * CONVERSATION_HISTORY is agy's own context-priming record (always empty content). SYSTEM_MESSAGE is
 * how a sub-agent reports back to its parent and is handled separately.
 */
const NON_RESULT_TYPES = new Set(['USER_INPUT', 'PLANNER_RESPONSE', 'CHECKPOINT', 'CONVERSATION_HISTORY', 'SYSTEM_MESSAGE'])

/** `<USER_REQUEST>…</USER_REQUEST>` plus the metadata block agy appends to every prompt. */
export function agyUserText(content: string): string {
  const request = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(content)
  const body = request ? request[1] : content.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
  return body.trim()
}

/**
 * Strip the timestamp preamble every tool result step carries.
 *
 * Measured: `Created At: …\nCompleted At: …\n\n<the actual output>`. Left in, every tool card opens
 * with two lines of clock before it says anything.
 */
export function agyToolOutput(step: AgyStep): string {
  const body = step.content
    .replace(/^Created At: [^\n]*\n?/, '')
    .replace(/^Completed At: [^\n]*\n?/, '')
    .trim()
  return clip(body, MAX_OUTPUT)
}

/** Normalize the measured argument names that otherwise render blank shared cards. */
export function agyToolInput(tool: string, args: JsonObject): JsonObject {
  // `toolAction`/`toolSummary` are agy's own card labels; keep them, they are useful in the expansion.
  if (tool === 'Bash' && str(args.CommandLine)) return { ...args, command: str(args.CommandLine) }
  if (tool === 'Read' && str(args.AbsolutePath)) return { ...args, file_path: str(args.AbsolutePath) }
  if (tool === 'ListDir' && str(args.DirectoryPath)) return { ...args, path: str(args.DirectoryPath) }
  if (tool === 'Grep' && str(args.Query)) return { ...args, pattern: str(args.Query) }
  if (tool === 'WebSearch' && str(args.query)) return args
  return args
}

interface PendingCall {
  id: string
  tool: string
  rawName: string
}

interface AgyTurnState {
  open: boolean
  seq: number
  /** Calls announced by the last PLANNER_RESPONSE, waiting for their result steps, in order. */
  pending: PendingCall[]
  /** Tool rows opened and not yet closed, so an interrupted turn can close them all. */
  openRows: Map<string, string>
  /**
   * Row id -> the child conversations it spawned that have not reported back yet.
   *
   * One `invoke_subagent` call spawns N children (measured: three in one call), so N report-backs
   * share ONE row. Emitting `subagent_finished` per child fired the same id three times for a row
   * already closed; the row is finished when the LAST child has reported.
   */
  subagentRows: Map<string, Set<string>>
  /** Child conversation id -> its row, so a report-back can find the row it belongs to. */
  subagentOwner: Map<string, string>
}

export function newAgyTurnState(): AgyTurnState {
  return { open: false, seq: 0, pending: [], openRows: new Map(), subagentRows: new Map(), subagentOwner: new Map() }
}

function closeRows(state: AgyTurnState, events: LiveEvent[], status: string): void {
  for (const [id, tool] of state.openRows) {
    events.push({ type: 'tool_end', payload: { id, tool, output: `Tool ${status}`, isError: status === 'failed', summary: '' } })
  }
  state.openRows.clear()
  state.pending = []
}

/** `Created the following subagents:\n{ "conversationId": "…", … }{ … }` -> the child ids. */
function subagentIds(content: string): string[] {
  return [...content.matchAll(/"conversationId":\s*"([0-9a-f-]{16,})"/gi)].map((match) => match[1])
}

/**
 * The `invoke_subagent` result is a wall of JSON — one object per child with its conversation id, a
 * `file://` transcript URI and its workspace list — and rendering it raw filled the card with machine
 * addresses nobody can act on (measured on a real three-agent run). The count is the useful part; the
 * children's work arrives as their report-backs.
 */
function subagentSummary(content: string, children: string[]): string {
  const roles = [...content.matchAll(/"role"\s*:\s*"([^"]+)"/g)].map((match) => match[1])
  const what = roles.length ? `: ${roles.join(', ')}` : ''
  return `Launched ${children.length} sub-agent${children.length === 1 ? '' : 's'}${what}`
}

/** A child's report-back arrives as `[Message] … sender=<child conversation id> … content=<text>`. */
function systemMessageSender(content: string): { sender: string; text: string } | null {
  const sender = /sender=([0-9a-f-]{16,})/i.exec(content)
  if (!sender) return null
  const text = /content=([\s\S]*)$/.exec(content)
  return { sender: sender[1], text: (text ? text[1] : '').trim() }
}

export function agyStepToEvents(step: AgyStep, state: AgyTurnState, mode: 'live' | 'replay'): LiveEvent[] {
  const events: LiveEvent[] = []

  if (step.type === 'USER_INPUT') {
    const userMessage = agyUserText(step.content)
    if (mode === 'live') {
      if (state.open) {
        closeRows(state, events, 'interrupted')
        events.push({ type: 'turn_ended', payload: {} })
      }
      state.open = true
      state.pending = []
      events.push({ type: 'turn_started', payload: { userMessage } })
    }
    events.push({ type: 'user_message', payload: { content: userMessage } })
    return events
  }

  if (step.type === 'CHECKPOINT') {
    // NOT automatically a compaction, whatever its text says.
    //
    // Every agy conversation carries exactly one `{{ CHECKPOINT 0 }}` at step 3 or 4 — measured across
    // all ten conversations on this machine, including a four-step one whose only turn was "hi". Its
    // body always claims "the earlier parts of this conversation have been truncated", because it is a
    // fixed template (`{{ CHECKPOINT %d }}` in the binary), not a report. Rendering it put a
    // "Context compacted" banner under the FIRST reply of every new agent.
    //
    // The counter is what carries the information: 0 is the routine bookkeeping record. A higher one
    // ought to be a real compaction, but no conversation here ran long enough to produce one, so that
    // branch is unverified — and an unparseable header is treated as routine, because a missing banner
    // is a far smaller error than one on every first message.
    const checkpoint = /\{\{\s*CHECKPOINT\s+(\d+)\s*\}\}/.exec(step.content)
    if (!checkpoint || checkpoint[1] === '0') return events
    // Deliberately does not touch `state.open`, and deliberately carries no body: agy's checkpoint text
    // is prompt scaffolding for itself (log paths, "this summary is just for your reference"), not
    // something a person reads. The surfaces render their own sentence for an empty message.
    events.push({ type: 'context_compact', payload: { message: '', trigger: 'auto' } })
    return events
  }

  if (step.type === 'CONVERSATION_HISTORY') return events

  if (step.type === 'SYSTEM_MESSAGE') {
    const message = systemMessageSender(step.content)
    const row = message ? state.subagentOwner.get(message.sender) : undefined
    if (message && row) {
      state.subagentOwner.delete(message.sender)
      const outstanding = state.subagentRows.get(row)
      outstanding?.delete(message.sender)
      // One row, N children: report it finished once, when the last of them has answered.
      if (outstanding && outstanding.size === 0) {
        state.subagentRows.delete(row)
        events.push({ type: 'subagent_finished', payload: { id: row, status: 'completed', summary: clip(message.text, MAX_OUTPUT) } })
      }
    }
    return events
  }

  if (step.type === 'PLANNER_RESPONSE') {
    if (step.thinking) events.push({ type: 'thinking_delta', payload: { content: clip(step.thinking, MAX_THINKING) } })
    const text = step.content.trim()
    if (text) events.push({ type: 'text_delta', payload: { content: text } })
    for (const call of step.toolCalls) {
      const tool = agyToolName(call.name)
      const id = `agy-${step.stepIndex}-${state.seq++}`
      state.pending.push({ id, tool, rawName: call.name })
      state.openRows.set(id, tool)
      events.push({ type: 'tool_start', payload: { id, tool, input: agyToolInput(tool, call.args) } })
    }
    return events
  }

  if (NON_RESULT_TYPES.has(step.type)) return events

  // Everything else is a tool RESULT, paired positionally with the call that queued it.
  const call = state.pending.shift()
  if (!call) return events
  state.openRows.delete(call.id)
  const isError = step.type === 'ERROR_MESSAGE' || (step.exitCode !== null && step.exitCode !== 0)
  const output = agyToolOutput(step)
  let cardOutput = output
  if (call.rawName === 'invoke_subagent') {
    const children = subagentIds(step.content)
    if (children.length) {
      state.subagentRows.set(call.id, new Set(children))
      for (const child of children) state.subagentOwner.set(child, call.id)
      cardOutput = subagentSummary(step.content, children)
    }
  }
  events.push({
    type: 'tool_end',
    payload: { id: call.id, tool: call.tool, output: cardOutput, isError, summary: '' },
  })
  return events
}

export class AgyNormalizer implements EngineNormalizer {
  private state = newAgyTurnState()

  get turnOpen(): boolean { return this.state.open }

  /** The `Stop` hook fired: close every row this turn opened, then the turn. */
  closeTurn(): LiveEvent[] {
    if (!this.state.open) return []
    const events: LiveEvent[] = []
    closeRows(this.state, events, 'completed')
    this.state.open = false
    this.state.subagentRows.clear()
    this.state.subagentOwner.clear()
    events.push({ type: 'turn_ended', payload: {} })
    return events
  }

  abortTurn(): LiveEvent[] {
    if (!this.state.open) return []
    const events: LiveEvent[] = []
    closeRows(this.state, events, 'failed')
    this.state.open = false
    this.state.subagentRows.clear()
    this.state.subagentOwner.clear()
    events.push({ type: 'turn_ended', payload: { aborted: true } })
    return events
  }

  ingest(line: string): LiveEvent[] {
    const step = agyStep(line)
    return step ? agyStepToEvents(step, this.state, 'live') : []
  }

  finishReplay(): LiveEvent[] { return [] }
}

export function agyMessagesToEvents(lines: string[]): SessionEvent[] {
  const state = newAgyTurnState()
  const events: SessionEvent[] = []
  for (const line of lines) {
    const step = agyStep(line)
    if (step) events.push(...agyStepToEvents(step, state, 'replay') as SessionEvent[])
  }
  events.push({ type: 'done', payload: { result: 'success' } })
  return events
}

export function lastAgyTurnText(lines: string[]): LastTurnText | null {
  let userMessage = ''
  let assistantText = ''
  for (const line of lines) {
    const step = agyStep(line)
    if (!step) continue
    if (step.type === 'USER_INPUT') {
      userMessage = agyUserText(step.content)
      assistantText = ''
    } else if (step.type === 'PLANNER_RESPONSE') {
      const text = step.content.trim()
      if (text) assistantText += `${assistantText ? '\n\n' : ''}${text}`
    }
  }
  return assistantText ? { userMessage, assistantText } : null
}
