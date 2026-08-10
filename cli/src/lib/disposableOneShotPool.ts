export type OneShotEngine = 'claude' | 'codex' | 'cursor' | 'opencode' | 'pi' | 'commandcode' | 'kilo'

const ONE_SHOT_ENGINES: readonly OneShotEngine[] = ['claude', 'codex', 'cursor', 'opencode', 'pi', 'commandcode', 'kilo']

export interface DisposableWorker<Options, Result> {
  readonly engine: OneShotEngine
  readonly createdAt: number
  isAlive(): boolean
  run(options: Options): Promise<Result>
  dispose(): void
  onExit(listener: () => void): void
}

export type ActiveEngineCounts = Record<OneShotEngine, number>

export function poolTargetForActiveSessions(active: number): number {
  if (!Number.isFinite(active) || active <= 0) return 0
  return Math.max(1, Math.ceil(active / 3))
}

interface EngineState<Options, Result> {
  active: number
  target: number
  starting: number
  ready: Set<DisposableWorker<Options, Result>>
  retryTimer: NodeJS.Timeout | null
}

export interface PoolSnapshot {
  enabled: boolean
  connected: boolean
  claude: { active: number; target: number; starting: number; ready: number }
  codex: { active: number; target: number; starting: number; ready: number }
  cursor: { active: number; target: number; starting: number; ready: number }
  opencode: { active: number; target: number; starting: number; ready: number }
  pi: { active: number; target: number; starting: number; ready: number }
  commandcode: { active: number; target: number; starting: number; ready: number }
  kilo: { active: number; target: number; starting: number; ready: number }
}

