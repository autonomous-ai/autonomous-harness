/**
 * Presence / remote-usage daily tracking — write path for `UserDailyPresence`,
 * `UserDailyRemoteUsage` and `UserDailyDevicePresence` (prisma/schema.prisma). Separate model
 * family and separate module from the opt-in `Analytics*` telemetry in analyticsIngest.ts: these
 * signals are derived directly from the web-ws/device-ws relays (src/lib/webWs.ts,
 * src/lib/deviceWs.ts), not from a collector upload.
 *
 * Unlike analyticsIngest.ts, none of these rows need last-write-wins ordering (there's no
 * client-supplied revision to defend against), so each touch is a plain atomic `upsert` on the
 * day's unique key — no separate create-then-swallow-P2002 step that could drop a concurrent
 * write's `lastSeenAt`/counter increment.
 *
 * All entry points are meant to be called fire-and-forget from the hot path (connection open,
 * periodic re-seed, p2p_offer) — callers must not await them inline.
 */
import { prisma } from './prisma.js'
import { utcDayStart } from '../types/analytics.js'

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
  await prisma.userDailyPresence.upsert({
    where: { userId_dayUtc: { userId, dayUtc } },
    create: { userId, dayUtc, connections: 1, firstSeenAt: now, lastSeenAt: now },
    update: {
      lastSeenAt: now,
      ...(opts.isNewConnection ? { connections: { increment: 1 } } : {}),
    },
  })
}

/**
 * Record that a user actually established a remote p2p connection (a `p2p_offer` frame passed
 * through the relay) to `machineId` on the UTC day containing `now`.
 */
export async function recordRemoteUsage(userId: string, machineId: string, now: Date): Promise<void> {
  const dayUtc = utcDayStart(now)
  await prisma.userDailyRemoteUsage.upsert({
    where: { userId_machineId_dayUtc: { userId, machineId, dayUtc } },
    create: { userId, machineId, dayUtc, sessions: 1, firstSeenAt: now, lastSeenAt: now },
    update: { lastSeenAt: now, sessions: { increment: 1 } },
  })
}

/**
 * Mark a user's device online for the UTC day containing `now`, mirroring `touchUserOnlineDay`
 * for the device-ws relay (src/lib/deviceWs.ts) instead of web-ws.
 */
export async function touchDeviceOnlineDay(
  userId: string,
  deviceId: string,
  now: Date,
  opts: { isNewConnection: boolean },
): Promise<void> {
  const dayUtc = utcDayStart(now)
  await prisma.userDailyDevicePresence.upsert({
    where: { userId_deviceId_dayUtc: { userId, deviceId, dayUtc } },
    create: { userId, deviceId, dayUtc, connections: 1, firstSeenAt: now, lastSeenAt: now },
    update: {
      lastSeenAt: now,
      ...(opts.isNewConnection ? { connections: { increment: 1 } } : {}),
    },
  })
}
