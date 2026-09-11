import { randomUUID } from 'node:crypto'
import { env } from '../config/env.js'
import {
  CAMPAIGN_REFERENCE_BATCH_SIZE,
  hasCampaignSubscriptionApiKey,
  listCampaignSubscriptionsByApiKey,
} from '../lib/autonomousCampaign.js'
import {
  storedAutonomousEnvironment,
  type AutonomousEnvironment,
} from '../lib/autonomousEnvironment.js'
import { pub } from '../lib/bus.js'
import { machineAlive, prisma } from '../lib/prisma.js'
import { logger } from '../utils/logger.js'
import { BILLING_EXPIRY_GRACE_MS, machineBillingService } from './MachineBillingService.js'
import { voiceQuotaService } from '../lib/voiceQuota.js'

const INTERVAL_MS = 60_000
const LEASE_MS = 70_000
const BATCH_SIZE = 100
const LEASE_KEY = 'machine-billing-expiry-worker'
const SYNC_BEFORE_END_MS = 10 * 60_000
const SYNC_AFTER_END_MS = 30 * 60_000
const SUBSCRIPTION_EXPIRED = 5

interface SyncCandidate {
  machineId: string
  autonomousEnv: string
  externalDeviceId: string | null
  externalSubscriptionId: string | null
}

interface BillingWorkerResult {
  synced: number
  suspended: number
}

class MachineBillingWorkerService {
  private timer: NodeJS.Timeout | undefined
  private running = false

  start(): void {
    if (this.timer) return
    for (const autonomousEnv of ['prod', 'stag'] as const) {
      if (!hasCampaignSubscriptionApiKey(autonomousEnv)) {
        logger.warn('campaign subscription sync disabled; API key is not configured', { autonomousEnv })
      }
    }
    void this.tick()
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS)
    this.timer.unref?.()
    logger.info('machine billing worker started', {
      intervalMs: INTERVAL_MS,
      syncBeforeEndMs: SYNC_BEFORE_END_MS,
      syncAfterEndMs: SYNC_AFTER_END_MS,
    })
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  async runOnce(): Promise<BillingWorkerResult> {
    // Refresh provider truth first so a renewal observed in this pass moves endAt forward before the
    // local one-hour fallback evaluates the cached value.
    const synced = await this.syncDueSubscriptions()
    const suspended = await this.suspendExpiredSubscriptions()
    try {
      const voiceCleanup = await voiceQuotaService.cleanup()
      if (voiceCleanup.released || voiceCleanup.deleted) {
        logger.info('voice quota cleanup completed', voiceCleanup)
      }
    } catch (err) {
      // Quota cleanup is independent from subscription reconciliation; retry next minute without
      // turning a transient cleanup failure into a missed billing pass.
      logger.error('voice quota cleanup failed', err)
    }
    return { synced, suspended }
  }

  private async findSyncCandidates(): Promise<SyncCandidate[]> {
    const now = Date.now()
    // now - endAt ∈ [-10m, +30m] ⇔ endAt ∈ [now - 30m, now + 10m].
    const earliestEndAt = new Date(now - SYNC_AFTER_END_MS)
    const latestEndAt = new Date(now + SYNC_BEFORE_END_MS)
    const candidates: SyncCandidate[] = []
    let cursor: string | undefined
    while (true) {
      const page = await prisma.machine.findMany({
        where: {
          billingStatus: 'active',
          authMode: { in: BILLED_MODES },
          externalSubscriptionId: { not: null },
          externalSubscriptionEndAt: { gte: earliestEndAt, lte: latestEndAt },
          ...machineAlive,
        },
        orderBy: { machineId: 'asc' },
        take: BATCH_SIZE,
        ...(cursor ? { cursor: { machineId: cursor }, skip: 1 } : {}),
        select: {
          machineId: true,
          autonomousEnv: true,
          externalDeviceId: true,
          externalSubscriptionId: true,
        },
      })
      candidates.push(...page)
      if (page.length < BATCH_SIZE) break
      cursor = page.at(-1)?.machineId
      if (!cursor) break
    }
    return candidates
  }

