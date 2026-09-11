import { env } from '../config/env.js'
import {
  isProvisionalUserEmail,
  normalizeUserEmail,
  userService,
} from '../services/UserService.js'
import {
  autonomousEnvironmentConfig,
  storedAutonomousEnvironment,
  type AutonomousEnvironment,
} from './autonomousEnvironment.js'

/** Internal identity attached to authenticated backend requests and user WebSockets. */
export interface AuthUser {
  sub: string // internal database user id
  email: string
  role: string
  autonomousEnv: AutonomousEnvironment
}

export interface SsoProfile {
  id: string
  email: string
}

export class SsoAuthError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID_TOKEN' | 'AUTH_SERVICE_UNAVAILABLE' | 'AUTONOMOUS_ENV_MISMATCH' | 'AUTONOMOUS_ENV_NOT_ALLOWED',
    readonly requiredEnv?: AutonomousEnvironment,
  ) {
    super(message)
    this.name = 'SsoAuthError'
  }
}

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined
  const m = /^Bearer\s+(.+)$/i.exec(header)
  return m ? m[1].trim() : undefined
}

type FetchLike = typeof fetch

/** Validate the SSO access token against the Autonomous profile service. */
export async function fetchSsoProfile(
  token: string,
  autonomousEnvOrFetch: AutonomousEnvironment | FetchLike = 'prod',
  fetchOverride?: FetchLike,
): Promise<SsoProfile> {
  // Preserve the old test/helper call shape fetchSsoProfile(token, fetchImpl) while production code
  // always supplies the environment explicitly.
  const autonomousEnv = typeof autonomousEnvOrFetch === 'function' ? 'prod' : autonomousEnvOrFetch
  const fetchImpl = typeof autonomousEnvOrFetch === 'function' ? autonomousEnvOrFetch : (fetchOverride ?? fetch)
  let res: Response
  try {
    res = await fetchImpl(autonomousEnvironmentConfig(autonomousEnv).ssoProfileUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Location: 'en-US',
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(env.SSO_PROFILE_TIMEOUT_MS),
    })
  } catch {
    throw new SsoAuthError('SSO profile service unavailable', 'AUTH_SERVICE_UNAVAILABLE')
  }

  if (res.status === 401 || res.status === 403) {
    throw new SsoAuthError('Invalid or expired SSO access token', 'INVALID_TOKEN')
  }
  if (!res.ok) {
    throw new SsoAuthError(`SSO profile service returned ${res.status}`, 'AUTH_SERVICE_UNAVAILABLE')
  }

  let raw: unknown
  try { raw = await res.json() } catch {
    throw new SsoAuthError('SSO profile service returned invalid JSON', 'AUTH_SERVICE_UNAVAILABLE')
  }
  const body = raw as { status?: unknown; message?: unknown; data?: { id?: unknown; email?: unknown } }
  if (body.status !== 1 || typeof body.data?.id !== 'string' || !body.data.id ||
      typeof body.data.email !== 'string' || !body.data.email) {
    const message = typeof body.message === 'string' ? body.message : ''
    if (/invalid|expired|unauthorized/i.test(message)) {
      throw new SsoAuthError('Invalid or expired SSO access token', 'INVALID_TOKEN')
    }
    throw new SsoAuthError('SSO profile service returned an invalid profile', 'AUTH_SERVICE_UNAVAILABLE')
  }
  return { id: body.data.id, email: body.data.email }
}

/** Optional metadata is read only AFTER the profile service has authenticated this access token. */
function accessTokenMetadata(token: string): { name?: string; roles?: string[] } {
  try {
    const part = token.split('.')[1]
    if (!part) return {}
    const raw = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
    const flat: Record<string, unknown> = {}
    for (const container of ['ext_info', 'user', 'profile', 'data', 'claims', 'userInfo', 'user_info']) {
      const value = raw[container]
      if (value && typeof value === 'object') Object.assign(flat, value)
    }
    Object.assign(flat, raw)
    const pick = (...keys: string[]): string | undefined => {
      for (const key of keys) {
        const value = flat[key]
        if (value != null && value !== '') return String(value)
      }
      return undefined
    }
    const given = pick('given_name', 'givenName', 'firstName', 'first_name')
    const family = pick('family_name', 'familyName', 'lastName', 'last_name')
    const name =
      pick('name', 'fullName', 'full_name', 'displayName', 'display_name', 'nickname', 'user_name', 'username') ??
      ([given, family].filter(Boolean).join(' ') || undefined)
    const roles = Array.isArray(flat.roles) ? flat.roles.map(String) : undefined
    return { ...(name ? { name } : {}), ...(roles ? { roles } : {}) }
  } catch {
    return {}
  }
}

/** Validate the token, mirror the external identity, then return the app's internal user identity. */
/**
 * @param enforceEnv Gate the caller on the account plane their user row is stamped with. TRUE for the
 *   web, which can be pointed at either plane and must not let the two identities cross.
 *
 *   FALSE for a surface that is production-only by construction — today that is `/api/mobile/*`. There
 *   the token is always validated against PROD SSO, so a staging token simply fails the profile fetch;
 *   what the flag drops is only the refusal to serve a user whose row happens to be stamped `stag`.
 *   Those rows are legacy (the schema backfilled every pre-existing user to staging), and rejecting
 *   them would lock long-standing customers out of the mobile app for a reason that has nothing to do
 *   with them. It is not a widening of access: the identity served is still the one prod SSO just
 *   verified, and `upsertFromSso` never rewrites `autonomousEnv`, so the user's web experience is
 *   untouched.
 */
export async function authenticateAccessToken(
  token: string,
  autonomousEnv: AutonomousEnvironment = 'prod',
  { enforceEnv = true }: { enforceEnv?: boolean } = {},
): Promise<AuthUser> {
  const profile = await fetchSsoProfile(token, autonomousEnv)
  const metadata = accessTokenMetadata(token)
  const email = normalizeUserEmail(profile.email)
  if (!email) throw new SsoAuthError('SSO profile service returned an invalid profile', 'AUTH_SERVICE_UNAVAILABLE')

  // Email is the account identity across Autonomous planes. Production may additionally claim the
  // deterministic provisional row created when an SDS device connected before its owner's first login.
  const byEmail = await userService.findByEmail(email)
  const byProdExternal = !byEmail && autonomousEnv === 'prod'
    ? await userService.findByExternal(profile.id)
    : null
  const provisional = !!byProdExternal && isProvisionalUserEmail(byProdExternal.email)
  const existing = byEmail ?? (provisional ? byProdExternal : null)

  if (enforceEnv && !existing && autonomousEnv === 'stag') {
    throw new SsoAuthError('Staging access is not enabled for this user', 'AUTONOMOUS_ENV_NOT_ALLOWED', 'prod')
  }
  if (enforceEnv && existing && !provisional) {
    const requiredEnv = storedAutonomousEnvironment(existing.autonomousEnv)
    if (requiredEnv !== autonomousEnv) {
      throw new SsoAuthError('Sign in through the configured Autonomous environment', 'AUTONOMOUS_ENV_MISMATCH', requiredEnv)
    }
  }
  const user = await userService.upsertFromSso({
    externalId: profile.id,
    email,
    autonomousEnv,
    ...metadata,
  })
  return { sub: user.id, email: user.email, role: user.role, autonomousEnv }
}
