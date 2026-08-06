/**
 * Devin CLI (devin.ai, Cognition) SQLite rows → shared event vocabulary.
 *
 * Devin keeps history in `<DEVIN_HOME>/sessions.db` (WAL) rather than a transcript file, so it is polled
 * like opencode/hermes (see `./reader.ts`). Two properties of that store shape this module — both
 * verified against real captured sessions (devin 3000.2.17):
 *
 * 1. **Each `message_nodes.chat_message` maps 1:1 onto Claude's content blocks**, so instead of
 *    re-implementing a normalizer we reshape a row into the Claude raw shape and hand it to the existing,
 *    battle-tested `lineToEvents`/`messagesToEvents` (`src/lib/normalize.ts`) — which already do thinking
 *    ids, tool-name tracking, `tool_result`→`tool_end` joining, truncation and tool summaries:
 *
 *      {"message_id":"…","role":"user"|"assistant"|"tool"|"system","content":"…",
 *       "thinking":{"thinking":"…"}, "tool_call_id":"call_…",
 *       "tool_calls":[{"id":"call_…","name":"exec","arguments":{…},"index":0,"kind":"function"}],
 *       "metadata":{"finish_reason":"tool_calls"|"stop", …}}
 *
 *    `metadata.finish_reason` is authoritative, so unlike Command Code nothing has to be synthesized:
 *    `tool_calls` continues the turn, anything else ends it.
 *
 * 2. **Rows repeat.** `message_nodes` is a forest — Devin re-persists the whole prompt chain as fresh
 *    `node_id`s on every inference, so one user prompt showed up 4× and its reply 2× across 29 raw rows
 *    (6 real messages). `message_id` is stable across those copies and is the dedupe key; the reader must
 *    never tail `row_id` alone or the mirror repeats every message.
 */

import {
  lastTurnTextFromRawLines,
  lineToEvents,
  messagesToEvents,
  type LastTurnText,
  type LiveEvent,
  type SessionEvent,
  type TurnState,
} from '../../lib/normalize.js'

/** One deduped row of `message_nodes`, as returned by `readDevinMessages`. */
export interface DvMessage {
  rowId: number
  messageId: string
  role: string
  content: string
  thinking: string | null
  /** Raw JSON text of the `tool_calls` array, straight out of `json_extract`. */
  toolCalls: string | null
  toolCallId: string | null
  finishReason: string | null
  /** `metadata.created_at` (RFC3339 UTC) — lets the reader tell a log failure apart from an older one. */
  createdAt?: string | null
}

/** Devin tool ids → the vocabulary the web/device cards render. */
const TOOL_NAMES: Record<string, string> = {
  exec: 'Bash',
  shell_command: 'Bash',
  get_output: 'Bash',
  kill_shell: 'Bash',
  write_to_process: 'Bash',
  read: 'Read',
  notebook_read: 'Read',
  read_subagent: 'Read',
  write: 'Write',
  edit: 'Edit',
  apply_patch: 'Edit',
  notebook_edit: 'Edit',
  find_file_by_name: 'Glob',
  grep: 'Grep',
  web_search: 'WebSearch',
  webfetch: 'WebFetch',
  todo_write: 'TodoWrite',
  update_plan: 'TodoWrite',
  run_subagent: 'Task',
  skill: 'Task',
  ask_user_question: 'AskUserQuestion',
  exit_plan_mode: 'ExitPlanMode',
}

export function devinToolName(name: string): string {
  const key = (name || '').toLowerCase()
  if (TOOL_NAMES[key]) return TOOL_NAMES[key]
  if (!name) return 'tool'
  // `mcp_call_tool` and any new/unmapped tool: snake_case → TitleCase so the card still reads well.
  return name.split('_').filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('')
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** `tool_calls` JSON text → Claude `tool_use` blocks (tool ids mapped to the shared vocabulary). */
function toolUseBlocks(toolCalls: string | null): unknown[] {
  if (!toolCalls) return []
  let parsed: unknown
  try { parsed = JSON.parse(toolCalls) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((entry) => {
    const call = object(entry)
    if (!call) return []
    const name = str(call.name)
    return [{
      type: 'tool_use',
      id: str(call.id) || `devin-${str(call.index)}`,
      name: devinToolName(name),
      input: object(call.arguments) ?? {},
    }]
  })
}

/**
 * One Devin row → one Claude-shaped raw line (or null for system prefix / unknown roles).
 * Exported for tests; the live reader and the replay/recap helpers all funnel through it.
 */
export function reshapeMessage(msg: DvMessage): string | null {
  const common = { uuid: msg.messageId, timestamp: undefined }

  if (msg.role === 'user') {
    return JSON.stringify({
      ...common,
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: msg.content }] },
    })
  }
  // A tool result is a role:"user" message carrying only a tool_result block — Claude's path turns that
  // into tool_end and never mistakes it for a prompt.
  if (msg.role === 'tool') {
    if (!msg.toolCallId) return null
    return JSON.stringify({
      ...common,
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.toolCallId,
          content: [{ type: 'text', text: msg.content }],
        }],
      },
    })
  }
  if (msg.role === 'assistant') {
    const content: unknown[] = []
    if (msg.thinking) content.push({ type: 'thinking', thinking: msg.thinking, signature: '' })
    if (msg.content) content.push({ type: 'text', text: msg.content })
    content.push(...toolUseBlocks(msg.toolCalls))
    return JSON.stringify({
      ...common,
      type: 'assistant',
      message: {
        role: 'assistant',
        content,
        stop_reason: msg.finishReason === 'tool_calls' ? 'tool_use' : 'end_turn',
      },
    })
  }
  return null // system prefix, and any future role
}

function reshapeAll(messages: DvMessage[]): string[] {
  const out: string[] = []
  for (const msg of messages) {
    const line = reshapeMessage(msg)
    if (line) out.push(line)
  }
  return out
}

/** Live path: one row → events, advancing the shared Claude turn state. */
export function devinMessageToEvents(msg: DvMessage, state: TurnState): LiveEvent[] {
  const line = reshapeMessage(msg)
  return line ? lineToEvents(line, state) : []
}

/** True when this row closes the turn (assistant finished without calling tools). */
export function isDevinTurnEnd(msg: DvMessage): boolean {
  return msg.role === 'assistant' && msg.finishReason !== 'tool_calls'
}

/** Full-session replay (session_get) — same render path as the live stream. */
export function devinMessagesToEvents(messages: DvMessage[]): SessionEvent[] {
  return messagesToEvents(reshapeAll(messages))
}

/** Last user prompt + the assistant text that followed it — the recap source of truth. */
export function lastDevinTurnText(messages: DvMessage[]): LastTurnText | null {
  return lastTurnTextFromRawLines(reshapeAll(messages))
}

/**
 * Turn-snapped pagination window for `session_get {limit, before}`; cursor `devin:<index>`.
 * The window start snaps back to a user prompt so a turn is never split (replay is stateful: a
 * tool_use's name must still be known when its tool_result renders).
 */
export function windowDevinMessages(
  messages: DvMessage[],
  opts: { limit: number; before?: string },
): { window: DvMessage[]; hasMore: boolean; oldestCursor: string | null; staleCursor?: boolean } {
  let endIndex = messages.length
  if (opts.before) {
    const match = /^devin:(\d+)$/.exec(opts.before)
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
    oldestCursor: `devin:${start}`,
  }
}
