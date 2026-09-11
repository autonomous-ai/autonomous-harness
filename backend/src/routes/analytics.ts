/**
 * Harness Analytics API.
 *
 * Two different credentials meet in this file, deliberately:
 *
 *   POST /api/analytics/report      machine api key  — the collector write path. In the auth
 *                                                      middleware skip-list; gated by `machineAuth`.
 *   GET  /api/analytics/overview    SSO access token — the dashboard read path.
 *   GET  /api/analytics/consent     SSO access token — collector state for the consent screen.
 *   POST /api/analytics/consent     SSO access token — turn collection on/off, account or machine.
 *   POST /api/analytics/delete      SSO access token — erase and bump the epoch.
 *
 * Design: docs/design/harness-analytics.md
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { prisma, machineAlive } from '../lib/prisma.js'
import { machineIdFromKey } from '../utils/crypto.js'
import { validateBody, validateQuery } from '../middlewares/validation.js'
import { sendSuccess, sendError } from '../utils/response.js'
import { logger } from '../utils/logger.js'
import { AnalyticsEpochError, ingestReport } from '../lib/analyticsIngest.js'
import { analyticsOverview, buildConsentView } from '../lib/analyticsQuery.js'
import {
  ANALYTICS_SCHEMA_VERSION,
  CONSENT_STATES,
  ENGINES,
  MAX_BUCKETS_PER_DAY,
  MAX_DAYS_PER_REPORT,
  MODES,
  ORIGINS,
  type AnalyticsReportRequest,
} from '../types/analytics.js'

/** 512 KB is far above a real backlog flush and far below anything that could hurt the process. */
const REPORT_BODY_LIMIT = 512 * 1024

/** Per-machine write budget. A healthy collector uploads on a timer, not in a loop. */
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 30

const rateBuckets = new Map<string, { count: number; resetAt: number }>()

export function rateLimitAllows(machineId: string, now = Date.now()): boolean {
  const bucket = rateBuckets.get(machineId)
  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(machineId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return true
  }
  if (bucket.count >= RATE_LIMIT_MAX) return false
  bucket.count++
  return true
}

/** Test seam: the limiter is process-local by design (one more report is not worth a Redis hop). */
export function resetRateLimits(): void {
  rateBuckets.clear()
}

const engineEnum = z.enum(ENGINES)

const bucketSchema = z.object({
  engine: engineEnum,
  mode: z.enum(MODES),
  origin: z.enum(ORIGINS),
  instructions: z.number().int().min(0),
  turnsStarted: z.number().int().min(0),
  turnsCompleted: z.number().int().min(0),
  turnsFailed: z.number().int().min(0),
  turnsCancelled: z.number().int().min(0),
  turnsInputNeeded: z.number().int().min(0),
  agentRuntimeMs: z.number().min(0),
})

const daySchema = z.object({
  dayUtc: z.string().min(8),
  machineDay: z.object({
    wallClockActiveMs: z.number().min(0),
    activeAgents: z.number().int().min(0),
    uptimeMs: z.number().min(0),
    reported: z.boolean(),
  }),
  buckets: z.array(bucketSchema).max(MAX_BUCKETS_PER_DAY),
})

const reportSchema = z.object({
  schemaVersion: z.number().int().min(1).max(ANALYTICS_SCHEMA_VERSION),
  epoch: z.number().int().min(0),
  generatedAt: z.string().min(8),
  collector: z.object({
    version: z.string().min(1).max(64),
    engineCoverage: z.array(engineEnum).max(ENGINES.length),
    enginesPresent: z.array(engineEnum).max(ENGINES.length).optional(),
  }),
  days: z.array(daySchema).max(MAX_DAYS_PER_REPORT),
})

const overviewQuery = z.object({
  days: z.coerce.number().int().min(1).max(400).default(30),
  machineId: z.string().min(1).optional(),
})

const consentBody = z.object({
  consent: z.enum(CONSENT_STATES),
  /** Omitted = apply to every machine on the account. */
  machineId: z.string().min(1).optional(),
})

interface MachineCtx { machineId: string; userId: string; mode: string }
type WithMachine = FastifyRequest & { machineCtx?: MachineCtx }

/**
 * Resolve the reporting machine from its api key. Identity is derived server-side and the body's
 * opinion about who it is, if any, is ignored — a client never chooses a `userId`.
 */
async function machineAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const key = req.headers['x-api-key']
  if (typeof key !== 'string' || !key) {
    sendError(reply, 'Missing machine api key', 'UNAUTHORIZED', 401)
    return
  }
  const machineId = machineIdFromKey(key)
  const binding = await prisma.machine.findUnique({ where: { machineId } })
  if (!binding || binding.deletedAt) {
    sendError(reply, 'Unknown machine', 'NO_MACHINE', 404)
    return
  }
  if (!rateLimitAllows(machineId)) {
    sendError(reply, 'Too many analytics reports', 'RATE_LIMITED', 429)
    return
  }
  ;(req as WithMachine).machineCtx = { machineId, userId: binding.userId, mode: binding.authMode ?? 'managed' }
}

