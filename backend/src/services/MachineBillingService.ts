import type { Machine, SubscriptionPlan } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { env } from '../config/env.js'
import { AppError, ForbiddenError, NotFoundError } from '../errors/index.js'
import {
  cancelCampaignSubscription,
  createCampaignDevice,
  createCheckout,
  fireCampaignDevice,
  getCampaignDevice,
  listCampaignSubscriptions,
  renewCampaignSubscription,
  type CampaignSubscription,
  type CheckoutInput,
} from '../lib/autonomousBff.js'
import { pub, publishDeviceMachineListChanged, publishDown } from '../lib/bus.js'
import { REMOTE_BILLING_SUSPENDED_FRAME, subscriptionMatches } from '../lib/billingState.js'
import { dailyTokenLimitForPlan } from '../lib/billingPlanMetadata.js'
import { encryptMachineCredential } from '../lib/machineCredential.js'
import { selectManagerId } from '../lib/managers.js'
import { machineAlive, prisma } from '../lib/prisma.js'
import { provisionViaManager } from '../lib/provision.js'
import { logger } from '../utils/logger.js'
import { voiceQuotaService } from '../lib/voiceQuota.js'
import {
  storedAutonomousEnvironment,
  type AutonomousEnvironment,
} from '../lib/autonomousEnvironment.js'

const LOCK_TTL_MS = 90_000
const LOCK_WAIT_MS = 10_000
const SUBSCRIPTION_PAID = 2
const SUBSCRIPTION_CANCELLED = 3
const SUBSCRIPTION_EXPIRED = 5
const SUBSCRIPTION_FREE_TRIAL = 6

export type BillingAction = 'subscribe' | 'upgrade' | 'downgrade'

export interface CheckoutView {
  operationId: string
  sessionId?: string
  redirectUrl?: string
  action: BillingAction
}

export interface BillingPlanView {
  id: string
  name: string
  priceUsd: number
  cpus: string
  memory: string
  maxAgents: number
  dailyTokenLimit: number | null
  dailyVoiceLimitSeconds: number
  isDefault: boolean
  eligible: boolean
  ineligibilityReason?: string
}

export interface MachineBillingView {
  billingStatus: 'pending' | 'active' | 'suspended'
  currentPlan: BillingPlanView | null
  plans: BillingPlanView[]
  subscription: {
    id: string | null
    status: number | null
    endAt: Date | null
    cancelledAt: Date | null
  }
  usage: {
    dailyTokens: number | null
    dailyVoiceSeconds: number | null
    voiceResetAt: string | null
  }
  freeEligible: boolean
  stale: boolean
}

function callbackUrl(
  origin: string,
  machineId: string,
  operationId: string,
  outcome: 'success' | 'cancelled',
): string {
  const configured = env.HARNESS_CHECKOUT_CALLBACK_URL.trim()
  const url = new URL(configured || '/machine-checkout', origin)
  url.searchParams.set('machineId', machineId)
  url.searchParams.set('operationId', operationId)
  url.searchParams.set('checkout', outcome)
  return url.toString()
}

function checkoutInput(
  email: string,
  plan: SubscriptionPlan,
  binding: Machine,
  origin: string,
  operationId: string,
): CheckoutInput {
  if (!plan.externalPlanId || !binding.externalDeviceId) {
    throw new AppError('Machine checkout is not initialized', 409, 'CHECKOUT_NOT_READY')
  }
  return {
    email,
    planId: plan.externalPlanId,
    referenceId: binding.externalDeviceId,
    successUrl: callbackUrl(origin, binding.machineId, operationId, 'success'),
    failureUrl: callbackUrl(origin, binding.machineId, operationId, 'cancelled'),
    origin,
  }
}

function requireSecurePlanChangeCallback(successUrl: string): void {
  if (new URL(successUrl).protocol === 'https:') return
  throw new AppError(
    'Plan changes require an HTTPS checkout callback. Configure HARNESS_CHECKOUT_CALLBACK_URL with an HTTPS URL.',
    503,
    'CHECKOUT_CALLBACK_HTTPS_REQUIRED',
  )
}

export async function withMachineBillingLock<T>(machineId: string, action: () => Promise<T>): Promise<T> {
  const key = `machine-billing-lock:${machineId}`
  const token = randomUUID()
  const deadline = Date.now() + LOCK_WAIT_MS
  let acquired = false
  while (!acquired && Date.now() < deadline) {
    acquired = (await pub.set(key, token, 'PX', LOCK_TTL_MS, 'NX')) === 'OK'
    if (!acquired) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!acquired) throw new AppError('Another billing operation is in progress', 409, 'BILLING_OPERATION_IN_PROGRESS')
  try {
    return await action()
  } finally {
    await pub.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      key,
      token,
    ).catch(() => { /* TTL is the fallback */ })
  }
}

export const BILLING_EXPIRY_GRACE_MS = 60 * 60 * 1000

function bindingEnvironment(binding: Machine): AutonomousEnvironment {
  return storedAutonomousEnvironment(binding.autonomousEnv)
}

/**
 * Which machine modes carry a subscription.
 *
 * This used to be spelled out as `authMode === 'managed' || authMode === 'remote'` at a dozen sites,
 * and several places collapsed the world to those two with a ternary. Adding `provider` as a third
 * billed mode meant touching every one of them, so the predicate lives here now — a fourth billed
 * mode should be one edit, not twelve.
 */
const BILLED_MODES: ReadonlySet<string> = new Set(['managed', 'remote', 'provider'])
const isBilled = (v: string | null | undefined): boolean => BILLED_MODES.has(v ?? '')
/** Billed modes with no container of ours: no manager reservation, no campaign device record. */
const NODELESS_BILLED: ReadonlySet<string> = new Set(['remote', 'provider'])
const isNodelessBilled = (v: string | null | undefined): boolean => NODELESS_BILLED.has(v ?? '')

/** The plan-catalog bucket a binding shops in. Managed and the nodeless modes have separate tiers. */
function planAuthMode(binding: { authMode?: string | null }): string {
  return isNodelessBilled(binding.authMode) ? binding.authMode! : 'managed'
}

