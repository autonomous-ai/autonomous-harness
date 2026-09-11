/**
 * Autonomous SSO — OAuth2 Authorization Code + PKCE.
 *
 * The backend builds the authorize URL, keeps PKCE verifier + CSRF state in a one-time Redis
 * transaction, and exchanges the code itself. The resulting SSO access token is returned to the web
 * and validated on subsequent control-plane requests through the Autonomous profile API.
 */
import { createHash, randomBytes } from 'crypto'
import { env } from '../config/env.js'
import { pub } from './bus.js'
import {
  autonomousEnvironmentConfig,
  isAutonomousEnvironment,
  type AutonomousEnvironment,
} from './autonomousEnvironment.js'

const b64url = (b: Buffer): string =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** A PKCE verifier (kept secret in the Redis transaction) + its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export const randomState = (): string => b64url(randomBytes(16))

const SSO_TX_TTL_SEC = 10 * 60
const ssoTxKey = (id: string): string => `sso:tx:${id}`

/** Per-login transaction stored server-side for 10 minutes. The browser only receives an opaque id. */
export interface SsoTx {
  verifier: string
  state: string
  next: string
  redirectUri: string
  webOrigin: string
  autonomousEnv: AutonomousEnvironment
}

function validTx(raw: unknown): raw is SsoTx {
  const tx = raw as Partial<SsoTx> | null
  return !!tx && typeof tx.verifier === 'string' && typeof tx.state === 'string' &&
    typeof tx.next === 'string' && typeof tx.redirectUri === 'string' && typeof tx.webOrigin === 'string' &&
    (tx.autonomousEnv === undefined || isAutonomousEnvironment(tx.autonomousEnv))
}

export async function createTx(tx: SsoTx): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = b64url(randomBytes(32))
    const stored = await pub.set(ssoTxKey(id), JSON.stringify(tx), 'EX', SSO_TX_TTL_SEC, 'NX')
    if (stored === 'OK') return id
  }
  throw new Error('could not allocate sso transaction')
}

/** Atomically read + delete so an authorization code transaction cannot be replayed. */
export async function consumeTx(id: string): Promise<SsoTx | null> {
  const raw = await pub.eval(
    "local v = redis.call('get', KEYS[1]); if v then redis.call('del', KEYS[1]) end; return v",
    1,
    ssoTxKey(id),
  )
  if (typeof raw !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return validTx(parsed)
      ? { ...parsed, autonomousEnv: parsed.autonomousEnv ?? 'prod' }
      : null
  } catch {
    return null
  }
}

// --- Origin derivation (so live→live, local→local without hardcoding) ------------------------------
const firstHeader = (v: string | string[] | undefined): string | undefined =>
  (Array.isArray(v) ? v[0] : v)?.split(',')[0].trim()

/** The SPA origin that initiated the login, from an explicit ?origin, else the Origin/Referer header. */
export function requestedWebOrigin(
  query: { origin?: string },
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  if (query.origin) return query.origin
  const origin = firstHeader(headers['origin'])
  if (origin) return origin
  const ref = firstHeader(headers['referer'])
  if (ref) {
    try {
      const u = new URL(ref)
      return `${u.protocol}//${u.host}`
    } catch {
      /* ignore */
    }
  }
  return undefined
}

/** Allowlist of SPA origins the post-login token may be redirected to (WEB_URL + WEB_ORIGINS). */
export function allowedWebOrigins(): string[] {
  return [env.WEB_URL, ...env.WEB_ORIGINS.split(',')]
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean)
}

/** Resolve the (trusted) SPA origin: the requested one IF allowlisted, else the primary WEB_URL. */
export function resolveWebOrigin(requested: string | undefined): string {
  const allow = allowedWebOrigins()
  const norm = requested?.trim().replace(/\/$/, '')
  return norm && allow.includes(norm) ? norm : allow[0] || env.WEB_URL
}

/** The WEB callback URL (the new SSO redirect_uri) — a page on the web origin, so the browser never
 *  lands on the API. An explicit SSO_REDIRECT_URI pins it; else it's the (allowlisted) web origin. */
