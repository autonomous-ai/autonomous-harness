import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma.js'
import { sendSuccess } from '../utils/response.js'
import { env } from '../config/env.js'
import { machineBillingService } from '../services/MachineBillingService.js'
import { dailyTokenLimitForPlan } from '../lib/billingPlanMetadata.js'

/**
 * Subscription tiers offered at agent-create. Read-only catalog (writes happen via the seeder / DB);
 * the web create-agent picker lists these and posts the chosen `planId` to POST /api/machines.
 * SSO-access-token gated like the rest of the control API.
 */
export async function planRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/plans', async (req, reply) => {
    const [plans, free] = await Promise.all([
      prisma.subscriptionPlan.findMany({
        where: env.HARNESS_BILLING_ENABLED
          ? { autonomousEnv: req.user!.autonomousEnv, available: true }
          : { autonomousEnv: req.user!.autonomousEnv, name: 'Remote', available: true },
        orderBy: { priceUsd: 'asc' },
      }),
      env.HARNESS_BILLING_ENABLED
        ? machineBillingService.freeEligibility(req.user!.sub, req.user!.autonomousEnv)
        : Promise.resolve({ eligible: false, reason: 'Machine billing is disabled' }),
    ])
    return sendSuccess(reply, {
      plans: plans.map((p) => ({
        id: p.id,
        name: p.name,
        priceUsd: p.priceUsd,
        authMode: p.authMode,
        cpus: p.cpus,
        memory: p.memory,
        maxAgents: p.maxAgents,
        dailyTokenLimit: dailyTokenLimitForPlan(p),
        dailyVoiceLimitSeconds: Math.max(0, p.dailyVoiceLimitSeconds ?? 0),
        isDefault: p.isDefault,
        eligible: !(p.authMode === 'managed' && p.priceUsd === 0) || free.eligible,
        ...((p.authMode === 'managed' && p.priceUsd === 0 && !free.eligible)
          ? { ineligibilityReason: free.reason }
          : {}),
      })),
    })
  })
}
