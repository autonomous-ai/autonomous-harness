import { isNodeless } from '../services/MachineService.js'
import type { Machine } from '@prisma/client'
import { prisma } from './prisma.js'
import { getAgentPresence, publishUp } from './bus.js'
import { provisionViaManager } from './provision.js'
import { logger } from '../utils/logger.js'
import { assertMachineBillingActive } from './billingState.js'

export type MachineLifecycleStatus = 'creating' | 'starting' | 'running' | 'stopping' | 'stopped' | 'offline' | 'failed' | 'unknown'

const READY_TIMEOUT_MS = 65_000
const POLL_MS = 250
const READY_CACHE_MS = 30_000
const wakes = new Map<string, Promise<void>>()
const readyUntil = new Map<string, number>()

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class MachineWakeError extends Error {
  constructor(message: string, readonly code: 'MACHINE_START_FAILED' | 'MACHINE_START_TIMEOUT') {
    super(message)
    this.name = 'MachineWakeError'
  }
}

/** Read the manager-owned machine_nodes lifecycle without adding that model to the backend Prisma schema. */
export async function getMachineLifecycleState(machineId: string): Promise<{ status: MachineLifecycleStatus; stopReason?: string }> {
  try {
    const raw = (await prisma.$runCommandRaw({
      find: 'machine_nodes',
      filter: { machineId },
      projection: { status: 1, stopReason: 1, _id: 0 },
      limit: 1,
    })) as { cursor?: { firstBatch?: Array<{ status?: string; stopReason?: string }> } }
    const row = raw.cursor?.firstBatch?.[0]
    return {
      status: typeof row?.status === 'string' ? row.status as MachineLifecycleStatus : 'unknown',
      ...(typeof row?.stopReason === 'string' ? { stopReason: row.stopReason } : {}),
    }
  } catch {
    return { status: 'unknown' }
  }
}

export async function getMachineLifecycleStatus(machineId: string): Promise<MachineLifecycleStatus> {
  return (await getMachineLifecycleState(machineId)).status
}

export function publishMachineLifecycle(machineId: string, status: MachineLifecycleStatus, reason?: string): void {
  void publishUp(machineId, {
    webEligible: true,
    commanderEligible: true,
    frame: { type: 'node_status', payload: { online: status === 'running', status, ...(reason ? { reason } : {}) } },
  })
}

type WakeBinding = Pick<Machine, 'machineId' | 'managerId' | 'authMode'> & { billingStatus?: string | null }

async function wake(binding: WakeBinding, subdomain?: string): Promise<void> {
  assertMachineBillingActive(binding)
  if (isNodeless(binding.authMode) || !binding.managerId) return
  const before = await getMachineLifecycleStatus(binding.machineId)
  const alreadyOnline = !!(await getAgentPresence(binding.machineId))
  if (!alreadyOnline || before !== 'running') publishMachineLifecycle(binding.machineId, 'starting')

  try {
    await provisionViaManager(binding.managerId, 'start', { machineId: binding.machineId, ...(subdomain ? { subdomain } : {}) })
  } catch (err) {
    const timeout = err instanceof Error && (err.name === 'ProvisionTimeoutError' || /timed out/i.test(err.message))
    const code = timeout ? 'MACHINE_START_TIMEOUT' : 'MACHINE_START_FAILED'
    // An app-specific readiness failure can happen after the node itself is already healthy. Keep
    // machine lifecycle accurate while returning the proxy failure to this request.
    const nodeOnline = !!(await getAgentPresence(binding.machineId))
    publishMachineLifecycle(binding.machineId, nodeOnline ? 'running' : timeout ? 'offline' : 'failed', code.toLowerCase())
    throw new MachineWakeError(err instanceof Error ? err.message : String(err), code)
  }

  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await getAgentPresence(binding.machineId)) {
      publishMachineLifecycle(binding.machineId, 'running')
      return
    }
    await sleep(POLL_MS)
  }
  publishMachineLifecycle(binding.machineId, 'offline', 'start_timeout')
  throw new MachineWakeError(`machine ${binding.machineId} did not register after start`, 'MACHINE_START_TIMEOUT')
}

/** Idempotent and herd-safe within this backend instance. The manager independently coalesces too. */
export async function ensureMachineReady(
  binding: WakeBinding,
  opts: { subdomain?: string } = {},
): Promise<void> {
  assertMachineBillingActive(binding)
  if (isNodeless(binding.authMode) || !binding.managerId) return Promise.resolve()
  const key = opts.subdomain ? `${binding.machineId}:app:${opts.subdomain}` : binding.machineId
  if (Date.now() < (readyUntil.get(key) ?? 0) && await getAgentPresence(binding.machineId)) return
  const pending = wakes.get(key)
  if (pending) return pending
  const p = wake(binding, opts.subdomain)
    .then(() => { readyUntil.set(key, Date.now() + READY_CACHE_MS) })
    .catch((err) => {
      logger.warn('machine wake failed', { machineId: binding.machineId, managerId: binding.managerId, error: err instanceof Error ? err.message : String(err) })
      throw err
    })
    .finally(() => { if (wakes.get(key) === p) wakes.delete(key) })
  wakes.set(key, p)
  return p
}
