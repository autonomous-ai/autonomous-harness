import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'

const authDir = await mkdtemp(`${tmpdir()}/harness-auth-session-`)
process.env.HARNESS_AUTH_DIR = authDir

const {
  AUTH_SESSION_FILE,
  AuthSessionError,
  AuthSessionManager,
  clearAuthSession,
  readAuthSession,
  writeAuthSession,
} = await import('./authSession.js')

const baseSession = () => ({
  version: 1 as const,
  accessToken: 'old-access',
  refreshToken: 'refresh-1',
  expiresAt: Date.now() - 1,
  autonomousEnv: 'prod' as const,
  computerId: 'computer-1',
  machineId: 'machine-1',
  updatedAt: Date.now(),
})

afterEach(() => {
  clearAuthSession()
  vi.unstubAllGlobals()
})

afterAll(async () => {
  delete process.env.HARNESS_AUTH_DIR
  await rm(authDir, { recursive: true, force: true })
})

describe('AuthSessionManager', () => {
  it('coalesces concurrent expired-token refreshes into one request and persists the rotated tokens', async () => {
    writeAuthSession(baseSession())
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { token: 'new-access', refreshToken: 'refresh-2', expiresIn: 3600 },
    })))
    vi.stubGlobal('fetch', fetchMock)
    const manager = new AuthSessionManager('https://api.example.test')

    await expect(Promise.all([manager.accessToken(), manager.accessToken()])).resolves.toEqual(['new-access', 'new-access'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(readAuthSession()).toMatchObject({ accessToken: 'new-access', refreshToken: 'refresh-2' })
    await expect(readFile(AUTH_SESSION_FILE, 'utf8')).resolves.toContain('new-access')
  })

  it('uses the newer persisted access token rather than refreshing a stale 401 again', async () => {
    writeAuthSession({ ...baseSession(), accessToken: 'already-refreshed', expiresAt: Date.now() + 3_600_000 })
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const manager = new AuthSessionManager('https://api.example.test')

    await expect(manager.accessToken({ force: true, failedToken: 'old-access' })).resolves.toBe('already-refreshed')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('names `harness login` when the refresh service answers 503, because that is what a dead token looks like here', async () => {
    // Measured 2026-09-06 against the live backend: an unusable refresh token comes back as
    // `503 {"error":{"code":"AUTH_SERVICE_UNAVAILABLE"}}`, NOT 401 and not REFRESH_TOKEN_INVALID.
    // So this answer is indistinguishable from a real outage, and the message has to carry both
    // readings — saying only the upstream's "Authentication service unavailable" sends somebody
    // with a dead sign-in away to wait for a service that is fine.
    writeAuthSession(baseSession())
    // A fresh Response per call: a body can only be read once, so one shared Response would make
    // every call after the first see an empty body and prove nothing about the message.
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      success: false,
      error: { code: 'AUTH_SERVICE_UNAVAILABLE', message: 'Authentication service unavailable' },
    }), { status: 503 })))
    const manager = new AuthSessionManager('https://api.example.test')

    const err = await manager.accessToken().catch((e: unknown) => e) as InstanceType<typeof AuthSessionError>
    expect(err).toMatchObject({ name: AuthSessionError.name, code: 'UNAVAILABLE' })
    expect(err.message).toMatch(/harness login/)          // the way out, which the upstream never names
    expect(err.message).toMatch(/Authentication service unavailable/)  // the upstream's own words, kept
  })

  it('keeps the session when the refresh service is merely unavailable', async () => {
    // The other half of the same ambiguity, and the reason this must NOT be reclassified as
    // INVALID_REFRESH: that branch deletes the session, and deleting it on a transient blip
    // destroys a refresh token nothing can bring back. Ambiguous means keep, and say so.
    writeAuthSession(baseSession())
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      success: false,
      error: { code: 'AUTH_SERVICE_UNAVAILABLE', message: 'Authentication service unavailable' },
    }), { status: 503 })))
    const manager = new AuthSessionManager('https://api.example.test')

    await expect(manager.accessToken()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(readAuthSession()).toMatchObject({ refreshToken: 'refresh-1' })
  })

  it('still says `harness login` when the service gives no message of its own', async () => {
    writeAuthSession(baseSession())
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error('socket hang up')))
    const manager = new AuthSessionManager('https://api.example.test')

    await expect(manager.accessToken()).rejects.toThrow(/harness login/)
    expect(readAuthSession()).toMatchObject({ refreshToken: 'refresh-1' })
  })

  it('clears an invalid refresh session instead of retrying it forever', async () => {
    writeAuthSession(baseSession())
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      success: false,
      error: { code: 'REFRESH_TOKEN_INVALID', message: 'expired' },
    }), { status: 401 })))
    const manager = new AuthSessionManager('https://api.example.test')

    await expect(manager.accessToken()).rejects.toMatchObject({ name: AuthSessionError.name, code: 'INVALID_REFRESH' })
    expect(readAuthSession()).toBeNull()
  })
})
