import { prisma } from '../prisma.js'
import { env } from '../../config/env.js'
import { logger } from '../../utils/logger.js'

/**
 * One-time additive backfill for accounts that already activated a Free machine. Existing machines are
 * grandfathered: we only create the lifetime claim and never suspend/delete a duplicate historical
 * machine. A live pending account receives a reservation; abandoned pending setup rows are ignored.
 */
export async function backfillMachineFreeEntitlements(): Promise<void> {
  try {
    const freePlans = await prisma.subscriptionPlan.findMany({
      where: {
        authMode: 'managed',
        campaignCode: env.HARNESS_CAMPAIGN_CODE,
        priceUsd: 0,
      },
    })
    let created = 0
    for (const free of freePlans) {
      const bindings = await prisma.machine.findMany({
        where: { planId: free.id, autonomousEnv: free.autonomousEnv },
        orderBy: { createdAt: 'asc' },
      })
      const firstByUser = new Map<string, typeof bindings[number]>()
      for (const binding of bindings) {
        const activated = binding.billingStatus !== 'pending' || !!binding.billingActivatedAt
        // A failed checkout can leave a soft-deleted pending binding for audit. It never consumed the
        // Free entitlement and must not prevent the account from trying Free again.
        if (binding.deletedAt && !activated) continue
        const current = firstByUser.get(binding.userId)
        // Prefer any machine that reached activation over a merely pending live reservation.
        const currentActivated = current && (current.billingStatus !== 'pending' || !!current.billingActivatedAt)
        if (!current || (!currentActivated && activated)) firstByUser.set(binding.userId, binding)
      }
      for (const binding of firstByUser.values()) {
        const claimed = binding.billingStatus !== 'pending' || !!binding.billingActivatedAt
        try {
          await prisma.machineFreeEntitlement.create({
            data: {
              userId: binding.userId,
              autonomousEnv: free.autonomousEnv,
              machineId: binding.machineId,
              status: claimed ? 'claimed' : 'reserved',
              ...(claimed ? { claimedAt: binding.billingActivatedAt ?? binding.createdAt } : {}),
            },
          })
          created++
        } catch {
          // Unique account/environment/machine already backfilled by an earlier boot.
        }
      }
    }
    if (created) logger.info('Free machine entitlements backfilled', { created })
  } catch (err) {
    logger.error('Free machine entitlement backfill failed; worker will retry on next boot', err)
  }
}
