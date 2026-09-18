// `harness remote`: the picker on a fake tty, the loopback calls against a fake daemon socket, and the
// lines it says when something on the way refuses.
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  LoopbackClient, LoopbackError, handoffTerminal, openRemoteTerminal, orderForPicker, pickMachine, remoteCommand, remoteFailureLine,
  type LoopbackSocket, type RemoteCommandDeps, type RemoteMachineChoice,
} from './remoteCommand.js'

const machines: RemoteMachineChoice[] = [
  { machineId: 'this-mac', label: 'MacbookPro.local', status: 'running', current: true },
  { machineId: 'box-1', label: 'machine-remote-1', status: 'offline', current: false },
  { machineId: 'box-2', label: 'machine-remote-2', status: 'running', current: false },
]

/** A tty for the picker: keys go in as the escape sequences a terminal sends, output is captured. */
function tty(): { input: RemoteCommandDeps['input']; output: RemoteCommandDeps['output']; written: () => string; press: (...keys: string[]) => void } {
  const input = new PassThrough() as unknown as RemoteCommandDeps['input'] & { setRawMode: (raw: boolean) => void }
  input.isTTY = true
  input.setRawMode = vi.fn()
  const chunks: string[] = []
  const output = new PassThrough() as unknown as RemoteCommandDeps['output']
  output.isTTY = true
  output.on('data', (chunk: Buffer) => chunks.push(chunk.toString()))
  const codes: Record<string, string> = { up: '\x1b[A', down: '\x1b[B', enter: '\r', esc: '\x1b', q: 'q', j: 'j', k: 'k', 'ctrl-c': '\x03' }
  return {
    input, output,
    written: () => chunks.join(''),
    press: (...keys) => { for (const key of keys) (input as unknown as PassThrough).write(codes[key] ?? key) },
  }
}

/** The daemon's loopback end, as `harness remote` sees it: a socket per connection, scripted replies. */
class FakeDaemon {
  readonly sent: Array<{ type: string; payload: Record<string, unknown> }> = []
  constructor(private readonly answer: (socket: FakeSocket, frame: { type: string; payload: Record<string, unknown> }) => void) {}
  connect = (url: string): LoopbackSocket => {
    expect(url).toBe('ws://127.0.0.1:18473/api/local-ws')
    const socket = new FakeSocket((frame) => { this.sent.push(frame); this.answer(socket, frame) })
    setTimeout(() => socket.emit('open'), 0)
    return socket
  }
}

class FakeSocket extends EventEmitter implements LoopbackSocket {
  closed = false
  constructor(private readonly onSend: (frame: { type: string; payload: Record<string, unknown> }) => void) { super() }
  send(data: string): void { this.onSend(JSON.parse(data) as { type: string; payload: Record<string, unknown> }) }
  reply(type: string, payload: Record<string, unknown>): void { this.emit('message', JSON.stringify({ type, payload }), false) }
  close(): void { this.closed = true; this.emit('close', 1000, '') }
}

/** The daemon as it behaves when everything works: selects, creates, hands off. */
function workingDaemon(windows = 1): FakeDaemon {
  return new FakeDaemon((socket, frame) => {
    if (frame.type === 'machine_select') socket.reply('connected', { machineId: frame.payload.machineId })
    if (frame.type === 'agent_create') socket.reply('agent_create_result', { requestId: frame.payload.requestId, agent: { id: 'agent-remote-1', engine: frame.payload.engine } })
    if (frame.type === 'remote_terminal_handoff') socket.reply('remote_terminal_handoff_result', { requestId: frame.payload.requestId, ok: true, fromAgentId: 'agent-local-7', windows })
  })
}

function deps(overrides: Partial<RemoteCommandDeps> = {}): RemoteCommandDeps & { errors: string[]; io: ReturnType<typeof tty>; links: string[] } {
  const io = tty()
  const errors: string[] = []
  const links: string[] = []
  return {
    tmuxPane: '%7',
    localMachineId: 'this-mac',
    port: 18473,
    daemonRunning: () => true,
    listMachines: async () => machines,
    isLinked: () => true,
    link: async (machineId, password) => { links.push(`${machineId}:${password}`); return { ok: true, fingerprint: 'AB:CD' } },
    promptPassword: async () => 'hunter2',
    input: io.input,
    output: io.output,
    error: (line) => errors.push(line),
    connect: workingDaemon().connect,
    ...overrides,
    errors,
    io,
    links,
  }
}

