/**
 * The wire types, as `../../spec/README.md` defines them.
 *
 * Deliberately hand-written rather than generated: a partner reading this file should be able to see
 * the entire wire surface without installing anything.
 *
 * An event is one flat, self-describing object discriminated on `kind`, and the SAME objects serve
 * both the `agent.send` stream and `agent.history` — which is why there is exactly one event
 * type here and not two.
 */

/** Content kinds. Terminal kinds are separate — see `TERMINAL_KINDS`. */
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

export interface ProviderError {
  code: ErrorCode
  message?: string
}

/**
 * One event.
 *
 * `kind` is optional ON PURPOSE: an event carrying only `text` is conformant and renders as plain
 * assistant output. That is the simplest correct implementation a partner can ship, and
 * making `kind` required here would quietly outlaw it.
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
  error?: ProviderError
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
  text?: string
  turnId?: string
}
