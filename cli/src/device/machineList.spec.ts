// The machine list, and the one comparison the whole feature hangs on.
//
// `local` is derived, not declared, and getting it wrong is invisible: every machine — including this
// computer's own — silently reads as remote, so the dial's own row goes missing and the daemon opens a
// cloud socket to reach agents that are in this very process.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { MachineListCache, sameComputer } from './machineList.js'

const DIR = (): string => mkdtempSync(join(tmpdir(), 'machines-'))

/** The shape `GET /api/machines` actually answers with (MachineService.toOwner). */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { machineId: 'm1', computerId: 'aabbccdd', name: 'office-imac', status: 'running', agentCount: 3, authMode: 'remote', ...over }
}

function ok(machines: Record<string, unknown>[]) {
  return async () => ({ status: 200, body: { machines } as Record<string, unknown> })
}

describe('sameComputer', () => {
  it('matches across the dash-and-case difference between the two sides', () => {
    // The CLI mints a dashed randomUUID; the backend de-dashes and lowercases before storing. A raw ===
    // never matches, and the symptom is that this computer never recognises itself.
    expect(sameComputer('7C9E6679-7425-40DE-944B-E07FC1F90AE7', '7c9e6679742540de944be07fc1f90ae7')).toBe(true)
  })

  it('is false for two different computers, and for nothing at all', () => {
    expect(sameComputer('aaaa', 'bbbb')).toBe(false)
    expect(sameComputer('', '')).toBe(false)          // two blanks are not the same computer
    expect(sameComputer(undefined, 'aaaa')).toBe(false)
  })
})

describe('MachineListCache', () => {
  it('marks the row whose computerId is this computer as local', async () => {
    const cache = new MachineListCache(
      ok([row({ machineId: 'mine', computerId: 'AA-BB-CC-DD' }), row({ machineId: 'other', computerId: 'ffff' })]),
      () => 'aabbccdd',
      () => {},
      DIR(),
    )
    await cache.refresh()
    expect(cache.find('mine')?.local).toBe(true)
    expect(cache.find('other')?.local).toBe(false)
  })

  it('reads `status` as liveness', async () => {
    const cache = new MachineListCache(
      ok([row({ machineId: 'up', status: 'running' }), row({ machineId: 'down', status: 'stopped' }), row({ machineId: 'huh', status: '' })]),
      () => 'zzzz', () => {}, DIR(),
    )
    await cache.refresh()
    expect(cache.find('up')?.state).toBe('ready')
    expect(cache.find('down')?.state).toBe('offline')
    expect(cache.find('huh')?.state).toBe('unknown')
  })

  it('keeps the last known rows when the backend goes away, and stops calling them live', async () => {
    // The dial must still show the machines the user saw; what it must NOT do is keep claiming they are
    // reachable. Emptying the wheel on a network blip would read as "your machines are gone".
    let fail = false
    const cache = new MachineListCache(
      async () => { if (fail) throw new Error('ECONNREFUSED'); return { status: 200, body: { machines: [row()] } } },
      () => 'zzzz', () => {}, DIR(),
    )
    await cache.refresh()
    expect(cache.list().source).toBe('backend')

    fail = true
    await cache.refresh()
    expect(cache.list().machines).toHaveLength(1)
    expect(cache.list().source).toBe('local')
    expect(cache.find('m1')?.state).toBe('unknown')
  })

  it('reports signed-out on a 401, with no rows', async () => {
    const cache = new MachineListCache(async () => ({ status: 401, body: {} }), () => 'z', () => {}, DIR())
    await cache.refresh()
    expect(cache.list()).toEqual({ machines: [], source: 'signed-out' })
  })

  it('survives a daemon restart offline by reloading its cache — as unknown, never as live', async () => {
    const dir = DIR()
    const first = new MachineListCache(ok([row()]), () => 'zzzz', () => {}, dir)
    await first.refresh()

    const second = new MachineListCache(async () => { throw new Error('offline') }, () => 'zzzz', () => {}, dir)
    expect(second.find('m1')?.name).toBe('office-imac')
    expect(second.find('m1')?.state).toBe('unknown')
  })

  it('falls back to hostname, then to a short id, for a machine with no name', async () => {
    const cache = new MachineListCache(
      ok([row({ machineId: 'a', name: '', hostname: 'thinkpad' }), row({ machineId: 'bcdef0123', name: '', hostname: '' })]),
      () => 'z', () => {}, DIR(),
    )
    await cache.refresh()
    expect(cache.find('a')?.name).toBe('thinkpad')
    expect(cache.find('bcdef0123')?.name).toBe('machine-bcdef0')
  })

  it('drops a row with no machineId rather than carrying a blank one onto the wheel', async () => {
    const cache = new MachineListCache(ok([row(), row({ machineId: undefined })]), () => 'z', () => {}, DIR())
    await cache.refresh()
    expect(cache.list().machines).toHaveLength(1)
  })

  it('does not reject when the response is nonsense', async () => {
    const log = vi.fn()
    const cache = new MachineListCache(async () => ({ status: 200, body: { nope: true } }), () => 'z', log, DIR())
    await expect(cache.refresh()).resolves.toBeUndefined()
    expect(cache.list().source).toBe('local')
  })
})
