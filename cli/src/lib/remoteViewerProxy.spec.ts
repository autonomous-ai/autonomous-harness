import { afterEach, describe, expect, it } from 'vitest'
import { once } from 'node:events'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { RemoteViewerProxy } from './remoteViewerProxy.js'
import { ViewerForwarder } from './viewerForwarder.js'
import { VIEWER_CHUNK_BYTES, VIEWER_WINDOW_BYTES, ViewerWire } from './viewerWire.js'
import type { Frame } from '../backendSocket.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanup.push(() => { server.closeAllConnections(); server.close() })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function http(url: string, headers: Record<string, string> = {}, body?: Buffer): Promise<{ status: number; headers: IncomingHttpHeaders; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers, method: body ? 'POST' : 'GET', agent: false }, (res) => {
      const parts: Buffer[] = []
      res.on('data', (data) => parts.push(data))
      res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, bytes: Buffer.concat(parts) }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function fixture(options: { supported?: boolean } = {}) {
  const bytes = Buffer.alloc(1024 * 1024 + 137)
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
  const seen: Array<{ path: string; headers: IncomingHttpHeaders }> = []
  const server = createServer((req, res) => {
    seen.push({ path: req.url!, headers: req.headers })
    if (req.url === '/bytes') {
      const partial = req.headers.range === 'bytes=17-991'
      const content = partial ? bytes.subarray(17, 992) : bytes
      res.writeHead(partial ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': content.length, ...(partial ? { 'Content-Range': `bytes 17-991/${bytes.length}` } : {}) })
      res.end(content)
    } else if (req.url === '/upload') {
      req.pipe(res)
    } else if (req.url === '/redirect') {
      res.writeHead(302, { Location: `${origin}/page?q=1` }).end()
    } else if (req.url === '/cookie') {
      res.writeHead(200, { 'Set-Cookie': ['session=remote-secret; Path=/; HttpOnly'] }).end('cookie')
    } else if (req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: first\n\n')
      // Deliberately leave it live until the local consumer cancels.
    } else res.end('<html><img src="/bytes">Remote viewer</html>')
  })
  const origin = await listen(server)
  const wss = new WebSocketServer({ server })
  cleanup.push(() => { for (const socket of wss.clients) socket.terminate(); wss.close() })
  wss.on('connection', (socket, req) => {
    seen.push({ path: req.url!, headers: req.headers })
    socket.on('message', (data, binary) => socket.send(data, { binary }))
  })
  const targets = new Map([['agent-a', `${origin}/page?file=a.step`], ['agent-b', `${origin}/`]])
  let deliver: (frame: Frame) => void = () => {}
  let proxy: RemoteViewerProxy
  const forwarder = new ViewerForwarder({
    target: (id) => targets.get(id) ?? null,
    send: (_conn, type, payload) => { queueMicrotask(() => proxy.receive({ type, payload })); return true },
  })
  proxy = new RemoteViewerProxy({
    supported: () => options.supported ?? true,
    send: (type, payload) => { queueMicrotask(() => forwarder.handle('owner', type, payload)); return true },
    deliver: (frame) => deliver(frame),
  })
  cleanup.push(() => { proxy.close(); forwarder.closeAll() })
  const frame = (type: string, payload: Record<string, unknown>) => new Promise<Record<string, any>>((resolve) => {
    deliver = (result) => resolve(result.payload as Record<string, any>)
    proxy.receive({ type, payload })
  })
  const agent = async (id = 'agent-a') => (await frame('agent_synced', { agent: { id, viewerUrl: targets.get(id) ?? null } })).agent as { viewerUrl: string | null; viewerError?: string }
  const open = async (id = 'agent-a') => {
    const rewritten = await agent(id)
    const bootstrap = await http(rewritten.viewerUrl!)
    expect(bootstrap.status).toBe(302)
    const local = new URL(rewritten.viewerUrl!).origin
    const cookie = bootstrap.headers['set-cookie']![0].split(';')[0]
    return { local, cookie, url: rewritten.viewerUrl!, bootstrap }
  }
  return { origin, bytes, seen, proxy, forwarder, targets, frame, agent, open }
}

describe('remote viewer HTTP and WebSocket forwarding', () => {
  it('rewrites only remote viewer URLs, preserves paths, and streams assets and byte ranges', async () => {
    const f = await fixture()
    const { local, cookie, bootstrap } = await f.open()
    expect(bootstrap.headers.location).toBe('/page?file=a.step')
    expect(local).not.toBe(f.origin)
    expect((await http(local + bootstrap.headers.location, { cookie })).bytes.toString()).toContain('Remote viewer')
    const full = await http(local + '/bytes', { cookie })
    expect(full.bytes.equals(f.bytes)).toBe(true)
    const range = await http(local + '/bytes', { cookie, range: 'bytes=17-991' })
    expect(range.status).toBe(206)
    expect(range.headers['content-range']).toBe(`bytes 17-991/${f.bytes.length}`)
    expect(range.bytes.equals(f.bytes.subarray(17, 992))).toBe(true)
    expect((await http(local + '/redirect', { cookie })).headers.location).toBe(local + '/page?q=1')
    const upload = await http(local + '/upload', { cookie, origin: local }, f.bytes)
    expect(upload.bytes.equals(f.bytes)).toBe(true)
    expect(f.seen.at(-1)?.headers.origin).toBe(f.origin)
    expect(f.seen.at(-1)?.headers.host).toBe(new URL(f.origin).host)
  })

  it('blocks unauthenticated access, foreign origins, DNS rebinding and cross-viewer cookies', async () => {
    const f = await fixture()
    const a = await f.open()
    const b = await f.open('agent-b')
    expect(a.local).not.toBe(b.local)
    const denied: Array<Record<string, string>> = [
      {}, { cookie: b.cookie }, { cookie: a.cookie, origin: 'https://evil.example' },
      { cookie: a.cookie, origin: 'null' }, { cookie: a.cookie, host: 'evil.example' },
      { cookie: a.cookie, 'sec-fetch-site': 'cross-site' },
    ]
    for (const headers of denied) expect((await http(a.local + '/', headers)).status).toBe(403)
    expect(f.seen).toHaveLength(0)
    const response = await http(a.local + '/cookie', { cookie: `${a.cookie}; unrelated=local-secret` })
    const remoteCookie = response.headers['set-cookie']![0].split(';')[0]
    await http(a.local + '/', { cookie: `${a.cookie}; ${remoteCookie}; unrelated=local-secret` })
    expect(f.seen.at(-1)?.headers.cookie).toBe('session=remote-secret')
  })

  it('delivers SSE before the response ends and cancels it when the pane connection closes', async () => {
    const f = await fixture()
    const { local, cookie } = await f.open()
    await new Promise<void>((resolve, reject) => {
      const req = request(local + '/events', { headers: { cookie }, agent: false }, (res) => {
        res.once('data', (chunk) => {
          expect(chunk.toString()).toBe('data: first\n\n')
          expect(res.complete).toBe(false)
          res.destroy()
          resolve()
        })
        res.on('error', reject)
      })
      req.on('error', reject)
      req.end()
    })
  })

  it('preserves WebSocket protocol, origin and large binary messages', async () => {
    const f = await fixture()
    const { local, cookie } = await f.open()
    const socket = new WebSocket(local.replace('http:', 'ws:') + '/ws', ['viewer-live'], { headers: { cookie }, origin: local })
    cleanup.push(() => socket.terminate())
    await once(socket, 'open')
    expect(socket.protocol).toBe('viewer-live')
    const answer = once(socket, 'message')
    socket.send(f.bytes)
    const [bytes, binary] = await answer
    expect(binary).toBe(true)
    expect((bytes as Buffer).equals(f.bytes)).toBe(true)
    expect(f.seen.at(-1)?.headers.origin).toBe(f.origin)
    socket.close()
    await once(socket, 'close')
  })

  it('updates artifacts on the same gateway and removes access on viewer stop, detach and missing agents', async () => {
    const f = await fixture()
    const a = await f.open()
    f.targets.set('agent-a', `${f.origin}/?file=new%20part.step#view`)
    const changed = await f.agent()
    expect(new URL(changed.viewerUrl!).origin).toBe(a.local)
    expect((await http(changed.viewerUrl!)).headers.location).toBe('/?file=new%20part.step#view')
    f.targets.delete('agent-a')
    f.forwarder.refresh('agent-a')
    expect((await f.agent()).viewerUrl).toBeNull()
    await expect(http(a.local + '/', { cookie: a.cookie })).rejects.toThrow()
    const b = await f.open('agent-b')
    await f.frame('agents_list_result', { agents: [] })
    await expect(http(b.local + '/', { cookie: b.cookie })).rejects.toThrow()
    const c = await f.open('agent-b')
    f.proxy.reset()
    await expect(http(c.local + '/', { cookie: c.cookie })).rejects.toThrow()
  })

  it('gives update guidance for old daemons and never exposes their loopback URL', async () => {
    const f = await fixture({ supported: false })
    expect(await f.agent()).toMatchObject({ viewerUrl: null, viewerError: expect.stringContaining('Update Harness') })
  })

  it('rejects arbitrary destinations and isolates stream ids by connection', async () => {
    const f = await fixture()
    const replies: Array<{ conn: string; type: string; payload: Record<string, unknown> }> = []
    const forwarder = new ViewerForwarder({
      target: (id) => f.targets.get(id) ?? null,
      send: (conn, type, payload) => { replies.push({ conn, type, payload }); return true },
    })
    cleanup.push(() => forwarder.closeAll())
    const base = { streamId: 'test', agentId: 'agent-a', origin: f.origin, path: '/', method: 'GET', headers: {} }
    for (const override of [
      { agentId: 'missing' }, { origin: 'http://127.0.0.1:22' }, { path: 'http://evil.example/' },
      { method: 'CONNECT' }, { headers: { host: 'localhost\r\nBad: x' } },
    ]) {
      forwarder.handle('owner', 'viewer_request', { ...base, ...override })
      expect(replies.at(-1)?.type).toBe('viewer_close')
    }
    expect(f.seen).toHaveLength(0)
    forwarder.handle('owner', 'viewer_request', base)
    forwarder.handle('intruder', 'viewer_close', { streamId: 'test' })
    forwarder.handle('owner', 'viewer_end', { streamId: 'test' })
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (replies.some((r) => r.type === 'viewer_response')) { clearInterval(timer); resolve() }
      }, 5)
    })
    expect(replies.find((r) => r.type === 'viewer_response')?.conn).toBe('owner')
  })
})

