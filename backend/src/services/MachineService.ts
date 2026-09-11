import type { Machine } from '@prisma/client'
import { prisma, machineAlive } from '../lib/prisma.js'
import { selectManagerId } from '../lib/managers.js'
import { provisionViaManager } from '../lib/provision.js'
import { getAgentPresence, clearAgentPresence, publishDown, publishDeviceMachineListChanged, pub } from '../lib/bus.js'
import { randomUUID } from 'node:crypto'
import { generateApiKey, machineIdFromKey } from '../utils/crypto.js'
import { assertMachineId, isMachineId } from '../utils/slug.js'
import { AppError, ForbiddenError, NotFoundError } from '../errors/index.js'
import { logger } from '../utils/logger.js'
import { ensureMachineReady, publishMachineLifecycle } from '../lib/machineLifecycle.js'
import { assertMachineBillingActive, billingStatusOf, type MachineBillingStatus } from '../lib/billingState.js'
import { env } from '../config/env.js'
import { encryptMachineCredential } from '../lib/machineCredential.js'
import { machineBillingService } from './MachineBillingService.js'
import { storedAutonomousEnvironment, type AutonomousEnvironment } from '../lib/autonomousEnvironment.js'

/** The agent's tier / how it runs Claude, resolved through its plan.
 *  'self' | 'managed' = a docker agent-node on a manager host; 'remote' = the user's own computer
 *  paired via the machine-adapter CLI; 'provider' = a third-party endpoint the owner pointed us at.
 *  The last two have no manager and no node — the binding is the whole machine. */
export type AgentAuthMode = 'self' | 'managed' | 'remote' | 'provider'
export type AgentEngine = 'claude' | 'codex' | 'cursor' | 'opencode' | 'pi' | 'hermes' | 'commandcode' | 'devin'

/** Modes with no container of ours: no manager reservation, no docker node, nothing to start or stop. */
export const NODELESS_MODES: ReadonlySet<AgentAuthMode> = new Set(['remote', 'provider'])
export const isNodeless = (v: string | null | undefined): boolean => NODELESS_MODES.has(toAuthMode(v))

function toAuthMode(v: string | null | undefined): AgentAuthMode {
  return v === 'managed' || v === 'remote' || v === 'provider' ? v : 'self'
}

/**
 * Owner view of a binding. Machine API keys remain server-internal; browser and adapter
 * transports authenticate with the owner's SSO access token.
 */
export interface OwnerMachine {
  machineId: string
  computerId: string | null
  workspaceId: string | null
  planId: string | null
  autonomousEnv: AutonomousEnvironment
  // The agent's tier / how it authenticates with Claude, resolved through its plan.
  authMode: AgentAuthMode
  planName: string | null
  billingStatus: MachineBillingStatus
  createdAt: Date
  status: string
  agentCount: number
  // The agent's CLI engine (from the manager's AgentNode.engine); drives the web's engine-aware UI
  // so opening the agent renders the right badge/affordances immediately.
  engine: AgentEngine
  // The machine's display name (user-editable). Null until named or seeded from a connect.
  name: string | null
  // Hostname of the COMPUTER on its last connect (remote machines) — secondary detail on the card,
  // never the name. Null if no computer has ever connected.
  hostname: string | null
}

interface PlanInfo {
  authMode: AgentAuthMode
  name: string | null
}

interface MachineRequester {
  sub: string
  role: string
  autonomousEnv?: AutonomousEnvironment
}

function assertRequesterEnvironment(binding: Machine, requester: MachineRequester): void {
  if (requester.autonomousEnv && storedAutonomousEnvironment(binding.autonomousEnv) !== requester.autonomousEnv) {
    throw new AppError('Machine belongs to another Autonomous environment', 403, 'MACHINE_ENV_MISMATCH')
  }
}