function isCampaignPlan(
  plan: SubscriptionPlan | null | undefined,
  autonomousEnv?: AutonomousEnvironment,
): plan is SubscriptionPlan {
  return !!plan?.externalPlanId &&
    isBilled(plan.authMode) &&
    plan.campaignCode === env.HARNESS_CAMPAIGN_CODE &&
    (!autonomousEnv || storedAutonomousEnvironment(plan.autonomousEnv) === autonomousEnv)
}

function isFreePlan(plan: SubscriptionPlan | null | undefined): boolean {
  return isCampaignPlan(plan) && plan.authMode === 'managed' && plan.priceUsd === 0
}

/** The provider refused the call itself (rejected body / malformed payload) rather than the network
 *  or our own logic failing. Only this shape is ever tolerated during a delete. */
function isUpstreamRejection(err: unknown): err is AppError {
  return err instanceof AppError && err.code === 'BILLING_UPSTREAM_ERROR'
}

function isEntitled(subscription: CampaignSubscription | undefined): boolean {
  return !!subscription && (
    subscription.status === undefined ||
    subscription.status === SUBSCRIPTION_PAID ||
    subscription.status === SUBSCRIPTION_FREE_TRIAL
  )
}

function subscriptionFor(
  subscriptions: CampaignSubscription[],
  binding: Machine,
  externalPlanId?: number,
): CampaignSubscription | undefined {
  const exact = subscriptions.filter((subscription) =>
    subscription.campaignCode === env.HARNESS_CAMPAIGN_CODE &&
    subscription.referenceId === binding.externalDeviceId &&
    (externalPlanId === undefined || subscription.planId === externalPlanId))
  return exact.sort((a, b) => {
    const priority = (status?: number) => status === SUBSCRIPTION_PAID || status === SUBSCRIPTION_FREE_TRIAL
      ? 3
      : status === SUBSCRIPTION_CANCELLED
        ? 2
        : status === SUBSCRIPTION_EXPIRED
          ? 1
          : 0
    return priority(b.status) - priority(a.status) || (b.endAt?.getTime() ?? 0) - (a.endAt?.getTime() ?? 0)
  })[0]
}

async function ownedBinding(
  machineId: string,
  userId: string,
  requestedEnvironment?: AutonomousEnvironment,
): Promise<Machine> {
  const binding = await prisma.machine.findUnique({ where: { machineId } })
  if (!binding || binding.deletedAt) throw new NotFoundError('Machine')
  if (binding.userId !== userId) throw new ForbiddenError('Not your machine')
  if (requestedEnvironment && bindingEnvironment(binding) !== requestedEnvironment) {
    throw new AppError('Machine belongs to another Autonomous environment', 403, 'MACHINE_ENV_MISMATCH')
  }
  return binding
}

/** The plan row is LOCAL catalog data — it disappears when the catalog is re-synced, the campaign
 *  code changes, or a tier is retired. Callers that need the plan to price an operation must fail
 *  (`planForBinding`); deletion must not, or a de-catalogued plan traps the owner in a machine they
 *  can never remove. */
async function planOrNull(binding: Machine): Promise<SubscriptionPlan | null> {
  const plan = binding.planId ? await prisma.subscriptionPlan.findUnique({ where: { id: binding.planId } }) : null
  return isCampaignPlan(plan, bindingEnvironment(binding)) ? plan : null
}

async function planForBinding(binding: Machine): Promise<SubscriptionPlan> {
  const plan = await planOrNull(binding)
  if (!plan) throw new AppError('Machine plan is no longer available', 409, 'PLAN_UNAVAILABLE')
  return plan
}

async function ownedPending(
  machineId: string,
  userId: string,
  requestedEnvironment?: AutonomousEnvironment,
): Promise<{ binding: Machine; plan: SubscriptionPlan }> {
  const binding = await ownedBinding(machineId, userId, requestedEnvironment)
  if (binding.billingStatus === 'active') throw new AppError('Machine is already active', 409, 'MACHINE_ALREADY_ACTIVE')
  if (binding.billingStatus === 'suspended') throw new AppError('Machine subscription is suspended', 409, 'MACHINE_SUBSCRIPTION_REQUIRED')
  if (binding.billingStatus !== 'pending') throw new AppError('Machine does not require checkout', 400, 'CHECKOUT_NOT_REQUIRED')
  return { binding, plan: await planForBinding(binding) }
}

async function reservationManager(binding: Machine): Promise<string> {
  if (binding.managerId) {
    const manager = await prisma.manager.findUnique({ where: { managerId: binding.managerId } })
    if (manager?.lastSeenAt && manager.lastSeenAt.getTime() >= Date.now() - 90_000) return manager.managerId
  }
  const picked = await selectManagerId()
  await prisma.machine.update({ where: { machineId: binding.machineId }, data: { managerId: picked.managerId } })
  return picked.managerId
}

function provisionActivatedMachine(binding: Machine, managerId: string, wake: boolean): void {
  const cmd = wake ? 'start' : 'create'
  const payload = wake
    ? { machineId: binding.machineId }
    : { userId: binding.userId, workspaceId: binding.workspaceId ?? undefined, apiKey: binding.apiKey }
  void provisionViaManager(managerId, cmd, payload).then(() => {
    logger.info(wake ? 'resubscribed machine started' : 'managed machine provisioned', { machineId: binding.machineId, managerId })
  }).catch((err) => {
    logger.error('activated machine provision failed; manager reconcile owns healing', err instanceof Error ? err : new Error(String(err)), {
      machineId: binding.machineId,
      managerId,
      wake,
    })
  })
}

function actionFor(current: SubscriptionPlan, target: SubscriptionPlan, suspended: boolean): BillingAction {
  if (suspended || current.priceUsd === 0) return 'subscribe'
  return target.priceUsd > current.priceUsd ? 'upgrade' : 'downgrade'
}

async function freeEligible(
  userId: string,
  autonomousEnv: AutonomousEnvironment,
  machineId?: string,
): Promise<boolean> {
  const entitlement = await prisma.machineFreeEntitlement.findUnique({
    where: { userId_autonomousEnv: { userId, autonomousEnv } },
  })
  return !entitlement || (entitlement.status === 'reserved' && entitlement.machineId === machineId)
}