describe('viewer flow control', () => {
  it('caps bytes in flight while a receiver is stalled and rejects excess credit/data', async () => {
    const sent: Array<{ type: string; p: Record<string, unknown> }> = []
    const wire = new ViewerWire('a', (type, p) => { sent.push({ type, p }); return true })
    cleanup.push(() => { wire.destroy() })
    wire.write(Buffer.alloc(VIEWER_WINDOW_BYTES * 3))
    expect(sent.filter((f) => f.type === 'viewer_data')).toHaveLength(VIEWER_WINDOW_BYTES / VIEWER_CHUNK_BYTES)
    wire.handle('viewer_ack', { bytes: VIEWER_CHUNK_BYTES })
    expect(sent.filter((f) => f.type === 'viewer_data')).toHaveLength(VIEWER_WINDOW_BYTES / VIEWER_CHUNK_BYTES + 1)
    wire.handle('viewer_ack', { bytes: VIEWER_WINDOW_BYTES + 1 })
    expect(wire.destroyed).toBe(true)

    const receiver = new ViewerWire('b', () => true)
    cleanup.push(() => { receiver.destroy() })
    for (let i = 0; i <= VIEWER_WINDOW_BYTES / VIEWER_CHUNK_BYTES; i++) {
      receiver.handle('viewer_data', { data: Buffer.alloc(VIEWER_CHUNK_BYTES).toString('base64') })
    }
    expect(receiver.destroyed).toBe(true)
  })
})
