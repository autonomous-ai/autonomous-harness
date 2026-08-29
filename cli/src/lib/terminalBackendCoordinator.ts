import type { RegisteredSession } from './registry.js'
import type { TerminalBackend } from './terminalBackend.js'
import { processIdentityKey, terminalInstanceId, terminalPlacementKey, terminalRouteKey } from './terminalRuntime.js'
import {
  terminalActionNotStarted,
  type RuntimeValidation,
  type TerminalActionResult,
  type TerminalCaptureOptions,
  type TerminalLogicalKey,
  type TerminalReadResult,
  type TerminalRuntimeRef,
  type TerminalStreamHandle,
  type TerminalStreamSink,
  type TerminalStreamSize,
} from './terminalTypes.js'

export interface TerminalControlLease {
  agentId: string
  runtime: TerminalRuntimeRef
  placementKey: string
  generation: string
}

function primaryPlacement(session: Pick<RegisteredSession, 'runtimes' | 'primaryRuntimeKey'>): string {
  const primary = session.runtimes.find((runtime) => terminalRouteKey(runtime) === session.primaryRuntimeKey)
  return primary ? terminalPlacementKey(primary) : ''
}

function runtimeGeneration(session: Pick<RegisteredSession, 'engine' | 'processIdentity' | 'runtimes' | 'primaryRuntimeKey'>): string {
  const process = session.processIdentity ? processIdentityKey(session.engine, session.processIdentity) : ''
  return `${process}\u0000${primaryPlacement(session)}\u0000${session.runtimes.map(terminalPlacementKey).sort().join('\u0001')}`
}

const LEGACY_KEYS: Record<string, TerminalLogicalKey> = {
  Enter: 'enter', Escape: 'escape', Tab: 'tab', BTab: 'backtab', Up: 'up', Down: 'down', Left: 'left', Right: 'right',
  Home: 'home', End: 'end', BSpace: 'backspace', DC: 'delete', PPage: 'pageup', NPage: 'pagedown',
  'C-c': 'ctrl-c', 'C-d': 'ctrl-d', 'C-u': 'ctrl-u', 'C-w': 'ctrl-w', Space: 'space',
  '0': '0', '1': '1', '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8', '9': '9',
}

export function terminalLogicalKey(key: string): TerminalLogicalKey | null {
  return LEGACY_KEYS[key] ?? null
}

/** Resolves all terminal I/O through validated backend-scoped locators. */
export class TerminalBackendCoordinator {
  private readonly byInstance = new Map<string, TerminalBackend>()

  constructor(
    backends: readonly TerminalBackend[],
    private readonly backendOrder: readonly string[],
    private herdrSessionOrder: readonly string[],
  ) {
    this.replaceBackends(backends)
  }

  replaceBackends(backends: readonly TerminalBackend[]): void {
    this.byInstance.clear()
    for (const backend of backends) this.byInstance.set(backend.instanceId, backend)
  }

  /**
   * The session order is only a deterministic tie-break between two runtimes of the same backend, but it
   * has to track discovery: with sessions adopted as they start, the set is no longer fixed at boot.
   */
  setHerdrSessionOrder(order: readonly string[]): void {
    this.herdrSessionOrder = order
  }

  instances(): TerminalBackend[] {
    return [...this.byInstance.values()]
  }

  async titles(): Promise<Map<string, string>> {
    const snapshots = await Promise.all(this.instances().map((backend) =>
      backend.titles().catch(() => ({ state: 'failed' as const, reason: 'terminal title snapshot failed' }))))
    const titles = new Map<string, string>()
    for (const snapshot of snapshots) {
      if (snapshot.state !== 'succeeded') continue
      for (const [route, title] of snapshot.value) titles.set(route, title)
    }
    return titles
  }

  titleFor(session: RegisteredSession, titles: ReadonlyMap<string, string>): string | undefined {
    for (const runtime of this.orderedRuntimes(session)) {
      const title = titles.get(terminalRouteKey(runtime))
      if (title) return title
    }
    return undefined
  }

  backendFor(runtime: TerminalRuntimeRef): TerminalBackend | undefined {
    return this.byInstance.get(terminalInstanceId(runtime))
  }

  private orderedRuntimes(session: RegisteredSession): TerminalRuntimeRef[] {
    const configured = session.runtimes.filter((runtime) => this.backendFor(runtime))
    return configured.toSorted((a, b) => {
      const aPrimary = terminalRouteKey(a) === session.primaryRuntimeKey
      const bPrimary = terminalRouteKey(b) === session.primaryRuntimeKey
      if (aPrimary !== bPrimary) return aPrimary ? -1 : 1
      const ab = this.backendOrder.indexOf(a.backend)
      const bb = this.backendOrder.indexOf(b.backend)
      if (ab !== bb) return (ab < 0 ? Number.MAX_SAFE_INTEGER : ab) - (bb < 0 ? Number.MAX_SAFE_INTEGER : bb)
      if (a.backend === 'herdr' && b.backend === 'herdr') {
        return this.herdrSessionOrder.indexOf(a.sessionName) - this.herdrSessionOrder.indexOf(b.sessionName)
      }
      return terminalRouteKey(a).localeCompare(terminalRouteKey(b))
    })
  }

