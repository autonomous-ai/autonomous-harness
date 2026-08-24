import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
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
