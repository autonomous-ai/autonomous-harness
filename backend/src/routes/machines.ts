import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { machineService, machineBillingService, userService } from '../services/index.js'
import { prisma } from '../lib/prisma.js'
import { machineIdFromKey } from '../utils/crypto.js'
import { validateBody, validateParams, validateQuery } from '../middlewares/validation.js'
import { isMachineId } from '../utils/slug.js'
import { sendSuccess, sendCreated, sendError } from '../utils/response.js'
import { logger } from '../utils/logger.js'
import { bearerToken } from '../lib/ssoAuth.js'
import { requestedWebOrigin, resolveWebOrigin } from '../lib/sso.js'
import { storedAutonomousEnvironment } from '../lib/autonomousEnvironment.js'
import { env } from '../config/env.js'
import { probeProvider, ProviderProbeError } from '../lib/providerProbe.js'
import { normalizeComputerId } from '../lib/deviceAuth.js'

const createBody = z.object({
  // Defaults to the caller; admins may provision for another user.
  userId: z.string().min(1).optional(),
  workspaceId: z.string().optional(),
  // Subscription plan id — REQUIRED: the caller must pick a tier. cpus/memory + authMode come from it.
  planId: z.string().min(1),
  // `provider` tier only. Both are REQUIRED when the chosen plan is a provider plan and REJECTED
  // otherwise — enforced in the handler, where the plan's authMode is known. The URL is checked by
  // lib/providerUrl.ts and the pair is proven live before anything is written.
  providerUrl: z.string().trim().min(1).max(2048).optional(),
  providerCredential: z.string().trim().min(1).max(4096).optional(),
})

const machineParams = z.object({
  machineId: z.string().refine(isMachineId, 'Invalid machineId'),
})
const resolveMachineQuery = z.object({
  deviceId: z.string().trim().min(1).max(128),
})
const resolveComputerBody = z.object({
  computerId: z.string().trim().min(1).max(128),
  label: z.string().trim().max(120).optional(),
  // The machine id the caller still holds, when it has one. Lets the service answer 403 to a daemon
  // whose machine was deleted instead of quietly minting it a new one. Absent on a first pairing.
  machineId: z.string().trim().max(64).optional(),
})

// Rename: writes the machine's `name`. 40 chars max — the device picker's per-row buffer.
// Empty string clears back to the default `machine-<id8>`.
const renameBody = z.object({
  name: z.string().trim().max(40),
})
const activateBody = z.object({
  sessionId: z.string().min(1).optional(),
  referenceCode: z.string().trim().min(1).max(128).optional(),
})
const billingCheckoutBody = z.object({ planId: z.string().min(1) })
const billingCompleteBody = z.object({
  operationId: z.string().uuid(),
  outcome: z.enum(['success', 'cancelled']),
  referenceCode: z.string().trim().min(1).max(128).optional(),
})

function requestAccessToken(authorization: string | undefined): string {
  const token = bearerToken(authorization)
  if (!token) throw new Error('Authenticated request is missing its SSO access token')
  return token
}

function requestWebOrigin(req: { headers: Record<string, string | string[] | undefined> }): string {
  return resolveWebOrigin(requestedWebOrigin({}, req.headers))
}

