import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { deviceService } from '../services/index.js'
import { validateParams } from '../middlewares/validation.js'
import { sendSuccess, sendError } from '../utils/response.js'
import { revokeDeviceForUser } from '../lib/deviceRevoke.js'

// A device is a COMPUTER running the `harness` daemon. It comes into existence by connecting to
// /api/device-ws with its owner's SSO token and a `?computer=` id — there is no pairing handshake, no
// device token and no OTA gate here any more, so both of the old public endpoints are gone and every
// route below is SSO-gated like the rest of the control plane.

const deviceParams = z.object({ deviceId: z.string().min(1) })

export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/devices', async (req, reply) => {
    const devices = await deviceService.listForUser(req.user!.sub)
    return sendSuccess(reply, { devices })
  })

  // FORGETS a dial; it is not a revocation. The row is deleted and the live socket is closed, but the
  // daemon on that computer re-creates it on its next connect — the credential is the owner's SSO
  // session, which this cannot touch. Naming it "revoke" in the UI would promise something it does not do.
  app.delete<{ Params: z.infer<typeof deviceParams> }>(
    '/api/devices/:deviceId',
    { preHandler: validateParams(deviceParams) },
    async (req, reply) => {
      // Delete + all three revoke pushes live in revokeDeviceForUser — the mobile group calls the same
      // helper, so the two surfaces cannot drift into revoking a device that keeps its socket.
      const ok = await revokeDeviceForUser(req.params.deviceId, req.user!.sub)
      if (!ok) return sendError(reply, 'Device not found', 'NOT_FOUND', 404)
      return sendSuccess(reply, { deleted: true })
    },
  )
}
