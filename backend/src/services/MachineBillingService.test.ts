import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  transaction: vi.fn(),
  bindingFind: vi.fn(),
  bindingUpdate: vi.fn(),
  bindingUpdateMany: vi.fn(),
  planFind: vi.fn(),
  planFindMany: vi.fn(),
  planFindFirst: vi.fn(),
  attemptFindFirst: vi.fn(),
  attemptCreate: vi.fn(),
  attemptUpdate: vi.fn(),
  attemptUpdateMany: vi.fn(),
  managerFind: vi.fn(),
  freeFind: vi.fn(),
  freeCreate: vi.fn(),
  freeUpdate: vi.fn(),
  freeDeleteMany: vi.fn(),
}))
const bff = vi.hoisted(() => ({
  getDevice: vi.fn(),
  listSubscriptions: vi.fn(),
  createDevice: vi.fn(),
  createCheckout: vi.fn(),
  fireDevice: vi.fn(),
  cancelSubscription: vi.fn(),
  renewSubscription: vi.fn(),
}))
const provision = vi.hoisted(() => vi.fn())
const publishDown = vi.hoisted(() => vi.fn())
const encrypt = vi.hoisted(() => vi.fn(() => 'encrypted-key'))
const voiceSnapshot = vi.hoisted(() => vi.fn())

vi.mock('../config/env.js', () => ({
  env: {
    HARNESS_CAMPAIGN_CODE: 'ai-harness-device',
    HARNESS_CHECKOUT_CALLBACK_URL: '',
  },
}))
vi.mock('../lib/prisma.js', () => ({
  // The real value — `suspendIfDue`'s guard is asserted below, so a stub would make that assertion
  // check the stub instead of the filter.
  machineAlive: { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] },
  prisma: {
    $transaction: db.transaction,
    machine: { findUnique: db.bindingFind, update: db.bindingUpdate, updateMany: db.bindingUpdateMany },
    subscriptionPlan: { findUnique: db.planFind, findMany: db.planFindMany, findFirst: db.planFindFirst },
    machineCheckoutAttempt: {
      findFirst: db.attemptFindFirst,
      create: db.attemptCreate,
      update: db.attemptUpdate,
      updateMany: db.attemptUpdateMany,
    },
    machineFreeEntitlement: {
      findUnique: db.freeFind,
      create: db.freeCreate,
      update: db.freeUpdate,
      deleteMany: db.freeDeleteMany,
    },
    manager: { findUnique: db.managerFind },
  },
}))
vi.mock('../lib/autonomousBff.js', () => ({
  getCampaignDevice: bff.getDevice,
  listCampaignSubscriptions: bff.listSubscriptions,
  createCampaignDevice: bff.createDevice,
  createCheckout: bff.createCheckout,
  fireCampaignDevice: bff.fireDevice,
  cancelCampaignSubscription: bff.cancelSubscription,
  renewCampaignSubscription: bff.renewSubscription,
}))
vi.mock('../lib/bus.js', () => ({
  pub: { set: vi.fn(async () => 'OK'), eval: vi.fn(async () => 1) },
  publishDeviceMachineListChanged: vi.fn(async () => undefined),
  publishDown,
}))
vi.mock('../lib/machineCredential.js', () => ({ encryptMachineCredential: encrypt }))
vi.mock('../lib/managers.js', () => ({ selectManagerId: vi.fn(async () => ({ managerId: 'mgr-2' })) }))
vi.mock('../lib/provision.js', () => ({ provisionViaManager: provision }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../lib/voiceQuota.js', () => ({
  voiceQuotaService: { snapshotForMachine: voiceSnapshot },
}))

import { machineBillingService } from './MachineBillingService.js'
import { AppError } from '../errors/index.js'

const future = new Date(Date.now() + 86_400_000)
const overdue = new Date(Date.now() - 7_200_000)
const withinGrace = new Date(Date.now() - 1_800_000)
const binding = {
  id: 'binding-id', userId: 'user-1', machineId: 'a'.repeat(32), apiKey: 'agent-key',
  managerId: 'mgr-1', workspaceId: null, planId: 'plan-pro', authMode: 'managed', name: null,
  autonomousEnv: 'prod',
  billingStatus: 'pending', externalDeviceId: 'device-1', externalSubscriptionId: null,
  externalSubscriptionStatus: null, externalSubscriptionEndAt: null, externalSubscriptionCancelledAt: null,
  billingActivatedAt: null, billingError: null, billingErrorAt: null, llmApiKeyEncrypted: null,
  deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
}
const proPlan = {
  id: 'plan-pro', name: 'Pro', cpus: '1', memory: '2g', maxAgents: 10, priceUsd: 20,
  dailyVoiceLimitSeconds: 1800,
  autonomousEnv: 'prod',
  authMode: 'managed', isDefault: false, available: true, externalPlanId: 38,
  externalPlanName: 'Pro', campaignCode: 'ai-harness-device', externalMetadata: null,
  catalogSource: 'autonomous-bff', catalogSyncedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
}
const maxPlan = { ...proPlan, id: 'plan-max', name: 'Max', priceUsd: 100, dailyVoiceLimitSeconds: 0, externalPlanId: 39 }
const freePlan = { ...proPlan, id: 'plan-free', name: 'Free', priceUsd: 0, dailyVoiceLimitSeconds: 600, externalPlanId: 37 }
const remotePlan = {
  ...proPlan,
  id: 'plan-remote',
  name: 'Remote',
  priceUsd: 10,
  externalPlanId: 40,
  dailyVoiceLimitSeconds: 3600,
  authMode: 'remote',
}
const attempt = {
  id: 'attempt-1', machineId: binding.machineId, userId: binding.userId, externalPlanId: 38,
  autonomousEnv: 'prod',
  externalDeviceId: 'device-1', sessionId: 'operation-1', operationId: 'operation-1',
  operationType: 'subscribe', sourcePlanId: 'plan-pro', targetPlanId: 'plan-pro',
  providerSessionId: 'checkout-1', redirectUrl: 'https://checkout.example/session',
  checkoutEmail: 'owner@example.com', successUrl: 'http://localhost/success',
  failureUrl: 'http://localhost/failure', webOrigin: 'http://localhost:3000',
  status: 'pending', error: null, completedAt: null, createdAt: new Date(), updatedAt: new Date(),
}

