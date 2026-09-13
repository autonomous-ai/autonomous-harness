import { describe, expect, it, vi } from 'vitest'
import type { AgentLaunch, ProcessIdentity, RegisteredSession } from './registry.js'
import type { TerminalRuntimeRef, TmuxRuntimeRef } from './terminalTypes.js'
import { restoreAgents, type RestoreAgentsDeps, type RestoreLaunch } from './restoreAgents.js'

const identity = (pid: number): ProcessIdentity => ({ pid, executable: 'claude', startMarker: `start ${pid}` })

function row(overrides: Partial<RegisteredSession> = {}): RegisteredSession {
  return {
    schemaVersion: 2,
    active: false,
    launch: { state: 'ready' },
    agentId: 'agent-a',
    sessionId: 'session-a',
    boundAt: 1,
    engine: 'claude',
    transcriptPath: null,
    projectDir: 'demo',
    cwd: '/tmp/demo',
    runtimes: [{ backend: 'tmux', paneId: '%3' }],
    primaryRuntimeKey: 'tmux\u0000%3',
    tmuxPane: '%3',
    source: null,
    title: null,
    model: null,
    cliVersion: null,
    processIdentity: null,
    registeredAt: 1,
    updatedAt: 1,
    lastHookAt: 1,
    lastTranscriptAt: 1,
    ...overrides,
  }
}

interface Harness {
  deps: RestoreAgentsDeps
  calls: string[]
  rows: Map<string, RegisteredSession>
  launches: Array<{ agentId: string; resumeSessionId?: string }>
  /** Per-pane scripted answers for probeProcess; shifted on each call. */
  probes: Map<string, Array<ProcessIdentity | null>>
  states: Map<string, Array<{ dead: boolean } | null>>
  nextPane: string[]
  paneCreates: number
  respawns: number
  transactionDepth: number
  released: string[]
}

function harness(rows: RegisteredSession[], opts: { livePanes?: string[]; failCreate?: boolean; budgetMs?: number; settleMs?: number } = {}): Harness {
  const h: Harness = {
    calls: [],
    rows: new Map(rows.map((r) => [r.agentId, r])),
    launches: [],
    probes: new Map(),
    states: new Map(),
    nextPane: ['%0', '%1', '%2'],
    paneCreates: 0,
    respawns: 0,
    transactionDepth: 0,
    released: [],
    deps: undefined as unknown as RestoreAgentsDeps,
  }
  const live = new Set(opts.livePanes ?? [])
  const note = (name: string) => { h.calls.push(`${name}${h.transactionDepth ? '@tx' : ''}`) }
  h.deps = {
    registry: {
      list: () => [...h.rows.values()],
      byAgent: (id) => h.rows.get(id),
      transaction: async (apply) => {
        h.transactionDepth++
        try { return await apply() } finally { h.transactionDepth-- }
      },
      clearProcessIdentity: (id) => { note(`clearIdentity:${id}`); const r = h.rows.get(id); if (r) r.processIdentity = null; return !!r },
      updateRuntimes: (id, runtimes: readonly TerminalRuntimeRef[], key) => {
        note(`updateRuntimes:${id}:${(runtimes[0] as TmuxRuntimeRef).paneId}`)
        const r = h.rows.get(id); if (!r) return false
        r.runtimes = [...runtimes]; r.primaryRuntimeKey = key ?? ''; r.active = true
        return true
      },
      setLaunch: (id, launch: AgentLaunch) => {
        note(`setLaunch:${id}:${launch.state}${launch.state === 'failed' ? `:${launch.error}` : ''}`)
        const r = h.rows.get(id); if (!r) return null
        r.launch = launch; return r
      },
      updateProcessIdentity: (id, pi) => { note(`updateIdentity:${id}:${pi.pid}`); const r = h.rows.get(id); if (r) r.processIdentity = pi; return !!r },
      unbindSession: (sid) => { note(`unbind:${sid}`); return true },
      inheritName: (from, to) => { note(`inheritName:${from}->${to}`) },
    },
    liveProcess: async (_entry, runtime) => live.has(runtime.paneId) ? identity(1000 + Number(runtime.paneId.slice(1))) : null,
    buildLaunch: (entry, o) => {
      h.launches.push({ agentId: entry.agentId, ...(o.resumeSessionId ? { resumeSessionId: o.resumeSessionId } : {}) })
      const launch: RestoreLaunch = { argv: [entry.engine, ...(o.resumeSessionId ? ['--resume', o.resumeSessionId] : [])] }
      return launch
    },
    createPane: async (entry) => {
      note(`createPane:${entry.agentId}`)
      h.paneCreates++
      if (opts.failCreate) return { ok: false, reason: 'tmux said no' }
      return { ok: true, runtime: { backend: 'tmux', paneId: h.nextPane.shift() ?? '%99' } }
    },
    respawn: async (runtime, launch) => { note(`respawn:${runtime.paneId}:${launch.argv.join(' ')}`); h.respawns++; return { ok: true } },
    probeProcess: async (runtime) => {
      const queue = h.probes.get(runtime.paneId) ?? []
      return queue.length ? queue.shift()! : null
    },
    paneState: async (runtime) => {
      const queue = h.states.get(runtime.paneId) ?? []
      return queue.length ? queue.shift()! : { dead: false }
    },
    clearRemainOnExit: async (runtime) => { note(`clearRemainOnExit:${runtime.paneId}`) },
    holdRoute: (key) => { note(`hold:${key}`) },
    releaseRoute: (key) => { note(`release:${key}`); h.released.push(key) },
    triggerHint: async (runtime) => { note(`triggerHint:${runtime.paneId}`) },
    log: () => {},
    budgetMs: opts.budgetMs ?? 60_000,
    settleMs: opts.settleMs ?? 0,
    sleep: async () => {},
  }
  return h
}