/** Maintains disposable, pre-spawned workers. A checked-out worker is never returned to the pool. */
export class DisposableOneShotPool<Options, Result> {
  private readonly states: Record<OneShotEngine, EngineState<Options, Result>> = {
    claude: { active: 0, target: 0, starting: 0, ready: new Set(), retryTimer: null },
    codex: { active: 0, target: 0, starting: 0, ready: new Set(), retryTimer: null },
    cursor: { active: 0, target: 0, starting: 0, ready: new Set(), retryTimer: null },
    opencode: { active: 0, target: 0, starting: 0, ready: new Set(), retryTimer: null },
    pi: { active: 0, target: 0, starting: 0, ready: new Set(), retryTimer: null },
    commandcode: { active: 0, target: 0, starting: 0, ready: new Set(), retryTimer: null },
    kilo: { active: 0, target: 0, starting: 0, ready: new Set(), retryTimer: null },
  }
  private readonly all = new Set<DisposableWorker<Options, Result>>()
  private connected = false
  private enabled = false
  private closed = false
  private generation = 0
  private unwarmTimer: NodeJS.Timeout | null = null
  private sweepTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly factory: (engine: OneShotEngine) => Promise<DisposableWorker<Options, Result>>,
    private readonly graceMs = 5 * 60_000,
    private readonly log: (line: string) => void = (line) => console.log(line),
    /** How long a warm worker may sit unused before it is replaced. A pooled worker is a real
     *  process parked on its stdin: with no ceiling it survives for as long as the adapter does.
     *  One was observed being handed out after 84 minutes, and another idling for 94 — a leak, and
     *  a stale model session for whoever eventually got it. `run()`'s timeout cannot help here; it
     *  only arms once a worker is assigned work. */
    private readonly maxIdleMs = 10 * 60_000,
  ) {}

  setActiveCounts(counts: ActiveEngineCounts): void {
    for (const engine of ONE_SHOT_ENGINES) {
      this.states[engine].active = Math.max(0, Math.floor(counts[engine] || 0))
    }
    this.reconcileAll()
  }

  setDeviceConnected(connected: boolean): void {
    if (this.closed) return
    this.connected = connected
    if (this.unwarmTimer) {
      clearTimeout(this.unwarmTimer)
      this.unwarmTimer = null
    }
    if (connected) {
      this.enabled = true
      this.startSweep()
      this.reconcileAll()
      return
    }
    if (!this.enabled) return
    this.unwarmTimer = setTimeout(() => {
      this.unwarmTimer = null
      if (this.connected || this.closed) return
      this.enabled = false
      this.reconcileAll()
      this.log('[recap-pool] device grace expired · unwarmed')
    }, this.graceMs)
  }

  async run(engine: OneShotEngine, options: Options): Promise<Result> {
    const state = this.states[engine]
    let worker: DisposableWorker<Options, Result> | undefined
    for (const candidate of state.ready) {
      state.ready.delete(candidate)
      if (candidate.isAlive() && !this.expired(candidate)) { worker = candidate; break }
      if (candidate.isAlive()) this.log(`[recap-pool] ${engine} dropped a stale warm worker · age=${Date.now() - candidate.createdAt}ms`)
      candidate.dispose()
      this.all.delete(candidate)
    }

    const hit = !!worker
    // The direct worker used by a miss is busy, not pool capacity. Refill the ready target now so a
    // concurrent recap can still hit a warm worker instead of waiting for this one to finish.
    this.reconcile(engine)
    const selected = worker ?? await this.createWorker(engine)

    const age = Date.now() - selected.createdAt
    this.log(`[recap-pool] ${engine} ${hit ? 'hit' : 'miss'} · workerAge=${age}ms · ready=${state.ready.size}/${state.target}`)
    try {
      return await selected.run(options)
    } finally {
      selected.dispose()
      this.all.delete(selected)
      this.reconcile(engine)
    }
  }

  /** Drop idle workers after a runtime config/model change; in-flight work remains isolated. */
  recycleReady(): void {
    this.generation++
    for (const engine of ONE_SHOT_ENGINES) {
      const state = this.states[engine]
      for (const worker of state.ready) worker.dispose()
      state.ready.clear()
    }
    this.reconcileAll()
  }

  shutdown(): void {
    if (this.closed) return
    this.closed = true
    this.enabled = false
    if (this.unwarmTimer) clearTimeout(this.unwarmTimer)
    this.unwarmTimer = null
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
    for (const worker of this.all) worker.dispose()
    this.all.clear()
    for (const engine of ONE_SHOT_ENGINES) {
      if (this.states[engine].retryTimer) clearTimeout(this.states[engine].retryTimer)
      this.states[engine].retryTimer = null
      this.states[engine].ready.clear()
      this.states[engine].target = 0
    }
  }

  snapshot(): PoolSnapshot {
    const item = (engine: OneShotEngine) => {
      const s = this.states[engine]
      return { active: s.active, target: s.target, starting: s.starting, ready: s.ready.size }
    }
    return {
      enabled: this.enabled,
      connected: this.connected,
      claude: item('claude'),
      codex: item('codex'),
      cursor: item('cursor'),
      opencode: item('opencode'),
      pi: item('pi'),
      commandcode: item('commandcode'),
      kilo: item('kilo'),
    }
  }

  private expired(worker: DisposableWorker<Options, Result>): boolean {
    return this.maxIdleMs > 0 && Date.now() - worker.createdAt >= this.maxIdleMs
  }

  /** Retire warm workers that have aged out. Runs on its own timer, because a pool nobody asks for
   *  a recap from is exactly the case where they would otherwise sit forever. */
  private sweepExpired(): void {
    for (const engine of ONE_SHOT_ENGINES) {
      const state = this.states[engine]
      for (const worker of [...state.ready]) {
        if (!this.expired(worker)) continue
        state.ready.delete(worker)
        worker.dispose()
        this.all.delete(worker)
        this.log(`[recap-pool] ${engine} retired an idle warm worker · age=${Date.now() - worker.createdAt}ms`)
      }
    }
    this.reconcileAll()
  }

  private startSweep(): void {
    if (this.sweepTimer || this.closed || this.maxIdleMs <= 0) return
    this.sweepTimer = setInterval(() => this.sweepExpired(), Math.max(1_000, Math.floor(this.maxIdleMs / 4)))
    // Never a reason to hold the process open for this.
    this.sweepTimer.unref?.()
  }

  private reconcileAll(): void {
    for (const engine of ONE_SHOT_ENGINES) this.reconcile(engine)
  }

  private reconcile(engine: OneShotEngine): void {
    if (this.closed) return
    const state = this.states[engine]
    const previousTarget = state.target
    state.target = this.enabled ? poolTargetForActiveSessions(state.active) : 0
    if (state.target !== previousTarget) {
      this.log(`[recap-pool] ${engine} target ${previousTarget}→${state.target} · active=${state.active}`)
    }

    if (state.target === 0 && state.retryTimer) {
      clearTimeout(state.retryTimer)
      state.retryTimer = null
    }

    while (state.ready.size > state.target) {
      const worker = state.ready.values().next().value as DisposableWorker<Options, Result> | undefined
      if (!worker) break
      state.ready.delete(worker)
      worker.dispose()
      this.all.delete(worker)
    }
    while (!state.retryTimer && state.ready.size + state.starting < state.target) this.spawnPooled(engine)
  }

  private spawnPooled(engine: OneShotEngine): void {
    const state = this.states[engine]
    const generation = this.generation
    state.starting++
    void this.createWorker(engine)
      .then((worker) => {
        state.starting--
        if (generation !== this.generation || this.closed || !this.enabled || state.ready.size >= state.target || !worker.isAlive()) {
          worker.dispose()
          this.all.delete(worker)
          if (!this.closed && this.enabled && state.ready.size < state.target) this.scheduleRetry(engine)
        } else {
          state.ready.add(worker)
          this.log(`[recap-pool] ${engine} warm ready=${state.ready.size}/${state.target}`)
          this.reconcile(engine)
        }
      })
      .catch((err) => {
        state.starting--
        this.log(`[recap-pool] ${engine} warm spawn failed: ${err instanceof Error ? err.message : String(err)}`)
        this.scheduleRetry(engine)
      })
  }

  private async createWorker(engine: OneShotEngine): Promise<DisposableWorker<Options, Result>> {
    const worker = await this.factory(engine)
    this.all.add(worker)
    worker.onExit(() => {
      this.all.delete(worker)
      const wasReady = this.states[engine].ready.delete(worker)
      if (wasReady) this.scheduleRetry(engine)
    })
    if (this.closed) {
      worker.dispose()
      this.all.delete(worker)
      throw new Error('recap pool shut down while worker was starting')
    }
    return worker
  }

  private scheduleRetry(engine: OneShotEngine): void {
    const state = this.states[engine]
    if (this.closed || !this.enabled || state.target === 0 || state.retryTimer) return
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null
      this.reconcile(engine)
    }, 1000)
  }
}