describe('pickMachine', () => {
  it('starts on the first online machine, says Online/Offline on every row, moves with the arrows, and takes Enter', async () => {
    const io = tty()
    const picked = pickMachine(machines.filter((m) => !m.current), io)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(io.written()).toContain('❯ machine-remote-2  Online')
    expect(io.written()).toContain('  machine-remote-1  Offline')
    io.press('up')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(io.written().split('❯ ').at(-1)).toMatch(/^machine-remote-1/)
    io.press('down', 'enter')
    expect(await picked).toEqual(machines[2])
  })

  it('an offline machine cannot be taken: Enter says so and the list stays', async () => {
    const io = tty()
    const picked = pickMachine(machines.filter((m) => !m.current), io)
    await new Promise((resolve) => setTimeout(resolve, 5))
    io.press('up', 'enter')  // onto machine-remote-1 (offline)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(io.written()).toContain('machine-remote-1 is offline. Run `harness start` there, or choose an online machine.')
    io.press('down', 'enter')
    expect(await picked).toEqual(machines[2])
  })

  it('wraps at both ends and also answers to j and k', async () => {
    const io = tty()
    const picked = pickMachine(machines.filter((m) => !m.current), io)
    await new Promise((resolve) => setTimeout(resolve, 5))
    io.press('j', 'j', 'k', 'k', 'k', 'k', 'enter')  // 2→1→2→1→2→1→2
    expect(await picked).toEqual(machines[2])
  })

  it('Esc, q and Ctrl-C leave with nothing chosen', async () => {
    for (const key of ['esc', 'q', 'ctrl-c']) {
      const io = tty()
      const picked = pickMachine(machines.filter((m) => !m.current), io)
      await new Promise((resolve) => setTimeout(resolve, 5))
      io.press(key)
      expect(await picked, key).toBeNull()
    }
  })
})

describe('orderForPicker', () => {
  it('lists the online machines first, keeping each group in the order the account gave', () => {
    const rows: RemoteMachineChoice[] = [
      { machineId: 'a', label: 'a', status: 'offline', current: false },
      { machineId: 'b', label: 'b', status: 'running', current: false },
      { machineId: 'c', label: 'c', status: 'offline', current: false },
      { machineId: 'd', label: 'd', status: 'online', current: false },
    ]
    expect(orderForPicker(rows).map((row) => row.machineId)).toEqual(['b', 'd', 'a', 'c'])
  })
})

