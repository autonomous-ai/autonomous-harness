import { prisma, machineAlive } from './prisma.js'
import { AppError } from '../errors/index.js'

// A manager is a candidate only if it heartbeated recently (3 missed beats @ 30s).
const ALIVE_MS = 90_000

/**
 * Placement — pick the manager to provision the next node on. Provisioning + all data go over the
 * manager socket (Redis `mgr:{managerId}`), so we only need the chosen managerId (+ liveness/capacity
 * from the DB), never a reachable address (publicHost is gone). Best-fit: the live manager with the
 * LEAST free capacity that still has room, packing nodes onto the fullest manager first.
 * Throws NO_MANAGER when none is alive, NO_CAPACITY when all live ones are full.
 */
export async function selectManagerId(): Promise<{ managerId: string }> {
  const cutoff = new Date(Date.now() - ALIVE_MS)
  const managers = await prisma.manager.findMany({ where: { lastSeenAt: { gte: cutoff } } })
  if (managers.length === 0) throw new AppError('No live agent-manager available', 503, 'NO_MANAGER')
  const reservations = await prisma.machine.groupBy({
    by: ['managerId'],
    where: {
      managerId: { in: managers.map((m) => m.managerId) },
      billingStatus: 'pending',
      ...machineAlive,
    },
    _count: { _all: true },
  })
  const pendingByManager = new Map(reservations.map((r) => [r.managerId, r._count._all]))
  const withRoom = managers
    .map((m) => ({ m, free: m.maxNodes - m.nodeCount - (pendingByManager.get(m.managerId) ?? 0) }))
    .filter((x) => x.free > 0)
    .sort((a, b) => a.free - b.free || b.m.nodeCount - a.m.nodeCount)
  if (withRoom.length === 0) throw new AppError('No manager has free capacity', 503, 'NO_CAPACITY')
  return { managerId: withRoom[0].m.managerId }
}
