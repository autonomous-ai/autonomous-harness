/**
 * Provider events → our wire frames. **The trust boundary.**
 *
 * Everything arriving here was produced by a third party at a URL the machine owner typed. It goes
 * straight to the web UI and to the physical device screen, so this module treats it as untrusted
 * input: known event kinds are mapped, everything else is dropped and counted, and a stream that
 * keeps violating the shape gets closed.
 *
 * `adapterWs.ts` forwards its frames verbatim and opaque, which is fine because the adapter is our
 * code. That is exactly the property a provider does not have — dropping E2EE for this mode did not
 * reduce the need for validation here, it raised it.
 *
 * The frames it emits are the ones the web and the device already speak — this module is the only
 * place a provider's vocabulary becomes ours.
 *
 * Spec: autonomous-ai/autonomous-harness → provider/spec/README.md.
 */
import type { Frame } from '../tunnel.js'

/**
 * The event vocabulary.
 *
 * ENFORCEMENT LIVES IN THE `switch` in `eventToFrame`, whose `default` drops anything unrecognised.
 * This set exists so the vocabulary can be asserted and reasoned about from outside — an earlier
 * version also checked it before the switch, which a mutation test exposed as dead code: removing
 * that check changed nothing, because the switch already refused. Two lists for one rule is how they
 * drift, so there is one rule and one list, and `every allowed kind maps to a frame` keeps them
 * honest.
 */
export const ALLOWED_KINDS = new Set([
  'user_message',
  'thinking_delta',
  'thinking_title',
  'text_delta',
  'tool_start',
  'tool_end',
  'context_compact',
  'done',
  'recap_start',
  'recap_end',
])

/**
 * Terminal kinds, which end the stream. Exactly one must arrive.
 *
 * Explicit rather than derived from a state machine, which is what makes "every stream ends properly"
 * a single assertion instead of a state table.
 */
export const TERMINAL_KINDS = new Set(['turn_completed', 'turn_failed', 'turn_cancelled', 'turn_input_required'])

export interface ProviderEvent {
  kind?: string
  [field: string]: unknown
}

export type TurnEnd =
  | { outcome: 'completed' }
  | { outcome: 'failed'; message?: string }
  | { outcome: 'cancelled' }
  /** Not a failure: the turn is PAUSED for a human answer, which arrives as a resumed `agent.send`. */
  | { outcome: 'input_required'; prompt?: string }

export type MappedEvent =
  | { kind: 'frames'; frames: Frame[] }
  | { kind: 'terminal'; end: TurnEnd; frames: Frame[] }
  | { kind: 'invalid'; reason: string }
  | { kind: 'ignore' }

/**
 * Per-field ceiling on anything a provider sends.
 *
 * `MAX_FRAMES_PER_TURN` bounds how MANY events arrive and `MAX_STREAM_BYTES` bounds a whole turn at
 * 32 MB — neither stops one event from carrying all of it. Every frame here fans out through Redis to
 * every open web tab and to the device screen, so a single 32 MB `text_delta` is amplified once per
 * client. 100k characters is far past any real assistant message and far short of a problem.
 */
export const MAX_FIELD_CHARS = 100_000

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v.slice(0, MAX_FIELD_CHARS) : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/**
 * Tool input is arbitrary JSON, so it is bounded by its SERIALISED size — there is no length to slice.
 * Oversized input is replaced by a marked preview rather than dropped: the tool row still renders, and
 * it says plainly that there was more.
 */
function boundedInput(v: unknown): unknown {
  if (v == null) return {}
  const json = JSON.stringify(v) ?? ''
  return json.length <= MAX_FIELD_CHARS ? v : { truncated: true, preview: json.slice(0, 1_000) }
}

/**
 * Map one SSE payload.
 *
 * Returns `invalid` rather than throwing so the caller can count violations and decide when a
 * provider has misbehaved enough to disconnect — one malformed frame is not worth losing a turn over,
 * a hundred is.
 */