export async function machineRoutes(app: FastifyInstance): Promise<void> {
  // Validate an agent api key (NOT JWT). Public + agent-key gated: derive machineId = sha256(key)[:32]
  // and confirm an AgentBinding exists. Used by the shared CCR gateway to authorize an agent-node's
  // Claude CLI (bearer `sk-ccr-<API_KEY>`). In the auth-middleware skip-list. Returns the machineId
  // (safe public identity) — never echoes the raw key.
  app.post('/api/machines/validate', async (req, reply) => {
    const key = req.headers['x-api-key']
    if (typeof key !== 'string' || !key) {
      return sendError(reply, 'Missing agent api key', 'UNAUTHORIZED', 401)
    }
    const machineId = machineIdFromKey(key)
    const binding = await prisma.machine.findUnique({ where: { machineId: machineId } })
    if (!binding || binding.deletedAt) {
      return sendError(reply, 'Unknown machine', 'NO_MACHINE', 404)
    }
    if (binding.billingStatus === 'pending') {
      return sendError(reply, 'Machine payment is pending', 'MACHINE_PAYMENT_PENDING', 409)
    }
    if (binding.billingStatus === 'suspended') {
      return sendError(reply, 'Machine subscription is required', 'MACHINE_SUBSCRIPTION_REQUIRED', 402)
    }
    if (binding.billingStatus === 'active' && binding.authMode === 'managed') {
      return sendError(reply, 'Externally billed machines use their campaign credential directly', 'CCR_NOT_ALLOWED', 403)
    }
    return sendSuccess(reply, { valid: true, machineId: machineId, userId: binding.userId, managerId: binding.managerId })
  })

  // Provision a node for the caller (or, if admin, for `userId`).
  app.post<{ Body: z.infer<typeof createBody> }>(
    '/api/machines',
    { preHandler: validateBody(createBody) },
    async (req, reply) => {
      const isAdmin = req.user!.role === 'admin'
      const userId = isAdmin && req.body.userId ? req.body.userId : req.user!.sub
      const owner = userId === req.user!.sub ? await userService.get(req.user!.sub) : await userService.get(userId)
      if (!owner) return sendError(reply, 'User not found', 'NOT_FOUND', 404)
      const autonomousEnv = storedAutonomousEnvironment(owner.autonomousEnv)
      if (userId !== req.user!.sub) {
        const plan = await prisma.subscriptionPlan.findUnique({
          where: { id: req.body.planId },
          select: { authMode: true, autonomousEnv: true },
        })
        // External device/subscription ownership is derived from the caller's SSO access token and
        // email. An admin therefore cannot start a campaign checkout on behalf of another account;
        // doing so would permanently bind that user's machine to the admin's campaign device.
        if (!plan || plan.autonomousEnv !== autonomousEnv ||
          (env.HARNESS_BILLING_ENABLED && (plan.authMode === 'managed' || plan.authMode === 'remote' || plan.authMode === 'provider'))) {
          return sendError(
            reply,
            'Billed machines must be created by the subscription owner',
            'BILLING_OWNER_REQUIRED',
            403,
          )
        }
      }
      // A provider machine needs a URL and a credential, and BOTH are proven live before anything is
      // written. Skipping the probe would make a wrong credential indistinguishable from an outage —
      // the machine would look created and only fail on the first message.
      const chosenPlan = await prisma.subscriptionPlan.findUnique({
        where: { id: req.body.planId },
        select: { authMode: true },
      })
      const wantsProvider = chosenPlan?.authMode === 'provider'
      if (!wantsProvider && (req.body.providerUrl || req.body.providerCredential)) {
        return sendError(reply, 'Provider details are only valid on a Provider plan', 'PROVIDER_NOT_APPLICABLE', 400)
      }
      let provider: { url: string; credential: string } | undefined
      if (wantsProvider) {
        if (!req.body.providerUrl || !req.body.providerCredential) {
          return sendError(reply, 'A Provider machine needs a provider URL and credential', 'PROVIDER_DETAILS_REQUIRED', 400)
        }
        try {
          const probe = await probeProvider(req.body.providerUrl, req.body.providerCredential)
          provider = { url: probe.url, credential: req.body.providerCredential }
        } catch (err) {
          // Each failure has its own code because each has a different fix: change the URL, wait,
          // pick another provider, or paste the right credential.
          if (err instanceof ProviderProbeError) return sendError(reply, err.message, err.code, 400)
          throw err
        }
      }

      const agent = await machineService.create(userId, req.body.workspaceId, {
        planId: req.body.planId,
        autonomousEnv,
        ...(provider ? { provider } : {}),
      })
      const checkout = agent.billingStatus === 'pending'
        ? await machineBillingService.beginCheckout(
          agent.machineId,
          userId,
          req.user!.email,
          requestAccessToken(req.headers.authorization),
          requestWebOrigin(req),
          req.user!.autonomousEnv,
        )
        : undefined
      return sendCreated(reply, { machine: agent, ...(checkout ? { checkout } : {}) })
    },
  )

  // Continue a pending campaign machine with a fresh hosted checkout. Free uses the same endpoint to
  // collect a card without charging it; an older attempt never prevents another explicit attempt.
  app.post<{ Params: z.infer<typeof machineParams> }>(
    '/api/machines/:machineId/checkout',
    { preHandler: validateParams(machineParams) },
    async (req, reply) => {
      const checkout = await machineBillingService.beginCheckout(
        req.params.machineId,
        req.user!.sub,
        req.user!.email,
        requestAccessToken(req.headers.authorization),
        requestWebOrigin(req),
        req.user!.autonomousEnv,
      )
      return sendSuccess(reply, { checkout })
    },
  )

  // Legacy payment callback verifier. Idempotent completion uses an authoritative
  // device/subscription exact-match read; no separate checkout-complete endpoint is required.
  app.post<{ Params: z.infer<typeof machineParams>; Body: z.infer<typeof activateBody> }>(
    '/api/machines/:machineId/activate',
    { preHandler: [validateParams(machineParams), validateBody(activateBody)] },
    async (req, reply) => {
      await machineBillingService.activate(
        req.params.machineId,
        req.user!.sub,
        req.user!.email,
        requestAccessToken(req.headers.authorization),
        requestWebOrigin(req),
        req.body.sessionId,
        req.body.referenceCode,
        req.user!.autonomousEnv,
      )
      const machine = await machineService.get(req.params.machineId, req.user!)
      return sendSuccess(reply, { machine })
    },
  )

  // Owner-only managed-plan view. Refreshes subscription metadata with the caller's short-lived SSO
  // token but never persists that token; on a transient upstream failure it returns cached metadata.
  app.get<{ Params: z.infer<typeof machineParams> }>(
    '/api/machines/:machineId/billing',
    { preHandler: validateParams(machineParams) },
    async (req, reply) => {
      const billing = await machineBillingService.getBilling(
        req.params.machineId,
        req.user!.sub,
        requestAccessToken(req.headers.authorization),
        req.user!.autonomousEnv,
      )
      return sendSuccess(reply, { billing })
    },
  )

  // Start Free→paid subscribe, paid↔paid upgrade/downgrade, or Suspended→paid re-subscribe.
  app.post<{ Params: z.infer<typeof machineParams>; Body: z.infer<typeof billingCheckoutBody> }>(
    '/api/machines/:machineId/billing/checkout',
    { preHandler: [validateParams(machineParams), validateBody(billingCheckoutBody)] },
    async (req, reply) => {
      const checkout = await machineBillingService.beginPlanCheckout(
        req.params.machineId,
        req.user!.sub,
        req.body.planId,
        req.user!.email,
        requestAccessToken(req.headers.authorization),
        requestWebOrigin(req),
        req.user!.autonomousEnv,
      )
      return sendSuccess(reply, { checkout })
    },
  )

  // Shared callback verifier for initial subscribe and later plan changes. Stripe cancellation only
  // closes the local operation; it never mutates the machine's currently effective plan.
  app.post<{ Params: z.infer<typeof machineParams>; Body: z.infer<typeof billingCompleteBody> }>(
    '/api/machines/:machineId/billing/complete',
    { preHandler: [validateParams(machineParams), validateBody(billingCompleteBody)] },
    async (req, reply) => {
      const billing = await machineBillingService.complete(
        req.params.machineId,
        req.user!.sub,
        requestAccessToken(req.headers.authorization),
        req.body.operationId,
        req.body.outcome,
        req.user!.autonomousEnv,
      )
      return sendSuccess(reply, { billing })
    },
  )

  app.post<{ Params: z.infer<typeof machineParams> }>(
    '/api/machines/:machineId/billing/cancel',
    { preHandler: validateParams(machineParams) },
    async (req, reply) => {
      const billing = await machineBillingService.cancel(
        req.params.machineId,
        req.user!.sub,
        requestAccessToken(req.headers.authorization),
        req.user!.autonomousEnv,
      )
      return sendSuccess(reply, { billing })
    },
  )

  app.post<{ Params: z.infer<typeof machineParams> }>(
    '/api/machines/:machineId/billing/renew',
    { preHandler: validateParams(machineParams) },
    async (req, reply) => {
      const billing = await machineBillingService.renew(
        req.params.machineId,
        req.user!.sub,
        requestAccessToken(req.headers.authorization),
        req.user!.autonomousEnv,
      )
      return sendSuccess(reply, { billing })
    },
  )

  // List the caller's agent(s).
  app.get('/api/machines', async (req, reply) => {
    const bindings = await machineService.listForUser(req.user!.sub, req.user!.autonomousEnv)
    return sendSuccess(reply, { machines: bindings })
  })

  // Canonical Remote-machine lookup for an authenticated Harness CLI. The computer id is stable
  // across CLI restarts, so this is also the first-time create path before the adapter WebSocket dials.
  app.post<{ Body: z.infer<typeof resolveComputerBody> }>(
    '/api/machines/resolve-computer',
    { preHandler: validateBody(resolveComputerBody) },
    async (req, reply) => {
      const computerId = normalizeComputerId(req.body.computerId)
      if (!computerId) return sendError(reply, 'Invalid computer id', 'BAD_REQUEST', 400)
      const result = await machineService.resolveOrCreateForComputer(
        req.user!.sub,
        req.user!.autonomousEnv,
        computerId,
        req.body.label ?? 'computer',
        req.body.machineId,
      )
      // The server-internal machine API key must never leave this SSO endpoint.
      return sendSuccess(reply, {
        machine: { machineId: result.machine.machineId, computerId: result.machine.computerId },
        created: result.created,
      })
    },
  )

  // Resolve an Autonomous campaign device deep-link to a machine owned by this exact user/env.
  app.get<{ Querystring: z.infer<typeof resolveMachineQuery> }>(
    '/api/machines/resolve',
    { preHandler: validateQuery(resolveMachineQuery) },
    async (req, reply) => {
      const machine = await machineService.resolveByExternalDeviceId(req.query.deviceId, req.user!)
      return sendSuccess(reply, { machine })
    },
  )

  // Fetch one agent (incl. its apiKey) by id — owner or admin. Used by /machine/<id>.
  app.get<{ Params: z.infer<typeof machineParams> }>(
    '/api/machines/:machineId',
    { preHandler: validateParams(machineParams) },
    async (req, reply) => {
      const agent = await machineService.get(req.params.machineId, req.user!)
      return sendSuccess(reply, { machine: agent })
    },
  )

  // Explicit wake button. The response is delayed until the node has registered and is ready.
  app.post<{ Params: z.infer<typeof machineParams> }>(
    '/api/machines/:machineId/start',
    { preHandler: validateParams(machineParams) },
    async (req, reply) => {
      await machineService.start(req.params.machineId, req.user!)
      return sendSuccess(reply, { status: 'running' })
    },
  )

  // Explicit resource-saving stop. The container/volume remains available for a later start.
  app.post<{ Params: z.infer<typeof machineParams> }>(
    '/api/machines/:machineId/stop',
    { preHandler: validateParams(machineParams) },
    async (req, reply) => {
      await machineService.stop(req.params.machineId, req.user!)
      return sendSuccess(reply, { status: 'stopped' })
    },
  )

  // Rename a machine (owner or admin). Empty name → null (back to the default display name).
  app.patch<{ Params: z.infer<typeof machineParams>; Body: z.infer<typeof renameBody> }>(
    '/api/machines/:machineId',
    { preHandler: [validateParams(machineParams), validateBody(renameBody)] },
    async (req, reply) => {
      const name = req.body.name || null
      await machineService.rename(req.params.machineId, req.user!, name)
      return sendSuccess(reply, { name })
    },
  )

  // Destroy an agent (owner or admin).
  app.delete<{ Params: z.infer<typeof machineParams> }>(
    '/api/machines/:machineId',
    { preHandler: validateParams(machineParams) },
    async (req, reply) => {
      await machineService.destroy(
        req.params.machineId,
        req.user!,
        requestAccessToken(req.headers.authorization),
      )
      return sendSuccess(reply, { deleted: true })
    },
  )
}
