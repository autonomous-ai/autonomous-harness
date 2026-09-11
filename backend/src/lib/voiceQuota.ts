import type { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { logger } from '../utils/logger.js'

const PENDING_RESERVATION_MS = 20 * 60_000
const RETENTION_MS = 35 * 24 * 60 * 60_000
const TRANSACTION_RETRIES = 3

export interface VoiceQuotaSnapshot {
  machineId: string
  dayKey: string
  limitSeconds: number
  usedSeconds: number
  remainingSeconds: number | null
  resetAt: string
}

export interface VoiceQuotaReservationResult {
  snapshot: VoiceQuotaSnapshot
  state: 'reserved' | 'pending' | 'committed'
}

export class VoiceQuotaExceededError extends Error {
  readonly code = 'DAILY_VOICE_LIMIT_REACHED'

  constructor(readonly snapshot: VoiceQuotaSnapshot) {
    super('Daily voice limit reached')
    this.name = 'VoiceQuotaExceededError'
  }
}

type DbClient = Prisma.TransactionClient | typeof prisma

function utcWindow(now: Date): { dayKey: string; resetAt: Date; expiresAt: Date } {
  const dayKey = now.toISOString().slice(0, 10)
  const resetAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  return { dayKey, resetAt, expiresAt: new Date(resetAt.getTime() + RETENTION_MS) }
}

function snapshot(
  machineId: string,
  dayKey: string,
  resetAt: Date,
  usedMs: number,
  limitSeconds: number,
): VoiceQuotaSnapshot {
  const limitMs = limitSeconds * 1000
  return {
    machineId,
    dayKey,
    limitSeconds,
    usedSeconds: Math.floor(Math.max(0, usedMs) / 1000),
    remainingSeconds: limitSeconds === 0
      ? null
      : Math.floor(Math.max(0, limitMs - usedMs) / 1000),
    resetAt: resetAt.toISOString(),
  }
}

async function limitForMachine(machineId: string, db: DbClient = prisma): Promise<number> {
  const binding = await db.machine.findUnique({
    where: { machineId },
    select: { planId: true, deletedAt: true },
  })
  if (!binding || binding.deletedAt) throw new Error('machine not found')
  if (!binding.planId) return 0
  const plan = await db.subscriptionPlan.findUnique({
    where: { id: binding.planId },
    select: { dailyVoiceLimitSeconds: true },
  })
  // Missing/legacy plans remain unlimited for backwards compatibility.
  return Math.max(0, plan?.dailyVoiceLimitSeconds ?? 0)
}

function transientTransactionError(err: unknown): boolean {
  const code = typeof err === 'object' && err ? (err as { code?: unknown }).code : undefined
  const message = err instanceof Error ? err.message : String(err)
  // Concurrent first delivery of the same upload can race on the unique uploadId. Retrying P2002
  // re-reads the winner's reservation and returns pending/committed without charging a second time.
  return code === 'P2002' || code === 'P2034'
    || /write conflict|transienttransactionerror|transaction.*aborted/i.test(message)
}

async function withTransactionRetry<T>(
  action: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= TRANSACTION_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(action)
    } catch (err) {
      lastError = err
      if (!transientTransactionError(err) || attempt === TRANSACTION_RETRIES) throw err
    }
  }
  throw lastError
}

