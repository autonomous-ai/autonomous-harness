import { describe, expect, it, vi } from 'vitest'
import type { AgentEngine } from '../engines/types.js'
import type { AgentCommandOwnershipSnapshot } from './engineBin.js'
import type { ProcessRow } from './tmux.js'
import type { RegisteredSession } from './registry.js'
import {
  TmuxAgentReconciler,
  discoverTmuxAgentsFromSnapshot,
  runtimeKey,
  type DiscoveredTmuxAgent,
  type TmuxAgentProbe,
} from './tmuxAgentDiscovery.js'

const START = 'Mon Aug 10 12:00:00 2026'
const pane = { tmuxPane: '%1', rootPid: 1, cwd: '/work/demo' }
const row = (pid: number, parentPid: number, executable: string, args = executable): ProcessRow => ({
  pid, parentPid, executable, args, startMarker: START,
})
const ownership = (cursor: string[] = [], grok: string[] = []): AgentCommandOwnershipSnapshot => ({
  cursorFileKeys: new Set(cursor),
  grokFileKeys: new Set(grok),
  conflictingFileKeys: new Set(cursor.filter((key) => grok.includes(key))),
  agentCandidates: [],
  cursorAgentCandidates: [],
  grokCandidates: [],
})

describe('tmux process agent snapshot discovery', () => {
  const fixtures: Array<[AgentEngine, string, string]> = [
    ['claude', 'claude', 'claude'],
    ['codex', 'codex', 'codex'],
    ['cursor', 'cursor-agent', 'cursor-agent'],
    ['opencode', 'opencode', 'opencode'],
    ['pi', 'pi', 'pi'],
    ['hermes', 'python', '/opt/hermes-agent/hermes'],
    ['commandcode', '⌘ Project', '⌘ Project'],
    ['devin', 'devin', 'devin'],
    ['muse', 'muse-bin-1.2.3', 'muse-bin-1.2.3'],
    ['amp', 'amp', 'amp'],
    ['kilo', 'kilo', 'kilo'],
    ['grok', 'grok', 'grok'],
  ]

  it.each(fixtures)('recognizes the plain %s CLI process', (engine, executable, args) => {
    const result = discoverTmuxAgentsFromSnapshot([pane], [row(1, 0, 'zsh'), row(2, 1, executable, args)], 900)
    expect(result.agents).toHaveLength(1)
    expect(result.agents[0]).toMatchObject({ engine, tmuxPane: '%1', cwd: '/work/demo' })
  })

  it('classifies each vendor agent alias from the executable file identity', () => {
    const commands = ownership(['cursor-file'], ['grok-file'])
    const cursorRow = { ...row(2, 1, 'agent'), imageFileKey: 'cursor-file' }
    const grokRow = { ...row(2, 1, 'agent'), imageFileKey: 'grok-file' }

    expect(discoverTmuxAgentsFromSnapshot([pane], [row(1, 0, 'zsh'), cursorRow], 900, commands)
      .agents[0]?.engine).toBe('cursor')
    expect(discoverTmuxAgentsFromSnapshot([pane], [row(1, 0, 'zsh'), grokRow], 900, commands)
      .agents[0]?.engine).toBe('grok')
  })

  it('does not guess an unresolved agent alias and lets a pane-scoped vendor hook resolve it', () => {
    const commands = ownership(['cursor-file'], ['grok-file'])
    const rows = [row(1, 0, 'zsh'), row(2, 1, 'agent')]
    const unresolved = discoverTmuxAgentsFromSnapshot([pane], rows, 900, commands)
    expect(unresolved.agents).toEqual([])
    expect(unresolved.ambiguousPanes.has('%1')).toBe(true)

    const hinted = discoverTmuxAgentsFromSnapshot(
      [pane], rows, 900, commands, new Map([['%1', 'grok']]),
    )
    expect(hinted.agents[0]?.engine).toBe('grok')

    const conflict = ownership(['same-file'], ['same-file'])
    const conflicted = discoverTmuxAgentsFromSnapshot(
      [pane], [row(1, 0, 'zsh'), { ...row(2, 1, 'agent'), imageFileKey: 'same-file' }],
      900, conflict, new Map([['%1', 'grok']]),
    )
    expect(conflicted.agents).toEqual([])
    expect(conflicted.ambiguousPanes.has('%1')).toBe(true)
  })

  it('does not let a nested sub-agent steal a pane from an unresolved top-level agent alias', () => {
    const result = discoverTmuxAgentsFromSnapshot(
      [pane],
      [row(1, 0, 'zsh'), row(2, 1, 'agent'), row(3, 2, 'codex')],
      900,
      ownership(),
    )
    expect(result.agents).toEqual([])
    expect(result.ambiguousPanes.has('%1')).toBe(true)
  })

  it('keeps a file-identified Grok parent while agent-named sub-agent PIDs churn', () => {
    const commands = ownership(['cursor-file'], ['grok-file'])
    const first = discoverTmuxAgentsFromSnapshot(
      [pane],
      [row(1, 0, 'zsh'), { ...row(2, 1, 'agent'), imageFileKey: 'grok-file' }, row(3, 2, 'cursor-agent')],
      900,
      commands,
    )
    const second = discoverTmuxAgentsFromSnapshot(
      [pane],
      [row(1, 0, 'zsh'), { ...row(2, 1, 'agent'), imageFileKey: 'grok-file' }, row(30, 2, 'cursor-agent')],
      900,
      commands,
    )
    expect(first.agents[0]?.engine).toBe('grok')
    expect(first.agents[0]?.processIdentity.pid).toBe(2)
    expect(runtimeKey(first.agents[0])).toBe(runtimeKey(second.agents[0]))
  })

  const wrappers: Array<[AgentEngine, string, string]> = [
    ['claude', 'node', '/opt/lib/node_modules/@anthropic-ai/claude-code/cli.js'],
    ['codex', 'node', '/opt/lib/node_modules/@openai/codex/bin/codex.js'],
    ['cursor', 'node', '/opt/cursor-agent/versions/1.2.3/index.js'],
    ['opencode', 'opencode.exe', '/opt/lib/node_modules/opencode-ai/bin/opencode.exe'],
    ['pi', 'node', '/opt/lib/node_modules/pi-coding-agent/dist/cli.js'],
    ['hermes', 'python3', '/opt/hermes-agent/hermes'],
    ['commandcode', 'node', '/opt/lib/node_modules/command-code/dist/index.mjs'],
    ['devin', 'python3', '/opt/devin/cli/_versions/1.2.3/bin/devin'],
    ['muse', 'muse-bin-0.1.0-R708.1', 'muse-bin-0.1.0-R708.1'],
    ['amp', 'node', '/opt/.amp/bin/amp'],
    ['kilo', 'node', '/opt/lib/node_modules/@kilocode/cli/bin/kilo'],
    ['grok', 'node', '/opt/.grok/bin/grok'],
  ]

  it.each(wrappers)('recognizes the installed/wrapper form for %s', (engine, executable, args) => {
    const result = discoverTmuxAgentsFromSnapshot([pane], [row(1, 0, 'zsh'), row(2, 1, executable, args)], 900)
    expect(result.agents).toHaveLength(1)
    expect(result.agents[0].engine).toBe(engine)
  })

  const installPrefixes = [
    '/usr/local',
    '/opt/homebrew',
    '/nix/store/abc123-agent-cli',
    '/home/test/.local/share/pnpm/global/5',
  ]

  it.each(wrappers.flatMap(([engine, executable, args]) => installPrefixes.map((prefix) => [
    engine,
    executable,
    args.replace('/opt', prefix),
  ] as const)))('recognizes %s under arbitrary install prefix (%s)', (engine, executable, args) => {
    const result = discoverTmuxAgentsFromSnapshot(
      [pane],
      [row(1, 0, 'zsh'), row(2, 1, executable, args)],
      900,
    )
    expect(result.agents[0]?.engine).toBe(engine)
  })

  it('recognizes an interpreter entrypoint under a quoted install prefix with spaces', () => {
    const result = discoverTmuxAgentsFromSnapshot(
      [pane],
      [row(1, 0, 'zsh'), row(2, 1, 'node', 'node "/Applications/Agent Tools/lib/node_modules/@openai/codex/bin/codex.js"')],
      900,
    )
    expect(result.agents[0]?.engine).toBe('codex')
  })

  it('honors a configured engine path with a custom executable name', () => {
    const previous = process.env.CODEX_PATH
    process.env.CODEX_PATH = '/srv/company-tools/company-coding-agent'
    try {
      const result = discoverTmuxAgentsFromSnapshot(
        [pane],
        [row(1, 0, 'zsh'), row(2, 1, 'company-coding-agent', '/srv/company-tools/company-coding-agent')],
        900,
      )
      expect(result.agents[0]?.engine).toBe('codex')
    } finally {
      if (previous === undefined) delete process.env.CODEX_PATH
      else process.env.CODEX_PATH = previous
    }
  })

  it('never treats engine names in prompt arguments as process entrypoints', () => {
    const result = discoverTmuxAgentsFromSnapshot(
      [pane],
      [row(1, 0, 'zsh'), row(2, 1, 'python3', 'python3 /work/runner.py compare claude codex agent opencode pi hermes cmd devin muse amp kilo grok')],
      900,
    )
    expect(result.agents).toEqual([])
  })

  it('does not infer an agent from an engine-named repository path', () => {
    const result = discoverTmuxAgentsFromSnapshot(
      [pane],
      [row(1, 0, 'zsh'), row(2, 1, 'node', 'node /work/codex/tests/runner.js')],
      900,
    )
    expect(result.agents).toEqual([])
  })

  it('does not treat inline shell source as the process entrypoint', () => {
    const result = discoverTmuxAgentsFromSnapshot(
      [pane],
      [row(1, 0, 'zsh'), row(2, 1, 'bash', 'bash -c "printf claude codex kilo"')],
      900,
    )
    expect(result.agents).toEqual([])
  })

  it.each(['kilo', 'kilocode'])('recognizes the public %s wrapper command', (command) => {
    const result = discoverTmuxAgentsFromSnapshot(
      [pane],
      [row(1, 0, 'zsh'), row(2, 1, 'node', `node /any/prefix/bin/${command}`)],
      900,
    )
    expect(result.agents[0]?.engine).toBe('kilo')
  })

  it('recognizes Command Code after it rewrites its process title', () => {
    const result = discoverTmuxAgentsFromSnapshot(
      [pane],
      [row(1, 0, 'zsh'), row(2, 1, '⌘ Implement lifecycle plan', '⌘ Implement lifecycle plan')],
      900,
    )
    expect(result.agents[0]?.engine).toBe('commandcode')
  })

  it('creates independent agents for two panes running the same engine', () => {
    const result = discoverTmuxAgentsFromSnapshot(
      [pane, { tmuxPane: '%2', rootPid: 10, cwd: '/work/other' }],
      [row(1, 0, 'zsh'), row(2, 1, 'claude'), row(10, 0, 'zsh'), row(11, 10, 'claude')],
      900,
    )
    expect(result.agents.map((agent) => [agent.tmuxPane, agent.engine])).toEqual([
      ['%1', 'claude'], ['%2', 'claude'],
    ])
  })

  it('keeps the shallow supported parent and ignores a nested supported sub-agent', () => {
    const result = discoverTmuxAgentsFromSnapshot(
      [pane],
      [row(1, 0, 'zsh'), row(2, 1, 'claude'), row(3, 2, 'codex')],
      900,
    )
    expect(result.agents.map((agent) => agent.engine)).toEqual(['claude'])
  })

  it('keeps the same parent identity while nested sub-agent PIDs churn', () => {
    const first = discoverTmuxAgentsFromSnapshot(
      [pane],
      [
        row(1, 0, 'zsh'),
        row(2, 1, 'claude'),
        row(3, 2, 'node', 'node /work/helper.js'),
        row(4, 3, 'codex'),
      ],
      900,
    )
    const second = discoverTmuxAgentsFromSnapshot(
      [pane],
      [
        row(1, 0, 'zsh'),
        row(2, 1, 'claude'),
        row(30, 2, 'node', 'node /work/helper.js'),
        row(40, 30, 'agent'),
      ],
      900,
    )
    expect(first.agents[0]?.processIdentity.pid).toBe(2)
    expect(second.agents[0]?.processIdentity.pid).toBe(2)
    expect(runtimeKey(first.agents[0])).toBe(runtimeKey(second.agents[0]))
  })

  it('excludes recap/voice/one-shot descendants of the harness daemon', () => {
    const result = discoverTmuxAgentsFromSnapshot(
      [pane],
      [row(1, 0, 'zsh'), row(20, 1, 'node', 'node cli.js __run'), row(21, 20, 'codex', 'codex exec recap')],
      20,
    )
    expect(result.agents).toEqual([])
  })

  it('does not guess when two top-level supported processes tie', () => {
    const result = discoverTmuxAgentsFromSnapshot(
      [pane],
      [row(1, 0, 'zsh'), row(2, 1, 'claude'), row(3, 1, 'codex')],
      900,
    )
    expect(result.agents).toEqual([])
    expect(result.ambiguousPanes.has('%1')).toBe(true)
  })
})

