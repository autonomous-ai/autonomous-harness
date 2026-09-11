import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify'

const listDetailedForUser = vi.hoisted(() => vi.fn())
const detailForUser = vi.hoisted(() => vi.fn())
const rename = vi.hoisted(() => vi.fn())
const listForUser = vi.hoisted(() => vi.fn())
const revokeDeviceForUser = vi.hoisted(() => vi.fn())
const authenticateAccessToken = vi.hoisted(() => vi.fn())

vi.mock('../services/index.js', () => ({
  deviceService: { listDetailedForUser, detailForUser, rename },
  machineService: { listForUser },
  machineDisplayName: (id: string) => `machine-${id.slice(0, 6)}`,
}))
vi.mock('../lib/deviceRevoke.js', () => ({ revokeDeviceForUser }))
// Only the SSO network call is faked. bearerToken, SsoAuthError and resolveSsoAuth stay REAL, so the
// preHandler's token parsing and its 401/503/403 mapping are genuinely exercised.
vi.mock('../lib/ssoAuth.js', async (importActual) => ({
  ...(await importActual<typeof import('../lib/ssoAuth.js')>()),
  authenticateAccessToken,
}))

import { mobileRoutes } from './mobile.js'
import { errorHandler } from '../middlewares/errorHandler.js'
import { SsoAuthError } from '../lib/ssoAuth.js'
import { shouldSkipAuth } from '../middlewares/authMiddleware.js'

/** The real OwnerMachine shape, apiKey included — that is the point of several tests below. */
const machine = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  machineId: '7f3ca1b29c4d5e6f7a8b9c0d1e2f3a4b',
  apiKey: 'sk-super-secret-data-plane-key',
  workspaceId: null,
  planId: 'plan-pro',
  autonomousEnv: 'prod',
  authMode: 'managed',
  planName: 'Pro',
  billingStatus: 'active',
  createdAt: new Date('2026-07-01T00:00:00Z'),
  status: 'running',
  agentCount: 2,
  engine: 'claude',
  name: null,
  ...over,
})

const device = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  deviceId: '6a70088ae13f6277cdf9015a',
  name: 'device',
  online: true,
  lastSeenAt: new Date('2026-08-01T00:00:00Z'),
  createdAt: new Date('2026-07-01T00:00:00Z'),
  macAddress: 'AA:BB:CC:DD:EE:FF',
  firmwareVersion: '0.2.8',
  chip: 'esp32s3',
  ssid: null,
  rssi: null,
  activeMachineId: null,
  ...over,
})

const USER = { sub: 'u1', email: 'a@b.c', role: 'user', autonomousEnv: 'prod' }

async function buildApp(user: Record<string, unknown> | null = USER): Promise<FastifyInstance> {
  if (user) authenticateAccessToken.mockResolvedValue(user)
  const app = Fastify({ logger: false })
  app.setErrorHandler(errorHandler)
  await app.register(mobileRoutes)
  await app.ready()
  return app
}

/** Every call carries a token — the group authenticates itself now. */
function call(app: FastifyInstance, opts: InjectOptions & { noAuth?: boolean }) {
  const { noAuth, ...rest } = opts
  return app.inject({ ...rest, headers: noAuth ? {} : { authorization: 'Bearer sso-token' } })
}

const overview = (app: FastifyInstance) => call(app, { method: 'GET', url: '/api/mobile/v1/overview' })

beforeEach(() => {
  vi.clearAllMocks()
  listDetailedForUser.mockResolvedValue([])
  listForUser.mockResolvedValue([])
  detailForUser.mockResolvedValue(null)
  rename.mockResolvedValue(null)
  revokeDeviceForUser.mockResolvedValue(true)
})