function toOwner(b: Machine, status = 'unknown', agentCount = 0, plan?: PlanInfo, engine = 'claude'): OwnerMachine {
  return {
    machineId: b.machineId,
    computerId: b.computerId ?? null,
    workspaceId: b.workspaceId,
    planId: b.planId,
    autonomousEnv: storedAutonomousEnvironment(b.autonomousEnv),
    authMode: plan?.authMode ?? 'self',
    planName: plan?.name ?? null,
    billingStatus: billingStatusOf(b),
    createdAt: b.createdAt,
    status,
    agentCount,
    engine: normalizeEngine(engine),
    name: b.name ?? null,
    hostname: b.hostname ?? null,
  }
}

const COMPUTER_CREATE_LOCK_TTL_MS = 15_000
const COMPUTER_CREATE_LOCK_WAIT_MS = 10_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function computerCreateLockKey(userId: string, computerId: string): string {
  return `machine:create:${userId}:${computerId}`
}

/**
 * Serialize the rare first-login create path across backend replicas. The machine schema cannot
 * use a simple unique key because older rows can share a nullable computer id, so re-checking
 * under a short Redis lock prevents concurrent adapter upgrades from minting duplicate rows.
 */
async function withComputerCreateLock<T>(userId: string, computerId: string, action: () => Promise<T>): Promise<T> {
  const key = computerCreateLockKey(userId, computerId)
  const owner = randomUUID()
  const deadline = Date.now() + COMPUTER_CREATE_LOCK_WAIT_MS
  let acquired = false
  while (Date.now() < deadline) {
    try {
      acquired = (await pub.set(key, owner, 'PX', COMPUTER_CREATE_LOCK_TTL_MS, 'NX')) === 'OK'
    } catch (err) {
      logger.error('computer create lock unavailable', err, { userId, computerId })
      throw new AppError('Could not reserve this computer. Please retry.', 503, 'COMPUTER_LOCK_UNAVAILABLE')
    }
    if (acquired) break
    await sleep(40)
  }
  if (!acquired) throw new AppError('Computer setup is already in progress. Please retry.', 409, 'COMPUTER_SETUP_BUSY')
  try {
    return await action()
  } finally {
    // Never delete a successor's lock if this process stalled beyond the TTL.
    try {
      const current = await pub.get(key)
      if (current === owner) await pub.del(key)
    } catch (err) {
      logger.warn('computer create lock release failed', { userId, computerId, err })
    }
  }
}

function firstUsableComputerMachine(rows: Machine[]): Machine | undefined {
  return rows.find((machine) => {
    const status = billingStatusOf(machine)
    return status === 'active' || status === 'not_required'
  })
}

/** Resolve each agent's plan display name via its binding's planId. authMode comes from the BINDING
 *  (denormalized at create, backfilled at boot) — never from the plan, so a later plan-doc edit can't
 *  flip a live agent's mode. Missing/legacy → self. */
async function plansByMachine(bindings: Machine[]): Promise<Map<string, PlanInfo>> {
  const out = new Map<string, PlanInfo>()
  const planIds = [...new Set(bindings.map((b) => b.planId).filter((id): id is string => !!id))]
  const plans = planIds.length ? await prisma.subscriptionPlan.findMany({ where: { id: { in: planIds } } }) : []
  const byId = new Map(plans.map((p) => [p.id, p]))
  for (const b of bindings) {
    const p = b.planId ? byId.get(b.planId) : undefined
    out.set(b.machineId, { authMode: toAuthMode(b.authMode), name: p?.name ?? null })
  }
  return out
}

/** Project count per machineId, from the proxy-populated `machine_agents` collection. */
async function countByMachine(ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (ids.length === 0) return out
  const grouped = await prisma.machineAgent.groupBy({
    by: ['machineId'],
    where: { machineId: { in: ids } },
    _count: { _all: true },
  })
  for (const g of grouped) out.set(g.machineId, g._count._all)
  return out
}

function normalizeEngine(v: unknown): AgentEngine {
  return v === 'codex' || v === 'cursor' || v === 'opencode' || v === 'pi' || v === 'hermes' || v === 'commandcode' || v === 'devin' ? v : 'claude'
}

