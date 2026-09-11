import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  plan: vi.fn(),
  plans: vi.fn(),
  bindingCreate: vi.fn(),
  bindingFind: vi.fn(),
  bindingFindFirst: vi.fn(),
  bindingUpdate: vi.fn(),
}))
const selectManager = vi.hoisted(() => vi.fn())
const provision = vi.hoisted(() => vi.fn())
const publishMachineList = vi.hoisted(() => vi.fn())
const publishDown = vi.hoisted(() => vi.fn())
const clearPresence = vi.hoisted(() => vi.fn())
const billing = vi.hoisted(() => ({
  reserveFreeEntitlement: vi.fn(),
  releaseFreeReservation: vi.fn(),
  cancelPending: vi.fn(),
  deleteCampaignMachine: vi.fn(),
}))

vi.mock('../config/env.js', () => ({ env: { HARNESS_BILLING_ENABLED: true, HARNESS_CAMPAIGN_CODE: 'ai-harness-device' } }))
vi.mock('../lib/prisma.js', () => ({
  machineAlive: { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] },
  prisma: {
    subscriptionPlan: { findUnique: db.plan, findMany: db.plans },
    machine: {
      create: db.bindingCreate,
      findUnique: db.bindingFind,
      findFirst: db.bindingFindFirst,
      update: db.bindingUpdate,
    },
  },
}))
vi.mock('../lib/managers.js', () => ({ selectManagerId: selectManager }))
vi.mock('../lib/provision.js', () => ({ provisionViaManager: provision }))
vi.mock('../lib/bus.js', () => ({
  getAgentPresence: vi.fn(), clearAgentPresence: clearPresence, publishDown,
  publishDeviceMachineListChanged: publishMachineList,
}))
vi.mock('../utils/crypto.js', () => ({ generateApiKey: vi.fn(() => 'agent-key'), machineIdFromKey: vi.fn(() => 'a'.repeat(32)) }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../lib/machineLifecycle.js', () => ({ ensureMachineReady: vi.fn(), publishMachineLifecycle: vi.fn() }))
vi.mock('./MachineBillingService.js', () => ({ machineBillingService: billing }))

import { machineService } from './MachineService.js'

const plan = {
  id: 'plan-1', name: 'Pro', authMode: 'managed', available: true,
  autonomousEnv: 'prod',
  externalPlanId: 38, campaignCode: 'ai-harness-device',
}
const created = {
  id: 'binding-1', userId: 'user-1', machineId: 'a'.repeat(32), apiKey: 'agent-key',
  managerId: 'mgr-1', workspaceId: null, planId: 'plan-1', authMode: 'managed',
  autonomousEnv: 'prod',
  name: null, billingStatus: 'pending', externalDeviceId: null,
  externalSubscriptionId: null, billingActivatedAt: null, billingError: null,
  billingErrorAt: null, llmApiKeyEncrypted: null, deletedAt: null, createdAt: new Date(),
}
const remotePlan = {
  ...plan,
  id: 'plan-remote',
  name: 'Remote',
  authMode: 'remote',
  externalPlanId: 40,
}
const remoteCreated = {
  ...created,
  planId: remotePlan.id,
  authMode: 'remote',
  managerId: '',
}

describe('managed machine reservation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    db.plan.mockResolvedValue(plan)
    db.plans.mockResolvedValue([plan])
    selectManager.mockResolvedValue({ managerId: 'mgr-1' })
    db.bindingCreate.mockResolvedValue(created)
    db.bindingUpdate.mockResolvedValue(created)
    publishMachineList.mockResolvedValue(1)
    publishDown.mockResolvedValue(undefined)
    clearPresence.mockResolvedValue(undefined)
    billing.reserveFreeEntitlement.mockResolvedValue(undefined)
    billing.releaseFreeReservation.mockResolvedValue(undefined)
    billing.deleteCampaignMachine.mockResolvedValue(undefined)
    provision.mockResolvedValue(undefined)
  })

  it('writes only a payment-pending binding and never provisions Docker before checkout', async () => {
    await expect(machineService.create('user-1', undefined, { planId: 'plan-1', autonomousEnv: 'prod' }))
      .resolves.toMatchObject({ machineId: 'a'.repeat(32), billingStatus: 'pending', status: 'payment_pending' })
    expect(db.bindingCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ managerId: 'mgr-1', billingStatus: 'pending', authMode: 'managed' }),
    })
    expect(provision).not.toHaveBeenCalled()
    expect(billing.reserveFreeEntitlement).toHaveBeenCalledWith('user-1', 'a'.repeat(32), plan)
    expect(publishMachineList).toHaveBeenCalledWith('user-1', { reason: 'created' })
  })

  it('creates a paid Remote machine as pending without manager placement or Docker', async () => {
    db.plan.mockResolvedValue(remotePlan)
    db.bindingCreate.mockResolvedValue(remoteCreated)

    await expect(machineService.create('user-1', undefined, { planId: remotePlan.id, autonomousEnv: 'prod' }))
      .resolves.toMatchObject({
        machineId: 'a'.repeat(32), authMode: 'remote', billingStatus: 'pending', status: 'payment_pending',
      })

    expect(db.bindingCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ managerId: '', billingStatus: 'pending', authMode: 'remote' }),
    })
    expect(selectManager).not.toHaveBeenCalled()
    expect(billing.reserveFreeEntitlement).not.toHaveBeenCalled()
    expect(provision).not.toHaveBeenCalled()
  })

  it('rejects grandfathered plans even when their rows remain in Mongo', async () => {
    db.plan.mockResolvedValue({ ...plan, name: 'Managed', available: false, externalPlanId: null })
    await expect(machineService.create('user-1', undefined, { planId: 'plan-1', autonomousEnv: 'prod' }))
      .rejects.toMatchObject({ code: 'PLAN_UNAVAILABLE' })
    expect(db.bindingCreate).not.toHaveBeenCalled()
  })

  it('delegates managed billing cleanup before tearing down an active machine', async () => {
    db.bindingFind.mockResolvedValue({
      ...created, billingStatus: 'active', externalDeviceId: 'device-1', externalSubscriptionId: 'sub-1',
    })
    await machineService.destroy(created.machineId, { sub: 'user-1', role: 'user', autonomousEnv: 'prod' }, 'sso-token')

    expect(billing.deleteCampaignMachine).toHaveBeenCalledWith(created.machineId, 'user-1', 'sso-token', 'prod')
    expect(db.bindingUpdate).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(provision).toHaveBeenCalledWith('mgr-1', 'destroy', { machineId: created.machineId }))
  })

  it('resolves an external campaign device only inside the caller owner and environment', async () => {
    db.bindingFindFirst.mockResolvedValue({ ...created, externalDeviceId: 'device-1' })

    await expect(machineService.resolveByExternalDeviceId(
      'device-1',
      { sub: 'user-1', role: 'user', autonomousEnv: 'prod' },
    )).resolves.toMatchObject({
      machineId: created.machineId,
      planName: 'Pro',
      billingStatus: 'pending',
      status: 'payment_pending',
    })

    expect(db.bindingFindFirst).toHaveBeenCalledWith({
      where: {
        externalDeviceId: 'device-1',
        userId: 'user-1',
        autonomousEnv: 'prod',
        OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }],
      },
      orderBy: { createdAt: 'desc' },
    })
  })

  it('does not resolve an external campaign device outside the caller scope', async () => {
    db.bindingFindFirst.mockResolvedValue(null)

    await expect(machineService.resolveByExternalDeviceId(
      'device-other',
      { sub: 'user-1', role: 'user', autonomousEnv: 'prod' },
    )).rejects.toMatchObject({ code: 'NOT_FOUND' })

    expect(db.plans).not.toHaveBeenCalled()
  })

  it('does not soft-delete or tear down when upstream billing cleanup fails', async () => {
    db.bindingFind.mockResolvedValue({
      ...created, billingStatus: 'active', externalDeviceId: 'device-1', externalSubscriptionId: 'sub-1',
    })
    billing.deleteCampaignMachine.mockRejectedValue(new Error('provider unavailable'))

    await expect(machineService.destroy(
      created.machineId, { sub: 'user-1', role: 'user', autonomousEnv: 'prod' }, 'sso-token',
    )).rejects.toThrow('provider unavailable')

    expect(db.bindingUpdate).not.toHaveBeenCalled()
    expect(provision).not.toHaveBeenCalled()
  })

  it('deletes a legacy Managed machine locally when it has no campaign billing metadata', async () => {
    db.bindingFind.mockResolvedValue({
      ...created,
      billingStatus: null,
      externalDeviceId: null,
      externalSubscriptionId: null,
      externalSubscriptionStatus: null,
      externalSubscriptionEndAt: null,
      externalSubscriptionCancelledAt: null,
      billingActivatedAt: null,
    })

    await machineService.destroy(
      created.machineId,
      { sub: 'user-1', role: 'user', autonomousEnv: 'prod' },
    )

    expect(billing.deleteCampaignMachine).not.toHaveBeenCalled()
    expect(db.bindingUpdate).toHaveBeenCalledWith({
      where: { machineId: created.machineId }, data: { deletedAt: expect.any(Date) },
    })
    expect(publishMachineList).toHaveBeenCalledWith('user-1', { reason: 'deleted' })
    await vi.waitFor(() => expect(provision).toHaveBeenCalledWith(
      'mgr-1', 'destroy', { machineId: created.machineId },
    ))
  })

  it('runs billing cleanup for a new paid Remote machine without touching Docker', async () => {
    db.bindingFind.mockResolvedValue({
      ...remoteCreated, billingStatus: 'active', externalDeviceId: 'device-remote', externalSubscriptionId: 'sub-remote',
    })

    await machineService.destroy(remoteCreated.machineId, { sub: 'user-1', role: 'user', autonomousEnv: 'prod' }, 'sso-token')

    expect(billing.deleteCampaignMachine).toHaveBeenCalledWith(remoteCreated.machineId, 'user-1', 'sso-token', 'prod')
    expect(provision).not.toHaveBeenCalled()
    expect(publishDown).toHaveBeenCalledWith(remoteCreated.machineId, { connId: '', frame: { type: 'machine_revoked' } })
  })

  it('keeps grandfathered Remote deletion local and does not require upstream billing', async () => {
    db.bindingFind.mockResolvedValue({ ...remoteCreated, billingStatus: 'not_required', externalDeviceId: null })

    await machineService.destroy(remoteCreated.machineId, { sub: 'user-1', role: 'user', autonomousEnv: 'prod' })

    expect(billing.deleteCampaignMachine).not.toHaveBeenCalled()
    expect(db.bindingUpdate).toHaveBeenCalledWith({
      where: { machineId: remoteCreated.machineId }, data: { deletedAt: expect.any(Date) },
    })
    expect(provision).not.toHaveBeenCalled()
  })
})