  private async syncDueSubscriptions(): Promise<number> {
    const candidates = await this.findSyncCandidates()
    const byEnvironment = new Map<AutonomousEnvironment, SyncCandidate[]>()
    for (const candidate of candidates) {
      const autonomousEnv = storedAutonomousEnvironment(candidate.autonomousEnv)
      const group = byEnvironment.get(autonomousEnv) ?? []
      group.push(candidate)
      byEnvironment.set(autonomousEnv, group)
    }

    let synced = 0
    for (const [autonomousEnv, environmentCandidates] of byEnvironment) {
      if (!hasCampaignSubscriptionApiKey(autonomousEnv)) continue
      const candidatesWithDevice = environmentCandidates.filter(
        (candidate): candidate is SyncCandidate & { externalDeviceId: string } => !!candidate.externalDeviceId,
      )
      const missingDeviceId = environmentCandidates.length - candidatesWithDevice.length
      if (missingDeviceId) {
        logger.warn('campaign subscription sync skipped machines without a device id', {
          autonomousEnv,
          missingDeviceId,
        })
      }
      const referenceIds = [...new Set(candidatesWithDevice.map((candidate) => candidate.externalDeviceId))]
      let missingSubscription = 0
      let mismatchedReference = 0
      for (let offset = 0; offset < referenceIds.length; offset += CAMPAIGN_REFERENCE_BATCH_SIZE) {
        const referenceBatch = referenceIds.slice(offset, offset + CAMPAIGN_REFERENCE_BATCH_SIZE)
        const referenceSet = new Set(referenceBatch)
        const batchCandidates = candidatesWithDevice.filter(
          (candidate) => referenceSet.has(candidate.externalDeviceId),
        )
        try {
          const subscriptions = await listCampaignSubscriptionsByApiKey(
            autonomousEnv,
            env.HARNESS_CAMPAIGN_CODE,
            referenceBatch,
          )
          const byId = new Map(subscriptions.flatMap((subscription) =>
            subscription.id ? [[subscription.id, subscription] as const] : []))
          for (const candidate of batchCandidates) {
            if (!candidate.externalSubscriptionId) continue
            const subscription = byId.get(candidate.externalSubscriptionId)
            if (!subscription) {
              missingSubscription++
              continue
            }
            if (subscription.referenceId && subscription.referenceId !== candidate.externalDeviceId) {
              mismatchedReference++
              continue
            }
            try {
              const result = await machineBillingService.syncSubscription(
                candidate.machineId,
                subscription,
                candidate.externalSubscriptionId,
              )
              if (result?.changed) synced++
            } catch (err) {
              logger.error('machine subscription snapshot reconcile failed', err, {
                machineId: candidate.machineId,
                autonomousEnv,
              })
            }
          }
        } catch (err) {
          // Keep batches and environments isolated. One malformed/missing device must not block the
          // remaining candidates, and upstream failure must not prevent the +1h local fallback.
          logger.error('campaign subscription sync batch failed', err, {
            autonomousEnv,
            referenceCount: referenceBatch.length,
          })
        }
      }
      if (missingSubscription) {
        logger.warn('campaign subscription snapshot omitted active machine subscriptions', {
          autonomousEnv,
          missing: missingSubscription,
        })
      }
      if (mismatchedReference) {
        logger.warn('campaign subscription snapshot returned mismatched reference ids', {
          autonomousEnv,
          mismatchedReference,
        })
      }
    }
    return synced
  }

  private async suspendExpiredSubscriptions(): Promise<number> {
    const overdueCutoff = new Date(Date.now() - BILLING_EXPIRY_GRACE_MS)
    const due = await prisma.machine.findMany({
      where: {
        billingStatus: 'active',
        authMode: { in: BILLED_MODES },
        ...machineAlive,
        AND: [
          {
            OR: [
              { externalSubscriptionEndAt: { lte: overdueCutoff } },
              // Upstream may advance Cancelled -> Expired before our next pass. Expired is terminal
              // even if an older record omitted endAt, so it must not remain locally active.
              { externalSubscriptionStatus: SUBSCRIPTION_EXPIRED },
            ],
          },
        ],
      },
      orderBy: { externalSubscriptionEndAt: 'asc' },
      take: BATCH_SIZE,
      select: { machineId: true },
    })
    const results = await Promise.allSettled(due.map(({ machineId }) => machineBillingService.suspendIfDue(machineId)))
    let suspended = 0
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        if (result.value) suspended++
      } else {
        logger.error('machine billing expiry reconcile failed', result.reason, { machineId: due[index]?.machineId })
      }
    }
    return suspended
  }

  private async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    const token = randomUUID()
    try {
      if (await pub.set(LEASE_KEY, token, 'PX', LEASE_MS, 'NX') !== 'OK') return
      const result = await this.runOnce()
      if (result.synced || result.suspended) logger.info('machine billing pass completed', { ...result })
    } catch (err) {
      logger.error('machine billing expiry tick failed', err)
    } finally {
      await pub.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        LEASE_KEY,
        token,
      ).catch(() => {})
      this.running = false
    }
  }
}

/** Machine modes that carry a subscription, so the worker sweeps them for renewal and expiry.
 *  Kept as one list because it is used by two separate queries below — see the same set in
 *  MachineBillingService. */
const BILLED_MODES: string[] = ['managed', 'remote', 'provider']

export const machineBillingWorkerService = new MachineBillingWorkerService()