export function mapEvent(raw: unknown): MappedEvent {
  if (!raw || typeof raw !== 'object') return { kind: 'invalid', reason: 'event is not an object' }
  const event = raw as ProviderEvent
  const kind = str(event.kind)
  // RICHNESS IS OPT-IN. A provider that only ever sends `{text: "…"}` is conformant, and its output
  // renders as plain assistant text. Treating that as invalid would reject the simplest possible
  // correct implementation — which is the one a partner writes first.
  if (!kind) {
    const plain = typeof event.text === 'string' ? event.text.slice(0, MAX_FIELD_CHARS) : ''
    return plain
      ? { kind: 'frames', frames: [{ type: 'text_delta', payload: { content: plain } }] }
      : { kind: 'invalid', reason: 'event has neither a kind nor text' }
  }

  if (TERMINAL_KINDS.has(kind)) return { kind: 'terminal', end: terminalEnd(kind, event), frames: [] }

  // `turn_started` carries only ids we already know; it exists so a provider can mark the boundary
  // and so the conformance runner can require one. Nothing is rendered from it.
  if (kind === 'turn_started') return { kind: 'ignore' }

  const frame = eventToFrame(event, kind)
  return frame ? { kind: 'frames', frames: [frame] } : { kind: 'ignore' }
}

function terminalEnd(kind: string, event: ProviderEvent): TurnEnd {
  switch (kind) {
    case 'turn_cancelled': return { outcome: 'cancelled' }
    case 'turn_input_required': {
      const prompt = str(event.prompt)
      return { outcome: 'input_required', ...(prompt ? { prompt } : {}) }
    }
    case 'turn_failed': {
      const err = (event.error ?? {}) as Record<string, unknown>
      const message = str(err.message)
      return { outcome: 'failed', ...(message ? { message } : {}) }
    }
    default: return { outcome: 'completed' }
  }
}

/** One event → one client frame, or null when it carries nothing we render. */
export function eventToFrame(event: ProviderEvent, kind: string): Frame | null {
  const text = typeof event.text === 'string' ? event.text.slice(0, MAX_FIELD_CHARS) : ''

  switch (kind) {
    case 'text_delta':
    case 'thinking_delta':
      return text ? { type: kind, payload: { content: text, ...idOf(event.thinkingId) } } : null

    case 'thinking_title': {
      const title = str(event.title) ?? str(event.text)
      return title ? { type: 'thinking_title', payload: { title, ...idOf(event.thinkingId) } } : null
    }

    case 'user_message':
      return text ? { type: 'user_message', payload: { content: text } } : null

    case 'tool_start': {
      const id = str(event.toolId)
      if (!id) return null // an unpaired tool call would render as a row that never resolves
      return { type: 'tool_start', payload: { id, tool: str(event.tool) ?? 'tool', input: boundedInput(event.input) } }
    }

    case 'tool_end': {
      const id = str(event.toolId)
      if (!id) return null
      const seconds = num(event.durationSeconds)
      return {
        type: 'tool_end',
        payload: {
          id,
          tool: str(event.tool) ?? 'tool',
          output: typeof event.output === 'string' ? event.output.slice(0, MAX_FIELD_CHARS) : text,
          // `ok: false` is the failure signal; absent `ok` means the provider did not say, which is
          // not the same as saying it failed.
          isError: event.ok === false,
          summary: str(event.summary) ?? '',
          ...(seconds != null ? { durationSeconds: seconds } : {}),
        },
      }
    }

    case 'context_compact':
      return { type: 'context_compact', payload: { message: text || 'Context compacted' } }

    case 'done':
      return { type: 'done', payload: { result: text } }

    // The recap phase, bracketed. Neither of these is forwarded to a client as-is: `providerLink`
    // consumes them and re-emits the frames the web and the device already speak.
    case 'recap_start':
      return { type: 'recap_start', payload: {} }

    // Deliberately NOT null when the headline is missing: an absent `recap` is the provider saying
    // "nothing to show", and swallowing that would leave the client's "preparing a recap" indicator
    // open forever.
    case 'recap_end': {
      const recap = str(event.recap)
      // `text`, not `body`: `agent.recap` hands back this same object, and one shape for the pushed
      // and the pulled recap is what lets a single mapper serve both.
      return { type: 'recap_end', payload: { ...(recap ? { recap } : {}), ...(text ? { text } : {}) } }
    }

    default:
      return null
  }
}

function idOf(v: unknown): Record<string, string> {
  const id = str(v)
  return id ? { thinkingId: id } : {}
}

/** Terminal end → how the turn ended, for `turn_ended` and the error surface. */
export function turnOutcome(end: TurnEnd): { aborted: boolean; failed: boolean } {
  return { aborted: end.outcome === 'cancelled', failed: end.outcome === 'failed' }
}

/** How many malformed events a provider may send before we stop listening to it. */
export const MAX_CONSECUTIVE_INVALID = 20
