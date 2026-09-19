import { afterEach, describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { RemoteViewerProxy } from './remoteViewerProxy.js'
import type { Frame } from '../backendSocket.js'

const cleanup: Array<() => void> = []
afterEach(() => { cleanup.splice(0).reverse().forEach((close) => close()); vi.restoreAllMocks() })
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

function fixture() {
  const delivered: Frame[] = []
  const send = vi.fn((_type: string, _p: Record<string, unknown>) => true)
  const proxy = new RemoteViewerProxy({ supported: () => true, send, deliver: (f) => delivered.push(f) })
  cleanup.push(() => proxy.close())
  // Fault injection at the HTTP boundary: production instances and handlers, synthetic broken peers.
  const state = proxy as any
  const announce = async (agent: unknown) => {
    proxy.receive({ type: 'agent_synced', payload: { agent } })
    await state.metadata
    return (delivered.at(-1)?.payload as any)?.agent
  }
  const gateway = async () => {
    await announce({ id: 'a', viewerUrl: 'http://127.0.0.1:4321/' })
    return state.gateways.get('a')
  }
  return { proxy, state, send, delivered, announce, gateway }
}

class Response extends PassThrough {
  status = 0
  headersSent = false
  headers: Record<string, unknown> = {}
  setHeader(key: string, value: unknown) { this.headers[key.toLowerCase()] = value }
  writeHead(status: number, headers: Record<string, unknown> = {}) { this.status = status; Object.assign(this.headers, headers); this.headersSent = true; return this }
  flushHeaders() {}
}

function request(gateway: any, overrides: Record<string, unknown> = {}) {
  return Object.assign(new PassThrough(), {
    url: '/', method: 'GET', headers: {
      host: new URL(gateway.origin).host, cookie: `${gateway.cookie}=${gateway.token}`,
    }, ...overrides,
  })
}

describe('remote viewer metadata lifecycle', () => {
  it('passes non-viewer events, malformed metadata and public URLs without allocating a gateway', async () => {
    const f = fixture()
    expect(f.proxy.receive({})).toBe(false)
    expect(f.proxy.receive({ type: 'turn_started' })).toBe(false)
    expect(f.proxy.receive({ type: 'viewer_data' })).toBe(true)
    expect(f.proxy.receive({ type: 'viewer_response', payload: { streamId: 'absent' } })).toBe(true)
    for (const frame of [{ type: 'agent_deleted' }, { type: 'agent_created', payload: {} }]) {
      f.proxy.receive(frame)
      await f.state.metadata
      expect(f.delivered.at(-1)).toEqual(frame)
    }
    for (const raw of ['agent', { name: 'no id' }, { id: 'a', viewerUrl: 'https://example.com/' }, { id: 'b', viewerUrl: 'not a URL' }]) {
      expect(await f.announce(raw)).toEqual(raw)
    }
    expect(await f.announce({ id: 'a', viewerUrl: 'https://localhost:443/' })).toMatchObject({ viewerUrl: null, viewerError: expect.any(String) })
    f.proxy.receive({ type: 'agents_list_result', payload: { agents: [null, { id: 'a' }] } })
    await f.state.metadata
    expect((f.delivered.at(-1)?.payload as any).agents).toEqual([null, { id: 'a' }])
  })

  it('replaces gateways on port changes, deletes agents and caps the number of open viewers', async () => {
    const f = fixture()
    const gateway = await f.gateway()
    f.proxy.receive({ type: 'agents_list_result', payload: { agents: [{ id: 'a', viewerUrl: 'http://127.0.0.1:4321/' }] } })
    await f.state.metadata
    expect(f.state.gateways.get('a')).toBe(gateway)
    await f.announce({ id: 'a', viewerUrl: 'http://127.0.0.1:4322/' })
    expect(f.state.gateways.get('a')).not.toBe(gateway)
    f.proxy.receive({ type: 'agent_deleted', payload: { agentId: 'a' } })
    await f.state.metadata
    expect(f.state.gateways.size).toBe(0)
    f.proxy.receive({ type: 'agents_list_result', payload: { agents: Array.from({ length: 65 }, (_, i) => ({ id: `a${i}`, viewerUrl: 'http://127.0.0.1:4321/' })) } })
    await f.state.metadata
    expect(f.state.gateways.size).toBe(64)
    expect((f.delivered.at(-1)?.payload as any).agents.at(-1).viewerError).toContain('Too many')
  })

  it('drops queued frames and pending binds when the client detaches, without leaking listeners', async () => {
    const f = fixture()
    f.proxy.receive({ type: 'agent_created', payload: { agent: { id: 'a', viewerUrl: 'http://127.0.0.1:4321/' } } })
    f.proxy.reset()
    await f.state.metadata
    expect(f.delivered).toHaveLength(0)
    const create = f.state.createGateway.bind(f.state)
    vi.spyOn(f.state, 'createGateway').mockImplementation(async (...args: unknown[]) => {
      const gateway = await create(...args)
      f.proxy.reset()
      return gateway
    })
    f.proxy.receive({ type: 'agents_list_result', payload: { agents: [{ id: 'a', viewerUrl: 'http://127.0.0.1:4321/' }, { id: 'b', viewerUrl: 'http://127.0.0.1:4321/' }] } })
    await f.state.metadata
    expect(f.state.gateways.size).toBe(0)
    expect(f.delivered).toHaveLength(0)
    f.proxy.close()
    await f.announce({ id: 'b', viewerUrl: 'http://127.0.0.1:4321/' })
    expect(f.delivered).toHaveLength(0)
  })

  it('returns safe updateable metadata on bind failure instead of timing out the agent RPC', async () => {
    const f = fixture()
    vi.spyOn(f.state, 'createGateway').mockRejectedValue(new Error('no ports available'))
    const failed = await f.announce({ id: 'a', viewerUrl: 'http://127.0.0.1:4321/' })
    expect(failed.viewerUrl).toBeNull()
    expect(failed.viewerError).toContain('could not be opened')
    f.proxy.receive({ type: 'agents_list_result', payload: { agents: [{ id: 'a', viewerUrl: 'http://127.0.0.1:4321/' }, { id: 'b', viewerUrl: 'https://example.com/' }, null] } })
    await f.state.metadata
    expect((f.delivered.at(-1)?.payload as any).agents[1].viewerUrl).toBe('https://example.com/')
    vi.spyOn(f.state, 'rewrite').mockRejectedValue(new Error('interrupted metadata processing'))
    f.proxy.receive({ type: 'agent_created' })
    await f.state.metadata
    expect(f.delivered.at(-1)).toEqual({ type: 'agent_created' })
    f.proxy.receive({ type: 'agent_created', payload: {} })
    await f.state.metadata
    expect(f.delivered.at(-1)).toEqual({ type: 'agent_created', payload: {} })
    f.proxy.receive({ type: 'agent_created', payload: { agent: 'malformed' } })
    await f.state.metadata
    expect((f.delivered.at(-1)?.payload as any).agent).toBe('malformed')
    const delivered = f.delivered.length
    f.proxy.receive({ type: 'agent_created' })
    await Promise.resolve() // let rewrite start, then cancel before its rejection is handled
    f.proxy.reset()
    await f.state.metadata
    expect(f.delivered.length).toBe(delivered)
  })
})

describe('local HTTP boundaries and remote failures', () => {
  it('contains socket/server errors and refuses CONNECT, invalid HTTP and unsafe bootstrap redirects', async () => {
    const f = fixture()
    const gateway = await f.gateway()
    const socket = new PassThrough()
    gateway.server.emit('connection', socket)
    socket.emit('error', new Error('peer disconnected'))
    gateway.server.emit('connect', {}, socket)
    expect(socket.destroyed).toBe(true)
    const malformed = new PassThrough()
    gateway.server.emit('clientError', new Error('invalid HTTP'), malformed)
    expect(malformed.destroyed).toBe(true)
    for (const url of ['http://evil.example/', '//[', '/back\\slash', '/space here']) {
      const response = new Response()
      f.state.serve(gateway, request(gateway, { url }), response)
      expect(response.status).toBe(400)
    }
    const foreign = request(gateway)
    Object.assign(foreign.headers, { referer: 'https://evil.example/' })
    const forbidden = new Response()
    f.state.serve(gateway, foreign, forbidden)
    expect(forbidden.status).toBe(403)
    f.state.serve(gateway, request(gateway, { url: undefined }), new Response())
    const noCookie = request(gateway)
    delete (noCookie.headers as any).cookie
    f.state.open(gateway, noCookie, false, () => {})
    for (const path of ['https://evil.example', '//evil.example', '/\\evil.example', '/\nfoo']) {
      const res = new Response()
      f.state.serve(gateway, request(gateway, { url: `/__harness_viewer/${gateway.token}?path=${encodeURIComponent(path)}` }), res)
      expect(res.status).toBe(400)
    }
    const res = new Response()
    f.state.serve(gateway, request(gateway, { url: `/__harness_viewer/${gateway.token}` }), res)
    expect(res.headers.Location).toBe('/')
    gateway.server.emit('error', new Error('listener failed'))
    expect(f.state.gateways.size).toBe(0)
  })

  it.each([199, 600, 200.5, 'bad', 101])('rejects invalid upstream HTTP status %s', async (status) => {
    const f = fixture()
    const gateway = await f.gateway()
    const res = new Response()
    f.state.serve(gateway, request(gateway), res)
    const stream = [...f.state.wires.values()][0] as any
    stream.response({ status, headers: {} })
    await tick()
    expect(res.status).toBe(502)
  })

  it('refuses unsolicited upgrade metadata, duplicate responses, bad headers and interrupted bodies', async () => {
    const f = fixture()
    const gateway = await f.gateway()
    for (const kind of ['upgrade', 'headers', 'duplicate', 'interrupted', 'request-error']) {
      const req = request(gateway)
      const res = new Response()
      f.state.serve(gateway, req, res)
      const stream = [...f.state.wires.values()].at(-1) as any
      if (kind === 'upgrade') stream.response({ status: 200, headers: {}, upgrade: true })
      else if (kind === 'headers') stream.response({ status: 200, headers: { bad: '\n' } })
      else if (kind === 'request-error') req.emit('error', new Error('upload interrupted'))
      else {
        stream.response({ status: 200, headers: {} })
        if (kind === 'duplicate') stream.response({ status: 200, headers: {} })
        else stream.wire.handle('viewer_close', { error: 'lost upstream' })
      }
      await tick()
      expect(res.destroyed || res.status === 502, kind).toBe(true)
    }
  })

  it('caps active requests and rejects new work on a disposed proxy', async () => {
    const f = fixture()
    const gateway = await f.gateway()
    for (let i = 0; i < 64; i++) f.state.open(gateway, request(gateway), false, () => {})
    const res = new Response()
    f.state.serve(gateway, request(gateway), res)
    expect(res.status).toBe(503)
    const socket = new PassThrough()
    f.state.serveUpgrade(gateway, request(gateway, { headers: { host: new URL(gateway.origin).host, cookie: `${gateway.cookie}=${gateway.token}`, upgrade: 'websocket' } }), socket, Buffer.alloc(0))
    expect(socket.destroyed).toBe(true)
    f.proxy.close()
    expect(f.state.open(gateway, request(gateway), false, () => {})).toBeNull()
  })

  it('handles a failed send and malformed outgoing headers without exposing loopback cookies', async () => {
    const f = fixture()
    const gateway = await f.gateway()
    for (const invalidHeaders of [false, true]) {
      const res = new Response()
      const req = request(gateway)
      if (invalidHeaders) (req.headers as any).invalid = '\r\n'
      f.send.mockReturnValue(false)
      f.state.serve(gateway, req, res)
      await tick()
      expect(res.status).toBe(502)
    }
    const req = request(gateway)
    Object.assign(req.headers, { referer: `${gateway.origin}/page`, origin: gateway.origin })
    f.send.mockReturnValue(true)
    f.state.open(gateway, req, false, () => {})
    expect(f.send).toHaveBeenCalledWith('viewer_request', expect.objectContaining({ headers: expect.objectContaining({ referer: 'http://127.0.0.1:4321/page' }) }))
    expect(f.state.responseHeaders(gateway, { location: 'https://example.com/', 'set-cookie': 'a=b; Domain=localhost; Path=/' }))
      .toMatchObject({ location: 'https://example.com/', 'set-cookie': [`${gateway.cookie}_a=b; Path=/`] })
  })
})

describe('WebSocket proxy failures', () => {
  it('refuses unauthorized upgrades before sending any remote request', async () => {
    const f = fixture()
    const gateway = await f.gateway()
    const req = request(gateway)
    for (const headers of [{}, { ...req.headers, origin: 'https://evil.example' }, { ...req.headers, cookie: '', upgrade: 'websocket' }, { ...req.headers, upgrade: 'h2c' }]) {
      const socket = new PassThrough()
      f.state.serveUpgrade(gateway, request(gateway, { headers }), socket, Buffer.alloc(0))
      expect(socket.read()?.toString()).toContain('403')
    }
    expect(f.send).not.toHaveBeenCalled()
  })

  it.each(['declined', 'not-upgrade', 'headers', 'duplicate', 'socket-error'])('cleans up a %s upgrade', async (kind) => {
    const f = fixture()
    const gateway = await f.gateway()
    const req = request(gateway)
    Object.assign(req.headers, { upgrade: 'websocket' })
    const socket = new PassThrough()
    f.state.serveUpgrade(gateway, req, socket, Buffer.from('client-head'))
    const stream = [...f.state.wires.values()][0] as any
    if (kind === 'declined') stream.response({ status: 403 })
    else if (kind === 'not-upgrade') stream.response({ status: 101, upgrade: false })
    else if (kind === 'headers') stream.response({ status: 101, upgrade: true, headers: { bad: '\n' } })
    else {
      stream.response({ status: 101, upgrade: true, headers: { 'set-cookie': ['a=b', 'c=d'] } })
      if (kind === 'duplicate') stream.response({ status: 101, upgrade: true, headers: {} })
      else socket.emit('error', new Error('client dropped'))
    }
    await tick()
    expect(socket.destroyed).toBe(true)
  })
})
