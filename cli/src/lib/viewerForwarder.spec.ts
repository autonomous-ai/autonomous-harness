import { afterEach, describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { ViewerForwarder } from './viewerForwarder.js'

const requestStub = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('node:http', () => ({ request: requestStub.call }))

const clean: ViewerForwarder[] = []
afterEach(() => { clean.splice(0).forEach((f) => f.closeAll()); vi.restoreAllMocks() })

function fixture() {
  const send = vi.fn(() => true)
  const target = vi.fn((_id: string) => 'http://localhost:4321/')
  const requests: PassThrough[] = []
  requestStub.call.mockReset().mockImplementation(() => {
    const req = new PassThrough()
    requests.push(req)
    return req
  })
  const forwarder = new ViewerForwarder({ send, target })
  clean.push(forwarder)
  const base = { streamId: 's', agentId: 'a', origin: 'http://localhost:4321', path: '/', method: 'GET', headers: {} }
  const open = (p: Record<string, unknown> = {}, conn = 'owner') => forwarder.handle(conn, 'viewer_request', { ...base, ...p })
  const response = (status: number | undefined = 200, headers: unknown = {}) => Object.assign(new PassThrough(), { statusCode: status, headers })
  return { send, target, requests, forwarder, base, open, response }
}

describe('viewer forwarding boundaries', () => {
  it('ignores invalid stream identifiers and rejects a request without an agent or valid destination', () => {
    const f = fixture()
    f.open({ streamId: '../other' })
    expect(f.send).not.toHaveBeenCalled()
    f.open({ agentId: 123 })
    expect(f.send).toHaveBeenCalledWith('owner', 'viewer_close', expect.anything())
    expect(requestStub.call).not.toHaveBeenCalled()
  })

  it.each([
    { path: 42 }, { path: '/'.repeat(17000) }, { path: 'relative' }, { path: '//other' },
    { path: '/back\\slash' }, { path: '/new\nline' }, { method: 2 }, { method: 'CONNECT' },
    { upgrade: true, method: 'POST' }, { headers: { invalid: ['\r\n'] } },
  ])('rejects malformed requests %j before connecting', (input) => {
    const f = fixture()
    f.open(input)
    expect(requestStub.call).not.toHaveBeenCalled()
    expect(f.send).toHaveBeenCalledWith('owner', 'viewer_close', expect.anything())
  })

  it('never replaces a live stream id, and caps per-client and daemon-wide streams', () => {
    const f = fixture()
    f.open()
    f.open()
    expect(requestStub.call).toHaveBeenCalledTimes(1)
    f.forwarder.closeAll()
    const bounded = fixture()
    for (let c = 0; c < 4; c++) {
      for (let i = 0; i < 64; i++) bounded.open({ streamId: `s${i}` }, `client${c}`)
      bounded.open({ streamId: 'overflow' }, `client${c}`)
    }
    bounded.open({ streamId: 'overflow' }, 'client4')
    expect(requestStub.call).toHaveBeenCalledTimes(256)
    expect(bounded.send).toHaveBeenCalledTimes(5)
  })

  it('pins IPv6 loopback and closes only the matching connection or a changed viewer origin', () => {
    const f = fixture()
    f.target.mockReturnValue('http://[::1]:4321/')
    f.open({ origin: 'http://[::1]:4321' })
    expect(requestStub.call).toHaveBeenCalledWith(expect.objectContaining({ hostname: '::1', port: '4321' }))
    f.open({ streamId: 'other', agentId: 'b', origin: 'http://[::1]:4321' }, 'other-owner')
    f.forwarder.refresh('a')
    expect(f.requests[0].destroyed).toBe(false)
    f.target.mockReturnValue('http://[::1]:4322/')
    f.forwarder.refresh('a')
    expect(f.send).toHaveBeenCalledWith('owner', 'viewer_close', expect.anything())
    expect(f.send).not.toHaveBeenCalledWith('other-owner', 'viewer_close', expect.anything())
    f.forwarder.closeConnection('other-owner')
    expect(f.send).toHaveBeenCalledWith('other-owner', 'viewer_close', expect.anything())
  })
})

describe('upstream HTTP and WebSocket failures', () => {
  it('contains synchronous connection failures and malformed response headers', () => {
    const f = fixture()
    requestStub.call.mockImplementationOnce(() => { throw new Error('connect failed') })
    f.open()
    f.open({ streamId: 'bad-header' })
    f.requests[0].emit('response', f.response(200, { bad: '\n' }))
    expect(f.send.mock.calls.filter((args: unknown[]) => args[1] === 'viewer_close')).toHaveLength(2)
  })

  it('fails closed on a dead relay, missing status, interrupted response and upstream error', () => {
    const f = fixture()
    f.open()
    f.send.mockReturnValue(false)
    f.requests[0].emit('response', f.response(200))
    f.send.mockReturnValue(true)
    f.open({ streamId: 'nostatus' })
    const response = Object.assign(new PassThrough(), { statusCode: undefined, headers: {} })
    f.requests[1].emit('response', response)
    expect(f.send).toHaveBeenCalledWith('owner', 'viewer_response', expect.objectContaining({ status: 502 }))
    response.emit('error', new Error('interrupted'))
    f.open({ streamId: 'request-error' })
    f.requests[2].emit('error', new Error('connect failed'))
  })

  it('handles declined and unsolicited upgrades, including malformed upgrade headers', () => {
    const f = fixture()
    f.open({ upgrade: true })
    f.requests[0].emit('response', f.response(403))
    f.open({ streamId: 'normal' })
    const normalSocket = new PassThrough()
    f.requests[1].emit('upgrade', f.response(101), normalSocket, Buffer.alloc(0))
    expect(normalSocket.destroyed).toBe(true)
    f.open({ streamId: 'badstatus', upgrade: true })
    const badSocket = new PassThrough()
    f.requests[2].emit('upgrade', f.response(200), badSocket, Buffer.alloc(0))
    expect(badSocket.destroyed).toBe(true)
    f.open({ streamId: 'badheaders', upgrade: true })
    const headerSocket = new PassThrough()
    f.requests[3].emit('upgrade', f.response(101, { bad: '\n' }), headerSocket, Buffer.alloc(0))
    expect(headerSocket.destroyed).toBe(true)
  })

  it('forwards upgrade head bytes and closes both sides on socket error, close or client cancellation', async () => {
    const f = fixture()
    for (let i = 0; i < 3; i++) {
      f.open({ streamId: `ws${i}`, upgrade: true })
      const socket = new PassThrough()
      f.requests[i].emit('upgrade', f.response(101), socket, i ? Buffer.alloc(0) : Buffer.from('head'))
      if (i === 0) socket.emit('error', new Error('socket failed'))
      else if (i === 1) socket.emit('close')
      else f.forwarder.handle('owner', 'viewer_close', { streamId: 'ws2' })
      await new Promise((resolve) => setImmediate(resolve))
      expect(socket.destroyed).toBe(true)
    }
    expect(f.send).toHaveBeenCalledWith('owner', 'viewer_data', expect.objectContaining({ data: Buffer.from('head').toString('base64') }))
  })
})