async function plansView(
  userId: string,
  autonomousEnv: AutonomousEnvironment,
  authMode: string,
  machineId?: string,
): Promise<BillingPlanView[]> {
  const [plans, eligible] = await Promise.all([
    prisma.subscriptionPlan.findMany({
      where: { autonomousEnv, available: true, authMode, campaignCode: env.HARNESS_CAMPAIGN_CODE },
      orderBy: { priceUsd: 'asc' },
    }),
    authMode === 'managed' ? freeEligible(userId, autonomousEnv, machineId) : Promise.resolve(false),
  ])
  return plans.map((plan) => ({
    id: plan.id,
    name: plan.name,
    priceUsd: plan.priceUsd,
    cpus: plan.cpus,
    memory: plan.memory,
    maxAgents: plan.maxAgents,
    dailyTokenLimit: dailyTokenLimitForPlan(plan),
    dailyVoiceLimitSeconds: Math.max(0, plan.dailyVoiceLimitSeconds ?? 0),
    isDefault: plan.isDefault,
    eligible: plan.priceUsd > 0 || eligible,
    ...(plan.priceUsd === 0 && !eligible ? { ineligibilityReason: 'Free plan already used' } : {}),
  }))
}

async function buildBillingView(
  binding: Machine,
  stale: boolean,
  dailyTokens: number | null = null,
  dailyVoiceSeconds: number | null = null,
  voiceResetAt: string | null = null,
): Promise<MachineBillingView> {
  const autonomousEnv = bindingEnvironment(binding)
  const authMode = planAuthMode(binding)
  const [plan, plans, eligible] = await Promise.all([
    binding.planId ? prisma.subscriptionPlan.findUnique({ where: { id: binding.planId } }) : null,
    plansView(binding.userId, autonomousEnv, authMode, binding.machineId),
    authMode === 'managed' ? freeEligible(binding.userId, autonomousEnv, binding.machineId) : Promise.resolve(false),
  ])
  const currentPlan = plan
    ? {
      id: plan.id,
      name: plan.name,
      priceUsd: plan.priceUsd,
      cpus: plan.cpus,
      memory: plan.memory,
      maxAgents: plan.maxAgents,
      dailyTokenLimit: dailyTokenLimitForPlan(plan),
      dailyVoiceLimitSeconds: Math.max(0, plan.dailyVoiceLimitSeconds ?? 0),
      isDefault: plan.isDefault,
      eligible: true,
    }
    : null
  return {
    billingStatus: binding.billingStatus === 'pending' || binding.billingStatus === 'suspended'
      ? binding.billingStatus
      : 'active',
    currentPlan,
    plans,
    subscription: {
      id: binding.externalSubscriptionId ?? null,
      status: binding.externalSubscriptionStatus ?? null,
      endAt: binding.externalSubscriptionEndAt ?? null,
      cancelledAt: binding.externalSubscriptionCancelledAt ?? null,
    },
    usage: { dailyTokens, dailyVoiceSeconds, voiceResetAt },
    freeEligible: eligible,
    stale,
  }
}

async function startCheckoutOperation(
  binding: Machine,
  currentPlan: SubscriptionPlan,
  targetPlan: SubscriptionPlan,
  action: BillingAction,
  userId: string,
  email: string,
  token: string,
  origin: string,
): Promise<CheckoutView> {
  // A checkout URL is disposable UI state, not a lock on the machine. Every explicit user action
  // gets a fresh provider session; older tabs/callbacks are superseded and cannot mutate billing.
  await prisma.machineCheckoutAttempt.updateMany({
    where: { machineId: binding.machineId, status: { in: ['creating', 'pending'] } },
    data: { status: 'cancelled', error: 'Superseded by a newer checkout' },
  })

  const operationId = randomUUID()
  const input = checkoutInput(email, targetPlan, binding, origin, operationId)
  // The campaign provider accepts localhost for an initial subscription, but Stripe-hosted plan
  // changes reject an HTTP success_url with a generic status:-1 response. Fail locally with an
  // actionable configuration error instead. Local E2E testing should use an HTTPS tunnel.
  if (binding.billingStatus !== 'pending') requireSecurePlanChangeCallback(input.successUrl)
  const attempt = await prisma.machineCheckoutAttempt.create({
    data: {
      machineId: binding.machineId,
      userId,
      autonomousEnv: bindingEnvironment(binding),
      externalPlanId: targetPlan.externalPlanId!,
      externalDeviceId: binding.externalDeviceId!,
      // Preserve the legacy required/unique column. New callbacks use operationId; providerSessionId
      // stores the real Stripe/BFF session when one exists.
      sessionId: operationId,
      operationId,
      operationType: binding.billingStatus === 'pending' ? 'subscribe' : 'plan_change',
      sourcePlanId: currentPlan.id,
      targetPlanId: targetPlan.id,
      checkoutEmail: input.email,
      successUrl: input.successUrl,
      failureUrl: input.failureUrl,
      webOrigin: input.origin,
      status: 'creating',
    },
  })
  try {
    const checkout = await createCheckout(bindingEnvironment(binding), token, input)
    if (isFreePlan(targetPlan) && !checkout.redirectUrl) {
      throw new AppError(
        'Autonomous billing service did not return a Free card setup URL',
        503,
        'BILLING_UPSTREAM_ERROR',
      )
    }
    await prisma.machineCheckoutAttempt.update({
      where: { id: attempt.id },
      data: {
        providerSessionId: checkout.sessionId ?? null,
        redirectUrl: checkout.redirectUrl ?? null,
        status: 'pending',
      },
    })
    return { operationId, ...checkout, action }
  } catch (err) {
    await prisma.machineCheckoutAttempt.update({
      where: { id: attempt.id },
      data: { status: 'failed', error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500) },
    }).catch(() => {})
    throw err
  }
}

function sameDate(left: Date | null, right: Date | null): boolean {
  return left?.getTime() === right?.getTime()
}

