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
  onTerminalAvailability?: (current: RegisteredSession, available: boolean) => void | Promise<void>
  onProbeStatus?: (status: { ready: true; error: string | null }) => void
  transaction?: <T>(apply: () => T | Promise<T>) => Promise<T>
  /** Refresh configured backend instances before each immutable probe cycle. */
  beforeProbe?: () => void | Promise<void>
  probe?: (hints: ReadonlyMap<string, AgentEngine>) => Promise<TerminalAgentProbe>
  daemonPid?: number
}

function currentProcessKey(session: RegisteredSession): string | null {
  return session.processIdentity ? processIdentityKey(session.engine, session.processIdentity) : null
}

function sharesPlacement(
  current: Pick<RegisteredSession, 'runtimes'>,
  observed: Pick<DiscoveredTerminalAgent, 'runtimes'>,
): boolean {
  const placements = new Set(current.runtimes.map(terminalPlacementKey))
  return observed.runtimes.some((runtime) => placements.has(terminalPlacementKey(runtime)))
}

/**
 * A process-backed agent exists before an engine session does. During that interval the terminal route
 * is its stable identity: launchers are allowed to exec/fork into the real native binary while painting
 * a first-run prompt (Claude folder trust is the common case). Once a session binds, process identity is
 * authoritative again so a different process in the same pane cannot inherit an existing transcript.
 */
function unboundRouteOwner(
  current: readonly RegisteredSession[],
  observed: DiscoveredTerminalAgent,
): RegisteredSession | undefined {
  const matches = current.filter((candidate) => (
    !candidate.sessionId
    && candidate.engine === observed.engine
    && sharesPlacement(candidate, observed)
  ))
  return matches.length === 1 ? matches[0] : undefined
}

function unboundRouteObservation(
  current: RegisteredSession,
  observed: readonly DiscoveredTerminalAgent[],
): DiscoveredTerminalAgent | undefined {
  if (current.sessionId) return undefined
  const matches = observed.filter((candidate) => (
    candidate.engine === current.engine && sharesPlacement(current, candidate)
  ))
  return matches.length === 1 ? matches[0] : undefined
}

