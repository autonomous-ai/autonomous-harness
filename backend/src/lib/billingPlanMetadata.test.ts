import { describe, expect, it } from 'vitest'
import { dailyTokenLimitForPlan } from './billingPlanMetadata.js'

describe('campaign plan metadata', () => {
  it('reads finite non-negative daily token limits and preserves unlimited zero', () => {
    expect(dailyTokenLimitForPlan({ externalMetadata: { daily_token_limit: 10_000_000 } })).toBe(10_000_000)
    expect(dailyTokenLimitForPlan({ externalMetadata: { daily_token_limit: '50000000' } })).toBe(50_000_000)
    expect(dailyTokenLimitForPlan({ externalMetadata: { daily_token_limit: 0 } })).toBe(0)
  })

  it('omits missing or invalid catalog limits', () => {
    expect(dailyTokenLimitForPlan({ externalMetadata: null })).toBeNull()
    expect(dailyTokenLimitForPlan({ externalMetadata: {} })).toBeNull()
    expect(dailyTokenLimitForPlan({ externalMetadata: { daily_token_limit: '' } })).toBeNull()
    expect(dailyTokenLimitForPlan({ externalMetadata: { daily_token_limit: -1 } })).toBeNull()
    expect(dailyTokenLimitForPlan({ externalMetadata: { daily_token_limit: 'many' } })).toBeNull()
  })
})
