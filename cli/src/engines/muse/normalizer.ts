/**
 * Muse Code JSONL → shared event vocabulary.
 *
 * Muse writes one append-only JSONL per session, but the layout is DATE-SHARDED rather than keyed by
 * project: `<MUSE_HOME>/sessions/YYYY/MM/DD/<session-uuid>/session.jsonl`, with sub-agents one level
 * deeper under `subagent/<child-uuid>/`. Nothing in the path names the project — the only link is
 * `workspace_root`, carried in the FIRST record. That is why this engine is discovered by scanning
 * rather than announced by a hook (measured: muse's hooks do not fire, in `exec` or in the TUI).
 *
 * Every line shares one envelope:
 *
 *   {schema_version, id, stream:{kind,id}, sequence, recorded_at, record_type,
 *    payload_type, payload:{kind, event?…}}
 *
 * `recorded_at` is MICROseconds. `payload_type` is mostly the useless constant `runtime.session`; the
 * real discriminator is `payload.event.kind`, of which a real session carries 27 distinct values.
 *
 * The six that matter, verified against a real session (muse 0.1.0-R708.1, 188 records) — note the
 * bundled `read-session` skill documents a DIFFERENT name for the first one (`user_prompt_display`),
 * which never appears on disk:
 *
 *   started                        {prompt}                      ← the user asked; opens a turn
 *   reasoning_committed            {text}                        → thinking
 *   assistant_message_committed    {message_id, response_id, text}
 *   assistant_tool_calls_committed {tool_calls:[{id, call_id, name, args}]}   args is a JSON *string*
 *   tool_result_batch_committed    {batch_id, results:[{tool_call_index, tool_call_id, text}]}
 *   terminal                       {terminal, reason, turn_duration_ms}      ← closes the turn
 *
 * Tool calls pair by `call_id` ↔ `results[].tool_call_id`. A failed turn carries the provider error in
 * `terminal.reason` (seen live: `API error 402 … Billing verification failed`), so unlike engines whose
 * failures are silent, no log tailing is needed to notice one.
 */

import type { EngineNormalizer } from '../types.js'
import type { LastTurnText, LiveEvent, SessionEvent } from '../../lib/normalize.js'

type JsonObject = Record<string, unknown>

const MAX_OUTPUT = 2_000
const MAX_THINKING = 500

/** Muse's tool names → the vocabulary the web/device cards already render. */
const TOOL_NAMES: Record<string, string> = {
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  bash: 'Bash',
  shell: 'Bash',
  grep: 'Grep',
  glob: 'Glob',
  list_dir: 'LS',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  // MEASURED from real sessions (`assistant_tool_calls_committed.tool_calls[].name`), not guessed from
  // what other CLIs call the same thing — muse's names differ from every one of them.
  //
  // The planning tool MUST land on the exact string `TodoWrite`: the device builds its checklist by
  // matching that name literally, so a near-miss shows no list at all and reports no error.
  write_todos: 'TodoWrite',
  // Delegation is three tools, not one: spawn starts a child, wait blocks on it, read pulls its result.
  // Only the spawn opens a sub-agent row; the other two are ordinary cards about that child.
  subagent_spawn: 'Task',
  subagent_wait: 'TaskWait',
  subagent_read_result: 'TaskResult',
  // Asking the user belongs on its own screen, not in the tool feed — the shared name routes it there.
  request_user_input: 'AskUserQuestion',
}

export function museToolName(name: string): string {
  return TOOL_NAMES[name] ?? (name ? name.charAt(0).toUpperCase() + name.slice(1) : 'Tool')
}

