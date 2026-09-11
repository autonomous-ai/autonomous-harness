/**
 * Harness Analytics ingest — the write path for `POST /api/analytics/report`.
 *
 * Design: docs/design/harness-analytics.md ("Upload contract").
 *
 * Four gates run before anything is stored, in this order, because each one can make the next
 * meaningless:
 *
 *   1. epoch    — a collector holding records from before a deletion must not resurrect them.
 *   2. consent  — nothing is stored until the owner has seen the field list.
 *   3. clock    — a machine whose clock is years off would otherwise own every chart.
 *   4. LWW      — each record key has exactly ONE writer, so `generatedAt` ordering is sufficient
 *                 and no client-chosen revision is accepted (a hostile one could pin a record).
 */
import { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import {
  CLOCK_SKEW_TOLERANCE_MS,
  RETENTION_DAYS,
  utcDayStart,
  type AnalyticsReportRequest,
  type AnalyticsReportResponse,
  type ConsentState,
  type DailyReportPayload,
  type Engine,
} from '../types/analytics.js'

const DAY_MS = 24 * 60 * 60 * 1000

export interface MachineIdentity {
  machineId: string
  userId: string
  /**
   * The machine's authMode, read from its own record.
   *
   * `mode` is a dimension of every bucket, and the client's opinion about it is ignored: the backend
   * already knows what kind of machine this is, and a collector that mislabelled itself would split
   * one machine's history across two dimensions that can never be reconciled.
   */
  mode: string
}

export class AnalyticsEpochError extends Error {
  constructor(readonly currentEpoch: number) {
    super('Report carries a stale analytics epoch')
    this.name = 'AnalyticsEpochError'
  }
}

interface StateRow {
  consent: string
  epoch: number
}

/**
 * Read the machine's collector state, creating it on first contact.
 *
 * A new row is created already switched ON: collection is the default, and the owner turns it off
 * rather than turning it on. The row's existence is also what tells the dashboard this machine runs
 * a collector at all.
 */
export async function loadMachineState({ machineId, userId }: MachineIdentity): Promise<StateRow> {
  const existing = await prisma.analyticsMachineState.findUnique({ where: { machineId } })
  if (existing) return { consent: existing.consent, epoch: existing.epoch }
  const created = await prisma.analyticsMachineState.upsert({
    where: { machineId },
    create: { machineId, userId, engineCoverage: [] },
    update: {},
  })
  return { consent: created.consent, epoch: created.epoch }
}

/** A day is storable when its date sits inside the retention window and is not in the future. */
export function dayIsInWindow(dayUtc: Date, now: Date): boolean {
  const today = utcDayStart(now).getTime()
  const day = dayUtc.getTime()
  if (Number.isNaN(day)) return false
  // One day of slack ahead: a collector on a machine that is a few hours ahead of the server may
  // legitimately have already opened tomorrow's record.
  if (day > today + DAY_MS) return false
  return day >= today - RETENTION_DAYS * DAY_MS
}

/**
 * Store one day's records if they are newer than what is already there.
 *
 * `updateMany` with a `generatedAt: { lt }` guard is the atomic half of last-write-wins: it touches
 * the row only when this report is genuinely newer. A zero count means either "no row yet" or "the
 * stored row is newer", and `create` distinguishes them — a unique-constraint violation is the
 * second case and is silently correct.
 */
async function writeDay(
  identity: MachineIdentity,
  day: DailyReportPayload,
  dayUtc: Date,
  generatedAt: Date,
  schemaVersion: number,
): Promise<void> {
  const { machineId, userId } = identity
  const md = day.machineDay
  const machineData = {
    wallClockActiveMs: BigInt(Math.max(0, Math.round(md.wallClockActiveMs))),
    activeAgents: Math.max(0, Math.round(md.activeAgents)),
    uptimeMs: BigInt(Math.max(0, Math.round(md.uptimeMs))),
    reported: md.reported !== false,
    generatedAt,
  }
  const touched = await prisma.analyticsDailyMachine.updateMany({
    where: { userId, machineId, dayUtc, generatedAt: { lt: generatedAt } },
    data: machineData,
  })
  if (touched.count === 0) {
    await prisma.analyticsDailyMachine
      .create({ data: { userId, machineId, dayUtc, ...machineData } })
      .catch(swallowUniqueViolation)
  }

  for (const bucket of day.buckets) {
    const key = {
      userId,
      machineId,
      dayUtc,
      engine: bucket.engine,
      // Server-derived, not client-chosen: see MachineIdentity.mode.
      mode: identity.mode,
      origin: bucket.origin,
      schemaVersion,
    }
    const data = {
      instructions: nonNegative(bucket.instructions),
      turnsStarted: nonNegative(bucket.turnsStarted),
      turnsCompleted: nonNegative(bucket.turnsCompleted),
      turnsFailed: nonNegative(bucket.turnsFailed),
      turnsCancelled: nonNegative(bucket.turnsCancelled),
      turnsInputNeeded: nonNegative(bucket.turnsInputNeeded),
      agentRuntimeMs: BigInt(nonNegative(bucket.agentRuntimeMs)),
      generatedAt,
    }
    const updated = await prisma.analyticsDailyBucket.updateMany({
      where: { ...key, generatedAt: { lt: generatedAt } },
      data,
    })
    if (updated.count === 0) {
      await prisma.analyticsDailyBucket.create({ data: { ...key, ...data } }).catch(swallowUniqueViolation)
    }
  }
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

/** A unique-constraint violation here means a newer record already won the race. That is the goal. */
function swallowUniqueViolation(err: unknown): void {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return
  throw err
}

/**
 * Apply one report.
 *
 * Returns what the collector needs to act on: the authoritative consent state and epoch. That
 * response IS the control channel — a headless CLI has no other way to learn it should stop.
 */
export async function ingestReport(
  identity: MachineIdentity,
  report: AnalyticsReportRequest,
  now: Date = new Date(),
): Promise<AnalyticsReportResponse> {
  const state = await loadMachineState(identity)

  // 1. Epoch. Refuse outright so the collector drops its queue instead of retrying forever.
  if (report.epoch < state.epoch) throw new AnalyticsEpochError(state.epoch)

  const base = {
    consent: state.consent as ConsentState,
    epoch: state.epoch,
    serverTime: now.toISOString(),
  }

  // 2. Consent. Nothing is stored, and nothing about the collector is recorded either.
  if (state.consent !== 'on') return { ...base, accepted: 0, quarantined: 0 }

  // 3. Clock. A report stamped far from the server's clock is quarantined whole: its day keys cannot
  //    be trusted either. The skew is still recorded, so Coverage can explain the silence.
  const generatedAt = new Date(report.generatedAt)
  const skewMs = Number.isNaN(generatedAt.getTime())
    ? null
    : now.getTime() - generatedAt.getTime()
  const clockUsable = skewMs !== null && Math.abs(skewMs) <= CLOCK_SKEW_TOLERANCE_MS

  let accepted = 0
  let quarantined = 0

  if (!clockUsable) {
    quarantined = report.days.length
  } else {
    for (const day of report.days) {
      const dayUtc = utcDayStart(day.dayUtc)
      if (!dayIsInWindow(dayUtc, now)) {
        quarantined++
        continue
      }
      // 4. Last-write-wins by generatedAt, per record.
      await writeDay(identity, day, dayUtc, generatedAt, report.schemaVersion)
      accepted++
    }
  }

  await prisma.analyticsMachineState.update({
    where: { machineId: identity.machineId },
    data: {
      collectorVersion: report.collector.version,
      engineCoverage: dedupeEngines(report.collector.engineCoverage),
      enginesPresent: dedupeEngines(report.collector.enginesPresent ?? []),
      lastReportAt: now,
      clockSkewMs: skewMs === null ? null : clampSkewForStorage(skewMs),
    },
  })

  return { ...base, accepted, quarantined }
}

function dedupeEngines(engines: Engine[]): string[] {
  return [...new Set(engines)]
}

/** Keep the stored skew inside Int32 so a nonsense clock cannot overflow the column. */
function clampSkewForStorage(skewMs: number): number {
  const limit = 2_147_483_647
  return Math.max(-limit, Math.min(limit, Math.round(skewMs)))
}