function observed(pid: number, engine: AgentEngine = 'claude'): DiscoveredTmuxAgent {
  return {
    engine,
    tmuxPane: '%1',
    cwd: '/work/demo',
    processIdentity: { pid, executable: engine, startMarker: `${START} ${pid}` },
    args: engine,
    resumeSessionId: null,
  }
}

function registered(agent: DiscoveredTmuxAgent, agentId = 'agent-1'): RegisteredSession {
  return {
    agentId,
    sessionId: '',
    boundAt: null,
    engine: agent.engine,
    transcriptPath: null,
    projectDir: 'demo',
    cwd: agent.cwd,
    tmuxPane: agent.tmuxPane,
    source: null,
    title: null,
    model: null,
    cliVersion: null,
    processIdentity: agent.processIdentity,
    registeredAt: 1,
    updatedAt: 1,
    lastHookAt: 1,
    lastTranscriptAt: 1,
  }
}

const success = (agents: DiscoveredTmuxAgent[], panes = new Set(['%1'])): TmuxAgentProbe => ({
  ok: true,
  agents,
  panes,
  ambiguousPanes: new Set(),
})

describe('tmux process agent lifecycle reconciliation', () => {
  it('creates on the first positive scan and removes only after two confirmed misses', async () => {
    let current: RegisteredSession[] = []
    const live = observed(10)
    const probes = [success([live]), success([]), success([])]
    const removed: string[] = []
    const reconciler = new TmuxAgentReconciler({
      current: () => current,
      probe: async () => probes.shift()!,
      onDiscovered: (agent) => { current = [registered(agent)] },
      onObserved: () => {},
      onRemoved: (agent) => { removed.push(agent.agentId); current = [] },
    })
    await reconciler.trigger()
    expect(current).toHaveLength(1)
    await reconciler.trigger()
    expect(removed).toEqual([])
    await reconciler.trigger()
    expect(removed).toEqual(['agent-1'])
  })

  it('does not count a failed probe as a miss', async () => {
    const live = observed(10)
    let current = [registered(live)]
    const probes: TmuxAgentProbe[] = [
      { ok: false, error: 'ps timed out' },
      success([]),
      success([]),
    ]
    const removed = vi.fn(() => { current = [] })
    const reconciler = new TmuxAgentReconciler({
      current: () => current,
      probe: async () => probes.shift()!,
      onDiscovered: () => {},
      onObserved: () => {},
      onRemoved: removed,
    })
    await reconciler.trigger()
    await reconciler.trigger()
    expect(removed).not.toHaveBeenCalled()
    await reconciler.trigger()
    expect(removed).toHaveBeenCalledTimes(1)
  })

  it('holds the current agent through a detached same-depth sub-agent ambiguity', async () => {
    const live = observed(10)
    const current = [registered(live)]
    const ambiguous: TmuxAgentProbe = {
      ok: true,
      agents: [],
      panes: new Set(['%1']),
      ambiguousPanes: new Set(['%1']),
    }
    const probes = [ambiguous, ambiguous, success([live])]
    const discovered = vi.fn()
    const removed = vi.fn()
    const observedAgain = vi.fn()
    const reconciler = new TmuxAgentReconciler({
      current: () => current,
      probe: async () => probes.shift()!,
      onDiscovered: discovered,
      onObserved: observedAgain,
      onRemoved: removed,
    })

    await reconciler.trigger()
    await reconciler.trigger()
    expect(discovered).not.toHaveBeenCalled()
    expect(removed).not.toHaveBeenCalled()
    await reconciler.trigger()
    expect(observedAgain).toHaveBeenCalledWith(live, current[0])
    expect(removed).not.toHaveBeenCalled()
  })

  it('serializes scans and coalesces every trigger received during one slow pass', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let calls = 0
    let active = 0
    let maxActive = 0
    const reconciler = new TmuxAgentReconciler({
      current: () => [],
      probe: async () => {
        calls++
        active++
        maxActive = Math.max(maxActive, active)
        if (calls === 1) await firstGate
        active--
        return success([])
      },
      onDiscovered: () => {},
      onObserved: () => {},
      onRemoved: () => {},
    })

    const first = reconciler.trigger()
    const second = reconciler.trigger()
    const third = reconciler.trigger()
    expect(calls).toBe(1)
    releaseFirst()
    await Promise.all([first, second, third])
    expect(calls).toBe(2)
    expect(maxActive).toBe(1)
  })

  it('replaces a changed process in the same pane immediately', async () => {
    const old = observed(10)
    const replacement = observed(11, 'codex')
    let current = [registered(old)]
    const order: string[] = []
    const reconciler = new TmuxAgentReconciler({
      current: () => current,
      probe: async () => success([replacement]),
      onDiscovered: (agent) => { order.push('add'); current = [registered(agent, 'agent-2')] },
      onObserved: () => {},
      onRemoved: () => { order.push('remove'); current = [] },
    })
    await reconciler.trigger()
    expect(order).toEqual(['remove', 'add'])
    expect(current[0]).toMatchObject({ agentId: 'agent-2', engine: 'codex' })
  })

  it('treats PID reuse with a new start marker as immediate replacement', async () => {
    const old = observed(10)
    const replacement = { ...observed(10), processIdentity: { ...observed(10).processIdentity, startMarker: `${START} reused` } }
    let current = [registered(old)]
    const order: string[] = []
    const reconciler = new TmuxAgentReconciler({
      current: () => current,
      probe: async () => success([replacement]),
      onDiscovered: (agent) => { order.push('add'); current = [registered(agent, 'agent-2')] },
      onObserved: () => {},
      onRemoved: () => { order.push('remove'); current = [] },
    })
    await reconciler.trigger()
    expect(order).toEqual(['remove', 'add'])
    expect(current[0].agentId).toBe('agent-2')
  })

  it('suppresses a deleted runtime until that exact identity disappears', async () => {
    const live = observed(10)
    let current: RegisteredSession[] = []
    const probes = [success([live]), success([]), success([observed(11)])]
    const added: string[] = []
    const reconciler = new TmuxAgentReconciler({
      current: () => current,
      probe: async () => probes.shift()!,
      onDiscovered: (agent) => { added.push(runtimeKey(agent)); current = [registered(agent)] },
      onObserved: () => {},
      onRemoved: () => { current = [] },
    })
    reconciler.suppress(live)
    await reconciler.trigger()
    expect(added).toEqual([])
    await reconciler.trigger()
    await reconciler.trigger()
    expect(added).toEqual([runtimeKey(observed(11))])
  })
})
