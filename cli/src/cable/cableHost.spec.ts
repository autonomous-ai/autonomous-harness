// How the wheel's rows are composed: the local row, and the fleet's rows around it.
import { describe, expect, it, vi } from 'vitest'

import { DaemonCableHost, type CableHostWiring } from './cableHost.js'
import type { FleetMachine, MachineFleet } from './machineFleet.js'

const AGENTS: Array<{ agentId: string; registeredAt: number; active: boolean; terminalAvailable: boolean; engine: string }> = []
vi.mock('../lib/registry.js', () => ({
  registry: {
    list: () => AGENTS,
    active: () => AGENTS.filter((a) => a.active),
    advertised: () => AGENTS.filter((a) => a.terminalAvailable),
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
  const set = (rows: Array<{ agentId: string; registeredAt: number; active?: boolean; terminalAvailable?: boolean }>): void => {
    AGENTS.length = 0
    for (const r of rows) AGENTS.push({ engine: 'claude', active: true, terminalAvailable: true, ...r })
  }

  it('lists only terminal-available agents — including a dormant engine with a live pane', async () => {
    // Two surfaces reading one registry must not disagree about what is on it. A dead agent holding a tile
    // on the dial and nowhere else is a tile that cannot be driven and cannot be explained.
    set([
      { agentId: 'a', registeredAt: 1 },
      { agentId: 'b', registeredAt: 2, active: false },
      { agentId: 'stale', registeredAt: 3, terminalAvailable: false },
    ])
    const host = new DaemonCableHost(wiring())
    expect((await host.listAgents()).map((a) => a.id)).toEqual(['a', 'b'])
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

describe('DaemonCableHost.listAgents across machines', () => {
  /** A fleet whose remote agent lists are scripted per machine. */
  function crossFleet(byMachine: Record<string, Array<{ id: string; name: string }>>, machines = [REMOTE]): MachineFleet {
    const fleet = fleetOf(machines)
    fleet.listAgents = vi.fn(async (machineId: string) => (byMachine[machineId] ?? []) as never)
    fleet.sendTurn = vi.fn()
    fleet.stopTurn = vi.fn()
    fleet.recentSummaries = vi.fn(async () => [])
    return fleet
  }

  /** Two ticks: the first kicks the background refresh off, the second reads what it wrote. */
  async function settled(host: DaemonCableHost): Promise<Awaited<ReturnType<DaemonCableHost['listAgents']>>> {
    await host.listAgents()
    await new Promise((r) => setTimeout(r, 0))
    return host.listAgents()
  }

  it('puts this computer first and every other machine after it, in wheel order', async () => {
    // The order IS the contract: the dial swipes through it and the desktop app's rail reads top to
    // bottom in the same order, so the two surfaces can be compared by eye.
    AGENTS.length = 0
    AGENTS.push({ agentId: 'local-1', registeredAt: 1, active: true, terminalAvailable: true, engine: 'claude' })
    const second: FleetMachine = { machineId: 'third', name: 'studio', state: 'ready', authMode: 'remote' }
    const host = new DaemonCableHost(
      wiring(),
      crossFleet({ other: [{ id: 'r1', name: 'api' }], third: [{ id: 'r2', name: 'ui' }] }, [REMOTE, second]),
    )
    const agents = await settled(host)
    expect(agents.map((a) => a.id)).toEqual(['local-1', 'r1', 'r2'])
    expect(agents.map((a) => a.machine)).toEqual(['MacbookPro.local', 'office-imac', 'studio'])
    expect(agents.map((a) => a.machineId)).toEqual(['mine', 'other', 'third'])
  })

  it('keeps a machine\'s agents when the backend cannot be asked', async () => {
    // The failure this exists for, measured on the real dial: `unknown` means the backend could not be
    // reached — MachineListCache.degrade() marks EVERY machine with it in one go — and reading it as
    // "the machine is gone" emptied a remote machine off the carousel mid-session, silently, while the
    // window went on showing those agents.
    AGENTS.length = 0
    const machines: FleetMachine[] = [{ ...REMOTE }]
    const host = new DaemonCableHost(wiring(), crossFleet({ other: [{ id: 'r1', name: 'api' }] }, machines))
    expect((await settled(host)).map((a) => a.id)).toEqual(['r1'])

    machines[0].state = 'unknown'
    // Well past REMOTE_GRACE_MS: this is not a grace period, it is a different question.
    vi.setSystemTime(Date.now() + 10 * 60_000)
    expect((await settled(host)).map((a) => a.id)).toEqual(['r1'])
    vi.useRealTimers()
  })

  it('drops them when the machine itself says it is offline, and says so', async () => {
    AGENTS.length = 0
    const log = vi.fn()
    const machines: FleetMachine[] = [{ ...REMOTE }]
    const host = new DaemonCableHost(wiring({ log }), crossFleet({ other: [{ id: 'r1', name: 'api' }] }, machines))
    expect((await settled(host)).map((a) => a.id)).toEqual(['r1'])

    machines[0].state = 'offline'
    expect((await settled(host)).map((a) => a.id)).toEqual([])
    // An agent leaving the carousel is the one event that cannot be diagnosed from its absence.
    expect(log.mock.calls.flat().join('\n')).toContain('left the carousel')
  })

  it('holds a tile the window has open even when its machine goes offline', async () => {
    // The desk is the contract between the two screens. A hole in it makes a swipe skip a tile and an
    // agent chosen in the window have nowhere to land.
    AGENTS.length = 0
    const machines: FleetMachine[] = [{ ...REMOTE }]
    const host = new DaemonCableHost(wiring(), crossFleet({ other: [{ id: 'r1', name: 'api' }] }, machines))
    await settled(host)
    host.setDesk(['r1'])

    machines[0].state = 'offline'
    const agents = await settled(host)
    expect(agents.map((a) => a.id)).toEqual(['r1'])
    // Under the name and machine it was last seen with, not a placeholder.
    expect(agents[0]).toMatchObject({ name: 'api', machineId: 'other', machine: 'office-imac' })
    expect(host.knows('r1')).toBe(true)
  })

  it('lists every agent, marking the ones the carousel does not walk', async () => {
    // Ring first, then the rest — the session sends the count of the first
    // group, so the ORDER is the split. Every agent is still listed, because
    // the dial's own count and its switcher read this list.
    AGENTS.length = 0
    for (const agentId of ['a1', 'a2', 'a3', 'a4']) {
      AGENTS.push({ agentId, registeredAt: 1, active: true, terminalAvailable: true, engine: 'claude' })
    }
    const host = new DaemonCableHost(wiring())
    await settled(host)
    // Tiles at both ends of the list: a2 and a3 are between them, so neither is
    // reached by stepping off an edge.
    host.setDesk(['a1', 'a4'])

    const agents = await host.listAgents()
    expect(agents.map((a) => a.id)).toEqual(['a1', 'a4', 'a2', 'a3'])
    expect(agents.filter((a) => !a.offRing).map((a) => a.id)).toEqual(['a1', 'a4'])
    expect(agents.filter((a) => a.offRing).map((a) => a.id)).toEqual(['a2', 'a3'])
  })

  it('does not resurrect an agent that has no tile', async () => {
    // The memory is only a warrant for what the window is showing. An agent that was deleted must stay
    // deleted.
    AGENTS.length = 0
    const machines: FleetMachine[] = [{ ...REMOTE }]
    const host = new DaemonCableHost(wiring(), crossFleet({ other: [{ id: 'r1', name: 'api' }] }, machines))
    await settled(host)

    machines[0].state = 'offline'
    expect((await settled(host)).map((a) => a.id)).toEqual([])
    expect(host.knows('r1')).toBe(false)
  })

  it('sends a turn to the agent’s OWN machine, not to the selected one', async () => {
    // The single worst outcome this feature can produce is a turn delivered to a different computer, so
    // the routing is asserted with the wheel deliberately pointed somewhere else.
    AGENTS.length = 0
    const fleet = crossFleet({ other: [{ id: 'r1', name: 'api' }] })
    const host = new DaemonCableHost(wiring(), fleet)
    await settled(host)
    expect(host.isLocalSelected()).toBe(true)   // the wheel never moved

    host.sendTurn('r1', 'ship it')
    expect(fleet.sendTurn).toHaveBeenCalledWith('other', 'r1', 'ship it')
  })

  it('reports a dial focus with the machine that owns the agent', async () => {
    AGENTS.length = 0
    const focused = vi.fn()
    const host = new DaemonCableHost(
      wiring({ focused }),
      crossFleet({ other: [{ id: 'r1', name: 'api' }] }),
    )
    await settled(host)

    host.focus('r1')

    // No edge: the window has reported no tiles, so there is no desk to be off
    // the end of and nothing for it to replace.
    expect(focused).toHaveBeenCalledWith('other', 'r1', undefined)
  })

  it('tells the window which end of the desk an off-desk agent belongs to', async () => {
    // The dial never reports which way the thumb went. It does not have to: an
    // agent's side of the ring is the answer, and the ring is built here.
    AGENTS.length = 0
    for (const agentId of ['a1', 'a2', 'a3']) {
      AGENTS.push({ agentId, registeredAt: 1, active: true, terminalAvailable: true, engine: 'claude' })
    }
    const focused = vi.fn()
    const host = new DaemonCableHost(wiring({ focused }))
    await settled(host)

    host.setDesk(['a2'])
    await host.listAgents()

    host.focus('a3')
    expect(focused).toHaveBeenLastCalledWith(expect.any(String), 'a3', 'tail')
    host.focus('a1')
    expect(focused).toHaveBeenLastCalledWith(expect.any(String), 'a1', 'head')
    // On the desk already: the window focuses that tile rather than replacing
    // one, so there is no edge to name.
    host.focus('a2')
    expect(focused).toHaveBeenLastCalledWith(expect.any(String), 'a2', undefined)
  })

  it('pushes the agents in ring order, tiles first', async () => {
    AGENTS.length = 0
    for (const agentId of ['a1', 'a2', 'a3', 'a4']) {
      AGENTS.push({ agentId, registeredAt: 1, active: true, terminalAvailable: true, engine: 'claude' })
    }
    const host = new DaemonCableHost(wiring({}))
    await settled(host)

    host.setDesk(['a3', 'a1'])
    const ids = (await host.listAgents()).map((a) => a.id)
    // Tiles in TILE order in the middle; a2 is nearer a1's end walking back,
    // a4 nearer a3's end walking forward.
    expect(ids.slice(ids.indexOf('a3'), ids.indexOf('a3') + 2)).toEqual(['a3', 'a1'])
    expect(ids).toHaveLength(4)
    expect(new Set(ids).size).toBe(4)
  })

  it('does not guess a machine for an unknown dial focus', async () => {
    AGENTS.length = 0
    const focused = vi.fn()
    const host = new DaemonCableHost(wiring({ focused }), crossFleet({ other: [] }))
    await settled(host)

    host.focus('missing-agent')

    expect(focused).not.toHaveBeenCalled()
  })

  it('keeps a local agent local even while another machine is selected', async () => {
    AGENTS.length = 0
    AGENTS.push({ agentId: 'local-1', registeredAt: 1, active: true, terminalAvailable: true, engine: 'claude' })
    const sendTurn = vi.fn()
    const fleet = crossFleet({ other: [] })
    const host = new DaemonCableHost(wiring({ sendTurn }), fleet)
    await settled(host)
    await host.selectMachine('other')

    host.sendTurn('local-1', 'hello')
    expect(sendTurn).toHaveBeenCalledWith('local-1', 'hello')
    expect(fleet.sendTurn).not.toHaveBeenCalled()
  })

  it('drops a turn for an agent it has never listed rather than guessing a machine', async () => {
    // Falling back to the selected machine here is how a turn lands on the wrong computer. The local
    // wiring is the only safe default: it is the machine the cable can vouch for.
    AGENTS.length = 0
    const sendTurn = vi.fn()
    const fleet = crossFleet({ other: [{ id: 'r1', name: 'api' }] })
    const host = new DaemonCableHost(wiring({ sendTurn }), fleet)
    await settled(host)
    await host.selectMachine('other')

    host.sendTurn('ghost', 'where does this go?')
    expect(fleet.sendTurn).not.toHaveBeenCalled()
    expect(sendTurn).toHaveBeenCalledWith('ghost', 'where does this go?')
  })

  it('holds a machine’s last good list through a failure instead of blanking its tiles', async () => {
    AGENTS.length = 0
    const fleet = crossFleet({ other: [{ id: 'r1', name: 'api' }] })
    const host = new DaemonCableHost(wiring(), fleet)
    expect((await settled(host)).map((a) => a.id)).toEqual(['r1'])

    ;(fleet.listAgents as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('cloud blip'))
    // Date.now rather than fake timers: the refresh is paced by wall-clock comparisons, and faking the
    // whole timer wheel would also freeze the `setTimeout(0)` this test uses to let the refresh land.
    const real = Date.now
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => real() + 6_000)
    try {
      const agents = await settled(host)   // past the refresh cadence, well inside the grace period
      expect(agents.map((a) => a.id)).toEqual(['r1'])
    } finally {
      nowSpy.mockRestore()
    }
  })


  it('asks nothing of a machine that is not ready, and shows none of its agents', async () => {
    // An offline or unlinked machine costs a 15-second RPC timeout per round to learn nothing.
    AGENTS.length = 0
    const unlinked: FleetMachine = { machineId: 'other', name: 'office-imac', state: 'needs-link', authMode: 'remote' }
    const fleet = crossFleet({ other: [{ id: 'r1', name: 'api' }] }, [unlinked])
    const host = new DaemonCableHost(wiring(), fleet)
    expect(await settled(host)).toEqual([])
    expect(fleet.listAgents).not.toHaveBeenCalled()
  })
})
