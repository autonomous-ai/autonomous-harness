import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { machineService, deviceService, machineDisplayName, type DeviceDetail, type OwnerMachine } from '../services/index.js'
import { validateBody, validateParams } from '../middlewares/validation.js'
import { sendSuccess, sendError } from '../utils/response.js'
import { revokeDeviceForUser } from '../lib/deviceRevoke.js'
import { authenticateAccessToken, bearerToken } from '../lib/ssoAuth.js'
import { resolveSsoAuth } from '../middlewares/authMiddleware.js'

// The Autonomous MOBILE app's read surface for the Machine product tile.
// Contract + screen designs: docs/specs/mobile-app-machine-ui.md.
//
// WHY A SEPARATE GROUP rather than widening /api/devices + /api/machines:
//
//  1. `/api/machines` returns OwnerMachine, which carries `apiKey` — the DATA-PLANE credential,
//     where possession *is* authentication for that machine. The web is a first-party client that
//     needs it. An app-store binary must never receive it. Here the mapper builds an allow-listed
//     object field by field and NEVER spreads OwnerMachine, so a future field on that interface
//     cannot silently leak. That is the whole reason this file exists; do not "simplify" it into a
//     spread plus a delete.
//  2. The app renders one screen from devices + machines + the link between them, so it wants ONE
//     round trip. The web wants the two lists independently.
//  3. App-store builds live in users' hands for months, so this contract has to stay stable while
//     `/api/machines` keeps evolving for the web. Hence the explicit /v1.
//
// AUTH: the same Autonomous SSO access token the web sends, but PRODUCTION-ONLY.
//
// There is no staging build of the mobile app, so this group pins the plane to prod and ignores
// `x-autonomous-env` entirely. A staging token therefore fails the prod profile fetch and gets a
// plain 401 — no cross-plane access is opened.
//
// What is deliberately dropped is the account-plane GATE (`enforceEnv: false`). Every user row that
// predates the prod default was backfilled to `autonomousEnv: 'stag'`, and the web's gate answers
// those with 403 AUTONOMOUS_ENV_MISMATCH. Applying it here would lock long-standing customers out of
// the mobile app for a reason that has nothing to do with them. The identity served is still the one
// prod SSO just verified, resolved by EMAIL, and upsertFromSso never rewrites `autonomousEnv`, so a
// user's web experience is untouched.
//
// The same reasoning applies to the machine list: it is fetched by user, NOT filtered by env — see
// the call sites. Filtering would authenticate a legacy user successfully and then show them nothing.
//
// Because of the above, `/api/mobile/` is listed in shouldSkipAuth: the GLOBAL hook must not run its
// env gate on these paths. mobileAuth below is what actually authenticates them.
//
// VOCABULARY: this surface speaks the product model — machine -> agent -> session. A machine's
// unit count is published as `agentCount` (never the historical `projectCount`), and the
// billing-flavoured `authMode` as a plain `kind` the app can actually render.

const deviceParams = z.object({ deviceId: z.string().min(1) })
const renameBody = z.object({
  // Trimmed before length-checking, so "   " is rejected as empty rather than stored as blanks.
  name: z.string().transform((s) => s.trim()).pipe(z.string().min(1, 'Name is required').max(32, 'Name is too long')),
})

/** What the app shows as the machine's type. Maps the billing-flavoured authMode onto the three
 *  things a person can actually distinguish (mobile spec §1.2). `self`/`managed` are both "a machine
 *  we run for you", and the difference between them is a billing tier, not something to render. */
function machineKind(authMode: OwnerMachine['authMode']): 'cloud' | 'remote' | 'external' {
  if (authMode === 'remote') return 'remote'
  if (authMode === 'provider') return 'external'
  return 'cloud'
}

interface MobileMachine {
  machineId: string
  name: string
  kind: 'cloud' | 'remote' | 'external'
  status: string
  agentCount: number
  engine: string
  planName: string | null
  billingStatus: string
}

/** Allow-list. Built field by field ON PURPOSE — see the `apiKey` note in the header. */
function toMobileMachine(b: OwnerMachine): MobileMachine {
  return {
    machineId: b.machineId,
    // Same fallback the device's own machine picker uses, so a machine is named identically on the
    // phone and on the device screen.
    name: b.name?.trim() || machineDisplayName(b.machineId),
    kind: machineKind(b.authMode),
    status: b.status,
    agentCount: b.agentCount,
    engine: b.engine,
    planName: b.planName,
    billingStatus: b.billingStatus,
  }
}