describe('auth — production-only, account-plane gate off', () => {
  it('is excluded from the global hook, so its own preHandler is the gate', () => {
    // If this ever flips back, the global hook re-applies the env gate and every legacy `stag` user
    // gets a 403 from the mobile app.
    expect(shouldSkipAuth('/api/mobile/v1/overview')).toBe(true)
    expect(shouldSkipAuth('/api/machines')).toBe(false)
  })

  it('401s with no Authorization header', async () => {
    const app = await buildApp()
    const res = await call(app, { method: 'GET', url: '/api/mobile/v1/overview', noAuth: true })

    expect(res.statusCode).toBe(401)
    expect(authenticateAccessToken).not.toHaveBeenCalled()
  })

  it('always validates against PROD with the env gate disabled', async () => {
    const app = await buildApp()
    await overview(app)

    expect(authenticateAccessToken).toHaveBeenCalledWith('sso-token', 'prod', { enforceEnv: false })
  })

  it('ignores x-autonomous-env — there is no staging mobile app', async () => {
    const app = await buildApp()
    await app.inject({
      method: 'GET', url: '/api/mobile/v1/overview',
      headers: { authorization: 'Bearer sso-token', 'x-autonomous-env': 'stag' },
    })

    expect(authenticateAccessToken).toHaveBeenCalledWith('sso-token', 'prod', { enforceEnv: false })
  })

  it('serves a user whose row is stamped stag — those rows are legacy, not an error', async () => {
    // The web answers this user 403 AUTONOMOUS_ENV_MISMATCH. The mobile app must not.
    const app = await buildApp({ ...USER, autonomousEnv: 'stag' })
    listDetailedForUser.mockResolvedValue([device()])

    expect((await overview(app)).statusCode).toBe(200)
  })

  it('401s a token prod SSO rejects', async () => {
    authenticateAccessToken.mockRejectedValue(new SsoAuthError('nope', 'INVALID_TOKEN'))
    const app = await buildApp(null)

    expect((await overview(app)).statusCode).toBe(401)
  })

  it('503s when SSO itself is unreachable, so the app does not sign the user out', async () => {
    authenticateAccessToken.mockRejectedValue(new SsoAuthError('down', 'AUTH_SERVICE_UNAVAILABLE'))
    const app = await buildApp(null)
    const res = await overview(app)

    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('AUTH_SERVICE_UNAVAILABLE')
  })
})

describe('machine list is by user, never by environment', () => {
  it('passes no env filter, so legacy stag-stamped machines still appear', async () => {
    const app = await buildApp({ ...USER, autonomousEnv: 'stag' })
    await overview(app)

    expect(listForUser).toHaveBeenCalledWith('u1')
    expect(listForUser).not.toHaveBeenCalledWith('u1', expect.anything())
  })

  it('returns machines whose own row says stag', async () => {
    listForUser.mockResolvedValue([machine({ autonomousEnv: 'stag' })])
    const app = await buildApp()

    expect(JSON.parse((await overview(app)).payload).data.machines).toHaveLength(1)
  })
})

describe('apiKey containment', () => {
  it('never serializes the data-plane key in /overview', async () => {
    // Asserted on the raw payload, not on parsed top-level keys: a nested or renamed occurrence has
    // to fail too, because possession of this key IS authentication for the machine.
    listForUser.mockResolvedValue([machine(), machine({ machineId: 'b'.repeat(32), authMode: 'remote' })])
    listDetailedForUser.mockResolvedValue([device()])
    const app = await buildApp()

    const res = await overview(app)

    expect(res.statusCode).toBe(200)
    expect(res.payload).not.toContain('sk-super-secret-data-plane-key')
    expect(res.payload.toLowerCase()).not.toContain('apikey')
  })

  it('never serializes it on the single-device route either', async () => {
    listForUser.mockResolvedValue([machine()])
    detailForUser.mockResolvedValue(device({ activeMachineId: machine().machineId }))
    const app = await buildApp()

    const res = await call(app, { method: 'GET', url: '/api/mobile/v1/devices/6a70088ae13f6277cdf9015a' })

    expect(res.payload).not.toContain('sk-super-secret-data-plane-key')
    expect(res.payload.toLowerCase()).not.toContain('apikey')
  })
})

describe('machine mapping', () => {
  const kindOf = async (authMode: string): Promise<string> => {
    listForUser.mockResolvedValue([machine({ authMode })])
    const app = await buildApp()
    return JSON.parse((await overview(app)).payload).data.machines[0].kind
  }

  it('maps every authMode onto a kind a person can distinguish', async () => {
    expect(await kindOf('self')).toBe('cloud')
    expect(await kindOf('managed')).toBe('cloud')
    expect(await kindOf('remote')).toBe('remote')
    expect(await kindOf('provider')).toBe('external')
  })

  it('publishes the unit count as agentCount, never the historical projectCount', async () => {
    listForUser.mockResolvedValue([machine({ agentCount: 4 })])
    const app = await buildApp()

    const body = JSON.parse((await overview(app)).payload)

    expect(body.data.machines[0].agentCount).toBe(4)
    expect(body.data.machines[0]).not.toHaveProperty('projectCount')
  })

  it('prefers name and falls back to the device picker-s label', async () => {
    listForUser.mockResolvedValue([
      machine({ machineId: 'a'.repeat(32), name: '  MacBook-Pro-Kenny  ' }),
      machine({ machineId: '7f3ca1b29c4d5e6f7a8b9c0d1e2f3a4b', name: null }),
    ])
    const app = await buildApp()

    const body = JSON.parse((await overview(app)).payload)

    expect(body.data.machines.map((h: { name: string }) => h.name))
      .toEqual(['MacBook-Pro-Kenny', 'machine-7f3ca1'])
  })

  it('keeps payment_pending visible — the device silently hides such machines', async () => {
    listForUser.mockResolvedValue([machine({ status: 'payment_pending', billingStatus: 'pending' })])
    const app = await buildApp()

    const body = JSON.parse((await overview(app)).payload)

    expect(body.data.machines[0]).toMatchObject({ status: 'payment_pending', billingStatus: 'pending' })
  })
})

