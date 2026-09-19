import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
const mocks = vi.hoisted(() => ({
  prisma: { harnessShare: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), updateMany: vi.fn() },
    machine: { findFirst: vi.fn(), findMany: vi.fn() }, user: { findMany: vi.fn() } },
  presence: vi.fn(), changed: vi.fn(), auth: vi.fn(),
}))
vi.mock('../lib/prisma.js', () => ({ prisma: mocks.prisma, machineAlive: { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] } }))
vi.mock('../lib/bus.js', () => ({ getAgentPresenceMany: mocks.presence, publishShareChanged: mocks.changed }))
vi.mock('../lib/ssoAuth.js', async original => ({ ...await original<typeof import('../lib/ssoAuth.js')>(), authenticateAccessToken: mocks.auth }))
import { harnessShareRoutes, recipientShare } from './harnessShares.js'
import { registerAuthMiddleware } from '../middlewares/authMiddleware.js'
import { errorHandler } from '../middlewares/errorHandler.js'

const owner = { sub: 'owner', email: 'owner@example.com', role: 'user', autonomousEnv: 'prod' as const }
const ken = { sub: 'ken', email: ' Ken@Example.com ', role: 'user', autonomousEnv: 'prod' as const }
const machine = { machineId: 'm1', userId: owner.sub, name: 'Design studio', authMode: 'remote', billingStatus: 'not_required' }
const input = () => ({ machineId: 'm1', agentId: 'agent-1', name: 'My harness', engine: 'codex',
  recipientEmail: 'ken@example.com', ownerPublicKey: Buffer.alloc(32, 1).toString('base64'),
  expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() })
