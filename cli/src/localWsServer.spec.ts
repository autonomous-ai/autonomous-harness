import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { Frame, LocalClientSink } from './backendSocket.js'
import { attachLocalWsServer, type LocalWsBackend, type LocalWsServer } from './localWsServer.js'
import { encodeTerminalLocal, TerminalBinaryKind, type TerminalBinaryClear } from './lib/terminalBinary.js'

const machineId = 'machine-123'
const streamId = '00112233-4455-6677-8899-aabbccddeeff'

class FakeBackend implements LocalWsBackend {
  sink: LocalClientSink | null = null
  connId: string | null = null
  frames: Frame[] = []
  binaries: TerminalBinaryClear[] = []
  unregisters: string[] = []

  registerLocalClient(connId: string, sink: LocalClientSink): boolean {
    this.connId = connId
    this.sink = sink
    return true
  }
  async unregisterLocalClient(connId: string): Promise<void> {
    this.unregisters.push(connId)
  }
  handleLocalFrame(_connId: string, frame: Frame): void {
    this.frames.push(frame)
  }
  async handleLocalBinary(_connId: string, frame: TerminalBinaryClear): Promise<void> {
    this.binaries.push(frame)
  }
}

function onceOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
}

function onceMessage(ws: WebSocket): Promise<Frame> {
  return new Promise((resolve, reject) => {
    ws.once('message', (raw) => {
      try { resolve(JSON.parse(raw.toString()) as Frame) } catch (error) { reject(error) }
    })
    ws.once('error', reject)
  })
}

