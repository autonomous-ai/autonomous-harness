import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { encodeTerminalHop, TerminalBinaryKind, TerminalHopDirection } from './terminalBinary.js'

const bus = vi.hoisted(() => ({
  publishDown: vi.fn(async () => 1),
}))

vi.mock('./bus.js', () => ({
  subscribeUp: async () => () => undefined,
  subscribeTerminalUp: async () => () => undefined,
  publishUp: async () => 1,
  publishDown: bus.publishDown,
  publishTerminalDown: async () => 1,
  setAgentClientCount: async () => undefined,
  getAgentClientTotals: async () => ({ ui: 0, commander: 0, commanderActive: 0 }),
  bumpCommanderJoinGeneration: async () => 1,
  getCommanderJoinGeneration: async () => 1,
}))

const { attachHubClient, deliverTerminalUpLocal, deliverUpLocal } = await import('./hub.js')

describe('terminal target routing', () => {
  const attached: Array<ReturnType<typeof attachHubClient>> = []
  const socket = (out: unknown[]): WebSocket => ({
    readyState: 1,
    send: (data: unknown) => { out.push(data) },
    on: () => undefined,
  } as unknown as WebSocket)

  beforeEach(() => {
    while (attached.length) attached.pop()!.detach()
    bus.publishDown.mockClear()
  })

  it('delivers ciphertext only to the addressed web connection', () => {
    const machineId = `terminal-target-${Date.now()}`
    const webSent: string[] = []
    const commanderSent: string[] = []
    const web = attachHubClient(socket(webSent), machineId, 'web')
    const commander = attachHubClient(socket(commanderSent), machineId, 'commander')
    attached.push(web, commander)

    deliverUpLocal(machineId, {
      targetConnId: web.connId,
      targetKind: 'web',
      webEligible: true,
      commanderEligible: false,
      frame: {
        type: 'terminal_output',
        payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'opaque' } },
      },
    })

    expect(webSent).toHaveLength(1)
    expect(webSent[0]).toContain('terminal_output')
    expect(commanderSent).toHaveLength(0)
  })

  it('delivers an opaque binary frame only to its addressed web connection', () => {
    const machineId = `terminal-binary-target-${Date.now()}`
    const webSent: unknown[] = []
    const otherSent: unknown[] = []
    const web = attachHubClient(socket(webSent), machineId, 'web')
    const other = attachHubClient(socket(otherSent), machineId, 'web')
    attached.push(web, other)
    const frame = Buffer.alloc(36)
    frame.write('HTRM')
    frame[4] = 3
    frame[5] = TerminalBinaryKind.output
    frame.writeUInt32BE(16, 16)
    const packet = encodeTerminalHop(
      TerminalHopDirection.up,
      web.connId,
      frame,
    )!

    deliverTerminalUpLocal(machineId, packet)

    expect(Buffer.from(webSent[0] as Uint8Array)).toEqual(frame)
    expect(otherSent).toHaveLength(0)
  })

  it('notifies Harness of the exact connId before a web route detaches', async () => {
    const machineId = `terminal-disconnect-${Date.now()}`
    const web = attachHubClient(socket([]), machineId, 'web')
    attached.push(web)

    web.detach()

    await vi.waitFor(() => {
      expect(bus.publishDown).toHaveBeenCalledWith(machineId, {
        connId: web.connId,
        frame: { type: '__client_disconnected', payload: {} },
      })
    })
    attached.pop()
  })
})
