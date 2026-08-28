import type { AgentEngine } from '../engines/types.js'
import type { RegisteredSession } from './registry.js'
import {
  probeTerminalAgents,
  targetForRuntime,
  type DiscoveredTerminalAgent,
  type TerminalAgentProbe,
} from './terminalAgentDiscovery.js'
import type { TerminalBackend } from './terminalBackend.js'
import { mergeTerminalRuntimes, processIdentityKey, terminalPlacementKey, terminalRouteKey } from './terminalRuntime.js'
import type { TerminalRuntimeRef } from './terminalTypes.js'

const MISS_LIMIT = 2

export interface TerminalAgentReconcilerDeps {
  current: () => RegisteredSession[]
  backends: readonly TerminalBackend[]
  backendOrder: readonly string[]
  herdrSessionOrder: readonly string[]
  onDiscovered: (agent: DiscoveredTerminalAgent) => void | Promise<void>
  onObserved: (agent: DiscoveredTerminalAgent, current: RegisteredSession) => void | Promise<void>
  onDormant: (current: RegisteredSession, reason: string) => void | Promise<void>
  onRemoved: (current: RegisteredSession, reason: string) => void | Promise<void>
  transaction?: <T>(apply: () => T | Promise<T>) => Promise<T>
  /** Refresh configured backend instances before each immutable probe cycle. */
  beforeProbe?: () => void | Promise<void>
  probe?: (hints: ReadonlyMap<string, AgentEngine>) => Promise<TerminalAgentProbe>
  daemonPid?: number
}

function currentProcessKey(session: RegisteredSession): string | null {
  return session.processIdentity ? processIdentityKey(session.engine, session.processIdentity) : null
}

