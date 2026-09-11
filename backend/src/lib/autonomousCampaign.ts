import { env } from '../config/env.js'
import type { AutonomousEnvironment } from './autonomousEnvironment.js'
import { autonomousEnvironmentConfig } from './autonomousEnvironment.js'
import { type CampaignSubscription, parseSubscription } from './autonomousBff.js'

type JsonObject = Record<string, unknown>

const PAGE_SIZE = 100
const MAX_PAGES = 1_000
export const CAMPAIGN_REFERENCE_BATCH_SIZE = 100

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

function number(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function pageData(raw: unknown): { rows: unknown[]; total?: number } {
  const envelope = object(raw)
  const status = number(envelope?.status)
  if (status !== undefined && status !== 1) {
    throw new Error(`Autonomous campaign subscription API rejected the request (status ${status})`)
  }
  const data = object(envelope?.data) ?? envelope
  const rows = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data?.subscriptions)
      ? data.subscriptions
      : Array.isArray(data?.items)
        ? data.items
        : Array.isArray(raw)
          ? raw
          : []
  return { rows, total: number(data?.total) }
}

export function hasCampaignSubscriptionApiKey(autonomousEnv: AutonomousEnvironment): boolean {
  return !!autonomousEnvironmentConfig(autonomousEnv).campaignApiKey
}

/** A device record as projected by the campaign service — trimmed to what the device flow actually uses.
 *
 *  The response also carries `fa_channel` / `fd_channel`, and they are deliberately NOT read: the device
 *  relays its own provisioned topics and those are what the bridge connects with, so parsing the record's
 *  copy would only invite someone to start trusting it. Broker credentials are absent from the projection
 *  entirely (as are the lobster api key and device secret). */
export interface CampaignDevice {
  id: string
  /** The Autonomous SSO subject == `User.externalId`. This is what attributes a device to an account. */
  customerId: string
  /** Account email from the record's `created_user_id`. Required — see the throw in the parser. */
  createdUserEmail: string
  status?: number
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Reads the campaign-wide subscription snapshot with a server credential. This deliberately lives
 * outside autonomousBff: the BFF client carries a user's bearer token, while this endpoint accepts
 * only x-api-key and is owned by the singleton worker.
 */
export async function listCampaignSubscriptionsByApiKey(
  autonomousEnv: AutonomousEnvironment,
  campaignCode: string,
  referenceIds: readonly string[],
): Promise<CampaignSubscription[]> {
  const uniqueReferenceIds = [...new Set(referenceIds.map((value) => value.trim()).filter(Boolean))]
  if (!uniqueReferenceIds.length) {
    throw new Error('Autonomous campaign subscription API requires at least one reference id')
  }
  if (uniqueReferenceIds.length > CAMPAIGN_REFERENCE_BATCH_SIZE) {
    throw new Error(
      `Autonomous campaign subscription API accepts at most ${CAMPAIGN_REFERENCE_BATCH_SIZE} reference ids per request`,
    )
  }
  const environment = autonomousEnvironmentConfig(autonomousEnv)
  if (!environment.campaignApiKey) {
    throw new Error(`Autonomous campaign subscription API key is not configured for ${autonomousEnv}`)
  }

  const subscriptions: CampaignSubscription[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL('/api/v1/subscriptions/', environment.campaignApiUrl)
    url.searchParams.set('campaign_code', campaignCode)
    for (const referenceId of uniqueReferenceIds) url.searchParams.append('reference_ids[]', referenceId)
    url.searchParams.set('page', String(page))
    url.searchParams.set('limit', String(PAGE_SIZE))

    let response: Response
    try {
      response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'x-api-key': environment.campaignApiKey,
        },
        signal: AbortSignal.timeout(env.AUTONOMOUS_BFF_TIMEOUT_MS),
      })
    } catch {
      throw new Error(`Autonomous campaign subscription API is unavailable for ${autonomousEnv}`)
    }
    if (!response.ok) {
      throw new Error(`Autonomous campaign subscription API failed for ${autonomousEnv} (HTTP ${response.status})`)
    }

    let raw: unknown
    try {
      raw = await response.json()
    } catch {
      throw new Error(`Autonomous campaign subscription API returned invalid data for ${autonomousEnv}`)
    }
    const { rows, total } = pageData(raw)
    for (const value of rows) {
      const row = object(value)
      if (!row) continue
      const parsed = parseSubscription(row)
      if (parsed.id) subscriptions.push(parsed)
    }
    if (rows.length === 0 || rows.length < PAGE_SIZE || (total !== undefined && subscriptions.length >= total)) {
      return subscriptions
    }
  }
  throw new Error(`Autonomous campaign subscription API exceeded ${MAX_PAGES} pages for ${autonomousEnv}`)
}