  async validate(session: RegisteredSession): Promise<RuntimeValidation> {
    if (!session.active) return { state: 'gone', reason: 'terminal agent is dormant' }
    let unknown: RuntimeValidation | null = null
    for (const runtime of this.orderedRuntimes(session)) {
      const backend = this.backendFor(runtime)!
      const result = await backend.validate(runtime, {
        engine: session.engine,
        processIdentity: session.processIdentity ?? undefined,
      })
      if (result.state === 'alive') return result
      if (result.state === 'unknown') unknown = result
    }
    return unknown ?? { state: 'gone', reason: 'no configured terminal runtime is alive' }
  }

  async acquireLease(session: RegisteredSession): Promise<TerminalReadResult<TerminalControlLease>> {
    if (!session.active) return { state: 'failed', reason: 'terminal agent is dormant' }
    for (const runtime of this.orderedRuntimes(session)) {
      const backend = this.backendFor(runtime)!
      const validation = await backend.validate(runtime, {
        engine: session.engine,
        processIdentity: session.processIdentity ?? undefined,
      })
      if (validation.state === 'alive') {
        return {
          state: 'succeeded',
          value: {
            agentId: session.agentId,
            runtime,
            placementKey: terminalPlacementKey(runtime),
            generation: runtimeGeneration(session),
          },
        }
      }
    }
    return { state: 'failed', reason: 'no terminal runtime could be leased' }
  }

  leaseIsCurrent(lease: TerminalControlLease, session: RegisteredSession): boolean {
    if (lease.agentId !== session.agentId || lease.generation !== runtimeGeneration(session)) return false
    const current = session.runtimes.find((runtime) => terminalPlacementKey(runtime) === lease.placementKey)
    if (!current) return false
    // Herdr's pane route is mutable. Refresh it under the stable endpoint + terminal placement rather
    // than splitting a pinned interaction across a different placement.
    lease.runtime = current
    return true
  }

  async validateLease(lease: TerminalControlLease, session: RegisteredSession): Promise<boolean> {
    if (!this.leaseIsCurrent(lease, session)) return false
    const backend = this.backendFor(lease.runtime)
    if (!backend) return false
    return (await backend.validate(lease.runtime, {
      engine: session.engine,
      processIdentity: session.processIdentity ?? undefined,
    })).state === 'alive'
  }

  async capture(session: RegisteredSession, options?: TerminalCaptureOptions): Promise<TerminalReadResult<string>> {
    if (!session.active) return { state: 'failed', reason: 'terminal agent is dormant' }
    let reason = 'no configured terminal runtime is available'
    for (const runtime of this.orderedRuntimes(session)) {
      const result = await this.backendFor(runtime)!.capture(runtime, options)
      if (result.state === 'succeeded') return result
      reason = result.reason
    }
    return { state: 'failed', reason }
  }

  async captureLease(lease: TerminalControlLease, options?: TerminalCaptureOptions): Promise<TerminalReadResult<string>> {
    const backend = this.backendFor(lease.runtime)
    return backend ? backend.capture(lease.runtime, options) : { state: 'failed', reason: 'leased terminal backend is disabled' }
  }

  /** Open a byte stream on the first validated streaming-capable runtime. MVP deliberately skips Herdr. */
  async openStream(
    session: RegisteredSession,
    size: TerminalStreamSize,
    sink: TerminalStreamSink,
  ): Promise<TerminalReadResult<TerminalStreamHandle>> {
    // `active` describes whether the engine process was discovered, not whether the retained
    // terminal runtime is still viewable. A dormant agent can legitimately be waiting at setup,
    // trust, or a shell prompt. Let each backend authoritatively check whether its pane still
    // exists. Engine-targeted operations (capture, leases, and submit helpers) keep their active
    // guards elsewhere in this coordinator; the opened stream may still carry raw terminal input.
    let reason = 'TERMINAL_RUNTIME_UNAVAILABLE'
    for (const runtime of this.orderedRuntimes(session)) {
      const backend = this.backendFor(runtime)
      if (!backend?.openStream) continue
      const result = await backend.openStream(runtime, {
        engine: session.engine,
        processIdentity: session.processIdentity ?? undefined,
      }, size, sink)
      if (result.state === 'succeeded') return result as TerminalReadResult<TerminalStreamHandle>
      reason = result.reason
    }
    return { state: 'failed', reason }
  }