function planById(id?: string) {
  if (id === freePlan.id) return freePlan
  if (id === maxPlan.id) return maxPlan
  if (id === remotePlan.id) return remotePlan
  return proPlan
}

function exactSubscription(planId = 38, status = 2) {
  return {
    id: 'sub-1', campaignCode: 'ai-harness-device', referenceId: 'device-1',
    planId, status, endAt: future,
  }
}

describe('machine billing lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    db.bindingFind.mockResolvedValue(binding)
    db.bindingUpdate.mockImplementation(async ({ data }: { data: object }) => ({ ...binding, ...data }))
    db.bindingUpdateMany.mockResolvedValue({ count: 1 })
    db.planFind.mockImplementation(async ({ where }: { where: { id?: string } }) => planById(where.id))
    db.planFindMany.mockResolvedValue([freePlan, proPlan, maxPlan])
    db.planFindFirst.mockResolvedValue(proPlan)
    // Checkout creation/pending-view queries return no operation by default. Legacy/new callback
    // lookups use OR and resolve the immutable operation fixture.
    db.attemptFindFirst.mockImplementation(async ({ where }: { where?: { OR?: unknown } }) => where?.OR ? attempt : null)
    db.attemptCreate.mockImplementation(async ({ data }: { data: object }) => ({ id: 'attempt-new', ...data }))
    db.attemptUpdate.mockResolvedValue(attempt)
    db.attemptUpdateMany.mockResolvedValue({ count: 1 })
    db.transaction.mockImplementation(async (action: (tx: unknown) => Promise<unknown>) => action({
      machine: { update: db.bindingUpdate },
      machineFreeEntitlement: {
        findUnique: db.freeFind,
        create: db.freeCreate,
        update: db.freeUpdate,
      },
    }))
    db.managerFind.mockResolvedValue({ managerId: 'mgr-1', lastSeenAt: new Date() })
    db.freeFind.mockResolvedValue(null)
    db.freeCreate.mockResolvedValue({})
    db.freeUpdate.mockResolvedValue({})
    db.freeDeleteMany.mockResolvedValue({ count: 1 })
    bff.listSubscriptions.mockResolvedValue([])
    bff.createDevice.mockResolvedValue('device-1')
    bff.createCheckout.mockResolvedValue({ sessionId: 'checkout-1', redirectUrl: 'https://checkout.example/session' })
    bff.fireDevice.mockResolvedValue(undefined)
    bff.cancelSubscription.mockResolvedValue(undefined)
    bff.renewSubscription.mockResolvedValue(undefined)
    publishDown.mockResolvedValue(undefined)
    provision.mockResolvedValue({})
    voiceSnapshot.mockResolvedValue({
      machineId: binding.machineId,
      dayKey: '2026-07-24',
      limitSeconds: 1800,
      usedSeconds: 380,
      remainingSeconds: 1420,
      resetAt: '2026-07-25T00:00:00.000Z',
    })
  })

  it('creates an immutable operation before checkout and never provisions a pending machine', async () => {
    db.bindingFind.mockResolvedValue({ ...binding, externalDeviceId: null })

    const result = await machineBillingService.beginCheckout(
      binding.machineId, binding.userId, 'owner@example.com', 'sso-token', 'http://localhost:3000',
    )

    expect(result).toMatchObject({
      operationId: expect.any(String), action: 'subscribe',
      sessionId: 'checkout-1', redirectUrl: 'https://checkout.example/session',
    })
    expect(bff.createDevice).toHaveBeenCalledWith('prod', 'sso-token')
    expect(db.attemptCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        operationId: result!.operationId,
        sessionId: result!.operationId,
        targetPlanId: 'plan-pro',
        externalPlanId: 38,
      }),
    }))
    expect(provision).not.toHaveBeenCalled()
  })

  it('activates a paid Remote machine without an llm key, manager reservation, or Docker', async () => {
    const remoteBinding = {
      ...binding,
      managerId: '',
      planId: remotePlan.id,
      authMode: 'remote',
      billingStatus: 'pending',
    }
    const remoteAttempt = {
      ...attempt,
      externalPlanId: 40,
      sourcePlanId: remotePlan.id,
      targetPlanId: remotePlan.id,
    }
    db.bindingFind.mockResolvedValue(remoteBinding)
    db.attemptFindFirst.mockResolvedValue(remoteAttempt)
    db.bindingUpdate.mockImplementation(async ({ data }: { data: object }) => ({ ...remoteBinding, ...data }))
    bff.getDevice.mockResolvedValue({ deviceId: 'device-1', subscription: exactSubscription(40) })

    await expect(machineBillingService.complete(
      remoteBinding.machineId, remoteBinding.userId, 'sso-token', 'operation-1', 'success',
    )).resolves.toMatchObject({ billingStatus: 'active' })

    expect(db.bindingUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        managerId: '', planId: remotePlan.id, billingStatus: 'active', llmApiKeyEncrypted: null,
      }),
    }))
    expect(encrypt).not.toHaveBeenCalled()
    expect(db.managerFind).not.toHaveBeenCalled()
    expect(provision).not.toHaveBeenCalled()
  })

  it('supersedes pending operations and creates a fresh checkout for every click', async () => {
    const result = await machineBillingService.beginCheckout(
      binding.machineId, binding.userId, 'owner@example.com', 'sso-token', 'http://localhost:3000',
    )

    expect(result).toMatchObject({
      operationId: expect.any(String), sessionId: 'checkout-1',
      redirectUrl: 'https://checkout.example/session', action: 'subscribe',
    })
    expect(result.operationId).not.toBe('operation-1')
    expect(db.attemptUpdateMany).toHaveBeenCalledWith({
      where: { machineId: binding.machineId, status: { in: ['creating', 'pending'] } },
      data: { status: 'cancelled', error: 'Superseded by a newer checkout' },
    })
    expect(bff.createCheckout).toHaveBeenCalledOnce()
    expect(db.attemptCreate).toHaveBeenCalledOnce()
  })

  it('creates a hosted Free card setup without claiming or provisioning before the callback', async () => {
    const pendingFree = { ...binding, planId: freePlan.id }
    db.bindingFind.mockResolvedValue(pendingFree)
    db.freeFind.mockResolvedValue({
      userId: binding.userId,
      machineId: binding.machineId,
      status: 'reserved',
      claimedAt: null,
    })
    const checkout = await machineBillingService.beginCheckout(
      binding.machineId,
      binding.userId,
      'owner@example.com',
      'sso-token',
      'http://localhost:3000',
    )

    expect(checkout).toMatchObject({
      operationId: expect.any(String), action: 'subscribe',
      sessionId: 'checkout-1', redirectUrl: 'https://checkout.example/session',
    })
    expect(bff.createCheckout).toHaveBeenCalledWith('prod', 'sso-token', expect.objectContaining({
      planId: 37,
      referenceId: 'device-1',
      successUrl: expect.stringContaining(`machineId=${binding.machineId}`),
    }))
    expect(db.attemptCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        operationId: checkout.operationId,
        targetPlanId: freePlan.id,
        externalPlanId: 37,
      }),
    }))
    expect(db.freeUpdate).not.toHaveBeenCalled()
    expect(encrypt).not.toHaveBeenCalled()
    expect(provision).not.toHaveBeenCalled()
  })

  it('keeps Free pending when the provider does not return a hosted card setup URL', async () => {
    db.bindingFind.mockResolvedValue({ ...binding, planId: freePlan.id })
    bff.createCheckout.mockResolvedValue({ sessionId: 'checkout-1' })

    await expect(machineBillingService.beginCheckout(
      binding.machineId,
      binding.userId,
      'owner@example.com',
      'sso-token',
      'http://localhost:3000',
    )).rejects.toMatchObject({ code: 'BILLING_UPSTREAM_ERROR' })

    expect(db.attemptUpdate).toHaveBeenCalledWith({
      where: { id: 'attempt-new' },
      data: {
        status: 'failed',
        error: 'Autonomous billing service did not return a Free card setup URL',
      },
    })
    expect(db.bindingUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { machineId: binding.machineId, billingStatus: 'pending' },
    }))
    expect(db.freeUpdate).not.toHaveBeenCalled()
    expect(provision).not.toHaveBeenCalled()
  })

  it('creates a fresh plan-change checkout instead of exposing an existing pending attempt', async () => {
    db.bindingFind.mockResolvedValue({
      ...binding,
      billingStatus: 'active',
      externalSubscriptionStatus: 2,
      externalSubscriptionEndAt: future,
    })

    const result = await machineBillingService.beginPlanCheckout(
      binding.machineId,
      binding.userId,
      maxPlan.id,
      'owner@example.com',
      'sso-token',
      'https://app.example.com',
    )

    expect(result).toMatchObject({
      operationId: expect.any(String),
      sessionId: 'checkout-1',
      action: 'upgrade',
    })
    expect(db.attemptUpdateMany).toHaveBeenCalledWith({
      where: { machineId: binding.machineId, status: { in: ['creating', 'pending'] } },
      data: { status: 'cancelled', error: 'Superseded by a newer checkout' },
    })
    expect(db.attemptCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        operationType: 'plan_change',
        sourcePlanId: proPlan.id,
        targetPlanId: maxPlan.id,
      }),
    }))
    expect(bff.createCheckout).toHaveBeenCalledOnce()
  })

  it('never allows an active Remote machine to change plans', async () => {
    db.bindingFind.mockResolvedValue({
      ...binding,
      managerId: '',
      planId: remotePlan.id,
      authMode: 'remote',
      billingStatus: 'active',
      externalSubscriptionStatus: 2,
    })

    await expect(machineBillingService.beginPlanCheckout(
      binding.machineId, binding.userId, remotePlan.id, 'owner@example.com', 'sso-token', 'https://app.example.com',
    )).rejects.toMatchObject({ code: 'REMOTE_PLAN_CHANGE_NOT_ALLOWED' })
    expect(bff.createCheckout).not.toHaveBeenCalled()
  })

  it('lets a suspended Remote machine re-subscribe only to the same Remote plan', async () => {
    db.bindingFind.mockResolvedValue({
      ...binding,
      managerId: '',
      planId: remotePlan.id,
      authMode: 'remote',
      billingStatus: 'suspended',
      externalSubscriptionStatus: 5,
    })

    const result = await machineBillingService.beginPlanCheckout(
      binding.machineId, binding.userId, remotePlan.id, 'owner@example.com', 'sso-token', 'https://app.example.com',
    )

    expect(result.action).toBe('subscribe')
    expect(db.attemptCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ targetPlanId: remotePlan.id, externalPlanId: 40 }),
    }))
  })

  it('does not activate or provision when subscription identity mismatches', async () => {
    bff.getDevice.mockResolvedValue({ deviceId: 'device-1', llmApiKey: 'secret', subscription: exactSubscription(39) })

    await expect(machineBillingService.activate(
      binding.machineId, binding.userId, 'owner@example.com', 'sso-token', 'http://localhost:3000', 'checkout-1',
    )).rejects.toMatchObject({ code: 'PAYMENT_NOT_VERIFIED' })
    expect(provision).not.toHaveBeenCalled()
  })

  it('encrypts the campaign key, activates, and provisions after exact verification', async () => {
    bff.getDevice.mockResolvedValue({ deviceId: 'device-1', llmApiKey: 'secret', subscription: exactSubscription() })

    await machineBillingService.activate(
      binding.machineId, binding.userId, 'owner@example.com', 'sso-token', 'http://localhost:3000', 'checkout-1',
    )

    expect(db.bindingUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ billingStatus: 'active', llmApiKeyEncrypted: 'encrypted-key' }),
    }))
    await vi.waitFor(() => expect(provision).toHaveBeenCalledWith(
      'mgr-1', 'create', expect.objectContaining({ apiKey: 'agent-key' }),
    ))
  })

  it('claims and activates Free only after the hosted checkout callback is verified', async () => {
    const pendingFree = { ...binding, planId: freePlan.id }
    const freeAttempt = {
      ...attempt,
      externalPlanId: 37,
      sourcePlanId: freePlan.id,
      targetPlanId: freePlan.id,
    }
    db.bindingFind.mockResolvedValue(pendingFree)
    db.bindingUpdate.mockImplementation(async ({ data }: { data: object }) => ({ ...pendingFree, ...data }))
    db.attemptFindFirst.mockResolvedValue(freeAttempt)
    db.freeFind.mockResolvedValue({
      userId: binding.userId,
      machineId: binding.machineId,
      status: 'reserved',
      claimedAt: null,
    })
    bff.getDevice.mockResolvedValue({
      deviceId: 'device-1',
      llmApiKey: 'free-secret',
      subscription: exactSubscription(37),
    })

    await expect(machineBillingService.complete(
      binding.machineId, binding.userId, 'sso-token', 'operation-1', 'success',
    )).resolves.toMatchObject({ billingStatus: 'active' })

    expect(db.freeUpdate).toHaveBeenCalledWith({
      where: { userId_autonomousEnv: { userId: binding.userId, autonomousEnv: 'prod' } },
      data: { status: 'claimed', claimedAt: expect.any(Date) },
    })
    expect(db.bindingUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        billingStatus: 'active',
        externalSubscriptionId: 'sub-1',
        externalSubscriptionStatus: 2,
        llmApiKeyEncrypted: 'encrypted-key',
      }),
    }))
    await vi.waitFor(() => expect(provision).toHaveBeenCalledWith(
      'mgr-1', 'create', expect.objectContaining({ apiKey: 'agent-key' }),
    ))
  })

  it('keeps the Free reservation and machine pending when card setup is cancelled', async () => {
    const pendingFree = { ...binding, planId: freePlan.id }
    const freeAttempt = {
      ...attempt,
      externalPlanId: 37,
      sourcePlanId: freePlan.id,
      targetPlanId: freePlan.id,
    }
    db.bindingFind.mockResolvedValue(pendingFree)
    db.attemptFindFirst.mockResolvedValue(freeAttempt)

    await expect(machineBillingService.complete(
      binding.machineId, binding.userId, 'sso-token', 'operation-1', 'cancelled',
    )).resolves.toMatchObject({ billingStatus: 'pending' })

    expect(db.attemptUpdate).toHaveBeenCalledWith({
      where: { id: freeAttempt.id }, data: { status: 'cancelled' },
    })
    expect(db.freeUpdate).not.toHaveBeenCalled()
    expect(db.freeDeleteMany).not.toHaveBeenCalled()
    expect(provision).not.toHaveBeenCalled()
  })

  it('adopts a renewed paid plan and clears the previous cancellation timestamp', async () => {
    const cancelledAt = new Date('2026-07-20T00:00:00.000Z')
    const renewedEndAt = new Date('2026-08-24T00:00:00.000Z')
    const active = {
      ...binding,
      billingStatus: 'active',
      externalSubscriptionId: 'sub-1',
      externalSubscriptionStatus: 3,
      externalSubscriptionEndAt: withinGrace,
      externalSubscriptionCancelledAt: cancelledAt,
    }
    db.bindingFind.mockResolvedValue(active)
    db.planFindFirst.mockResolvedValue(maxPlan)
    db.bindingUpdate.mockImplementation(async ({ data }: { data: object }) => ({ ...active, ...data }))

    await expect(machineBillingService.syncSubscription(binding.machineId, {
      id: 'sub-1',
      campaignCode: 'ai-harness-device',
      planId: 39,
      status: 2,
      endAt: renewedEndAt,
    }, 'sub-1')).resolves.toMatchObject({ changed: true })

    expect(db.bindingUpdate).toHaveBeenCalledWith({
      where: { machineId: binding.machineId },
      data: {
        planId: maxPlan.id,
        externalSubscriptionStatus: 2,
        externalSubscriptionEndAt: renewedEndAt,
        externalSubscriptionCancelledAt: null,
      },
    })
  })

  it('does not rewrite unchanged subscription metadata on every worker pass', async () => {
    const active = {
      ...binding,
      billingStatus: 'active',
      externalSubscriptionId: 'sub-1',
      externalSubscriptionStatus: 2,
      externalSubscriptionEndAt: future,
    }
    db.bindingFind.mockResolvedValue(active)

    await expect(machineBillingService.syncSubscription(
      binding.machineId,
      exactSubscription(),
      'sub-1',
    )).resolves.toMatchObject({ changed: false })

    expect(db.bindingUpdate).not.toHaveBeenCalled()
  })

  it('does not apply a stale snapshot after checkout replaces the subscription id', async () => {
    db.bindingFind.mockResolvedValue({
      ...binding,
      billingStatus: 'active',
      externalSubscriptionId: 'sub-new',
    })

    await expect(machineBillingService.syncSubscription(
      binding.machineId,
      exactSubscription(),
      'sub-old',
    )).resolves.toBeNull()

    expect(db.planFindFirst).not.toHaveBeenCalled()
    expect(db.bindingUpdate).not.toHaveBeenCalled()
  })

  it('returns fresh daily usage and plan limits with the billing view', async () => {
    const planWithQuota = { ...proPlan, externalMetadata: { daily_token_limit: 50_000_000 } }
    db.bindingFind.mockResolvedValue({ ...binding, billingStatus: 'active' })
    db.planFind.mockResolvedValue(planWithQuota)
    db.planFindMany.mockResolvedValue([
      { ...freePlan, externalMetadata: { daily_token_limit: 10_000_000 } },
      planWithQuota,
      { ...maxPlan, externalMetadata: { daily_token_limit: 0 } },
    ])
    bff.listSubscriptions.mockResolvedValue([exactSubscription()])
    bff.getDevice.mockResolvedValue({ deviceId: 'device-1', dailyUsage: 230_946 })

    const result = await machineBillingService.getBilling(binding.machineId, binding.userId, 'sso-token')

    expect(result.stale).toBe(false)
    expect(result.usage.dailyTokens).toBe(230_946)
    expect(result.usage.dailyVoiceSeconds).toBe(380)
    expect(result.usage.voiceResetAt).toBe('2026-07-25T00:00:00.000Z')
    expect(result.currentPlan?.dailyTokenLimit).toBe(50_000_000)
    expect(result.currentPlan?.dailyVoiceLimitSeconds).toBe(1800)
    expect(result.plans.map((plan) => [plan.name, plan.dailyTokenLimit])).toEqual([
      ['Free', 10_000_000], ['Pro', 50_000_000], ['Max', 0],
    ])
    expect(result.plans.map((plan) => [plan.name, plan.dailyVoiceLimitSeconds])).toEqual([
      ['Free', 600], ['Pro', 1800], ['Max', 0],
    ])
  })

  it('does not mark billing stale or block actions when only usage refresh fails', async () => {
    db.bindingFind.mockResolvedValue({ ...binding, billingStatus: 'active' })
    bff.listSubscriptions.mockResolvedValue([exactSubscription()])
    bff.getDevice.mockRejectedValue(new Error('device usage unavailable'))

    const result = await machineBillingService.getBilling(binding.machineId, binding.userId, 'sso-token')

    expect(result.stale).toBe(false)
    expect(result.usage.dailyTokens).toBeNull()
  })

  it('keeps fresh usage visible when subscription refresh falls back to cached billing', async () => {
    db.bindingFind.mockResolvedValue({ ...binding, billingStatus: 'active' })
    bff.listSubscriptions.mockRejectedValue(new Error('subscription service unavailable'))
    bff.getDevice.mockResolvedValue({ deviceId: 'device-1', dailyUsage: 125_268 })

    const result = await machineBillingService.getBilling(binding.machineId, binding.userId, 'sso-token')

    expect(result.stale).toBe(true)
    expect(result.usage.dailyTokens).toBe(125_268)
  })

  it('uses the authoritative subscription list when the device projection is delayed', async () => {
    bff.getDevice.mockResolvedValue({ deviceId: 'device-1', llmApiKey: 'secret' })
    bff.listSubscriptions.mockResolvedValue([exactSubscription()])

    await machineBillingService.complete(binding.machineId, binding.userId, 'sso-token', 'operation-1', 'success')

    expect(db.bindingUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ billingStatus: 'active', externalSubscriptionId: 'sub-1' }),
    }))
  })

  it('verifies the immutable attempt plan if the catalog changes during checkout', async () => {
    db.planFind.mockResolvedValue({ ...proPlan, externalPlanId: 99 })
    bff.getDevice.mockResolvedValue({ deviceId: 'device-1', llmApiKey: 'secret', subscription: exactSubscription(38) })

    await expect(machineBillingService.complete(
      binding.machineId, binding.userId, 'sso-token', 'operation-1', 'success',
    )).resolves.toMatchObject({ billingStatus: 'active' })
    expect(bff.getDevice).toHaveBeenCalled()
  })

  it('supports a legacy provider session callback with no operationId or targetPlanId', async () => {
    const legacy = { ...attempt, operationId: null, targetPlanId: null, sessionId: 'checkout-legacy', providerSessionId: null }
    db.attemptFindFirst.mockImplementation(async ({ where }: { where?: { OR?: unknown } }) => where?.OR ? legacy : null)
    bff.getDevice.mockResolvedValue({ deviceId: 'device-1', llmApiKey: 'secret', subscription: exactSubscription() })

    await expect(machineBillingService.activate(
      binding.machineId, binding.userId, 'owner@example.com', 'sso-token', 'http://localhost:3000', 'checkout-legacy',
    )).resolves.toBeUndefined()
    expect(db.bindingUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ billingStatus: 'active' }),
    }))
  })

  it('rejects a success callback from a superseded checkout', async () => {
    db.attemptFindFirst.mockResolvedValue({ ...attempt, status: 'cancelled' })

    await expect(machineBillingService.complete(
      binding.machineId, binding.userId, 'sso-token', 'operation-1', 'success',
    )).rejects.toMatchObject({ code: 'CHECKOUT_SUPERSEDED' })
    expect(bff.getDevice).not.toHaveBeenCalled()
  })

  it('keeps the machine pending while its campaign credential is not ready', async () => {
    bff.getDevice.mockResolvedValue({ deviceId: 'device-1', subscription: exactSubscription() })

    await expect(machineBillingService.complete(
      binding.machineId, binding.userId, 'sso-token', 'operation-1', 'success',
    )).rejects.toMatchObject({ code: 'CAMPAIGN_CREDENTIAL_NOT_READY' })
    expect(provision).not.toHaveBeenCalled()
  })

  it('blocks every downgrade to Free', async () => {
    db.bindingFind.mockResolvedValue({ ...binding, billingStatus: 'active', externalSubscriptionStatus: 2 })

    await expect(machineBillingService.beginPlanCheckout(
      binding.machineId, binding.userId, freePlan.id, 'owner@example.com', 'sso-token', 'http://localhost:3000',
    )).rejects.toMatchObject({ code: 'FREE_DOWNGRADE_NOT_ALLOWED' })
  })

  it('rejects a new plan-change checkout when its callback is not HTTPS', async () => {
    db.bindingFind.mockResolvedValue({ ...binding, billingStatus: 'active', externalSubscriptionStatus: 2 })

    await expect(machineBillingService.beginPlanCheckout(
      binding.machineId, binding.userId, maxPlan.id, 'owner@example.com', 'sso-token', 'http://localhost:3000',
    )).rejects.toMatchObject({ code: 'CHECKOUT_CALLBACK_HTTPS_REQUIRED' })
    expect(db.attemptCreate).not.toHaveBeenCalled()
    expect(bff.createCheckout).not.toHaveBeenCalled()
  })

  it('enforces the account-level one-time Free entitlement', async () => {
    db.freeCreate.mockRejectedValueOnce(new Error('duplicate key'))
    db.freeFind.mockResolvedValue({ userId: binding.userId, machineId: 'another-machine', status: 'claimed' })

    await expect(machineBillingService.reserveFreeEntitlement(binding.userId, binding.machineId, freePlan))
      .rejects.toMatchObject({ code: 'FREE_PLAN_ALREADY_USED' })
  })

  it('cancels a paid subscription at period end without stopping the machine immediately', async () => {
    db.bindingFind.mockResolvedValue({ ...binding, billingStatus: 'active', externalSubscriptionStatus: 2 })
    bff.listSubscriptions.mockResolvedValue([exactSubscription(38, 2)])

    const result = await machineBillingService.cancel(binding.machineId, binding.userId, 'sso-token')

    expect(bff.cancelSubscription).toHaveBeenCalledWith('prod', 'sso-token', 'sub-1')
    expect(result.subscription.status).toBe(3)
    expect(provision).not.toHaveBeenCalled()
  })

  it('renews a cancellation only before its current period ends', async () => {
    db.bindingFind.mockResolvedValue({
      ...binding, billingStatus: 'active', externalSubscriptionId: 'sub-1',
      externalSubscriptionStatus: 3, externalSubscriptionEndAt: future,
    })
    bff.listSubscriptions.mockResolvedValue([exactSubscription(38, 3)])

    const result = await machineBillingService.renew(binding.machineId, binding.userId, 'sso-token')

    expect(bff.renewSubscription).toHaveBeenCalledWith('prod', 'sso-token', 'sub-1')
    expect(result.subscription.status).toBe(2)
  })

  it('suspends a managed machine when endAt is overdue by more than one hour without changing upstream status', async () => {
    db.bindingFind.mockResolvedValue({
      ...binding, billingStatus: 'active', externalSubscriptionStatus: 2, externalSubscriptionEndAt: overdue,
    })

    await expect(machineBillingService.suspendIfDue(binding.machineId)).resolves.toBe(true)
    // The guard is an AND of two ORs: "not soft-deleted" (which must accept a legacy row that lacks
    // the field entirely) and "overdue". As sibling keys one `OR` would overwrite the other, so the
    // nesting is the assertion — a bare `deletedAt: null` here silently skipped every legacy machine.
    expect(db.bindingUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        billingStatus: 'active',
        authMode: { in: ['managed', 'remote', 'provider'] },
        AND: [
          { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] },
          {
            OR: [
              { externalSubscriptionEndAt: { lte: expect.any(Date) } },
              { externalSubscriptionStatus: 5 },
            ],
          },
        ],
      }),
      data: { billingStatus: 'suspended' },
    }))
    expect(provision).toHaveBeenCalledWith('mgr-1', 'stop', { machineId: binding.machineId })
  })

  it('does not suspend before the one-hour endAt grace has elapsed', async () => {
    db.bindingFind.mockResolvedValue({
      ...binding, billingStatus: 'active', externalSubscriptionStatus: 2, externalSubscriptionEndAt: withinGrace,
    })

    await expect(machineBillingService.suspendIfDue(binding.machineId)).resolves.toBe(false)
    expect(db.bindingUpdateMany).not.toHaveBeenCalled()
    expect(provision).not.toHaveBeenCalled()
  })

  it('does not stop the runtime when endAt changes before the guarded update', async () => {
    db.bindingFind.mockResolvedValue({
      ...binding, billingStatus: 'active', externalSubscriptionStatus: 2, externalSubscriptionEndAt: overdue,
    })
    db.bindingUpdateMany.mockResolvedValue({ count: 0 })

    await expect(machineBillingService.suspendIfDue(binding.machineId)).resolves.toBe(false)
    expect(provision).not.toHaveBeenCalled()
  })

  it('also suspends when the provider already advanced the subscription to Expired', async () => {
    db.bindingFind.mockResolvedValue({
      ...binding, billingStatus: 'active', externalSubscriptionStatus: 5,
      externalSubscriptionEndAt: null,
    })

    await expect(machineBillingService.suspendIfDue(binding.machineId)).resolves.toBe(true)
    expect(provision).toHaveBeenCalledWith('mgr-1', 'stop', { machineId: binding.machineId })
  })

  it('disconnects an overdue Remote adapter without stopping a manager runtime', async () => {
    db.bindingFind.mockResolvedValue({
      ...binding,
      managerId: '',
      planId: remotePlan.id,
      authMode: 'remote',
      billingStatus: 'active',
      externalSubscriptionStatus: 2,
      externalSubscriptionEndAt: overdue,
    })

    await expect(machineBillingService.suspendIfDue(binding.machineId)).resolves.toBe(true)
    expect(publishDown).toHaveBeenCalledWith(binding.machineId, {
      connId: '', frame: { type: '__billing_suspended' },
    })
    expect(provision).not.toHaveBeenCalled()
  })

  it.each([
    ['self-auth', { authMode: 'self-auth', billingStatus: 'active', deletedAt: null }],
    ['pending', { authMode: 'managed', billingStatus: 'pending', deletedAt: null }],
    ['deleted', { authMode: 'managed', billingStatus: 'active', deletedAt: new Date() }],
    ['already suspended', { authMode: 'managed', billingStatus: 'suspended', deletedAt: null }],
  ])('does not process an overdue %s machine', async (_case, state) => {
    db.bindingFind.mockResolvedValue({
      ...binding,
      ...state,
      externalSubscriptionStatus: 2,
      externalSubscriptionEndAt: overdue,
    })

    await expect(machineBillingService.suspendIfDue(binding.machineId)).resolves.toBe(false)
    expect(db.bindingUpdateMany).not.toHaveBeenCalled()
    expect(provision).not.toHaveBeenCalled()
    expect(publishDown).not.toHaveBeenCalled()
  })

  it('fires the external device before soft-deleting a pending machine', async () => {
    await machineBillingService.cancelPending(binding.machineId, binding.userId, 'sso-token')

    expect(bff.fireDevice).toHaveBeenCalledWith('prod', 'sso-token', 'device-1')
    expect(db.bindingUpdate).toHaveBeenCalledWith({
      where: { machineId: binding.machineId }, data: { deletedAt: expect.any(Date) },
    })
  })

  it('cancels an active paid subscription and fires its device before local soft delete', async () => {
    db.bindingFind.mockResolvedValue({ ...binding, billingStatus: 'active' })
    bff.listSubscriptions.mockResolvedValue([exactSubscription()])

    await machineBillingService.deleteCampaignMachine(binding.machineId, binding.userId, 'sso-token')

    expect(bff.cancelSubscription).toHaveBeenCalledWith('prod', 'sso-token', 'sub-1')
    expect(bff.fireDevice).toHaveBeenCalledWith('prod', 'sso-token', 'device-1')
    expect(db.bindingUpdate).toHaveBeenCalledWith({
      where: { machineId: binding.machineId }, data: { deletedAt: expect.any(Date) },
    })
    expect(bff.cancelSubscription.mock.invocationCallOrder[0]).toBeLessThan(bff.fireDevice.mock.invocationCallOrder[0])
    expect(bff.fireDevice.mock.invocationCallOrder[0]).toBeLessThan(db.bindingUpdate.mock.invocationCallOrder[0])
  })

  it('soft-deletes after cancellation when fire-intern rejects the now-cancelled subscription', async () => {
    db.bindingFind.mockResolvedValue({ ...binding, billingStatus: 'active' })
    bff.listSubscriptions.mockResolvedValue([exactSubscription()])
    bff.fireDevice.mockRejectedValue(new AppError(
      'We’re sorry, but we are unable to process your request.', 503, 'BILLING_UPSTREAM_ERROR',
    ))

    await expect(machineBillingService.deleteCampaignMachine(
      binding.machineId, binding.userId, 'sso-token',
    )).resolves.toBeUndefined()

    expect(bff.cancelSubscription).toHaveBeenCalledWith('prod', 'sso-token', 'sub-1')
    expect(db.bindingUpdate).toHaveBeenCalledWith({
      where: { machineId: binding.machineId }, data: { deletedAt: expect.any(Date) },
    })
  })

  it('keeps the local machine when upstream subscription cancellation fails', async () => {
    db.bindingFind.mockResolvedValue({ ...binding, billingStatus: 'active' })
    bff.listSubscriptions.mockResolvedValue([exactSubscription()])
    bff.cancelSubscription.mockRejectedValue(new Error('provider unavailable'))

    await expect(machineBillingService.deleteCampaignMachine(
      binding.machineId, binding.userId, 'sso-token',
    )).rejects.toThrow('provider unavailable')

    expect(bff.fireDevice).not.toHaveBeenCalled()
    expect(db.bindingUpdate).not.toHaveBeenCalled()
  })

  it('soft-deletes when the provider reports no subscription for the device and then rejects fire-intern', async () => {
    // "No subscription exists" is the strongest possible proof that nothing renews, but it used to
    // leave renewalDisabled false, so a fire-intern 503 made the machine undeletable forever.
    db.bindingFind.mockResolvedValue({ ...binding, billingStatus: 'active' })
    bff.listSubscriptions.mockResolvedValue([])
    bff.fireDevice.mockRejectedValue(new AppError(
      'We’re sorry, but we are unable to process your request.', 503, 'BILLING_UPSTREAM_ERROR',
    ))

    await expect(machineBillingService.deleteCampaignMachine(
      binding.machineId, binding.userId, 'sso-token',
    )).resolves.toBeUndefined()

    expect(bff.cancelSubscription).not.toHaveBeenCalled()
    expect(db.bindingUpdate).toHaveBeenCalledWith({
      where: { machineId: binding.machineId }, data: { deletedAt: expect.any(Date) },
    })
  })

  it('deletes a never-activated machine whose subscription lookup the provider rejects', async () => {
    db.bindingFind.mockResolvedValue({ ...binding, billingStatus: 'pending' })
    bff.listSubscriptions.mockRejectedValue(new AppError(
      'We’re sorry, but we are unable to process your request.', 503, 'BILLING_UPSTREAM_ERROR',
    ))

    await expect(machineBillingService.deleteCampaignMachine(
      binding.machineId, binding.userId, 'sso-token',
    )).resolves.toBeUndefined()

    expect(bff.fireDevice).toHaveBeenCalledWith('prod', 'sso-token', 'device-1')
    expect(db.bindingUpdate).toHaveBeenCalledWith({
      where: { machineId: binding.machineId }, data: { deletedAt: expect.any(Date) },
    })
  })

  it('keeps an activated machine when its subscription lookup cannot be verified', async () => {
    db.bindingFind.mockResolvedValue({
      ...binding, billingStatus: 'active', externalSubscriptionId: 'sub-1', externalSubscriptionStatus: 2,
    })
    bff.listSubscriptions.mockRejectedValue(new AppError(
      'We’re sorry, but we are unable to process your request.', 503, 'BILLING_UPSTREAM_ERROR',
    ))

    await expect(machineBillingService.deleteCampaignMachine(
      binding.machineId, binding.userId, 'sso-token',
    )).rejects.toMatchObject({ code: 'BILLING_UPSTREAM_ERROR' })

    expect(bff.fireDevice).not.toHaveBeenCalled()
    expect(db.bindingUpdate).not.toHaveBeenCalled()
  })

  it('keeps the machine when a proven live subscription cannot be cancelled', async () => {
    db.bindingFind.mockResolvedValue({ ...binding, billingStatus: 'active' })
    bff.listSubscriptions.mockResolvedValue([exactSubscription()])
    bff.cancelSubscription.mockRejectedValue(new AppError(
      'We’re sorry, but we are unable to process your request.', 503, 'BILLING_UPSTREAM_ERROR',
    ))

    await expect(machineBillingService.deleteCampaignMachine(
      binding.machineId, binding.userId, 'sso-token',
    )).rejects.toMatchObject({ code: 'BILLING_UPSTREAM_ERROR' })

    expect(bff.fireDevice).not.toHaveBeenCalled()
    expect(db.bindingUpdate).not.toHaveBeenCalled()
  })

  it('deletes a machine whose plan left the catalog, with nothing upstream to cancel', async () => {
    // A retired/re-synced plan (or a changed campaign code) used to fail the delete with
    // PLAN_UNAVAILABLE forever — the owner could never remove the machine.
    db.planFind.mockResolvedValue(null)
    db.bindingFind.mockResolvedValue({ ...binding, billingStatus: 'active', externalDeviceId: null })

    await expect(machineBillingService.deleteCampaignMachine(
      binding.machineId, binding.userId, 'sso-token',
    )).resolves.toBeUndefined()

    expect(bff.cancelSubscription).not.toHaveBeenCalled()
    expect(bff.fireDevice).not.toHaveBeenCalled()
    expect(db.bindingUpdate).toHaveBeenCalledWith({
      where: { machineId: binding.machineId }, data: { deletedAt: expect.any(Date) },
    })
  })

  it('still cancels upstream truth when the plan left the catalog but a device remains', async () => {
    db.planFind.mockResolvedValue(null)
    db.bindingFind.mockResolvedValue({ ...binding, billingStatus: 'active' })
    bff.listSubscriptions.mockResolvedValue([exactSubscription()])

    await machineBillingService.deleteCampaignMachine(binding.machineId, binding.userId, 'sso-token')

    expect(bff.cancelSubscription).toHaveBeenCalledWith('prod', 'sso-token', 'sub-1')
    expect(bff.fireDevice).toHaveBeenCalledWith('prod', 'sso-token', 'device-1')
    expect(db.bindingUpdate).toHaveBeenCalledWith({
      where: { machineId: binding.machineId }, data: { deletedAt: expect.any(Date) },
    })
  })

  it('still refuses to hide a plan-less machine that has a subscription but no device', async () => {
    db.planFind.mockResolvedValue(null)
    db.bindingFind.mockResolvedValue({
      ...binding,
      billingStatus: 'active',
      externalDeviceId: null,
      externalSubscriptionId: 'sub-1',
    })

    await expect(machineBillingService.deleteCampaignMachine(
      binding.machineId, binding.userId, 'sso-token',
    )).rejects.toMatchObject({ code: 'BILLING_CLEANUP_REQUIRED' })

    expect(db.bindingUpdate).not.toHaveBeenCalled()
  })

  it('refuses to hide an active paid machine when its billing device reference is missing', async () => {
    db.bindingFind.mockResolvedValue({
      ...binding,
      billingStatus: 'active',
      externalDeviceId: null,
      externalSubscriptionId: 'sub-1',
    })

    await expect(machineBillingService.deleteCampaignMachine(
      binding.machineId, binding.userId, 'sso-token',
    )).rejects.toMatchObject({ code: 'BILLING_CLEANUP_REQUIRED' })

    expect(bff.cancelSubscription).not.toHaveBeenCalled()
    expect(bff.fireDevice).not.toHaveBeenCalled()
    expect(db.bindingUpdate).not.toHaveBeenCalled()
  })
})