describe('account-bound harness invitations', () => {
  let app: FastifyInstance
  beforeEach(async () => {
    vi.resetAllMocks()
    mocks.auth.mockResolvedValue(owner)
    mocks.prisma.machine.findFirst.mockResolvedValue(machine)
    mocks.prisma.machine.findMany.mockResolvedValue([machine])
    mocks.prisma.user.findMany.mockResolvedValue([{ id: owner.sub, name: 'D', email: owner.email }])
    mocks.prisma.harnessShare.findMany.mockResolvedValue([])
    mocks.prisma.harnessShare.updateMany.mockResolvedValue({ count: 1 })
    mocks.presence.mockResolvedValue(new Map([['m1', true]]))
    app = Fastify(); app.setErrorHandler(errorHandler); registerAuthMiddleware(app, mocks.auth)
    await app.register(harnessShareRoutes); await app.ready()
  })
  afterEach(async () => { await app.close() })
  const auth = { authorization: 'Bearer fixture' }
  function put(payload: unknown = input(), id: string = randomUUID()) {
    return app.inject({ method: 'PUT', url: `/api/harness-shares/${id}`, headers: auth, payload: payload as any })
  }
  it('requires SSO on every endpoint', async () => {
    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      expect((await app.inject({ method, url: `/api/harness-shares${method === 'GET' ? '' : `/${randomUUID()}`}` })).statusCode).toBe(401)
    }
    expect(mocks.prisma.harnessShare.findMany).not.toHaveBeenCalled()
  })
  it('publishes an owner invitation with normalized email and the authenticated account/environment', async () => {
    const id = randomUUID(), data = { ...input(), recipientEmail: ' Ken@Example.com ' }
    expect((await put(data, id)).json()).toEqual({ success: true, data: { id } })
    expect(mocks.prisma.machine.findFirst).toHaveBeenCalledWith({ where: expect.objectContaining({
      machineId: 'm1', userId: owner.sub, autonomousEnv: 'prod', OR: expect.any(Array),
    }) })
    expect(mocks.prisma.harnessShare.upsert).toHaveBeenCalledWith({ where: { id },
      create: expect.objectContaining({ id, recipientEmail: 'ken@example.com', ownerId: 'owner', autonomousEnv: 'prod', revokedAt: null }),
      update: expect.objectContaining({ recipientEmail: 'ken@example.com', expiresAt: expect.any(Date) }) })
    expect(mocks.changed).toHaveBeenCalledWith(id)
  })
  it('rejects invalid emails, expired/overlong invitations, unknown fields, unsafe machine IDs and keys', async () => {
    for (const patch of [{ recipientEmail: 'bad' }, { expiresAt: new Date(0).toISOString() },
      { expiresAt: new Date(Date.now() + 92 * 86400_000).toISOString() }, { ownerPublicKey: 'bad' },
      { machineId: '../machine' }, { canControl: true }, { name: '' }, { agentId: '' }]) {
      expect((await put({ ...input(), ...patch })).statusCode).toBe(400)
    }
    expect((await put(input(), 'not-a-uuid')).statusCode).toBe(400)
    expect(mocks.prisma.harnessShare.upsert).not.toHaveBeenCalled()
  })
  it('forbids sharing another owner’s machine, suspended machines, and self invitations', async () => {
    mocks.prisma.machine.findFirst.mockResolvedValueOnce(null)
    expect((await put()).statusCode).toBe(403)
    mocks.prisma.machine.findFirst.mockResolvedValueOnce({ ...machine, billingStatus: 'suspended' })
    expect((await put()).statusCode).toBe(403)
    const self = await put({ ...input(), recipientEmail: ' OWNER@example.com ' })
    expect(self.statusCode).toBe(400); expect(self.json().error.code).toBe('SELF_INVITE')
    expect(mocks.prisma.harnessShare.upsert).not.toHaveBeenCalled()
  })
  it('cannot repurpose an existing grant for another account, machine, agent or email', async () => {
    for (const patch of [{ ownerId: 'other' }, { machineId: 'other' }, { agentId: 'other' }, { recipientEmail: 'diego@example.com' }]) {
      mocks.prisma.harnessShare.findUnique.mockResolvedValueOnce({ ...input(), ownerId: owner.sub, ...patch })
      expect((await put()).statusCode).toBe(403)
    }
    mocks.prisma.harnessShare.findUnique.mockResolvedValueOnce({ ...input(), ownerId: owner.sub })
    expect((await put()).statusCode).toBe(200)
  })
  it('discovers only active invitations for the signed-in email and environment, without machine secrets', async () => {
    mocks.auth.mockResolvedValue(ken)
    mocks.prisma.harnessShare.findMany.mockResolvedValue([
      { id: 'ken-grant', ...input(), ownerId: owner.sub, expiresAt: new Date(input().expiresAt) },
      { id: 'old-owner-grant', ...input(), ownerId: 'previous-owner', expiresAt: new Date(input().expiresAt) },
    ])
    mocks.prisma.machine.findMany.mockResolvedValue([machine,
      { ...machine, machineId: 'no-grants' }, { ...machine, machineId: 'suspended', billingStatus: 'suspended' }])
    const response = await app.inject({ method: 'GET', url: '/api/harness-shares', headers: auth })
    expect(response.json().data.machines).toEqual([{
      machineId: 'm1', name: 'Design studio', authMode: 'remote', status: 'running', shared: true, ownerName: 'D',
      shares: [{ id: 'ken-grant', agentId: 'agent-1', name: 'My harness', engine: 'codex',
        ownerPublicKey: input().ownerPublicKey, expiresAt: expect.any(String) }],
    }])
    expect(mocks.prisma.harnessShare.findMany).toHaveBeenCalledWith({ where: {
      recipientEmail: 'ken@example.com', autonomousEnv: 'prod', revokedAt: null, expiresAt: { gt: expect.any(Date) },
    }, orderBy: { createdAt: 'asc' }, take: 1000 })
  })
  it('retains offline invitations and handles unnamed owners and missing metadata', async () => {
    mocks.prisma.harnessShare.findMany.mockResolvedValue([{ id: 's', ...input(), engine: null, ownerId: 'owner', expiresAt: new Date(input().expiresAt) }])
    mocks.presence.mockResolvedValue(new Map())
    mocks.prisma.user.findMany.mockResolvedValue([{ id: 'owner', name: null, email: owner.email }])
    const response = () => app.inject({ method: 'GET', url: '/api/harness-shares', headers: auth })
    expect((await response()).json().data.machines[0]).toMatchObject({ status: 'offline', ownerName: owner.email })
    mocks.prisma.user.findMany.mockResolvedValue([])
    expect((await response()).json().data.machines[0].ownerName).toBe('Harness user')
  })
  it('removes only the owner’s invitation and publishes revocation after persistence', async () => {
    const id = randomUUID()
    const remove = () => app.inject({ method: 'DELETE', url: `/api/harness-shares/${id}`, headers: auth })
    expect((await remove()).json()).toEqual({ success: true, data: { removed: true } })
    expect(mocks.prisma.harnessShare.updateMany).toHaveBeenCalledWith({ where: { id, ownerId: 'owner', autonomousEnv: 'prod' }, data: { revokedAt: expect.any(Date) } })
    expect(mocks.changed).toHaveBeenCalledWith(id)
    mocks.prisma.harnessShare.updateMany.mockResolvedValue({ count: 0 })
    expect((await remove()).statusCode).toBe(404)
    expect(mocks.changed).toHaveBeenCalledTimes(1)
  })
  it('rechecks exact recipient, expiry, current machine ownership and billing on socket admission', async () => {
    const grant = { ...input(), id: 'share', ownerId: 'owner' }
    mocks.prisma.harnessShare.findFirst.mockResolvedValue(null)
    expect(await recipientShare('share', ken)).toBeNull()
    mocks.prisma.harnessShare.findFirst.mockResolvedValue(grant)
    expect(await recipientShare('share', ken)).toEqual(grant)
    expect(mocks.prisma.harnessShare.findFirst).toHaveBeenLastCalledWith({ where: { id: 'share', recipientEmail: 'ken@example.com', autonomousEnv: 'prod', revokedAt: null, expiresAt: { gt: expect.any(Date) } } })
    expect(mocks.prisma.machine.findFirst).toHaveBeenLastCalledWith({ where: expect.objectContaining({ machineId: 'm1', userId: 'owner', autonomousEnv: 'prod', OR: expect.any(Array) }) })
    mocks.prisma.machine.findFirst.mockResolvedValueOnce(null)
    expect(await recipientShare('share', ken)).toBeNull()
    mocks.prisma.machine.findFirst.mockResolvedValueOnce({ ...machine, billingStatus: 'pending' })
    expect(await recipientShare('share', ken)).toBeNull()
  })
})
