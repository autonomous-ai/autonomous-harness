/**
 * Amp JSONL → shared event vocabulary.
 *
 * The JSONL this reads is not Amp's — Amp keeps NO conversation on disk. Threads live on its server; the
 * only local artefacts are `session.json` and a debug log that records `blockCount` and `frameLength` and
 * not one character of message text (measured across two real sessions, 380 and 93k lines). So the
 * adapter's own plugin (see `installAmpPlugin`) writes the transcript, and this parses it.
 *
 * That makes the record vocabulary ours, and small:
 *
 *   session     {threadId, cwd}            ← first line; `cwd` is what re-binds the session after a restart
 *   turn_start  {id, message}              ← the user asked; opens a turn
 *   text        {id, i, text}              ← assistant prose, one record per block
 *   thinking    {id, i, text}
 *   tool_call   {id, tool, input}
 *   tool_result {id, tool, status, output} ← status is 'done' | 'error' | 'cancelled'
 *   turn_end    {id, status}               ← closes the turn; a non-'done' status is a failed turn
 *
 * Tool calls pair by `id` (Amp's `toolUseID`), which both records carry verbatim.
 *
 * Two measured absences shape what this can render, and neither is a bug to be fixed here:
 *
 *   - **Amp has no planning/todo tool.** The tool list a real session advertises has 33 entries and none
 *     of them writes a checklist (the agent says so itself when asked). Nothing maps to `TodoWrite`, so
 *     the device checklist stays empty for Amp — an absence, not a mis-mapping.
 *   - **Amp has no ask-the-user tool.** What looks like a question is the permission prompt, drawn in the
 *     TUI and recorded nowhere at all — not in the thread log, not in the export. It is read off the pane
 *     instead; see `askQuestion.ts`.
 */

import type { EngineNormalizer } from '../types.js'
import type { LastTurnText, LiveEvent, SessionEvent } from '../../lib/normalize.js'

type JsonObject = Record<string, unknown>

const MAX_OUTPUT = 2_000
const MAX_THINKING = 500

/**
 * Amp's tool names → the vocabulary the web/device cards already render.
 *
 * MEASURED from a real session's `system/init` tool list and from live `tool.call` events — not carried
 * over from another engine, because Amp's names match no other CLI's. Only tools whose behaviour was
 * actually observed are mapped; the rest fall through to the title-cased default on purpose. Guessing
 * that `finder` is a Glob or `oracle` an Agent would put a wrong card on screen and report nothing.
 */
const TOOL_NAMES: Record<string, string> = {
  // The one tool Amp actually reads and writes files with in a normal turn — measured: asked to read a
  // file, it runs `cat` through this rather than through any read tool.
  shell_command: 'Bash',
  // The thread log spells the same tool `async_shell_command` while the wire calls it `shell_command`.
  // Both are mapped so a rename on either side cannot silently drop the card.
  async_shell_command: 'Bash',
  shell_command_status: 'BashOutput',
  apply_patch: 'Edit',
  web_search: 'WebSearch',
  read_web_page: 'WebFetch',
  // Amp's sub-agent tool already carries the shared name — and its own display map confirms the meaning
  // ("Task" → "Subagent"). MEASURED end to end: `Task` fires as an ordinary client tool whose RESULT is
  // the child's answer, so the row opens on tool_start and closes on tool_end. Nothing here needs to emit
  // `subagent_finished`, and no row is left holding `turn_ended` open the way muse's did.
  Task: 'Task',
  // The rest come from Amp's OWN display-name table, found in the binary — not from analogy with another
  // engine. None appeared in the 33 tools a medium-mode session advertises, so they are either legacy or
  // gated behind a mode or integration this machine has not seen. Mapping them costs nothing and closes
  // the gap in advance; leaving them out would be the silent-blank-card failure all over again.
  run_terminal_command: 'Bash',
  read_file: 'Read',
  ripgrep: 'Grep',
  Glob: 'Glob',
  write_file: 'Write',
  create_file: 'Write',
  edit_file: 'Edit',
  // Amp calls these "Read TODOs"/"Update TODOs". `todo_write` MUST land on exactly `TodoWrite`: the
  // device builds its checklist by matching that string literally. Amp does not expose the tool today —
  // asked for a todo list, it wrote a numbered list in PROSE and used no tool at all (measured on a real
  // pane) — so the checklist stays empty by absence, not by a mis-mapping.
  todo_write: 'TodoWrite',
  todo_read: 'TodoRead',
}

/**
 * Amp's tool arguments → the field names the shared cards already read.
 *
 * The consumers are not the place to learn an engine's spelling. Web renders `WebSearch` from `query`
 * (or cursor's `search_term`) and Amp sends neither — it sends `{objective, search_queries}` — so a real
 * search drew as `Web Search("")`, a card admitting a search happened and refusing to say what for. The
 * fix belongs HERE, exactly as muse's `TodoWrite` is reshaped so `input.todos[].content` matches: one
 * engine adapts once, instead of every surface learning every engine.
 *
 * The original keys are kept alongside, so the expanded card still shows what Amp was actually given.
 */
