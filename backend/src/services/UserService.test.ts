import { beforeEach, describe, expect, it, vi } from 'vitest'

const findUnique = vi.hoisted(() => vi.fn())
const create = vi.hoisted(() => vi.fn())
const update = vi.hoisted(() => vi.fn())
const remove = vi.hoisted(() => vi.fn())
const updateManyDevices = vi.hoisted(() => vi.fn())
const transaction = vi.hoisted(() => vi.fn())

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    user: { findUnique, create, update, delete: remove },
    deviceBinding: { updateMany: updateManyDevices },
    $transaction: transaction,
  },
}))
vi.mock('../config/env.js', () => ({ ADMIN_EMAILS: new Set<string>(['boss@example.com']) }))
vi.mock('../lib/password.js', () => ({ hashPassword: (p: string) => `hashed:${p}` }))

import {
  isProvisionalUserEmail,
  normalizeUserEmail,
  provisionalEmailForExternalId,
  userService,
} from './UserService.js'

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'u1',
  email: 'a@example.com',
  externalId: 'prod-sub-1',
  stagExternalId: null,
  name: 'A',
  role: 'user',
  autonomousEnv: 'prod',
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  create.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({ id: 'new', ...data }))
  update.mockImplementation(({ data }: { data: Record<string, unknown> }) => row(data))
  remove.mockResolvedValue({})
  updateManyDevices.mockResolvedValue({ count: 1 })
  transaction.mockImplementation(async (operations: Array<Promise<unknown>>) => Promise.all(operations))
})

describe('SSO user identity', () => {
  it('normalizes email and uses it as the lookup key', async () => {
    findUnique.mockResolvedValue(row())

    const user = await userService.upsertFromSso({
      externalId: 'prod-sub-1',
      email: ' A@Example.COM ',
      autonomousEnv: 'prod',
    })

    expect(findUnique).toHaveBeenCalledWith({ where: { email: 'a@example.com' } })
    expect(update).not.toHaveBeenCalled()
    expect(user).toMatchObject({ id: 'u1' })
  })

  it('stores the SSO subject in stagExternalId for staging', async () => {
    findUnique.mockResolvedValue(row({ autonomousEnv: 'stag' }))

    await userService.upsertFromSso({
      externalId: 'stag-sub-1',
      email: 'a@example.com',
      autonomousEnv: 'stag',
    })

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: { stagExternalId: 'stag-sub-1' },
    }))
  })

  it('claims a prod device provisional row by externalId', async () => {
    const provisional = row({
      email: provisionalEmailForExternalId('prod-sub-1'),
      name: null,
    })
    findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(provisional)

    await userService.upsertFromSso({
      externalId: 'prod-sub-1',
      email: 'owner@example.com',
      autonomousEnv: 'prod',
      name: 'Owner',
    })

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'u1' },
      data: { email: 'owner@example.com', name: 'Owner' },
    }))
  })

  it('merges a conflicting provisional device row into the email user', async () => {
    const actual = row({ id: 'real', externalId: 'local-prod-real' })
    const provisional = row({
      id: 'pending',
      email: provisionalEmailForExternalId('prod-sub-1'),
    })
    findUnique.mockResolvedValueOnce(actual).mockResolvedValueOnce(provisional)

    await userService.upsertFromSso({
      externalId: 'prod-sub-1',
      email: 'a@example.com',
      autonomousEnv: 'prod',
    })

    expect(updateManyDevices).toHaveBeenCalledWith({
      where: { userId: 'pending' },
      data: { userId: 'real' },
    })
    expect(remove).toHaveBeenCalledWith({ where: { id: 'pending' } })
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'real' },
      data: { externalId: 'prod-sub-1' },
    }))
  })

  it('promotes to admin from the ADMIN_EMAILS allowlist', async () => {
    findUnique.mockResolvedValue(row({ email: 'boss@example.com' }))

    await userService.upsertFromSso({
      externalId: 'prod-sub-1',
      email: 'boss@example.com',
      autonomousEnv: 'prod',
    })

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { role: 'admin' } }))
  })

  it('creates a staging user with a local prod placeholder', async () => {
    findUnique.mockResolvedValue(null)

    const user = await userService.upsertFromSso({
      externalId: 'stag-sub-1',
      email: 'new@example.com',
      autonomousEnv: 'stag',
    })

    expect(user).toMatchObject({
      email: 'new@example.com',
      stagExternalId: 'stag-sub-1',
      autonomousEnv: 'stag',
    })
    expect(String((user as Record<string, unknown>).externalId)).toMatch(/^local-prod-[0-9a-f-]{36}$/)
  })

  it('does not adopt a prod subject already owned by another real email', async () => {
    const other = row({ id: 'other', email: 'other@example.com' })
    findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(other)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(other)
    create.mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }))

    await expect(userService.upsertFromSso({
      externalId: 'prod-sub-1',
      email: 'new@example.com',
      autonomousEnv: 'prod',
    })).rejects.toThrow(/assigned to another email/i)
  })
})

describe('provisional identity helpers', () => {
  it('builds a deterministic non-deliverable email', () => {
    expect(provisionalEmailForExternalId('ABC123')).toBe('device-abc123@pending.harness.invalid')
    expect(isProvisionalUserEmail('device-abc123@pending.harness.invalid')).toBe(true)
    expect(isProvisionalUserEmail('owner@example.com')).toBe(false)
    expect(normalizeUserEmail(' Owner@Example.COM ')).toBe('owner@example.com')
  })

  it('creates one prod provisional identity and returns the race winner', async () => {
    findUnique.mockResolvedValueOnce(null)
    create.mockResolvedValueOnce(row({
      id: 'pending',
      email: provisionalEmailForExternalId('prod-sub-1'),
    }))

    await expect(userService.findOrCreateProdProvisional('prod-sub-1')).resolves.toMatchObject({
      id: 'pending',
      email: provisionalEmailForExternalId('prod-sub-1'),
    })
  })
})

describe('campaign device identity', () => {
  it('creates an email-keyed prod user before the first SSO login', async () => {
    findUnique.mockResolvedValue(null)

    await userService.findOrCreateProdDeviceOwner('prod-sub-1', ' Owner@Example.COM ')

    expect(findUnique).toHaveBeenCalledWith({ where: { email: 'owner@example.com' } })
    expect(create).toHaveBeenCalledWith({
      data: {
        email: 'owner@example.com',
        externalId: 'prod-sub-1',
        name: undefined,
        role: 'user',
        autonomousEnv: 'prod',
      },
    })
  })
})

describe('create — locally-created accounts', () => {
  it('uses normalized unique email and a namespaced prod externalId', async () => {
    findUnique.mockResolvedValue(null)

    await userService.create({ email: ' New@Example.com ', password: 'pw' })

    const data = create.mock.calls[0][0].data as Record<string, unknown>
    expect(String(data.externalId)).toMatch(/^local-[0-9a-f-]{36}$/)
    expect(data.email).toBe('new@example.com')
    expect(data.passwordHash).toBe('hashed:pw')
  })

  it('rejects an existing email through the unique lookup', async () => {
    findUnique.mockResolvedValue(row())

    await expect(userService.create({ email: 'a@example.com', password: 'pw' })).rejects.toThrow(/already exists/i)
    expect(findUnique).toHaveBeenCalledWith({ where: { email: 'a@example.com' } })
  })
})
