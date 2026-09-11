import { describe, expect, it } from 'vitest'
import { billingStatusOf, subscriptionMatches } from './billingState.js'

describe('machine billing state', () => {
  it('grandfathers rows without billingStatus as active', () => {
    expect(billingStatusOf({ authMode: 'managed' })).toBe('active')
    expect(billingStatusOf({ authMode: 'remote' })).toBe('not_required')
    expect(billingStatusOf({ authMode: 'remote', billingStatus: 'not_required' })).toBe('not_required')
    expect(billingStatusOf({ authMode: 'remote', billingStatus: 'active' })).toBe('active')
    expect(billingStatusOf({ authMode: 'managed', billingStatus: 'pending' })).toBe('pending')
    expect(billingStatusOf({ authMode: 'remote', billingStatus: 'suspended' })).toBe('suspended')
  })

  it('requires campaign, device reference and plan id to all match', () => {
    const expected = { campaignCode: 'ai-harness-device', referenceId: 'device-1', planId: 38 }
    expect(subscriptionMatches({ campaignCode: 'ai-harness-device', referenceId: 'device-1', planId: 38 }, expected)).toBe(true)
    expect(subscriptionMatches({ campaignCode: 'other', referenceId: 'device-1', planId: 38 }, expected)).toBe(false)
    expect(subscriptionMatches({ campaignCode: 'ai-harness-device', referenceId: 'device-2', planId: 38 }, expected)).toBe(false)
    expect(subscriptionMatches({ campaignCode: 'ai-harness-device', referenceId: 'device-1', planId: 39 }, expected)).toBe(false)
  })
})