/**
 * Legacy Managed machines predate campaign billing. Their retired plan rows still say
 * `authMode=managed`, but they have no billing lifecycle or provider references. Treating every
 * Managed machine as externally billed sends those rows through plan/subscription cancellation and
 * makes them undeletable once the legacy plan is no longer in the campaign catalog.
 *
 * Any lifecycle state or provider reference is billing evidence and keeps the billing-safe delete
 * path intact, so a real renewable subscription can never be hidden without cancellation.
 */
function hasManagedCampaignBilling(binding: Machine): boolean {
  return binding.authMode === 'managed' && (
    binding.billingStatus === 'pending'
    || binding.billingStatus === 'active'
    || binding.billingStatus === 'suspended'
    || binding.externalDeviceId != null
    || binding.externalSubscriptionId != null
    || binding.externalSubscriptionStatus != null
    || binding.externalSubscriptionEndAt != null
    || binding.externalSubscriptionCancelledAt != null
    || binding.billingActivatedAt != null
  )
}

/** Best-effort node status + engine per machineId, read directly from the shared Mongo `machine_nodes`
 *  collection (the agent-manager owns writes; the backend just reads). `machine_nodes.engine` is an
 *  optional per-machine override; when absent, fall back to the owning manager's MACHINE_ENGINE mirror. */
async function nodeInfoByAgent(bindings: Machine[]): Promise<Map<string, { status: string; engine: string }>> {
  const out = new Map<string, { status: string; engine: string }>()
  const ids = bindings.map((b) => b.machineId)
  if (!ids.length) return out
  try {
    const raw = (await prisma.$runCommandRaw({
      find: 'machine_nodes',
      filter: { machineId: { $in: ids } },
      projection: { machineId: 1, status: 1, engine: 1, managerId: 1, _id: 0 },
    })) as { cursor?: { firstBatch?: Array<{ machineId?: string; status?: string; engine?: string; managerId?: string }> } }
    const nodes = raw?.cursor?.firstBatch ?? []
    const managerIds = [...new Set(nodes.map((n) => n.managerId).filter((id): id is string => typeof id === 'string'))]
    const managerEngines = new Map<string, AgentEngine>()
    if (managerIds.length) {
      const managers = await prisma.manager.findMany({
        where: { managerId: { in: managerIds } },
        select: { managerId: true, agentEngine: true },
      })
      for (const m of managers) managerEngines.set(m.managerId, normalizeEngine(m.agentEngine))
    }
    for (const n of nodes) {
      if (typeof n.machineId === 'string') {
        const fallback = n.managerId ? managerEngines.get(n.managerId) : undefined
        out.set(n.machineId, { status: n.status ?? 'unknown', engine: normalizeEngine(n.engine ?? fallback) })
      }
    }
  } catch { /* best effort — leave unresolved agents as unknown */ }
  for (const b of bindings) if (!out.has(b.machineId)) out.set(b.machineId, { status: 'unknown', engine: 'claude' })
  return out
}

/** Remote agents have no agent_nodes row — their liveness is the adapter's presence key
 *  (`agent:{id}:mgr`, set by /api/adapter-ws while the machine is connected). Patch `info` in place. */
async function applyRemoteStatus(
  bindings: Machine[],
  plans: Map<string, PlanInfo>,
  info: Map<string, { status: string; engine: string }>,
): Promise<void> {
  const remote = bindings.filter((b) => plans.get(b.machineId)?.authMode === 'remote')
  await Promise.all(
    remote.map(async (b) => {
      const online = !!(await getAgentPresence(b.machineId))
      info.set(b.machineId, { status: online ? 'running' : 'offline', engine: 'claude' })
    }),
  )
}

