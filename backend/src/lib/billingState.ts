import { AppError } from '../errors/index.js'

export type MachineBillingStatus = 'not_required' | 'pending' | 'active' | 'suspended'
export const REMOTE_BILLING_SUSPENDED_FRAME = '__billing_suspended'

/** Missing managed status is legacy-active; missing Remote status is grandfathered/unbilled. */
export function billingStatusOf(binding: { billingStatus?: string | null; authMode?: string | null }): MachineBillingStatus {
  if (binding.billingStatus === 'pending') return 'pending'
  if (binding.billingStatus === 'suspended') return 'suspended'
  if (binding.billingStatus === 'active') return 'active'
  if (binding.billingStatus === 'not_required') return 'not_required'
  // Remote rows created before campaign billing have no status and remain grandfathered.
  if (binding.authMode === 'remote') return 'not_required'
  return 'active'
}

export function assertMachineBillingActive(binding: { billingStatus?: string | null; authMode?: string | null }): void {
  if (billingStatusOf(binding) === 'pending') {
    throw new AppError('Machine payment is pending', 409, 'MACHINE_PAYMENT_PENDING')
  }
  if (billingStatusOf(binding) === 'suspended') {
    throw new AppError('Machine subscription is required', 402, 'MACHINE_SUBSCRIPTION_REQUIRED')
  }
}

export function machineBillingAllowsDataPlane(binding: { billingStatus?: string | null; authMode?: string | null }): boolean {
  const status = billingStatusOf(binding)
  return status === 'active' || status === 'not_required'
}

export function subscriptionMatches(
  subscription: { campaignCode?: string; referenceId?: string; planId?: number } | undefined,
  expected: { campaignCode: string; referenceId: string; planId: number },
): boolean {
  return !!subscription &&
    subscription.campaignCode === expected.campaignCode &&
    subscription.referenceId === expected.referenceId &&
    subscription.planId === expected.planId
}
