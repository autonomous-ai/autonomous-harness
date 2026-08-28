import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from './registry.js'
import type { DiscoveredTerminalAgent, TerminalAgentProbe } from './terminalAgentDiscovery.js'
import type { TerminalBackend } from './terminalBackend.js'
import { TerminalAgentReconciler } from './terminalAgentReconciler.js'
import { terminalRouteKey } from './terminalRuntime.js'
import type { TerminalRuntimeRef } from './terminalTypes.js'

const tmux: TerminalRuntimeRef = { backend: 'tmux', paneId: '%1' }
const herdr: TerminalRuntimeRef = {
  backend: 'herdr', endpointId: 'endpoint-a', sessionName: 'default', terminalId: 'terminal-a', paneId: 'w1:p1',
}
const identity = { pid: 42, executable: 'claude', startMarker: 'Sat Aug 15 10:00:00 2026' }

function session(runtimes: TerminalRuntimeRef[] = [tmux]): RegisteredSession {
  return {
    schemaVersion: 2, active: true, agentId: 'agent-1', sessionId: '', boundAt: null, engine: 'claude',
    transcriptPath: null, projectDir: 'work', cwd: '/work', runtimes,
    primaryRuntimeKey: terminalRouteKey(runtimes[0]), tmuxPane: runtimes.find((runtime) => runtime.backend === 'tmux')?.paneId ?? '',
    source: null, title: null, model: null, cliVersion: null, processIdentity: identity,
    registeredAt: 1, updatedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
  }
}

function observed(runtimes: TerminalRuntimeRef[]): DiscoveredTerminalAgent {
  return {
    engine: 'claude', cwd: '/work', processIdentity: identity, args: 'claude', resumeSessionId: null,
    runtimes, primaryRuntimeKey: terminalRouteKey(runtimes[0]),
  }
}

function probe(targets: TerminalAgentProbe['targets'], agents: DiscoveredTerminalAgent[] = []): TerminalAgentProbe {
  return { processTableAvailable: true, targets, agents, ambiguousPlacements: new Set() }
}

describe('composite terminal reconciliation', () => {
  it('does not count an unavailable endpoint as a confirmed miss', async () => {
    const current = session([herdr])
    const onDormant = vi.fn()
    const onRemoved = vi.fn()
    const reconciler = new TerminalAgentReconciler({
      current: () => [current], backends: [], backendOrder: ['herdr'], herdrSessionOrder: ['default'],
      onDiscovered: vi.fn(), onObserved: vi.fn(), onDormant, onRemoved,
      probe: async () => probe([{ instanceId: 'herdr:endpoint-a', result: { state: 'unavailable', reason: 'stopped' } }]),
    })
    await reconciler.trigger()
    await reconciler.trigger()
    expect(onDormant).not.toHaveBeenCalled()
    expect(onRemoved).not.toHaveBeenCalled()
  })

  it('refreshes configured targets before every cycle so an initially stopped Herdr session can recover', async () => {
    const current = session([herdr])
    const onObserved = vi.fn()
    const onRemoved = vi.fn()
    let available = false
    const beforeProbe = vi.fn(async () => { available = beforeProbe.mock.calls.length > 1 })
    const reconciler = new TerminalAgentReconciler({
      current: () => [current], backends: [], backendOrder: ['herdr'], herdrSessionOrder: ['default'],
      onDiscovered: vi.fn(), onObserved, onDormant: vi.fn(), onRemoved, beforeProbe,
      probe: async () => available
        ? probe(
          [{ instanceId: 'herdr:endpoint-a', result: { state: 'available', roots: [{ runtime: herdr, rootPid: 1, cwd: '/work' }] } }],
          [observed([herdr])],
        )
        : probe([{ instanceId: 'herdr:endpoint-a', result: { state: 'unavailable', reason: 'stopped' } }]),
    })

    await reconciler.trigger()
    expect(onObserved).not.toHaveBeenCalled()
    await reconciler.trigger()

    expect(beforeProbe).toHaveBeenCalledTimes(2)
    expect(onObserved).toHaveBeenCalledWith(expect.objectContaining({ runtimes: [herdr] }), current)
    expect(onRemoved).not.toHaveBeenCalled()
  })

  it('removes only after two successful negative inventories', async () => {
    const current = session([herdr])
    const onRemoved = vi.fn()
    const validate = vi.fn(async () => ({ state: 'gone' as const, reason: 'process exited' }))
    const backend = { instanceId: 'herdr:endpoint-a', validate } as unknown as TerminalBackend
    const reconciler = new TerminalAgentReconciler({
      current: () => [current], backends: [backend], backendOrder: ['herdr'], herdrSessionOrder: ['default'],
      onDiscovered: vi.fn(), onObserved: vi.fn(), onDormant: vi.fn(), onRemoved,
      probe: async () => probe([{ instanceId: 'herdr:endpoint-a', result: { state: 'available', roots: [] } }]),
    })
    await reconciler.trigger()
    expect(onRemoved).not.toHaveBeenCalled()
    await reconciler.trigger()
    expect(onRemoved).toHaveBeenCalledWith(current, 'terminal runtime absent after 2 confirmed scans')
    expect(validate).toHaveBeenCalledTimes(2)
  })

  it('keeps an agent active when pane-specific validation proves a process missed by the aggregate scan', async () => {
    const current = session([tmux])
    const onDormant = vi.fn()
    const onRemoved = vi.fn()
    const validate = vi.fn(async () => ({ state: 'alive' as const }))
    const backend = { instanceId: 'tmux:default', validate } as unknown as TerminalBackend
    const reconciler = new TerminalAgentReconciler({
      current: () => [current], backends: [backend], backendOrder: ['tmux'], herdrSessionOrder: [],
      onDiscovered: vi.fn(), onObserved: vi.fn(), onDormant, onRemoved,
      probe: async () => probe([{ instanceId: 'tmux:default', result: { state: 'available', roots: [] } }]),
    })

    await reconciler.trigger()
    await reconciler.trigger()
    await reconciler.trigger()

    expect(validate).toHaveBeenCalledTimes(3)
    expect(onDormant).not.toHaveBeenCalled()
    expect(onRemoved).not.toHaveBeenCalled()
  })

  it('keeps an agent active when pane-specific validation is inconclusive', async () => {
    const current = session([tmux])
    const onDormant = vi.fn()
    const onRemoved = vi.fn()
    const validate = vi.fn(async () => ({ state: 'unknown' as const, reason: 'process table timed out' }))
    const backend = { instanceId: 'tmux:default', validate } as unknown as TerminalBackend
    const reconciler = new TerminalAgentReconciler({
      current: () => [current], backends: [backend], backendOrder: ['tmux'], herdrSessionOrder: [],
      onDiscovered: vi.fn(), onObserved: vi.fn(), onDormant, onRemoved,
      probe: async () => probe([{ instanceId: 'tmux:default', result: { state: 'available', roots: [] } }]),
    })

    await reconciler.trigger()
    await reconciler.trigger()

    expect(onDormant).not.toHaveBeenCalled()
    expect(onRemoved).not.toHaveBeenCalled()
  })

  it('refreshes a moved Herdr route on the same process without changing agent ownership', async () => {
    const current = session([herdr])
    const moved = { ...herdr, paneId: 'w2:p4' }
    const onObserved = vi.fn()
    const reconciler = new TerminalAgentReconciler({
      current: () => [current], backends: [], backendOrder: ['herdr'], herdrSessionOrder: ['default'],
      onDiscovered: vi.fn(), onObserved, onDormant: vi.fn(), onRemoved: vi.fn(),
      probe: async () => probe(
        [{ instanceId: 'herdr:endpoint-a', result: { state: 'available', roots: [{ runtime: moved, rootPid: 1, cwd: '/work' }] } }],
        [observed([moved])],
      ),
    })
    await reconciler.trigger()
    expect(onObserved).toHaveBeenCalledWith(expect.objectContaining({ runtimes: [moved] }), current)
  })

  it('keeps a healthy locator active when another backend is unavailable', async () => {
    const current = session([tmux, herdr])
    const onObserved = vi.fn()
    const onDormant = vi.fn()
    const reconciler = new TerminalAgentReconciler({
      current: () => [current], backends: [], backendOrder: ['tmux', 'herdr'], herdrSessionOrder: ['default'],
      onDiscovered: vi.fn(), onObserved, onDormant, onRemoved: vi.fn(),
      probe: async () => probe([
        { instanceId: 'tmux:default', result: { state: 'available', roots: [{ runtime: tmux, rootPid: 1, cwd: '/work' }] } },
        { instanceId: 'herdr:endpoint-a', result: { state: 'unavailable', reason: 'stopped' } },
      ], [observed([tmux])]),
    })
    await reconciler.trigger()
    expect(onObserved).toHaveBeenCalledWith(expect.objectContaining({ runtimes: [herdr, tmux] }), current)
    expect(onDormant).not.toHaveBeenCalled()
  })
})

