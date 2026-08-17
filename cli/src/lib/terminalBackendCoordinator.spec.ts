import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from './registry.js'
import type { TerminalBackend } from './terminalBackend.js'
import { TerminalBackendCoordinator } from './terminalBackendCoordinator.js'
import { terminalRouteKey } from './terminalRuntime.js'
import type { TerminalRuntimeRef } from './terminalTypes.js'

const tmux: TerminalRuntimeRef = { backend: 'tmux', paneId: '%1' }
const herdr: TerminalRuntimeRef = {
  backend: 'herdr', endpointId: 'endpoint-a', sessionName: 'default', terminalId: 'terminal-a', paneId: 'w1:p1',
}

function session(): RegisteredSession {
  return {
    schemaVersion: 2, active: true, agentId: 'agent-1', sessionId: 's1', boundAt: 1, engine: 'claude', transcriptPath: null,
    projectDir: 'work', cwd: '/work', runtimes: [tmux, herdr], primaryRuntimeKey: terminalRouteKey(tmux), tmuxPane: '%1',
    source: null, title: null, model: null, cliVersion: null,
    processIdentity: { pid: 42, executable: 'claude', startMarker: 'Sat Aug 15 10:00:00 2026' },
    registeredAt: 1, updatedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
  }
}

function backend(instanceId: string, submit: TerminalBackend['submitText']): TerminalBackend {
  return {
    name: instanceId.startsWith('tmux') ? 'tmux' : 'herdr', instanceId,
    create: vi.fn(), kill: vi.fn(), inventory: vi.fn(),
    titles: vi.fn(async () => ({ state: 'succeeded' as const, value: new Map() })),
    validate: vi.fn(async () => ({ state: 'alive' as const })), capture: vi.fn(), typeLiteral: vi.fn(), submitText: submit,
    sendKey: vi.fn(), setTitle: vi.fn(), notify: vi.fn(),
  }
}