export function ampToolInput(tool: string, input: unknown): unknown {
  const args = obj(input)
  if (!args) return input ?? {}
  if (tool === 'WebSearch' && !str(args.query)) {
    const queries = Array.isArray(args.search_queries)
      ? args.search_queries.filter((q): q is string => typeof q === 'string').join(', ')
      : ''
    const query = str(args.objective).trim() || queries
    if (query) return { ...args, query }
  }
  return args
}

export function ampToolName(name: string): string {
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

/** One parsed record, or null for a line that is not one. */
export function ampRecord(line: string): JsonObject | null {
  let raw: JsonObject | null
  try { raw = obj(JSON.parse(line)) } catch { return null }
  if (!raw || !str(raw.t)) return null
  return raw
}

/** `cwd` from the session record — the link between a thread and a directory. */
export function ampWorkspaceRoot(firstLine: string): string | null {
  const record = ampRecord(firstLine)
  if (!record || str(record.t) !== 'session') return null
  return str(record.cwd) || null
}

/**
 * A tool result's output, as text.
 *
 * Amp's `output` is never a plain string, and it has THREE shapes, all measured:
 *
 *   {content:[{type:'text',text:…}]}          tools that return prose (skill)
 *   {output:'hello\n',exitCode:0}             shell
 *   {result:[{url,title,excerpts:[…]}],status} the SERVER-run tools, web_search among them
 *
 * The third one matters most on screen: a web search returns whole scraped pages, and rendering its JSON
 * put thousands of characters of site chrome on a card where a list of sources belonged. It is reduced to
 * `title — url` lines here, which is what the result actually says.
 */
/** `[{title,url,excerpts}]` → one `title — url` line each, or '' if that is not what this is. */
function searchHits(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const lines = value
    .map((entry) => {
      const hit = obj(entry)
      if (!hit) return ''
      const title = str(hit.title).trim()
      const url = str(hit.url).trim()
      return title && url ? `${title} — ${url}` : title || url
    })
    .filter(Boolean)
  return lines.length ? lines.join('\n') : ''
}

export function ampToolOutput(output: unknown): string {
  if (typeof output === 'string') {
    // The same search result reaches us two ways and only one of them is an object: the `tool.result`
    // EVENT hands over a JSON *string* holding `[{title,url,excerpts}]` (measured), while the message
    // block hands over `{result:[…]}`. Unparsed, the card showed a wall of scraped page text.
    try {
      const hits = searchHits(JSON.parse(output))
      if (hits) return hits
    } catch { /* an ordinary string, which is the common case */ }
    return output
  }
  // A BARE array of hits, which is what the export's `run.result` holds. `obj()` rejects arrays, so
  // without this the card fell through to JSON.stringify and showed whole scraped pages.
  const bare = searchHits(output)
  if (bare) return bare
  const body = obj(output)
  if (!body) return output === undefined || output === null ? '' : JSON.stringify(output)
  const content = body.content
  if (Array.isArray(content)) {
    const text = content
      .map((entry) => str(obj(entry)?.text))
      .filter(Boolean)
      .join('\n')
    if (text) return text
  }
  if (typeof body.output === 'string') return body.output
  const hits = searchHits(body.result)
  if (hits) return hits
  return JSON.stringify(body)
}

export interface AmpTurnState {
  open: boolean
  /** Replay only: a `turn_start` was seen for the turn now being read. */
  sawStart: boolean
  /** tool id → the name it opened under, so the result reports the same one. */
  toolNames: Map<string, string>
  pendingTools: Set<string>
  thinkingCounter: number
}

export function newAmpTurnState(): AmpTurnState {
  return { open: false, sawStart: false, toolNames: new Map(), pendingTools: new Set(), thinkingCounter: 0 }
}

/** One record → events. `mode: 'replay'` emits `user_message` instead of deriving the turn lifecycle. */
export function ampRecordToEvents(record: JsonObject, state: AmpTurnState, mode: 'live' | 'replay'): LiveEvent[] {
  const kind = str(record.t)
  const events: LiveEvent[] = []

  if (kind === 'turn_start') {
    const prompt = str(record.message).trim()
    if (mode === 'replay') {
      state.sawStart = true
      return prompt ? [{ type: 'user_message', payload: { content: prompt } }] : []
    }
    // A turn already open means the previous one never closed — close it rather than nest, so the tile
    // cannot be left spinning by a turn whose end was missed.
    if (state.open) events.push({ type: 'turn_ended', payload: {} })
    state.open = true
    state.pendingTools.clear()
    events.push({ type: 'turn_started', payload: { userMessage: prompt } })
    return events
  }

  // A turn whose `agent.start` never fired still has to render.
  //
  // MEASURED: a prompt submitted while Amp is still connecting is QUEUED, and the queued message is
  // dispatched WITHOUT an `agent.start` event — the captured transcript held `session`, then `thinking`,
  // `tool_call`, `tool_result`, `text` and a `turn_end` whose message id matched no start at all. Without
  // this backstop that whole turn is invisible: nothing opens it, and `turn_end` is then dropped below
  // because no turn is open, so the answer never reaches web or device.
  //
  // The prompt text is genuinely unknown here (it is the one thing the event would have carried), so the
  // turn opens with an empty message rather than a guessed one.
  if (mode === 'live' && !state.open && (kind === 'thinking' || kind === 'text' || kind === 'tool_call')) {
    state.open = true
    events.push({ type: 'turn_started', payload: { userMessage: '' } })
  }

  if (kind === 'thinking') {
    const text = str(record.text).trim()
    if (text) {
      events.push({
        type: 'thinking_delta',
        payload: { content: clip(text, MAX_THINKING), thinkingId: `thinking-amp-${state.thinkingCounter++}` },
      })
    }
    return events
  }

  if (kind === 'text') {
    const text = str(record.text)
    if (text) events.push({ type: 'text_delta', payload: { content: text } })
    return events
  }

  if (kind === 'tool_call') {
    const id = str(record.id)
    if (!id) return events
    const tool = ampToolName(str(record.tool))
    state.toolNames.set(id, tool)
    state.pendingTools.add(id)
    events.push({ type: 'tool_start', payload: { id, tool, input: ampToolInput(tool, record.input) } })
    return events
  }

  if (kind === 'tool_result') {
    const id = str(record.id)
    if (!id) return events
    const tool = state.toolNames.get(id) ?? ampToolName(str(record.tool))
    state.toolNames.delete(id)
    state.pendingTools.delete(id)
    const output = ampToolOutput(record.output)
    // Amp reports the outcome as a word, not a flag: 'done' | 'error' | 'cancelled' (measured).
    const status = str(record.status)
    const isError = status === 'error' || status === 'cancelled'
    events.push({
      type: 'tool_end',
      payload: { id, tool, output: clip(output, MAX_OUTPUT), isError, summary: isError ? status : '' },
    })
    return events
  }

  if (kind === 'turn_end') {
    if (mode === 'replay') return []
    if (!state.open) return []
    state.open = false
    state.pendingTools.clear()
    // 'error' and 'cancelled' are both turns that produced no answer. Marking them aborted clears the
    // device tile without asking a recap worker to summarise nothing.
    const failed = str(record.status) !== 'done'
    events.push({ type: 'turn_ended', payload: failed ? { aborted: true } : {} })
    return events
  }

  return []
}

/** Live tail: one JSONL line → events. */
export class AmpNormalizer implements EngineNormalizer {
  private state = newAmpTurnState()

  get turnOpen(): boolean { return this.state.open }

  closeTurn(): void {
    this.state.open = false
    this.state.pendingTools.clear()
  }

  ingest(line: string): LiveEvent[] {
    const record = ampRecord(line)
    return record ? ampRecordToEvents(record, this.state, 'live') : []
  }

  finishReplay(): LiveEvent[] {
    return []
  }
}

/**
 * Where each turn begins, for the turns that never announced themselves.
 *
 * A prompt queued while Amp is connecting arrives with no `agent.start`, so its turn has no `turn_start`
 * record and history opened straight into an answer with nothing showing what was asked. `turn_end`
 * carries that prompt — but emitting it there would print the question AFTER its answer, so this finds
 * the first record of each such turn and the caller injects the user message in front of it.
 */
function recoveredPrompts(records: JsonObject[]): Map<number, string> {
  const out = new Map<number, string>()
  let first = -1        // first record of the turn being scanned
  let sawStart = false
  for (let i = 0; i < records.length; i++) {
    const kind = str(records[i].t)
    if (kind === 'session') continue
    if (first < 0) first = i
    if (kind === 'turn_start') sawStart = true
    if (kind === 'turn_end') {
      const prompt = str(records[i].message).trim()
      if (!sawStart && prompt) out.set(first, prompt)
      first = -1
      sawStart = false
    }
  }
  return out
}

/** Full-session replay (`session_get`) — the same render path as the live stream. */
export function ampMessagesToEvents(lines: string[]): SessionEvent[] {
  const state = newAmpTurnState()
  const records = lines.map(ampRecord).filter((r): r is JsonObject => r !== null)
  const recovered = recoveredPrompts(records)
  const events: SessionEvent[] = []
  records.forEach((record, i) => {
    const prompt = recovered.get(i)
    if (prompt) events.push({ type: 'user_message', payload: { content: prompt } })
    events.push(...ampRecordToEvents(record, state, 'replay') as SessionEvent[])
  })
  events.push({ type: 'done', payload: { result: 'success' } })
  return events
}

/** Last user prompt + the assistant text that followed it — the recap's source of truth. */
export function lastAmpTurnText(lines: string[]): LastTurnText | null {
  let userMessage = ''
  let assistantText = ''
  for (const line of lines) {
    const record = ampRecord(line)
    if (!record) continue
    const kind = str(record.t)
    if (kind === 'turn_start') {
      userMessage = str(record.message).trim()
      assistantText = ''
    } else if (kind === 'text') {
      const text = str(record.text).trim()
      if (text) assistantText += `${assistantText ? '\n\n' : ''}${text}`
    }
  }
  return assistantText ? { userMessage, assistantText } : null
}