/** Serialized, failure-isolated reconciliation across every enabled backend instance. */
export class TerminalAgentReconciler {
  private readonly misses = new Map<string, number>()
  private readonly suppressed = new Set<string>()
  private readonly hints = new Map<string, AgentEngine>()
  private pending = false
  private inFlight: Promise<void> | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly deps: TerminalAgentReconcilerDeps) {}

  start(intervalMs: number): void {
    void this.trigger()
    this.timer = setInterval(() => { void this.trigger() }, intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  triggerHint(runtime: TerminalRuntimeRef, engine: AgentEngine): Promise<void> {
    this.hints.set(terminalRouteKey(runtime), engine)
    return this.trigger()
  }

  /**
   * Adopt an engine process that a backend-specific, pane-scoped probe already verified.
   *
   * New-agent creation has stronger evidence than the periodic inventory scan: it owns the exact
   * runtime it just created and resolves the requested engine beneath that runtime. Passing that
   * observation through the same callbacks used by reconciliation keeps process-agent creation and
   * later session binding on one path, while avoiding a second best-effort inventory snapshot.
   */
  async adoptVerified(observed: DiscoveredTerminalAgent): Promise<RegisteredSession | undefined> {
    const apply = async (): Promise<RegisteredSession | undefined> => {
      const key = processIdentityKey(observed.engine, observed.processIdentity)
      const current = this.deps.current().find((candidate) => currentProcessKey(candidate) === key)
      if (current) await this.deps.onObserved(observed, current)
      else await this.deps.onDiscovered(observed)
      return this.deps.current().find((candidate) => currentProcessKey(candidate) === key)
    }
    return this.deps.transaction ? this.deps.transaction(apply) : apply()
  }

  /** Hide an explicitly deleted process until an authoritative scan proves that process exited. */
  suppress(session: Pick<RegisteredSession, 'engine' | 'processIdentity'>): void {
    if (session.processIdentity) this.suppressed.add(processIdentityKey(session.engine, session.processIdentity))
  }

  trigger(): Promise<void> {
    this.pending = true
    if (!this.inFlight) this.inFlight = this.drain().finally(() => { this.inFlight = null })
    return this.inFlight
  }

  private async drain(): Promise<void> {
    while (this.pending) {
      this.pending = false
      await this.reconcileOnce()
    }
  }

  private async reconcileOnce(): Promise<void> {
    await this.deps.beforeProbe?.()
    const hints = new Map(this.hints)
    const probe = await (this.deps.probe
      ? this.deps.probe(hints)
      : probeTerminalAgents(
        this.deps.backends,
        this.deps.backendOrder,
        this.deps.herdrSessionOrder,
        this.deps.daemonPid ?? process.pid,
        hints,
      ))
    if (!probe.processTableAvailable) {
      console.warn('[discovery] process table unavailable; keeping existing terminal agents')
      return
    }
    this.hints.clear()

    const observedKeys = new Set(probe.agents.map((agent) => processIdentityKey(agent.engine, agent.processIdentity)))
    for (const key of [...this.suppressed]) if (!observedKeys.has(key)) this.suppressed.delete(key)
    probe.agents = probe.agents.filter((agent) => !this.suppressed.has(processIdentityKey(agent.engine, agent.processIdentity)))

    const apply = async (): Promise<void> => {
      const before = this.deps.current()
      const observedByProcess = new Map(probe.agents.map((agent) => [
        processIdentityKey(agent.engine, agent.processIdentity),
        agent,
      ]))
      const matchedProcesses = new Set<string>()

      // Refresh existing process identities first. New route owners are opened afterwards so split/merge
      // conflict handling never depends on backend probe completion order.
      for (const current of before) {
        const processKey = currentProcessKey(current)
        const observed = processKey ? observedByProcess.get(processKey) : undefined
        if (observed) matchedProcesses.add(processKey!)

        let nextRuntimes = current.runtimes
        for (const runtime of current.runtimes) {
          const target = targetForRuntime(probe, runtime)
          if (!target || target.result.state !== 'available') continue
          const placement = terminalPlacementKey(runtime)
          if (probe.ambiguousPlacements.has(placement)) continue
          const replacement = observed?.runtimes.find((candidate) => terminalPlacementKey(candidate) === placement)
          const missKey = `${current.agentId}\u0000${placement}`
          if (replacement) {
            this.misses.delete(missKey)
            nextRuntimes = mergeTerminalRuntimes(nextRuntimes, [replacement])
            continue
          }
          const misses = (this.misses.get(missKey) ?? 0) + 1
          if (misses < MISS_LIMIT) {
            this.misses.set(missKey, misses)
            continue
          }
          this.misses.delete(missKey)
          nextRuntimes = nextRuntimes.filter((candidate) => terminalPlacementKey(candidate) !== placement)
        }

        if (observed) {
          const availableInstances = new Set(probe.targets
            .filter((target) => target.result.state === 'available')
            .map((target) => target.instanceId))
          const unknownRuntimes = current.runtimes.filter((runtime) => !availableInstances.has(
            runtime.backend === 'tmux' ? 'tmux:default' : `herdr:${runtime.endpointId}`,
          ))
          const merged: DiscoveredTerminalAgent = {
            ...observed,
            runtimes: mergeTerminalRuntimes(unknownRuntimes, [...nextRuntimes, ...observed.runtimes]),
          }
          await this.deps.onObserved(merged, current)
        } else if (nextRuntimes.length < current.runtimes.length && nextRuntimes.length > 0) {
          await this.deps.onObserved({
            engine: current.engine,
            cwd: current.cwd ?? '',
            processIdentity: current.processIdentity!,
            args: current.processIdentity?.executable ?? '',
            resumeSessionId: null,
            runtimes: nextRuntimes,
            primaryRuntimeKey: nextRuntimes.some((runtime) => terminalRouteKey(runtime) === current.primaryRuntimeKey)
              ? current.primaryRuntimeKey
              : terminalRouteKey(nextRuntimes[0]),
          }, current)
          await this.deps.onDormant(current, 'no terminal runtime currently verifies this process')
        } else if (nextRuntimes.length === 0) {
          await this.deps.onRemoved(current, `terminal runtime absent after ${MISS_LIMIT} confirmed scans`)
        } else {
          await this.deps.onDormant(current, 'no terminal runtime currently verifies this process')
        }
      }

      for (const observed of probe.agents) {
        const key = processIdentityKey(observed.engine, observed.processIdentity)
        if (!matchedProcesses.has(key)) await this.deps.onDiscovered(observed)
      }
    }

    if (this.deps.transaction) await this.deps.transaction(apply)
    else await apply()
  }
}
