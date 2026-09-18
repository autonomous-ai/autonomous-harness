import { EventEmitter } from 'node:events'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({
  auth: vi.fn(), grant: vi.fn(), up: vi.fn(), changed: vi.fn(), down: vi.fn(), live: vi.fn(),
  upgrade: vi.fn(),
}))
vi.mock('./ssoAuth.js', () => ({ authenticateAccessToken: m.auth }))
vi.mock('../routes/harnessShares.js', () => ({ recipientShare: m.grant }))
vi.mock('./bus.js', () => ({ publishDown: m.down, subscribeUp: m.up, subscribeShareChanged: m.changed }))
vi.mock('./hub.js', () => ({ trackSocketLiveness: m.live }))
vi.mock('./wsServer.js', () => ({ WS_LIMITS: { web: 1 }, createWss: () => ({ handleUpgrade: m.upgrade }) }))
import { attachObserver, handleObserverUpgrade } from './observerWs.js'
const user = { sub: 'ken', email: ' Ken@Example.com ', autonomousEnv: 'prod' as const, role: 'user' }
const share = { id: '11111111-1111-4111-8111-111111111111', machineId: 'm', agentId: 'a' }
class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0
  send = vi.fn()
  close = vi.fn((_code?: number, _reason?: string) => { this.readyState = 3; this.emit('close') })
  terminate = vi.fn(() => this.close())
  message(type: string, payload: unknown = {}) { this.emit('message', Buffer.from(JSON.stringify({ type, payload })), false) }
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
describe('isolated observer WebSocket boundary', () => {
  let ws: Socket, upward: (message: any) => void, changed: () => void, disposeUp: ReturnType<typeof vi.fn<() => void>>, disposeShare: ReturnType<typeof vi.fn<() => void>>, disposeLive: ReturnType<typeof vi.fn<() => void>>
  beforeEach(() => {
    vi.useFakeTimers(); vi.resetAllMocks(); ws = new Socket()
    disposeUp = vi.fn(); disposeShare = vi.fn(); disposeLive = vi.fn()
    m.auth.mockResolvedValue(user); m.grant.mockResolvedValue(share)
    m.down.mockResolvedValue(1); m.live.mockReturnValue(disposeLive)
    m.up.mockImplementation(async (_id, callback) => { upward = callback; return disposeUp })
    m.changed.mockImplementation(async (_id, callback) => { changed = callback; return disposeShare })
    m.upgrade.mockImplementation((_req, _socket, _head, done) => done(ws))
  })
  afterEach(() => { ws.close(); vi.useRealTimers() })
  const attach = () => attachObserver(ws as never, user, share as never)
  const hello = () => ws.message('observer_hello', { ephemeral: Buffer.alloc(32, 1).toString('base64') })
  it('routes only invitation-scoped traffic and only targeted observer output', async () => {
    await attach()
    expect(JSON.parse(ws.send.mock.calls[0][0] as string)).toEqual({ type: 'observer_connected' })
    hello(); await flush()
    expect(m.down).toHaveBeenCalledWith('m', { connId: expect.stringMatching(/^observer:/), frame: {
      type: 'observer_open', payload: { shareId: share.id, email: 'ken@example.com', ephemeral: Buffer.alloc(32, 1).toString('base64') },
    } })
    const connId = m.down.mock.calls[0][1].connId
    for (const type of ['agents', 'message', 'e2e_welcome', 'terminal_ready']) upward({ targetConnId: connId, frame: { type } })
    upward({ targetConnId: 'someone-else', frame: { type: 'observer_frame' } })
    expect(ws.send).toHaveBeenCalledTimes(1)
    for (const type of ['observer_welcome', 'observer_frame', 'observer_closed']) upward({ targetConnId: connId, frame: { type } })
    expect(ws.send).toHaveBeenCalledTimes(4)
    ws.message('observer_frame', { __e2e: { encrypted: true } }); await flush()
    expect(m.down.mock.calls[1][1]).toEqual({ connId, frame: { type: 'observer_frame', payload: { __e2e: { encrypted: true } } } })
    ws.close(); ws.emit('close')
    expect(disposeLive).toHaveBeenCalledTimes(1); expect(disposeUp).toHaveBeenCalledTimes(1); expect(disposeShare).toHaveBeenCalledTimes(1)
    upward({ targetConnId: connId, frame: { type: 'observer_frame' } })
    expect(ws.send).toHaveBeenCalledTimes(4)
    expect(m.down.mock.calls.at(-1)?.[1].frame.type).toBe('observer_close')
  })
  it('revocation notifications and periodic checks close active viewers', async () => {
    await attach(); m.grant.mockResolvedValue(null); changed(); await flush()
    expect(ws.close).toHaveBeenCalledWith(4403, expect.any(String))
    ws = new Socket(); m.grant.mockResolvedValue(share); await attach()
    m.grant.mockResolvedValue(null); await vi.advanceTimersByTimeAsync(5000)
    expect(ws.close).toHaveBeenCalledWith(4403, expect.any(String))
  })
  it('database and owner outages are recoverable; admission rechecks race-safe authority', async () => {
    m.grant.mockResolvedValue(null); await attach()
    expect(ws.send).not.toHaveBeenCalled()
    ws = new Socket(); m.grant.mockResolvedValue(share); await attach()
    upward({ frame: { type: 'node_status', payload: { online: false } } })
    expect(ws.close).toHaveBeenCalledWith(1012, 'Owner is offline')
    ws = new Socket(); m.grant.mockRejectedValue(new Error('db down')); await attach()
    expect(ws.close).toHaveBeenCalledWith(1013, 'Sharing temporarily unavailable')
  })
  it('bounds and validates messages, rejecting control APIs and repeated handshakes', async () => {
    for (const send of [
      () => ws.message('agent_delete'), () => ws.message('observer_frame', { __e2e: {} }),
      () => ws.message('observer_hello', { ephemeral: 'bad' }),
      () => ws.emit('message', Buffer.from('garbage'), false),
      () => ws.emit('message', Buffer.from('{}'), true),
      () => ws.emit('message', Buffer.alloc(65 * 1024), false),
      () => ws.emit('message', [Buffer.alloc(65 * 1024)], false),
    ]) {
      ws = new Socket(); await attach(); send(); await flush()
      expect(ws.close).toHaveBeenCalledWith(1008, expect.any(String))
    }
    ws = new Socket(); await attach(); hello(); await flush(); hello(); await flush()
    expect(ws.close).toHaveBeenCalledWith(1008, expect.any(String))
  })
  it('bounds rate, resets the window and preserves message order across async publication', async () => {
    await attach(); hello(); await flush()
    await vi.advanceTimersByTimeAsync(1000)
    for (let i = 0; i < 121; i++) { ws.message('observer_frame', { __e2e: {} }); await flush() }
    expect(ws.close).toHaveBeenCalledWith(1008, 'Invalid observer message')
    ws = new Socket(); await attach();
    let release!: () => void
    m.down.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(1) }))
    hello(); await flush(); ws.message('observer_frame', { __e2e: {} }); await flush()
    const before = m.down.mock.calls.length; release(); await flush()
    expect(m.down.mock.calls.length).toBe(before + 1)
  })
  it('handles publication errors and subscriptions completing after a disconnect', async () => {
    await attach(); m.down.mockRejectedValueOnce(new Error('relay down')); hello(); await flush()
    expect(ws.close).toHaveBeenCalledWith(1013, 'Owner unavailable')
    ws = new Socket(); await attach(); hello(); await flush()
    m.down.mockRejectedValueOnce(new Error('relay down')); ws.message('observer_frame', { __e2e: {} }); await flush()
    expect(ws.close).toHaveBeenCalledWith(1013, 'Owner unavailable')
    ws = new Socket()
    let release!: (value: () => void) => void
    m.changed.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const attaching = attach(); ws.close(); release(() => disposeShare()); await attaching
    expect(disposeShare).toHaveBeenCalled(); expect(ws.send).not.toHaveBeenCalled()
  })
  it('authenticates upgrades before admission and rejects absent/invalid grants', async () => {
    const socket = { destroyed: false, destroy: vi.fn() }
    const req = (url: string, token = 'fixture') => ({ url, headers: { 'sec-websocket-protocol': token } })
    for (const request of [req('/api/observer-ws?share=bad'), req(`/api/observer-ws?share=${share.id}`, '')]) {
      handleObserverUpgrade(request as never, socket as never, Buffer.alloc(0)); await flush()
    }
    expect(socket.destroy).toHaveBeenCalledTimes(2); expect(m.auth).not.toHaveBeenCalled()
    handleObserverUpgrade(req(`/api/observer-ws?share=${share.id}&autonomousEnv=prod`) as never, socket as never, Buffer.alloc(0)); await flush()
    expect(m.auth).toHaveBeenCalledWith('fixture', 'prod'); expect(m.upgrade).toHaveBeenCalledTimes(1)
    ws.close(); ws = new Socket(); m.grant.mockResolvedValueOnce(null)
    handleObserverUpgrade(req(`/api/observer-ws?share=${share.id}`) as never, socket as never, Buffer.alloc(0)); await flush()
    expect(ws.close).toHaveBeenCalledWith(4403, expect.any(String))
    m.auth.mockRejectedValueOnce(new Error('invalid'))
    handleObserverUpgrade(req(`/api/observer-ws?share=${share.id}`) as never, socket as never, Buffer.alloc(0)); await flush()
    expect(socket.destroy).toHaveBeenCalledTimes(3)
    socket.destroyed = true
    handleObserverUpgrade(req(`/api/observer-ws?share=${share.id}`) as never, socket as never, Buffer.alloc(0)); await flush()
    expect(m.upgrade).toHaveBeenCalledTimes(2)
  })
  it('cleans up upgrade failures, synchronous relay faults, closed inboxes and excessive queued messages', async () => {
    const socket = { destroyed: false, destroy: vi.fn() }
    handleObserverUpgrade({ headers: { 'sec-websocket-protocol': 'fixture' } } as never, socket as never, Buffer.alloc(0))
    await flush(); expect(socket.destroy).toHaveBeenCalledTimes(1)
    const req = { url: `/api/observer-ws?share=${share.id}`, headers: { 'sec-websocket-protocol': 'fixture' } }
    m.changed.mockRejectedValueOnce(new Error('subscription down'))
    handleObserverUpgrade(req as never, socket as never, Buffer.alloc(0)); await flush()
    expect(ws.close).toHaveBeenCalledWith(1013, 'Sharing temporarily unavailable')
    socket.destroyed = true; m.auth.mockRejectedValueOnce(new Error('auth down'))
    handleObserverUpgrade(req as never, socket as never, Buffer.alloc(0)); await flush()
    expect(socket.destroy).toHaveBeenCalledTimes(1)
    ws = new Socket(); await attach()
    m.down.mockImplementationOnce(() => { throw new Error('relay not initialized') })
    hello(); await flush()
    expect(ws.close).toHaveBeenCalledWith(1013, 'Sharing temporarily unavailable')
    ws = new Socket(); await attach()
    let release!: () => void
    m.down.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(1) }))
    hello(); await flush()
    m.down.mockRejectedValueOnce(new Error('cleanup relay down'))
    for (let i = 0; i < 257; i++) ws.message('observer_frame', { __e2e: {} })
    expect(ws.close).toHaveBeenCalledWith(1008, 'Too many observer messages')
    release(); await flush(); await vi.advanceTimersByTimeAsync(1)
  })
})