async function ownedMachineIds(userId: string): Promise<string[]> {
  const rows = await prisma.machine.findMany({
    where: { userId, ...machineAlive },
    select: { machineId: true },
  })
  return rows.map((r) => r.machineId)
}

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  // ---- collector write path (machine api key) ---------------------------------------------------
  app.post<{ Body: z.infer<typeof reportSchema> }>(
    '/api/analytics/report',
    { bodyLimit: REPORT_BODY_LIMIT, preHandler: [machineAuth, validateBody(reportSchema)] },
    async (req, reply) => {
      const ctx = (req as WithMachine).machineCtx!
      try {
        const body = req.body as AnalyticsReportRequest
        const result = await ingestReport(ctx, {
          ...body,
          collector: { ...body.collector, enginesPresent: body.collector.enginesPresent ?? [] },
        })
        return sendSuccess(reply, result)
      } catch (err) {
        if (err instanceof AnalyticsEpochError) {
          // 409 is the collector's signal to drop its local queue: this history was deleted.
          return sendError(
            reply,
            `Analytics history was reset; current epoch is ${err.currentEpoch}`,
            'ANALYTICS_EPOCH_STALE',
            409,
          )
        }
        logger.error('POST /api/analytics/report failed', err, { machineId: ctx.machineId })
        return sendError(reply, 'Could not store analytics report', 'ANALYTICS_INGEST_FAILED', 500)
      }
    },
  )

  // ---- dashboard read path (SSO) ----------------------------------------------------------------
  app.get<{ Querystring: z.infer<typeof overviewQuery> }>(
    '/api/analytics/overview',
    { preHandler: [validateQuery(overviewQuery)] },
    async (req, reply) => {
      const userId = req.user?.sub
      if (!userId) return sendError(reply, 'Unauthorized', 'UNAUTHORIZED', 401)
      const { days, machineId } = req.query
      if (machineId) {
        const owned = await prisma.machine.findFirst({
          where: { machineId, userId, ...machineAlive },
          select: { machineId: true },
        })
        if (!owned) return sendError(reply, 'Unknown machine', 'NO_MACHINE', 404)
      }
      const overview = await analyticsOverview({ userId, days, machineId })
      return sendSuccess(reply, overview)
    },
  )

  // ---- consent surfaces (SSO) -------------------------------------------------------------------
  app.get('/api/analytics/consent', async (req, reply) => {
    const userId = req.user?.sub
    if (!userId) return sendError(reply, 'Unauthorized', 'UNAUTHORIZED', 401)
    const [machines, states] = await Promise.all([
      prisma.machine.findMany({
        where: { userId, ...machineAlive },
        select: { machineId: true, name: true, hostname: true, authMode: true },
      }),
      prisma.analyticsMachineState.findMany({ where: { userId } }),
    ])
    return sendSuccess(reply, buildConsentView(machines, states))
  })

  app.post<{ Body: z.infer<typeof consentBody> }>(
    '/api/analytics/consent',
    { preHandler: [validateBody(consentBody)] },
    async (req, reply) => {
      const userId = req.user?.sub
      if (!userId) return sendError(reply, 'Unauthorized', 'UNAUTHORIZED', 401)
      const { consent, machineId } = req.body
      const targets = machineId ? [machineId] : await ownedMachineIds(userId)
      if (machineId && !(await ownedMachineIds(userId)).includes(machineId)) {
        return sendError(reply, 'Unknown machine', 'NO_MACHINE', 404)
      }
      for (const target of targets) {
        await prisma.analyticsMachineState.upsert({
          where: { machineId: target },
          create: { machineId: target, userId, consent, engineCoverage: [], enginesPresent: [] },
          update: { consent },
        })
      }
      logger.info('analytics consent updated', { userId, consent, machines: targets.length })
      return sendSuccess(reply, { consent, machines: targets.length })
    },
  )

  /**
   * Erase every stored figure for the account and bump the epoch.
   *
   * The bump is the durable half: without it a collector still holding queued records would simply
   * upload them again on its next attempt, and the delete would be cosmetic.
   */
  app.post('/api/analytics/delete', async (req, reply) => {
    const userId = req.user?.sub
    if (!userId) return sendError(reply, 'Unauthorized', 'UNAUTHORIZED', 401)
    const [buckets, machineDays] = await Promise.all([
      prisma.analyticsDailyBucket.deleteMany({ where: { userId } }),
      prisma.analyticsDailyMachine.deleteMany({ where: { userId } }),
    ])
    const states = await prisma.analyticsMachineState.findMany({ where: { userId } })
    for (const state of states) {
      await prisma.analyticsMachineState.update({
        where: { machineId: state.machineId },
        data: { epoch: state.epoch + 1, lastReportAt: null },
      })
    }
    logger.info('analytics data deleted', {
      userId,
      buckets: buckets.count,
      machineDays: machineDays.count,
      machines: states.length,
    })
    return sendSuccess(reply, {
      deletedBuckets: buckets.count,
      deletedMachineDays: machineDays.count,
      machines: states.length,
    })
  })
}
