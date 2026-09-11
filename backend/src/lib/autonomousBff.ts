import { env } from '../config/env.js'
import { AppError } from '../errors/index.js'
import { autonomousEnvironmentConfig, type AutonomousEnvironment } from './autonomousEnvironment.js'

type JsonObject = Record<string, unknown>

export interface CampaignPlan {
  id: number
  code: 'free' | 'pro' | 'max' | 'remote' | 'provider'
  name: string
  amount: number
  currency: string
  metadata: JsonObject
}

export interface CheckoutInput {
  email: string
  planId: number
  referenceId: string
  referenceCode?: string
  successUrl: string
  failureUrl: string
  origin: string
}

export interface CheckoutResult {
  sessionId?: string
  redirectUrl?: string
}

export interface CampaignDevice {
  deviceId: string
  subscription?: CampaignSubscription
  llmApiKey?: string
  dailyUsage?: number
}

export interface CampaignSubscription {
  id?: string
  campaignCode?: string
  referenceId?: string
  planId?: number
  planName?: string
  status?: number
  startAt?: Date
  endAt?: Date
  cancelledAt?: Date
}

function object(value: unknown): JsonObject | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}

function unwrap(raw: unknown): unknown {
  const body = object(raw)
  if (!body) return raw
  if (body.status !== undefined && body.status !== 1 && body.status !== true && body.status !== 'success') {
    const message = typeof body.message === 'string' ? body.message : 'Autonomous BFF rejected the request'
    throw new AppError(message, 503, 'BILLING_UPSTREAM_ERROR')
  }
  return body.data ?? body.result ?? raw
}

function firstObject(raw: unknown): JsonObject {
  const value = unwrap(raw)
  if (Array.isArray(value)) return object(value[0]) ?? {}
  const obj = object(value) ?? {}
  for (const key of ['device', 'checkout', 'checkout_session', 'subscription_plan']) {
    const nested = object(obj[key])
    if (nested) return nested
  }
  return obj
}

function str(obj: JsonObject, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
}

