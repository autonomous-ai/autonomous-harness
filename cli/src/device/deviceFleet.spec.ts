// The fan-out between the machine list and the one device socket.
//
// The cases here are the ones that fail SILENTLY: a machine with no pinned key answering an empty
// carousel instead of an instruction, and another machine's turn card painting a tile on the machine the
// dial is actually showing.
import { describe, expect, it, vi } from 'vitest'

import { DeviceFleet } from './deviceFleet.js'
import { FleetError, type FleetEvent } from '../cable/machineFleet.js'
import type { DeviceFrame } from './deviceLink.js'

type Listed = { machineId: string; name: string; state: string; agentCount: number; authMode: string; local: boolean }

function listOf(rows: Partial<Listed>[]): Listed[] {
  return rows.map((r) => ({
    machineId: 'm1', name: 'office-imac', state: 'ready', authMode: 'remote', local: false, ...r,
  })) as Listed[]
}

function make(over: { rows?: Partial<Listed>[]; linked?: string[]; rpc?: (t: string, p: Record<string, unknown>) => Promise<Record<string, unknown>> } = {}) {
  const rows = listOf(over.rows ?? [{}])
  let frameCb: ((f: DeviceFrame) => void) | null = null
  const sent: DeviceFrame[] = []
  const link = {
    selectedMachine: 'm1',
    onFrame: (cb: (f: DeviceFrame) => void) => { frameCb = cb; return () => {} },
    attach: vi.fn(async () => {}),
    online: vi.fn(async () => {}),
    detach: vi.fn(),
    release: vi.fn(),
    send: (f: DeviceFrame) => { sent.push(f) },
    rpc: over.rpc ?? (async () => ({})),
  }
  const fleet = new DeviceFleet({
    list: {
      list: () => ({ machines: rows, source: 'backend' as const }),
      find: (id: string) => rows.find((r) => r.machineId === id),
    } as never,
    link: link as never,
    hasPeerLink: (id: string) => (over.linked ?? ['m1']).includes(id),
    log: () => {},
  })
  return { fleet, link, sent, say: (f: DeviceFrame) => frameCb?.(f) }
}

