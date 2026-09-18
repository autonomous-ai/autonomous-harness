import { describe, expect, it, vi } from 'vitest'
import { reconcileGridAttach, createGridAttachRunner, type GridAttachDeps, type GridAttachResult } from './gridAttach.js'
import type { GridHandoffResult } from './gridHandoff.js'
import type { EnsureResult } from './gridEnsure.js'

const NAME = 'someone-7f3a91c4'
const EMAIL = 'someone@autonomous.ai'

const OK_HANDOFF: GridHandoffResult = { code: 'OK', exitCode: 0, message: '', stdout: '', stderr: '' }
const MISSING_HANDOFF: GridHandoffResult = {
  code: 'GRID_CLI_MISSING', exitCode: 1, message: 'no grid', stdout: '', stderr: '',
}
const EXISTED: EnsureResult = { status: 'existed', message: '' }
const CREATED: EnsureResult = { status: 'created', message: '' }

/** Deps with every seam a no-op success, so a test overrides only the one it is about. */
function deps(over: Partial<GridAttachDeps> = {}): GridAttachDeps & {
  handoff: ReturnType<typeof vi.fn>
  ensure: ReturnType<typeof vi.fn>
  onName: ReturnType<typeof vi.fn>
} {
  const base = {
    managedGridReady: Promise.resolve(),
    gridAvailable: () => true,
    mintName: async () => NAME,
    accessToken: async () => 'tok',
    signedInEmail: () => EMAIL,
    gridNames: async () => [NAME],
    handoff: vi.fn(async () => OK_HANDOFF),
    ensure: vi.fn(async () => EXISTED),
    onName: vi.fn(),
    log: () => {},
  }
  return { ...base, ...over } as never
}

