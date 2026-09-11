import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { env } from '../config/env.js'
import { prisma } from '../lib/prisma.js'
import { machineIdFromKey, generateSubdomain } from '../utils/crypto.js'
import { provisionViaManager } from '../lib/provision.js'
import { evictCachedAppTarget } from '../lib/appTargetCache.js'
import { validateBody, validateParams } from '../middlewares/validation.js'
import { sendSuccess, sendCreated, sendError } from '../utils/response.js'
import { logger } from '../utils/logger.js'
import { billingStatusOf } from '../lib/billingState.js'

// The port Claude ran its app on (any port except the agent-node's reserved brain/api ports).
const RESERVED_PORTS = new Set<number>([8080, 8081])
const registerBody = z.object({
  agentId: z.string().min(1), // the agent unit this app belongs to
  port: z.number().int().min(1).max(65535).refine((p) => !RESERVED_PORTS.has(p), 'Port 8080/8081 are reserved (brain/api)'),
})
const subdomainParams = z.object({ subdomain: z.string().min(1) })

interface AgentCtx { machineId: string; managerId: string; userId: string }
type WithAgent = FastifyRequest & { agentCtx?: AgentCtx }

const publicUrl = (subdomain: string) => `https://${subdomain}${env.APP_DOMAIN_SUFFIX}`

/**
 * Resolve the caller's agent from its api key (NOT the JWT). The agent-node's domain MCP calls these
 * endpoints with `x-api-key: API_KEY`; we derive machineId = sha256(key)[:32] and find its binding
 * (owner + owning manager). These routes are in the auth-middleware skip-list (see authMiddleware).
 */
async function agentAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const key = req.headers['x-api-key']
  if (typeof key !== 'string' || !key) {
    sendError(reply, 'Missing agent api key', 'UNAUTHORIZED', 401)
    return
  }
  const machineId = machineIdFromKey(key)
  const binding = await prisma.machine.findUnique({ where: { machineId: machineId } })
  if (!binding || binding.deletedAt) {
    sendError(reply, 'Unknown machine', 'NO_MACHINE', 404)
    return
  }
  if (binding.billingStatus === 'pending') {
    sendError(reply, 'Machine payment is pending', 'MACHINE_PAYMENT_PENDING', 409)
    return
  }
  if (billingStatusOf(binding) === 'suspended') {
    sendError(reply, 'Machine subscription is required', 'MACHINE_SUBSCRIPTION_REQUIRED', 402)
    return
  }
  ;(req as WithAgent).agentCtx = { machineId, managerId: binding.managerId, userId: binding.userId }
}

/**
 * Public app-deploy registration API — agent-key gated (NOT JWT). Generates a random subdomain, asks
 * the owning manager to allocate an app port + route, and persists the `subdomains` routing record.
 */
export async function appRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: z.infer<typeof registerBody> }>(
    '/api/apps/register',
    { preHandler: [agentAuth, validateBody(registerBody)] },
    async (req, reply) => {
      const { machineId, managerId, userId } = (req as WithAgent).agentCtx!
      const { agentId, port } = req.body
      try {
        // Random, unique subdomain (retry on the rare collision).
        let subdomain = ''
        for (let i = 0; i < 5 && !subdomain; i++) {
          const cand = generateSubdomain()
          const exists = await prisma.subdomain.findUnique({ where: { subdomain: cand } })
          if (!exists) subdomain = cand
        }
        if (!subdomain) return sendError(reply, 'could not allocate a subdomain', 'ALLOC_FAILED', 500)

        // Register the app on the owning manager over its socket (no manager address needed).
        const { appPort } = await provisionViaManager(managerId, 'app_create', { machineId, subdomain, agentId, port }) as { appPort: number }

        try {
          await prisma.subdomain.create({ data: { subdomain, machineId, agentId, managerId, userId } })
          evictCachedAppTarget(subdomain) // drop any negative-cache marker so it's reachable immediately
        } catch (err) {
          // Roll back the manager-side deploy so we don't leak an orphan route/port.
          await provisionViaManager(managerId, 'app_delete', { subdomain }).catch(() => { /* best effort */ })
          throw err
        }

        logger.info('subdomain registered', { machineId, subdomain, agentId })
        return sendCreated(reply, { url: publicUrl(subdomain), appPort, subdomain })
      } catch (err) {
        logger.error('POST /api/apps/register failed', err, { machineId, agentId })
        return sendError(reply, err instanceof Error ? err.message : 'register failed', 'REGISTER_FAILED', 500)
      }
    },
  )

  app.get<{ Querystring: { machineId?: string } }>(
    '/api/apps',
    { preHandler: agentAuth },
    async (req, reply) => {
      const { machineId } = (req as WithAgent).agentCtx!
      const rows = await prisma.subdomain.findMany({
        where: { machineId: machineId, ...(req.query.machineId ? { machineId: req.query.machineId } : {}) },
        orderBy: { createdAt: 'desc' },
      })
      return sendSuccess(reply, {
        apps: rows.map((r) => ({ subdomain: r.subdomain, machineId: r.machineId, url: publicUrl(r.subdomain), createdAt: r.createdAt })),
      })
    },
  )

  app.delete<{ Params: z.infer<typeof subdomainParams> }>(
    '/api/apps/:subdomain',
    { preHandler: [agentAuth, validateParams(subdomainParams)] },
    async (req, reply) => {
      const { machineId, managerId } = (req as WithAgent).agentCtx!
      const { subdomain } = req.params
      const rec = await prisma.subdomain.findUnique({ where: { subdomain } })
      if (!rec || rec.machineId !== machineId) return sendError(reply, 'not found', 'NOT_FOUND', 404)
      await provisionViaManager(managerId, 'app_delete', { subdomain }).catch((e) => logger.warn('manager app_delete failed', { subdomain, error: String(e) }))
      await prisma.subdomain.delete({ where: { subdomain } }).catch(() => { /* gone */ })
      evictCachedAppTarget(subdomain)
      return sendSuccess(reply, { deleted: true })
    },
  )
}