describe('verified process adoption', () => {
  it('opens a sessionless agent through the normal discovery callback without another inventory scan', async () => {
    let current: RegisteredSession[] = []
    const candidate = observed([tmux])
    const onDiscovered = vi.fn(async () => { current = [session([tmux])] })
    const probeSnapshot = vi.fn(async () => {
      throw new Error('verified adoption must not run the general probe')
    })
    let transactionCalls = 0
    const transaction = async <T>(apply: () => T | Promise<T>): Promise<T> => {
      transactionCalls += 1
      return await apply()
    }
    const reconciler = new TerminalAgentReconciler({
      current: () => current, backends: [], backendOrder: ['tmux'], herdrSessionOrder: [],
      onDiscovered, onObserved: vi.fn(), onDormant: vi.fn(), onRemoved: vi.fn(),
      probe: probeSnapshot, transaction,
    })

    const adopted = await reconciler.adoptVerified(candidate)

    expect(adopted).toBe(current[0])
    expect(adopted?.sessionId).toBe('')
    expect(adopted?.processIdentity).toEqual(identity)
    expect(onDiscovered).toHaveBeenCalledWith(candidate)
    expect(transactionCalls).toBe(1)
    expect(probeSnapshot).not.toHaveBeenCalled()
  })

  it('refreshes an already adopted process instead of opening a duplicate agent', async () => {
    const existing = session([tmux])
    const onDiscovered = vi.fn()
    const onObserved = vi.fn()
    const reconciler = new TerminalAgentReconciler({
      current: () => [existing], backends: [], backendOrder: ['tmux'], herdrSessionOrder: [],
      onDiscovered, onObserved, onDormant: vi.fn(), onRemoved: vi.fn(),
    })

    const adopted = await reconciler.adoptVerified(observed([tmux]))

    expect(adopted).toBe(existing)
    expect(onObserved).toHaveBeenCalledWith(observed([tmux]), existing)
    expect(onDiscovered).not.toHaveBeenCalled()
  })

  it('reports no adopted agent when the registry callback rejects the process', async () => {
    const onDiscovered = vi.fn()
    const reconciler = new TerminalAgentReconciler({
      current: () => [], backends: [], backendOrder: ['tmux'], herdrSessionOrder: [],
      onDiscovered, onObserved: vi.fn(), onDormant: vi.fn(), onRemoved: vi.fn(),
    })

    expect(await reconciler.adoptVerified(observed([tmux]))).toBeUndefined()
    expect(onDiscovered).toHaveBeenCalledOnce()
  })
})
