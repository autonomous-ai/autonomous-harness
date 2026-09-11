import { beforeEach, describe, expect, it, vi } from 'vitest'

const planDb = vi.hoisted(() => ({
  upsert: vi.fn(),
  findMany: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
}))
const fetchPlans = vi.hoisted(() => vi.fn())

vi.mock('../../config/env.js', () => ({
  env: {
    HARNESS_BILLING_ENABLED: true,
    HARNESS_CAMPAIGN_CODE: 'ai-harness-device',
    AUTONOMOUS_BFF_URL: 'https://apiv2.autonomous.ai',
  },
}))
vi.mock('../autonomousBff.js', () => ({ fetchCampaignPlans: fetchPlans }))
vi.mock('../prisma.js', () => ({ prisma: { subscriptionPlan: planDb } }))
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))

import { ensurePlansForEnvironment } from './seed.js'

describe('campaign catalog cache isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    planDb.upsert.mockResolvedValue({})
    planDb.updateMany.mockResolvedValue({ count: 0 })
    planDb.update.mockResolvedValue({})
    fetchPlans.mockResolvedValue([])
  })

  it('hides staging cached plans when the production catalog cannot be refreshed', async () => {
    planDb.findMany.mockResolvedValue([
      { name: 'Free', available: true, externalPlanId: 37, campaignCode: 'ai-harness-device', catalogSource: 'https://apiv2.staging.autonomousdev.xyz' },
      { name: 'Pro', available: true, externalPlanId: 38, campaignCode: 'ai-harness-device', catalogSource: 'https://apiv2.staging.autonomousdev.xyz' },
      { name: 'Max', available: true, externalPlanId: 39, campaignCode: 'ai-harness-device', catalogSource: 'https://apiv2.staging.autonomousdev.xyz' },
      { name: 'Remote', available: true, externalPlanId: 40, campaignCode: 'ai-harness-device', catalogSource: 'https://apiv2.staging.autonomousdev.xyz' },
      { name: 'Provider', available: true, externalPlanId: 45, campaignCode: 'ai-harness-device', catalogSource: 'https://apiv2.staging.autonomousdev.xyz' },
    ])

    await ensurePlansForEnvironment('prod')

    expect(planDb.updateMany).toHaveBeenCalledWith({
      where: { autonomousEnv: 'prod', name: { in: ['Free', 'Pro', 'Max', 'Remote', 'Provider'] } },
      data: { available: false, isDefault: false },
    })
    expect(planDb.update).not.toHaveBeenCalled()
  })

  /** The live catalog, verified 2026-08-04: five tiers, Provider at $10/month (prod plan_id 45). */
  const FULL_CATALOG = [
    { code: 'free', id: 41, amount: 0, currency: 'USD', name: 'Free', metadata: {} },
    { code: 'pro', id: 42, amount: 20, currency: 'USD', name: 'Pro', metadata: {} },
    { code: 'max', id: 43, amount: 100, currency: 'USD', name: 'Max', metadata: {} },
    { code: 'remote', id: 44, amount: 10, currency: 'USD', name: 'Remote', metadata: {} },
    { code: 'provider', id: 45, amount: 10, currency: 'USD', name: 'Provider', metadata: {} },
  ]

  it('synchronizes Remote only when the same environment returns the complete catalog', async () => {
    fetchPlans.mockResolvedValue(FULL_CATALOG)

    await ensurePlansForEnvironment('prod')

    expect(planDb.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { autonomousEnv_name: { autonomousEnv: 'prod', name: 'Remote' } },
      update: expect.objectContaining({
        authMode: 'remote',
        priceUsd: 10,
        dailyVoiceLimitSeconds: 3600,
        externalPlanId: 44,
        available: true,
      }),
    }))
    expect(planDb.update).toHaveBeenCalledWith({
      where: { autonomousEnv_name: { autonomousEnv: 'prod', name: 'Free' } },
      data: { isDefault: true },
    })
  })

  it('synchronizes Provider with its upstream plan id', async () => {
    fetchPlans.mockResolvedValue(FULL_CATALOG)

    await ensurePlansForEnvironment('prod')

    expect(planDb.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { autonomousEnv_name: { autonomousEnv: 'prod', name: 'Provider' } },
      update: expect.objectContaining({ authMode: 'provider', priceUsd: 10, externalPlanId: 45, available: true }),
    }))
  })

  it('refuses the WHOLE catalog when one tier price disagrees with upstream', async () => {
    // The trap this guards: `completeCatalog` validates every tier's price, so a local price that
    // drifts from upstream does not disable one plan — it silently takes Free/Pro/Max/Remote down
    // with it, falling back to cache or hiding everything.
    fetchPlans.mockResolvedValue(FULL_CATALOG.map((p) => (p.code === 'provider' ? { ...p, amount: 20 } : p)))
    planDb.findMany.mockResolvedValue([]) // no cache, so the hide path runs

    await ensurePlansForEnvironment('prod')

    expect(planDb.upsert).not.toHaveBeenCalledWith(expect.objectContaining({
      where: { autonomousEnv_name: { autonomousEnv: 'prod', name: 'Remote' } },
      update: expect.objectContaining({ available: true }),
    }))
    expect(planDb.updateMany).toHaveBeenCalledWith({
      where: { autonomousEnv: 'prod', name: { in: ['Free', 'Pro', 'Max', 'Remote', 'Provider'] } },
      data: { available: false, isDefault: false },
    })
  })
})
