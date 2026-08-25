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

  it('drops a card tagged for a machine the dial is not showing', () => {
    // Agent ids are bare UUIDs with no machine component, so a stray card either paints the wrong tile or
    // none at all — and both look like the dial simply missing a turn.
    const { fleet, say } = make()
    const seen: FleetEvent[] = []
    fleet.onEvent((e) => seen.push(e))
    say({ type: 'commander_event', machineId: 'other', agentId: 'a1', payload: { kind: 'summary', recap: 'nope' } })
    expect(seen).toHaveLength(0)

    say({ type: 'commander_event', machineId: 'm1', agentId: 'a1', payload: { kind: 'summary', recap: 'yes', text: 'body' } })
    expect(seen).toEqual([{ machineId: 'm1', kind: 'summary', agentId: 'a1', text: 'body', recap: 'yes' }])
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
})
