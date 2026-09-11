import { prisma } from './prisma.js'
import { storedAutonomousEnvironment } from './autonomousEnvironment.js'

/**
 * Per-machine agent tracking (`machine_agents`) for plan caps. The source of truth for agent
 * CONTENT is the agent-node's SQLite; the central layer only keeps a count. Maintained by the backend
 * hub tap on the node's `agent_synced` / `agent_deleted` up-frames (see managerWs.ts) — this
 * replaced the old data-plane proxy-response tap when chat moved onto the hub WS.
 */

/**
 * The agent's current project count + its plan's max. Count comes from `machine_agents`; the cap is
 * resolved machineId → agent_bindings.planId → subscription_plans.maxAgents (default plan when no
 * planId; floor of 1 when unresolved).
 */
export async function agentLimit(machineId: string): Promise<{ count: number; max: number }> {
  const [count, bindingRow] = await Promise.all([
    prisma.machineAgent.count({ where: { machineId: machineId } }),
    prisma.machine.findUnique({ where: { machineId: machineId } }),
  ])
  const binding = bindingRow && !bindingRow.deletedAt ? bindingRow : null // soft-deleted = absent
  const plan = binding?.planId
    ? await prisma.subscriptionPlan.findUnique({ where: { id: binding.planId } })
    : await prisma.subscriptionPlan.findFirst({
      where: { autonomousEnv: storedAutonomousEnvironment(binding?.autonomousEnv), isDefault: true },
    })
  return { count, max: plan?.maxAgents ?? 1 }
}

/** Upsert a `machine_agents` row from an agent object (hub tap on `agent_synced`). Best-effort. */
export async function recordCreatedAgent(machineId: string, agent: { id?: unknown; name?: unknown } | null | undefined): Promise<void> {
  const agentId = typeof agent?.id === 'string' ? agent.id : undefined
  if (!agentId) return
  const name = typeof agent?.name === 'string' ? agent.name : null
  await prisma.machineAgent.upsert({
    where: { machineId_agentId: { machineId, agentId } },
    create: { machineId, agentId, name },
    update: { name },
  })
}

/** Remove a `machine_agents` row (hub tap on `agent_deleted`). */
export async function recordDeletedAgent(machineId: string, agentId: string): Promise<void> {
  if (!agentId) return
  await prisma.machineAgent.deleteMany({ where: { machineId, agentId } })
}
