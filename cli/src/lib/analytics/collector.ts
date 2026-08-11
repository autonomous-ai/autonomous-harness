/**
 * Harness Analytics collector for the remote CLI.
 *
 * Design: `autonomous-code` docs/design/harness-analytics.md ("Source-specific collectors").
 *
 * This is the collector that matters most: it is the only layer that understands every engine's
 * transcript well enough to count the same concept across all twelve, and it is the only one that
 * can count at all — the relay sees `turn_started` and `turn_ended` as ciphertext
 * (`ENCRYPTED_UP_TYPES` in `src/lib/e2ee/core.ts`), so a byte count there could never distinguish a
 * real instruction from a duplicated control frame.
 *
 * Two behaviours are load-bearing and easy to get wrong:
 *
 *  - **Collection starts immediately; uploading waits for acknowledgement.** Aggregates are
 *    snapshots, so holding them costs nothing and loses nothing. That is what lets the product be on
 *    by default while still being able to say, truthfully, that no byte left this computer before
 *    its owner read the field list. The CLI runs headless on servers and under `harness join`, where
 *    there is no screen to show a preview on, so the hold is the only honest mechanism available.
 *  - **The upload response is the control channel.** A daemon has no other way to learn the owner
 *    turned collection off or deleted the history.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { env } from '../../config/env.js'
import { ENGINES as ALL_ENGINES, type AgentEngine } from '../../engines/types.js'
import { AnalyticsReducer, type ReducerSnapshot } from './reducer.js'
import {
  ANALYTICS_SCHEMA_VERSION,
  MAX_DAYS_PER_REPORT,
  type AnalyticsReportResponse,
  type ConsentState,
  type Engine,
  type Origin,
  type TurnOutcome,
} from './contract.js'

const UPTIME_TICK_MS = 60_000
/** A tick may credit at most this much, so a laptop that slept cannot claim the hours it was shut. */
const UPTIME_MAX_CREDIT_MS = 90_000

interface PersistedState {
  version: 1
  consent: ConsentState
  epoch: number
  reducer: ReducerSnapshot
}

/** Where the daemon keeps its analytics state, beside its other mutable data. */
export function analyticsStateFile(): string {
  return join(env.ADAPTER_DATA_DIR, 'analytics', 'state.json')
}

/** The CLI dials the backend over `wss://`; the ingest endpoint is the same host over `https://`. */
export function analyticsBaseUrl(): string {
  if (env.ANALYTICS_BACKEND_URL) return env.ANALYTICS_BACKEND_URL.replace(/\/$/, '')
  return env.BACKEND_WS_URL.replace(/^ws/, 'http').replace(/\/$/, '')
}

export interface CollectorOptions {
  /** Reads the machine api key. Kept as a callback because the daemon may join after start-up. */
  token: () => string | null
  /**
   * Engines with a registered agent on this computer right now.
   *
   * `engineCoverage` alone cannot answer "is anything being missed": an engine absent from it is
   * either uninstrumented or simply not installed. Only the difference is shown to the user, so the
   * collector has to report what it can actually see.
   */
  enginesPresent: () => AgentEngine[]
  collectorVersion: string
  now?: () => number
}

export class AnalyticsCollector {
  private reducer = new AnalyticsReducer()
  // Collection is ON by default; the backend only ever tells us to stop.
  private consent: ConsentState = 'on'
  private epoch = 0
  private lastTickAt: number
  private uptimeTimer: NodeJS.Timeout | null = null
  private flushTimer: NodeJS.Timeout | null = null
  private started = false
  private flushing = false
  private dirty = false

  /** The CLI instruments every engine it integrates — that is the point of putting it here. */
  private readonly coverage: Engine[] = [...ALL_ENGINES] as Engine[]