describe('reconcileGridAttach — the daemon-start convergence', () => {
  it('does nothing but publish the name when already signed in as the right account with the grid present', async () => {
    const d = deps()
    const r = await reconcileGridAttach(d)

    expect(r.status).toBe('converged')
    expect(r.name).toBe(NAME)
    expect(d.handoff).not.toHaveBeenCalled()
    expect(d.ensure).not.toHaveBeenCalled()
    expect(d.onName).toHaveBeenCalledWith(NAME)
  })

  it('re-signs in and ensures when the account name is not known locally (never created, or not synced here)', async () => {
    // The name is not in the local `grid ls`, so the machine cannot be proven to be set up — it
    // (re)signs in as this account and ensures the grid rather than acting on a weaker guess.
    const d = deps({ gridNames: async () => [], ensure: vi.fn(async () => CREATED) })
    const r = await reconcileGridAttach(d)

    expect(r.status).toBe('signed-in')
    expect(d.handoff).toHaveBeenCalledWith('tok')
    expect(d.ensure).toHaveBeenCalledWith(NAME)
    expect(d.onName).toHaveBeenCalledWith(NAME)
  })

  it('does not false-positive across two accounts sharing an email local-part', async () => {
    // Signed in to grid as `someone@personal` (grid `someone-11112222`) while the harness account is
    // `someone@company` (minted `someone-7f3a91c4`). The names differ, so the local `grid ls` does
    // NOT contain the harness account's name — this must overwrite, not skip.
    const d = deps({ signedInEmail: () => 'someone@personal.example', gridNames: async () => ['someone-11112222'] })
    const r = await reconcileGridAttach(d)

    expect(r.status).toBe('signed-in')
    expect(d.handoff).toHaveBeenCalledOnce()
    expect(d.ensure).toHaveBeenCalledWith(NAME)
  })

  it('hands the token over, then ensures, when this machine has no grid sign-in', async () => {
    const d = deps({ signedInEmail: () => null, gridNames: async () => [] })
    const r = await reconcileGridAttach(d)

    expect(r.status).toBe('signed-in')
    expect(d.handoff).toHaveBeenCalledWith('tok')
    expect(d.ensure).toHaveBeenCalledWith(NAME)
    expect(d.onName).toHaveBeenCalledWith(NAME)
  })

  it('overwrites a different account: signed in as someone else means a hand-off', async () => {
    // The signed-in email's pattern does not match the account's minted name.
    const d = deps({ signedInEmail: () => 'other@elsewhere.io', gridNames: async () => ['other-11112222'] })
    const r = await reconcileGridAttach(d)

    expect(r.status).toBe('signed-in')
    expect(d.handoff).toHaveBeenCalledOnce()
    expect(d.ensure).toHaveBeenCalledWith(NAME)
  })

  it('signs in again when the local grid list cannot be read — an unreadable registry is not "no grids"', async () => {
    const d = deps({ gridNames: async () => { throw new Error('grid ls exited 1') } })
    const r = await reconcileGridAttach(d)

    // It must NOT treat the failed read as proof of anything: the safe direction is to sign in
    // again, which rewrites the registry the next start reads.
    expect(r.status).toBe('signed-in')
    expect(d.handoff).toHaveBeenCalledOnce()
    expect(d.ensure).toHaveBeenCalledWith(NAME)
  })

  it('does nothing and reports no-cli when there is no grid binary', async () => {
    const d = deps({ gridAvailable: () => false, mintName: vi.fn() as never })
    const r = await reconcileGridAttach(d)

    expect(r.status).toBe('no-cli')
    expect(d.onName).not.toHaveBeenCalled()
    expect((d.mintName as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('stops at no-name on an older backend that mints none, without touching grid', async () => {
    const d = deps({ mintName: async () => null })
    const r = await reconcileGridAttach(d)

    expect(r.status).toBe('no-name')
    expect(d.handoff).not.toHaveBeenCalled()
    expect(d.ensure).not.toHaveBeenCalled()
    expect(d.onName).not.toHaveBeenCalled()
  })

  it('stops at no-name when the control plane is unreachable — and will try again next start', async () => {
    const d = deps({ mintName: async () => { throw new Error('ECONNREFUSED') } })
    const r = await reconcileGridAttach(d)

    expect(r.status).toBe('no-name')
    expect(r.detail).toContain('ECONNREFUSED')
    expect(d.handoff).not.toHaveBeenCalled()
  })

  it('reports handoff-failed without ensuring, leaving the harness sign-in untouched', async () => {
    const d = deps({ signedInEmail: () => null, handoff: vi.fn(async () => MISSING_HANDOFF) })
    const r = await reconcileGridAttach(d)

    expect(r.status).toBe('handoff-failed')
    expect(d.ensure).not.toHaveBeenCalled()
    expect(d.onName).not.toHaveBeenCalled()
  })

  it('waits for the managed grid runtime before checking the binary', async () => {
    const order: string[] = []
    let releaseRuntime = (): void => {}
    const runtime = new Promise<void>((res) => { releaseRuntime = () => { order.push('runtime'); res() } })
    const d = deps({
      managedGridReady: runtime,
      gridAvailable: () => { order.push('available'); return false },
    })

    const done = reconcileGridAttach(d)
    // The binary check must not have run before the runtime promise settled.
    await Promise.resolve()
    expect(order).toEqual([])
    releaseRuntime()
    await done
    expect(order).toEqual(['runtime', 'available'])
  })

  it('does not let a rejected runtime promise throw — a failed download is best-effort', async () => {
    const d = deps({ managedGridReady: Promise.reject(new Error('download failed')), gridAvailable: () => false })
    await expect(reconcileGridAttach(d)).resolves.toMatchObject({ status: 'no-cli' })
  })
})

/**
 * The coordination half: WHEN a reconcile runs. The daemon calls `run()` at start and again on every
 * backend reconnect, so every property here is about the interaction of those calls.
 */
describe('createGridAttachRunner — when a reconcile runs', () => {
  const result = (status: GridAttachResult['status']): GridAttachResult => ({ status, name: NAME, detail: '' })

  /** A clock the test moves by hand, so nothing here waits on real time. */
  function clock(start = 1_000_000) {
    let t = start
    return { now: () => t, advance: (ms: number) => { t += ms } }
  }

  function runner(over: Partial<Parameters<typeof createGridAttachRunner>[0]> = {}, c = clock()) {
    const attempt = vi.fn(async () => result('converged'))
    const logs: string[] = []
    const r = createGridAttachRunner({
      attempt,
      maxAttempts: 3,
      minIntervalMs: 1_000,
      ceilingMs: 5_000,
      now: c.now,
      log: (line) => logs.push(line),
      ...over,
    })
    return { r, attempt: (over.attempt ?? attempt) as ReturnType<typeof vi.fn>, logs, clock: c }
  }

  it('runs once and stops once attached — a later reconnect costs nothing', async () => {
    const { r, attempt, clock: c } = runner()

    r.run()
    await r.probe()
    expect(attempt).toHaveBeenCalledOnce()

    c.advance(10_000) // well past the interval, so only "already attached" can stop a second run
    r.run()
    expect(attempt).toHaveBeenCalledOnce()
  })

  it('does not overlap: a reconnect during an in-flight attempt is a no-op', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((res) => { release = res })
    const attempt = vi.fn(async () => { await gate; return result('converged') })
    const { r, clock: c } = runner({ attempt })

    r.run()
    c.advance(10_000)
    r.run()
    r.run()
    expect(attempt).toHaveBeenCalledOnce()

    release()
    await r.probe()
    expect(attempt).toHaveBeenCalledOnce()
  })

  it('retries after an attempt that did not attach, once the interval has passed', async () => {
    const attempt = vi.fn(async () => result('no-name'))
    const { r, clock: c } = runner({ attempt })

    r.run()
    await r.probe()
    expect(attempt).toHaveBeenCalledOnce()

    c.advance(1_000)
    r.run()
    await r.probe()
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  it('collapses a burst of reconnects into ONE deferred attempt instead of burning the budget', async () => {
    vi.useFakeTimers()
    try {
      const attempt = vi.fn(async () => result('no-name'))
      // A real clock is not advanced by fake timers, so the runner reads the same injected one.
      const c = clock()
      const { r } = runner({ attempt }, c)

      r.run()
      await r.probe()
      expect(attempt).toHaveBeenCalledTimes(1)

      // Waking a laptop: several reconnects inside the interval. None may start an attempt, and
      // together they must cost exactly one — the whole point of deferring rather than dropping.
      for (let i = 0; i < 5; i++) r.run()
      expect(attempt).toHaveBeenCalledTimes(1)
      expect(r.attempts()).toBe(1)

      c.advance(1_000)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(attempt).toHaveBeenCalledTimes(2)
      // Four attempts' worth of churn cost one, so the cap of 3 is not spent.
      expect(r.attempts()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up out loud at the cap, and says it only once', async () => {
    const attempt = vi.fn(async () => result('no-name'))
    const { r, logs, clock: c } = runner({ attempt })

    for (let i = 0; i < 3; i++) {
      c.advance(1_000)
      r.run()
      await r.probe()
    }
    expect(attempt).toHaveBeenCalledTimes(3)

    c.advance(1_000)
    r.run()
    c.advance(1_000)
    r.run()
    expect(attempt).toHaveBeenCalledTimes(3)
    expect(logs.filter((l) => l.includes('giving up'))).toHaveLength(1)
  })

  it('a rejected attempt is logged and retried, never thrown', async () => {
    const attempt = vi.fn(async () => { throw new Error('boom') })
    const { r, logs, clock: c } = runner({ attempt })

    expect(() => r.run()).not.toThrow()
    await r.probe()
    expect(logs.some((l) => l.includes('boom'))).toBe(true)

    c.advance(1_000)
    r.run()
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  it('probe stops offering the attempt once its ceiling passes, so an RPC never waits on a stuck one', async () => {
    const attempt = vi.fn(async () => new Promise<GridAttachResult>(() => {})) // never settles
    const { r, clock: c } = runner({ attempt })

    r.run()
    expect(r.probe()).not.toBeNull()
    c.advance(5_000)
    expect(r.probe()).toBeNull()
  })
})
