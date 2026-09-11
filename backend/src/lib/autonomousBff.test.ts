import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../config/env.js', () => ({
  env: {
    AUTONOMOUS_BFF_URL: 'https://bff.example',
    STAGING_AUTONOMOUS_BFF_URL: 'https://bff.staging.example',
    AUTONOMOUS_CHECKOUT_ORIGIN: 'https://autonomous.ai',
    STAGING_AUTONOMOUS_CHECKOUT_ORIGIN: 'https://staging.autonomousdev.xyz',
    AUTONOMOUS_BFF_TIMEOUT_MS: 1000,
    HARNESS_CAMPAIGN_CODE: 'ai-harness-device',
    HARNESS_DEVICE_TYPE: 15,
    HARNESS_DEVICE_TIMEZONE_DEFAULT: 'Asia/Saigon',
  },
}))

import {
  completeCheckout,
  createCampaignDevice,
  createCheckout,
  fetchCampaignPlans,
  fireCampaignDevice,
  getCampaignDevice,
  listCampaignSubscriptions,
} from './autonomousBff.js'

afterEach(() => vi.unstubAllGlobals())

describe('Autonomous campaign catalog', () => {
  it('reads billable ids and prices from each monthly frequencies entry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      status: 1,
      data: {
        plans: [
          { name: 'free', title: 'Free', daily_token_limit: 10, frequencies: [{ plan_id: 37, amount: 0, frequency: 'month', currency: 'USD' }] },
          { name: 'pro', title: 'Pro', daily_token_limit: 50, frequencies: [{ plan_id: 38, amount: 20, frequency: 'month', currency: 'USD' }] },
          { name: 'max', title: 'Max', daily_token_limit: 0, frequencies: [{ plan_id: 39, amount: 100, frequency: 'month', currency: 'USD' }] },
          { name: 'remote', title: 'Remote', frequencies: [{ plan_id: 40, amount: 10, frequency: 'month', currency: 'USD' }] },
        ],
      },
    }), { status: 200 })))

    const plans = await fetchCampaignPlans('prod')
    expect(plans.map((p) => [p.code, p.id, p.amount])).toEqual([
      ['free', 37, 0], ['pro', 38, 20], ['max', 39, 100], ['remote', 40, 10],
    ])
    expect(plans.every((p) => p.currency === 'USD')).toBe(true)
    expect(plans[1].metadata.daily_token_limit).toBe(50)
  })

  it('recognises the Provider tier without colliding with Pro', async () => {
    // Mirrors the live catalog (verified 2026-08-04): five tiers, Provider at $10/month.
    // `provider` and `pro` are one substring apart, so this pins the word boundary that keeps them
    // distinct — get it wrong and the Pro plan silently becomes the Provider plan.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      status: 1,
      data: {
        plans: [
          { name: 'free', title: 'Free', frequencies: [{ plan_id: 41, amount: 0, frequency: 'month', currency: 'USD' }] },
          { name: 'pro', title: 'Pro', frequencies: [{ plan_id: 42, amount: 20, frequency: 'month', currency: 'USD' }] },
          { name: 'max', title: 'Max', frequencies: [{ plan_id: 43, amount: 100, frequency: 'month', currency: 'USD' }] },
          { name: 'remote', title: 'Remote', frequencies: [{ plan_id: 44, amount: 10, frequency: 'month', currency: 'USD' }] },
          { name: 'provider', title: 'Provider', frequencies: [{ plan_id: 45, amount: 10, frequency: 'month', currency: 'USD' }] },
        ],
      },
    }), { status: 200 })))

    const plans = await fetchCampaignPlans('prod')
    expect(plans.map((p) => [p.code, p.id, p.amount])).toEqual([
      ['free', 41, 0], ['pro', 42, 20], ['max', 43, 100], ['remote', 44, 10], ['provider', 45, 10],
    ])
    // The decisive assertion: Pro kept its own id rather than being overwritten by Provider.
    expect(plans.find((p) => p.code === 'pro')?.id).toBe(42)
  })

  it('drops a tier it does not recognise rather than failing the whole catalog', async () => {
    // A tier appearing upstream before this backend knows about it must be INVISIBLE, not fatal:
    // the catalog is only usable if every known tier is present, so a stray row that inflated the
    // map would take Free/Pro/Max/Remote down with it.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      status: 1,
      data: {
        plans: [
          { name: 'free', title: 'Free', frequencies: [{ plan_id: 1, amount: 0, frequency: 'month', currency: 'USD' }] },
          { name: 'enterprise', title: 'Enterprise', frequencies: [{ plan_id: 99, amount: 500, frequency: 'month', currency: 'USD' }] },
        ],
      },
    }), { status: 200 })))

    const plans = await fetchCampaignPlans('prod')
    expect(plans.map((p) => p.code)).toEqual(['free'])
  })

  it('does not treat an empty subscription placeholder as a paid subscription', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      status: 1,
      data: { device_id: 'device-1', subscription: {} },
    }), { status: 200 })))

    await expect(getCampaignDevice('prod', 'token', 'device-1')).resolves.toEqual({
      deviceId: 'device-1',
      llmApiKey: undefined,
    })
  })

  it('parses daily token usage without exposing unrelated device fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      status: 1,
      data: { device_id: 'device-1', daily_usage: 230_946, monthly_usage: 900_000 },
    }), { status: 200 })))

    await expect(getCampaignDevice('prod', 'token', 'device-1')).resolves.toEqual({
      deviceId: 'device-1',
      llmApiKey: undefined,
      dailyUsage: 230_946,
    })
  })

  it('parses the nested subscription-list response used as the authoritative payment fallback', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      status: 1,
      data: {
        data: [{
          id: 'sub-1', campaign_code: 'ai-harness-device', reference_id: 'device-1',
          plan_id: 38, plan_name: 'Pro', status: 2,
        }],
        total: 1,
      },
    }), { status: 200 })))

    await expect(listCampaignSubscriptions('prod', 'token', 'ai-harness-device', 'device-1')).resolves.toEqual([{
      id: 'sub-1', campaignCode: 'ai-harness-device', referenceId: 'device-1', planId: 38, planName: 'Pro',
      status: 2, startAt: undefined, endAt: undefined, cancelledAt: undefined,
    }])
  })

  it('parses protobuf timestamp objects returned on campaign subscriptions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      status: 1,
      data: {
        device_id: 'device-1',
        subscription: {
          id: 'sub-1',
          start_date: { seconds: 1_784_703_323, nanos: 261_000_000 },
          end_date: { seconds: 1_787_381_732 },
          cancelled_date: {},
        },
      },
    }), { status: 200 })))

    const device = await getCampaignDevice('prod', 'token', 'device-1')
    expect(device.subscription?.startAt?.toISOString()).toBe('2026-07-22T06:55:23.261Z')
    expect(device.subscription?.endAt?.toISOString()).toBe('2026-08-22T06:55:32.000Z')
    expect(device.subscription?.cancelledAt).toBeUndefined()
  })

  it('forwards the callback reference code when completing hosted checkout', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Origin: 'https://autonomous.ai' })
      expect(JSON.parse(String(init?.body))).toMatchObject({
        session_id: 'checkout-1', reference: '2607000093', reference_id: 'device-1', plan_id: 38,
      })
      return new Response(JSON.stringify({ status: 1, data: {} }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await completeCheckout('prod', 'token', 'checkout-1', {
      email: 'owner@example.com', planId: 38, referenceId: 'device-1', referenceCode: '2607000093',
      successUrl: 'http://localhost:3000/machine-checkout?checkout=success',
      failureUrl: 'http://localhost:3000/machine-checkout?checkout=cancelled',
      origin: 'http://localhost:3000',
    })
  })

  it('forwards only the caller token and configured campaign device metadata to staging BFF', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer sso-access', location: 'en-US' })
      expect(url).toContain('https://bff.staging.example')
      if (url.endsWith('/api/v1/stand-to-earn/device')) {
        expect(body).toEqual({ device_type: 15, timezone: 'Asia/Saigon' })
        return new Response(JSON.stringify({ status: 1, data: { device_id: 'device-1' } }), { status: 200 })
      }
      expect(url).toContain('/api/v1/checkout/stripe/checkout-session')
      expect(init?.headers).toMatchObject({ Origin: 'https://staging.autonomousdev.xyz' })
      expect(body).toMatchObject({
        email: 'owner@example.com', campaign_code: 'ai-harness-device', plan_id: 38,
        reference_id: 'device-1', use_stripe_hosted_subscription: true,
      })
      return new Response(JSON.stringify({
        status: 1, data: { checkout_session_id: 'checkout-1', redirect_url: 'https://checkout.example/1' },
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(createCampaignDevice('stag', 'sso-access')).resolves.toBe('device-1')
    await expect(createCheckout('stag', 'sso-access', {
      email: 'owner@example.com', planId: 38, referenceId: 'device-1',
      successUrl: 'http://localhost:3000/machine-checkout?checkout=success',
      failureUrl: 'http://localhost:3000/machine-checkout?checkout=cancelled',
      origin: 'http://localhost:3000',
    })).resolves.toEqual({ sessionId: 'checkout-1', redirectUrl: 'https://checkout.example/1' })
  })

  it('does not classify a billing-upstream auth rejection as an expired Machine SSO session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ status: 0, message: 'Unauthorized' }),
      { status: 401 },
    )))

    await expect(createCheckout('stag', 'sso-access', {
      email: 'owner@example.com', planId: 38, referenceId: 'device-1',
      successUrl: 'https://harness.autonomous.ai/machine-checkout?checkout=success',
      failureUrl: 'https://harness.autonomous.ai/machine-checkout?checkout=cancelled',
      origin: 'https://harness.autonomous.ai',
    })).rejects.toMatchObject({
      statusCode: 502,
      code: 'BILLING_UPSTREAM_UNAUTHORIZED',
    })
  })

  it('parses a session-only response so the service can enforce plan-specific redirect rules', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      status: 1, data: { checkout_session_id: 'checkout-1' },
    }), { status: 200 })))

    await expect(createCheckout('prod', 'sso-access', {
      email: 'owner@example.com', planId: 37, referenceId: 'device-1',
      successUrl: 'http://localhost:3000/machine-checkout?checkout=success',
      failureUrl: 'http://localhost:3000/machine-checkout?checkout=cancelled',
      origin: 'http://localhost:3000',
    })).resolves.toEqual({ sessionId: 'checkout-1' })
  })

  it('uses fire-intern rather than raw device delete for billing-safe cleanup', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toContain('/api/v1/stand-to-earn/device/device-1/fire-intern')
      expect(init?.method).toBe('POST')
      return new Response(JSON.stringify({ status: 1, data: {} }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(fireCampaignDevice('prod', 'sso-access', 'device-1')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