  typeLiteralLease(lease: TerminalControlLease, text: string): Promise<TerminalActionResult> {
    const backend = this.backendFor(lease.runtime)
    return backend
      ? backend.typeLiteral(lease.runtime, text)
      : Promise.resolve(terminalActionNotStarted('leased terminal backend is disabled'))
  }

  submitTextLease(lease: TerminalControlLease, text: string): Promise<TerminalActionResult> {
    const backend = this.backendFor(lease.runtime)
    return backend
      ? backend.submitText(lease.runtime, text)
      : Promise.resolve(terminalActionNotStarted('leased terminal backend is disabled'))
  }

  /** Single-operation lease dispatch with exact-once-safe fallback to another validated locator. */
  async submitTextForLease(
    session: RegisteredSession,
    lease: TerminalControlLease,
    text: string,
  ): Promise<TerminalActionResult> {
    if (!this.leaseIsCurrent(lease, session)) return terminalActionNotStarted('terminal control lease changed')
    const ordered = this.orderedRuntimes(session)
    const candidates = [
      lease.runtime,
      ...ordered.filter((runtime) => terminalPlacementKey(runtime) !== lease.placementKey),
    ]
    let last: TerminalActionResult = terminalActionNotStarted('no configured terminal runtime is available')
    for (const runtime of candidates) {
      const backend = this.backendFor(runtime)
      if (!backend) continue
      const validation = await backend.validate(runtime, {
        engine: session.engine,
        processIdentity: session.processIdentity ?? undefined,
      })
      if (validation.state !== 'alive') continue
      const result = await backend.submitText(runtime, text)
      if (result.state === 'succeeded') {
        lease.runtime = runtime
        lease.placementKey = terminalPlacementKey(runtime)
        return result
      }
      if (result.dispatch === 'possibly_executed') return result
      last = result
      if (result.dispatch !== 'not_started' && result.dispatch !== 'rejected') return result
    }
    return last
  }

  sendLegacyKeyLease(lease: TerminalControlLease, key: string): Promise<TerminalActionResult> {
    const backend = this.backendFor(lease.runtime)
    const logical = terminalLogicalKey(key)
    return backend && logical
      ? backend.sendKey(lease.runtime, logical)
      : Promise.resolve(terminalActionNotStarted(backend
        ? 'unsupported logical terminal key'
        : 'leased terminal backend is disabled'))
  }

  private async sideEffect(
    session: RegisteredSession,
    action: (backend: TerminalBackend, runtime: TerminalRuntimeRef) => Promise<TerminalActionResult>,
  ): Promise<TerminalActionResult> {
    if (!session.active) return terminalActionNotStarted('terminal agent is dormant')
    let last: TerminalActionResult = terminalActionNotStarted('no configured terminal runtime is available')
    for (const runtime of this.orderedRuntimes(session)) {
      const backend = this.backendFor(runtime)!
      const validation = await backend.validate(runtime, {
        engine: session.engine,
        processIdentity: session.processIdentity ?? undefined,
      })
      if (validation.state !== 'alive') continue
      const result = await action(backend, runtime)
      if (result.state === 'succeeded' || result.dispatch === 'possibly_executed') return result
      last = result
      // Only proven pre-dispatch or explicit server rejection may use another validated locator.
      if (result.dispatch !== 'not_started' && result.dispatch !== 'rejected') return result
    }
    return last
  }

  submitText(session: RegisteredSession, text: string): Promise<TerminalActionResult> {
    return this.sideEffect(session, (backend, runtime) => backend.submitText(runtime, text))
  }

  typeLiteral(session: RegisteredSession, text: string): Promise<TerminalActionResult> {
    return this.sideEffect(session, (backend, runtime) => backend.typeLiteral(runtime, text))
  }

  sendKey(session: RegisteredSession, key: TerminalLogicalKey): Promise<TerminalActionResult> {
    return this.sideEffect(session, (backend, runtime) => backend.sendKey(runtime, key))
  }

  sendLegacyKey(session: RegisteredSession, key: string): Promise<TerminalActionResult> {
    const logical = terminalLogicalKey(key)
    return logical ? this.sendKey(session, logical) : Promise.resolve(terminalActionNotStarted('unsupported logical terminal key'))
  }

  setTitle(session: RegisteredSession, title: string): Promise<TerminalActionResult> {
    return this.sideEffect(session, (backend, runtime) => backend.setTitle(runtime, title))
  }

  notify(session: RegisteredSession, title: string, body: string): Promise<TerminalActionResult> {
    return this.sideEffect(session, (backend, runtime) => backend.notify(runtime, title, body))
  }
}
