import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const findMany = vi.hoisted(() => vi.fn())
const syncSubscription = vi.hoisted(() => vi.fn())
const suspendIfDue = vi.hoisted(() => vi.fn())
const listSubscriptions = vi.hoisted(() => vi.fn())
const hasApiKey = vi.hoisted(() => vi.fn())
const cleanupVoiceQuota = vi.hoisted(() => vi.fn())

vi.mock('../config/env.js', () => ({ env: { HARNESS_CAMPAIGN_CODE: 'ai-harness-device' } }))
vi.mock('../lib/prisma.js', () => ({
  prisma: { machine: { findMany } },
  machineAlive: { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] },
}))
vi.mock('../lib/bus.js', () => ({ pub: { set: vi.fn(), eval: vi.fn(async () => 1) } }))
vi.mock('../lib/autonomousCampaign.js', () => ({
  CAMPAIGN_REFERENCE_BATCH_SIZE: 100,
  hasCampaignSubscriptionApiKey: hasApiKey,
  listCampaignSubscriptionsByApiKey: listSubscriptions,
}))
vi.mock('../lib/autonomousEnvironment.js', () => ({
  storedAutonomousEnvironment: (value: unknown) => value === 'prod' ? 'prod' : 'stag',
}))
vi.mock('./MachineBillingService.js', () => ({
  BILLING_EXPIRY_GRACE_MS: 60 * 60 * 1000,
  machineBillingService: { syncSubscription, suspendIfDue },
}))
vi.mock('../lib/voiceQuota.js', () => ({
  voiceQuotaService: { cleanup: cleanupVoiceQuota },
}))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { machineBillingWorkerService } from './MachineBillingWorkerService.js'

const alive = { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] }