/** Loopback-only redirect URIs for native/desktop OAuth. Accepts 127.0.0.1, localhost, [::1]. */
export function isLoopbackRedirectUri(redirectUri: string): boolean {
  let u: URL
  try { u = new URL(redirectUri) } catch { return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const host = u.hostname.toLowerCase()
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
}

export function webCallbackUri(webOrigin: string): string {
  return env.SSO_REDIRECT_URI || `${webOrigin.replace(/\/$/, '')}/auth/callback`
}

/** Where to send the browser to log in. `prompt=select_account` (env) forces the account picker so
 *  a user can switch accounts even when an SSO session already exists. */
export function authorizeUrl(
  challenge: string,
  state: string,
  redirectUri: string,
  autonomousEnv: AutonomousEnvironment,
): string {
  const config = autonomousEnvironmentConfig(autonomousEnv)
  const u = new URL('/oauth2/authorize', config.ssoIssuer)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', config.ssoClientId)
  u.searchParams.set('redirect_uri', redirectUri)
  u.searchParams.set('scope', env.SSO_SCOPE)
  u.searchParams.set('code_challenge', challenge)
  u.searchParams.set('code_challenge_method', 'S256')
  u.searchParams.set('state', state)
  if (env.SSO_PROMPT) u.searchParams.set('prompt', env.SSO_PROMPT)
  return u.toString()
}

/** End-session URL — clears the SSO session so the next login isn't silently auto-completed. */
export function logoutUrl(webOrigin: string, autonomousEnv: AutonomousEnvironment): string {
  const config = autonomousEnvironmentConfig(autonomousEnv)
  const u = new URL('/oauth2/logout', config.ssoIssuer)
  u.searchParams.set('client_id', config.ssoClientId)
  u.searchParams.set('post_logout_redirect_uri', webOrigin)
  return u.toString()
}

export interface SsoTokens {
  access_token?: string
  id_token?: string
  refresh_token?: string
  token_type?: string
  expires_in?: number
}

export class SsoTokenError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID_GRANT' | 'TOKEN_SERVICE_UNAVAILABLE',
  ) {
    super(message)
    this.name = 'SsoTokenError'
  }
}

async function requestTokens(
  body: URLSearchParams,
  autonomousEnv: AutonomousEnvironment,
): Promise<SsoTokens> {
  const config = autonomousEnvironmentConfig(autonomousEnv)
  if (config.ssoClientSecret) body.set('client_secret', config.ssoClientSecret)

  let res: Response
  try {
    res = await fetch(new URL('/oauth2/token', config.ssoIssuer).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(env.SSO_PROFILE_TIMEOUT_MS),
    })
  } catch {
    throw new SsoTokenError('SSO token service unavailable', 'TOKEN_SERVICE_UNAVAILABLE')
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    const invalidGrant = res.status === 400 && /invalid[_ -]?grant|invalid.*refresh|expired.*refresh/i.test(detail)
    throw new SsoTokenError(
      `SSO token endpoint returned ${res.status}`,
      invalidGrant ? 'INVALID_GRANT' : 'TOKEN_SERVICE_UNAVAILABLE',
    )
  }

  try {
    return (await res.json()) as SsoTokens
  } catch {
    throw new SsoTokenError('SSO token service returned invalid JSON', 'TOKEN_SERVICE_UNAVAILABLE')
  }
}

/** Exchange the authorization code for tokens (public client + PKCE; no secret unless configured). */
export async function exchangeCode(
  code: string,
  verifier: string,
  redirectUri: string,
  autonomousEnv: AutonomousEnvironment,
): Promise<SsoTokens> {
  const config = autonomousEnvironmentConfig(autonomousEnv)
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri, // MUST match the one sent to /authorize
    client_id: config.ssoClientId,
    code_verifier: verifier,
  })
  return requestTokens(body, autonomousEnv)
}

/** Exchange a browser-held refresh token for a fresh SSO access token. */
export async function refreshAccessToken(
  refreshToken: string,
  autonomousEnv: AutonomousEnvironment,
): Promise<SsoTokens> {
  const config = autonomousEnvironmentConfig(autonomousEnv)
  return requestTokens(new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.ssoClientId,
  }), autonomousEnv)
}
