/**
 * Discover the top-level supported coding-agent process in every tmux pane.
 *
 * The process is the agent. A launcher, hook, transcript, or session id may describe it, but none of
 * those owns its lifetime. One successful reconciliation reads tmux once and ps once, then applies the
 * same snapshot to every pane so a slow machine cannot turn N agents into N independent timeout risks.
 */

import { execFile } from 'node:child_process'
import {
  agentAliasOwner,
  agentCommandOwnershipSnapshot,
  ENGINES,
  type AgentCommandOwnershipSnapshot,
} from './engineBin.js'
import type { AgentEngine } from '../engines/types.js'
import type { ProcessIdentity, RegisteredSession } from './registry.js'
import {
  ambiguousAgentProcess,
  engineProcessMatchScore,
  enrichProcessRows,
  parseProcessRow,
  resumeSessionId,
  type ProcessRow,
} from './tmux.js'

export interface TmuxPaneSnapshot {
  tmuxPane: string
  rootPid: number
  cwd: string
}

export interface DiscoveredTmuxAgent {
  engine: AgentEngine
  tmuxPane: string
  cwd: string
  processIdentity: ProcessIdentity
  /** The stable engine process argv, used only to bind an explicit `--resume <id>` after discovery. */
  args: string
  resumeSessionId: string | null
}

export type TmuxAgentProbe =
  | { ok: true; agents: DiscoveredTmuxAgent[]; panes: Set<string>; ambiguousPanes: Set<string> }
  | { ok: false; error: string }

export interface TmuxAgentDiscoveryDeps {
  current: () => RegisteredSession[]
  onDiscovered: (agent: DiscoveredTmuxAgent) => void | Promise<void>
  onObserved: (agent: DiscoveredTmuxAgent, current: RegisteredSession) => void | Promise<void>
  onRemoved: (agent: RegisteredSession, reason: string) => void | Promise<void>
  probe?: (daemonPid: number, hints?: ReadonlyMap<string, AgentEngine>) => Promise<TmuxAgentProbe>
  daemonPid?: number
}

const MISS_LIMIT = 2

function execText(command: string, args: string[], timeout: number): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout }, (err, stdout) => {
      if (err) { resolve({ ok: false, error: err.message }); return }
      resolve({ ok: true, stdout })
    })
  })
}

