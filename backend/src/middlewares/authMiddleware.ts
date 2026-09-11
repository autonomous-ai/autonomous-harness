import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { authenticateAccessToken, bearerToken, SsoAuthError } from '../lib/ssoAuth.js'
import type { AuthUser } from '../lib/ssoAuth.js'
import { ForbiddenError } from '../errors/index.js'
import { parseAutonomousEnvironment, type AutonomousEnvironment } from '../lib/autonomousEnvironment.js'

/**
 * Public local routes (no user access token). Data-plane requests never reach Fastify — they're
 * intercepted in the serverFactory (see server.ts) — so this gate only sees the control
 * API. Everything except health + login requires a valid SSO access token.
 */
export function shouldSkipAuth(url: string): boolean {
  const path = url.split('?')[0]
  return (
    path === '/api/health' ||
    // Web-driven SSO login (pre-session): /authorize returns the SSO URL, /exchange trades the code
    // for the SSO access token, /logout-url returns the SSO end-session URL. All fetched by web XHR.
    path === '/api/auth/authorize' ||
    path === '/api/auth/authorize-native' ||
    path === '/api/auth/exchange' ||
    path === '/api/auth/refresh' ||
    path === '/api/auth/logout-url' ||
    // Public app-deploy registration — agent-key gated (x-api-key), self-validated in its
    // own preHandler (agentAuth). Called by the agent-node's domain MCP, not the web SSO token.
    path === '/api/apps' ||
    path.startsWith('/api/apps/') ||
    // Public agent-key validation — agent-key gated (x-api-key), self-validated in the handler.
    // Called by the shared CCR gateway to authorize an agent-node's Claude CLI bearer token.
    path === '/api/machines/validate' ||
    // Analytics collector write path — machine-key gated (x-api-key), self-validated in its own
    // preHandler (machineAuth). The READ endpoints under /api/analytics/ are NOT listed here: they
    // are dashboard calls and must carry the owner's SSO token.
    path === '/api/analytics/report' ||
    // The mobile group is production-only by construction and runs its own SSO preHandler, which
    // pins the plane to prod and skips the account-plane gate (see routes/mobile.ts). It is NOT
    // unauthenticated — skipping here only means "not gated by THIS hook".
    path.startsWith('/api/mobile/') ||
    // The Cursor desktop app's two standalone endpoints — both shared-secret gated (`api_key` header),
    // self-validated in their own preHandler (routes/cursor.ts). That client has no SSO token. Listed
    // one by one on purpose: a future /api/cursor/* route must not inherit the skip by accident.
    path === '/api/cursor/stt' ||
    path === '/api/cursor/summarize' ||
    path === '/api/cursor/route' ||
    // Device-authorization grant for the desktop app. These two are unauthenticated BY DESIGN — the app
    // has no credential yet, which is the entire reason the flow exists. Neither reveals anything:
    // `start` returns codes it just minted, and `poll` needs the 32-byte device code and answers once.
    // The approve/deny/lookup half is NOT listed and stays SSO-gated — that is where the user's identity
    // and their machine list are involved. Listed one by one, like the cursor pair above.
    path === '/api/device-auth/start' ||
    path === '/api/device-auth/poll'
  )
}

export function registerAuthMiddleware(
  app: FastifyInstance,
  authenticate: typeof authenticateAccessToken = authenticateAccessToken,
): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (shouldSkipAuth(request.url)) return
    const token = bearerToken(request.headers['authorization'])
    if (!token) {
      return reply.code(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } })
    }
    let autonomousEnv: AutonomousEnvironment
    try {
      autonomousEnv = parseAutonomousEnvironment(request.headers['x-autonomous-env'])
    } catch {
      return reply.code(400).send({ success: false, error: { code: 'INVALID_AUTONOMOUS_ENV', message: 'Invalid Autonomous environment' } })
    }
    const auth = await resolveSsoAuth(token, authenticate, autonomousEnv)
    if ('user' in auth) {
      request.user = auth.user
      return
    }
    return reply.code(auth.status).send({
      success: false,
      error: {
        code: auth.code,
        message: auth.message,
        ...(auth.requiredEnv ? { requiredEnv: auth.requiredEnv } : {}),
      },
    })
  })
}

export async function resolveSsoAuth(
  token: string,
  authenticate: typeof authenticateAccessToken = authenticateAccessToken,
  autonomousEnv: AutonomousEnvironment = 'prod',
): Promise<
  | { user: AuthUser }
  | {
    status: 401 | 403 | 503
    code: 'UNAUTHORIZED' | 'AUTH_SERVICE_UNAVAILABLE' | 'AUTONOMOUS_ENV_MISMATCH' | 'AUTONOMOUS_ENV_NOT_ALLOWED'
    message: string
    requiredEnv?: AutonomousEnvironment
  }
> {
  try {
    return { user: await authenticate(token, autonomousEnv) }
  } catch (err) {
    if (err instanceof SsoAuthError && err.code === 'AUTH_SERVICE_UNAVAILABLE') {
      return { status: 503, code: 'AUTH_SERVICE_UNAVAILABLE', message: 'Authentication service unavailable' }
    }
    if (err instanceof SsoAuthError &&
      (err.code === 'AUTONOMOUS_ENV_MISMATCH' || err.code === 'AUTONOMOUS_ENV_NOT_ALLOWED')) {
      return {
        status: 403,
        code: err.code,
        message: err.message,
        ...(err.requiredEnv ? { requiredEnv: err.requiredEnv } : {}),
      }
    }
    return { status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' }
  }
}

/** Throw 403 unless the authenticated user is an admin. */
export function requireAdmin(request: FastifyRequest): void {
  if (request.user?.role !== 'admin') {
    throw new ForbiddenError('Admin only')
  }
}