describe('TerminalBackendCoordinator', () => {
  it('merges backend-scoped title snapshots and prefers the primary runtime title', async () => {
    const first = backend('tmux:default', vi.fn())
    first.titles = vi.fn(async () => ({ state: 'succeeded' as const, value: new Map([[terminalRouteKey(tmux), 'tmux title']]) }))
    const second = backend('herdr:endpoint-a', vi.fn())
    second.titles = vi.fn(async () => ({ state: 'succeeded' as const, value: new Map([[terminalRouteKey(herdr), 'Herdr title']]) }))
    const coordinator = new TerminalBackendCoordinator([first, second], ['herdr', 'tmux'], ['default'])
    const current = session()
    current.primaryRuntimeKey = terminalRouteKey(herdr)
    const titles = await coordinator.titles()
    expect(titles.size).toBe(2)
    expect(coordinator.titleFor(current, titles)).toBe('Herdr title')
  })

  it('fails over only when dispatch is proven not to have started', async () => {
    const first = backend('tmux:default', vi.fn(async () => ({ state: 'failed' as const, dispatch: 'not_started' as const, reason: 'missing' })))
    const second = backend('herdr:endpoint-a', vi.fn(async () => ({ state: 'succeeded' as const, dispatch: 'executed' as const })))
    const result = await new TerminalBackendCoordinator([first, second], ['tmux', 'herdr'], ['default']).submitText(session(), 'hello')
    expect(result).toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(second.submitText).toHaveBeenCalledOnce()
  })

  it('never retries a possibly executed side effect', async () => {
    const first = backend('tmux:default', vi.fn(async () => ({ state: 'unknown' as const, dispatch: 'possibly_executed' as const, reason: 'lost response' })))
    const second = backend('herdr:endpoint-a', vi.fn(async () => ({ state: 'succeeded' as const, dispatch: 'executed' as const })))
    const result = await new TerminalBackendCoordinator([first, second], ['tmux', 'herdr'], ['default']).submitText(session(), 'hello')
    expect(result).toMatchObject({ state: 'unknown', dispatch: 'possibly_executed' })
    expect(second.submitText).not.toHaveBeenCalled()
  })

  it('allows read-only capture failover and refreshes a Herdr lease after a route move', async () => {
    const first = backend('tmux:default', vi.fn())
    first.capture = vi.fn(async () => ({ state: 'failed' as const, reason: 'capture failed' }))
    const second = backend('herdr:endpoint-a', vi.fn())
    second.capture = vi.fn(async () => ({ state: 'succeeded' as const, value: 'screen' }))
    const coordinator = new TerminalBackendCoordinator([first, second], ['tmux', 'herdr'], ['default'])
    const current = session()
    await expect(coordinator.capture(current)).resolves.toEqual({ state: 'succeeded', value: 'screen' })
    const acquired = await coordinator.acquireLease(current)
    expect(acquired.state).toBe('succeeded')
    if (acquired.state !== 'succeeded') return
    expect(coordinator.leaseIsCurrent(acquired.value, current)).toBe(true)
    current.runtimes = [herdr]
    current.primaryRuntimeKey = terminalRouteKey(herdr)
    const herdrLease = await coordinator.acquireLease(current)
    expect(herdrLease.state).toBe('succeeded')
    if (herdrLease.state !== 'succeeded') return
    current.runtimes[0] = { ...herdr, paneId: 'w2:p4' }
    current.primaryRuntimeKey = terminalRouteKey(current.runtimes[0])
    expect(coordinator.leaseIsCurrent(herdrLease.value, current)).toBe(true)
    expect(herdrLease.value.runtime).toMatchObject({ paneId: 'w2:p4', terminalId: 'terminal-a' })
  })

  it('uses lease-aware pre-dispatch fallback but never retries ambiguous completion', async () => {
    const first = backend('tmux:default', vi.fn(async () => ({ state: 'failed' as const, dispatch: 'rejected' as const, reason: 'rejected' })))
    const secondSubmit = vi.fn(async () => ({ state: 'succeeded' as const, dispatch: 'executed' as const }))
    const second = backend('herdr:endpoint-a', secondSubmit)
    const coordinator = new TerminalBackendCoordinator([first, second], ['tmux', 'herdr'], ['default'])
    const current = session()
    const acquired = await coordinator.acquireLease(current)
    expect(acquired.state).toBe('succeeded')
    if (acquired.state !== 'succeeded') return
    await expect(coordinator.submitTextForLease(current, acquired.value, 'hello')).resolves.toEqual({
      state: 'succeeded', dispatch: 'executed',
    })
    expect(acquired.value.runtime).toEqual(herdr)

    first.submitText = vi.fn(async () => ({ state: 'unknown' as const, dispatch: 'possibly_executed' as const, reason: 'lost response' }))
    const another = await coordinator.acquireLease(current)
    if (another.state !== 'succeeded') return
    secondSubmit.mockClear()
    await expect(coordinator.submitTextForLease(current, another.value, 'again')).resolves.toMatchObject({
      state: 'unknown', dispatch: 'possibly_executed',
    })
    expect(secondSubmit).not.toHaveBeenCalled()
  })

  it('never changes placement for a side effect issued through an already pinned multi-step lease', async () => {
    const firstSubmit = vi.fn(async () => ({ state: 'failed' as const, dispatch: 'rejected' as const, reason: 'rejected' }))
    const secondSubmit = vi.fn(async () => ({ state: 'succeeded' as const, dispatch: 'executed' as const }))
    const coordinator = new TerminalBackendCoordinator([
      backend('tmux:default', firstSubmit),
      backend('herdr:endpoint-a', secondSubmit),
    ], ['tmux', 'herdr'], ['default'])
    const acquired = await coordinator.acquireLease(session())
    expect(acquired.state).toBe('succeeded')
    if (acquired.state !== 'succeeded') return

    await expect(coordinator.submitTextLease(acquired.value, 'hello')).resolves.toMatchObject({
      state: 'failed', dispatch: 'rejected',
    })
    expect(firstSubmit).toHaveBeenCalledOnce()
    expect(secondSubmit).not.toHaveBeenCalled()
  })

  it('keeps an active lease valid when refreshed endpoint discovery reuses the same backend instance', async () => {
    const herdrBackend = backend('herdr:endpoint-a', vi.fn())
    const coordinator = new TerminalBackendCoordinator([herdrBackend], ['herdr'], ['default'])
    const current = session()
    current.runtimes = [herdr]
    current.primaryRuntimeKey = terminalRouteKey(herdr)
    const acquired = await coordinator.acquireLease(current)
    expect(acquired.state).toBe('succeeded')
    if (acquired.state !== 'succeeded') return

    coordinator.replaceBackends([herdrBackend])

    expect(coordinator.leaseIsCurrent(acquired.value, current)).toBe(true)
    await expect(coordinator.validateLease(acquired.value, current)).resolves.toBe(true)
  })
})
