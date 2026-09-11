/**
 * Presence / remote-usage daily tracking — write path for `UserDailyPresence` and
 * `UserDailyRemoteUsage` (prisma/schema.prisma). Separate model family and separate module from
 * the opt-in `Analytics*` telemetry in analyticsIngest.ts: these two signals are derived directly
 * from the web-ws relay (src/lib/webWs.ts), not from a collector upload.
 *
 * Both entry points are meant to be called fire-and-forget from the hot path (connection open,
 * periodic re-seed, p2p_offer) — callers must not await them inline.
 */
import { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { utcDayStart } from '../types/analytics.js'

/** A unique-constraint violation here means a concurrent write already created today's row. */
function swallowUniqueViolation(err: unknown): void {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return
  throw err
}

/**
 * Mark a user online for the UTC day containing `now`. Call once on connect
 * (`isNewConnection: true`, bumps `connections`) and again whenever a day-boundary check on an
 * open connection finds the day has changed (`isNewConnection: false`, just touches `lastSeenAt`).
 */
export async function touchUserOnlineDay(
  userId: string,
  now: Date,
  opts: { isNewConnection: boolean },
): Promise<void> {
  const dayUtc = utcDayStart(now)
  const touched = await prisma.userDailyPresence.updateMany({
    where: { userId, dayUtc },
    data: {
      lastSeenAt: now,
      ...(opts.isNewConnection ? { connections: { increment: 1 } } : {}),
    },
  })
  if (touched.count === 0) {
    await prisma.userDailyPresence
      .create({ data: { userId, dayUtc, connections: 1, firstSeenAt: now, lastSeenAt: now } })
      .catch(swallowUniqueViolation)
  }
}

/**
 * Record that a user actually established a remote p2p connection (a `p2p_offer` frame passed
 * through the relay) to `machineId` on the UTC day containing `now`.
 */
export async function recordRemoteUsage(userId: string, machineId: string, now: Date): Promise<void> {
  const dayUtc = utcDayStart(now)
  const touched = await prisma.userDailyRemoteUsage.updateMany({
    where: { userId, machineId, dayUtc },
    data: { lastSeenAt: now, sessions: { increment: 1 } },
  })
  if (touched.count === 0) {
    await prisma.userDailyRemoteUsage
      .create({ data: { userId, machineId, dayUtc, sessions: 1, firstSeenAt: now, lastSeenAt: now } })
      .catch(swallowUniqueViolation)
  }
}
