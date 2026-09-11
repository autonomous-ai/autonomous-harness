/**
 * Harness Analytics read path — account rollups for the dashboard.
 *
 * Design: docs/design/harness-analytics.md ("Metric contract", "Backend data model").
 *
 * The rollup rules are not stylistic; breaking them produces numbers that are wrong in a way nobody
 * notices:
 *
 *   - `AnalyticsDailyBucket` may be aggregated freely (additive counters).
 *   - `AnalyticsDailyMachine.activeAgents` may be summed ACROSS MACHINES only — an agent belongs to
 *     exactly one machine, so there is nothing to de-duplicate, but it is never split by engine.
 *   - `AnalyticsDailyMachine.wallClockActiveMs` is summed across machines only under the label
 *     "sum across machines". It is a union within a machine and cannot become a union across them.
 */
import { prisma } from './prisma.js'
import { machineAlive } from './prisma.js'
import {
  MIN_DAYS_FOR_BASELINE,
  MIN_SAMPLE_FOR_RATE,
  utcDayKey,
  utcDayStart,
  type Engine,
} from '../types/analytics.js'

const DAY_MS = 24 * 60 * 60 * 1000

export type MachineDataState = 'active' | 'idle' | 'no_data'

export interface AnalyticsOverview {
  range: { fromDay: string; toDay: string; days: number }
  totals: {
    instructions: number
    turnsStarted: number
    turnsCompleted: number
    turnsFailed: number
    turnsCancelled: number
    turnsInputNeeded: number
    terminalTurns: number
    agentRuntimeMs: number
    /** Sum across machines — overlapping work on two machines is counted twice, by design. */
    wallClockActiveMs: number
    activeAgents: number
    activeDays: number
    /** Suppressed (null) below MIN_SAMPLE_FOR_RATE terminal turns rather than shown over a tiny n. */
    completionRate: number | null
    unproductiveShare: number | null
  }
  byEngine: EngineTotals[]
  daily: DailyPoint[]
  machines: MachineSummary[]
  coverage: {
    knownMachines: number
    reportingMachines: number
    staleMachines: number
    lastReportAt: string | null
  }
  health: {
    ready: boolean
    baselineDays: number
    requiredDays: number
    latestDay: string | null
    latestRate: number | null
    baselineRate: number | null
  }
  notInstrumented: { machineId: string; machineName: string | null; engines: string[] }[]
}

export interface EngineTotals {
  engine: string
  instructions: number
  turnsCompleted: number
  turnsFailed: number
  turnsCancelled: number
  turnsInputNeeded: number
  agentRuntimeMs: number
}

export interface DailyPoint {
  day: string
  instructions: number
  turnsCompleted: number
  turnsFailed: number
  turnsCancelled: number
  turnsInputNeeded: number
  byEngine: Record<string, number>
  /** Per-machine reporting state for this day. This is what keeps "idle" from reading as "no data". */
  machineStates: Record<string, MachineDataState>
}

export interface MachineSummary {
  machineId: string
  /**
   * RAW `Machine.name`, not a display string.
   *
   * The display name is `machineLabel()` in apps/web/src/lib/machineLabel.ts, which every other
   * surface already uses. Deriving a second one here is how the Analytics table ended up showing
   * `cf755d85` while the Machines list showed `machine-cf755d85` for the same machine.
   */
  name: string | null
  mode: string
  billed: boolean
  wallClockActiveMs: number
  uptimeMs: number
  /** null when uptime is not meaningful (remote computers and providers are not containers). */
  utilization: number | null
  reportedDays: number
  missingDays: number
  lastReportAt: string | null
  collectorVersion: string | null
  consent: string
  clockSkewMs: number | null
}

/** A machine is considered stale when it has not reported for longer than this. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000

/** Modes whose machines are containers we bill for, so utilization is a meaningful number. */
const UTILIZATION_MODES = new Set(['managed', 'self'])

export interface OverviewOptions {
  userId: string
  days: number
  machineId?: string
  now?: Date
}

