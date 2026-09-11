/**
 * Autonomous provider protocol client — the eight methods a `provider` machine speaks.
 *
 * JSON-RPC 2.0 over HTTPS POST, with SSE for the turn stream. There is **no WebSocket and nothing
 * long-lived**: a turn is one HTTP request whose response body streams back. That is why a provider
 * machine needs no owning worker, no `register`/`unregister`, and no socket to watch.
 *
 * EVERYTHING IS KEYED BY `agentId`. A provider has no session concept: one agent is one continuous
 * transcript. The session the web keys its turn lifecycle on is synthesised on our side
 * (`providerLink.ts`), so the provider never learns the concept exists.
 *
 * Every request goes through `providerFetch` — the URL came from the machine owner, so the SSRF guard
 * is not optional. See `lib/providerUrl.ts`; the address policy is enforced at connect time.
 *
 * There is no discovery step: one URL, one credential header, and the methods below. Everything a
 * client needs to know it learns by calling.
 *
 * Contract: autonomous-ai/autonomous-harness → provider/spec/README.md.
 */
import { providerFetch, readBodyCapped, type ProviderResponse } from '../providerUrl.js'

export interface ProviderCallOptions {
  url: string
  credential: string
  timeoutMs?: number
  signal?: AbortSignal
}

export class ProviderError extends Error {
  constructor(message: string, readonly kind: ProviderErrorKind, readonly status?: number) {
    super(message)
    this.name = 'ProviderError'
  }
}

/**
 * Each kind exists because it needs different words in front of the user.
 *
 * - `unauthenticated` — the credential is wrong. Not the same sentence as "the provider is down", and
 *   once the two are collapsed the distinction cannot be recovered downstream.
 * - `refused` — the provider answered CORRECTLY and said no, with a reason of its own. Since nothing
 *   is declared in advance, this is how a provider whose agents are managed in its own product
 *   declines `agent.create`: the message ("agents are managed in Example Co") is the whole mitigation
 *   for having no capability declarations, so it must reach the user verbatim.
 * - `protocol` — it answered, but not the way this protocol says to. Almost always a URL pointing at
 *   something else entirely.
 * - `transport` / `not_streaming` — could not reach it, or it would not stream.
 */
export type ProviderErrorKind = 'unauthenticated' | 'refused' | 'transport' | 'protocol' | 'not_streaming'

/** Error codes are strings, not numbers. */
const UNAUTHENTICATED_CODES = new Set(['unauthenticated', 'unauthorized'])

/** The codes this protocol defines. One of these means "answered, and said no" — not "malformed". */
const REFUSAL_CODES = new Set(['not_found', 'unsupported', 'invalid_request', 'rate_limited', 'internal'])

/**
 * One header, by convention rather than by declaration.
 *
 * There is no discovery document to ask where the credential goes, which means a provider cannot
 * choose a different header. That is the trade: `Authorization: Bearer` is near-universal, and the
 * alternative was a whole unauthenticated round trip whose only other job was to say "use this
 * header".
 */