describe('the loopback calls', () => {
  it('openRemoteTerminal selects the machine and creates a terminal agent at home', async () => {
    const daemon = workingDaemon()
    expect(await openRemoteTerminal({ port: 18473, connect: daemon.connect }, 'box-2')).toBe('agent-remote-1')
    expect(daemon.sent.map((frame) => frame.type)).toEqual(['machine_select', 'agent_create'])
    expect(daemon.sent[0].payload).toEqual({ machineId: 'box-2', localProtocolVersion: 1 })
    expect(daemon.sent[1].payload).toMatchObject({ engine: 'terminal', bypassPermission: false })
    expect(daemon.sent[1].payload).not.toHaveProperty('cwd')
  })

  it('handoffTerminal selects this machine and names the pane', async () => {
    const daemon = workingDaemon(2)
    const result = await handoffTerminal({ port: 18473, connect: daemon.connect }, 'this-mac', { tmuxPane: '%7', machineId: 'box-2', agentId: 'agent-remote-1' })
    expect(result).toEqual({ fromAgentId: 'agent-local-7', windows: 2 })
    expect(daemon.sent[0].payload.machineId).toBe('this-mac')
    expect(daemon.sent[1].payload).toMatchObject({ tmuxPane: '%7', machineId: 'box-2', agentId: 'agent-remote-1' })
  })

  it('a machine the daemon closes on with 4404 is NO_PEER_LINK; a reply with error is thrown by code', async () => {
    const unlinked = new FakeDaemon((socket, frame) => { if (frame.type === 'machine_select') { socket.emit('close', 4404, 'NO_PEER_LINK') } })
    await expect(openRemoteTerminal({ port: 18473, connect: unlinked.connect }, 'box-1')).rejects.toMatchObject({ code: 'NO_PEER_LINK' })
    const refusing = new FakeDaemon((socket, frame) => {
      if (frame.type === 'machine_select') socket.reply('connected', {})
      if (frame.type === 'agent_create') socket.reply('agent_create_result', { requestId: frame.payload.requestId, error: 'INVALID_ENGINE', detail: 'no' })
    })
    await expect(openRemoteTerminal({ port: 18473, connect: refusing.connect }, 'box-1')).rejects.toMatchObject({ code: 'INVALID_ENGINE', message: 'no' })
  })

  it('a daemon that never answers is a TIMEOUT, not a hang', async () => {
    const silent = new FakeDaemon(() => {})
    const client = new LoopbackClient('ws://127.0.0.1:18473/api/local-ws', silent.connect)
    await expect(client.select('box-1', 30)).rejects.toMatchObject({ code: 'TIMEOUT' })
    client.close()
  })
})

