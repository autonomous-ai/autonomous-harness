/**
 * Harness Analytics — the local reducer.
 *
 * Design: docs/design/harness-analytics.md ("Local reducer and daily aggregates").
 *
 * This is where the additive/non-additive split is actually produced. Counters are accumulated per
 * (day, engine, mode, origin); the union of turn intervals and the distinct agent count are computed
 * HERE, per (machine, day), because this is the only place the whole set of intervals is visible.
 * Splitting either of them by engine and re-summing later is the bug this shape exists to prevent.
 *
 * Nothing in this file keeps prompt text, tool data, file names, or timestamps beyond the day
 * totals. `agentId` is held only long enough to count distinct agents and is never emitted.
 */
import {
  utcDayKey,
  type DailyBucketPayload,
  type DailyReportPayload,
  type Engine,
  type Mode,
  type Origin,
  type TurnOutcome,
} from './contract.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** A turn still open after this long is closed as failed — the machine was almost certainly killed. */
export const STALE_TURN_MS = 24 * 60 * 60 * 1000

/** Days retained locally. Aggregates are tiny, but the queue must still be bounded. */
export const MAX_LOCAL_DAYS = 120

type BucketKey = string // `${engine}|${mode}|${origin}`

interface Counters {
  instructions: number
  turnsStarted: number
  turnsCompleted: number
  turnsFailed: number
  turnsCancelled: number
  turnsInputNeeded: number
  agentRuntimeMs: number
}

interface DayState {
  buckets: Record<BucketKey, Counters>
  /** Merged, disjoint, sorted [startMs, endMs) offsets within the day. */
  intervals: [number, number][]
  /** Agent ids with at least one accepted human instruction. Never leaves this process. */
  agents: string[]
  uptimeMs: number
}

interface OpenTurn {
  turnId: string
  startedAt: number
  engine: Engine
  mode: Mode
  origin: Origin
}

export interface ReducerSnapshot {
  version: 1
  days: Record<string, DayState>
  openTurns: Record<string, OpenTurn>
}

function emptyCounters(): Counters {
  return {
    instructions: 0,
    turnsStarted: 0,
    turnsCompleted: 0,
    turnsFailed: 0,
    turnsCancelled: 0,
    turnsInputNeeded: 0,
    agentRuntimeMs: 0,
  }
}

function emptyDay(): DayState {
  return { buckets: {}, intervals: [], agents: [], uptimeMs: 0 }
}