function authHeaders(opts: ProviderCallOptions, extra: Record<string, string> = {}): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${opts.credential}`, ...extra }
}

/** An authentication failure, and a deliberate refusal, must each be distinguishable from an outage. */
function classify(status: number, errorCode?: string): ProviderErrorKind | null {
  if (status === 401 || status === 403 || (errorCode && UNAUTHENTICATED_CODES.has(errorCode))) return 'unauthenticated'
  if (errorCode && REFUSAL_CODES.has(errorCode)) return 'refused'
  if (errorCode) return 'protocol'
  if (status >= 400) return 'transport'
  return null
}

// ── JSON-RPC ─────────────────────────────────────────────────────────────────────────────────────

async function rpc<T>(opts: ProviderCallOptions, method: string, params: unknown): Promise<T> {
  const res = await providerFetch(opts.url, {
    method: 'POST',
    headers: authHeaders(opts),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    timeoutMs: opts.timeoutMs ?? 15_000,
    signal: opts.signal,
  })
  const text = await readBodyCapped(res)
  let parsed: { result?: T; error?: { code?: string; message?: string } }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    throw new ProviderError('provider did not return JSON', 'protocol', res.status)
  }
  const kind = classify(res.status, parsed.error?.code)
  if (kind) throw new ProviderError(parsed.error?.message ?? `provider error ${res.status}`, kind, res.status)
  if (parsed.result === undefined) throw new ProviderError('provider returned no result', 'protocol', res.status)
  return parsed.result
}

// ── agent.list ───────────────────────────────────────────────────────────────────────────────────

export interface ProviderAgent { id?: string; name?: string; description?: string }

/** Scoped to the tenant the credential selects — which is why it is authenticated, unlike the card. */
export const listAgents = (opts: ProviderCallOptions): Promise<{ agents?: ProviderAgent[] }> =>
  rpc<{ agents?: ProviderAgent[] }>(opts, 'agent.list', {})

// ── agent.history ────────────────────────────────────────────────────────────────────────────────

/**
 * One agent's transcript, windowed.
 *
 * `events` are the SAME objects the live stream emits, so there is no second shape to reconcile and
 * no way for "what you saw live" to drift from "what you see after a refresh". `before` is an opaque
 * cursor the provider mints; we never construct one.
 */
export interface AgentHistory {
  agentId?: string
  events?: unknown[]
  nextBefore?: string
  truncated?: boolean
}

export const fetchAgentHistory = (
  opts: ProviderCallOptions,
  agentId: string,
  window: { limit?: number; before?: string } = {},
): Promise<AgentHistory> =>
  rpc<AgentHistory>(opts, 'agent.history', {
    agentId,
    ...(window.limit ? { limit: window.limit } : {}),
    ...(window.before ? { before: window.before } : {}),
  })

// ── turn.cancel ──────────────────────────────────────────────────────────────────────────────────

export const cancelTurn = (opts: ProviderCallOptions, turnId: string): Promise<{ cancelled?: boolean }> =>
  rpc<{ cancelled?: boolean }>(opts, 'turn.cancel', { turnId })

// ── agent.create / rename / delete ───────────────────────────────────────────────────────────────

/**
 * Mutations on the agent list.
 *
 * Required of every provider, but a provider whose agents are managed in its own product does NOT
 * implement a fake mutation — it answers `invalid_request` with a message, and that message is shown
 * to the user ("agents are managed in Example Co"). An explanation the user can read beats a control
 * that is silently missing, which is why nothing has to be declared in advance for the client to know
 * what to hide.
 */
export const createAgent = (opts: ProviderCallOptions, name: string, description?: string): Promise<ProviderAgent> =>
  rpc<ProviderAgent>(opts, 'agent.create', { name, ...(description ? { description } : {}) })

export const renameAgent = (opts: ProviderCallOptions, agentId: string, name: string): Promise<ProviderAgent> =>
  rpc<ProviderAgent>(opts, 'agent.rename', { agentId, name })

export const deleteAgent = (opts: ProviderCallOptions, agentId: string): Promise<{ deleted?: boolean }> =>
  rpc<{ deleted?: boolean }>(opts, 'agent.delete', { agentId })

// ── agent.recap ──────────────────────────────────────────────────────────────────────────────────

/**
 * The agent's LAST recap — the device's tile text.
 *
 * The same object `recap_end` pushes on a turn's own stream, so there is one shape for a recap however
 * it reaches us. A provider that summarises nothing answers with no `recap`, and the backend excerpts
 * the turn itself instead.
 */
export const fetchRecap = (opts: ProviderCallOptions, agentId: string): Promise<ProviderRecap> =>
  rpc<ProviderRecap>(opts, 'agent.recap', { agentId })

export interface ProviderRecap {
  recap?: unknown
  text?: unknown
  /** Which turn it summarises. Optional on the wire, and load-bearing — see `fetchProviderRecap`. */
  turnId?: unknown
}

// ── agent.send (streaming) ───────────────────────────────────────────────────────────────────────

export interface SendMessage {
  agentId: string
  /** Minted by US, before the request leaves — so `turn.cancel` is valid from the first millisecond. */
  turnId: string
  text: string
  /** Set when answering a `turn_input_required`: same turn, continued. */
  resume?: boolean
}

/**
 * `agent.send`, yielding parsed SSE payloads in order.
 *
 * The response is consumed as a stream rather than buffered: a turn can run for minutes, and the
 * whole point of the protocol is that partial output reaches the user while it does.
 */
export async function* sendMessage(
  opts: ProviderCallOptions,
  message: SendMessage,
): AsyncGenerator<Record<string, unknown>> {
  const res: ProviderResponse = await providerFetch(opts.url, {
    method: 'POST',
    headers: authHeaders(opts, { accept: 'text/event-stream' }),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'agent.send',
      params: {
        agentId: message.agentId,
        turnId: message.turnId,
        ...(message.resume ? { resume: true } : {}),
        message: { text: message.text },
      },
    }),
    // A turn is long; the per-request budget must not cut it off mid-answer.
    timeoutMs: opts.timeoutMs ?? 10 * 60_000,
    signal: opts.signal,
  })

  const kind = classify(res.status)
  if (kind) {
    res.stream.destroy()
    throw new ProviderError(`provider refused the turn (${res.status})`, kind, res.status)
  }
  // A non-SSE reply here means the provider is not conformant, and the client cannot stream.
  const contentType = String(res.headers['content-type'] ?? '')
  if (!contentType.includes('text/event-stream')) {
    res.stream.destroy()
    throw new ProviderError(`expected text/event-stream, got "${contentType}"`, 'not_streaming', res.status)
  }

  let buffer = ''
  let seen = 0
  for await (const chunk of res.stream) {
    seen += (chunk as Buffer).length
    // A provider that never stops streaming must not be able to exhaust this process.
    if (seen > MAX_STREAM_BYTES) {
      res.stream.destroy()
      throw new ProviderError('provider stream exceeded the size limit', 'transport')
    }
    buffer += (chunk as Buffer).toString('utf8')
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      try {
        yield JSON.parse(line.slice(5).trim()) as Record<string, unknown>
      } catch {
        // A frame we cannot parse is dropped rather than failing the turn: the stream is
        // third-party output and one malformed event must not lose the ones after it.
      }
    }
  }
}

export const MAX_STREAM_BYTES = 32 * 1024 * 1024
