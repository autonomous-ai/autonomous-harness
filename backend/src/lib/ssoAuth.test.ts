import { afterEach, describe, expect, it, vi } from 'vitest'

const findByEmail = vi.hoisted(() => vi.fn())
const findByExternal = vi.hoisted(() => vi.fn())
const upsertFromSso = vi.hoisted(() => vi.fn())

vi.mock('../services/UserService.js', () => ({
  userService: { findByEmail, findByExternal, upsertFromSso },
  normalizeUserEmail: (email: string) => email.trim().toLowerCase(),
  isProvisionalUserEmail: (email: string) => email.endsWith('@pending.harness.invalid'),
}))

import { authenticateAccessToken, fetchSsoProfile, SsoAuthError } from './ssoAuth.js'

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('SSO profile authentication', () => {
  it('sends the SSO access token and required locale header', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(200, {
      status: 1,
      data: { id: 'external-1', email: 'USER@example.com' },
    }))

    await expect(fetchSsoProfile('access.token.value', fetchMock)).resolves.toEqual({
      id: 'external-1',
      email: 'USER@example.com',
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [, init] = fetchMock.mock.calls[0]
    expect(init?.headers).toMatchObject({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Location: 'en-US',
      Authorization: 'Bearer access.token.value',
    })
  })

  it('classifies 401 as an invalid token', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(401, { message: 'Invalid or expired JWT' }))
    await expect(fetchSsoProfile('expired', fetchMock)).rejects.toMatchObject({ code: 'INVALID_TOKEN' } satisfies Partial<SsoAuthError>)
  })

  it('classifies network and malformed-profile failures as service unavailable', async () => {
    const network = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'))
    await expect(fetchSsoProfile('token', network)).rejects.toMatchObject({ code: 'AUTH_SERVICE_UNAVAILABLE' } satisfies Partial<SsoAuthError>)

    const malformed = vi.fn<typeof fetch>().mockResolvedValue(response(200, { status: -1, message: 'missing location' }))
    await expect(fetchSsoProfile('token', malformed)).rejects.toMatchObject({ code: 'AUTH_SERVICE_UNAVAILABLE' } satisfies Partial<SsoAuthError>)
  })
})

describe('authenticated user resolution', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  function profileFetch(id: string, email: string): void {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response(200, {
      status: 1,
      data: { id, email },
    })))
  }

  it('uses normalized email as identity and saves the staging subject separately', async () => {
    profileFetch('stag-sub-1', ' Owner@Example.COM ')
    const existing = {
      id: 'u1',
      email: 'owner@example.com',
      externalId: 'prod-sub-1',
      stagExternalId: null,
      role: 'user',
      autonomousEnv: 'stag',
    }
    findByEmail.mockResolvedValue(existing)
    upsertFromSso.mockResolvedValue({ ...existing, stagExternalId: 'stag-sub-1' })

    await expect(authenticateAccessToken('a.e30.c', 'stag')).resolves.toEqual({
      sub: 'u1',
      email: 'owner@example.com',
      role: 'user',
      autonomousEnv: 'stag',
    })
    expect(upsertFromSso).toHaveBeenCalledWith(expect.objectContaining({
      externalId: 'stag-sub-1',
      email: 'owner@example.com',
      autonomousEnv: 'stag',
    }))
    expect(findByExternal).not.toHaveBeenCalled()
  })

  it('claims a prod provisional row by User.externalId', async () => {
    profileFetch('prod-sub-1', 'owner@example.com')
    findByEmail.mockResolvedValue(null)
    findByExternal.mockResolvedValue({
      id: 'pending',
      email: 'device-prod-sub-1@pending.harness.invalid',
      externalId: 'prod-sub-1',
      role: 'user',
      autonomousEnv: 'prod',
    })
    upsertFromSso.mockResolvedValue({
      id: 'pending',
      email: 'owner@example.com',
      role: 'user',
    })

    await expect(authenticateAccessToken('a.e30.c', 'prod')).resolves.toMatchObject({ sub: 'pending' })
    expect(upsertFromSso).toHaveBeenCalledOnce()
  })

  it('keeps unknown staging emails closed', async () => {
    profileFetch('stag-sub-new', 'new@example.com')
    findByEmail.mockResolvedValue(null)

    await expect(authenticateAccessToken('a.e30.c', 'stag')).rejects.toMatchObject({
      code: 'AUTONOMOUS_ENV_NOT_ALLOWED',
      requiredEnv: 'prod',
    })
    expect(upsertFromSso).not.toHaveBeenCalled()
  })

  it('rejects the wrong environment without mutating identity fields', async () => {
    profileFetch('prod-sub-1', 'owner@example.com')
    findByEmail.mockResolvedValue({
      id: 'u1',
      email: 'owner@example.com',
      externalId: 'local-prod-u1',
      role: 'user',
      autonomousEnv: 'stag',
    })

    await expect(authenticateAccessToken('a.e30.c', 'prod')).rejects.toMatchObject({
      code: 'AUTONOMOUS_ENV_MISMATCH',
      requiredEnv: 'stag',
    })
    expect(upsertFromSso).not.toHaveBeenCalled()
  })
})
