import { describe, expect, it } from 'vitest'
import { terminateDeletedAgent, type TerminateDeps } from './deleteAgentFallback.js'
import type { RegisteredSession } from './registry.js'

/**
 * The one place in the adapter that signals somebody else's process. Everything here is about NOT hitting
 * the wrong target and NOT going quiet when it fails: by the time this runs the UI already told the user
 * the agent is gone, so an unreported failure leaves a running engine nothing accounts for.
 */

const SESSION = {
  sessionId: 's1',
  engine: 'claude',
  tmuxPane: '%3',
  processIdentity: { pid: 4242, executable: 'claude', startMarker: 'Mon Aug  3 09:00:00 2026' },
} as unknown as RegisteredSession

/** Deps whose clock is instant, so the real (multi-second) waits do not slow the suite down. */
function deps(over: Partial<TerminateDeps> = {}): TerminateDeps & { kills: Array<[number, string]>; logs: string[] } {
  const kills: Array<[number, string]> = []
  const logs: string[] = []
  return {
    kills,
    logs,
    isAlive: async () => true,
    kill: (pid, signal) => { kills.push([pid, signal]) },
    sleep: async () => { /* instant */ },
    log: (m) => { logs.push(m) },
    ...over,
  }
}

describe('delete-agent fallback', () => {
  it('does nothing when the engine already left', async () => {
    // The normal case on a current build: the launcher got the request and shut its child down.
    const d = deps({ isAlive: async () => false })
    await expect(terminateDeletedAgent(SESSION, d)).resolves.toBe('gone')
    expect(d.kills).toEqual([])
  })

  it('SIGTERMs an engine that is still there, and stops once it goes', async () => {
    let alive = true
    const d = deps({ isAlive: async () => alive, kill: (pid, signal) => { alive = false; d.kills.push([pid, signal]) } })
    await expect(terminateDeletedAgent(SESSION, d)).resolves.toBe('terminated')
    expect(d.kills).toEqual([[4242, 'SIGTERM']])
  })

  it('escalates to SIGKILL for an engine that ignores SIGTERM', async () => {
    // Some CLIs trap SIGTERM for a "press again to quit" prompt. Delete has to mean deleted.
    let alive = true
    const d = deps({
      isAlive: async () => alive,
      kill: (pid, signal) => { if (signal === 'SIGKILL') alive = false; d.kills.push([pid, signal]) },
    })
    await expect(terminateDeletedAgent(SESSION, d)).resolves.toBe('killed')
    expect(d.kills).toEqual([[4242, 'SIGTERM'], [4242, 'SIGKILL']])
    expect(d.logs.join('\n')).toContain('SIGKILL')
  })

  it('never signals a pane that now holds a different process', async () => {
    // isAlive compares pid AND start time, so a recycled pid reads as not-alive — the pid-reuse guard.
    const d = deps({ isAlive: async () => false })
    await terminateDeletedAgent({ ...SESSION, processIdentity: { pid: 4242, executable: 'x', startMarker: 'later' } } as RegisteredSession, d)
    expect(d.kills).toEqual([])
  })

  it('has nothing to signal when the session never had a pid on record', async () => {
    const d = deps()
    await expect(terminateDeletedAgent({ ...SESSION, processIdentity: null } as RegisteredSession, d))
      .resolves.toBe('not-ours')
    expect(d.kills).toEqual([])
  })

  it('reports a refused signal instead of swallowing it', async () => {
    // EPERM: a differently-owned engine (sudo, another account). The delete silently did not happen, and
    // the user was already told it did — so this must be loud, and must not throw.
    const d = deps({
      kill: () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }) },
    })
    await expect(terminateDeletedAgent(SESSION, d)).resolves.toBe('failed')
    expect(d.logs.join('\n')).toContain('operation not permitted')
  })

  it('treats a process that vanished mid-signal as gone, not as a failure', async () => {
    let alive = true
    const d = deps({
      isAlive: async () => alive,
      kill: () => { alive = false; throw Object.assign(new Error('no such process'), { code: 'ESRCH' }) },
    })
    await expect(terminateDeletedAgent(SESSION, d)).resolves.toBe('gone')
    expect(d.logs.join('\n')).not.toContain('could not') // ESRCH is not an error worth reporting
  })

  it('says failed — loudly — when even SIGKILL does not take', async () => {
    const d = deps() // alive forever
    await expect(terminateDeletedAgent(SESSION, d)).resolves.toBe('failed')
    expect(d.logs.join('\n')).toContain('STILL running')
  })

  it('waits for the launcher before touching anything', async () => {
    // The budgets are coupled: this delay must outlast the launcher's own SIGTERM→SIGKILL grace, so a
    // launcher that understood the request always finishes first and this never fires at all.
    const waits: number[] = []
    const d = deps({ isAlive: async () => false, sleep: async (ms) => { waits.push(ms) } })
    await terminateDeletedAgent(SESSION, d)
    expect(waits[0]).toBeGreaterThan(3_000) // LAUNCHER_EXIT_GRACE_MS in launch.ts
  })

  it('never rejects, whatever the probe does', async () => {
    const d = deps({ isAlive: async () => { throw new Error('tmux is gone') } })
    await expect(terminateDeletedAgent(SESSION, d)).resolves.toBe('gone')
  })
})

describe('delete-agent fallback timing', () => {
  it('polls during the kill grace rather than sleeping through it', async () => {
    // A polled grace lets a well-behaved engine's exit be noticed immediately; one long sleep would make
    // every SIGTERM cost the full grace before the outcome is known.
    let alive = true
    const sleeps: number[] = []
    let calls = 0
    const d = deps({
      isAlive: async () => { calls += 1; if (calls > 3) alive = false; return alive },
      sleep: async (ms) => { sleeps.push(ms) },
    })
    await expect(terminateDeletedAgent(SESSION, d)).resolves.toBe('terminated')
    expect(sleeps.filter((ms) => ms < 1_000).length).toBeGreaterThan(0)
  })

  it('honours caller-supplied budgets', async () => {
    const sleeps: number[] = []
    const d = deps({ isAlive: async () => false, sleep: async (ms) => { sleeps.push(ms) } })
    await terminateDeletedAgent(SESSION, d, 10, 20)
    expect(sleeps[0]).toBe(10)
  })
})

describe('delete-agent fallback wiring', () => {
  it('uses the session it was handed, not a lookup', async () => {
    // The registry entry is already gone by the time this runs (forgetSession removed it), so the caller
    // must pass the captured session. Pinning it here keeps that ordering from being "fixed" later.
    const seen: RegisteredSession[] = []
    const d = deps({ isAlive: async (s) => { seen.push(s); return false } })
    await terminateDeletedAgent(SESSION, d)
    expect(seen[0]).toBe(SESSION)
  })
})