describe('DeviceFleet', () => {
  it('hides this computer from the fleet list — the host adds it back with real facts', async () => {
    const { fleet } = make({ rows: [{ machineId: 'mine', local: true }, { machineId: 'other' }], linked: ['other'] })
    const { machines } = await fleet.list()
    expect(machines.map((m) => m.machineId)).toEqual(['other'])
  })

  it('marks an unlinked remote machine needs-link instead of leaving it looking ready', async () => {
    // Reachable but unreadable: everything on it is encrypted to a key this daemon does not hold. Saying
    // "ready" would send the user into an empty carousel with nothing explaining it.
    const { fleet } = make({ rows: [{ machineId: 'm1', authMode: 'remote' }], linked: [] })
    const { machines } = await fleet.list()
    expect(machines[0].state).toBe('needs-link')
  })

  it('leaves a cloud machine alone — E2EE is a remote-machine rule, not a universal one', async () => {
    const { fleet } = make({ rows: [{ machineId: 'm1', authMode: 'managed' }], linked: [] })
    const { machines } = await fleet.list()
    expect(machines[0].state).toBe('ready')
  })

  it('refuses an unlinked select LOCALLY, without dialling anything', async () => {
    const { fleet, link } = make({ rows: [{ machineId: 'm1', name: 'imac', authMode: 'remote' }], linked: [] })
    await expect(fleet.select('m1')).rejects.toMatchObject({ code: 'NEEDS_LINK' })
    expect(link.attach).not.toHaveBeenCalled()   // the guide appears instantly, not after a doomed connect
  })

  it('refuses a machine that is not on the account', async () => {
    const { fleet } = make()
    await expect(fleet.select('nope')).rejects.toBeInstanceOf(FleetError)
  })

  it('maps the far end’s refusal onto a code and words a person can act on', async () => {
    const { fleet, link } = make()
    link.attach = vi.fn(async () => { throw new Error('NOT_YOUR_MACHINE') })
    await expect(fleet.select('m1')).rejects.toMatchObject({ code: 'NOT_YOURS' })
  })

  it('sends a turn in the shape the backend dispatches', async () => {
    const { fleet, sent } = make()
    fleet.sendTurn('m1', 'a1', 'ship it')
    expect(sent[0]).toMatchObject({ type: 'message', payload: { content: 'ship it', agentId: 'a1', resumeLatest: true } })
  })

  it('forwards a question answer keyed by the question keys', async () => {
    const { fleet, sent } = make()
    fleet.answer('m1', 'a1', 'req-1', { scope: 'wide' })
    expect(sent[0]).toMatchObject({ type: 'question_response', payload: { agentId: 'a1', requestId: 'req-1', answers: { scope: 'wide' } } })
  })

  it('turns an agents_list_result into tiles, chips and all', async () => {
    const { fleet } = make({
      rpc: async () => ({ agents: [{ id: 'a1', name: 'api refactor', engine: 'codex', selectedModel: 'runtime-v1:s1:codex:opus@high' }] }),
    })
    const agents = await fleet.listAgents('m1')
    expect(agents[0]).toMatchObject({ id: 'a1', name: 'api refactor', engine: 'codex', model: 'opus', effort: 'high' })
  })

  it('delivers a card from a machine the wheel is not pointed at, tagged with its own machine', () => {
    // The carousel spans machines, so a card from a background machine belongs to a tile that is on
    // screen. This used to be DROPPED — which, once every machine's agents share one carousel, is what a
    // tile stuck on "Working…" for a turn that finished minutes ago looks like from the outside.
    const { fleet, say } = make()
    const seen: FleetEvent[] = []
    fleet.onEvent((e) => seen.push(e))
    say({ type: 'commander_event', machineId: 'other', agentId: 'a1', payload: { kind: 'summary', recap: 'nope', text: 'b' } })
    expect(seen).toEqual([{ machineId: 'other', kind: 'summary', agentId: 'a1', text: 'b', recap: 'nope' }])

    say({ type: 'commander_event', machineId: 'm1', agentId: 'a1', payload: { kind: 'summary', recap: 'yes', text: 'body' } })
    expect(seen[1]).toEqual({ machineId: 'm1', kind: 'summary', agentId: 'a1', text: 'body', recap: 'yes' })
  })


  it('ignores card kinds the dial has no use for', () => {
    const { fleet, say } = make()
    const seen: FleetEvent[] = []
    fleet.onEvent((e) => seen.push(e))
    say({ type: 'commander_event', machineId: 'm1', agentId: 'a1', payload: { kind: 'tool', text: 'grep' } })
    expect(seen).toHaveLength(0)
  })

  it('surfaces a question and a presence flip', () => {
    const { fleet, say } = make()
    const seen: FleetEvent[] = []
    fleet.onEvent((e) => seen.push(e))
    say({ type: 'commander_question', machineId: 'm1', agentId: 'a1', payload: { requestId: 'r1', questions: [{ key: 'k' }] } })
    say({ type: 'node_status', machineId: 'm1', payload: { online: false } })
    expect(seen.map((e) => e.kind)).toEqual(['question', 'state'])
  })

  it('caches recaps so a redraw does not re-ask the far machine for every tile', async () => {
    const rpc = vi.fn(async () => ({ events: [{ kind: 'summary', recap: 'r', text: 't' }] }))
    const { fleet } = make({ rpc })
    await fleet.recentSummaries('m1', 'a1')
    await fleet.recentSummaries('m1', 'a1')
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('answers an empty history rather than throwing when a recap RPC fails', async () => {
    const { fleet } = make({ rpc: async () => { throw new Error('timed out') } })
    await expect(fleet.recentSummaries('m1', 'a1')).resolves.toEqual([])
  })

  it('selects THIS computer without asking for a pinned key', async () => {
    // Our own machine is `authMode: 'remote'` like any other computer-backed one and has no pin for
    // itself — nor does it need one: its agents are read in-process, never over the relay.
    const { fleet, link } = make({ rows: [{ machineId: 'mine', local: true, authMode: 'remote' }], linked: [] })
    await expect(fleet.select('mine')).resolves.toBeUndefined()
    expect(link.attach).toHaveBeenCalledWith('mine')
  })

  it('keeps the socket when the dial goes back to local, and drops it when the dial goes', () => {
    // Two different events. "Looked away" detaches from the machine but the wheel's dots must stay live;
    // "unplugged" takes the socket with it, because it was only ever held for the dial.
    const { fleet, link } = make()
    // Lingering: nothing happens yet, and when it does it DETACHES rather than closing.
    fleet.release(false)
    expect(link.release).not.toHaveBeenCalled()

    // Unplugged: the socket goes now.
    fleet.release(true)
    expect(link.release).toHaveBeenCalled()
    expect(link.detach).not.toHaveBeenCalled()
  })

  it('folds a live machines_status into the list and reports the change', () => {
    const rows = [{ machineId: 'm1', name: 'a', state: 'offline', authMode: 'remote', local: false }]
    const applied: unknown[] = []
    let frameCb!: (f: { type?: string; payload?: Record<string, unknown> }) => void
    const fleet = new DeviceFleet({
      list: {
        list: () => ({ machines: rows, source: 'backend' as const }),
        find: (id: string) => rows.find((r) => r.machineId === id),
        applyLive: (r: unknown) => { applied.push(r); return true },
      } as never,
      link: { selectedMachine: 'm1', onFrame: (cb: never) => { frameCb = cb; return () => {} } } as never,
      hasPeerLink: () => true,
      log: () => {},
    })
    const seen: string[] = []
    fleet.onEvent((e) => seen.push(e.kind))

    frameCb({ type: 'machines_status', payload: { statuses: [{ machineId: 'm1', online: true }] } })
    expect(applied).toHaveLength(1)
    expect(seen).toEqual(['state'])
  })

  it('does not filter machines_status by the selected machine', () => {
    // It is about the whole account, and it arrives while nothing at all is selected.
    let frameCb!: (f: { type?: string; machineId?: string; payload?: Record<string, unknown> }) => void
    const fleet = new DeviceFleet({
      list: { list: () => ({ machines: [], source: 'backend' as const }), find: () => undefined, applyLive: () => true } as never,
      link: { selectedMachine: 'm1', onFrame: (cb: never) => { frameCb = cb; return () => {} } } as never,
      hasPeerLink: () => true,
      log: () => {},
    })
    const seen: string[] = []
    fleet.onEvent((e) => seen.push(e.kind))
    frameCb({ type: 'machines_status', machineId: 'someone-else', payload: { statuses: [] } })
    expect(seen).toEqual(['state'])
  })

  it('reads nothing over the lane for THIS computer', async () => {
    // Selecting the local machine is an announcement, not an attach-to-read: its agents are in-process.
    // Asking the cloud round-trips to ourselves and is refused with E2EE_REQUIRED, because a
    // computer-backed machine is `authMode: 'remote'` — which is exactly what happened on hardware.
    const rpc = vi.fn(async () => ({ agents: [] }))
    const { fleet } = make({ rows: [{ machineId: 'mine', local: true, authMode: 'remote' }], linked: [], rpc })
    await fleet.select('mine')
    await new Promise((r) => setTimeout(r, 0))
    expect(rpc).not.toHaveBeenCalled()
  })

  it('drops our own cards when they come back the long way', () => {
    // Selecting the local machine attaches a commander to it, so everything this daemon emits is fanned
    // back down the socket — after the dial already had it in-process.
    const { fleet, say } = make({ rows: [{ machineId: 'mine', local: true }, { machineId: 'm1' }] })
    const seen: string[] = []
    fleet.onEvent((e) => seen.push(e.kind))
    say({ type: 'commander_event', machineId: 'mine', agentId: 'a1', payload: { kind: 'summary', recap: 'echo' } })
    expect(seen).toHaveLength(0)
  })
})
