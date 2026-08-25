// How the wheel's rows are composed: the local row, and the fleet's rows around it.
import { describe, expect, it, vi } from 'vitest'

import { DaemonCableHost, type CableHostWiring } from './cableHost.js'
import type { FleetMachine, MachineFleet } from './machineFleet.js'

const AGENTS: Array<{ agentId: string; registeredAt: number; active: boolean; engine: string }> = []
vi.mock('../lib/registry.js', () => ({
  registry: {
    list: () => AGENTS,
    active: () => AGENTS.filter((a) => a.active),
  },
  projectDisplayName: (s: { agentId: string }) => s.agentId,
}))

function wiring(over: Partial<CableHostWiring> = {}): CableHostWiring {
  return {
    machineName: () => 'MacbookPro.local',
    machineId: () => 'mine',
    computerId: () => 'abc-123',
    sendTurn: vi.fn(),
    stopTurn: vi.fn(),
    answer: vi.fn(),
    recent: () => [],
    log: vi.fn(),
    ...over,
  }
}

function fleetOf(machines: FleetMachine[]): MachineFleet {
  return {
    list: async () => ({ machines, source: 'backend' as const }),
    online: async () => {},
    select: async () => {},
    release: vi.fn(),
    listAgents: async () => [],
    sendTurn: vi.fn(), stopTurn: vi.fn(), answer: vi.fn(), updateAgent: vi.fn(),
    listModels: async () => [],
    recentSummaries: async () => [],
    onEvent: () => () => {},
  }
}

const REMOTE: FleetMachine = { machineId: 'other', name: 'office-imac', state: 'ready', authMode: 'remote' }

describe('DaemonCableHost.listMachines', () => {
  it('names the local row after the machine, and marks it local', async () => {
    // The row carries the machine's name; what identifies it as the cabled one is the `local` flag, which
    // the dial turns into the second line. Two facts, one field each.
    const host = new DaemonCableHost(wiring(), fleetOf([REMOTE]))
    const { machines } = await host.listMachines()
    expect(machines[0]).toMatchObject({ id: 'mine', name: 'MacbookPro.local', local: true, state: 'ready' })
  })

  it('puts the local row first and keeps the fleet’s rows after it', async () => {
    const host = new DaemonCableHost(wiring(), fleetOf([REMOTE]))
    const { machines } = await host.listMachines()
    expect(machines.map((m) => m.id)).toEqual(['mine', 'other'])
    expect(machines[1]).toMatchObject({ name: 'office-imac', local: false })
  })

  it('never lists this computer twice, and a rename on the account does not touch its label', async () => {
    // `GET /api/machines` contains this computer too. Letting that row through would put the same machine
    // on the wheel under two names, and the ✓ could only ever mark one of them.
    const dupe: FleetMachine = { machineId: 'mine', name: 'renamed-in-the-web-ui', state: 'offline', authMode: 'remote' }
    const host = new DaemonCableHost(wiring(), fleetOf([dupe, REMOTE]))
    const { machines } = await host.listMachines()
    expect(machines.map((m) => m.id)).toEqual(['mine', 'other'])
    expect(machines[0]).toMatchObject({ name: 'MacbookPro.local', state: 'ready' })
  })

  it('shows one row and says why when there is no fleet at all', async () => {
    const host = new DaemonCableHost(wiring())
    const { machines, source } = await host.listMachines()
    expect(source).toBe('signed-out')
    expect(machines).toHaveLength(1)
    expect(machines[0].local).toBe(true)
  })

  it('falls back to a placeholder id rather than an empty one', async () => {
    // A belt, not a mode: `harness start` refuses to run signed out and resolves the machineId before the
    // daemon spawns, so this should never happen. It is guarded because the alternative is silent — an
    // empty id renders a row that is tappable and can never be selected.
    const host = new DaemonCableHost(wiring({ machineId: () => '' }))
    const { machines } = await host.listMachines()
    expect(machines[0].id).toBe('cable:abc-123')
    expect(host.isLocalSelected()).toBe(true)
  })
})