export async function analyticsOverview(opts: OverviewOptions): Promise<AnalyticsOverview> {
  const now = opts.now ?? new Date()
  const toDay = utcDayStart(now)
  const fromDay = new Date(toDay.getTime() - (opts.days - 1) * DAY_MS)

  const machineFilter = opts.machineId ? { machineId: opts.machineId } : {}

  const [machineRows, buckets, machineDays, states] = await Promise.all([
    prisma.machine.findMany({
      where: { userId: opts.userId, ...machineFilter, ...machineAlive },
      select: { machineId: true, name: true, hostname: true, authMode: true, billingStatus: true },
    }),
    prisma.analyticsDailyBucket.findMany({
      where: { userId: opts.userId, ...machineFilter, dayUtc: { gte: fromDay, lte: toDay } },
    }),
    prisma.analyticsDailyMachine.findMany({
      where: { userId: opts.userId, ...machineFilter, dayUtc: { gte: fromDay, lte: toDay } },
    }),
    prisma.analyticsMachineState.findMany({ where: { userId: opts.userId, ...machineFilter } }),
  ])

  const stateByMachine = new Map(states.map((s) => [s.machineId, s]))
  const rawNameOf = (machineId: string): string | null =>
    machineRows.find((m) => m.machineId === machineId)?.name ?? null

  // ---- additive rollup -------------------------------------------------------------------------
  const totals = {
    instructions: 0,
    turnsStarted: 0,
    turnsCompleted: 0,
    turnsFailed: 0,
    turnsCancelled: 0,
    turnsInputNeeded: 0,
    agentRuntimeMs: 0,
  }
  const engineTotals = new Map<string, EngineTotals>()
  const dayPoints = new Map<string, DailyPoint>()

  for (const b of buckets) {
    totals.instructions += b.instructions
    totals.turnsStarted += b.turnsStarted
    totals.turnsCompleted += b.turnsCompleted
    totals.turnsFailed += b.turnsFailed
    totals.turnsCancelled += b.turnsCancelled
    totals.turnsInputNeeded += b.turnsInputNeeded
    totals.agentRuntimeMs += Number(b.agentRuntimeMs)

    const et = engineTotals.get(b.engine) ?? {
      engine: b.engine,
      instructions: 0,
      turnsCompleted: 0,
      turnsFailed: 0,
      turnsCancelled: 0,
      turnsInputNeeded: 0,
      agentRuntimeMs: 0,
    }
    et.instructions += b.instructions
    et.turnsCompleted += b.turnsCompleted
    et.turnsFailed += b.turnsFailed
    et.turnsCancelled += b.turnsCancelled
    et.turnsInputNeeded += b.turnsInputNeeded
    et.agentRuntimeMs += Number(b.agentRuntimeMs)
    engineTotals.set(b.engine, et)

    const key = utcDayKey(b.dayUtc)
    const point = dayPoints.get(key) ?? emptyPoint(key)
    point.instructions += b.instructions
    point.turnsCompleted += b.turnsCompleted
    point.turnsFailed += b.turnsFailed
    point.turnsCancelled += b.turnsCancelled
    point.turnsInputNeeded += b.turnsInputNeeded
    point.byEngine[b.engine] = (point.byEngine[b.engine] ?? 0) + b.instructions
    dayPoints.set(key, point)
  }

  // ---- non-additive rollup ---------------------------------------------------------------------
  // These come ONLY from AnalyticsDailyMachine, at (machine, day) granularity. They are never
  // derived from the engine-split buckets, because a union and a distinct count do not decompose.
  let wallClockActiveMs = 0
  let activeAgents = 0
  const activeDays = new Set<string>()
  const perMachine = new Map<string, { wallClockActiveMs: number; uptimeMs: number; reportedDays: number }>()

  for (const md of machineDays) {
    const key = utcDayKey(md.dayUtc)
    wallClockActiveMs += Number(md.wallClockActiveMs)
    activeAgents += md.activeAgents
    if (Number(md.wallClockActiveMs) > 0) activeDays.add(key)

    const agg = perMachine.get(md.machineId) ?? { wallClockActiveMs: 0, uptimeMs: 0, reportedDays: 0 }
    agg.wallClockActiveMs += Number(md.wallClockActiveMs)
    agg.uptimeMs += Number(md.uptimeMs)
    if (md.reported) agg.reportedDays++
    perMachine.set(md.machineId, agg)

    const point = dayPoints.get(key) ?? emptyPoint(key)
    point.machineStates[md.machineId] = Number(md.wallClockActiveMs) > 0 ? 'active' : 'idle'
    dayPoints.set(key, point)
  }

  // Every (machine, day) with no record at all is explicitly `no_data`, never an implicit zero.
  const allDayKeys: string[] = []
  for (let i = 0; i < opts.days; i++) {
    allDayKeys.push(utcDayKey(new Date(fromDay.getTime() + i * DAY_MS)))
  }
  for (const key of allDayKeys) {
    const point = dayPoints.get(key) ?? emptyPoint(key)
    for (const m of machineRows) {
      if (!point.machineStates[m.machineId]) point.machineStates[m.machineId] = 'no_data'
    }
    dayPoints.set(key, point)
  }

  const terminalTurns =
    totals.turnsCompleted + totals.turnsFailed + totals.turnsCancelled + totals.turnsInputNeeded
  const enoughSample = terminalTurns >= MIN_SAMPLE_FOR_RATE

  const machines: MachineSummary[] = machineRows.map((m) => {
    const agg = perMachine.get(m.machineId) ?? { wallClockActiveMs: 0, uptimeMs: 0, reportedDays: 0 }
    const state = stateByMachine.get(m.machineId)
    const mode = m.authMode ?? 'managed'
    const utilization =
      UTILIZATION_MODES.has(mode) && agg.uptimeMs > 0
        ? agg.wallClockActiveMs / agg.uptimeMs
        : null
    return {
      machineId: m.machineId,
      name: m.name ?? null,
      mode,
      billed: m.billingStatus === 'active',
      wallClockActiveMs: agg.wallClockActiveMs,
      uptimeMs: agg.uptimeMs,
      utilization,
      reportedDays: agg.reportedDays,
      missingDays: opts.days - agg.reportedDays,
      lastReportAt: state?.lastReportAt?.toISOString() ?? null,
      collectorVersion: state?.collectorVersion ?? null,
      consent: state?.consent ?? 'unacknowledged',
      clockSkewMs: state?.clockSkewMs ?? null,
    }
  })

  const lastReportTimes = states
    .map((s) => s.lastReportAt?.getTime())
    .filter((t): t is number => typeof t === 'number')
  const lastReportAt = lastReportTimes.length ? new Date(Math.max(...lastReportTimes)) : null

  const daily = allDayKeys.map((k) => dayPoints.get(k) ?? emptyPoint(k))

  return {
    range: { fromDay: utcDayKey(fromDay), toDay: utcDayKey(toDay), days: opts.days },
    totals: {
      ...totals,
      terminalTurns,
      wallClockActiveMs,
      activeAgents,
      activeDays: activeDays.size,
      completionRate: enoughSample ? totals.turnsCompleted / terminalTurns : null,
      unproductiveShare: enoughSample
        ? (totals.turnsFailed + totals.turnsCancelled) / terminalTurns
        : null,
    },
    byEngine: [...engineTotals.values()].sort((a, b) => b.instructions - a.instructions),
    daily,
    machines,
    coverage: {
      knownMachines: machineRows.length,
      reportingMachines: machines.filter((m) => m.reportedDays > 0).length,
      staleMachines: machines.filter(
        (m) => m.lastReportAt !== null && now.getTime() - Date.parse(m.lastReportAt) > STALE_AFTER_MS,
      ).length,
      lastReportAt: lastReportAt?.toISOString() ?? null,
    },
    health: healthOf(daily, machineDays.length, now),
    notInstrumented: states
      .map((s) => ({
        machineId: s.machineId,
        machineName: rawNameOf(s.machineId),
        engines: (s.enginesPresent ?? []).filter((e) => !(s.engineCoverage ?? []).includes(e)),
      }))
      .filter((row) => row.engines.length > 0),
  }
}

