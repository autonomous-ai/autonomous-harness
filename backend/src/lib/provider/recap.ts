/**
 * Per-turn recap for a `provider` machine — the device's tile text.
 *
 * Two sources, in this order:
 *
 *  1. **The provider's own**, through `agent.recap`. This is a PULL by design, so it is asked for
 *     rather than pushed, and it is authoritative when the provider has one.
 *  2. **Derived here**, when it answers with nothing. The backend does NOT run a model for this: it
 *     excerpts the turn's own assistant output. That keeps recap generation where it belongs (the
 *     engine that produced the turn) and still gives the device something true to show, instead of an
 *     empty tile for every provider that does not summarise.
 *
 * The caps are the wire's, not ours to pick: `recap` ≤ 200 comes from the recap schema, and 2000 for
 * the body is what the node path and the `harness` CLI both use for a commander part. Nothing here
 * ever appends an ellipsis — the same rule `capRecap` enforces in
 * `machine-node/brain/src/prefrontal/recap.ts`, because a truncated line that ADVERTISES its
 * truncation reads worse on a round 466px display than one that simply ends.
 *
 * Spec: autonomous-ai/autonomous-harness → provider/spec/README.md.
 */
import { fetchRecap, type ProviderCallOptions, type ProviderRecap } from './client.js'

/** The `recap` ceiling — what fits a tile on a round 466px display at a glance. */
export const RECAP_MAX_CHARS = 200
/** One commander part — matches `SessionService.getRecentEvents` and the CLI's `MAX_PART`. */
export const BODY_MAX_CHARS = 2000

/**
 * One tile.
 *
 * This is the shape `SessionService.getRecentEvents` returns for a node-backed machine and the shape
 * `deviceWs.trimRecentEvents` already knows how to shrink — a provider machine must be
 * indistinguishable from a node one by the time the frame reaches the device.
 */
export interface RecapEvent {
  kind: 'summary'
  /** The fuller body, shown in the device's tap-to-read reader. */
  text: string
  /** The headline shown on the tile at a glance. */
  recap: string
}

/**
 * A recap, however it reached us → the tile we render.
 *
 * The ONE place the caps and the body fallback live, because a recap arrives two ways — pulled with
 * `agent.recap` and pushed on the turn's own stream as `recap_end` — and two copies of "cap at 200,
 * fall back to the headline" is how the device ends up rendering two different strings for the same
 * turn. Both carry the SAME object, which is what makes one mapper enough.
 *
 * Null when there is no headline: `recap` is the only field that must be present, and a recap without
 * one renders as nothing.
 */
export function toRecapEvent(entry: { recap?: unknown; text?: unknown } | undefined): RecapEvent | null {
  const recap = cap(flatten(entry?.recap), RECAP_MAX_CHARS)
  if (!recap) return null
  // `text` is optional. Falling back to the headline keeps the reader from opening on an empty pane.
  return { kind: 'summary', recap, text: cap(flatten(entry?.text), BODY_MAX_CHARS) || recap }
}

/**
 * Ask the provider for the agent's LAST recap.
 *
 * `null` is legitimate, not a failure: a provider that does not summarise says so by answering with
 * no `recap`, and the caller excerpts the turn instead.
 */
export async function fetchProviderRecap(
  call: ProviderCallOptions,
  agentId: string,
  opts: { turnId?: string } = {},
): Promise<RecapEvent | null> {
  const result: ProviderRecap = (await fetchRecap(call, agentId)) ?? {}
  // Asking for ONE specific turn's recap. `agent.recap` is scoped to an AGENT and cannot be scoped to
  // a turn, so the check happens here: the last recap a provider holds the instant a turn ends is very
  // often the PREVIOUS turn's, and showing that as this turn's summary is worse than showing none. A
  // recap that names no turn (the field is optional) is accepted, as it always was.
  if (opts.turnId && typeof result.turnId === 'string' && result.turnId !== opts.turnId) return null
  return toRecapEvent(result)
}

/**
 * The gap-fill: excerpt the turn's own output.
 *
 * An excerpt, deliberately — not a generated summary and not a statistic. The headline is the answer's
 * opening sentence, which for an assistant reply is very often the answer itself; the body is the
 * reply.
 *
 * Returns null when the turn produced no assistant text at all, and the caller then shows nothing.
 * Inventing a tile for a turn that said nothing is worse than an empty one.
 */
export function deriveRecap(assistantText: string): RecapEvent | null {
  const body = cap(flatten(assistantText), BODY_MAX_CHARS)
  if (!body) return null
  const recap = cap(firstSentence(body), RECAP_MAX_CHARS)
  if (!recap) return null
  return { kind: 'summary', recap, text: body }
}

/** Whitespace collapsed to single spaces: the device renders one line, and newlines waste it. */
function flatten(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * Hard cap, cut at a word boundary when there is one, and NEVER with an ellipsis appended.
 *
 * The boundary search is bounded to the last 40% so a long unbroken token cannot collapse the line to
 * a couple of words.
 */
function cap(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()
}

/** Up to the first sentence terminator; the whole string when it has none. */
function firstSentence(text: string): string {
  const match = /[.!?](\s|$)/.exec(text)
  return match ? text.slice(0, match.index + 1) : text
}