describe('DaemonCableHost.listAgents', () => {
  const set = (rows: Array<{ agentId: string; registeredAt: number; active?: boolean }>): void => {
    AGENTS.length = 0
    for (const r of rows) AGENTS.push({ engine: 'claude', active: true, ...r })
  }

  it('lists only ACTIVE agents — the same set the web and the app are given', async () => {
    // Two surfaces reading one registry must not disagree about what is on it. A dead agent holding a tile
    // on the dial and nowhere else is a tile that cannot be driven and cannot be explained.
    set([{ agentId: 'a', registeredAt: 1 }, { agentId: 'b', registeredAt: 2, active: false }])
    const host = new DaemonCableHost(wiring())
    expect((await host.listAgents()).map((a) => a.id)).toEqual(['a'])
  })

  it('orders oldest first', async () => {
    set([{ agentId: 'new', registeredAt: 30 }, { agentId: 'old', registeredAt: 10 }, { agentId: 'mid', registeredAt: 20 }])
    const host = new DaemonCableHost(wiring())
    expect((await host.listAgents()).map((a) => a.id)).toEqual(['old', 'mid', 'new'])
  })

  it('breaks a tie by id, so the order never falls through to insertion order', async () => {
    // Without the tie-break the winner is whichever the Map happens to hold first — which differs between
    // daemon runs, so the web, the app and the dial would each show a different order for one registry.
    set([{ agentId: 'zz', registeredAt: 5 }, { agentId: 'aa', registeredAt: 5 }])
    const host = new DaemonCableHost(wiring())
    expect((await host.listAgents()).map((a) => a.id)).toEqual(['aa', 'zz'])

    set([{ agentId: 'aa', registeredAt: 5 }, { agentId: 'zz', registeredAt: 5 }])
    expect((await new DaemonCableHost(wiring()).listAgents()).map((a) => a.id)).toEqual(['aa', 'zz'])
  })
})

describe('the cloud lane follows the CABLE, not the selection', () => {
  const remoteFleet = () => {
    const f = fleetOf([REMOTE])
    f.online = vi.fn(async () => {})
    f.select = vi.fn(async () => {})
    f.release = vi.fn()
    return f
  }

  it('drops the lane the moment the dial goes away', async () => {
    // Held on the dial's behalf and used by nothing else here. Keeping it open leaves the account showing
    // a device attached to a machine while the dial sits unplugged in a drawer, with that machine's cards
    // relayed to a screen that is not there.
    const fleet = remoteFleet()
    const host = new DaemonCableHost(wiring(), fleet)
    await host.selectMachine('other')

    host.onDialGone()
    expect(fleet.release).toHaveBeenCalledWith(true)   // true = now, not after the linger
  })

  it('drops it even when the dial was on the local machine — cancelling a linger', () => {
    const fleet = remoteFleet()
    const host = new DaemonCableHost(wiring(), fleet)
    host.onDialGone()
    expect(fleet.release).toHaveBeenCalledWith(true)
  })

  it('opens the socket the moment the dial appears, whatever is selected', async () => {
    // The whole point: plugged in means online. The wheel's dots are live from that moment, instead of
    // waiting for the user to pick a machine that is not this computer.
    const fleet = remoteFleet()
    const host = new DaemonCableHost(wiring(), fleet)
    host.onDialAttached()
    await new Promise((r) => setTimeout(r, 0))
    expect(fleet.online).toHaveBeenCalled()
  })

  it('announces the selected machine on attach — including the local one', async () => {
    // `DeviceBinding.activeMachineId` is what the web and the mobile app read to say where a dial is.
    // Skipping the local machine leaves it naming whatever was selected last, forever.
    const fleet = remoteFleet()
    const host = new DaemonCableHost(wiring(), fleet)
    host.onDialAttached()
    await new Promise((r) => setTimeout(r, 0))
    expect(fleet.select).toHaveBeenCalledWith('mine')
  })

  it('announces a remote selection after a replug', async () => {
    const fleet = remoteFleet()
    const host = new DaemonCableHost(wiring(), fleet)
    await host.selectMachine('other')
    ;(fleet.select as ReturnType<typeof vi.fn>).mockClear()

    host.onDialAttached()
    await new Promise((r) => setTimeout(r, 0))
    expect(fleet.select).toHaveBeenCalledWith('other')
  })

  it('announces nothing for the placeholder id — it is not a machineId', async () => {
    const fleet = remoteFleet()
    const host = new DaemonCableHost(wiring({ machineId: () => '' }), fleet)
    host.onDialAttached()
    await new Promise((r) => setTimeout(r, 0))
    expect(fleet.online).toHaveBeenCalled()
    expect(fleet.select).not.toHaveBeenCalled()
  })

  it('survives a lane that will not reopen, instead of rejecting into the greeting', async () => {
    const fleet = remoteFleet()
    const host = new DaemonCableHost(wiring(), fleet)
    await host.selectMachine('other')
    ;(fleet.select as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('unreachable'))

    expect(() => host.onDialAttached()).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))   // let the rejection land on its catch
  })
})
