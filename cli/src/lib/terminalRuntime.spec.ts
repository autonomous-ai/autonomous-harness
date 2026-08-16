import { describe, expect, it } from 'vitest'
import {
  mergeTerminalRuntimes,
  processIdentityKey,
  sameProcessIdentity,
  terminalPlacementKey,
  terminalRouteKey,
} from './terminalRuntime.js'
import type { HerdrRuntimeRef, TmuxRuntimeRef } from './terminalTypes.js'

const tmux: TmuxRuntimeRef = { backend: 'tmux', paneId: '%3' }
const herdr: HerdrRuntimeRef = {
  backend: 'herdr',
  endpointId: 'herdr:default:abc',
  sessionName: 'default',
  terminalId: 'terminal-1',
  paneId: 'w1:p1',
}

describe('terminal runtime identity', () => {
  it('scopes duplicate Herdr pane routes to their configured endpoint', () => {
    const other = { ...herdr, endpointId: 'herdr:work:def', sessionName: 'work' }
    expect(terminalRouteKey(herdr)).not.toBe(terminalRouteKey(other))
    expect(terminalPlacementKey(herdr)).not.toBe(terminalPlacementKey(other))
  })

  it('keeps Herdr placement stable while replacing a moved route', () => {
    const moved = { ...herdr, paneId: 'w2:p4' }
    expect(terminalPlacementKey(moved)).toBe(terminalPlacementKey(herdr))
    expect(terminalRouteKey(moved)).not.toBe(terminalRouteKey(herdr))
    expect(mergeTerminalRuntimes([tmux, herdr], [moved])).toEqual([moved, tmux])
  })

  it('keys process identity without treating argv-derived executable as authoritative', () => {
    const before = { pid: 42, executable: 'node', startMarker: 'Sat Aug 15 10:00:00 2026' }
    const renamed = { ...before, executable: 'agent title' }
    expect(sameProcessIdentity(before, renamed)).toBe(true)
    expect(processIdentityKey('claude', before)).toBe(processIdentityKey('claude', renamed))
  })

  it('rejects separator injection into stable keys', () => {
    expect(() => terminalRouteKey({ backend: 'tmux', paneId: '%1\u0000other' })).toThrow('invalid tmux pane id')
  })
})