describe('device ↔ machine attachment', () => {
  it('embeds the attached machine so the app never joins two lists itself', async () => {
    const h = machine({ name: 'MacBook-Pro-Kenny', authMode: 'remote' })
    listForUser.mockResolvedValue([h])
    listDetailedForUser.mockResolvedValue([device({ activeMachineId: h.machineId })])
    const app = await buildApp()

    const body = JSON.parse((await overview(app)).payload)

    expect(body.data.devices[0].activeMachine)
      .toEqual({ machineId: h.machineId, name: 'MacBook-Pro-Kenny', kind: 'remote' })
  })

  it('renders a dangling pointer as null, not as a bare id', async () => {
    // The machine was deleted out from under the device.
    listForUser.mockResolvedValue([])
    listDetailedForUser.mockResolvedValue([device({ activeMachineId: 'deleted-machine-id' })])
    const app = await buildApp()

    const res = await overview(app)

    expect(JSON.parse(res.payload).data.devices[0].activeMachine).toBeNull()
    expect(res.payload).not.toContain('deleted-machine-id')
  })

  it('does NOT leak the legacy pairing-origin machineId', async () => {
    // DeviceBinding.machineId means something different and is null for every per-user device.
    listDetailedForUser.mockResolvedValue([device()])
    const app = await buildApp()

    const body = JSON.parse((await overview(app)).payload)

    expect(body.data.devices[0]).not.toHaveProperty('machineId')
  })
})

describe('summary', () => {
  it('counts online devices from the live flag', async () => {
    listDetailedForUser.mockResolvedValue([
      device({ deviceId: 'a', online: true }),
      device({ deviceId: 'b', online: false }),
      device({ deviceId: 'c', online: true }),
    ])
    listForUser.mockResolvedValue([machine()])
    const app = await buildApp()

    const body = JSON.parse((await overview(app)).payload)

    expect(body.data.summary).toEqual({ deviceCount: 3, devicesOnline: 2, machineCount: 1 })
  })
})

describe('rename', () => {
  it('trims and accepts a normal name', async () => {
    rename.mockResolvedValue(device({ name: 'Kitchen' }))
    const app = await buildApp()

    const res = await call(app, {
      method: 'PATCH', url: '/api/mobile/v1/devices/dev-1', payload: { name: '  Kitchen  ' },
    })

    expect(res.statusCode).toBe(200)
    expect(rename).toHaveBeenCalledWith('dev-1', 'u1', 'Kitchen')
  })

  it('rejects a blank name', async () => {
    const app = await buildApp()
    const res = await call(app, { method: 'PATCH', url: '/api/mobile/v1/devices/dev-1', payload: { name: '   ' } })

    expect(res.statusCode).toBe(400)
    expect(rename).not.toHaveBeenCalled()
  })

  it('rejects an over-long name', async () => {
    const app = await buildApp()
    const res = await call(app, { method: 'PATCH', url: '/api/mobile/v1/devices/dev-1', payload: { name: 'x'.repeat(33) } })

    expect(res.statusCode).toBe(400)
    expect(rename).not.toHaveBeenCalled()
  })

  it('404s another user-s device', async () => {
    rename.mockResolvedValue(null)
    const app = await buildApp()

    const res = await call(app, { method: 'PATCH', url: '/api/mobile/v1/devices/dev-1', payload: { name: 'Kitchen' } })

    expect(res.statusCode).toBe(404)
  })
})

describe('delete', () => {
  it('goes through the shared revoke helper, so all three pushes happen', async () => {
    const app = await buildApp()

    const res = await call(app, { method: 'DELETE', url: '/api/mobile/v1/devices/dev-1' })

    expect(res.statusCode).toBe(200)
    expect(revokeDeviceForUser).toHaveBeenCalledWith('dev-1', 'u1')
  })

  it('404s when the device is not the caller-s', async () => {
    revokeDeviceForUser.mockResolvedValue(false)
    const app = await buildApp()

    expect((await call(app, { method: 'DELETE', url: '/api/mobile/v1/devices/dev-1' })).statusCode).toBe(404)
  })
})