function emptyPoint(day: string): DailyPoint {
  return {
    day,
    instructions: 0,
    turnsCompleted: 0,
    turnsFailed: 0,
    turnsCancelled: 0,
    turnsInputNeeded: 0,
    byEngine: {},
    machineStates: {},
  }
}

/**
 * Compare the most recent day against the account's OWN trailing baseline.
 *
 * Never against other accounts, and never against an engine ranking. Until there is enough history
 * the panel reports that it is still building rather than inventing a comparison.
 */
function healthOf(
  daily: DailyPoint[],
  recordCount: number,
  now: Date,
): AnalyticsOverview['health'] {
  const withTurns = daily.filter(
    (d) => d.turnsCompleted + d.turnsFailed + d.turnsCancelled + d.turnsInputNeeded > 0,
  )
  const baselineDays = withTurns.length
  if (recordCount === 0 || baselineDays < MIN_DAYS_FOR_BASELINE) {
    return {
      ready: false,
      baselineDays,
      requiredDays: MIN_DAYS_FOR_BASELINE,
      latestDay: null,
      latestRate: null,
      baselineRate: null,
    }
  }
  const latest = withTurns[withTurns.length - 1]
  const prior = withTurns.slice(0, -1)
  const rate = (d: DailyPoint): number => {
    const terminal = d.turnsCompleted + d.turnsFailed + d.turnsCancelled + d.turnsInputNeeded
    return terminal === 0 ? 0 : d.turnsCompleted / terminal
  }
  const priorTerminal = prior.reduce(
    (acc, d) => acc + d.turnsCompleted + d.turnsFailed + d.turnsCancelled + d.turnsInputNeeded,
    0,
  )
  const priorCompleted = prior.reduce((acc, d) => acc + d.turnsCompleted, 0)
  void now
  return {
    ready: true,
    baselineDays,
    requiredDays: MIN_DAYS_FOR_BASELINE,
    latestDay: latest.day,
    latestRate: rate(latest),
    baselineRate: priorTerminal === 0 ? null : priorCompleted / priorTerminal,
  }
}