  constructor(private readonly opts: CollectorOptions) {
    this.lastTickAt = this.now()
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  start(): void {
    if (this.started || !env.ANALYTICS_ENABLED) return
    this.started = true
    this.load()
    this.lastTickAt = this.now()

    this.uptimeTimer = setInterval(() => this.tick(), UPTIME_TICK_MS)
    this.uptimeTimer.unref?.()
    this.flushTimer = setInterval(() => { void this.flush() }, env.ANALYTICS_FLUSH_INTERVAL_MS)
    this.flushTimer.unref?.()
  }

  stop(): void {
    this.started = false
    if (this.uptimeTimer) clearInterval(this.uptimeTimer)
    if (this.flushTimer) clearInterval(this.flushTimer)
    this.uptimeTimer = null
    this.flushTimer = null
    this.persist()
  }

  /** Live turn id per session. The normalizers emit per-session lifecycle events, not turn ids. */
  private readonly openTurns = new Map<string, string>()
  private turnSeq = 0

  /**
   * A turn began on a session.
   *
   * Called from the single `emitSessionEvents` funnel, which every engine's normalizer feeds — so one
   * hook covers all twelve, and a thirteenth engine is counted the day it joins that funnel.
   *
   * `agentId` is used ONLY to count distinct active agents for the day and never leaves this
   * computer; the wire payload carries the integer alone.
   */
  sessionTurnStarted(
    sessionId: string,
    engine: AgentEngine,
    agentId: string,
    origin: Origin = 'human',
    at = this.now(),
  ): void {
    if (!this.collecting()) return

    // A previous turn that never terminated would otherwise leak and under-report the day.
    const stale = this.openTurns.get(sessionId)
    if (stale) this.reducer.turnFinished(stale, at, 'failed')

    const turnId = `${sessionId}#${++this.turnSeq}`
    this.openTurns.set(sessionId, turnId)
    this.reducer.turnStarted(turnId, at, engine as Engine, 'remote', origin)
    this.reducer.instruction(at, engine as Engine, 'remote', origin, agentId)
    this.dirty = true
  }

  /** A turn terminated. `aborted` is the normalizers' word for an interrupt. */
  sessionTurnEnded(sessionId: string, aborted: boolean, at = this.now()): void {
    if (!this.collecting()) return
    const turnId = this.openTurns.get(sessionId)
    if (!turnId) return
    this.openTurns.delete(sessionId)
    this.reducer.turnFinished(turnId, at, aborted ? 'cancelled' : 'completed')
    this.dirty = true
  }

  /** A session went away. Its open turn is a failure; dropping it would under-report the day. */
  sessionClosed(sessionId: string, at = this.now()): void {
    const turnId = this.openTurns.get(sessionId)
    if (!turnId) return
    this.openTurns.delete(sessionId)
    if (!this.collecting()) return
    this.reducer.turnFinished(turnId, at, 'failed')
    this.dirty = true
  }

  /** Direct turn control, used by the conformance tests. */
  turnFinished(turnId: string, outcome: TurnOutcome, at = this.now()): void {
    if (!this.collecting()) return
    this.reducer.turnFinished(turnId, at, outcome)
    this.dirty = true
  }

  /**
   * A `harness analytics off` run by the person at this computer wins over anything the account
   * says. It is a marker file rather than a flag in the state JSON because that command is a
   * separate short-lived process and two writers on one snapshot corrupts it.
   */
  private locallyDisabled(): boolean {
    try { return existsSync(join(env.ADAPTER_DATA_DIR, 'analytics', 'disabled')) } catch { return false }
  }

  private collecting(): boolean {
    return this.started && this.consent !== 'off' && !this.locallyDisabled()
  }

  private tick(): void {
    const now = this.now()
    const elapsed = now - this.lastTickAt
    this.lastTickAt = now
    if (!this.collecting()) return
    this.reducer.tickUptime(now, elapsed, UPTIME_MAX_CREDIT_MS)
    this.reducer.closeStaleTurns(now)
  }

  /** The report this computer would send, for `harness analytics preview` — nothing is uploaded. */
  buildReport(now = new Date(this.now())): Record<string, unknown> {
    const days = this.reducer.reportableDays().slice(-MAX_DAYS_PER_REPORT)
    return {
      schemaVersion: ANALYTICS_SCHEMA_VERSION,
      epoch: this.epoch,
      generatedAt: now.toISOString(),
      collector: {
        version: this.opts.collectorVersion,
        engineCoverage: this.coverage,
        enginesPresent: [...new Set(this.opts.enginesPresent())],
      },
      days: days.map((d) => this.reducer.reportFor(d, 'remote')).filter(Boolean),
    }
  }

  consentState(): ConsentState {
    return this.consent
  }

  async flush(now = new Date(this.now())): Promise<void> {
    if (!this.started || this.flushing || this.locallyDisabled()) return
    this.flushing = true
    try {
      if (this.dirty) { this.persist(); this.dirty = false }
      const key = this.opts.token()
      if (!key) return

      const body = this.buildReport(now)
      if ((body.days as unknown[]).length === 0) return

      const res = await fetch(`${analyticsBaseUrl()}/api/analytics/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: JSON.stringify(body),
      })

      if (res.status === 409) {
        // The owner deleted this account's history. Anything still queued belongs to the old epoch,
        // so it is dropped here rather than uploaded again on the next tick.
        const payload = await res.json().catch(() => null) as { error?: { message?: string } } | null
        this.epoch = extractEpoch(payload?.error?.message) ?? this.epoch + 1
        this.reducer.clear()
        this.persist()
        console.log('[analytics] history was reset centrally; local records dropped')
        return
      }
      if (!res.ok) return // transient: keep the snapshot and retry on the next flush

      const parsed = await res.json().catch(() => null) as { data?: AnalyticsReportResponse } | null
      const result = parsed?.data
      if (!result) return

      this.applyControl(result)
      if (result.accepted > 0) {
        // Keep a two-day tail so a late terminal event can still revise a recently-uploaded day.
        const days = (body.days as { dayUtc: string }[]).map((d) => d.dayUtc)
        this.reducer.forgetBefore(days[Math.max(0, days.length - 2)])
        this.persist()
      }
    } catch {
      // Offline, DNS down, backend restarting. The snapshot survives; the next flush retries.
    } finally {
      this.flushing = false
    }
  }

  private applyControl(result: AnalyticsReportResponse): void {
    const previous = this.consent
    this.consent = result.consent
    this.epoch = result.epoch

    if (result.consent === 'off') {
      this.reducer.clear()
      this.persist()
      if (previous !== 'off') console.log('[analytics] collection turned off by the account owner')
      return
    }
    if (previous !== result.consent) this.persist()
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(analyticsStateFile(), 'utf8')) as PersistedState
      if (parsed.version !== 1) return
      this.consent = parsed.consent
      this.epoch = parsed.epoch
      this.reducer = new AnalyticsReducer(parsed.reducer)
    } catch {
      // No state yet, or unreadable. Starting clean loses at most today's counters, which is better
      // than refusing to collect.
    }
  }

  private persist(): void {
    const payload: PersistedState = {
      version: 1,
      consent: this.consent,
      epoch: this.epoch,
      reducer: this.reducer.snapshot(),
    }
    try {
      const target = analyticsStateFile()
      mkdirSync(dirname(target), { recursive: true })
      const tmp = `${target}.tmp`
      writeFileSync(tmp, JSON.stringify(payload), 'utf8')
      renameSync(tmp, target) // atomic: a crash mid-write must not leave a truncated state file
    } catch {
      // A read-only or full disk must not take the daemon down over analytics.
    }
  }
}

/** Pull the current epoch out of the 409 message so the collector resynchronises immediately. */
export function extractEpoch(message: string | undefined): number | null {
  const match = /current epoch is (\d+)/.exec(message ?? '')
  return match ? Number(match[1]) : null
}