function parsePanes(stdout: string): TmuxPaneSnapshot[] {
  const panes: TmuxPaneSnapshot[] = []
  for (const line of stdout.split('\n')) {
    const [tmuxPane, pidText, ...cwdParts] = line.split('\t')
    const rootPid = Number(pidText)
    if (!/^%\d+$/.test(tmuxPane) || !Number.isSafeInteger(rootPid) || rootPid <= 0) continue
    panes.push({ tmuxPane, rootPid, cwd: cwdParts.join('\t') })
  }
  return panes
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

/**
 * Pick one pane owner from an already-read process tree.
 *
 * Depth outranks score: a supported CLI nested below another supported CLI is a sub-agent/tool child and
 * must not steal the pane. Score only distinguishes wrappers at the same depth. A remaining tie is
 * ambiguous and deliberately produces no agent.
 */
function paneOwner(
  pane: TmuxPaneSnapshot,
  rows: readonly ProcessRow[],
  excluded: ReadonlySet<number>,
  ownership: AgentCommandOwnershipSnapshot,
  hintedEngine?: AgentEngine,
): { agent: DiscoveredTmuxAgent | null; ambiguous: boolean } {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const children = childrenByParent(rows)
  const queue: Array<{ pid: number; depth: number }> = [{ pid: pane.rootPid, depth: 0 }]
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
        // A vendor hook is pane-scoped evidence from the running CLI. It may resolve an otherwise bare
        // `agent`, but can never override strong file/package evidence for the other vendor.
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

  if (!matches.length) return { agent: null, ambiguous: Number.isFinite(unresolvedAliasDepth) }
  const shallowest = Math.min(...matches.map((match) => match.depth))
  if (unresolvedAliasDepth <= shallowest) return { agent: null, ambiguous: true }
  const atDepth = matches.filter((match) => match.depth === shallowest)
  const strongest = Math.max(...atDepth.map((match) => match.score))
  const finalists = atDepth.filter((match) => match.score === strongest)
  const unique = new Map(finalists.map((match) => [`${match.row.pid}:${match.engine}`, match]))
  if (unique.size !== 1) return { agent: null, ambiguous: true }

  const [{ row, engine }] = [...unique.values()]
  return {
    ambiguous: false,
    agent: {
      engine,
      tmuxPane: pane.tmuxPane,
      cwd: pane.cwd,
      processIdentity: { pid: row.pid, executable: row.executable, startMarker: row.startMarker },
      args: row.args,
      resumeSessionId: resumeSessionId(engine, row.args),
    },
  }
}

/** Pure snapshot form used by the reconciler and process-table fixtures. */
export function discoverTmuxAgentsFromSnapshot(
  panes: readonly TmuxPaneSnapshot[],
  rows: readonly ProcessRow[],
  daemonPid: number,
  ownership = agentCommandOwnershipSnapshot(),
  hints: ReadonlyMap<string, AgentEngine> = new Map(),
): Extract<TmuxAgentProbe, { ok: true }> {
  const excluded = daemonDescendants(rows, daemonPid)
  const agents: DiscoveredTmuxAgent[] = []
  const ambiguousPanes = new Set<string>()
  for (const pane of panes) {
    const owner = paneOwner(pane, rows, excluded, ownership, hints.get(pane.tmuxPane))
    if (owner.ambiguous) ambiguousPanes.add(pane.tmuxPane)
    else if (owner.agent) agents.push(owner.agent)
  }
  return { ok: true, agents, panes: new Set(panes.map((pane) => pane.tmuxPane)), ambiguousPanes }
}

/** One tmux call plus one ps call for a complete reconciliation pass. */
export async function probeTmuxAgents(
  daemonPid = process.pid,
  hints: ReadonlyMap<string, AgentEngine> = new Map(),
): Promise<TmuxAgentProbe> {
  const [tmux, ps] = await Promise.all([
    execText('tmux', ['list-panes', '-a', '-F', '#{pane_id}\t#{pane_pid}\t#{pane_current_path}'], 2_000),
    execText('ps', ['-axo', 'pid=,ppid=,comm=,lstart=,args='], 3_000),
  ])
  if (!tmux.ok) return { ok: false, error: `tmux list-panes failed: ${tmux.error}` }
  if (!ps.ok) return { ok: false, error: `process table failed: ${ps.error}` }
  const parsed = ps.stdout.split('\n').map(parseProcessRow).filter((row): row is ProcessRow => row !== null)
  const rows = await enrichProcessRows(parsed)
  return discoverTmuxAgentsFromSnapshot(
    parsePanes(tmux.stdout),
    rows,
    daemonPid,
    agentCommandOwnershipSnapshot(),
    hints,
  )
}

export function sameRuntime(
  current: Pick<RegisteredSession, 'engine' | 'tmuxPane' | 'processIdentity'>,
  observed: Pick<DiscoveredTmuxAgent, 'engine' | 'tmuxPane' | 'processIdentity'>,
): boolean {
  const saved = current.processIdentity
  const live = observed.processIdentity
  return current.engine === observed.engine
    && current.tmuxPane === observed.tmuxPane
    && !!saved
    && saved.pid === live.pid
    && saved.startMarker === live.startMarker
}

export function runtimeKey(runtime: Pick<DiscoveredTmuxAgent, 'engine' | 'tmuxPane' | 'processIdentity'>): string {
  return `${runtime.tmuxPane}\u0000${runtime.engine}\u0000${runtime.processIdentity.pid}\u0000${runtime.processIdentity.startMarker}`
}

/**
 * Serialized/coalesced lifecycle loop. Successful negative observations count; probe failures and
 * ambiguous panes leave both the agent and its miss count untouched.
 */
export class TmuxAgentReconciler {
  private readonly misses = new Map<string, number>()
  private readonly suppressed = new Set<string>()
  private pending = false
  private inFlight: Promise<void> | null = null
  private timer: NodeJS.Timeout | null = null
  private readonly hints = new Map<string, AgentEngine>()
  private readonly warnedAmbiguousPanes = new Set<string>()

  constructor(private readonly deps: TmuxAgentDiscoveryDeps) {}

  start(intervalMs: number): void {
    void this.trigger()
    this.timer = setInterval(() => { void this.trigger() }, intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Hide an explicitly deleted runtime until a successful scan proves that exact process is gone. */
  suppress(runtime: Pick<DiscoveredTmuxAgent, 'engine' | 'tmuxPane' | 'processIdentity'>): void {
    this.suppressed.add(runtimeKey(runtime))
  }

  trigger(): Promise<void> {
    this.pending = true
    if (!this.inFlight) this.inFlight = this.drain().finally(() => { this.inFlight = null })
    return this.inFlight
  }

  /** A validated vendor hook may resolve the otherwise colliding bare `agent` command in one pane. */
  triggerHint(tmuxPane: string, engine: AgentEngine): Promise<void> {
    this.hints.set(tmuxPane, engine)
    return this.trigger()
  }

  private async drain(): Promise<void> {
    while (this.pending) {
      this.pending = false
      await this.reconcileOnce()
    }
  }

  private async reconcileOnce(): Promise<void> {
    const hints = new Map(this.hints)
    const probe = await (this.deps.probe ?? probeTmuxAgents)(this.deps.daemonPid ?? process.pid, hints)
    if (!probe.ok) {
      console.warn(`[discovery] ${probe.error}; keeping ${this.deps.current().length} agent(s)`)
      return
    }
    for (const pane of hints.keys()) this.hints.delete(pane)
    for (const pane of probe.ambiguousPanes) {
      if (this.warnedAmbiguousPanes.has(pane)) continue
      this.warnedAmbiguousPanes.add(pane)
      console.warn(`[discovery] ${pane} has an unresolved agent command; set CURSOR_PATH or GROK_PATH to an absolute vendor CLI path`)
    }
    for (const pane of [...this.warnedAmbiguousPanes]) {
      if (!probe.ambiguousPanes.has(pane)) this.warnedAmbiguousPanes.delete(pane)
    }

    const observedKeys = new Set(probe.agents.map(runtimeKey))
    for (const key of [...this.suppressed]) if (!observedKeys.has(key)) this.suppressed.delete(key)

    const before = this.deps.current()
    const byPane = new Map(before.map((agent) => [agent.tmuxPane, agent]))
    const observedAgentIds = new Set<string>()

    for (const observed of probe.agents) {
      if (this.suppressed.has(runtimeKey(observed))) continue
      const current = byPane.get(observed.tmuxPane)
      if (!current) {
        await this.deps.onDiscovered(observed)
        continue
      }
      // One-time migration from a launcher-owned record that did not persist a process identity.
      const legacyMatch = !current.processIdentity && current.engine === observed.engine
      if (legacyMatch || sameRuntime(current, observed)) {
        observedAgentIds.add(current.agentId)
        this.misses.delete(current.agentId)
        await this.deps.onObserved(observed, current)
        continue
      }
      this.misses.delete(current.agentId)
      await this.deps.onRemoved(current, `process replaced in ${observed.tmuxPane}`)
      await this.deps.onDiscovered(observed)
    }

    for (const current of before) {
      if (observedAgentIds.has(current.agentId)) continue
      if (probe.ambiguousPanes.has(current.tmuxPane)) continue
      const observed = probe.agents.find((candidate) => candidate.tmuxPane === current.tmuxPane)
      if (observed) continue // replacement already handled above
      const misses = (this.misses.get(current.agentId) ?? 0) + 1
      if (misses < MISS_LIMIT) {
        this.misses.set(current.agentId, misses)
        continue
      }
      this.misses.delete(current.agentId)
      const reason = probe.panes.has(current.tmuxPane)
        ? `no supported engine process in ${current.tmuxPane} after ${MISS_LIMIT} confirmed scans`
        : `tmux pane ${current.tmuxPane} absent after ${MISS_LIMIT} confirmed scans`
      await this.deps.onRemoved(current, reason)
    }
  }
}