/** A watch always ends in `finally { releaseRoute }`; the success path releases once more before the
 *  hint, so "settled" means at least `watches` releases and the LAST one came from a finally. */
const settled = (h: Harness, watches: number, successes = 0) =>
  vi.waitFor(() => { expect(h.released.length).toBe(watches + successes) })

describe('restoreAgents — which agents get a pane back', () => {
  it('recreates a missing pane with a resume launch and hands the row over to discovery', async () => {
    const h = harness([row()])
    h.probes.set('%0', [null, identity(500)])

    const summary = await restoreAgents(h.deps)

    expect(summary).toEqual({ restored: ['agent-a'], skipped: [], failed: [] })
    expect(h.launches).toEqual([{ agentId: 'agent-a', resumeSessionId: 'session-a' }])
    // Every registry write of phase 1 happens inside the one transaction, in this order.
    expect(h.calls.slice(0, 5)).toEqual([
      'clearIdentity:agent-a@tx',
      'createPane:agent-a@tx',
      'hold:tmux\u0000%0@tx',
      'updateRuntimes:agent-a:%0@tx',
      'setLaunch:agent-a:starting@tx',
    ])
    await settled(h, 1, 1)
    // The route is released BEFORE the hint so the pass it triggers sees the pane again.
    expect(h.calls.slice(5)).toEqual([
      'updateIdentity:agent-a:500',
      'clearRemainOnExit:%0',
      'release:tmux\u0000%0',
      'triggerHint:%0',
      'release:tmux\u0000%0', // the finally, idempotent by contract
    ])
    expect(h.rows.get('agent-a')?.launch).toEqual({ state: 'starting' })
  })

  it('launches fresh when the row has no session to resume', async () => {
    const h = harness([row({ sessionId: '', boundAt: null })])
    h.probes.set('%0', [identity(1)])
    await restoreAgents(h.deps)
    expect(h.launches).toEqual([{ agentId: 'agent-a' }])
    await settled(h, 1, 1)
  })

  it('leaves a pane that still runs its engine alone, re-identifying a row that lost its pid', async () => {
    const h = harness([row()], { livePanes: ['%3'] })
    const summary = await restoreAgents(h.deps)
    expect(summary).toEqual({ restored: [], skipped: [], failed: [] })
    expect(h.paneCreates).toBe(0)
    // No identity on the row (a misread reboot, a tmux server that outlived the daemon): the live
    // pid is written back so discovery adopts by process rather than by route.
    expect(h.calls).toEqual(['updateIdentity:agent-a:1003'])
  })

  it('does not touch a live row that still knows its process', async () => {
    const h = harness([row({ processIdentity: identity(1003) })], { livePanes: ['%3'] })
    await restoreAgents(h.deps)
    expect(h.calls).toEqual([])
  })

  it('skips herdr-only rows, failed launches and grid agents, saying why', async () => {
    const h = harness([
      row({ agentId: 'herdr', runtimes: [{ backend: 'herdr', sessionName: 's', paneId: 'p' } as unknown as TerminalRuntimeRef] }),
      row({ agentId: 'broken', launch: { state: 'failed', error: 'START_TIMEOUT' } }),
      row({ agentId: 'gridded', grid: { baseUrl: 'https://grid.example/relay', model: null } }),
    ])
    const summary = await restoreAgents(h.deps)
    expect(summary.restored).toEqual([])
    expect(summary.skipped.map((s) => s.agentId)).toEqual(['herdr', 'broken', 'gridded'])
    expect(summary.skipped[2].reason).toMatch(/grid/)
    expect(h.paneCreates).toBe(0)
  })

  it('records a pane that could not be opened and leaves the row untouched', async () => {
    const h = harness([row()], { failCreate: true })
    const summary = await restoreAgents(h.deps)
    expect(summary.failed).toEqual([{ agentId: 'agent-a', reason: 'tmux said no' }])
    expect(h.calls).not.toContainEqual(expect.stringMatching(/^updateRuntimes/))
    expect(h.calls).not.toContainEqual(expect.stringMatching(/^hold/))
    expect(h.rows.get('agent-a')?.tmuxPane).toBe('%3')
  })

  it('restores several agents inside one transaction so reused pane ids cannot evict each other', async () => {
    const h = harness([row({ agentId: 'a', runtimes: [{ backend: 'tmux', paneId: '%1' }] }), row({ agentId: 'b', runtimes: [{ backend: 'tmux', paneId: '%0' }] })])
    h.probes.set('%0', [identity(1)])
    h.probes.set('%1', [identity(2)])
    const summary = await restoreAgents(h.deps)
    expect(summary.restored).toEqual(['a', 'b'])
    expect(h.calls.filter((c) => c.startsWith('updateRuntimes'))).toEqual(['updateRuntimes:a:%0@tx', 'updateRuntimes:b:%1@tx'])
    await settled(h, 2, 2)
  })
})