describe('local CLI WebSocket', () => {
  let server: http.Server | null = null
  let local: LocalWsServer | null = null

  afterEach(async () => {
    await local?.close()
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve())
    local = null
    server = null
  })

  async function start(backend: FakeBackend): Promise<string> {
    server = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    local = attachLocalWsServer(server, { machineId, backend })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    return `ws://127.0.0.1:${port}/api/local-ws`
  }

  it('accepts loopback, selects the exact machine, and routes JSON plus HTRL binary', async () => {
    const backend = new FakeBackend()
    const url = await start(backend)
    const ws = new WebSocket(url)
    await onceOpen(ws)
    const connected = onceMessage(ws)
    ws.send(JSON.stringify({
      type: 'machine_select',
      payload: { machineId, localProtocolVersion: 1 },
    }))
    await expect(connected).resolves.toMatchObject({
      type: 'connected',
      payload: { machineId, transport: 'local', e2ee: false },
    })

    ws.send(JSON.stringify({ type: 'agents_list', payload: { requestId: 'r1' } }))
    const binary = encodeTerminalLocal({
      kind: TerminalBinaryKind.input,
      streamId,
      seq: 1,
      bytes: new TextEncoder().encode('hello'),
      compressed: false,
    })!
    ws.send(binary)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(backend.frames).toEqual([{ type: 'agents_list', payload: { requestId: 'r1' } }])
    expect(backend.binaries[0]).toMatchObject({
      kind: TerminalBinaryKind.input,
      streamId,
      seq: 1,
    })

    const reply = onceMessage(ws)
    expect(backend.sink?.sendFrame({ type: 'agents_list_result', payload: { requestId: 'r1', agents: [] } })).toBe(true)
    await expect(reply).resolves.toMatchObject({ type: 'agents_list_result' })
    ws.close()
  })

  it('takes the window\'s tile roster, keeps it off the wire, and forgets it on close', async () => {
    const backend = new FakeBackend()
    const rosters: string[][] = []
    server = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    local = attachLocalWsServer(server, {
      machineId,
      backend,
      onAppPanes: (ids) => rosters.push(ids),
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-ws`

    const ws = new WebSocket(url)
    await onceOpen(ws)
    const connected = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
    await connected

    ws.send(JSON.stringify({ type: 'app_panes', payload: { agentIds: ['a1', 'a2', '', 7, null] } }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Anything that is not a usable id is dropped rather than trusted.
    expect(rosters).toEqual([['a1', 'a2']])
    // Like app_focus: it describes a screen at this desk, so the machine never sees it.
    expect(backend.frames.map((frame) => frame.type)).toEqual([])

    ws.close()
    // A window that went away has no tiles open. Left standing, the roster would go on silencing the
    // dial for agents nobody can see any more — backwards, and permanently.
    await vi.waitFor(() => expect(rosters).toEqual([['a1', 'a2'], []]))
  })

  it('follows an explicit app_focus, and keeps it off the wire', async () => {
    const backend = new FakeBackend()
    const moves: Array<{ machineId: string; agentId: string }> = []
    server = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    local = attachLocalWsServer(server, {
      machineId,
      backend,
      onAppFocus: (m, a) => moves.push({ machineId: m, agentId: a }),
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-ws`

    const ws = new WebSocket(url)
    await onceOpen(ws)
    const connected = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
    await connected

    // Opening a terminal still counts: that is all an older app build sends.
    ws.send(JSON.stringify({ type: 'terminal_open', payload: { agentId: 'agent-opened' } }))
    // And a window that MOVED without opening anything now says so — which is every click on a pane
    // that already holds a live session, the case the dial used to miss entirely.
    ws.send(JSON.stringify({ type: 'app_focus', payload: { agentId: 'agent-focused' } }))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(moves).toEqual([
      { machineId, agentId: 'agent-opened' },
      { machineId, agentId: 'agent-focused' },
    ])
    // Consumed locally: it describes a hand at this desk, and the machine has no use for an unknown
    // frame type arriving on every pane click.
    expect(backend.frames.map((frame) => frame.type)).toEqual(['terminal_open'])
    ws.close()
  })

  it('carries the window\'s answer about a spoken task, and keeps it off the wire', async () => {
    const backend = new FakeBackend()
    const replies: Array<{ voiceId: string; reply: unknown }> = []
    server = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    local = attachLocalWsServer(server, {
      machineId,
      backend,
      onVoiceRouteReply: (voiceId, reply) => replies.push({ voiceId, reply }),
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-ws`

    const ws = new WebSocket(url)
    await onceOpen(ws)
    const connected = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
    await connected

    ws.send(JSON.stringify({ type: 'voice_route_reply', payload: { voiceId: 'v1', state: 'taken' } }))
    ws.send(JSON.stringify({ type: 'voice_route_reply', payload: { voiceId: 'v1', state: 'sent', agentId: 'a7' } }))
    ws.send(JSON.stringify({ type: 'voice_route_reply', payload: { voiceId: 'v2', state: 'cancelled' } }))
    // Neither of these is an answer: one names no request, the other a state this side cannot read.
    // Guessing at either would settle a spoken turn on something nobody said.
    ws.send(JSON.stringify({ type: 'voice_route_reply', payload: { state: 'sent', agentId: 'a9' } }))
    ws.send(JSON.stringify({ type: 'voice_route_reply', payload: { voiceId: 'v3', state: 'maybe' } }))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(replies).toEqual([
      { voiceId: 'v1', reply: { t: 'taken' } },
      { voiceId: 'v1', reply: { t: 'sent', agentId: 'a7' } },
      { voiceId: 'v2', reply: { t: 'cancelled' } },
    ])
    // It describes a hand at this desk. The machine has no use for it.
    expect(backend.frames).toEqual([])
    ws.close()
  })

  it('answers a routed task on the id it was asked with, and sends nothing', async () => {
    const backend = new FakeBackend()
    const asked: string[] = []
    server = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    local = attachLocalWsServer(server, {
      machineId,
      backend,
      onRouteTask: async (text) => {
        asked.push(text)
        return {
          agentId: 'a1', machineId: 'm-local', name: 'auth-api', confidence: 0.86, reason: 'name matches',
          weighed: 4, machines: 2, via: 'model',
          candidates: [{ agentId: 'a1', machineId: 'm-local', name: 'auth-api', machine: 'this computer', engine: 'claude', recent: 'token rotation', confidence: 0.86 }],
        }
      },
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-ws`

    const ws = new WebSocket(url)
    await onceOpen(ws)
    const connected = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
    await connected

    const answered = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'route_task', payload: { requestId: 'q-7', text: '  fix the retry  ' } }))
    const reply = await answered   // onceMessage already parses
    // The requestId comes back UNTOUCHED — it is the window's own rpc id, and the only thing tying this
    // answer to the spinner it is holding open.
    expect(reply.type).toBe('route_result')
    expect(reply.payload).toMatchObject({ requestId: 'q-7', agentId: 'a1', machineId: 'm-local', name: 'auth-api', confidence: 0.86 })
    expect(asked).toEqual(['fix the retry'])
    // Asking is not sending. Nothing reached the machine.
    expect(backend.frames.map((frame) => frame.type)).toEqual([])
    ws.close()
  })

  it('still answers when there is nothing to answer with', async () => {
    // The window holds a spinner on the id it asked with, so silence is the one reply it cannot recover
    // from — an empty task and a router that throws must both come back as frames.
    const backend = new FakeBackend()
    server = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    local = attachLocalWsServer(server, {
      machineId,
      backend,
      onRouteTask: async () => { throw new Error('router unavailable') },
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-ws`

    const ws = new WebSocket(url)
    await onceOpen(ws)
    const connected = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
    await connected

    const blank = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'route_task', payload: { requestId: 'q-empty', text: '   ' } }))
    expect((await blank).payload).toMatchObject({ requestId: 'q-empty', agentId: '', reason: 'empty task' })

    const failed = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'route_task', payload: { requestId: 'q-throw', text: 'anything' } }))
    expect((await failed).payload).toMatchObject({ requestId: 'q-throw', agentId: '', reason: 'router unavailable' })
    ws.close()
  })

  it('delivers a committed route, and keeps the frame off the wire', async () => {
    const backend = new FakeBackend()
    const sent: Array<{ agentId: string; text: string }> = []
    server = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    local = attachLocalWsServer(server, {
      machineId,
      backend,
      onRouteSend: (agentId, text) => {
        sent.push({ agentId, text })
        return { ok: true as const }
      },
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-ws`

    const ws = new WebSocket(url)
    await onceOpen(ws)
    const connected = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
    await connected

    const delivered = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'route_send', payload: { requestId: 's-1', agentId: 'a2', text: 'do the thing' } }))
    expect((await delivered).payload).toMatchObject({ requestId: 's-1', ok: true })

    // The half-formed one is dropped rather than delivered to whoever sorts first — and it is REFUSED
    // out loud, because the window is waiting on this id either way.
    const refused = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'route_send', payload: { requestId: 's-2', agentId: '', text: 'nobody' } }))
    expect((await refused).payload).toMatchObject({ requestId: 's-2', ok: false })

    expect(sent).toEqual([{ agentId: 'a2', text: 'do the thing' }])
    expect(backend.frames.map((frame) => frame.type)).toEqual([])
    ws.close()
  })

  it('says so when the agent could not be delivered to', async () => {
    // The remote leg carries no ack of its own: a machine that has gone deaf takes the turn and nothing
    // comes back. With the palette closing silently on a confident route, that is a task that vanishes
    // without a mark anywhere — so the refusal has to travel.
    const backend = new FakeBackend()
    server = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    local = attachLocalWsServer(server, {
      machineId,
      backend,
      onRouteSend: () => ({ ok: false as const, machine: 'mac-mini', reason: 'the last request to it did not come back' }),
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-ws`

    const ws = new WebSocket(url)
    await onceOpen(ws)
    const connected = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
    await connected

    const answered = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'route_send', payload: { requestId: 's-3', agentId: 'a9', text: 'work' } }))
    expect((await answered).payload).toMatchObject({
      requestId: 's-3', ok: false, machine: 'mac-mini', reason: 'the last request to it did not come back',
    })
    ws.close()
  })

  it('does not require a credential on the loopback transport', async () => {
    const url = await start(new FakeBackend())
    const ws = new WebSocket(url, ['legacy-client-label'])
    await onceOpen(ws)
    ws.close()
  })

  it('rejects browser origins and machine-id mismatches', async () => {
    const url = await start(new FakeBackend())
    const browser = new WebSocket(url, { origin: 'https://example.com' })
    const error = await new Promise<Error>((resolve) => browser.once('error', resolve))
    expect(error.message).toContain('403')

    const ws = new WebSocket(url)
    await onceOpen(ws)
    const closed = new Promise<number>((resolve) => ws.once('close', resolve))
    ws.send(JSON.stringify({
      type: 'machine_select',
      payload: { machineId: 'other-machine', localProtocolVersion: 1 },
    }))
    await expect(closed).resolves.toBe(4403)
  })
})