async function syncFromSubscription(
  binding: Machine,
  subscription: CampaignSubscription,
): Promise<{ binding: Machine; changed: boolean }> {
  const plan = subscription.planId
    ? await prisma.subscriptionPlan.findFirst({
      where: {
        externalPlanId: subscription.planId,
        campaignCode: env.HARNESS_CAMPAIGN_CODE,
        authMode: planAuthMode(binding),
        autonomousEnv: bindingEnvironment(binding),
      },
    })
    : null
  // Persist the provider truth, but leave the active -> suspended transition to the singleton
  // billing worker. That transition also stops the runtime and must not be performed partially by
  // an arbitrary clustered HTTP process serving GET /billing.
  const shouldAdoptPlan = !!plan && subscription.status !== SUBSCRIPTION_EXPIRED
  const nextPlanId = shouldAdoptPlan ? plan.id : binding.planId
  const nextSubscriptionId = subscription.id ?? binding.externalSubscriptionId
  const nextStatus = subscription.status ?? binding.externalSubscriptionStatus
  const nextEndAt = subscription.endAt ?? binding.externalSubscriptionEndAt
  const nextCancelledAt = nextStatus === SUBSCRIPTION_PAID || nextStatus === SUBSCRIPTION_FREE_TRIAL
    ? null
    : subscription.cancelledAt ?? binding.externalSubscriptionCancelledAt
  const changed = nextPlanId !== binding.planId ||
    nextSubscriptionId !== binding.externalSubscriptionId ||
    nextStatus !== binding.externalSubscriptionStatus ||
    !sameDate(nextEndAt, binding.externalSubscriptionEndAt) ||
    !sameDate(nextCancelledAt, binding.externalSubscriptionCancelledAt)
  if (!changed) return { binding, changed: false }
  if (subscription.planId && !plan) {
    logger.warn('campaign subscription plan unavailable; keeping current machine plan', {
      machineId: binding.machineId,
      autonomousEnv: bindingEnvironment(binding),
      externalPlanId: subscription.planId,
    })
  }
  const updated = await prisma.machine.update({
    where: { machineId: binding.machineId },
    data: {
      ...(nextPlanId !== binding.planId ? { planId: nextPlanId } : {}),
      ...(nextSubscriptionId !== binding.externalSubscriptionId
        ? { externalSubscriptionId: nextSubscriptionId }
        : {}),
      ...(nextStatus !== binding.externalSubscriptionStatus ? { externalSubscriptionStatus: nextStatus } : {}),
      ...(!sameDate(nextEndAt, binding.externalSubscriptionEndAt) ? { externalSubscriptionEndAt: nextEndAt } : {}),
      ...(!sameDate(nextCancelledAt, binding.externalSubscriptionCancelledAt)
        ? { externalSubscriptionCancelledAt: nextCancelledAt }
        : {}),
    },
  })
  return { binding: updated, changed: true }
}

async function syncSubscription(
  machineId: string,
  subscription: CampaignSubscription,
  expectedSubscriptionId?: string,
): Promise<{ binding: Machine; changed: boolean } | null> {
  return withMachineBillingLock(machineId, async () => {
    const binding = await prisma.machine.findUnique({ where: { machineId } })
    const billedMachine = isBilled(binding?.authMode)
    if (!binding || binding.deletedAt || !billedMachine) return null
    // A checkout may replace the subscription between the worker's candidate scan and this lock.
    // Never let an older campaign snapshot overwrite the newer subscription in that race.
    if (expectedSubscriptionId && binding.externalSubscriptionId !== expectedSubscriptionId) return null
    const result = await syncFromSubscription(binding, subscription)
    if (result.changed) {
      await publishDeviceMachineListChanged(binding.userId, { reason: 'updated' }).catch(() => {})
    }
    return result
  })
}