describe('machine billing worker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T00:00:00.000Z'))
    vi.clearAllMocks()
    findMany.mockResolvedValue([])
    hasApiKey.mockReturnValue(true)
    listSubscriptions.mockResolvedValue([])
    syncSubscription.mockResolvedValue({ changed: false })
    suspendIfDue.mockResolvedValue(false)
    cleanupVoiceQuota.mockResolvedValue({ released: 0, deleted: 0 })
  })

  afterEach(() => vi.useRealTimers())

  it('syncs active subscriptions while now-endAt is between -10 and +30 minutes', async () => {
    findMany
      .mockResolvedValueOnce([{
        machineId: 'machine-1',
        autonomousEnv: 'stag',
        externalDeviceId: 'device-1',
        externalSubscriptionId: 'sub-1',
      }])
      .mockResolvedValueOnce([])
    listSubscriptions.mockResolvedValue([{
      id: 'sub-1',
      campaignCode: 'ai-harness-device',
      planId: 38,
      status: 2,
      endAt: new Date('2026-08-24T00:00:00.000Z'),
    }])
    syncSubscription.mockResolvedValue({ changed: true })

    await expect(machineBillingWorkerService.runOnce()).resolves.toEqual({ synced: 1, suspended: 0 })

    expect(findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: {
        billingStatus: 'active',
        authMode: { in: ['managed', 'remote', 'provider'] },
        externalSubscriptionId: { not: null },
        externalSubscriptionEndAt: {
          gte: new Date('2026-07-23T23:30:00.000Z'),
          lte: new Date('2026-07-24T00:10:00.000Z'),
        },
        ...alive,
      },
      orderBy: { machineId: 'asc' },
      take: 100,
    }))
    expect(listSubscriptions).toHaveBeenCalledWith('stag', 'ai-harness-device', ['device-1'])
    expect(syncSubscription).toHaveBeenCalledWith('machine-1', expect.objectContaining({ id: 'sub-1' }), 'sub-1')
    expect(cleanupVoiceQuota).toHaveBeenCalledOnce()
  })

  it('checks matching subscriptions again on the next one-minute pass', async () => {
    const candidate = {
      machineId: 'machine-1',
      autonomousEnv: 'prod',
      externalDeviceId: 'device-1',
      externalSubscriptionId: 'sub-1',
    }
    findMany
      .mockResolvedValueOnce([candidate]).mockResolvedValueOnce([])
      .mockResolvedValueOnce([candidate]).mockResolvedValueOnce([])
    listSubscriptions.mockResolvedValue([{ id: 'sub-1', status: 2 }])

    await machineBillingWorkerService.runOnce()
    await machineBillingWorkerService.runOnce()

    expect(listSubscriptions).toHaveBeenCalledTimes(2)
    expect(syncSubscription).toHaveBeenCalledTimes(2)
  })

  it('keeps the one-hour local suspend fallback when upstream sync fails', async () => {
    findMany
      .mockResolvedValueOnce([{
        machineId: 'machine-sync',
        autonomousEnv: 'prod',
        externalDeviceId: 'device-sync',
        externalSubscriptionId: 'sub-sync',
      }])
      .mockResolvedValueOnce([{ machineId: 'machine-expired' }])
    listSubscriptions.mockRejectedValue(new Error('upstream unavailable'))
    suspendIfDue.mockResolvedValue(true)

    await expect(machineBillingWorkerService.runOnce()).resolves.toEqual({ synced: 0, suspended: 1 })
    expect(suspendIfDue).toHaveBeenCalledWith('machine-expired')
    expect(findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: {
        billingStatus: 'active',
        authMode: { in: ['managed', 'remote', 'provider'] },
        ...alive,
        AND: [{
          OR: [
            { externalSubscriptionEndAt: { lte: new Date('2026-07-23T23:00:00.000Z') } },
            { externalSubscriptionStatus: 5 },
          ],
        }],
      },
      take: 100,
    }))
  })

  it('skips only the environment whose API key is missing', async () => {
    findMany
      .mockResolvedValueOnce([{
        machineId: 'machine-1',
        autonomousEnv: 'stag',
        externalDeviceId: 'device-1',
        externalSubscriptionId: 'sub-1',
      }])
      .mockResolvedValueOnce([])
    hasApiKey.mockImplementation((autonomousEnv: string) => autonomousEnv === 'prod')

    await expect(machineBillingWorkerService.runOnce()).resolves.toEqual({ synced: 0, suspended: 0 })
    expect(listSubscriptions).not.toHaveBeenCalled()
    expect(syncSubscription).not.toHaveBeenCalled()
  })

  it('chunks targeted device filters at 100 reference ids', async () => {
    const candidates = Array.from({ length: 101 }, (_, index) => ({
      machineId: `machine-${index}`,
      autonomousEnv: 'prod',
      externalDeviceId: `device-${index}`,
      externalSubscriptionId: `sub-${index}`,
    }))
    findMany
      .mockResolvedValueOnce(candidates.slice(0, 100))
      .mockResolvedValueOnce(candidates.slice(100))
      .mockResolvedValueOnce([])
    listSubscriptions.mockImplementation(async (
      _autonomousEnv: string,
      _campaignCode: string,
      referenceIds: string[],
    ) => referenceIds.map((referenceId) => {
      const index = referenceId.slice('device-'.length)
      return { id: `sub-${index}`, referenceId, status: 2 }
    }))
    syncSubscription.mockResolvedValue({ changed: true })

    await expect(machineBillingWorkerService.runOnce()).resolves.toEqual({ synced: 101, suspended: 0 })

    expect(listSubscriptions).toHaveBeenCalledTimes(2)
    expect(listSubscriptions.mock.calls[0]?.[2]).toHaveLength(100)
    expect(listSubscriptions.mock.calls[1]?.[2]).toEqual(['device-100'])
  })

  it('does not apply a subscription whose returned reference id belongs to another device', async () => {
    findMany
      .mockResolvedValueOnce([{
        machineId: 'machine-1',
        autonomousEnv: 'prod',
        externalDeviceId: 'device-1',
        externalSubscriptionId: 'sub-1',
      }])
      .mockResolvedValueOnce([])
    listSubscriptions.mockResolvedValue([{
      id: 'sub-1',
      referenceId: 'device-other',
      status: 2,
    }])

    await expect(machineBillingWorkerService.runOnce()).resolves.toEqual({ synced: 0, suspended: 0 })
    expect(syncSubscription).not.toHaveBeenCalled()
  })

  it('never falls back to an unfiltered request when a machine has no external device id', async () => {
    findMany
      .mockResolvedValueOnce([{
        machineId: 'machine-1',
        autonomousEnv: 'prod',
        externalDeviceId: null,
        externalSubscriptionId: 'sub-1',
      }])
      .mockResolvedValueOnce([])

    await expect(machineBillingWorkerService.runOnce()).resolves.toEqual({ synced: 0, suspended: 0 })
    expect(listSubscriptions).not.toHaveBeenCalled()
  })
})
