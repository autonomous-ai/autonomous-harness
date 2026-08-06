import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DisposableOneShotPool,
  poolTargetForActiveSessions,
  type DisposableWorker,
  type OneShotEngine,
} from './disposableOneShotPool.js'

type Result = { workerId: number; engine: OneShotEngine }

class FakeWorker implements DisposableWorker<string, Result> {
  readonly createdAt = Date.now()
  private alive = true
  private used = false
  private readonly listeners = new Set<() => void>()

  constructor(readonly engine: OneShotEngine, readonly id: number) {}

  isAlive(): boolean { return this.alive }
  onExit(listener: () => void): void { this.listeners.add(listener) }
  async run(_options: string): Promise<Result> {
    if (this.used) throw new Error('worker reused')
    this.used = true
    return { workerId: this.id, engine: this.engine }
  }
  dispose(): void { this.alive = false }
  crash(): void {
    this.alive = false
    for (const listener of this.listeners) listener()
  }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => vi.useRealTimers())

describe('DisposableOneShotPool', () => {
  it('sizes each active engine independently at ceil(active / 3), minimum one', () => {
    expect([0, 1, 2, 3, 4, 6, 7].map(poolTargetForActiveSessions)).toEqual([0, 1, 1, 1, 2, 2, 3])
  })

  it('consumes a ready worker once and immediately replenishes that engine', async () => {
    let id = 0
    const created: FakeWorker[] = []
    const pool = new DisposableOneShotPool<string, Result>(async (engine) => {
      const worker = new FakeWorker(engine, ++id)
      created.push(worker)
      return worker
    }, 300_000, () => {})

    pool.setActiveCounts({ claude: 4, codex: 1, cursor: 2, opencode: 0, pi: 0, commandcode: 0 })
    pool.setDeviceConnected(true)
    await settle()
    expect(pool.snapshot()).toMatchObject({
      claude: { target: 2, ready: 2 },
      codex: { target: 1, ready: 1 },
      cursor: { target: 1, ready: 1 },
    })

    const first = await pool.run('claude', 'recap A')
    await settle()
    const second = await pool.run('claude', 'recap B')
    await settle()

    expect(first.engine).toBe('claude')
    expect(second.engine).toBe('claude')
    expect(second.workerId).not.toBe(first.workerId)
    expect(created.filter((worker) => worker.engine === 'codex')).toHaveLength(1)
    expect(created.filter((worker) => worker.engine === 'cursor')).toHaveLength(1)
    expect(pool.snapshot().claude).toMatchObject({ target: 2, ready: 2 })
    pool.shutdown()
  })

  it('cold-spawns immediately instead of waiting for a pooled worker that is still starting', async () => {
    const deferred: { resolve?: (worker: FakeWorker) => void } = {}
    let calls = 0
    const pool = new DisposableOneShotPool<string, Result>((engine) => {
      calls++
      if (calls === 1) return new Promise((resolve) => { deferred.resolve = resolve })
      return Promise.resolve(new FakeWorker(engine, calls))
    }, 300_000, () => {})

    pool.setActiveCounts({ claude: 1, codex: 0, cursor: 0, opencode: 0, pi: 0, commandcode: 0 })
    pool.setDeviceConnected(true)
    expect(pool.snapshot().claude.starting).toBe(1)

    await expect(pool.run('claude', 'cold')).resolves.toEqual({ workerId: 2, engine: 'claude' })
    expect(calls).toBe(2)
    deferred.resolve?.(new FakeWorker('claude', 1))
    await settle()
    expect(pool.snapshot().claude).toMatchObject({ target: 1, starting: 0, ready: 1 })
    pool.shutdown()
  })

  it('keeps workers for five minutes after device disconnect and cancels grace on reconnect', async () => {
    vi.useFakeTimers()
    let id = 0
    const pool = new DisposableOneShotPool<string, Result>(
      async (engine) => new FakeWorker(engine, ++id),
      5 * 60_000,
      () => {},
    )
    pool.setActiveCounts({ claude: 1, codex: 0, cursor: 0, opencode: 0, pi: 0, commandcode: 0 })
    pool.setDeviceConnected(true)
    await settle()

    pool.setDeviceConnected(false)
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    expect(pool.snapshot()).toMatchObject({ enabled: true, connected: false, claude: { ready: 1 } })

    pool.setDeviceConnected(true)
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(pool.snapshot()).toMatchObject({ enabled: true, connected: true, claude: { ready: 1 } })

    pool.setDeviceConnected(false)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(pool.snapshot()).toMatchObject({ enabled: false, connected: false, claude: { target: 0, ready: 0 } })
    pool.shutdown()
  })

  it('replenishes an idle worker crash with backoff', async () => {
    vi.useFakeTimers()
    const created: FakeWorker[] = []
    const pool = new DisposableOneShotPool<string, Result>(async (engine) => {
      const worker = new FakeWorker(engine, created.length + 1)
      created.push(worker)
      return worker
    }, 300_000, () => {})
    pool.setActiveCounts({ claude: 1, codex: 0, cursor: 0, opencode: 0, pi: 0, commandcode: 0 })
    pool.setDeviceConnected(true)
    await settle()
    expect(created).toHaveLength(1)

    created[0].crash()
    expect(pool.snapshot().claude.ready).toBe(0)
    await vi.advanceTimersByTimeAsync(999)
    expect(created).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(created).toHaveLength(2)
    expect(pool.snapshot().claude.ready).toBe(1)
    pool.shutdown()
  })

  it('never hands out a warm worker that has aged past its idle ceiling', async () => {
    vi.useFakeTimers()
    let id = 0
    const created: FakeWorker[] = []
    const pool = new DisposableOneShotPool<string, Result>(
      async (engine) => {
        const worker = new FakeWorker(engine, ++id)
        created.push(worker)
        return worker
      },
      300_000,
      () => {},
      60_000, // idle ceiling
    )

    pool.setActiveCounts({ claude: 1, codex: 0, cursor: 0, opencode: 0, pi: 0, commandcode: 0 })
    pool.setDeviceConnected(true)
    await settle()
    expect(pool.snapshot()).toMatchObject({ claude: { ready: 1 } })
    const stale = created[0]

    // Past the ceiling: the parked process is a leak and its model session is cold.
    await vi.advanceTimersByTimeAsync(61_000)
    const result = await pool.run('claude', 'prompt')

    expect(stale.isAlive()).toBe(false)
    expect(result.workerId).not.toBe(stale.id)
    pool.shutdown()
  })

  it('retires an idle warm worker on its own, with no recap to trigger it', async () => {
    // The leak in the field: nobody asked for a recap for over an hour, so nothing ever looked at
    // the pool, and a warm worker sat on its stdin the whole time.
    vi.useFakeTimers()
    let id = 0
    const created: FakeWorker[] = []
    const pool = new DisposableOneShotPool<string, Result>(
      async (engine) => {
        const worker = new FakeWorker(engine, ++id)
        created.push(worker)
        return worker
      },
      300_000,
      () => {},
      60_000,
    )

    pool.setActiveCounts({ claude: 1, codex: 0, cursor: 0, opencode: 0, pi: 0, commandcode: 0 })
    pool.setDeviceConnected(true)
    await settle()
    const first = created[0]

    await vi.advanceTimersByTimeAsync(90_000)

    expect(first.isAlive()).toBe(false)
    // Replaced, not merely dropped: the pool still owes its target a warm worker.
    expect(pool.snapshot()).toMatchObject({ claude: { ready: 1 } })
    expect(created.length).toBeGreaterThan(1)
    pool.shutdown()
  })
})