export const machineBillingService = {
  isFreePlan,
  syncSubscription,

  async reserveFreeEntitlement(userId: string, machineId: string, plan: SubscriptionPlan): Promise<void> {
    if (!isFreePlan(plan)) return
    const autonomousEnv = storedAutonomousEnvironment(plan.autonomousEnv)
    try {
      await prisma.machineFreeEntitlement.create({ data: { userId, autonomousEnv, machineId, status: 'reserved' } })
    } catch {
      const existing = await prisma.machineFreeEntitlement.findUnique({
        where: { userId_autonomousEnv: { userId, autonomousEnv } },
      })
      if (existing?.status === 'reserved' && existing.machineId === machineId) return
      throw new AppError('Free plan has already been used for this account', 409, 'FREE_PLAN_ALREADY_USED')
    }
  },

  async releaseFreeReservation(userId: string, machineId: string): Promise<void> {
    await prisma.machineFreeEntitlement.deleteMany({ where: { userId, machineId, status: 'reserved' } })
  },

  async freeEligibility(
    userId: string,
    autonomousEnv: AutonomousEnvironment,
  ): Promise<{ eligible: boolean; reason?: string }> {
    const eligible = await freeEligible(userId, autonomousEnv)
    return { eligible, ...(!eligible ? { reason: 'Free plan already used' } : {}) }
  },

  async beginCheckout(
    machineId: string,
    userId: string,
    email: string,
    token: string,
    origin: string,
    requestedEnvironment?: AutonomousEnvironment,
  ): Promise<CheckoutView> {
    return withMachineBillingLock(machineId, async () => {
      let { binding, plan } = await ownedPending(machineId, userId, requestedEnvironment)
      try {
        if (!binding.externalDeviceId) {
          const externalDeviceId = await createCampaignDevice(bindingEnvironment(binding), token)
          binding = await prisma.machine.update({
            where: { machineId },
            data: { externalDeviceId, billingError: null, billingErrorAt: null },
          })
        }
        return await startCheckoutOperation(binding, plan, plan, 'subscribe', userId, email, token, origin)
      } catch (err) {
        await prisma.machine.updateMany({
          where: { machineId, billingStatus: 'pending' },
          data: { billingError: err instanceof Error ? err.message.slice(0, 500) : 'Checkout failed', billingErrorAt: new Date() },
        }).catch(() => {})
        throw err
      }
    })
  },

  async beginPlanCheckout(
    machineId: string,
    userId: string,
    targetPlanId: string,
    email: string,
    token: string,
    origin: string,
    requestedEnvironment?: AutonomousEnvironment,
  ): Promise<CheckoutView> {
    return withMachineBillingLock(machineId, async () => {
      const binding = await ownedBinding(machineId, userId, requestedEnvironment)
      if (binding.billingStatus !== 'active' && binding.billingStatus !== 'suspended') {
        throw new AppError('Machine setup must be completed first', 409, 'MACHINE_PAYMENT_PENDING')
      }
      if (!isBilled(binding.authMode) || !binding.externalDeviceId) {
        throw new AppError('This machine does not use campaign billing', 400, 'BILLING_NOT_APPLICABLE')
      }
      const [currentPlan, targetPlan] = await Promise.all([
        planForBinding(binding),
        prisma.subscriptionPlan.findUnique({ where: { id: targetPlanId } }),
      ])
      if (binding.authMode === 'remote' && binding.billingStatus === 'active') {
        throw new AppError('Remote machines cannot change plans', 409, 'REMOTE_PLAN_CHANGE_NOT_ALLOWED')
      }
      if (binding.authMode === 'remote' && targetPlanId !== currentPlan.id) {
        throw new AppError('Remote machines can only re-subscribe to their current plan', 409, 'REMOTE_PLAN_CHANGE_NOT_ALLOWED')
      }
      if (binding.externalSubscriptionStatus === SUBSCRIPTION_CANCELLED &&
        (!binding.externalSubscriptionEndAt || binding.externalSubscriptionEndAt.getTime() > Date.now())) {
        throw new AppError('Renew the cancelled subscription before changing plan', 409, 'SUBSCRIPTION_CANCELLED')
      }
      if (!isCampaignPlan(targetPlan, bindingEnvironment(binding)) || targetPlan.available !== true ||
        targetPlan.authMode !== binding.authMode) {
        throw new AppError('Target plan is unavailable', 409, 'PLAN_UNAVAILABLE')
      }
      if (targetPlan.priceUsd === 0) {
        throw new AppError('Paid machines cannot downgrade to Free', 409, 'FREE_DOWNGRADE_NOT_ALLOWED')
      }
      if (binding.billingStatus === 'active' && currentPlan.id === targetPlan.id) {
        throw new AppError('Machine is already on this plan', 409, 'PLAN_ALREADY_ACTIVE')
      }
      const action = actionFor(currentPlan, targetPlan, binding.billingStatus === 'suspended')
      return startCheckoutOperation(binding, currentPlan, targetPlan, action, userId, email, token, origin)
    })
  },

  async complete(
    machineId: string,
    userId: string,
    token: string,
    operationId: string,
    outcome: 'success' | 'cancelled',
    requestedEnvironment?: AutonomousEnvironment,
  ): Promise<MachineBillingView> {
    return withMachineBillingLock(machineId, async () => {
      let binding = await ownedBinding(machineId, userId, requestedEnvironment)
      // operationId is the new stable callback key. Fall back to the legacy/provider session
      // columns so checkout URLs created before this rollout can still be completed safely.
      const attempt = await prisma.machineCheckoutAttempt.findFirst({
        where: {
          OR: [
            { operationId },
            { sessionId: operationId },
            { providerSessionId: operationId },
          ],
        },
        orderBy: { createdAt: 'desc' },
      })
      if (!attempt || attempt.machineId !== machineId || attempt.userId !== userId) {
        throw new AppError('Billing operation not found', 404, 'CHECKOUT_NOT_FOUND')
      }
      if (storedAutonomousEnvironment(attempt.autonomousEnv) !== bindingEnvironment(binding)) {
        throw new AppError('Billing operation belongs to another Autonomous environment', 409, 'BILLING_ENV_MISMATCH')
      }
      if (outcome === 'cancelled') {
        if (attempt.status !== 'completed') {
          await prisma.machineCheckoutAttempt.update({ where: { id: attempt.id }, data: { status: 'cancelled' } })
        }
        return buildBillingView(binding, false)
      }
      if (attempt.status === 'completed') return buildBillingView(binding, false)
      if (attempt.status === 'cancelled' || attempt.status === 'failed') {
        throw new AppError('This checkout was replaced by a newer one', 409, 'CHECKOUT_SUPERSEDED')
      }
      const targetPlanId = attempt.targetPlanId ?? binding.planId
      if (!targetPlanId) throw new AppError('Billing operation is incomplete', 409, 'CHECKOUT_NOT_READY')
      const targetPlan = await prisma.subscriptionPlan.findUnique({ where: { id: targetPlanId } })
      // The checkout attempt's externalPlanId is immutable. Catalog sync may update the local plan
      // row while the user is on Stripe; completion must still verify the plan that was purchased.
      if (!isCampaignPlan(targetPlan, bindingEnvironment(binding))) {
        throw new AppError('Billing operation target is unavailable', 409, 'PLAN_UNAVAILABLE')
      }
      if (targetPlan.authMode !== binding.authMode) {
        throw new AppError('Billing operation cannot change machine runtime type', 409, 'BILLING_OPERATION_STALE')
      }
      if (attempt.operationType === 'plan_change' && attempt.sourcePlanId &&
        binding.planId !== attempt.sourcePlanId && binding.planId !== targetPlanId) {
        throw new AppError('Billing operation is stale', 409, 'BILLING_OPERATION_STALE')
      }

      const autonomousEnv = bindingEnvironment(binding)
      const device = await getCampaignDevice(autonomousEnv, token, binding.externalDeviceId!)
      const expected = {
        campaignCode: env.HARNESS_CAMPAIGN_CODE,
        referenceId: binding.externalDeviceId!,
        planId: attempt.externalPlanId,
      }
      let subscription = subscriptionMatches(device.subscription, expected) ? device.subscription : undefined
      if (!subscription || !isEntitled(subscription)) {
        const subscriptions = await listCampaignSubscriptions(autonomousEnv, token, env.HARNESS_CAMPAIGN_CODE, binding.externalDeviceId!)
        subscription = subscriptionFor(subscriptions, binding, attempt.externalPlanId)
      }
      if (!subscription || !subscriptionMatches(subscription, expected) || !isEntitled(subscription)) {
        throw new AppError('Payment is not active for this machine and plan', 409, 'PAYMENT_NOT_VERIFIED')
      }
      if (targetPlan.authMode === 'managed' && !device.llmApiKey) {
        throw new AppError('Campaign credential is not ready yet', 409, 'CAMPAIGN_CREDENTIAL_NOT_READY')
      }

      if (isFreePlan(targetPlan)) {
        const entitlement = await prisma.machineFreeEntitlement.findUnique({
          where: { userId_autonomousEnv: { userId, autonomousEnv } },
        })
        if (entitlement && entitlement.machineId !== machineId) {
          throw new AppError('Free plan has already been used for this account', 409, 'FREE_PLAN_ALREADY_USED')
        }
        if (entitlement) {
          await prisma.machineFreeEntitlement.update({
            where: { userId_autonomousEnv: { userId, autonomousEnv } },
            data: { status: 'claimed', claimedAt: entitlement.claimedAt ?? new Date() },
          })
        } else {
          await prisma.machineFreeEntitlement.create({
            data: { userId, autonomousEnv, machineId, status: 'claimed', claimedAt: new Date() },
          })
        }
      }

      const wasPending = binding.billingStatus === 'pending'
      const wasSuspended = binding.billingStatus === 'suspended'
      const remote = isNodelessBilled(targetPlan.authMode)
      const managerId = remote ? '' : wasPending ? await reservationManager(binding) : binding.managerId
      binding = await prisma.machine.update({
        where: { machineId },
        data: {
          managerId,
          planId: targetPlan.id,
          billingStatus: 'active',
          externalSubscriptionId: subscription.id ?? binding.externalSubscriptionId,
          externalSubscriptionStatus: subscription.status ?? SUBSCRIPTION_PAID,
          externalSubscriptionEndAt: subscription.endAt ?? null,
          externalSubscriptionCancelledAt: null,
          billingActivatedAt: binding.billingActivatedAt ?? new Date(),
          billingError: null,
          billingErrorAt: null,
          llmApiKeyEncrypted: remote ? null : encryptMachineCredential(device.llmApiKey!),
        },
      })
      await prisma.machineCheckoutAttempt.update({
        where: { id: attempt.id },
        data: { status: 'completed', completedAt: new Date(), error: null },
      })
      await publishDeviceMachineListChanged(userId, { reason: wasPending ? 'created' : 'updated' }).catch(() => {})
      if (!remote && (wasPending || wasSuspended)) provisionActivatedMachine(binding, managerId, wasSuspended)
      return buildBillingView(binding, false)
    })
  },

  /** Backward-compatible activation for checkout URLs created before operationId was introduced. */
  async activate(
    machineId: string,
    userId: string,
    _email: string,
    token: string,
    _origin: string,
    sessionId?: string,
    _referenceCode?: string,
    requestedEnvironment?: AutonomousEnvironment,
  ): Promise<void> {
    const attempt = sessionId
      ? await prisma.machineCheckoutAttempt.findFirst({
        where: { OR: [{ operationId: sessionId }, { providerSessionId: sessionId }, { sessionId }] },
        orderBy: { createdAt: 'desc' },
      })
      : await prisma.machineCheckoutAttempt.findFirst({ where: { machineId }, orderBy: { createdAt: 'desc' } })
    if (!attempt) throw new AppError('Checkout session not found', 404, 'CHECKOUT_NOT_FOUND')
    const operationId = attempt.operationId ?? attempt.sessionId
    await this.complete(machineId, userId, token, operationId, 'success', requestedEnvironment)
  },

  async getBilling(
    machineId: string,
    userId: string,
    token: string,
    requestedEnvironment?: AutonomousEnvironment,
  ): Promise<MachineBillingView> {
    let binding = await ownedBinding(machineId, userId, requestedEnvironment)
    if (!isBilled(binding.authMode) || !binding.externalDeviceId) {
      throw new AppError('This machine does not use campaign billing', 400, 'BILLING_NOT_APPLICABLE')
    }
    await planForBinding(binding)
    const autonomousEnv = bindingEnvironment(binding)
    const [subscriptionsResult, usageResult, voiceUsageResult] = await Promise.allSettled([
      listCampaignSubscriptions(autonomousEnv, token, env.HARNESS_CAMPAIGN_CODE, binding.externalDeviceId),
      binding.authMode === 'managed'
        ? getCampaignDevice(autonomousEnv, token, binding.externalDeviceId)
        : Promise.resolve(null),
      voiceQuotaService.snapshotForMachine(binding.machineId),
    ])

    let stale = false
    if (subscriptionsResult.status === 'fulfilled') {
      try {
        const subscription = subscriptionFor(subscriptionsResult.value, binding)
        if (subscription) {
          const synced = await syncSubscription(machineId, subscription)
          if (synced) binding = synced.binding
        }
      } catch (err) {
        stale = true
        logger.warn('machine billing refresh failed; returning cached metadata', {
          machineId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    } else {
      if (subscriptionsResult.reason instanceof AppError && subscriptionsResult.reason.code === 'UNAUTHORIZED') {
        throw subscriptionsResult.reason
      }
      stale = true
      logger.warn('machine billing refresh failed; returning cached metadata', {
        machineId,
        error: subscriptionsResult.reason instanceof Error
          ? subscriptionsResult.reason.message
          : String(subscriptionsResult.reason),
      })
    }

    let dailyTokens: number | null = null
    if (usageResult.status === 'fulfilled') {
      if (usageResult.value) dailyTokens = Math.floor(usageResult.value.dailyUsage ?? 0)
    } else {
      if (usageResult.reason instanceof AppError && usageResult.reason.code === 'UNAUTHORIZED') throw usageResult.reason
      logger.warn('machine daily token usage unavailable', {
        machineId,
        error: usageResult.reason instanceof Error ? usageResult.reason.message : String(usageResult.reason),
      })
    }
    let dailyVoiceSeconds: number | null = null
    let voiceResetAt: string | null = null
    if (voiceUsageResult.status === 'fulfilled') {
      dailyVoiceSeconds = voiceUsageResult.value.usedSeconds
      voiceResetAt = voiceUsageResult.value.resetAt
    } else {
      logger.warn('machine daily voice usage unavailable', {
        machineId,
        error: voiceUsageResult.reason instanceof Error
          ? voiceUsageResult.reason.message
          : String(voiceUsageResult.reason),
      })
    }
    return buildBillingView(binding, stale, dailyTokens, dailyVoiceSeconds, voiceResetAt)
  },

  async cancel(
    machineId: string,
    userId: string,
    token: string,
    requestedEnvironment?: AutonomousEnvironment,
  ): Promise<MachineBillingView> {
    return withMachineBillingLock(machineId, async () => {
      let binding = await ownedBinding(machineId, userId, requestedEnvironment)
      if (binding.billingStatus !== 'active') throw new AppError('Machine subscription is not active', 409, 'SUBSCRIPTION_NOT_ACTIVE')
      const plan = await planForBinding(binding)
      if (plan.priceUsd <= 0) throw new AppError('Free plan cannot be cancelled', 409, 'FREE_PLAN_NOT_CANCELLABLE')
      const autonomousEnv = bindingEnvironment(binding)
      const subscriptions = await listCampaignSubscriptions(autonomousEnv, token, env.HARNESS_CAMPAIGN_CODE, binding.externalDeviceId!)
      const subscription = subscriptionFor(subscriptions, binding, plan.externalPlanId!)
      if (!subscription?.id) throw new AppError('Subscription was not found', 409, 'SUBSCRIPTION_NOT_FOUND')
      if (!subscription.endAt) throw new AppError('Subscription period end is unavailable', 409, 'BILLING_PERIOD_UNKNOWN')
      if (subscription.status !== SUBSCRIPTION_CANCELLED) {
        await cancelCampaignSubscription(autonomousEnv, token, subscription.id)
      }
      binding = await prisma.machine.update({
        where: { machineId },
        data: {
          externalSubscriptionId: subscription.id,
          externalSubscriptionStatus: SUBSCRIPTION_CANCELLED,
          externalSubscriptionEndAt: subscription.endAt,
          externalSubscriptionCancelledAt: subscription.cancelledAt ?? new Date(),
        },
      })
      await publishDeviceMachineListChanged(userId, { reason: 'updated' }).catch(() => {})
      return buildBillingView(binding, false)
    })
  },

  async renew(
    machineId: string,
    userId: string,
    token: string,
    requestedEnvironment?: AutonomousEnvironment,
  ): Promise<MachineBillingView> {
    return withMachineBillingLock(machineId, async () => {
      let binding = await ownedBinding(machineId, userId, requestedEnvironment)
      if (binding.billingStatus !== 'active' || binding.externalSubscriptionStatus !== SUBSCRIPTION_CANCELLED) {
        throw new AppError('Subscription is not cancelled', 409, 'SUBSCRIPTION_NOT_CANCELLED')
      }
      if (!binding.externalSubscriptionEndAt || binding.externalSubscriptionEndAt.getTime() <= Date.now()) {
        throw new AppError('Subscription has already expired', 409, 'SUBSCRIPTION_EXPIRED')
      }
      const autonomousEnv = bindingEnvironment(binding)
      const subscriptions = await listCampaignSubscriptions(autonomousEnv, token, env.HARNESS_CAMPAIGN_CODE, binding.externalDeviceId!)
      const subscription = subscriptionFor(subscriptions, binding)
      if (!subscription?.id || subscription.status !== SUBSCRIPTION_CANCELLED) {
        throw new AppError('Subscription is not cancelled', 409, 'SUBSCRIPTION_NOT_CANCELLED')
      }
      if (!subscription.endAt || subscription.endAt.getTime() <= Date.now()) {
        throw new AppError('Subscription has already expired', 409, 'SUBSCRIPTION_EXPIRED')
      }
      await renewCampaignSubscription(autonomousEnv, token, subscription.id)
      binding = await prisma.machine.update({
        where: { machineId },
        data: {
          externalSubscriptionStatus: SUBSCRIPTION_PAID,
          externalSubscriptionEndAt: subscription.endAt,
          externalSubscriptionCancelledAt: null,
        },
      })
      await publishDeviceMachineListChanged(userId, { reason: 'updated' }).catch(() => {})
      return buildBillingView(binding, false)
    })
  },

  /** Cancel every renewable upstream billing resource before hiding the machine locally. The local
   * soft delete is intentionally last: an upstream error leaves the machine visible and retryable. */
  async deleteCampaignMachine(
    machineId: string,
    userId: string,
    token: string,
    requestedEnvironment?: AutonomousEnvironment,
  ): Promise<void> {
    return withMachineBillingLock(machineId, async () => {
      const binding = await ownedBinding(machineId, userId, requestedEnvironment)
      if (!isBilled(binding.authMode)) {
        throw new AppError('This machine does not use campaign billing', 400, 'BILLING_NOT_APPLICABLE')
      }
      // Deletion never requires a resolvable plan: the plan row is local catalog data, while the
      // thing that actually bills lives upstream. When it is gone we cannot read a price, so we
      // assume the machine MAY be paid and fall through to provider truth (cancel + fire-intern)
      // below — strictly more cleanup than a known-free plan gets, and never a refusal.
      const plan = await planOrNull(binding)
      const maybePaid = plan ? plan.priceUsd > 0 : true

      // Was this machine ever activated upstream? `complete()` always stamps a subscription status
      // and `billingActivatedAt`, so the absence of every reference proves no subscription was ever
      // established for it — nothing can be renewing, whatever the provider says about the device.
      const everActivated = !!binding.externalSubscriptionId || !!binding.externalSubscriptionStatus ||
        !!binding.externalSubscriptionEndAt || !!binding.externalSubscriptionCancelledAt ||
        !!binding.billingActivatedAt

      const missingDeviceIsInconsistent = plan
        ? plan.priceUsd > 0 && binding.billingStatus !== 'pending'
        // Unknown plan: only upstream evidence proves a subscription ever existed. Without it there
        // is provably nothing to cancel, so the local row must not be held hostage to the catalog.
        : everActivated
      if (missingDeviceIsInconsistent && !binding.externalDeviceId) {
        // An activated paid machine without its provider reference is inconsistent. Never hide it:
        // ops must recover the device/subscription link so renewal can be cancelled authoritatively.
        throw new AppError(
          'Billing device is missing; subscription cancellation cannot be verified',
          409,
          'BILLING_CLEANUP_REQUIRED',
        )
      }

      if (binding.externalDeviceId) {
        const autonomousEnv = bindingEnvironment(binding)
        // "We know nothing can renew after this point." Only that justifies hiding the local row
        // when the provider then refuses to delete its device.
        let renewalDisabled = !maybePaid || binding.billingStatus === 'pending'
        if (maybePaid) {
          // Re-read provider truth instead of trusting cached status: a checkout callback or renew
          // may have completed in another tab. Explicitly cancel Paid/FreeTrial before fire-intern.
          let subscriptions: CampaignSubscription[] | undefined
          try {
            subscriptions = await listCampaignSubscriptions(autonomousEnv, token, env.HARNESS_CAMPAIGN_CODE, binding.externalDeviceId)
          } catch (err) {
            // The provider refuses to even look the device up (unknown/already-removed device,
            // campaign-code drift). A machine that was never activated has no subscription to
            // protect, so an unverifiable lookup must not make it permanently undeletable —
            // fire-intern is still attempted below and would cancel anything that did slip through.
            if (everActivated || !isUpstreamRejection(err)) throw err
            logger.warn('campaign subscription lookup rejected for a never-activated machine; continuing delete', {
              machineId, externalDeviceId: binding.externalDeviceId, autonomousEnv, error: err.message,
            })
          }
          if (subscriptions) {
            const subscription = subscriptionFor(subscriptions, binding)
            if (subscription?.id && isEntitled(subscription)) {
              // A live subscription is PROVEN here, so a failure to cancel it always aborts the
              // delete — no local state may excuse leaving a renewing charge behind.
              await cancelCampaignSubscription(autonomousEnv, token, subscription.id)
            }
            // Either we just cancelled it, or the provider itself reports no entitled subscription
            // for this device (none at all, cancelled, or expired). Both are authoritative proof
            // that nothing renews — including the "no subscription found" case, which used to be
            // read as "unverified" and left every such machine undeletable on a fire-intern 503.
            renewalDisabled = true
          }
        }
        // fire-intern is the provider's billing-safe delete. It cancels any remaining subscription
        // (including a pending/racing one), releases plan allocation, then deletes the device.
        try {
          await fireCampaignDevice(autonomousEnv, token, binding.externalDeviceId)
        } catch (err) {
          // Some provider deployments reject fire-intern after the explicit cancel because the
          // subscription is no longer Paid. Once cancellation is confirmed — or the machine was
          // never activated at all — recurring billing is already disabled: keep the
          // externalDeviceId on the soft-deleted audit row for later provider cleanup, but do not
          // trap the user in an undeletable local machine.
          if (!((renewalDisabled || !everActivated) && isUpstreamRejection(err))) throw err
          logger.warn('campaign device cleanup rejected; continuing soft delete', {
            machineId,
            externalDeviceId: binding.externalDeviceId,
            autonomousEnv,
            everActivated,
            renewalDisabled,
            error: err.message,
          })
        }
      }

      // Only now is it safe to hide the local machine. If any upstream call above throws, this write
      // is never reached and the user can retry deletion without losing the subscription record.
      await prisma.machine.update({ where: { machineId }, data: { deletedAt: new Date() } })
      await prisma.machineCheckoutAttempt.updateMany({
        where: { machineId, status: { in: ['creating', 'pending'] } },
        data: { status: 'cancelled', error: 'Machine deleted by owner' },
      })
      // Unconditional: the release is scoped to this machine AND `status: 'reserved'`, so an
      // activated Free machine (status 'claimed') keeps its lifetime entitlement spent. Not gated on
      // the plan, or a de-catalogued Free tier would strand the reservation and permanently block
      // the account's next Free machine.
      await this.releaseFreeReservation(userId, machineId)
      await publishDeviceMachineListChanged(userId, { reason: 'deleted' }).catch(() => {})
    })
  },

  async suspendIfDue(machineId: string): Promise<boolean> {
    return withMachineBillingLock(machineId, async () => {
      const binding = await prisma.machine.findUnique({ where: { machineId } })
      const overdueCutoff = new Date(Date.now() - BILLING_EXPIRY_GRACE_MS)
      const endAtOverdue = !!binding?.externalSubscriptionEndAt &&
        binding.externalSubscriptionEndAt.getTime() <= overdueCutoff.getTime()
      const providerExpired = binding?.externalSubscriptionStatus === SUBSCRIPTION_EXPIRED
      const billedMachine = isBilled(binding?.authMode)
      if (!binding || binding.deletedAt || !billedMachine || binding.billingStatus !== 'active' ||
        (!endAtOverdue && !providerExpired)) return false
      const updated = await prisma.machine.updateMany({
        where: {
          machineId,
          billingStatus: 'active',
          authMode: { in: [...BILLED_MODES] },
          // AND, not two sibling `OR`s: the alive filter is itself an OR (schema.prisma — a legacy row
          // LACKS `deletedAt` entirely, and `{deletedAt: null}` does not match absent), and spreading it
          // beside the overdue OR would have one silently overwrite the other.
          AND: [
            machineAlive,
            {
              OR: [
                { externalSubscriptionEndAt: { lte: overdueCutoff } },
                { externalSubscriptionStatus: SUBSCRIPTION_EXPIRED },
              ],
            },
          ],
        },
        data: { billingStatus: 'suspended' },
      })
      if (!updated.count) return false
      await publishDeviceMachineListChanged(binding.userId, { reason: 'updated' }).catch(() => {})
      if (binding.managerId) {
        await provisionViaManager(binding.managerId, 'stop', { machineId }).catch((err) => {
          logger.warn('suspended machine stop failed; manager reconcile will retry', {
            machineId,
            managerId: binding.managerId,
            error: err instanceof Error ? err.message : String(err),
          })
        })
      } else if (isNodelessBilled(binding.authMode)) {
        // No container to stop. For `remote` this frame closes the adapter's live socket without
        // revoking its token, so its retry loop then gets HTTP 402 until billing is restored.
        //
        // For `provider` there is no socket at all — the link is request-per-turn — so the frame is
        // simply not delivered anywhere, and enforcement rests entirely on `billingStatus`, which
        // `providerLink` consults before dialling. Publishing it anyway keeps the two modes on one
        // path and costs nothing when nobody is subscribed.
        await publishDown(machineId, {
          connId: '',
          frame: { type: REMOTE_BILLING_SUSPENDED_FRAME },
        }).catch((err) => {
          logger.warn('suspended machine disconnect publish failed', {
            machineId,
            authMode: binding.authMode,
            error: err instanceof Error ? err.message : String(err),
          })
        })
      }
      logger.info('machine subscription expired; machine suspended', { machineId, userId: binding.userId })
      return true
    })
  },

  async cancelPending(
    machineId: string,
    userId: string,
    token: string,
    requestedEnvironment?: AutonomousEnvironment,
  ): Promise<void> {
    const { binding } = await ownedPending(machineId, userId, requestedEnvironment)
    if (!isBilled(binding.authMode)) {
      throw new AppError('Machine does not require checkout', 400, 'CHECKOUT_NOT_REQUIRED')
    }
    await this.deleteCampaignMachine(machineId, userId, token, requestedEnvironment)
  },
}