describe('remoteCommand', () => {
  it('outside a Harness tile it says where it works and does nothing', async () => {
    for (const tmuxPane of [undefined, '', '%x']) {
      const d = deps({ tmuxPane })
      expect(await remoteCommand(d)).toBe(1)
      expect(d.errors[0]).toContain('inside a Harness terminal tile')
      expect(d.io.written()).toBe('')
    }
  })

  it('needs the daemon, a sign-in, and another machine', async () => {
    const down = deps({ daemonRunning: () => false })
    expect(await remoteCommand(down)).toBe(1)
    expect(down.errors[0]).toContain('harness start')
    const signedOut = deps({ localMachineId: null })
    expect(await remoteCommand(signedOut)).toBe(1)
    expect(signedOut.errors[0]).toContain('harness login')
    const alone = deps({ listMachines: async () => [machines[0]] })
    expect(await remoteCommand(alone)).toBe(1)
    expect(alone.errors[0]).toContain('No other machines')
    const allOffline = deps({ listMachines: async () => [machines[0], machines[1]] })
    expect(await remoteCommand(allOffline)).toBe(1)
    expect(allOffline.errors[0]).toContain('No other machine is online right now (machine-remote-1)')
  })

  it('a machine not linked yet is linked first, with its remote password', async () => {
    const daemon = workingDaemon()
    const d = deps({ connect: daemon.connect, isLinked: () => false })
    const run = remoteCommand(d)
    await new Promise((resolve) => setTimeout(resolve, 5))
    d.io.press('enter')
    expect(await run).toBe(0)
    expect(d.links).toEqual(['box-2:hunter2'])
    expect(d.io.written()).toContain('machine-remote-2 is not linked to this computer yet.')
    expect(d.io.written()).toContain('✓ Linked machine-remote-2 (fingerprint AB:CD)')
    expect(d.io.written()).toContain('Terminal opened on machine-remote-2. Switching this tile…')
  })

  it('an empty password, or a link the other machine refuses, stops before anything opens', async () => {
    const daemon = workingDaemon()
    const empty = deps({ connect: daemon.connect, isLinked: () => false, promptPassword: async () => '  ' })
    const emptyRun = remoteCommand(empty)
    await new Promise((resolve) => setTimeout(resolve, 5))
    empty.io.press('enter')
    expect(await emptyRun).toBe(1)
    expect(empty.errors[0]).toContain('No password entered')
    expect(daemon.sent).toEqual([])
    const refused = deps({ connect: daemon.connect, isLinked: () => false, link: async () => ({ ok: false, message: 'Wrong password for machine-remote-2.' }) })
    const refusedRun = remoteCommand(refused)
    await new Promise((resolve) => setTimeout(resolve, 5))
    refused.io.press('enter')
    expect(await refusedRun).toBe(1)
    expect(refused.errors[0]).toContain('Wrong password')
    expect(daemon.sent).toEqual([])
  })

  it('picks, opens the terminal there, hands the tile over, and says so', async () => {
    const daemon = workingDaemon()
    const d = deps({ connect: daemon.connect })
    const run = remoteCommand(d)
    await new Promise((resolve) => setTimeout(resolve, 5))
    d.io.press('enter')  // the first online one: machine-remote-2
    expect(await run).toBe(0)
    expect(d.errors).toEqual([])
    expect(d.io.written()).toContain('Opening a terminal on machine-remote-2')
    expect(d.io.written()).toContain('Terminal opened on machine-remote-2. Switching this tile…')
    expect(daemon.sent.map((frame) => frame.type)).toEqual(['machine_select', 'agent_create', 'machine_select', 'remote_terminal_handoff'])
  })

  it('cancelling is exit 0 and no call', async () => {
    const daemon = workingDaemon()
    const d = deps({ connect: daemon.connect })
    const run = remoteCommand(d)
    await new Promise((resolve) => setTimeout(resolve, 5))
    d.io.press('esc')
    expect(await run).toBe(0)
    expect(d.io.written()).toContain('Cancelled.')
    expect(daemon.sent).toEqual([])
  })

  it('with no window listening the terminal is still open, and it says where to find it', async () => {
    const d = deps({ connect: workingDaemon(0).connect })
    const run = remoteCommand(d)
    await new Promise((resolve) => setTimeout(resolve, 5))
    d.io.press('enter')
    expect(await run).toBe(0)
    expect(d.io.written()).toContain('No Harness window is open here')
  })

  it('a pin the daemon does not accept is linked again, once, and the open retried', async () => {
    let dials = 0
    const daemon = new FakeDaemon((socket, frame) => {
      if (frame.type === 'machine_select' && frame.payload.machineId === 'box-2' && ++dials === 1) { socket.emit('close', 4404, 'NO_PEER_LINK'); return }
      if (frame.type === 'machine_select') socket.reply('connected', {})
      if (frame.type === 'agent_create') socket.reply('agent_create_result', { requestId: frame.payload.requestId, agent: { id: 'agent-remote-1' } })
      if (frame.type === 'remote_terminal_handoff') socket.reply('remote_terminal_handoff_result', { requestId: frame.payload.requestId, ok: true, fromAgentId: 'a', windows: 1 })
    })
    const d = deps({ connect: daemon.connect })  // isLinked says yes; the daemon disagrees
    const run = remoteCommand(d)
    await new Promise((resolve) => setTimeout(resolve, 5))
    d.io.press('enter')
    expect(await run).toBe(0)
    expect(d.links).toEqual(['box-2:hunter2'])
    expect(d.io.written()).toContain('Terminal opened on machine-remote-2. Switching this tile…')
    // And when the second link is refused too, the command says what to run.
    const stubborn = new FakeDaemon((socket, frame) => { if (frame.type === 'machine_select') socket.emit('close', 4404, 'NO_PEER_LINK') })
    const e = deps({ connect: stubborn.connect })
    const eRun = remoteCommand(e)
    await new Promise((resolve) => setTimeout(resolve, 5))
    e.io.press('enter')
    expect(await eRun).toBe(1)
    expect(e.errors[0]).toContain('harness link connect box-2')
  })

  it('remoteFailureLine puts the daemon\'s codes into words', () => {
    const box = machines[1]
    expect(remoteFailureLine(new LoopbackError('NOT_A_HARNESS_PANE'), box)).toContain('inside a Harness terminal')
    expect(remoteFailureLine(new LoopbackError('DAEMON_UNREACHABLE', 'ECONNREFUSED'), box)).toContain('harness start')
    expect(remoteFailureLine(new LoopbackError('WEIRD', 'because'), box)).toBe('WEIRD: because')
    expect(remoteFailureLine(new Error('plain'), box)).toBe('plain')
  })
})
