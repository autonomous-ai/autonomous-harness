import type { FastifyInstance } from 'fastify'
import { userService } from '../services/index.js'
import { sendSuccess, sendError } from '../utils/response.js'
import { logger } from '../utils/logger.js'
import { authenticateAccessToken, SsoAuthError } from '../lib/ssoAuth.js'
import {
  pkcePair,
  randomState,
  createTx,
  consumeTx,
  authorizeUrl,
  logoutUrl,
  exchangeCode,
  refreshAccessToken,
  SsoTokenError,
  webCallbackUri,
  isLoopbackRedirectUri,
  resolveWebOrigin,
  requestedWebOrigin,
  type SsoTx,
} from '../lib/sso.js'
import { parseAutonomousEnvironment, type AutonomousEnvironment } from '../lib/autonomousEnvironment.js'

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // 1) Start login (web-driven). The web fetches this (XHR, so the API URL never hits the address
  //    bar), stashes the returned opaque `tx` id in sessionStorage, and navigates the browser to
  //    `authorizeUrl` (the SSO provider). redirect_uri is the WEB callback page, not the API.
  app.post<{ Body: { next?: string; origin?: string; autonomousEnv?: AutonomousEnvironment } }>('/api/auth/authorize', async (req, reply) => {
    const { verifier, challenge } = pkcePair()
    const state = randomState()
    const next = typeof req.body?.next === 'string' && req.body.next ? req.body.next : '/'
    const webOrigin = resolveWebOrigin(requestedWebOrigin(req.body ?? {}, req.headers))
    const redirectUri = webCallbackUri(webOrigin)
    let autonomousEnv: AutonomousEnvironment
    try { autonomousEnv = parseAutonomousEnvironment(req.body?.autonomousEnv) } catch {
      return sendError(reply, 'invalid Autonomous environment', 'INVALID_AUTONOMOUS_ENV', 400)
    }
    try {
      const tx = await createTx({ verifier, state, next, redirectUri, webOrigin, autonomousEnv })
      return sendSuccess(reply, { authorizeUrl: authorizeUrl(challenge, state, redirectUri, autonomousEnv), tx })
    } catch {
      return sendError(reply, 'login transaction service unavailable', 'AUTH_SERVICE_UNAVAILABLE', 503)
    }
  })

  // 2) Exchange the SSO code for its access token (web-driven). The web `/auth/callback` page reads
  //    ?code&state + the `tx` it stashed, and POSTs them here (XHR). The BACKEND exchanges the code
  //    then validates the access token through the profile service, mirrors the user and returns that
  //    SAME access token in the body. No backend-owned session JWT is minted.
  app.post<{ Body: { code?: string; state?: string; tx?: string } }>(
    '/api/auth/exchange',
    async (req, reply) => {
      const { code, state, tx: txRaw } = req.body ?? {}
      let tx: SsoTx | null = null
      try {
        tx = txRaw ? await consumeTx(txRaw) : null
      } catch {
        return sendError(reply, 'login transaction service unavailable', 'AUTH_SERVICE_UNAVAILABLE', 503)
      }
      if (!code || !state || !tx || tx.state !== state) {
        return sendError(reply, 'invalid_state', 'INVALID_STATE', 400)
      }
      try {
        const tokens = await exchangeCode(code, tx.verifier, tx.redirectUri, tx.autonomousEnv)
        const token = tokens.access_token
        if (!token) throw new Error('sso response had no access_token')
        const user = await authenticateAccessToken(token, tx.autonomousEnv)
        logger.info('sso login', {
          userId: user.sub,
          email: user.email || '(empty)',
          autonomousEnv: user.autonomousEnv,
          hasRefreshToken: !!tokens.refresh_token,
          expiresIn: tokens.expires_in,
        })
        return sendSuccess(reply, {
          token,
          next: tx.next,
          autonomousEnv: tx.autonomousEnv,
          ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
          ...(typeof tokens.expires_in === 'number' ? { expiresIn: tokens.expires_in } : {}),
        })
      } catch (e) {
        if (e instanceof SsoAuthError && e.code === 'AUTH_SERVICE_UNAVAILABLE') {
          return sendError(reply, e.message, e.code, 503)
        }
        if (e instanceof SsoAuthError &&
          (e.code === 'AUTONOMOUS_ENV_MISMATCH' || e.code === 'AUTONOMOUS_ENV_NOT_ALLOWED')) {
          return reply.code(403).send({
            success: false,
            error: {
              code: e.code,
              message: e.message,
              ...(e.requiredEnv ? { requiredEnv: e.requiredEnv } : {}),
            },
          })
        }
        return sendError(reply, e instanceof Error ? e.message : 'sso_failed', 'SSO_FAILED', 502)
      }
    },
  )

  app.post<{ Body: { refreshToken?: string; autonomousEnv?: AutonomousEnvironment } }>(
    '/api/auth/refresh',
    async (req, reply) => {
      const refreshToken = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken.trim() : ''
      if (!refreshToken) return sendError(reply, 'refresh token is required', 'INVALID_REFRESH_REQUEST', 400)

      let autonomousEnv: AutonomousEnvironment
      try { autonomousEnv = parseAutonomousEnvironment(req.body?.autonomousEnv) } catch {
        return sendError(reply, 'invalid Autonomous environment', 'INVALID_AUTONOMOUS_ENV', 400)
      }

      try {
        const tokens = await refreshAccessToken(refreshToken, autonomousEnv)
        const token = tokens.access_token
        if (!token) throw new SsoTokenError('SSO refresh returned no access token', 'TOKEN_SERVICE_UNAVAILABLE')
        const user = await authenticateAccessToken(token, autonomousEnv)
        logger.info('sso token refreshed', {
          userId: user.sub,
          autonomousEnv,
          rotatedRefreshToken: !!tokens.refresh_token,
          expiresIn: tokens.expires_in,
        })
        return sendSuccess(reply, {
          token,
          ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
          ...(typeof tokens.expires_in === 'number' ? { expiresIn: tokens.expires_in } : {}),
        })
      } catch (e) {
        if (e instanceof SsoTokenError) {
          return sendError(
            reply,
            e.code === 'INVALID_GRANT' ? 'Refresh token is invalid or expired' : 'Authentication service unavailable',
            e.code === 'INVALID_GRANT' ? 'REFRESH_TOKEN_INVALID' : 'AUTH_SERVICE_UNAVAILABLE',
            e.code === 'INVALID_GRANT' ? 401 : 503,
          )
        }
        if (e instanceof SsoAuthError && e.code === 'AUTH_SERVICE_UNAVAILABLE') {
          return sendError(reply, e.message, e.code, 503)
        }
        if (e instanceof SsoAuthError &&
          (e.code === 'AUTONOMOUS_ENV_MISMATCH' || e.code === 'AUTONOMOUS_ENV_NOT_ALLOWED')) {
          return reply.code(403).send({
            success: false,
            error: {
              code: e.code,
              message: e.message,
              ...(e.requiredEnv ? { requiredEnv: e.requiredEnv } : {}),
            },
          })
        }
        return sendError(reply, 'Unable to refresh SSO session', 'AUTH_SERVICE_UNAVAILABLE', 503)
      }
    },
  )

  // 1b) Native/desktop-driven login (loopback OAuth). Accepts an explicit loopback redirect_uri so a
  //     desktop client can run a local HTTP listener to capture the SSO callback; unlike the web
  //     authorize, it never derives redirect_uri from a web origin. /exchange reuses tx.redirectUri.
  app.post<{ Body: { redirectUri?: string; autonomousEnv?: AutonomousEnvironment } }>(
    '/api/auth/authorize-native',
    async (req, reply) => {
      const redirectUri = typeof req.body?.redirectUri === 'string' ? req.body.redirectUri.trim() : ''
      if (!redirectUri || !isLoopbackRedirectUri(redirectUri)) {
        return sendError(reply, 'redirectUri must be a loopback address (http://127.0.0.1:<port> or http://localhost:<port>)', 'INVALID_REDIRECT_URI', 400)
      }
      let autonomousEnv: AutonomousEnvironment
      try { autonomousEnv = parseAutonomousEnvironment(req.body?.autonomousEnv) } catch {
        return sendError(reply, 'invalid Autonomous environment', 'INVALID_AUTONOMOUS_ENV', 400)
      }
      try {
        const { verifier, challenge } = pkcePair()
        const state = randomState()
        const webOrigin = new URL(redirectUri).origin
        const tx = await createTx({ verifier, state, next: '/', redirectUri, webOrigin, autonomousEnv })
        return sendSuccess(reply, { authorizeUrl: authorizeUrl(challenge, state, redirectUri, autonomousEnv), tx })
      } catch {
        return sendError(reply, 'login transaction service unavailable', 'AUTH_SERVICE_UNAVAILABLE', 503)
      }
    },
  )

  // 3) SSO end-session URL (web-driven). The web fetches this (XHR), then navigates the browser to the
  //    returned issuer logout URL — without this the issuer's session cookie survives and the next
  //    login silently auto-completes with the same account. The API URL never hits the address bar.
  app.get<{ Querystring: { origin?: string; autonomousEnv?: AutonomousEnvironment } }>('/api/auth/logout-url', async (req, reply) => {
    let autonomousEnv: AutonomousEnvironment
    try { autonomousEnv = parseAutonomousEnvironment(req.query.autonomousEnv) } catch {
      return sendError(reply, 'invalid Autonomous environment', 'INVALID_AUTONOMOUS_ENV', 400)
    }
    return sendSuccess(reply, {
      logoutUrl: logoutUrl(resolveWebOrigin(requestedWebOrigin(req.query, req.headers)), autonomousEnv),
    })
  })

  // Current session's mirrored user, SSO-access-token gated by the auth middleware.
  app.get('/api/auth/me', async (req, reply) => {
    const user = await userService.get(req.user!.sub)
    if (!user) return sendError(reply, 'user not found', 'NOT_FOUND', 404)
    return sendSuccess(reply, { user: userService.toPublic(user), avatarUrl: null, description: null })
  })
}