function num(obj: JsonObject, ...keys: string[]): number | undefined {
  const value = str(obj, ...keys)
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function date(obj: JsonObject, ...keys: string[]): Date | undefined {
  for (const key of keys) {
    const value = obj[key]
    const timestamp = object(value)
    if (timestamp) {
      // Campaign APIs serialize protobuf timestamps as { seconds, nanos } rather than ISO strings.
      const seconds = num(timestamp, 'seconds')
      const nanos = num(timestamp, 'nanos') ?? 0
      if (seconds !== undefined) {
        const parsed = new Date(seconds * 1000 + nanos / 1_000_000)
        if (!Number.isNaN(parsed.getTime())) return parsed
      }
    }
    if (typeof value !== 'string' && typeof value !== 'number') continue
    const parsed = typeof value === 'number'
      ? new Date(value < 10_000_000_000 ? value * 1000 : value)
      : new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
}

export function parseSubscription(subscription: JsonObject): CampaignSubscription {
  return {
    id: str(subscription, 'id', '_id', 'subscription_id', 'subscriptionId'),
    campaignCode: str(subscription, 'campaign_code', 'campaignCode', 'code'),
    referenceId: str(subscription, 'reference_id', 'referenceId'),
    planId: num(subscription, 'plan_id', 'planId'),
    planName: str(subscription, 'plan_name', 'planName', 'name'),
    status: num(subscription, 'status', 'subscription_status', 'subscriptionStatus'),
    startAt: date(subscription, 'start_date', 'startDate', 'started_at', 'startedAt'),
    endAt: date(subscription, 'end_date', 'endDate', 'expires_at', 'expiresAt'),
    cancelledAt: date(subscription, 'cancelled_date', 'cancelledDate', 'canceled_at', 'cancelled_at'),
  }
}

async function request(
  autonomousEnv: AutonomousEnvironment,
  path: string,
  opts: { token?: string; method?: string; body?: unknown; origin?: string } = {},
): Promise<unknown> {
  let response: Response
  try {
    const environment = autonomousEnvironmentConfig(autonomousEnv)
    // Autonomous validates Origin separately from success_url/failure_url. A staging account used
    // from the production Machine UI must still present the staging allowlisted origin upstream, while
    // Stripe callbacks continue returning to the actual Machine web origin carried in the request body.
    const upstreamOrigin = opts.origin ? environment.checkoutOrigin : undefined
    response = await fetch(new URL(path, environment.bffUrl), {
      method: opts.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        location: 'en-US',
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(upstreamOrigin ? { Origin: upstreamOrigin } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: AbortSignal.timeout(env.AUTONOMOUS_BFF_TIMEOUT_MS),
    })
  } catch {
    throw new AppError('Autonomous billing service unavailable', 503, 'BILLING_SERVICE_UNAVAILABLE')
  }
  if (response.status === 401 || response.status === 403) {
    // The app auth middleware has already validated this same token through the profile API. Do not
    // report an upstream billing authorization failure as the Machine SSO session expiring: the web
    // would refresh once and then incorrectly log the user out.
    throw new AppError(
      'Autonomous billing service rejected the account session',
      502,
      'BILLING_UPSTREAM_UNAUTHORIZED',
    )
  }
  if (response.status === 404) {
    if (opts.method === 'DELETE') return undefined
    throw new AppError('Campaign device not found', 404, 'BILLING_DEVICE_NOT_FOUND')
  }
  if (!response.ok) {
    throw new AppError('Autonomous billing service unavailable', 503, 'BILLING_SERVICE_UNAVAILABLE')
  }
  if (response.status === 204) return undefined
  try { return await response.json() } catch {
    throw new AppError('Autonomous billing service returned invalid data', 503, 'BILLING_UPSTREAM_ERROR')
  }
}

function planCode(raw: JsonObject): CampaignPlan['code'] | undefined {
  const haystack = [str(raw, 'code', 'plan_code', 'slug'), str(raw, 'name', 'plan_name', 'title')]
    .filter(Boolean).join(' ').toLowerCase()
  // `provider` is tested BEFORE `pro` for readability only — the word boundary in /\bpro\b/ already
  // prevents "provider" from matching it. An upstream code this function does not recognise is
  // dropped by the caller, so a new tier appearing upstream is invisible here rather than fatal.
  if (/\bfree\b/.test(haystack)) return 'free'
  if (/\bprovider\b/.test(haystack)) return 'provider'
  if (/\bpro\b/.test(haystack)) return 'pro'
  if (/\bmax\b/.test(haystack)) return 'max'
  if (/\bremote\b/.test(haystack)) return 'remote'
  return undefined
}

export async function fetchCampaignPlans(autonomousEnv: AutonomousEnvironment): Promise<CampaignPlan[]> {
  const raw = unwrap(await request(autonomousEnv, `/api/v1/stand-to-earn/device/${encodeURIComponent(env.HARNESS_CAMPAIGN_CODE)}/subscription-plans`))
  const root = object(raw)
  const rows = Array.isArray(raw) ? raw : Array.isArray(root?.plans) ? root.plans : Array.isArray(root?.items) ? root.items : []
  const parsed: CampaignPlan[] = []
  for (const value of rows) {
    const p = object(value)
    if (!p) continue
    const frequencies = Array.isArray(p.frequencies) ? p.frequencies : []
    const monthly = frequencies.map(object).find((f) => f?.frequency === 'month') ?? object(frequencies[0])
    const id = num(monthly ?? p, 'id', 'plan_id')
    const code = planCode(p)
    if (!id || !code) continue
    parsed.push({
      id,
      code,
      name: str(p, 'name', 'plan_name', 'title') ?? code,
      amount: num(monthly ?? p, 'amount', 'price', 'price_usd') ?? 0,
      currency: (str(monthly ?? p, 'currency') ?? '').toUpperCase(),
      metadata: p,
    })
  }
  return parsed
}

export async function createCampaignDevice(autonomousEnv: AutonomousEnvironment, token: string): Promise<string> {
  const obj = firstObject(await request(autonomousEnv, '/api/v1/stand-to-earn/device', {
    token,
    method: 'POST',
    body: { device_type: env.HARNESS_DEVICE_TYPE, timezone: env.HARNESS_DEVICE_TIMEZONE_DEFAULT },
  }))
  const deviceId = str(obj, 'device_id', 'deviceId', 'id')
  if (!deviceId) throw new AppError('Autonomous billing service did not return a device id', 503, 'BILLING_UPSTREAM_ERROR')
  return deviceId
}

function checkoutBody(input: CheckoutInput): JsonObject {
  return {
    email: input.email,
    campaign_code: env.HARNESS_CAMPAIGN_CODE,
    plan_id: input.planId,
    reference_id: input.referenceId,
    quantity: 1,
    use_stripe_hosted_subscription: true,
    success_url: input.successUrl,
    failure_url: input.failureUrl,
  }
}

export async function createCheckout(autonomousEnv: AutonomousEnvironment, token: string, input: CheckoutInput): Promise<CheckoutResult> {
  const obj = firstObject(await request(autonomousEnv, '/api/v1/checkout/stripe/checkout-session', {
    token,
    method: 'POST',
    origin: input.origin,
    body: checkoutBody(input),
  }))
  const sessionId = str(obj, 'checkout_session_id', 'session_id', 'checkoutSessionId', 'sessionId', 'id')
  const redirectUrl = str(obj, 'redirect_url', 'checkout_url', 'redirectUrl', 'checkoutUrl', 'url')
  if (redirectUrl) {
    try {
      if (new URL(redirectUrl).protocol !== 'https:') throw new Error('not https')
    } catch {
      throw new AppError('Autonomous billing service returned an invalid checkout URL', 503, 'BILLING_UPSTREAM_ERROR')
    }
  }
  return { ...(sessionId ? { sessionId } : {}), ...(redirectUrl ? { redirectUrl } : {}) }
}

export async function completeCheckout(autonomousEnv: AutonomousEnvironment, token: string, sessionId: string, input: CheckoutInput): Promise<void> {
  const raw = await request(autonomousEnv, `/api/v1/checkout/stripe/checkout-complete/${encodeURIComponent(sessionId)}`, {
    token,
    method: 'POST',
    origin: input.origin,
    body: {
      ...checkoutBody(input),
      session_id: sessionId,
      ...(input.referenceCode ? { reference: input.referenceCode } : {}),
    },
  })
  // The BFF can report an application error in a HTTP 200 envelope. Do not silently continue to
  // device verification when checkout completion itself was rejected.
  unwrap(raw)
}

export async function getCampaignDevice(autonomousEnv: AutonomousEnvironment, token: string, deviceId: string): Promise<CampaignDevice> {
  const obj = firstObject(await request(autonomousEnv, `/api/v1/stand-to-earn/device/${encodeURIComponent(deviceId)}`, { token }))
  const subscription = object(obj.subscription)
  const parsedSubscription = subscription ? parseSubscription(subscription) : undefined
  const hasSubscription = !!parsedSubscription && Object.values(parsedSubscription).some((value) => value !== undefined)
  const dailyUsage = num(obj, 'daily_usage', 'dailyUsage')
  return {
    deviceId: str(obj, 'device_id', 'deviceId', 'id') ?? deviceId,
    llmApiKey: str(obj, 'llm_api_key', 'llmApiKey'),
    ...(dailyUsage !== undefined ? { dailyUsage: Math.max(0, dailyUsage) } : {}),
    ...(hasSubscription ? { subscription: parsedSubscription } : {}),
  }
}

export async function listCampaignSubscriptions(
  autonomousEnv: AutonomousEnvironment,
  token: string,
  campaignCode: string,
  referenceId: string,
): Promise<CampaignSubscription[]> {
  const query = new URLSearchParams({ campaign_code: campaignCode })
  query.append('reference_ids[]', referenceId)
  const raw = unwrap(await request(autonomousEnv, `/api/v1/me/subscriptions?${query.toString()}`, { token }))
  const root = object(raw)
  // Current BFF shape is {status:1,data:{data:[...],total:n}}. Keep the direct array/items aliases
  // for compatibility with older deployments.
  const rows = Array.isArray(raw)
    ? raw
    : Array.isArray(root?.data)
      ? root.data
      : Array.isArray(root?.subscriptions)
        ? root.subscriptions
        : Array.isArray(root?.items)
          ? root.items
          : []
  return rows.flatMap((value) => {
    const subscription = object(value)
    if (!subscription) return []
    return [parseSubscription(subscription)]
  })
}

export async function cancelCampaignSubscription(autonomousEnv: AutonomousEnvironment, token: string, subscriptionId: string): Promise<void> {
  const raw = await request(autonomousEnv, `/api/v1/me/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
    token,
    method: 'POST',
  })
  unwrap(raw)
}

export async function renewCampaignSubscription(autonomousEnv: AutonomousEnvironment, token: string, subscriptionId: string): Promise<void> {
  const raw = await request(autonomousEnv, `/api/v1/me/subscriptions/${encodeURIComponent(subscriptionId)}/renew`, {
    token,
    method: 'POST',
  })
  unwrap(raw)
}

/** Billing-safe device removal. Unlike raw DELETE, fire-intern also cancels the attached
 * subscription and releases any provider-side plan allocation before deleting the device. */
export async function fireCampaignDevice(autonomousEnv: AutonomousEnvironment, token: string, deviceId: string): Promise<void> {
  let raw: unknown
  try {
    raw = await request(autonomousEnv, `/api/v1/stand-to-earn/device/${encodeURIComponent(deviceId)}/fire-intern`, {
      token,
      method: 'POST',
    })
  } catch (err) {
    // A prior retry may already have fired the device. With no device left there is nothing that
    // can renew through this reference, so deletion remains idempotent.
    if (err instanceof AppError && err.code === 'BILLING_DEVICE_NOT_FOUND') return
    throw err
  }
  try { unwrap(raw) } catch (err) {
    if (err instanceof AppError && /not found/i.test(err.message)) return
    throw err
  }
}
