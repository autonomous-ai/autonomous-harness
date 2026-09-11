import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { userService } from '../services/index.js'
import { requireAdmin } from '../middlewares/authMiddleware.js'
import { validateBody, validateParams } from '../middlewares/validation.js'
import { sendSuccess, sendCreated } from '../utils/response.js'
import { logger } from '../utils/logger.js'
import { publishDeviceMachineListChanged } from '../lib/bus.js'

const idParams = z.object({ id: z.string().min(1) })

const createBody = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().optional(),
  role: z.enum(['user', 'admin']).optional(),
  autonomousEnv: z.enum(['prod', 'stag']).optional(),
})

const updateBody = z.object({
  name: z.string().optional(),
  password: z.string().min(6).optional(),
  role: z.enum(['user', 'admin']).optional(),
  autonomousEnv: z.enum(['prod', 'stag']).optional(),
})

/** Admin-only user management. All routes already require a valid SSO access token. */
export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/users', async (req, reply) => {
    requireAdmin(req)
    const users = await userService.list()
    return sendSuccess(reply, { users: users.map(userService.toPublic) })
  })

  app.post<{ Body: z.infer<typeof createBody> }>(
    '/api/users',
    { preHandler: validateBody(createBody) },
    async (req, reply) => {
      requireAdmin(req)
      const user = await userService.create(req.body)
      return sendCreated(reply, userService.toPublic(user))
    },
  )

  app.patch<{ Params: z.infer<typeof idParams>; Body: z.infer<typeof updateBody> }>(
    '/api/users/:id',
    { preHandler: [validateParams(idParams), validateBody(updateBody)] },
    async (req, reply) => {
      requireAdmin(req)
      const before = req.body.autonomousEnv
        ? await userService.get(req.params.id)
        : null
      const user = await userService.update(req.params.id, req.body)
      if (before && before.autonomousEnv !== user.autonomousEnv) {
        logger.info('user Autonomous environment changed', {
          userId: user.id,
          from: before.autonomousEnv,
          to: user.autonomousEnv,
          by: req.user!.sub,
        })
        // Invalidate already-authenticated web sockets immediately. REST requests would reject the
        // old plane on their next call, but an attached chat socket otherwise needs no REST traffic
        // and could keep its old environment indefinitely. Device subscribers only refresh their
        // cross-environment machine list; their protocol and visibility stay unchanged.
        await publishDeviceMachineListChanged(user.id, {
          reason: 'environment_changed',
          autonomousEnv: user.autonomousEnv === 'stag' ? 'stag' : 'prod',
        }).catch(() => { /* the next REST/WS auth still enforces the new environment */ })
      }
      return sendSuccess(reply, userService.toPublic(user))
    },
  )

  app.delete<{ Params: z.infer<typeof idParams> }>(
    '/api/users/:id',
    { preHandler: validateParams(idParams) },
    async (req, reply) => {
      requireAdmin(req)
      await userService.remove(req.params.id)
      return sendSuccess(reply, { deleted: true })
    },
  )
}
