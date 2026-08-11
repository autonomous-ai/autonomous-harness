/**
 * Harness Analytics — the canonical, versioned contract.
 *
 * MIRROR of `autonomous-code`: apps/backend/src/types/analytics.ts. The two repositories share no
 * package, so the copies are kept in sync by the conformance tests rather than by the module
 * system. Edit the backend copy first, then mirror it here.
 *
 *
 * Design: docs/design/harness-analytics.md
 *
 * The one rule that shapes everything here: ADDITIVE counters and NON-ADDITIVE metrics travel in
 * different shapes. `DailyBucket` may be split by engine/mode/origin and re-summed; `MachineDay`
 * may not, so it exists once per (machine, day) and is computed locally where every interval is
 * visible.
 */

export const ANALYTICS_SCHEMA_VERSION = 1

export const ENGINES = [
  'claude', 'codex', 'cursor', 'opencode', 'pi', 'hermes',
  'commandcode', 'devin', 'muse', 'amp', 'kilo', 'grok',
] as const
export type Engine = (typeof ENGINES)[number]

export const MODES = ['self', 'managed', 'remote', 'provider'] as const
export type Mode = (typeof MODES)[number]

export const ORIGINS = ['human', 'scheduled', 'system', 'api'] as const
export type Origin = (typeof ORIGINS)[number]

export const TURN_OUTCOMES = ['completed', 'failed', 'cancelled', 'input_required'] as const
export type TurnOutcome = (typeof TURN_OUTCOMES)[number]

/**
 * Collection is ON by default and can be turned off; there is no pending state.
 *
 * An earlier design held every upload until the account owner had acknowledged a field list. That
 * gate was removed deliberately: it put a full-page interstitial in front of the dashboard, and the
 * disclosure now lives as a non-blocking panel instead.
 */
export const CONSENT_STATES = ['on', 'off'] as const
export type ConsentState = (typeof CONSENT_STATES)[number]

/**
 * Canonical activity events, emitted at the normalization boundary — before E2EE sealing on the
 * remote CLI, because the relay cannot tell a real instruction from a duplicated control frame.
 *
 * `agentId` NEVER leaves the machine. It is present so the local reducer can compute a distinct
 * active-agent count; only the resulting integer is uploaded.
 */
export type AnalyticsEventV1 =
  | { type: 'instruction'; eventId: string; at: string; engine: Engine; origin: Origin }
  | { type: 'turn_started'; turnId: string; at: string; engine: Engine; origin: Origin; agentId: string }
  | { type: 'turn_finished'; turnId: string; at: string; outcome: TurnOutcome }

/** ADDITIVE counters for one (day, engine, mode, origin). Safe to sum along any dimension. */
export interface DailyBucketPayload {
  engine: Engine
  mode: Mode
  origin: Origin
  instructions: number
  turnsStarted: number
  turnsCompleted: number
  turnsFailed: number
  turnsCancelled: number
  turnsInputNeeded: number
  /** Sum of terminal turn durations. Concurrent agents overlap here by design. */
  agentRuntimeMs: number
}

/**
 * NON-ADDITIVE metrics for one (machine, day), plus the reporting heartbeat.
 *
 * Emitted for EVERY day the collector was alive, including an all-zero day: that is what lets the
 * dashboard tell "up and idle" from "no data". A missing day is missing information, never zero.
 */
export interface MachineDayPayload {
  /** Union of turn intervals — computed here, where the whole set is visible, and never split. */
  wallClockActiveMs: number
  /** Distinct agents with at least one accepted human instruction. */
  activeAgents: number
  /** Denominator for utilization. 0 when not meaningful (provider mode has no container). */
  uptimeMs: number
  reported: boolean
}

export interface DailyReportPayload {
  /** Midnight UTC of the day, ISO-8601 (`2026-08-11` or a full timestamp). */
  dayUtc: string
  machineDay: MachineDayPayload
  buckets: DailyBucketPayload[]
}

export interface CollectorInfo {
  version: string
  /** Engines this collector actually instruments. */
  engineCoverage: Engine[]
  /**
   * Engines the collector can SEE on this machine (registered agents, discovered binaries).
   *
   * Coverage alone cannot answer "is anything being missed": an engine absent from `engineCoverage`
   * is either uninstrumented or simply not installed, and reporting every engine the product knows
   * about as "not instrumented" would be noise on every machine. The difference
   * `enginesPresent - engineCoverage` is the honest set, and it is the only one the UI shows.
   */
  enginesPresent: Engine[]
}

/** Request body of `POST /api/analytics/report`. */
export interface AnalyticsReportRequest {
  schemaVersion: number
  /** Account deletion epoch the collector last saw. An older epoch is refused. */
  epoch: number
  /** Client monotonic stamp; the server clamps it against its own clock. */
  generatedAt: string
  collector: CollectorInfo
  days: DailyReportPayload[]
}

/**
 * Response of `POST /api/analytics/report`. This doubles as the control channel: it is the only way
 * a headless collector learns that the owner turned collection off or deleted the history.
 */
export interface AnalyticsReportResponse {
  consent: ConsentState
  epoch: number
  serverTime: string
  accepted: number
  quarantined: number
}

/**
 * How far a client stamp may sit from the server clock before its records are quarantined rather
 * than stored. A machine whose clock is years off would otherwise write into a bucket far outside
 * the range and take over every chart.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 48 * 60 * 60 * 1000

/** Days accepted in one report. A backlog flush after a long offline period needs several. */
export const MAX_DAYS_PER_REPORT = 120

/** Central retention for daily records: 13 months, so year-over-year views have a comparison. */
export const RETENTION_DAYS = 396

/** Buckets accepted for one day: 12 engines x 4 modes x 4 origins, with headroom. */
export const MAX_BUCKETS_PER_DAY = 240

/** Below this many terminal turns, a completion rate is suppressed instead of shown. */
export const MIN_SAMPLE_FOR_RATE = 30

/** Days of history required before an anomaly baseline is meaningful. */
export const MIN_DAYS_FOR_BASELINE = 14

/** Midnight UTC of the day containing `at`. The single definition of a day, used on both sides. */
export function utcDayStart(at: Date | string): Date {
  const d = typeof at === 'string' ? new Date(at) : at
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/** `2026-08-11` — the wire form of a day key. */
export function utcDayKey(at: Date | string): string {
  return utcDayStart(at).toISOString().slice(0, 10)
}
