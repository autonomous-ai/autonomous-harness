import type { AgentEngine } from '../engines/types.js'
import {
  agentAliasOwner,
  agentCommandOwnershipSnapshot,
  ENGINES,
  type AgentCommandOwnershipSnapshot,
} from './engineBin.js'
import { probeGatewayRuntime } from './gatewayRuntime.js'
import { probeGridAssignment, type GridAssignment } from './gridAssignment.js'
import type { TerminalBackend } from './terminalBackend.js'
import {
  ambiguousAgentProcess,
  engineProcessMatchScore,
  enrichProcessRows,
  processRows,
  processTreePids,
  resumeSessionId,
  type ProcessRow,
} from './tmux.js'
import { processIdentityKey, terminalInstanceId, terminalPlacementKey, terminalRouteKey } from './terminalRuntime.js'
import type {
  ProcessIdentity,
  TerminalInventoryResult,
  TerminalRootObservation,
  TerminalRuntimeRef,
} from './terminalTypes.js'

export { processRows } from './tmux.js'

export interface DiscoveredTerminalAgent {
  engine: AgentEngine
  cwd: string
  processIdentity: ProcessIdentity
  args: string
  resumeSessionId: string | null
  runtimes: TerminalRuntimeRef[]
  primaryRuntimeKey: string
  /**
   * 'ori' when this engine process is pointed at an OpenRouter endpoint (`ori claude` and friends).
   * undefined = the probe could not read the process; the registry then keeps whatever it already knew,
   * rather than downgrading a gateway agent to a vendor one on one failed read.
   *
   * Deliberately NOT a property of the terminal: the probe reads the engine's own env and argv, so a
   * gateway launch is recognized identically under tmux and under Herdr.
   */
  gateway?: 'ori' | null
  /**
   * The grid this engine process is pointed at, read from the same environment. null = a vendor login
   * or an unreadable probe — `gridAssignment.ts` explains why those share an answer.
   *
   * Backend-agnostic for the same reason `gateway` is: it is a fact about the process, not the pane.
   */
  grid?: GridAssignment | null
}

export interface TerminalTargetProbe {
  instanceId: string
  result: TerminalInventoryResult
}

export interface TerminalAgentProbe {
  processTableAvailable: boolean
  targets: TerminalTargetProbe[]
  agents: DiscoveredTerminalAgent[]
  ambiguousPlacements: Set<string>
}

interface RootOwner {
  agent: Omit<DiscoveredTerminalAgent, 'runtimes' | 'primaryRuntimeKey'> | null
  depth: number
  ambiguous: boolean
}

function childrenByParent(rows: readonly ProcessRow[]): Map<number, ProcessRow[]> {
  const children = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    const list = children.get(row.parentPid) ?? []
    list.push(row)
    children.set(row.parentPid, list)
  }
  return children
}

function daemonDescendants(rows: readonly ProcessRow[], daemonPid: number): Set<number> {
  const children = childrenByParent(rows)
  const excluded = new Set<number>()
  const queue = [daemonPid]
  while (queue.length) {
    const pid = queue.shift()!
    if (excluded.has(pid)) continue
    excluded.add(pid)
    for (const child of children.get(pid) ?? []) queue.push(child.pid)
  }
  return excluded
}

function rootOwner(
  root: TerminalRootObservation,
  rows: readonly ProcessRow[],
  excluded: ReadonlySet<number>,
  ownership: AgentCommandOwnershipSnapshot,
  hintedEngine?: AgentEngine,
): RootOwner {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const children = childrenByParent(rows)
  const queue: Array<{ pid: number; depth: number }> = [{ pid: root.rootPid, depth: 0 }]
  const matches: Array<{ row: ProcessRow; engine: AgentEngine; depth: number; score: number }> = []
  let unresolvedAliasDepth = Number.POSITIVE_INFINITY

  while (queue.length) {
    const current = queue.shift()!
    const row = byPid.get(current.pid)
    if (row && !excluded.has(row.pid)) {
      for (const engine of ENGINES) {
        const score = engineProcessMatchScore(row, engine, ownership)
        if (score > 0) matches.push({ row, engine, depth: current.depth, score })
      }
      if (ambiguousAgentProcess(row, ownership)) {
        const aliasOwner = agentAliasOwner([row.imageFileKey, row.entrypointFileKey], ownership)
        if (aliasOwner === 'unknown' && (hintedEngine === 'cursor' || hintedEngine === 'grok')) {
          matches.push({ row, engine: hintedEngine, depth: current.depth, score: 1 })
        } else {
          unresolvedAliasDepth = Math.min(unresolvedAliasDepth, current.depth)
        }
      }
    }
    for (const child of children.get(current.pid) ?? []) queue.push({ pid: child.pid, depth: current.depth + 1 })
  }

  if (!matches.length) return { agent: null, depth: Number.POSITIVE_INFINITY, ambiguous: Number.isFinite(unresolvedAliasDepth) }
  const shallowest = Math.min(...matches.map((match) => match.depth))
  if (unresolvedAliasDepth <= shallowest) return { agent: null, depth: shallowest, ambiguous: true }
  const atDepth = matches.filter((match) => match.depth === shallowest)
  const strongest = Math.max(...atDepth.map((match) => match.score))
  const finalists = atDepth.filter((match) => match.score === strongest)
  const unique = new Map(finalists.map((match) => [`${match.row.pid}:${match.engine}`, match]))
  if (unique.size !== 1) return { agent: null, depth: shallowest, ambiguous: true }

  const [{ row, engine }] = [...unique.values()]
  return {
    depth: shallowest,
    ambiguous: false,
    agent: {
      engine,
      cwd: root.cwd,
      processIdentity: { pid: row.pid, executable: row.executable, startMarker: row.startMarker },
      args: row.args,
      resumeSessionId: resumeSessionId(engine, row.args),
    },
  }
}

