import type { Prisma } from '@prisma/client'
import { env } from '../../config/env.js'
import {
  autonomousEnvironmentConfig,
  autonomousEnvironments,
  type AutonomousEnvironment,
} from '../autonomousEnvironment.js'
import { fetchCampaignPlans, type CampaignPlan } from '../autonomousBff.js'
import { prisma } from '../prisma.js'
import { logger } from '../../utils/logger.js'

const LEGACY_TIERS = [
  { name: 'Self-Auth', authMode: 'self', priceUsd: 10 },
  { name: 'Managed', authMode: 'managed', priceUsd: 30 },
] as const

const CAMPAIGN_TIERS = {
  free: { name: 'Free', cpus: '1', memory: '1g', maxAgents: 3, priceUsd: 0, dailyVoiceLimitSeconds: 10 * 60, authMode: 'managed', isDefault: true },
  pro: { name: 'Pro', cpus: '1', memory: '2g', maxAgents: 10, priceUsd: 20, dailyVoiceLimitSeconds: 30 * 60, authMode: 'managed', isDefault: false },
  max: { name: 'Max', cpus: '2', memory: '4g', maxAgents: 50, priceUsd: 100, dailyVoiceLimitSeconds: 0, authMode: 'managed', isDefault: false },
  remote: { name: 'Remote', cpus: '1', memory: '2g', maxAgents: 1, priceUsd: 10, dailyVoiceLimitSeconds: 60 * 60, authMode: 'remote', isDefault: false },
  // A provider machine runs NO container of ours — the model and the machine are the third party's.
  // cpus/memory/maxAgents are therefore inert rather than plausible-looking lies: projects come
  // from the provider's own agent list, so a local cap would mean nothing.
  //
  // ⚠ priceUsd MUST equal the upstream amount. `completeCatalog` below validates every tier's price
  // against the campaign catalog and returns undefined on ANY mismatch — which falls back to the
  // cached catalog, or hides EVERY campaign plan when there is no cache. A wrong number here breaks
  // Free/Pro/Max/Remote too, not just this row. Upstream: $10/month (prod plan_id 45, staging 41).
  provider: { name: 'Provider', cpus: '0', memory: '0', maxAgents: 0, priceUsd: 10, dailyVoiceLimitSeconds: 60 * 60, authMode: 'provider', isDefault: false },
} as const

function planKey(autonomousEnv: AutonomousEnvironment, name: string) {
  return { autonomousEnv_name: { autonomousEnv, name } }
}

function catalogSource(autonomousEnv: AutonomousEnvironment): string {
  return new URL(autonomousEnvironmentConfig(autonomousEnv).bffUrl).origin
}

async function seedLocalPlans(autonomousEnv: AutonomousEnvironment): Promise<void> {
  for (const tier of LEGACY_TIERS) {
    await prisma.subscriptionPlan.upsert({
      where: planKey(autonomousEnv, tier.name),
      update: { authMode: tier.authMode, dailyVoiceLimitSeconds: 0, isDefault: false, available: false },
      create: {
        ...tier,
        autonomousEnv,
        cpus: '1', memory: '2g', maxAgents: 1,
        authMode: tier.authMode, dailyVoiceLimitSeconds: 0, isDefault: false, available: false,
      },
    })
  }
  // Seed backend-owned resource/voice policy independently of the upstream catalog. Do not overwrite
  // availability or external ids on an existing row: a same-environment cache stays usable while the
  // provider is temporarily unavailable.
  for (const tier of Object.values(CAMPAIGN_TIERS)) {
    await prisma.subscriptionPlan.upsert({
      where: planKey(autonomousEnv, tier.name),
      update: {
        cpus: tier.cpus,
        memory: tier.memory,
        maxAgents: tier.maxAgents,
        priceUsd: tier.priceUsd,
        authMode: tier.authMode,
        dailyVoiceLimitSeconds: tier.dailyVoiceLimitSeconds,
      },
      create: {
        ...tier,
        autonomousEnv,
        available: false,
        isDefault: false,
      },
    })
  }
}

function completeCatalog(plans: CampaignPlan[]): Map<keyof typeof CAMPAIGN_TIERS, CampaignPlan> | undefined {
  const out = new Map<keyof typeof CAMPAIGN_TIERS, CampaignPlan>()
  for (const plan of plans) out.set(plan.code, plan)
  const valid = (Object.entries(CAMPAIGN_TIERS) as Array<[keyof typeof CAMPAIGN_TIERS, typeof CAMPAIGN_TIERS[keyof typeof CAMPAIGN_TIERS]]>)
    .every(([code, expected]) => out.get(code)?.amount === expected.priceUsd && out.get(code)?.currency === 'USD')
  return out.size === Object.keys(CAMPAIGN_TIERS).length && valid ? out : undefined
}

