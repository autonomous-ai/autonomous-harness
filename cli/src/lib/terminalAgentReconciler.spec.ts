import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from './registry.js'
import type { DiscoveredTerminalAgent, TerminalAgentProbe } from './terminalAgentDiscovery.js'
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
    expect(onDormant).toHaveBeenCalledTimes(2)
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
    const reconciler = new TerminalAgentReconciler({
      current: () => [current], backends: [], backendOrder: ['herdr'], herdrSessionOrder: ['default'],
      onDiscovered: vi.fn(), onObserved: vi.fn(), onDormant: vi.fn(), onRemoved,
      probe: async () => probe([{ instanceId: 'herdr:endpoint-a', result: { state: 'available', roots: [] } }]),
    })
    await reconciler.trigger()
    expect(onRemoved).not.toHaveBeenCalled()
    await reconciler.trigger()
    expect(onRemoved).toHaveBeenCalledWith(current, 'terminal runtime absent after 2 confirmed scans')
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
