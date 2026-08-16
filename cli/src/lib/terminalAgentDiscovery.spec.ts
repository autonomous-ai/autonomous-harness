import { describe, expect, it } from 'vitest'
import type { ProcessRow } from './tmux.js'
import { discoverTerminalAgentsFromSnapshot } from './terminalAgentDiscovery.js'
import { terminalRouteKey } from './terminalRuntime.js'
import type { TerminalRootObservation } from './terminalTypes.js'

const start = 'Sat Aug 15 10:00:00 2026'
const shell = (pid: number, parentPid: number): ProcessRow => ({ pid, parentPid, executable: 'bash', startMarker: start, args: 'bash' })
const claude = (pid: number, parentPid: number): ProcessRow => ({ pid, parentPid, executable: 'claude', startMarker: start, args: 'claude' })

const tmux: TerminalRootObservation = {
  runtime: { backend: 'tmux', paneId: '%1' }, rootPid: 10, cwd: '/work',
}
const herdr: TerminalRootObservation = {
  runtime: {
    backend: 'herdr', endpointId: 'endpoint-a', sessionName: 'default', terminalId: 'terminal-a', paneId: 'w1:p1',
  },
  rootPid: 20,
  cwd: '/work',
}

describe('backend-neutral process discovery', () => {
  it('deduplicates nested/coexisting roots by engine PID and start marker', () => {
    const result = discoverTerminalAgentsFromSnapshot(
      [tmux, herdr],
      [shell(10, 1), shell(20, 10), claude(30, 20)],
      999,
      ['tmux', 'herdr'],
      ['default'],
    )
    expect(result.agents).toHaveLength(1)
    expect(result.agents[0].runtimes).toHaveLength(2)
    expect(result.agents[0].primaryRuntimeKey).toBe(terminalRouteKey(herdr.runtime))
  })

  it('keeps duplicate public Herdr routes distinct across endpoints', () => {
    const second = {
      ...herdr,
      runtime: { ...herdr.runtime, endpointId: 'endpoint-b', sessionName: 'work', terminalId: 'terminal-b' },
      rootPid: 40,
    } as TerminalRootObservation
    const result = discoverTerminalAgentsFromSnapshot(
      [herdr, second],
      [shell(20, 1), claude(30, 20), shell(40, 1), claude(50, 40)],
      999,
      ['herdr'],
      ['default', 'work'],
    )
    expect(result.agents).toHaveLength(2)
    expect(result.agents.map((agent) => agent.primaryRuntimeKey)).toEqual([
      terminalRouteKey(herdr.runtime),
      terminalRouteKey(second.runtime),
    ])
  })

  it('chooses the nearest root before configured backend order', () => {
    const result = discoverTerminalAgentsFromSnapshot(
      [tmux, herdr],
      [shell(20, 1), shell(25, 20), shell(10, 25), claude(30, 10)],
      999,
      ['tmux', 'herdr'],
      ['default'],
    )
    expect(result.agents[0].primaryRuntimeKey).toBe(terminalRouteKey(tmux.runtime))
  })
})
