import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma, machineAlive } from '../lib/prisma.js'
import { getAgentPresenceMany, publishShareChanged } from '../lib/bus.js'
import { machineBillingAllowsDataPlane } from '../lib/billingState.js'
import { validateBody, validateParams } from '../middlewares/validation.js'
import { sendError, sendSuccess } from '../utils/response.js'
import type { AuthUser } from '../lib/ssoAuth.js'

const params = z.object({ id: z.string().uuid() })
const body = z.object({
  machineId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  agentId: z.string().min(1).max(160),
  recipientEmail: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().min(1).max(160),
  engine: z.string().max(64).nullable(),
  ownerPublicKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  expiresAt: z.string().datetime().refine(value => {
    const delta = Date.parse(value) - Date.now()
    return delta > 0 && delta <= 91 * 24 * 60 * 60_000
  }, 'Choose an expiry within 90 days.'),
}).strict()

/** Used again at socket admission and throughout a live connection. Never disclose another grant. */
export async function recipientShare(id: string, user: AuthUser) {
  const share = await prisma.harnessShare.findFirst({ where: {
    id, recipientEmail: user.email.trim().toLowerCase(), autonomousEnv: user.autonomousEnv,
    revokedAt: null, expiresAt: { gt: new Date() },
  } })
  if (!share) return null
  const machine = await prisma.machine.findFirst({ where: {
    machineId: share.machineId, userId: share.ownerId, autonomousEnv: user.autonomousEnv, ...machineAlive,
  } })
  return machine && machineBillingAllowsDataPlane(machine) ? share : null
}

export async function harnessShareRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/harness-shares', async (req, reply) => {
    const shares = await prisma.harnessShare.findMany({ where: {
      recipientEmail: req.user!.email.trim().toLowerCase(), autonomousEnv: req.user!.autonomousEnv,
      revokedAt: null, expiresAt: { gt: new Date() },
    }, orderBy: { createdAt: 'asc' }, take: 1000 })
    const machines = await prisma.machine.findMany({ where: {
      machineId: { in: [...new Set(shares.map(s => s.machineId))] },
      autonomousEnv: req.user!.autonomousEnv, ...machineAlive,
    } })
    const allowed = machines.filter(machineBillingAllowsDataPlane)
    const owners = await prisma.user.findMany({ where: { id: { in: [...new Set(allowed.map(m => m.userId))] } },
      select: { id: true, name: true, email: true } })
    const presence = await getAgentPresenceMany(allowed.map(m => m.machineId))
    sendSuccess(reply, { machines: allowed.flatMap(machine => {
      const grants = shares.filter(s => s.machineId === machine.machineId && s.ownerId === machine.userId)
      if (grants.length === 0) return []
      const owner = owners.find(o => o.id === machine.userId)
      return [{ machineId: machine.machineId, name: machine.name, authMode: 'remote',
        status: presence.get(machine.machineId) ? 'running' : 'offline',
        shared: true, ownerName: owner?.name || owner?.email || 'Harness user',
        shares: grants.map(s => ({ id: s.id, agentId: s.agentId, name: s.name, engine: s.engine,
          ownerPublicKey: s.ownerPublicKey, expiresAt: s.expiresAt.toISOString() })) }]
    }) })
  })

  app.put<{ Params: z.infer<typeof params>; Body: z.infer<typeof body> }>(
    '/api/harness-shares/:id', { preHandler: [validateParams(params), validateBody(body)] },
    async (req, reply) => {
      const input = req.body
      const machine = await prisma.machine.findFirst({ where: {
        machineId: input.machineId, userId: req.user!.sub, autonomousEnv: req.user!.autonomousEnv, ...machineAlive,
      } })
      if (!machine || !machineBillingAllowsDataPlane(machine)) {
        return sendError(reply, 'This machine is not available to share.', 'FORBIDDEN', 403)
      }
      if (input.recipientEmail === req.user!.email.trim().toLowerCase()) {
        return sendError(reply, 'You already own this harness.', 'SELF_INVITE', 400)
      }
      const existing = await prisma.harnessShare.findUnique({ where: { id: req.params.id } })
      if (existing && (existing.ownerId !== req.user!.sub || existing.machineId !== input.machineId
        || existing.agentId !== input.agentId || existing.recipientEmail !== input.recipientEmail)) {
        return sendError(reply, 'This invitation cannot be changed.', 'FORBIDDEN', 403)
      }
      const data = { ...input, expiresAt: new Date(input.expiresAt), revokedAt: null,
        ownerId: req.user!.sub, autonomousEnv: req.user!.autonomousEnv }
      await prisma.harnessShare.upsert({ where: { id: req.params.id },
        create: { id: req.params.id, ...data }, update: data })
      await publishShareChanged(req.params.id)
      sendSuccess(reply, { id: req.params.id })
    },
  )

  app.delete<{ Params: z.infer<typeof params> }>('/api/harness-shares/:id',
    { preHandler: [validateParams(params)] }, async (req, reply) => {
      const changed = await prisma.harnessShare.updateMany({ where: {
        id: req.params.id, ownerId: req.user!.sub, autonomousEnv: req.user!.autonomousEnv,
      }, data: { revokedAt: new Date() } })
      if (!changed.count) return sendError(reply, 'Invitation not found.', 'NOT_FOUND', 404)
      await publishShareChanged(req.params.id)
      sendSuccess(reply, { removed: true })
    })
}
