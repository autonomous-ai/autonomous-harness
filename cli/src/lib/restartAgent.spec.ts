import { describe, expect, it, vi } from 'vitest'
import { restartAgent, type RestartAgentDeps } from './restartAgent.js'
import type { ProcessIdentity } from './registry.js'

const IDENTITY: ProcessIdentity = { pid: 555, executable: 'claude', startMarker: 'Mon Aug  3 09:05:00 2026' }

interface Overrides {
  holdOpen?: RestartAgentDeps['holdOpen']
  terminate?: RestartAgentDeps['terminate']
  respawn?: RestartAgentDeps['respawn']
  waitForProcess?: RestartAgentDeps['waitForProcess']
  buildArgv?: RestartAgentDeps['buildArgv']
}

/** Every primitive records its own call, even when overridden — so `calls` always reflects the real
 *  order regardless of which primitive a test customizes the return value of. */
function deps(over: Overrides = {}): RestartAgentDeps & { calls: string[] } {
  const calls: string[] = []
  const holdOpenImpl = over.holdOpen ?? (async () => ({ ok: true }))
  const terminateImpl = over.terminate ?? (async () => 'terminated' as const)
  const respawnImpl = over.respawn ?? (async () => ({ ok: true }))
  const waitForProcessImpl = over.waitForProcess ?? (async () => IDENTITY)
  const buildArgvImpl = over.buildArgv ?? (() => ['claude'])
  return {
    calls,
    holdOpen: async () => { calls.push('holdOpen'); return holdOpenImpl() },
    terminate: async (checkAfterMs) => { calls.push('terminate'); return terminateImpl(checkAfterMs) },
    respawn: async (argv) => { calls.push('respawn'); return respawnImpl(argv) },
    waitForProcess: async () => { calls.push('waitForProcess'); return waitForProcessImpl() },
    buildArgv: (opts) => { calls.push('buildArgv'); return buildArgvImpl(opts) },
    log: () => {},
  }
}

describe('restartAgent', () => {
  it('holds the pane open, kills, respawns, and verifies — in that order', async () => {
    const d = deps()
    const outcome = await restartAgent({ engine: 'claude', sessionId: 's1' }, false, d)
    expect(outcome).toEqual({ ok: true, processIdentity: IDENTITY, resumed: true })
    expect(d.calls).toEqual(['holdOpen', 'terminate', 'buildArgv', 'respawn', 'waitForProcess'])
  })

  it('never respawns when holdOpen fails to re-arm the pane', async () => {
    const d = deps({ holdOpen: async () => ({ ok: false, reason: 'tmux unreachable' }) })
    const outcome = await restartAgent({ engine: 'claude', sessionId: 's1' }, false, d)
    expect(outcome).toEqual({ ok: false, detail: 'tmux unreachable' })
    expect(d.calls).toEqual(['holdOpen'])
  })

  it('never respawns over a kill that could not be confirmed (not-ours)', async () => {
    const d = deps({ terminate: async () => 'not-ours' })
    const outcome = await restartAgent({ engine: 'claude', sessionId: 's1' }, false, d)
    expect(outcome.ok).toBe(false)
    expect(d.calls).toEqual(['holdOpen', 'terminate'])
  })

  it('never respawns over a kill that failed', async () => {
    const d = deps({ terminate: async () => 'failed' })
    const outcome = await restartAgent({ engine: 'claude', sessionId: 's1' }, false, d)
    expect(outcome.ok).toBe(false)
    expect(d.calls).toEqual(['holdOpen', 'terminate'])
  })

  it('treats "gone" (the process had already exited) as a confirmed kill, safe to respawn over', async () => {
    const d = deps({ terminate: async () => 'gone' })
    const outcome = await restartAgent({ engine: 'claude', sessionId: 's1' }, false, d)
    expect(outcome.ok).toBe(true)
  })

  it('passes the resolved sessionId as resumeSessionId on the first attempt', async () => {
    const argvCalls: Array<{ bypassPermission: boolean; resumeSessionId?: string }> = []
    const d = deps({ buildArgv: (opts) => { argvCalls.push(opts); return ['claude'] } })
    await restartAgent({ engine: 'claude', sessionId: 'sess-42' }, true, d)
    expect(argvCalls).toEqual([{ bypassPermission: true, resumeSessionId: 'sess-42' }])
  })

  it('launches fresh (no resumeSessionId) when the session has none', async () => {
    const argvCalls: Array<{ bypassPermission: boolean; resumeSessionId?: string }> = []
    const d = deps({ buildArgv: (opts) => { argvCalls.push(opts); return ['claude'] } })
    const outcome = await restartAgent({ engine: 'claude', sessionId: '' }, false, d)
    expect(argvCalls).toEqual([{ bypassPermission: false }])
    expect(outcome).toMatchObject({ ok: true, resumed: false })
  })

  it('falls back to a fresh relaunch when the resumed relaunch never produces a recognizable process', async () => {
    let attempt = 0
    const argvCalls: Array<{ bypassPermission: boolean; resumeSessionId?: string }> = []
    const d = deps({
      buildArgv: (opts) => { argvCalls.push(opts); return ['claude'] },
      waitForProcess: async () => { attempt += 1; return attempt === 1 ? null : IDENTITY },
    })
    const outcome = await restartAgent({ engine: 'claude', sessionId: 'sess-42' }, false, d)
    expect(argvCalls).toEqual([
      { bypassPermission: false, resumeSessionId: 'sess-42' },
      { bypassPermission: false },
    ])
    expect(outcome).toEqual({ ok: true, processIdentity: IDENTITY, resumed: false })
    // respawn + waitForProcess ran twice (once per attempt); holdOpen/terminate ran once.
    expect(d.calls.filter((c) => c === 'respawn')).toHaveLength(2)
    expect(d.calls.filter((c) => c === 'holdOpen')).toHaveLength(1)
    expect(d.calls.filter((c) => c === 'terminate')).toHaveLength(1)
  })

  it('fails outright when even the fresh fallback relaunch never comes up', async () => {
    const d = deps({ waitForProcess: async () => null })
    const outcome = await restartAgent({ engine: 'codex', sessionId: 'sess-1' }, false, d)
    expect(outcome).toEqual({ ok: false, detail: 'codex did not come back up after restart' })
  })

  it('never retries a resume fallback for an engine with no session to resume in the first place', async () => {
    let respawnCalls = 0
    const d = deps({
      respawn: async () => { respawnCalls += 1; return { ok: true } },
      waitForProcess: async () => null,
    })
    await restartAgent({ engine: 'claude', sessionId: '' }, false, d)
    expect(respawnCalls).toBe(1) // no resume attempt to fall back FROM
  })

  it('does not poll for a process when respawn-pane itself fails', async () => {
    const d = deps({ respawn: async () => ({ ok: false, reason: 'tmux respawn-pane did not complete' }) })
    const outcome = await restartAgent({ engine: 'claude', sessionId: 's1' }, false, d)
    expect(outcome.ok).toBe(false)
    expect(d.calls).not.toContain('waitForProcess')
  })
})
