import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  limitSeconds: 600,
  usage: null as null | { machineId: string; dayKey: string; usedMs: number; expiresAt: Date },
  reservations: new Map<string, Record<string, unknown>>(),
}))

const db = vi.hoisted(() => ({
  bindingFind: vi.fn(),
  planFind: vi.fn(),
  usageFind: vi.fn(),
  usageUpsert: vi.fn(),
  usageUpdateMany: vi.fn(),
  usageDeleteMany: vi.fn(),
  reservationFind: vi.fn(),
  reservationFindMany: vi.fn(),
  reservationCreate: vi.fn(),
  reservationUpdate: vi.fn(),
  reservationUpdateMany: vi.fn(),
  reservationDeleteMany: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('./prisma.js', () => {
  const prisma = {
    machine: { findUnique: db.bindingFind },
    subscriptionPlan: { findUnique: db.planFind },
    machineVoiceDailyUsage: {
      findUnique: db.usageFind,
      upsert: db.usageUpsert,
      updateMany: db.usageUpdateMany,
      deleteMany: db.usageDeleteMany,
    },
    machineVoiceReservation: {
      findUnique: db.reservationFind,
      findMany: db.reservationFindMany,
      create: db.reservationCreate,
      update: db.reservationUpdate,
      updateMany: db.reservationUpdateMany,
      deleteMany: db.reservationDeleteMany,
    },
    $transaction: db.transaction,
  }
  return { prisma }
})
vi.mock('../utils/logger.js', () => ({ logger: { warn: vi.fn() } }))

import { VoiceQuotaExceededError, voiceQuotaService } from './voiceQuota.js'

describe('daily voice quota', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.limitSeconds = 600
    state.usage = null
    state.reservations.clear()
    db.bindingFind.mockResolvedValue({ planId: 'plan-1', deletedAt: null })
    db.planFind.mockImplementation(async () => ({ dailyVoiceLimitSeconds: state.limitSeconds }))
    db.usageFind.mockImplementation(async () => state.usage)
    db.usageUpsert.mockImplementation(async ({ create, update }: {
      create: { machineId: string; dayKey: string; usedMs: number; expiresAt: Date }
      update: { expiresAt: Date }
    }) => {
      if (!state.usage) state.usage = { ...create }
      else state.usage.expiresAt = update.expiresAt
      return { ...state.usage }
    })
    db.usageUpdateMany.mockImplementation(async ({ where, data }: {
      where: { usedMs?: { lte?: number } }
      data: { usedMs: { increment?: number; decrement?: number }; expiresAt?: Date }
    }) => {
      if (!state.usage) return { count: 0 }
      if (where.usedMs?.lte != null && state.usage.usedMs > where.usedMs.lte) return { count: 0 }
      state.usage.usedMs += data.usedMs.increment ?? -(data.usedMs.decrement ?? 0)
      if (data.expiresAt) state.usage.expiresAt = data.expiresAt
      return { count: 1 }
    })
    db.usageDeleteMany.mockResolvedValue({ count: 0 })
    db.reservationFind.mockImplementation(async ({ where }: { where: { uploadId: string } }) =>
      state.reservations.get(where.uploadId) ?? null)
    db.reservationCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      state.reservations.set(String(data.uploadId), { ...data })
      return data
    })
    db.reservationUpdate.mockImplementation(async ({ where, data }: {
      where: { uploadId: string }
      data: Record<string, unknown>
    }) => {
      const current = state.reservations.get(where.uploadId) ?? {}
      const next = { ...current, ...data }
      state.reservations.set(where.uploadId, next)
      return next
    })
    db.reservationUpdateMany.mockImplementation(async ({ where, data }: {
      where: { uploadId: string; status?: string }
      data: Record<string, unknown>
    }) => {
      const current = state.reservations.get(where.uploadId)
      if (!current || (where.status && current.status !== where.status)) return { count: 0 }
      state.reservations.set(where.uploadId, { ...current, ...data })
      return { count: 1 }
    })
    db.reservationFindMany.mockImplementation(async ({ where }: {
      where: { status: string; releaseAt: { lte: Date } }
    }) => [...state.reservations.values()]
      .filter((item) => item.status === where.status
        && item.releaseAt instanceof Date
        && item.releaseAt <= where.releaseAt.lte)
      .map((item) => ({ uploadId: item.uploadId })))
    db.reservationDeleteMany.mockResolvedValue({ count: 0 })
    db.transaction.mockImplementation(async (action: (tx: unknown) => Promise<unknown>) => action({
      machine: { findUnique: db.bindingFind },
      subscriptionPlan: { findUnique: db.planFind },
      machineVoiceDailyUsage: {
        findUnique: db.usageFind,
        upsert: db.usageUpsert,
        updateMany: db.usageUpdateMany,
      },
      machineVoiceReservation: {
        findUnique: db.reservationFind,
        create: db.reservationCreate,
        update: db.reservationUpdate,
      },
    }))
  })

  it('uses a UTC calendar day and reports the next UTC reset', async () => {
    const result = await voiceQuotaService.snapshotForMachine(
      'machine-1',
      new Date('2026-07-24T23:59:30.000Z'),
    )
    expect(result).toMatchObject({
      dayKey: '2026-07-24',
      limitSeconds: 600,
      usedSeconds: 0,
      remainingSeconds: 600,
      resetAt: '2026-07-25T00:00:00.000Z',
    })
  })

  it('reserves atomically and rejects an utterance that would cross the remaining limit', async () => {
    const now = new Date('2026-07-24T12:00:00.000Z')
    await expect(voiceQuotaService.reserve('machine-1', 'upload-a', 590_000, now)).resolves.toMatchObject({
      state: 'reserved',
      snapshot: { usedSeconds: 590, remainingSeconds: 10 },
    })
    await expect(voiceQuotaService.reserve('machine-1', 'upload-b', 20_000, now))
      .rejects.toBeInstanceOf(VoiceQuotaExceededError)
    expect(state.usage?.usedMs).toBe(590_000)
  })

  it('does not charge the same upload twice and commits it once', async () => {
    const now = new Date('2026-07-24T12:00:00.000Z')
    await voiceQuotaService.reserve('machine-1', 'upload-a', 30_000, now)
    await expect(voiceQuotaService.reserve('machine-1', 'upload-a', 30_000, now))
      .resolves.toMatchObject({ state: 'pending' })
    expect(state.usage?.usedMs).toBe(30_000)
    await voiceQuotaService.commit('upload-a', now)
    expect(state.reservations.get('upload-a')?.status).toBe('committed')
  })

  it('retries a concurrent unique uploadId winner and returns its pending reservation', async () => {
    const now = new Date('2026-07-24T12:00:00.000Z')
    db.transaction.mockImplementationOnce(async () => {
      state.usage = {
        machineId: 'machine-1',
        dayKey: '2026-07-24',
        usedMs: 30_000,
        expiresAt: new Date('2026-08-29T00:00:00.000Z'),
      }
      state.reservations.set('upload-race', {
        uploadId: 'upload-race',
        machineId: 'machine-1',
        dayKey: '2026-07-24',
        durationMs: 30_000,
        status: 'pending',
      })
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    })
    db.transaction.mockImplementationOnce(async (action: (tx: unknown) => Promise<unknown>) => action({
      machine: { findUnique: db.bindingFind },
      subscriptionPlan: { findUnique: db.planFind },
      machineVoiceDailyUsage: {
        findUnique: db.usageFind,
        upsert: db.usageUpsert,
        updateMany: db.usageUpdateMany,
      },
      machineVoiceReservation: {
        findUnique: db.reservationFind,
        create: db.reservationCreate,
        update: db.reservationUpdate,
      },
    }))

    await expect(voiceQuotaService.reserve('machine-1', 'upload-race', 30_000, now))
      .resolves.toMatchObject({ state: 'pending' })
    expect(state.usage?.usedMs).toBe(30_000)
    expect(db.transaction).toHaveBeenCalledTimes(2)
  })

  it('keeps concurrent devices inside the shared machine allowance', async () => {
    const now = new Date('2026-07-24T12:00:00.000Z')
    const results = await Promise.allSettled([
      voiceQuotaService.reserve('machine-1', 'upload-a', 590_000, now),
      voiceQuotaService.reserve('machine-1', 'upload-b', 20_000, now),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(state.usage?.usedMs).toBeLessThanOrEqual(600_000)
  })

  it('releases failed or stale pending STT reservations', async () => {
    const now = new Date('2026-07-24T12:00:00.000Z')
    await voiceQuotaService.reserve('machine-1', 'upload-a', 30_000, now)
    const cleanup = await voiceQuotaService.cleanup(new Date('2026-07-24T12:21:00.000Z'))
    expect(cleanup.released).toBe(1)
    expect(state.usage?.usedMs).toBe(0)
    expect(state.reservations.get('upload-a')?.status).toBe('released')
  })

  it('tracks usage without blocking the zero/unlimited plan', async () => {
    state.limitSeconds = 0
    const result = await voiceQuotaService.reserve(
      'machine-1',
      'upload-unlimited',
      3_700_000,
      new Date('2026-07-24T12:00:00.000Z'),
    )
    expect(result.snapshot).toMatchObject({
      limitSeconds: 0,
      usedSeconds: 3700,
      remainingSeconds: null,
    })
  })

  it('keeps the same daily bucket when the machine changes plan', async () => {
    const now = new Date('2026-07-24T12:00:00.000Z')
    await voiceQuotaService.reserve('machine-1', 'upload-free', 590_000, now)
    state.limitSeconds = 1800
    const upgraded = await voiceQuotaService.reserve('machine-1', 'upload-pro', 100_000, now)
    expect(upgraded.snapshot).toMatchObject({ usedSeconds: 690, remainingSeconds: 1110 })
    state.limitSeconds = 600
    await expect(voiceQuotaService.reserve('machine-1', 'upload-after-downgrade', 1_000, now))
      .rejects.toBeInstanceOf(VoiceQuotaExceededError)
    expect(state.usage?.usedMs).toBe(690_000)
  })
})