/** A device plus the machine it is attached to, resolved against machines the CALLER owns. */
function toMobileDevice(d: DeviceDetail, machinesById: Map<string, MobileMachine>): Record<string, unknown> {
  // Resolve rather than echo the stored id: a machine can be deleted, or belong to the caller's other
  // Autonomous environment, while the device still points at it. Both cases must read as "no machine",
  // never as a dangling id the app would have to handle itself.
  const active = d.activeMachineId ? machinesById.get(d.activeMachineId) ?? null : null
  return {
    deviceId: d.deviceId,
    name: d.name,
    online: d.online,
    lastSeenAt: d.lastSeenAt,
    createdAt: d.createdAt,
    macAddress: d.macAddress,
    firmwareVersion: d.firmwareVersion,
    chip: d.chip,
    ssid: d.ssid,
    rssi: d.rssi,
    activeMachine: active ? { machineId: active.machineId, name: active.name, kind: active.kind } : null,
  }
}

/** Production-pinned SSO auth for this group. See the AUTH note in the header for why the plane is
 *  hard-coded and the account-plane gate is off. Reuses resolveSsoAuth so the error mapping (401 vs
 *  503 vs 403) stays identical to the web's. */
async function mobileAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = bearerToken(req.headers['authorization'])
  if (!token) {
    sendError(reply, 'Unauthorized', 'UNAUTHORIZED', 401)
    return
  }
  const auth = await resolveSsoAuth(token, (t) => authenticateAccessToken(t, 'prod', { enforceEnv: false }), 'prod')
  if ('user' in auth) {
    req.user = auth.user
    return
  }
  sendError(reply, auth.message, auth.code, auth.status)
}

/** Every machine the user owns, in the app's shape. NOT filtered by Autonomous environment: the user
 *  is resolved by email and legacy rows carry `autonomousEnv: 'stag'`, so filtering would hand a
 *  successfully-authenticated customer an empty list. */
async function mobileMachines(userId: string): Promise<MobileMachine[]> {
  return (await machineService.listForUser(userId)).map(toMobileMachine)
}

export async function mobileRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', mobileAuth)

  /** Everything the group-detail screen needs, in one round trip. */
  app.get('/api/mobile/v1/overview', async (req, reply) => {
    const [devices, mapped] = await Promise.all([
      deviceService.listDetailedForUser(req.user!.sub),
      mobileMachines(req.user!.sub),
    ])
    const byId = new Map(mapped.map((h) => [h.machineId, h]))
    return sendSuccess(reply, {
      devices: devices.map((d) => toMobileDevice(d, byId)),
      machines: mapped,
      summary: {
        deviceCount: devices.length,
        devicesOnline: devices.filter((d) => d.online).length,
        machineCount: mapped.length,
      },
    })
  })

  /** One device, in the SAME shape it has inside `overview` — the app parses one type, not two. */
  app.get<{ Params: z.infer<typeof deviceParams> }>(
    '/api/mobile/v1/devices/:deviceId',
    { preHandler: validateParams(deviceParams) },
    async (req, reply) => {
      const device = await deviceService.detailForUser(req.params.deviceId, req.user!.sub)
      if (!device) return sendError(reply, 'Device not found', 'NOT_FOUND', 404)
      const byId = new Map((await mobileMachines(req.user!.sub)).map((h) => [h.machineId, h]))
      return sendSuccess(reply, { device: toMobileDevice(device, byId) })
    },
  )

  /** Rename. Devices are created with the literal name "device", so with more than one paired device
   *  this is what makes them tellable apart at all. */
  app.patch<{ Params: z.infer<typeof deviceParams>; Body: z.infer<typeof renameBody> }>(
    '/api/mobile/v1/devices/:deviceId',
    { preHandler: [validateParams(deviceParams), validateBody(renameBody)] },
    async (req, reply) => {
      const device = await deviceService.rename(req.params.deviceId, req.user!.sub, req.body.name)
      if (!device) return sendError(reply, 'Device not found', 'NOT_FOUND', 404)
      const byId = new Map((await mobileMachines(req.user!.sub)).map((h) => [h.machineId, h]))
      return sendSuccess(reply, { device: toMobileDevice(device, byId) })
    },
  )

  /** Unpair. Same helper as the web's DELETE, so both surfaces perform all three revoke pushes. */
  app.delete<{ Params: z.infer<typeof deviceParams> }>(
    '/api/mobile/v1/devices/:deviceId',
    { preHandler: validateParams(deviceParams) },
    async (req, reply) => {
      const ok = await revokeDeviceForUser(req.params.deviceId, req.user!.sub)
      if (!ok) return sendError(reply, 'Device not found', 'NOT_FOUND', 404)
      return sendSuccess(reply, { deleted: true })
    },
  )
}
