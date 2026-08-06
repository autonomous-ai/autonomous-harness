/**
 * In-memory state.
 *
 * A real provider would persist this; the shape is what matters. Note that THE TRANSCRIPT LIVES HERE —
 * the Autonomous backend keeps none for a provider machine, which is why `agent.history` is required
 * rather than optional.
 *
 * One agent is one continuous transcript (spec §1). There is no session, thread or context here, and
 * adding one back is the single most likely way to drift from the spec.
 */
import { isTerminalKind, type ProviderEvent, type RecapEntry } from './types.js'

/** How long a cancel waits for the send it belongs to. Generous: the client sends within a tick. */
export const EARLY_CANCEL_TTL_MS = 10 * 60_000

/** Deterministic ids: tests must not depend on a clock or a random source. */
let seq = 0
export const nextId = (prefix: string): string => `${prefix}-${++seq}`
export const resetIds = (): void => { seq = 0 }

interface Stored {
  /** Monotonic, and the only source of the `before` cursor. Never exposed as a field on the event. */
  seq: number
  event: ProviderEvent
}

export interface Window {
  events: ProviderEvent[]
  /** Omitted once the start of the transcript is reached. */
  nextBefore?: string
}

export class Store {
  private transcripts = new Map<string, Stored[]>()
  private recaps = new Map<string, RecapEntry[]>()
  /** turnId → abort for an in-flight stream, so `turn.cancel` can actually stop one. */
  private inFlight = new Map<string, AbortController>()
  /**
   * Turns cancelled BEFORE they started → when the cancel arrived.
   *
   * A cancel for a not-yet-started turn must be accepted AND must make that turn terminate
   * immediately if it later begins. Without this the client's whole reason for minting `turnId` itself
   * — being able to cancel in the first 200ms — would be honoured by the API and ignored by the engine.
   *
   * It holds the ARRIVAL TIME rather than just the id because an entry is otherwise only ever removed
   * by a matching `agent.send` that may never come: a client cancelling turns it never sends grows
   * this forever. Swept on write, which is the only moment it can grow.
   */
  private cancelledEarly = new Map<string, number>()
  /** turnId → agentId for a turn paused on `turn_input_required`, so a resume knows where it belongs. */
  private paused = new Map<string, string>()
  private counter = 0

  append(agentId: string, event: ProviderEvent): void {
    // Lifecycle and recap events are live-turn signals, not transcript content. Storing them would
    // make `agent.history` disagree with what a client renders from the stream.
    // `done` restates text already streamed as deltas — storing it would put the same words in the
    // transcript twice, and a client replaying would render the answer, then render it again.
    if (isTerminalKind(event.kind) || event.kind === 'turn_started'
      || event.kind === 'recap_start' || event.kind === 'recap_end' || event.kind === 'done') return
    const list = this.transcripts.get(agentId) ?? []
    list.push({ seq: ++this.counter, event })
    this.transcripts.set(agentId, list)
  }

  /**
   * A window of one agent's transcript, oldest-first within the window.
   *
   * `before` is opaque to the client and is our `seq` — which is why it is stored beside the event
   * rather than on it: the event objects handed back MUST be the ones the stream emitted.
   */
  history(agentId: string, limit?: number, before?: string): Window {
    const all = this.transcripts.get(agentId) ?? []
    const cutoff = before ? Number(before.replace(/^evt_/, '')) : Infinity
    const eligible = all.filter((s) => s.seq < cutoff)
    if (!limit) return { events: eligible.map((s) => s.event) }
    const slice = eligible.slice(-limit)
    const window: Window = { events: slice.map((s) => s.event) }
    // Only when something older remains. Its ABSENCE is how the client knows it reached the start.
    if (slice.length && eligible.length > slice.length) window.nextBefore = `evt_${slice[0]!.seq}`
    return window
  }

  pushRecap(agentId: string, entry: RecapEntry): void {
    this.recaps.set(agentId, [entry, ...(this.recaps.get(agentId) ?? [])].slice(0, 5))
  }

  /** The LAST one. The device shows a single tile per agent, so there is no history to page through. */
  lastRecap(agentId: string): RecapEntry | undefined {
    return (this.recaps.get(agentId) ?? [])[0]
  }

  register(turnId: string, controller: AbortController): void {
    this.inFlight.set(turnId, controller)
  }

  release(turnId: string): void {
    this.inFlight.delete(turnId)
  }

  pause(turnId: string, agentId: string): void {
    this.paused.set(turnId, agentId)
  }

  resumeOf(turnId: string): string | undefined {
    const agentId = this.paused.get(turnId)
    if (agentId) this.paused.delete(turnId)
    return agentId
  }

  /** True when this turn was cancelled before it began, and clears the flag. */
  takeEarlyCancel(turnId: string): boolean {
    return this.cancelledEarly.delete(turnId)
  }

  /**
   * Always succeeds. A cancel for an unknown turn is remembered rather than refused, because the
   * client mints `turnId` before sending and may well cancel first.
   */
  cancel(turnId: string): void {
    const live = this.inFlight.get(turnId)
    if (live) {
      live.abort()
      this.inFlight.delete(turnId)
      return
    }
    // A send that has not arrived within the window was never coming. Sweeping here — the one place
    // the map can grow — keeps an unmatched cancel from being a slow memory leak.
    const now = Date.now()
    for (const [id, at] of this.cancelledEarly) if (now - at > EARLY_CANCEL_TTL_MS) this.cancelledEarly.delete(id)
    this.cancelledEarly.set(turnId, now)
  }

  clear(): void {
    for (const c of this.inFlight.values()) c.abort()
    this.inFlight.clear()
    this.transcripts.clear()
    this.recaps.clear()
    this.cancelledEarly.clear()
    this.paused.clear()
    this.counter = 0
  }
}