async function ownerViewForBinding(binding: Machine): Promise<OwnerMachine> {
  const machineId = binding.machineId
  if (billingStatusOf(binding) === 'pending') {
    const plans = await plansByMachine([binding])
    return toOwner(binding, 'payment_pending', 0, plans.get(machineId), 'claude')
  }
  const [info, counts, plans] = await Promise.all([
    nodeInfoByAgent([binding]),
    countByMachine([machineId]),
    plansByMachine([binding]),
  ])
  await applyRemoteStatus([binding], plans, info)
  const ni = info.get(machineId)
  return toOwner(binding, ni?.status ?? 'unknown', counts.get(machineId) ?? 0, plans.get(machineId), ni?.engine)
}

/** Best-effort background container teardown for a deleted managed machine. The row is already gone
 *  (the user got their response); this just reaps the container + node row. `destroy` is idempotent
 *  on the manager, so we retry a few times to survive a momentarily-busy/unreachable manager. If
 *  every attempt fails, the row/container is orphaned (reconcile won't reap binding-less rows) —
 *  log loudly for ops. */
async function destroyNodeWithRetry(machineId: string, managerId: string, attempts = 3): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await provisionViaManager(managerId, 'destroy', { machineId: machineId })
      logger.info('agent-node container destroyed', { machineId, managerId, attempt: i })
      return
    } catch (err) {
      if (i === attempts) {
        logger.error('agent-node teardown failed after retries — may leave an orphan container/row',
          err instanceof Error ? err : new Error(String(err)), { machineId, managerId })
        return
      }
      logger.warn('agent-node teardown attempt failed, retrying', { machineId, attempt: i, error: String(err) })
      await new Promise((r) => setTimeout(r, i * 3000)) // 3s, 6s backoff
    }
  }
}

/** Provider details, encrypted at rest. The credential is never stored or logged in the clear. */
function providerFields(provider?: { url: string; credential: string }): Record<string, string> {
  if (!provider) return {}
  return {
    providerUrl: provider.url,
    providerCredentialEncrypted: encryptMachineCredential(provider.credential),
  }
}