async function hasCachedCatalog(autonomousEnv: AutonomousEnvironment): Promise<boolean> {
  const source = catalogSource(autonomousEnv)
  const rows = await prisma.subscriptionPlan.findMany({
    where: {
      autonomousEnv,
      name: { in: Object.values(CAMPAIGN_TIERS).map((x) => x.name) },
    },
    select: {
      name: true,
      priceUsd: true,
      authMode: true,
      available: true,
      externalPlanId: true,
      campaignCode: true,
      catalogSource: true,
    },
  })
  return rows.length === Object.keys(CAMPAIGN_TIERS).length && rows.every((plan) => {
    const expected = Object.values(CAMPAIGN_TIERS).find((tier) => tier.name === plan.name)
    return !!expected &&
      plan.priceUsd === expected.priceUsd &&
      plan.authMode === expected.authMode &&
      plan.available === true &&
      !!plan.externalPlanId &&
      plan.campaignCode === env.HARNESS_CAMPAIGN_CODE &&
      plan.catalogSource === source
  })
}

async function exposeRollbackRemote(autonomousEnv: AutonomousEnvironment): Promise<void> {
  await prisma.subscriptionPlan.updateMany({
    where: {
      autonomousEnv,
      name: { in: Object.values(CAMPAIGN_TIERS).map((x) => x.name) },
    },
    data: { available: false, isDefault: false },
  })
  await prisma.subscriptionPlan.update({
    where: planKey(autonomousEnv, 'Remote'),
    data: { priceUsd: 0, available: true, isDefault: true },
  })
}

async function hideCampaignPlans(autonomousEnv: AutonomousEnvironment): Promise<void> {
  await prisma.subscriptionPlan.updateMany({
    where: {
      autonomousEnv,
      name: { in: Object.values(CAMPAIGN_TIERS).map((x) => x.name) },
    },
    data: { available: false, isDefault: false },
  })
}

/** Synchronize one upstream catalog without ever reading/writing the other environment's rows. */
export async function ensurePlansForEnvironment(autonomousEnv: AutonomousEnvironment): Promise<void> {
  try {
    await seedLocalPlans(autonomousEnv)
    if (!env.HARNESS_BILLING_ENABLED) {
      await exposeRollbackRemote(autonomousEnv)
      logger.info('machine billing disabled; only Remote is available', { autonomousEnv })
      return
    }

    let catalog: Map<keyof typeof CAMPAIGN_TIERS, CampaignPlan> | undefined
    try {
      catalog = completeCatalog(await fetchCampaignPlans(autonomousEnv))
    } catch (err) {
      logger.warn('campaign plan sync failed; retaining cached catalog', {
        autonomousEnv,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    if (!catalog) {
      if (!(await hasCachedCatalog(autonomousEnv))) await hideCampaignPlans(autonomousEnv)
      return
    }

    const source = catalogSource(autonomousEnv)
    const syncedAt = new Date()
    for (const [code, local] of Object.entries(CAMPAIGN_TIERS) as Array<[keyof typeof CAMPAIGN_TIERS, typeof CAMPAIGN_TIERS[keyof typeof CAMPAIGN_TIERS]]>) {
      const external = catalog.get(code)!
      await prisma.subscriptionPlan.upsert({
        where: planKey(autonomousEnv, local.name),
        update: {
          cpus: local.cpus, memory: local.memory, maxAgents: local.maxAgents,
          priceUsd: external.amount, dailyVoiceLimitSeconds: local.dailyVoiceLimitSeconds,
          authMode: local.authMode, available: true,
          externalPlanId: external.id, externalPlanName: external.name,
          campaignCode: env.HARNESS_CAMPAIGN_CODE, catalogSource: source,
          externalMetadata: external.metadata as Prisma.InputJsonValue,
          catalogSyncedAt: syncedAt, isDefault: false,
        },
        create: {
          autonomousEnv,
          name: local.name, cpus: local.cpus, memory: local.memory,
          maxAgents: local.maxAgents, priceUsd: external.amount,
          dailyVoiceLimitSeconds: local.dailyVoiceLimitSeconds,
          authMode: local.authMode, available: true, externalPlanId: external.id,
          externalPlanName: external.name, campaignCode: env.HARNESS_CAMPAIGN_CODE,
          catalogSource: source,
          externalMetadata: external.metadata as Prisma.InputJsonValue,
          catalogSyncedAt: syncedAt, isDefault: false,
        },
      })
    }
    await prisma.subscriptionPlan.updateMany({
      where: { autonomousEnv, isDefault: true },
      data: { isDefault: false },
    })
    await prisma.subscriptionPlan.update({
      where: planKey(autonomousEnv, CAMPAIGN_TIERS.free.name),
      data: { isDefault: true },
    })
    logger.info('campaign subscription plans synchronized', {
      autonomousEnv,
      campaignCode: env.HARNESS_CAMPAIGN_CODE,
      catalogSource: source,
      plans: [...catalog.values()].map((plan) => ({ code: plan.code, id: plan.id, amount: plan.amount })),
    })
  } catch (err) {
    logger.warn('ensurePlansForEnvironment failed (continuing)', {
      autonomousEnv,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Worker startup refreshes both independent upstream catalogs. */
export async function ensurePlans(): Promise<void> {
  for (const autonomousEnv of autonomousEnvironments) {
    await ensurePlansForEnvironment(autonomousEnv)
  }
}