/** Engines the UI may render as series, ranked by volume. */
export function topEngines(byEngine: EngineTotals[], limit = 5): Engine[] {
  return byEngine.slice(0, limit).map((e) => e.engine as Engine)
}


export interface ConsentMachineRow {
  machineId: string
  name: string | null
  hostname: string | null
  authMode: string | null
}

export interface ConsentStateRow {
  machineId: string
  consent: string
  collectorVersion: string | null
  lastReportAt: Date | null
  engineCoverage: string[]
  enginesPresent: string[]
}

/**
 * Build the consent view.
 *
 * A machine only HAS a collector once it has reported at least once — `loadMachineState` creates its
 * row on first contact — so a machine with NO row has never run one. Keeping those two apart is what
 * stops the dashboard telling an owner their machines are collecting when the build on them has no
 * collector in it.
 */
export function buildConsentView(machines: ConsentMachineRow[], states: ConsentStateRow[]) {
  const byId = new Map(states.map((s) => [s.machineId, s]))

  return {
    machines: machines.map((m) => {
      const s = byId.get(m.machineId)
      return {
        machineId: m.machineId,
        // Raw, like everywhere else here: the web formats it with machineLabel().
        name: m.name ?? null,
        mode: m.authMode ?? 'managed',
        // Collection is on by default; a machine with no row simply has not reported yet.
        consent: s?.consent ?? 'on',
        /** False = no collector has ever reported from this machine. */
        hasReported: s !== undefined,
        collectorVersion: s?.collectorVersion ?? null,
        lastReportAt: s?.lastReportAt?.toISOString() ?? null,
        engineCoverage: s?.engineCoverage ?? [],
        enginesPresent: s?.enginesPresent ?? [],
      }
    }),
    /** True when no machine on the account has ever run a collector. */
    noCollectorYet: states.length === 0,
  }
}