export const machineService = {
  /** Provision a machine for a user (N allowed). Managed tiers: pick a manager (best-fit) → bind (on a
   *  plan) → create a docker node. Remote tier: write ONLY the binding — the user pairs their own
   *  machine (machine-adapter CLI) with the apiKey; no placement, no node, no docker. */
  async create(
    userId: string,
    workspaceId: string | undefined,
    opts: {
      planId: string
      autonomousEnv: AutonomousEnvironment
      /** provider tier only — already probed by the route, stored encrypted here. */
      provider?: { url: string; credential: string }
    },
  ): Promise<OwnerMachine> {
    // The caller must pick a plan (required); it decides authMode (self/managed/remote) and, for managed
    // tiers, the manager resolves cpus/memory through it.
    const plan = await prisma.subscriptionPlan.findUnique({ where: { id: opts.planId } })
    if (!plan) throw new AppError('Unknown plan', 400, 'NO_PLAN')
    if (plan.available !== true) throw new AppError('Plan is not available for new machines', 409, 'PLAN_UNAVAILABLE')
    if (storedAutonomousEnvironment(plan.autonomousEnv) !== opts.autonomousEnv) {
      throw new AppError('Plan belongs to another Autonomous environment', 409, 'PLAN_ENV_MISMATCH')
    }

    const apiKey = generateApiKey()
    const machineId = machineIdFromKey(apiKey)
    const planInfo: PlanInfo = { authMode: toAuthMode(plan.authMode), name: plan.name }
    const campaignBilled = env.HARNESS_BILLING_ENABLED && !!plan.externalPlanId &&
      plan.campaignCode === env.HARNESS_CAMPAIGN_CODE

    if (planInfo.authMode === 'remote' && !campaignBilled) {
      if (env.HARNESS_BILLING_ENABLED) {
        throw new AppError('Remote machine billing is unavailable', 503, 'BILLING_DISABLED')
      }
      // Remote = pair the user's own machine. managerId '' marks "no owning manager"; the binding
      // is the whole agent. This immediate path exists only for the explicit billing rollback flag;
      // normal catalog-backed Remote machines start pending and use hosted checkout below.
      const binding = await prisma.machine.create({
        data: {
          userId, machineId: machineId, apiKey, managerId: '', workspaceId: workspaceId ?? null,
          autonomousEnv: opts.autonomousEnv,
          planId: plan.id, authMode: planInfo.authMode, billingStatus: 'not_required',
          ...providerFields(opts.provider),
        },
      })
      await publishDeviceMachineListChanged(userId, { reason: 'created' }).catch(() => { /* best effort */ })
      logger.info('remote agent created (binding only)', { userId, machineId, planId: plan.id })
      return toOwner(binding, 'offline', 0, planInfo, 'claude')
    }

    if (!campaignBilled) {
      throw new AppError('Machine billing is unavailable', 503, 'BILLING_DISABLED')
    }

    // Remote has no manager reservation or Docker runtime. Managed uses capacity-aware placement.
    // Remote and provider have no manager reservation and no Docker runtime; '' marks "no owning
    // manager" and the binding is the whole machine. Managed uses capacity-aware placement.
    const managerId = NODELESS_MODES.has(planInfo.authMode) ? '' : (await selectManagerId()).managerId

    // Free is an account-lifetime entitlement. Reserve it before committing the pending binding so
    // two concurrent tabs cannot create two Free machines. A binding-create failure releases only the
    // still-unclaimed reservation; once upstream activation succeeds the ledger is permanent.
    if (planInfo.authMode === 'managed') {
      await machineBillingService.reserveFreeEntitlement(userId, machineId, plan)
    }

    // Write the binding FIRST: the manager reads the plan (via planId) from it, and refuses to
    // create a node without a binding.
    let binding: Machine
    try {
      binding = await prisma.machine.create({
        data: {
          userId, machineId: machineId, apiKey, managerId,
          autonomousEnv: opts.autonomousEnv,
          workspaceId: workspaceId ?? null, planId: plan.id, authMode: planInfo.authMode,
          billingStatus: 'pending',
          ...providerFields(opts.provider),
        },
      })
    } catch (err) {
      if (planInfo.authMode === 'managed') {
        await machineBillingService.releaseFreeReservation(userId, machineId).catch(() => {})
      }
      throw err
    }
    // New managed machines reserve a manager slot but intentionally have no MachineNode/Docker until
    // Autonomous confirms the exact campaign/device/plan subscription.
    // The invalidation is safe for hardware devices because their machine query filters pending rows;
    // web tabs still need it so Resume/Cancel appears immediately everywhere.
    await publishDeviceMachineListChanged(userId, { reason: 'created' }).catch(() => { /* best effort */ })
    logger.info('pending campaign machine reserved', {
      userId,
      machineId,
      managerId,
      authMode: planInfo.authMode,
      planId: plan.id,
    })
    return toOwner(binding, 'payment_pending', 0, planInfo, 'claude')
  },

  /**
   * The machine a computer connects to through `harness login`: the one already bound to this
   * computerId, else a brand-new Remote machine.
   *
   * Deliberately does NOT go through `create()`. That path is the *purchase* path — it demands an
   * available plan and, with billing on, sends every Remote plan through a hosted checkout. Approving
   * a computer is not a purchase, so the machine is written straight as `not_required`: no checkout,
   * no campaign subscription, no manager reservation (Remote is nodeless, `managerId: ''`).
   *
   * `computerId` is normalized by the caller — the reuse lookup below is an
   * equality match, so a dashed uuid and its de-dashed twin must never both reach this.
   */
  async resolveOrCreateForComputer(
    userId: string,
    autonomousEnv: AutonomousEnvironment,
    computerId: string,
    label: string,
    claimedMachineId?: string,
  ): Promise<{ machine: Machine; created: boolean }> {
    // A caller that still holds a machine id we have DELETED must be told so, never quietly given a
    // new machine. Deletion is soft, so `machineAlive` below simply does not find the old row — and
    // without this guard the call falls through to `create` and mints a fresh machineId for the same
    // (userId, computerId). That is what made deleting a machine do nothing at all whenever its
    // computer was offline at the time: it reconnected moments later as a brand-new machine and
    // carried on, credentials intact.
    //
    // 403 is deliberate: the harness CLI already maps 403 on the adapter-ws upgrade to `onRevoked`,
    // which clears its SSO session and stops the daemon. A caller with NO claim (a fresh login, whose
    // session was cleared by exactly that revocation) is untouched and still pairs normally.
    if (claimedMachineId && isMachineId(claimedMachineId)) {
      const claimed = await prisma.machine.findUnique({ where: { machineId: claimedMachineId } })
      if (claimed && claimed.userId === userId && claimed.deletedAt) {
        throw new AppError('This machine was removed from the account', 403, 'MACHINE_REVOKED')
      }
    }
    const findExisting = (): Promise<Machine[]> => prisma.machine.findMany({
      where: { userId, computerId, authMode: 'remote', ...machineAlive },
      orderBy: { createdAt: 'asc' },
    })
    // Avoid Redis on the overwhelmingly common reconnect path. A half-bought row never becomes the
    // answer — the adapter would only get 402 on connect.
    const reusable = firstUsableComputerMachine(await findExisting())
    if (reusable) return { machine: reusable, created: false }

    return withComputerCreateLock(userId, computerId, async () => {
      // Another backend may have completed this computer's first login while this request waited.
      const afterLock = firstUsableComputerMachine(await findExisting())
      if (afterLock) return { machine: afterLock, created: false }

      if (env.HARNESS_DEVICE_AUTH_MACHINE_LIMIT > 0) {
        // Hygiene, not a security control: this path is free, and the computer id behind it is
        // self-declared, so a loop of fresh ids would otherwise mint unbounded rows. Rows are cheap
        // (no container), hence a generous ceiling rather than a tight one.
        const owned = await prisma.machine.count({
          where: { userId, authMode: 'remote', billingStatus: 'not_required', ...machineAlive },
        })
        if (owned >= env.HARNESS_DEVICE_AUTH_MACHINE_LIMIT) {
          throw new AppError('Too many connected computers on this account', 409, 'TOO_MANY_MACHINES')
        }
      }

      const apiKey = generateApiKey()
      const machineId = machineIdFromKey(apiKey)
      // Best-effort: the catalog may have no Remote plan in this plane. planId is optional everywhere —
      // plansByMachine only reads it for the display name, and authMode is denormalized on the row.
      const plan = await prisma.subscriptionPlan.findFirst({
        where: { autonomousEnv, authMode: 'remote' },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      })
      const machine = await prisma.machine.create({
        data: {
          userId,
          machineId,
          apiKey,
          managerId: '',
          autonomousEnv,
          planId: plan?.id ?? null,
          authMode: 'remote',
          billingStatus: 'not_required',
          computerId,
          // Seeded from the computer's hostname so the card is never a bare id. The owner can rename it;
          // a later connect only ever refreshes `hostname`, never this.
          name: label.trim().slice(0, 120) || null,
        },
      })
      await publishDeviceMachineListChanged(userId, { reason: 'created' }).catch(() => { /* best effort */ })
      logger.info('remote machine created for computer', { userId, machineId, computerId })
      return { machine, created: true }
    })
  },

  /** List a user's agents (with best-effort live status). Includes the api key (owner only). */
  async listForUser(userId: string, autonomousEnv?: AutonomousEnvironment): Promise<OwnerMachine[]> {
    const rows = await prisma.machine.findMany({
      where: { userId, ...(autonomousEnv ? { autonomousEnv } : {}), ...machineAlive },
      orderBy: { createdAt: 'desc' },
    })
    if (rows.length === 0) return []
    const ids = rows.map((b) => b.machineId)
    const [info, counts, plans] = await Promise.all([nodeInfoByAgent(rows), countByMachine(ids), plansByMachine(rows)])
    await applyRemoteStatus(rows, plans, info)
    return rows.map((b) => {
      if (billingStatusOf(b) === 'pending') return toOwner(b, 'payment_pending', 0, plans.get(b.machineId), 'claude')
      const ni = info.get(b.machineId)
      return toOwner(b, ni?.status ?? 'unknown', counts.get(b.machineId) ?? 0, plans.get(b.machineId), ni?.engine)
    })
  },

  /** Fetch one agent (incl. its data-plane apiKey). Owner or admin only. */
  async get(machineId: string, requester: MachineRequester): Promise<OwnerMachine> {
    assertMachineId(machineId)
    const binding = await prisma.machine.findUnique({ where: { machineId: machineId } })
    if (!binding || binding.deletedAt) throw new NotFoundError('Machine')
    if (binding.userId !== requester.sub && requester.role !== 'admin') {
      throw new ForbiddenError('Not your machine')
    }
    assertRequesterEnvironment(binding, requester)
    return ownerViewForBinding(binding)
  },

  /** Resolve an Autonomous campaign device id to the caller's machine. This is owner- and
   * environment-scoped so a deep link can never reveal another account's machine. */
  async resolveByExternalDeviceId(externalDeviceId: string, requester: MachineRequester): Promise<OwnerMachine> {
    const binding = await prisma.machine.findFirst({
      where: {
        externalDeviceId,
        userId: requester.sub,
        ...(requester.autonomousEnv ? { autonomousEnv: requester.autonomousEnv } : {}),
        ...machineAlive,
      },
      orderBy: { createdAt: 'desc' },
    })
    if (!binding) throw new NotFoundError('Machine')
    return ownerViewForBinding(binding)
  },

  /** Owner-triggered on-demand wake. Remote machines have no Docker node and are rejected. */
  async start(machineId: string, requester: MachineRequester): Promise<void> {
    assertMachineId(machineId)
    const binding = await prisma.machine.findUnique({ where: { machineId: machineId } })
    if (!binding || binding.deletedAt) throw new NotFoundError('Machine')
    if (binding.userId !== requester.sub && requester.role !== 'admin') throw new ForbiddenError('Not your machine')
    assertRequesterEnvironment(binding, requester)
    assertMachineBillingActive(binding)
    if (isNodeless(binding.authMode) || !binding.managerId) throw new AppError('This machine has no node for the backend to start', 400, 'REMOTE_MACHINE')
    await ensureMachineReady(binding)
  },

  /** Owner-triggered manual stop. The manager keeps the container and persistent volume intact. */
  async stop(machineId: string, requester: MachineRequester): Promise<void> {
    assertMachineId(machineId)
    const binding = await prisma.machine.findUnique({ where: { machineId: machineId } })
    if (!binding || binding.deletedAt) throw new NotFoundError('Machine')
    if (binding.userId !== requester.sub && requester.role !== 'admin') throw new ForbiddenError('Not your machine')
    assertRequesterEnvironment(binding, requester)
    assertMachineBillingActive(binding)
    if (isNodeless(binding.authMode) || !binding.managerId) throw new AppError('This machine has no node for the backend to stop', 400, 'REMOTE_MACHINE')
    publishMachineLifecycle(binding.machineId, 'stopping', 'manual_stop')
    try {
      await provisionViaManager(binding.managerId, 'stop', { machineId: binding.machineId })
      // Covers an already-disconnected node where no unregister frame exists to announce the stop.
      publishMachineLifecycle(binding.machineId, 'stopped', 'manual_stop')
    } catch (err) {
      publishMachineLifecycle(binding.machineId, await getAgentPresence(binding.machineId) ? 'running' : 'offline', 'stop_failed')
      throw err
    }
  },

  /** Rename a machine. Owner or admin only. Writes `name` — the display surface shows
   *  `name || machine-<id8>`. `null` clears it back to the default (a remote machine gets its name
   *  re-seeded from the computer's hostname on the adapter's next connect).
   *  Fans the change out to live clients: devices re-snapshot via devmachines, a connected adapter
   *  gets a `machine_meta` down-frame, web tabs re-fetch on the forwarded `machines_changed`. */
  async rename(machineId: string, requester: MachineRequester, name: string | null): Promise<void> {
    assertMachineId(machineId)
    const binding = await prisma.machine.findUnique({ where: { machineId: machineId } })
    if (!binding || binding.deletedAt) throw new NotFoundError('Machine')
    if (binding.userId !== requester.sub && requester.role !== 'admin') {
      throw new ForbiddenError('Not your machine')
    }
    assertRequesterEnvironment(binding, requester)
    assertMachineBillingActive(binding)
    await prisma.machine.update({ where: { machineId }, data: { name } })
    await publishDeviceMachineListChanged(binding.userId, { reason: 'renamed' }).catch(() => { /* best effort */ })
    if (binding.managerId === '') {
      // Remote machine: a live adapter mirrors the name locally (`machine status`) — push it the new one.
      await publishDown(machineId, { connId: '', frame: { type: 'machine_meta', payload: { name } } }).catch(() => { /* best effort */ })
    }
    logger.info('machine renamed', { machineId, by: requester.sub, named: !!name })
  },

  /** Destroy a node. Owner or admin only. The binding row is SOFT-deleted (stamped `deletedAt`,
   *  kept for audit/restore) — every read path treats it as absent — while the physical resources
   *  (container/node row, adapter session, presence) are still torn down for real. */
  async destroy(machineId: string, requester: MachineRequester, accessToken?: string): Promise<void> {
    assertMachineId(machineId)
    const binding = await prisma.machine.findUnique({ where: { machineId: machineId } })
    if (!binding || binding.deletedAt) throw new NotFoundError('Machine')
    if (binding.userId !== requester.sub && requester.role !== 'admin') {
      throw new ForbiddenError('Not your machine')
    }
    assertRequesterEnvironment(binding, requester)
    const externallyBilled = hasManagedCampaignBilling(binding) ||
      (binding.authMode === 'remote' && billingStatusOf(binding) !== 'not_required')
    if (externallyBilled) {
      // Campaign devices/subscriptions belong to the owner's SSO account. Never use an admin's
      // token to cancel another user's billing. Billing cleanup must finish before local deletion.
      if (binding.userId !== requester.sub) throw new ForbiddenError('Billed machines must be deleted by their owner')
      if (!accessToken) throw new AppError('SSO access token required to cancel machine billing', 401, 'UNAUTHORIZED')
      await machineBillingService.deleteCampaignMachine(machineId, binding.userId, accessToken, requester.autonomousEnv)
    } else {
      // Non-billed Remote/legacy machines have no upstream subscription. Stamp the record now; the
      // physical cleanup below remains asynchronous.
      await prisma.machine.update({ where: { machineId: machineId }, data: { deletedAt: new Date() } }).catch(() => { /* already gone */ })
      await publishDeviceMachineListChanged(binding.userId, { reason: 'deleted' }).catch(() => { /* best effort */ })
    }

    if (binding.managerId === '') {
      // Remote agents have no node/container — just drop presence so the list goes offline immediately.
      // Also PUSH a machine_revoked down-frame so a LIVE adapter clears its saved token and stops now,
      // instead of only finding out (as a hard auth failure) on its next reconnect. adapterWs forwards
      // down-frames to the adapter socket; connId '' = not client-scoped.
      await publishDown(machineId, { connId: '', frame: { type: 'machine_revoked' } }).catch(() => { /* best effort */ })
      await clearAgentPresence(machineId).catch(() => { /* best effort */ })
    } else {
      // Managed: reap the container + node row in the background (idempotent on the manager → retryable).
      void destroyNodeWithRetry(machineId, binding.managerId)
    }
    logger.info('agent destroyed', { machineId, by: requester.sub, remote: binding.managerId === '', billingCancelled: externallyBilled })
  },
}