function runtimeRank(runtime: TerminalRuntimeRef, backendOrder: readonly string[], herdrSessionOrder: readonly string[]): number[] {
  const backend = backendOrder.indexOf(runtime.backend)
  const session = runtime.backend === 'herdr' ? herdrSessionOrder.indexOf(runtime.sessionName) : 0
  return [backend < 0 ? Number.MAX_SAFE_INTEGER : backend, session < 0 ? Number.MAX_SAFE_INTEGER : session]
}

function rankBefore(a: number[], b: number[]): boolean {
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])
}

/** Pure process-authoritative merge used by fixtures and the live coordinator. */
export function discoverTerminalAgentsFromSnapshot(
  roots: readonly TerminalRootObservation[],
  rows: readonly ProcessRow[],
  daemonPid: number,
  backendOrder: readonly string[],
  herdrSessionOrder: readonly string[],
  hints: ReadonlyMap<string, AgentEngine> = new Map(),
  ownership = agentCommandOwnershipSnapshot(),
): { agents: DiscoveredTerminalAgent[]; ambiguousPlacements: Set<string> } {
  const excluded = daemonDescendants(rows, daemonPid)
  const grouped = new Map<string, {
    agent: Omit<DiscoveredTerminalAgent, 'runtimes' | 'primaryRuntimeKey'>
    observations: Array<{ runtime: TerminalRuntimeRef; depth: number; cwd: string }>
  }>()
  const ambiguousPlacements = new Set<string>()

  for (const root of roots) {
    const owner = rootOwner(root, rows, excluded, ownership, hints.get(terminalRouteKey(root.runtime)))
    if (owner.ambiguous) {
      ambiguousPlacements.add(terminalPlacementKey(root.runtime))
      continue
    }
    if (!owner.agent) continue
    const key = processIdentityKey(owner.agent.engine, owner.agent.processIdentity)
    const group = grouped.get(key) ?? { agent: owner.agent, observations: [] }
    group.observations.push({ runtime: root.runtime, depth: owner.depth, cwd: root.cwd })
    grouped.set(key, group)
  }

  const agents = [...grouped.values()].map(({ agent, observations }): DiscoveredTerminalAgent => {
    const byPlacement = new Map<string, { runtime: TerminalRuntimeRef; depth: number; cwd: string }>()
    for (const observation of observations) byPlacement.set(terminalPlacementKey(observation.runtime), observation)
    const ordered = [...byPlacement.values()].sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth
      const ar = runtimeRank(a.runtime, backendOrder, herdrSessionOrder)
      const br = runtimeRank(b.runtime, backendOrder, herdrSessionOrder)
      if (rankBefore(ar, br)) return -1
      if (rankBefore(br, ar)) return 1
      return terminalPlacementKey(a.runtime).localeCompare(terminalPlacementKey(b.runtime))
    })
    return {
      ...agent,
      cwd: ordered[0].cwd,
      runtimes: ordered.map((observation) => observation.runtime),
      primaryRuntimeKey: terminalRouteKey(ordered[0].runtime),
    }
  })
  return { agents, ambiguousPlacements }
}

/** Probe all targets independently while reading the OS process table exactly once. */
export async function probeTerminalAgents(
  backends: readonly TerminalBackend[],
  backendOrder: readonly string[],
  herdrSessionOrder: readonly string[],
  daemonPid = process.pid,
  hints: ReadonlyMap<string, AgentEngine> = new Map(),
): Promise<TerminalAgentProbe> {
  const [targets, rows] = await Promise.all([
    Promise.all(backends.map(async (backend): Promise<TerminalTargetProbe> => ({
      instanceId: backend.instanceId,
      result: await backend.inventory().catch(() => ({ state: 'unavailable' as const, reason: 'terminal inventory failed' })),
    }))),
    processRows(),
  ])
  if (!rows) return { processTableAvailable: false, targets, agents: [], ambiguousPlacements: new Set() }
  const roots = targets.flatMap((target) => target.result.state === 'available' ? target.result.roots : [])
  const enrichedRows = await enrichProcessRows(rows, processTreePids(rows, roots.map((root) => root.rootPid)))
  const discovered = discoverTerminalAgentsFromSnapshot(
    roots,
    enrichedRows,
    daemonPid,
    backendOrder,
    herdrSessionOrder,
    hints,
  )
  // Which endpoint each agent's engine talks to. Cached per live process, so this is one read per agent
  // for its whole life rather than one per pass — and a failed read leaves `gateway` undefined rather
  // than false. Runs for every backend: the probe reads the process, not the pane.
  await Promise.all(discovered.agents.map(async (agent) => {
    const runtime = await probeGatewayRuntime(agent.processIdentity, agent.args)
    agent.gateway = runtime.kind
    // Same process, same cached read — the grid costs no extra `ps`.
    agent.grid = await probeGridAssignment(agent.processIdentity, agent.engine, agent.args)
  }))
  return { processTableAvailable: true, targets, ...discovered }
}

export function targetForRuntime(probe: TerminalAgentProbe, runtime: TerminalRuntimeRef): TerminalTargetProbe | undefined {
  return probe.targets.find((target) => target.instanceId === terminalInstanceId(runtime))
}
