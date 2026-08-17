import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessRow } from './tmux.js'
import type { TerminalBackend } from './terminalBackend.js'
import type { TerminalRootObservation, TerminalRuntimeRef } from './terminalTypes.js'

/**
 * The gateway flag has to ride the LIVE discovery path, not just the tmux-only one it was born on.
 *
 * This is the regression that a backend refactor produces for free: `probeTmuxAgents` keeps its probe
 * and its tests keep passing, while the reconciler has quietly moved to `probeTerminalAgents` and every
 * agent arrives with `gateway: undefined`. Nothing goes red — an `ori claude` pane just starts offering
 * the native Claude catalog again, accepts `/model` it cannot honour, and loses its recap. So the wiring
 * is pinned here, on both backends, rather than the classifier (which `gatewayRuntime.spec.ts` covers).
 */

const probeGatewayRuntime = vi.hoisted(() => vi.fn())
const processRows = vi.hoisted(() => vi.fn())

vi.mock('./gatewayRuntime.js', () => ({ probeGatewayRuntime }))
vi.mock('./tmux.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./tmux.js')>(),
  processRows,
}))

const { probeTerminalAgents } = await import('./terminalAgentDiscovery.js')

const START = 'Sat Aug 15 10:00:00 2026'
const row = (pid: number, parentPid: number, executable: string, args = executable): ProcessRow =>
  ({ pid, parentPid, executable, startMarker: START, args })

const TMUX_RUNTIME: TerminalRuntimeRef = { backend: 'tmux', paneId: '%1' }
const HERDR_RUNTIME: TerminalRuntimeRef = {
  backend: 'herdr', endpointId: 'endpoint-a', sessionName: 'default', terminalId: 'terminal-a', paneId: 'w1:p1',
}

function backendWith(name: 'tmux' | 'herdr', instanceId: string, roots: TerminalRootObservation[]): TerminalBackend {
  return {
    name,
    instanceId,
    inventory: async () => ({ state: 'available', roots }),
  } as unknown as TerminalBackend
}

beforeEach(() => {
  probeGatewayRuntime.mockReset()
  processRows.mockReset()
})

describe('gateway detection on the live terminal discovery path', () => {
  it('marks an ori-launched engine under EITHER backend, from the process rather than the pane', async () => {
    processRows.mockResolvedValue([
      row(10, 1, 'bash'), row(30, 10, 'claude'),      // tmux pane %1
      row(20, 1, 'bash'), row(40, 20, 'codex'),       // herdr pane w1:p1
    ])
    probeGatewayRuntime.mockResolvedValue({ kind: 'ori', apiKey: 'sk-or-v1-test' })

    const probe = await probeTerminalAgents(
      [
        backendWith('tmux', 'tmux', [{ runtime: TMUX_RUNTIME, rootPid: 10, cwd: '/work' }]),
        backendWith('herdr', 'herdr:endpoint-a', [{ runtime: HERDR_RUNTIME, rootPid: 20, cwd: '/work' }]),
      ],
      ['tmux', 'herdr'],
      ['default'],
      999,
    )

    expect(probe.agents.map((agent) => agent.engine).sort()).toEqual(['claude', 'codex'])
    expect(probe.agents.every((agent) => agent.gateway === 'ori')).toBe(true)
    // Probed by process identity + argv — never by which multiplexer owns the pane.
    expect(probeGatewayRuntime).toHaveBeenCalledTimes(2)
    for (const [identity, args] of probeGatewayRuntime.mock.calls) {
      expect(identity).toMatchObject({ startMarker: START })
      expect(typeof args).toBe('string')
    }
  })

  it('leaves a vendor login alone, and leaves an unreadable probe undefined', async () => {
    processRows.mockResolvedValue([row(10, 1, 'bash'), row(30, 10, 'claude')])
    const backends = [backendWith('tmux', 'tmux', [{ runtime: TMUX_RUNTIME, rootPid: 10, cwd: '/work' }])]

    probeGatewayRuntime.mockResolvedValue({ kind: null })
    const vendor = await probeTerminalAgents(backends, ['tmux'], [], 999)
    expect(vendor.agents[0].gateway).toBeNull()

    // `{ kind: null }` from a FAILED read is the same shape, so the reconciler's contract is what keeps
    // an agent from being downgraded: registry.updateProcessIdentity only writes a defined value.
    probeGatewayRuntime.mockResolvedValue({ kind: null })
    const unreadable = await probeTerminalAgents(backends, ['tmux'], [], 999)
    expect(unreadable.agents[0].gateway).not.toBe('ori')
  })

  it('does not probe when the process table is unavailable', async () => {
    processRows.mockResolvedValue(null)
    const probe = await probeTerminalAgents(
      [backendWith('tmux', 'tmux', [{ runtime: TMUX_RUNTIME, rootPid: 10, cwd: '/work' }])],
      ['tmux'],
      [],
      999,
    )
    expect(probe.processTableAvailable).toBe(false)
    expect(probeGatewayRuntime).not.toHaveBeenCalled()
  })
})
