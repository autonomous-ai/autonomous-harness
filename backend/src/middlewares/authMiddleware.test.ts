import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SsoAuthError } from '../lib/ssoAuth.js'
import { registerAuthMiddleware, resolveSsoAuth, shouldSkipAuth } from './authMiddleware.js'

const authenticate = vi.fn()

async function request() {
  const app = Fastify()
  registerAuthMiddleware(app, authenticate)
  app.get('/private', async (req) => ({ user: req.user }))
  const result = await app.inject({ method: 'GET', url: '/private', headers: { authorization: 'Bearer sso-token' } })
  await app.close()
  return result
}

describe('control-plane SSO auth middleware', () => {
  beforeEach(() => authenticate.mockReset())

  it('attaches the internal user resolved from a valid access token', async () => {
    authenticate.mockResolvedValue({ sub: 'internal-1', email: 'user@example.com', role: 'user' })
    const res = await request()
    expect(res.statusCode).toBe(200)
    expect(res.json().user.sub).toBe('internal-1')
    expect(authenticate).toHaveBeenCalledWith('sso-token', 'prod')
  })

  it('keeps only the native SSO flow public and rejects legacy machine-key routes', () => {
    expect(shouldSkipAuth('/api/machines/leave')).toBe(false)
    expect(shouldSkipAuth('/api/auth/authorize-native')).toBe(true)
    expect(shouldSkipAuth('/api/auth/refresh')).toBe(true)
    expect(shouldSkipAuth('/api/machines/join/code')).toBe(false)
    expect(shouldSkipAuth('/api/machines/join/poll')).toBe(false)
  })

  it('returns 401 only for invalid or expired tokens', async () => {
    const authenticateInvalid = async () => { throw new SsoAuthError('expired', 'INVALID_TOKEN') }
    await expect(resolveSsoAuth('sso-token', authenticateInvalid)).resolves.toEqual({
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'Unauthorized',
    })
  })

  it('returns 503 when the profile service is unavailable', async () => {
    const authenticateUnavailable = async () => { throw new SsoAuthError('offline', 'AUTH_SERVICE_UNAVAILABLE') }
    await expect(resolveSsoAuth('sso-token', authenticateUnavailable)).resolves.toEqual({
      status: 503,
      code: 'AUTH_SERVICE_UNAVAILABLE',
      message: 'Authentication service unavailable',
    })
  })

  it('returns the persisted environment when the token came from the wrong SSO plane', async () => {
    const mismatch = async () => {
      throw new SsoAuthError('wrong plane', 'AUTONOMOUS_ENV_MISMATCH', 'stag')
    }
    await expect(resolveSsoAuth('sso-token', mismatch, 'prod')).resolves.toEqual({
      status: 403,
      code: 'AUTONOMOUS_ENV_MISMATCH',
      message: 'wrong plane',
      requiredEnv: 'stag',
    })
  })
})
