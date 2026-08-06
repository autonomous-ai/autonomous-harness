/**
 * The wire types, as `../../spec/README.md` defines them.
 *
 * Deliberately hand-written rather than generated: a partner reading this file should be able to see
 * the entire wire surface without installing anything. Kept in step with
 * `reference-provider/src/types.ts` by hand rather than shared through a package, so that copying
 * this directory gives you something that compiles on its own.
 */

export const EVENT_KINDS = [
  'turn_started',
  'user_message',
  'thinking_title',
  'thinking_delta',
  'text_delta',
  'tool_start',
  'tool_end',
  'context_compact',
  'done',
  'recap_start',
  'recap_end',
] as const

/** Exactly ONE of these ends every stream. */
export const TERMINAL_KINDS = ['turn_completed', 'turn_failed', 'turn_cancelled', 'turn_input_required'] as const

export type EventKind = (typeof EVENT_KINDS)[number] | (typeof TERMINAL_KINDS)[number]

export const isTerminalKind = (kind: string | undefined): boolean =>
  !!kind && (TERMINAL_KINDS as readonly string[]).includes(kind)

/** Codes are STRINGS, and `unauthenticated` is its own so the UI can say the right sentence. */
export type ErrorCode =
  | 'unauthenticated'
  | 'not_found'
  | 'unsupported'
  | 'invalid_request'
  | 'rate_limited'
  | 'internal'

export interface ProviderErrorBody {
  code: ErrorCode
  message?: string
}

/**
 * One event: flat, self-describing, and readable without the events before it.
 *
 * `kind` is optional ON PURPOSE — an event carrying only `text` is conformant and renders as plain
 * assistant output. The same objects serve the live stream and `agent.history`,
 * which is why there is one event type here and not two.
 */
export interface ProviderEvent {
  kind?: EventKind
  text?: string
  turnId?: string
  agentId?: string
  at?: string
  title?: string
  thinkingId?: string
  toolId?: string
  tool?: string
  input?: unknown
  ok?: boolean
  output?: string
  summary?: string
  durationSeconds?: number
  recap?: string
  prompt?: string
  error?: ProviderErrorBody
}

export interface Agent {
  id: string
  name: string
  description?: string
}

/** JSON-RPC 2.0 — the only envelope, on one URL. */
export interface RpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

export interface RecapEntry {
  recap: string
  body?: string
  turnId?: string
}