/** Serialized, failure-isolated reconciliation across every enabled backend instance. */
export class TerminalAgentReconciler {
  private readonly misses = new Map<string, number>()
  private readonly engineMisses = new Map<string, number>()
  private readonly suppressed = new Set<string>()
  private readonly hints = new Map<string, AgentEngine>()
  private pending = false
  private inFlight: Promise<void> | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly deps: TerminalAgentReconcilerDeps) {}

  async start(intervalMs: number): Promise<void> {
    await this.trigger()
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
      const before = this.deps.current()
      const current = before.find((candidate) => currentProcessKey(candidate) === key)
        ?? unboundRouteOwner(before, observed)
      if (current) await this.deps.onTerminalAvailability?.(current, true)
      if (current) await this.deps.onObserved(observed, current)
      else await this.deps.onDiscovered(observed)
      const after = this.deps.current()
      return after.find((candidate) => currentProcessKey(candidate) === key)
        ?? unboundRouteOwner(after, observed)
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
    const availableTargets = probe.targets.filter((target) => target.result.state === 'available')
    const livePlacements = new Set(availableTargets.flatMap((target) =>
      target.result.state === 'available'
        ? target.result.roots.map((root) => terminalPlacementKey(root.runtime))
        : []))
    const probeError = !probe.processTableAvailable
      ? 'process table unavailable'
      : probe.targets.length > 0 && availableTargets.length === 0
        ? probe.targets.map((target) => `${target.instanceId}: ${target.result.state === 'available' ? 'available' : target.result.reason}`).join('; ')
        : null
    // Terminal placement liveness does not depend on finding an engine process. This is what keeps a
    // retained trust/setup/shell pane visible after restart, including when `ps` itself is unavailable.
    const markVerifiedPlacements = async (): Promise<void> => {
      for (const current of this.deps.current()) {
        if (current.runtimes.some((runtime) => livePlacements.has(terminalPlacementKey(runtime)))) {
          await this.deps.onTerminalAvailability?.(current, true)
        }
      }
    }
    if (this.deps.transaction) await this.deps.transaction(markVerifiedPlacements)
    else await markVerifiedPlacements()
    if (!probe.processTableAvailable) {
      console.warn('[discovery] process table unavailable; keeping existing terminal agents')
      this.deps.onProbeStatus?.({ ready: true, error: probeError })
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
        const observed = (processKey ? observedByProcess.get(processKey) : undefined)
          ?? unboundRouteObservation(current, probe.agents)
        if (observed) matchedProcesses.add(processIdentityKey(observed.engine, observed.processIdentity))

        let nextRuntimes = current.runtimes
        let terminalVerified = current.runtimes.some((runtime) => livePlacements.has(terminalPlacementKey(runtime)))
        for (const runtime of current.runtimes) {
          const target = targetForRuntime(probe, runtime)
          if (!target || target.result.state !== 'available') continue
          const placement = terminalPlacementKey(runtime)
          const replacement = observed?.runtimes.find((candidate) => terminalPlacementKey(candidate) === placement)
          const missKey = `${current.agentId}\u0000${placement}`
          // Inventory is the authority for terminal existence. A live pane without a recognized engine
          // is a dormant but still viewable agent, not a missing runtime.
          if (livePlacements.has(placement)) {
            this.misses.delete(missKey)
            terminalVerified = true
            if (replacement) nextRuntimes = mergeTerminalRuntimes(nextRuntimes, [replacement])
            continue
          }
          if (probe.ambiguousPlacements.has(placement)) continue
          if (replacement) {
            this.misses.delete(missKey)
            nextRuntimes = mergeTerminalRuntimes(nextRuntimes, [replacement])
            terminalVerified = true
            continue
          }
          // The aggregate inventory/process snapshot is deliberately cheap, but it is not stronger
          // than a backend-specific check of this exact runtime and saved process identity. New-agent
          // creation already proved the pane this way; without the same fallback here, one snapshot
          // miss hid that freshly adopted agent on the very next reconciliation cycle even while its
          // Claude trust prompt remained alive in tmux.
          const backend = this.deps.backends.find((candidate) => candidate.instanceId === target.instanceId)
          if (backend && current.processIdentity) {
            const validation = await backend.validate(runtime, {
              engine: current.engine,
              // This check answers only whether the terminal placement still exists. Engine/process
              // identity is reconciled independently from the aggregate process snapshot below.
              processIdentity: undefined,
            }).catch((error: unknown) => ({
              state: 'unknown' as const,
              reason: error instanceof Error ? error.message : 'terminal validation failed',
            }))
            if (validation.state === 'alive') {
              this.misses.delete(missKey)
              terminalVerified = true
              continue
            }
            // A timeout/unreadable backend is not evidence that the process exited. Preserve both the
            // route and its active UI entry, just as a failed whole-process-table read does above.
            if (validation.state === 'unknown') continue
          }
          const misses = (this.misses.get(missKey) ?? 0) + 1
          if (misses < MISS_LIMIT) {
            this.misses.set(missKey, misses)
            continue
          }
          this.misses.delete(missKey)
          nextRuntimes = nextRuntimes.filter((candidate) => terminalPlacementKey(candidate) !== placement)
        }

        if (terminalVerified) await this.deps.onTerminalAvailability?.(current, true)
        if (observed) {
          this.engineMisses.delete(current.agentId)
        } else if (current.active && terminalVerified && !current.runtimes.some((runtime) =>
          probe.ambiguousPlacements.has(terminalPlacementKey(runtime)))) {
          const misses = (this.engineMisses.get(current.agentId) ?? 0) + 1
          if (misses >= MISS_LIMIT) {
            this.engineMisses.delete(current.agentId)
            await this.deps.onDormant(current, `engine process absent after ${MISS_LIMIT} confirmed scans`)
          } else {
            this.engineMisses.set(current.agentId, misses)
          }
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
        } else if (nextRuntimes.length < current.runtimes.length) {
          if (nextRuntimes.length === 0) {
            await this.deps.onTerminalAvailability?.(current, false)
            await this.deps.onRemoved(current, `terminal runtime absent after ${MISS_LIMIT} confirmed scans`)
          } else {
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
          }
        }
      }

      for (const observed of probe.agents) {
        const key = processIdentityKey(observed.engine, observed.processIdentity)
        if (!matchedProcesses.has(key)) await this.deps.onDiscovered(observed)
      }
    }

    if (this.deps.transaction) await this.deps.transaction(apply)
    else await apply()
    // Readiness is published last: clients must never observe ready=true between the inventory read and
    // the authoritative availability/registry update.
    this.deps.onProbeStatus?.({ ready: true, error: probeError })
  }
}
