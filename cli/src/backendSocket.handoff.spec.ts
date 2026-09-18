// remote_terminal_handoff through the socket a local client talks to: `harness remote`, typed in a
// tile, names the tile by its tmux pane; the daemon names the agent and tells every OTHER loopback
// client (the window) to swap the tile over. Loopback in, loopback out.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackendSocket } from './backendSocket.js'
import { terminalHandoffRequest } from './lib/terminalHandoff.js'

describe('remote_terminal_handoff on the local socket', () => {
  let socket: BackendSocket
  let cli: Array<{ type: string; payload: Record<string, unknown> }>
  let window: Array<{ type: string; payload: Record<string, unknown> }>
  beforeEach(() => {
    socket = new BackendSocket('token')
    cli = []
    window = []
    socket.registerLocalClient('local:cli', { sendFrame: (frame) => { cli.push(frame as (typeof cli)[number]); return true }, sendBinary: () => true })
    socket.registerLocalClient('local:window', { sendFrame: (frame) => { window.push(frame as (typeof window)[number]); return true }, sendBinary: () => true })
    socket.onTerminalHandoff = (tmuxPane) => (tmuxPane === '%7' ? 'agent-local-7' : null)
  })
  afterEach(async () => {
    await socket.unregisterLocalClient('local:cli')
    await socket.unregisterLocalClient('local:window')
    await socket.stop()
  })

  const ask = (payload: Record<string, unknown>): void => socket.handleLocalFrame('local:cli', { type: 'remote_terminal_handoff', payload })
  const replies = (): Array<Record<string, unknown>> => cli.filter((frame) => frame.type === 'remote_terminal_handoff_result').map((frame) => frame.payload)

  it('names the tile by its pane, pushes the swap to the other loopback clients, and says how many heard', async () => {
    ask({ requestId: 'h-1', tmuxPane: '%7', machineId: 'machine-b', agentId: 'agent-remote-1' })
    await vi.waitFor(() => expect(replies()).toHaveLength(1))
    expect(replies()[0]).toEqual({ requestId: 'h-1', ok: true, fromAgentId: 'agent-local-7', windows: 1 })
    expect(window.filter((frame) => frame.type === 'remote_terminal_handoff').map((frame) => frame.payload))
      .toEqual([{ fromAgentId: 'agent-local-7', machineId: 'machine-b', agentId: 'agent-remote-1' }])
  })

  it('a pane that is not a Harness tile is refused, and nothing is pushed', async () => {
    ask({ requestId: 'h-2', tmuxPane: '%9', machineId: 'machine-b', agentId: 'agent-remote-1' })
    await vi.waitFor(() => expect(replies()).toHaveLength(1))
    expect(replies()[0]).toMatchObject({ requestId: 'h-2', error: 'NOT_A_HARNESS_PANE' })
    expect(window.some((frame) => frame.type === 'remote_terminal_handoff')).toBe(false)
  })

  it('a malformed request is refused before the registry is asked', async () => {
    const asked = vi.fn(() => 'agent-local-7')
    socket.onTerminalHandoff = asked
    ask({ requestId: 'h-3', tmuxPane: 'not-a-pane', machineId: 'machine-b', agentId: 'agent-remote-1' })
    await vi.waitFor(() => expect(replies()).toHaveLength(1))
    expect(replies()[0]).toMatchObject({ requestId: 'h-3', error: 'INVALID_HANDOFF' })
    expect(asked).not.toHaveBeenCalled()
  })

  it('counts no windows when the CLI is the only loopback client', async () => {
    await socket.unregisterLocalClient('local:window')
    ask({ requestId: 'h-4', tmuxPane: '%7', machineId: 'machine-b', agentId: 'agent-remote-1' })
    await vi.waitFor(() => expect(replies()).toHaveLength(1))
    expect(replies()[0]).toMatchObject({ ok: true, windows: 0 })
    socket.registerLocalClient('local:window', { sendFrame: () => true, sendBinary: () => true })
  })
})

describe('terminalHandoffRequest', () => {
  it('takes a tmux pane id and two bounded ids, nothing else', () => {
    expect(terminalHandoffRequest({ tmuxPane: '%0', machineId: 'm-1', agentId: 'a_1' })).toEqual({ tmuxPane: '%0', machineId: 'm-1', agentId: 'a_1' })
    for (const bad of [
      { tmuxPane: '0', machineId: 'm', agentId: 'a' },
      { tmuxPane: '%1234567890', machineId: 'm', agentId: 'a' },
      { tmuxPane: '%1', machineId: '../m', agentId: 'a' },
      { tmuxPane: '%1', machineId: 'm', agentId: '' },
      { tmuxPane: '%1', machineId: 'm' },
    ]) expect(terminalHandoffRequest(bad), JSON.stringify(bad)).toBeNull()
  })
})
