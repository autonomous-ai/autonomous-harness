/**
 * The agent list, and the mutations on it.
 *
 * There is no discovery document: `agent.list` IS how a client learns what this provider offers, and
 * it is authenticated, so two credentials can legitimately see two different lists.
 *
 * The list is MUTABLE, and that matters more than it looks. An earlier version derived the set of
 * valid ids once at module load; the moment `agent.create` could add one, that snapshot was stale and
 * a send to the freshly created agent came back `not_found`. Ids are derived on read here for exactly
 * that reason — there is no second list to fall out of step.
 */
import type { Agent } from './types.js'

export const CREDENTIAL_HEADER = 'authorization'

/** Two to start with, so agent scoping has something to get wrong. */
let agents: Agent[] = [
  { id: 'alpha', name: 'Alpha', description: 'The default agent' },
  { id: 'beta', name: 'Beta', description: 'A second agent, for scoping' },
]

export const listAgents = (): Agent[] => agents.map((a) => ({ ...a }))

export const hasAgent = (id: string): boolean => agents.some((a) => a.id === id)

export class AgentError extends Error {}

export function createAgent(name: string, description?: string): Agent {
  const clean = name.trim()
  if (!clean) throw new AgentError('name is required')
  const base = clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent'
  let id = base
  for (let n = 2; hasAgent(id); n++) id = `${base}-${n}`
  const created: Agent = { id, name: clean, ...(description ? { description } : {}) }
  agents.push(created)
  return created
}

export function renameAgent(id: string, name: string): Agent {
  const clean = name.trim()
  if (!clean) throw new AgentError('name is required')
  const found = agents.find((a) => a.id === id)
  if (!found) throw new AgentError(`no agent ${id}`)
  found.name = clean
  return { ...found }
}

export function deleteAgent(id: string): void {
  if (!hasAgent(id)) throw new AgentError(`no agent ${id}`)
  agents = agents.filter((a) => a.id !== id)
}

/** Test seam: the list is module state, and one test's `agent.create` must not leak into the next. */
export function resetAgents(): void {
  agents = [
    { id: 'alpha', name: 'Alpha', description: 'The default agent' },
    { id: 'beta', name: 'Beta', description: 'A second agent, for scoping' },
  ]
}
