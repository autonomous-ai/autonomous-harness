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
