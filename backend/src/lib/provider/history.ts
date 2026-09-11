/**
 * The transcript behind `session_get` for a `provider` machine.
 *
 * A provider has no sessions: one agent is one continuous transcript, fetched with `agent.history`
 * and windowed by `{limit, before}`. History is REQUIRED of every provider, so there is no
 * "undeclared" branch here any more — it either answers or it errors.
 *
 * The field names on OUR side are not a new invention and must not become one: `{limit, before}` in
 * and `{hasMore, oldestCursor, staleCursor}` out is exactly the pager the node path already speaks
 * (`machine-node/api/src/routes/websocket.ts` `session_get`, `SessionService.getSessionDetail`) and
 * the web already drives (`web/src/lib/store/slices/messagesSlice/sessionActions.ts`). A provider
 * machine has to be indistinguishable from a node one by the time the frame reaches the client — so
 * the provider's `nextBefore` is translated into that pager here, and never leaked upward.
 *
 * Spec: autonomous-ai/autonomous-harness → provider/spec/README.md.
 */
import type { Frame } from '../tunnel.js'
import { fetchAgentHistory, type ProviderCallOptions } from './client.js'
import { eventToFrame, type ProviderEvent } from './events.js'

/** The node's own ceiling, mirrored so a provider machine cannot be asked for a bigger window. */
export const MAX_HISTORY_LIMIT = 500

export interface AgentTranscript {
  events: Frame[]
  /** Present only for a WINDOWED answer — its absence is what marks a response as complete. */
  hasMore?: boolean
  oldestCursor?: string | null
  /** The provider hit its own transcript ceiling and said so, rather than truncating in silence. */
  truncated?: boolean
}

/**
 * Provider events → the event stream the web actually renders.
 *
 * The client has two branches (`messagesSlice/sessionActions.ts`): `events`, which is structured and
 * carries tool output, thinking and ordering; and a `messages` fallback that expects **Claude's own
 * JSONL shape** (`msg.message.content[]`). A provider speaks neither, so the fallback would drop every
 * entry on `if (!msg.message?.content) continue` and a provider transcript would render as an empty
 * chat no matter how much history came back. Mapping to `events` is the honest translation.
 *
 * It goes through the SAME `eventToFrame` a live turn does — and now on the same objects, since
 * `agent.history` returns exactly what the stream emitted. A replayed transcript and the live view
 * cannot disagree about the same event, because there is only one shape and one mapper.
 */
export function historyToEvents(events: unknown[]): Frame[] {
  const out: Frame[] = []
  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue
    const event = raw as ProviderEvent
    const kind = typeof event.kind === 'string' ? event.kind : ''
    if (!kind) continue
    const frame = eventToFrame(event, kind)
    // The recap phase is a live-turn signal, not transcript content — it has no place in a replay,
    // and the client's event vocabulary has no case for it.
    if (frame && frame.type !== 'recap_start' && frame.type !== 'recap_end') out.push(frame)
  }
  return out
}

/** `undefined` for "no window asked for", which the wire treats as the whole transcript. */
export function clampHistoryLimit(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.min(Math.floor(n), MAX_HISTORY_LIMIT)
}

/**
 * One agent's transcript, already in client frames and client pager shape.
 *
 * `nextBefore` → `{hasMore, oldestCursor}` happens HERE rather than at the call site, because those
 * two names are the client's contract and the provider must never see them. Note the asymmetry that
 * mirrors the node path: the pager fields are attached only when a window was actually requested.
 * Synthesising `hasMore: false` for a whole-transcript answer would tell the client "no older
 * messages" about a response that was never windowed — true by accident, and false the moment paging
 * is asked for.
 */
export async function fetchTranscript(
  call: ProviderCallOptions,
  agentId: string,
  opts: { limit?: number; before?: string } = {},
): Promise<AgentTranscript> {
  const out = await fetchAgentHistory(call, agentId, {
    ...(opts.limit ? { limit: opts.limit } : {}),
    // A cursor without a window is meaningless — the same pairing the node enforces.
    ...(opts.limit && opts.before ? { before: opts.before } : {}),
  })
  const transcript: AgentTranscript = {
    events: historyToEvents(Array.isArray(out?.events) ? out.events : []),
  }
  if (opts.limit) {
    const cursor = typeof out?.nextBefore === 'string' && out.nextBefore ? out.nextBefore : null
    transcript.hasMore = cursor !== null
    transcript.oldestCursor = cursor
  }
  if (out?.truncated === true) transcript.truncated = true
  return transcript
}