export const voiceQuotaService = {
  async snapshotForMachine(machineId: string, now = new Date()): Promise<VoiceQuotaSnapshot> {
    const [{ dayKey, resetAt }, limitSeconds] = await Promise.all([
      Promise.resolve(utcWindow(now)),
      limitForMachine(machineId),
    ])
    const usage = await prisma.machineVoiceDailyUsage.findUnique({
      where: { machineId_dayKey: { machineId, dayKey } },
      select: { usedMs: true },
    })
    return snapshot(machineId, dayKey, resetAt, usage?.usedMs ?? 0, limitSeconds)
  },

  async reserve(
    machineId: string,
    uploadId: string,
    durationMs: number,
    now = new Date(),
  ): Promise<VoiceQuotaReservationResult> {
    if (!uploadId) throw new Error('voice uploadId is required')
    const roundedDurationMs = Math.max(1, Math.ceil(durationMs))
    const { dayKey, resetAt, expiresAt } = utcWindow(now)

    return withTransactionRetry(async (tx) => {
      // Resolve the plan inside the same transaction as the usage increment so a concurrent plan
      // change cannot validate against one tier and charge against another snapshot.
      const limitSeconds = await limitForMachine(machineId, tx)
      const limitMs = limitSeconds * 1000
      const existing = await tx.machineVoiceReservation.findUnique({ where: { uploadId } })
      if (existing && (existing.machineId !== machineId || existing.dayKey !== dayKey)) {
        throw new Error('voice uploadId belongs to another machine or UTC day')
      }
      const usage = await tx.machineVoiceDailyUsage.upsert({
        where: { machineId_dayKey: { machineId, dayKey } },
        update: { expiresAt },
        create: { machineId, dayKey, usedMs: 0, expiresAt },
      })
      if (existing?.status === 'committed' || existing?.status === 'pending') {
        return {
          snapshot: snapshot(machineId, dayKey, resetAt, usage.usedMs, limitSeconds),
          state: existing.status,
        }
      }
      if (limitSeconds > 0 && usage.usedMs + roundedDurationMs > limitMs) {
        throw new VoiceQuotaExceededError(snapshot(machineId, dayKey, resetAt, usage.usedMs, limitSeconds))
      }

      const updated = await tx.machineVoiceDailyUsage.updateMany({
        where: {
          machineId,
          dayKey,
          ...(limitSeconds > 0 ? { usedMs: { lte: limitMs - roundedDurationMs } } : {}),
        },
        data: { usedMs: { increment: roundedDurationMs }, expiresAt },
      })
      if (updated.count !== 1) {
        const current = await tx.machineVoiceDailyUsage.findUnique({
          where: { machineId_dayKey: { machineId, dayKey } },
        })
        throw new VoiceQuotaExceededError(snapshot(machineId, dayKey, resetAt, current?.usedMs ?? 0, limitSeconds))
      }

      const releaseAt = new Date(now.getTime() + PENDING_RESERVATION_MS)
      if (existing?.status === 'released') {
        await tx.machineVoiceReservation.update({
          where: { uploadId },
          data: {
            durationMs: roundedDurationMs,
            status: 'pending',
            releaseAt,
            expiresAt,
            committedAt: null,
            releasedAt: null,
          },
        })
      } else {
        await tx.machineVoiceReservation.create({
          data: {
            uploadId,
            machineId,
            dayKey,
            durationMs: roundedDurationMs,
            status: 'pending',
            releaseAt,
            expiresAt,
          },
        })
      }
      return {
        snapshot: snapshot(machineId, dayKey, resetAt, usage.usedMs + roundedDurationMs, limitSeconds),
        state: 'reserved',
      }
    })
  },

  async commit(uploadId: string, now = new Date()): Promise<void> {
    await prisma.machineVoiceReservation.updateMany({
      where: { uploadId, status: 'pending' },
      data: { status: 'committed', committedAt: now, releaseAt: null },
    })
  },

  async release(uploadId: string, now = new Date()): Promise<boolean> {
    return withTransactionRetry(async (tx) => {
      const reservation = await tx.machineVoiceReservation.findUnique({ where: { uploadId } })
      if (!reservation || reservation.status !== 'pending') return false
      await tx.machineVoiceDailyUsage.updateMany({
        where: { machineId: reservation.machineId, dayKey: reservation.dayKey },
        data: { usedMs: { decrement: reservation.durationMs } },
      })
      await tx.machineVoiceReservation.update({
        where: { uploadId },
        data: { status: 'released', releasedAt: now, releaseAt: null },
      })
      return true
    })
  },

  async cleanup(now = new Date(), batchSize = 100): Promise<{ released: number; deleted: number }> {
    const stale = await prisma.machineVoiceReservation.findMany({
      where: { status: 'pending', releaseAt: { lte: now } },
      orderBy: { releaseAt: 'asc' },
      take: batchSize,
      select: { uploadId: true },
    })
    let released = 0
    for (const { uploadId } of stale) {
      try {
        if (await this.release(uploadId, now)) released++
      } catch (err) {
        logger.warn('stale voice quota reservation release failed', { uploadId, error: String(err) })
      }
    }
    const [reservations, usage] = await Promise.all([
      prisma.machineVoiceReservation.deleteMany({
        where: { status: { in: ['committed', 'released'] }, expiresAt: { lte: now } },
      }),
      prisma.machineVoiceDailyUsage.deleteMany({ where: { expiresAt: { lte: now } } }),
    ])
    return { released, deleted: reservations.count + usage.count }
  },
}