function obj(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

/** One record's event plus the SCOPE it belongs to. */
export interface MuseRecord {
  /** `payload.kind` — `run`, `task`, `tool_batch_effect`, … */
  scope: string
  event: JsonObject
}

/**
 * The `payload.event` of one record, or null for the envelopes that carry no event.
 *
 * The scope comes with it, and it is load-bearing: `run` and `task` are DIFFERENT lifecycles that share
 * event names. Both emit `started`, and only a run's is a turn — a `task.started` is scheduler
 * bookkeeping and several fire inside one run. This used to drop `payload.kind`, which left `started`
 * ambiguous; the only thing separating the two was that a task carries no prompt. That held right up
 * until a SCHEDULED run arrived — a real turn whose prompt is empty, because nobody typed anything.
 */
export function museEvent(line: string): MuseRecord | null {
  let raw: JsonObject | null
  try { raw = obj(JSON.parse(line)) } catch { return null }
  if (!raw) return null
  const payload = obj(raw.payload)
  if (!payload) return null
  const event = obj(payload.event)
  if (!event || !str(event.kind)) return null
  return { scope: str(payload.kind), event }
}

/** `workspace_root` from a session's first record — the only thing tying a session to a directory. */
export function museWorkspaceRoot(firstLine: string): string | null {
  let raw: JsonObject | null
  try { raw = obj(JSON.parse(firstLine)) } catch { return null }
  const record = obj(obj(raw?.payload)?.record)
  const root = str(record?.workspace_root)
  return root || null
}

export interface MuseTurnState {
  open: boolean
  /** call_id → tool name, so a result can be reported under the name that opened it. */
  toolNames: Map<string, string>
  /** `subagent_id` → the tool_start id of its sub-agent row, learned from the SPAWN'S RESULT. */
  subagentRows: Map<string, string>
  /** Rows opened this turn and not yet closed. A row left open holds `turn_ended` forever. */
  openRows: Set<string>
  pendingTools: Set<string>
  thinkingCounter: number
}

export function newMuseTurnState(): MuseTurnState {
  return {
    open: false, toolNames: new Map(), subagentRows: new Map(), openRows: new Set(),
    pendingTools: new Set(), thinkingCounter: 0,
  }
}

/** A sub-agent tool's result text is itself JSON (`{status, subagent_id, …}`). */
function resultBody(text: string): JsonObject | null {
  try { return obj(JSON.parse(text)) } catch { return null }
}

/** One record → events. `mode: 'replay'` emits `user_message` instead of deriving the turn lifecycle. */
export function museEventToEvents(record: MuseRecord, state: MuseTurnState, mode: 'live' | 'replay'): LiveEvent[] {
  const { scope, event } = record
  const kind = str(event.kind)
  const events: LiveEvent[] = []

  if (kind === 'started') {
    // ONLY a run start is a turn. `task.started` fires several times inside a single run — taking it for
    // a turn would open, and immediately re-open, one per task.
    if (scope !== 'run') return []
    const prompt = str(event.prompt).trim()
    // An EMPTY prompt is normal and still opens the turn: a SCHEDULED run has no typed message, because
    // the scheduler triggered it rather than a person. Bailing here is why a reminder's output never
    // reached the device — no turn opened, so the assistant text belonged to nothing and `terminal`
    // closed a turn that was never there. Replay is the exception: an empty prompt would draw an empty
    // user bubble, so it contributes no message and simply renders the assistant side.
    if (mode === 'replay') return prompt ? [{ type: 'user_message', payload: { content: prompt } }] : []
    if (state.open) events.push({ type: 'turn_ended', payload: {} })
    state.open = true
    state.pendingTools.clear()
    events.push({ type: 'turn_started', payload: { userMessage: prompt } })
    return events
  }

  if (kind === 'reasoning_committed') {
    const text = str(event.text).trim()
    if (!text) return []
    return [{
      type: 'thinking_delta',
      payload: { content: clip(text, MAX_THINKING), thinkingId: `thinking-muse-${state.thinkingCounter++}` },
    }]
  }

  if (kind === 'assistant_message_committed') {
    const text = str(event.text)
    return text ? [{ type: 'text_delta', payload: { content: text } }] : []
  }

  if (kind === 'assistant_tool_calls_committed') {
    const calls = Array.isArray(event.tool_calls) ? event.tool_calls : []
    for (const entry of calls) {
      const call = obj(entry)
      if (!call) continue
      const id = str(call.call_id) || str(call.id)
      if (!id) continue
      const tool = museToolName(str(call.name))
      state.toolNames.set(id, tool)
      state.pendingTools.add(id)
      // `args` arrives as a JSON string; hand the parsed object over so the cards can show real
      // arguments rather than a quoted blob.
      let input: unknown = str(call.args)
      try { input = JSON.parse(str(call.args)) } catch { /* keep the raw string */ }
      const args = obj(input) ?? {}
      // The device reads `input.todos[{content|subject, status}]` literally. Muse names the field `text`
      // (measured: {"todos":[{"text":"…","status":"in_progress"}]}), so without this reshape the tool
      // name matches, the card renders — and the checklist is silently empty.
      if (tool === 'TodoWrite' && Array.isArray(args.todos)) {
        input = {
          ...args,
          todos: args.todos.map((entry) => {
            const todo = obj(entry) ?? {}
            return { ...todo, content: str(todo.content) || str(todo.text) || str(todo.subject) }
          }),
        }
      }
      // A spawn's arguments name the child (`task_name`/`role`) but NOT its id. MEASURED: the id is
      // handed back in the spawn's RESULT (`{"status":"accepted","subagent_id":…}`), so the row can only
      // be tied to a child once that result arrives — see the result branch below.
      if (tool === 'Task') {
        state.openRows.add(id)
        // `description` is what the sub-agent row shows; muse calls it task_name.
        input = { ...args, description: str(args.task_name) || str(args.role) || 'sub-agent' }
      }
      events.push({ type: 'tool_start', payload: { id, tool, input } })
    }
    return events
  }

  if (kind === 'tool_result_batch_committed') {
    const results = Array.isArray(event.results) ? event.results : []
    for (const entry of results) {
      const result = obj(entry)
      if (!result) continue
      const id = str(result.tool_call_id)
      if (!id) continue
      const tool = state.toolNames.get(id) ?? 'Tool'
      state.toolNames.delete(id)
      state.pendingTools.delete(id)
      const output = str(result.text)
      const isError = result.is_error === true
      // The spawn's result is where the child's id is revealed — and where a spawn can be turned down
      // outright (`{"status":"rejected","reason":"command_id_reused"}`). A rejected spawn never runs, so
      // its row must close here or it holds the turn open for a child that does not exist.
      if (tool === 'Task') {
        const body = resultBody(output)
        const child = str(body?.subagent_id)
        if (str(body?.status) === 'accepted' && child) state.subagentRows.set(child, id)
        else if (state.openRows.delete(id)) {
          events.push({ type: 'subagent_finished', payload: { id, status: 'failed' } })
        }
      }
      // MEASURED: `subagent_wait` returning `{"status":"ready", …, "summary":…}` is muse's "this child is
      // done" signal. `subagent_read_result` — which an earlier reading of the tool list assumed was the
      // completion marker — is never called at all in real sessions.
      if (tool === 'TaskWait') {
        const body = resultBody(output)
        const rowId = state.subagentRows.get(str(body?.subagent_id))
        if (rowId && str(body?.status) === 'ready' && state.openRows.delete(rowId)) {
          state.subagentRows.delete(str(body?.subagent_id))
          events.push({ type: 'subagent_finished', payload: { id: rowId, status: 'completed' } })
        }
      }
      events.push({
        type: 'tool_end',
        payload: { id, tool, output: clip(output, MAX_OUTPUT), isError, summary: isError ? 'error' : '' },
      })
    }
    return events
  }

  if (kind === 'terminal') {
    if (mode === 'replay' || !state.open) return []
    state.open = false
    state.pendingTools.clear()
    // Muse spawns children it never waits on (measured: 7 spawns, 4 waits in one session), and the main
    // turn ends anyway. `turn_ended` is HELD while any sub-agent row is open, so a row nobody closed
    // pins the device tile on "Processing" forever with no recap — the exact bug this backstop fixes.
    for (const rowId of state.openRows) {
      events.push({ type: 'subagent_finished', payload: { id: rowId, status: 'completed' } })
    }
    state.openRows.clear()
    state.subagentRows.clear()
    // A failed turn is not a finished one: the device must clear its tile without a recap of nothing,
    // and the reason muse puts here is the provider's own error text.
    const failed = str(event.terminal) === 'failed'
    events.push({ type: 'turn_ended', payload: failed ? { aborted: true } : {} })
    return events
  }

  return []
}

/** Live tail: one JSONL line → events. */
export class MuseNormalizer implements EngineNormalizer {
  private state = newMuseTurnState()

  get turnOpen(): boolean { return this.state.open }

  closeTurn(): void {
    this.state.open = false
    this.state.pendingTools.clear()
    // Same reason as the `terminal` backstop: a row left open outlives the turn and holds the tile busy.
    this.state.openRows.clear()
    this.state.subagentRows.clear()
  }

  ingest(line: string): LiveEvent[] {
    const record = museEvent(line)
    return record ? museEventToEvents(record, this.state, 'live') : []
  }

  finishReplay(): LiveEvent[] {
    return []
  }
}

/** Full-session replay (`session_get`) — the same render path as the live stream. */
export function museMessagesToEvents(lines: string[]): SessionEvent[] {
  const state = newMuseTurnState()
  const events: SessionEvent[] = []
  for (const line of lines) {
    const record = museEvent(line)
    if (record) events.push(...museEventToEvents(record, state, 'replay') as SessionEvent[])
  }
  events.push({ type: 'done', payload: { result: 'success' } })
  return events
}

/** Last user prompt + the assistant text that followed it — the recap's source of truth. */
export function lastMuseTurnText(lines: string[]): LastTurnText | null {
  let userMessage = ''
  let assistantText = ''
  for (const line of lines) {
    const record = museEvent(line)
    if (!record) continue
    const event = record.event
    const kind = str(event.kind)
    if (kind === 'started' && record.scope === 'run') {
      // Reset on EVERY run start, prompt or not. Keying the reset on a non-empty prompt meant a series of
      // scheduled runs never reset it, so the recap of the 4th five-minute reminder carried all four
      // answers glued together instead of the latest one.
      userMessage = str(event.prompt).trim()
      assistantText = ''
    } else if (kind === 'assistant_message_committed') {
      const text = str(event.text).trim()
      if (text) assistantText += `${assistantText ? '\n\n' : ''}${text}`
    }
  }
  return assistantText ? { userMessage, assistantText } : null
}