describe('restoreAgents — waiting for the engine', () => {
  it('falls back to a fresh launch once when the resumed engine dies, and unbinds the stale session', async () => {
    const h = harness([row()])
    h.probes.set('%0', [null, null, identity(9)])
    h.states.set('%0', [{ dead: true }, { dead: false }])

    await restoreAgents(h.deps)
    await settled(h, 1, 1)

    expect(h.respawns).toBe(1)
    expect(h.launches).toEqual([
      { agentId: 'agent-a', resumeSessionId: 'session-a' },
      { agentId: 'agent-a' },
    ])
    const tail = h.calls.slice(5)
    expect(tail.slice(0, 3)).toEqual(['inheritName:session-a->agent-a', 'unbind:session-a', 'respawn:%0:claude'])
    expect(tail).toContain('updateIdentity:agent-a:9')
    expect(h.rows.get('agent-a')?.launch).toEqual({ state: 'starting' })
  })

  it('treats an engine that appears and then exits inside the settling window as a rejected resume', async () => {
    const h = harness([row()], { settleMs: 50 })
    // First probe: the resumed claude is up. Settling poll: the pane is dead. After the fresh
    // respawn: up again, and this time it stays.
    h.probes.set('%0', [identity(7), identity(8)])
    h.states.set('%0', [{ dead: true }])

    await restoreAgents(h.deps)
    await settled(h, 1, 1)

    expect(h.respawns).toBe(1)
    expect(h.launches.map((l) => l.resumeSessionId ?? 'fresh')).toEqual(['session-a', 'fresh'])
    const tail = h.calls.slice(5)
    expect(tail.slice(0, 4)).toEqual(['updateIdentity:agent-a:7', 'inheritName:session-a->agent-a', 'unbind:session-a', 'respawn:%0:claude'])
    expect(tail).toContain('updateIdentity:agent-a:8')
    expect(tail).toContain('clearRemainOnExit:%0')
    // remain-on-exit was NOT cleared before the first engine died — that is what kept the pane.
    expect(tail.indexOf('clearRemainOnExit:%0')).toBeGreaterThan(tail.indexOf('respawn:%0:claude'))
    expect(h.rows.get('agent-a')?.launch).toEqual({ state: 'starting' })
  })

  it('fails a fresh engine that exits inside the settling window', async () => {
    const h = harness([row({ sessionId: '', boundAt: null })], { settleMs: 50 })
    h.probes.set('%0', [identity(7)])
    h.states.set('%0', [{ dead: true }])
    await restoreAgents(h.deps)
    await settled(h, 1)
    expect(h.respawns).toBe(0)
    expect(h.rows.get('agent-a')?.launch).toMatchObject({ state: 'failed', error: 'ENGINE_DID_NOT_START' })
  })

  it('gives up after the fresh launch dies too', async () => {
    const h = harness([row()])
    h.states.set('%0', [{ dead: true }, { dead: true }])
    await restoreAgents(h.deps)
    await settled(h, 1)
    expect(h.respawns).toBe(1)
    expect(h.rows.get('agent-a')?.launch).toMatchObject({ state: 'failed', error: 'ENGINE_DID_NOT_START' })
  })

  it('does not retry fresh when there was no resume to blame', async () => {
    const h = harness([row({ sessionId: '', boundAt: null })])
    h.states.set('%0', [{ dead: true }])
    await restoreAgents(h.deps)
    await settled(h, 1)
    expect(h.respawns).toBe(0)
    expect(h.rows.get('agent-a')?.launch).toMatchObject({ state: 'failed', error: 'ENGINE_DID_NOT_START' })
  })

  it('fails the launch when the pane vanishes entirely', async () => {
    const h = harness([row()])
    h.states.set('%0', [null])
    await restoreAgents(h.deps)
    await settled(h, 1)
    expect(h.rows.get('agent-a')?.launch).toMatchObject({ state: 'failed', error: 'ENGINE_DID_NOT_START' })
  })

  it('times out with the launch marked, never leaving the route held', async () => {
    const h = harness([row()], { budgetMs: 0 })
    await restoreAgents(h.deps)
    await settled(h, 1)
    expect(h.rows.get('agent-a')?.launch).toMatchObject({ state: 'failed', error: 'START_TIMEOUT' })
    expect(h.released).toEqual(['tmux\u0000%0'])
  })

  it('stops quietly when the agent was deleted while its engine was starting', async () => {
    const h = harness([row()])
    h.probes.set('%0', [null])
    const deps = { ...h.deps }
    let polls = 0
    deps.probeProcess = async () => { if (++polls === 2) h.rows.delete('agent-a'); return null }
    await restoreAgents(deps)
    await settled(h, 1)
    expect(h.calls.filter((c) => c.startsWith('setLaunch:agent-a:failed'))).toEqual([])
  })
})
