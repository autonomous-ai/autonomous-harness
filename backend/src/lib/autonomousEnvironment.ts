import { env } from '../config/env.js'

export const autonomousEnvironments = ['prod', 'stag'] as const
export type AutonomousEnvironment = typeof autonomousEnvironments[number]

export function isAutonomousEnvironment(value: unknown): value is AutonomousEnvironment {
  return value === 'prod' || value === 'stag'
}

/** Missing values are production for backward-compatible clients; malformed explicit values fail. */
export function parseAutonomousEnvironment(
  value: unknown,
  fallback: AutonomousEnvironment = 'prod',
): AutonomousEnvironment {
  if (value == null || value === '') return fallback
  if (isAutonomousEnvironment(value)) return value
  throw new Error('INVALID_AUTONOMOUS_ENV')
}

/** Reads a persisted row safely during rolling migration, before the worker has stamped it. */
export function storedAutonomousEnvironment(value: unknown): AutonomousEnvironment {
  return isAutonomousEnvironment(value) ? value : 'stag'
}

export interface AutonomousEnvironmentConfig {
  name: AutonomousEnvironment
  ssoIssuer: string
  ssoClientId: string
  ssoClientSecret?: string
  ssoProfileUrl: string
  bffUrl: string
  checkoutOrigin: string
  campaignApiUrl: string
  campaignApiKey?: string
}

/** Single source of truth for upstream account-plane routing. */
export function autonomousEnvironmentConfig(name: AutonomousEnvironment): AutonomousEnvironmentConfig {
  if (name === 'stag') {
    return {
      name,
      ssoIssuer: env.STAGING_SSO_ISSUER,
      ssoClientId: env.STAGING_SSO_CLIENT_ID || env.SSO_CLIENT_ID,
      ssoClientSecret: env.STAGING_SSO_CLIENT_SECRET || env.SSO_CLIENT_SECRET,
      ssoProfileUrl: env.STAGING_SSO_PROFILE_URL,
      bffUrl: env.STAGING_AUTONOMOUS_BFF_URL,
      checkoutOrigin: env.STAGING_AUTONOMOUS_CHECKOUT_ORIGIN,
      campaignApiUrl: env.STAGING_AUTONOMOUS_CAMPAIGN_API_URL,
      campaignApiKey: env.STAGING_AUTONOMOUS_CAMPAIGN_API_KEY || undefined,
    }
  }
  return {
    name,
    ssoIssuer: env.SSO_ISSUER,
    ssoClientId: env.SSO_CLIENT_ID,
    ssoClientSecret: env.SSO_CLIENT_SECRET,
    ssoProfileUrl: env.SSO_PROFILE_URL,
    bffUrl: env.AUTONOMOUS_BFF_URL,
    checkoutOrigin: env.AUTONOMOUS_CHECKOUT_ORIGIN,
    campaignApiUrl: env.AUTONOMOUS_CAMPAIGN_API_URL,
    campaignApiKey: env.AUTONOMOUS_CAMPAIGN_API_KEY || undefined,
  }
}