function dayStartMs(at: number): number {
  const d = new Date(at)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

/**
 * Merge `[start, end)` into a disjoint sorted interval set.
 *
 * This is the union that makes wall-clock time honest: two agents working 10:00-10:25 and
 * 10:05-10:30 contribute 30 minutes here, while their runtimes contribute 50 minutes to the
 * additive counter. Both numbers are correct and they answer different questions.
 */
export function mergeInterval(
  intervals: [number, number][],
  start: number,
  end: number,
): [number, number][] {
  if (end <= start) return intervals
  const out: [number, number][] = []
  let lo = start
  let hi = end
  let inserted = false
  for (const [s, e] of intervals) {
    if (e < lo) {
      out.push([s, e])
    } else if (s > hi) {
      if (!inserted) { out.push([lo, hi]); inserted = true }
      out.push([s, e])
    } else {
      lo = Math.min(lo, s)
      hi = Math.max(hi, e)
    }
  }
  if (!inserted) out.push([lo, hi])
  return out.sort((a, b) => a[0] - b[0])
}

export function unionMs(intervals: [number, number][]): number {
  return intervals.reduce((acc, [s, e]) => acc + (e - s), 0)
}

/**
 * The reducer.
 *
 * Deliberately pure with respect to time: every entry point takes an explicit timestamp, so the
 * midnight-split, stale-turn, and uptime behaviours are testable without waiting for a clock.
 */
export class AnalyticsReducer {
  private days = new Map<string, DayState>()
  private open = new Map<string, OpenTurn>()

  constructor(snapshot?: ReducerSnapshot) {
    if (snapshot?.version === 1) {
      for (const [day, state] of Object.entries(snapshot.days)) this.days.set(day, state)
      for (const [id, turn] of Object.entries(snapshot.openTurns)) this.open.set(id, turn)
    }
  }

  snapshot(): ReducerSnapshot {
    return {
      version: 1,
      days: Object.fromEntries(this.days),
      openTurns: Object.fromEntries(this.open),
    }
  }

  private day(key: string): DayState {
    let state = this.days.get(key)
    if (!state) {
      state = emptyDay()
      this.days.set(key, state)
      this.prune()
    }
    return state
  }

  private counters(dayKey: string, engine: Engine, mode: Mode, origin: Origin): Counters {
    const state = this.day(dayKey)
    const key: BucketKey = `${engine}|${mode}|${origin}`
    state.buckets[key] = state.buckets[key] ?? emptyCounters()
    return state.buckets[key]
  }

  private prune(): void {
    if (this.days.size <= MAX_LOCAL_DAYS) return
    const sorted = [...this.days.keys()].sort()
    for (const key of sorted.slice(0, this.days.size - MAX_LOCAL_DAYS)) this.days.delete(key)
  }

  /**
   * A human instruction was accepted. Called only for turns the normalizer classified as real user
   * input — system prompts, tool results, replay, and compaction never reach here.
   */
  instruction(at: number, engine: Engine, mode: Mode, origin: Origin, agentId?: string): void {
    const key = utcDayKey(new Date(at))
    this.counters(key, engine, mode, origin).instructions++
    if (origin === 'human' && agentId) {
      const state = this.day(key)
      if (!state.agents.includes(agentId)) state.agents.push(agentId)
    }
  }

  turnStarted(turnId: string, at: number, engine: Engine, mode: Mode, origin: Origin): void {
    this.counters(utcDayKey(new Date(at)), engine, mode, origin).turnsStarted++
    this.open.set(turnId, { turnId, startedAt: at, engine, mode, origin })
  }

  /**
   * Close a turn.
   *
   * The outcome counts on the day the turn ENDED, which is one arbitrary choice made consistently
   * and stated in the metric tooltip. Runtime and the wall-clock union are split at the UTC day
   * boundary, so a turn running across midnight contributes to both days truthfully.
   */
  turnFinished(turnId: string, at: number, outcome: TurnOutcome): void {
    const turn = this.open.get(turnId)
    if (!turn) return
    this.open.delete(turnId)
    const end = Math.max(at, turn.startedAt)

    const counters = this.counters(utcDayKey(new Date(end)), turn.engine, turn.mode, turn.origin)
    if (outcome === 'completed') counters.turnsCompleted++
    else if (outcome === 'failed') counters.turnsFailed++
    else if (outcome === 'cancelled') counters.turnsCancelled++
    else counters.turnsInputNeeded++

    for (const slice of splitAcrossDays(turn.startedAt, end)) {
      const key = utcDayKey(new Date(slice.start))
      const base = dayStartMs(slice.start)
      this.counters(key, turn.engine, turn.mode, turn.origin).agentRuntimeMs += slice.end - slice.start
      const state = this.day(key)
      state.intervals = mergeInterval(state.intervals, slice.start - base, slice.end - base)
    }
  }

  /**
   * Close turns that outlived any plausible run.
   *
   * Without this a machine killed mid-turn would leave the turn open forever: its runtime would
   * never land anywhere and the day would silently under-report. Truncating at the last observed
   * event and calling it `failed` is the honest reading of "we stopped hearing about it".
   */
  closeStaleTurns(now: number): number {
    let closed = 0
    for (const [id, turn] of [...this.open]) {
      if (now - turn.startedAt < STALE_TURN_MS) continue
      this.turnFinished(id, turn.startedAt + STALE_TURN_MS, 'failed')
      closed++
    }
    return closed
  }

  /**
   * Credit time the collector was alive, for the utilization denominator.
   *
   * Bounded per call so a suspended container that wakes up hours later does not credit the gap: we
   * only know the process was running when it was actually ticking.
   */
  tickUptime(now: number, elapsedMs: number, maxCreditMs: number): void {
    const credit = Math.max(0, Math.min(elapsedMs, maxCreditMs))
    if (credit === 0) return
    for (const slice of splitAcrossDays(now - credit, now)) {
      this.day(utcDayKey(new Date(slice.start))).uptimeMs += slice.end - slice.start
    }
  }

  /** Days that have any activity or any credited uptime — i.e. days this collector was alive. */
  reportableDays(): string[] {
    return [...this.days.keys()].sort()
  }

  /**
   * Build the wire payload for a day.
   *
   * `reported: true` on an all-zero day is the heartbeat: it is what lets the dashboard say "up and
   * idle" instead of leaving a gap that looks identical to a machine that was switched off.
   */
  reportFor(dayKey: string, mode: Mode): DailyReportPayload | null {
    const state = this.days.get(dayKey)
    if (!state) return null
    const buckets: DailyBucketPayload[] = Object.entries(state.buckets).map(([key, counters]) => {
      const [engine, bucketMode, origin] = key.split('|') as [Engine, Mode, Origin]
      return { engine, mode: bucketMode, origin, ...counters }
    })
    void mode
    return {
      dayUtc: dayKey,
      machineDay: {
        wallClockActiveMs: unionMs(state.intervals),
        activeAgents: state.agents.length,
        uptimeMs: state.uptimeMs,
        reported: true,
      },
      buckets,
    }
  }

  /** Drop everything. Used when the account turns collection off or deletes its history. */
  clear(): void {
    this.days.clear()
    this.open.clear()
  }

  /** Forget days already stored centrally, keeping a small tail in case a later revision arrives. */
  forgetBefore(dayKey: string): void {
    for (const key of [...this.days.keys()]) {
      if (key < dayKey) this.days.delete(key)
    }
  }
}

/** Split `[start, end)` at UTC midnights, so no interval is ever attributed to the wrong day. */
export function splitAcrossDays(start: number, end: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  let cursor = start
  while (cursor < end) {
    const boundary = dayStartMs(cursor) + DAY_MS
    const stop = Math.min(end, boundary)
    out.push({ start: cursor, end: stop })
    cursor = stop
  }
  return out
}
