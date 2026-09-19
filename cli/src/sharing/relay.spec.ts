import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthSessionManager } from '../lib/authSession.js'
import { b64e, newIdentity } from '../lib/e2ee/core.js'
import { ownerHandshake } from './crypto.js'
const state = vi.hoisted(() => ({ sockets: [] as any[], stop: vi.fn() }))
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeWebSocket extends EventEmitter {
    static OPEN = 1
    readyState = 1
    send = vi.fn()
    terminate = vi.fn(() => { this.readyState = 3; this.emit('close', 1006, Buffer.alloc(0)) })
    constructor(...args: unknown[]) { super(); state.sockets.push(this); (this as any).args = args }
  }
  return { WebSocket: FakeWebSocket }
})
vi.mock('../lib/wsLiveness.js', () => ({ watchSocketLiveness: () => ({ stop: state.stop }) }))
import { HarnessShareRelay, SharingEndedError } from './relay.js'
import { SHARE_REQUEST_TYPES, SHARE_RESULT_TYPES } from './protocol.js'
describe('recipient relay', () => {
  const identity = newIdentity()
  const share = { id: 'share', agentId: 'agent', name: 'Demo', engine: null,
    ownerPublicKey: b64e(identity.pub), expiresAt: new Date(Date.now() + 100000).toISOString() }
  let relay: HarnessShareRelay
  let discover: ReturnType<typeof vi.fn<() => Promise<any[]>>>
  let sink: { sendFrame: ReturnType<typeof vi.fn>; sendBinary: ReturnType<typeof vi.fn> }, closed: ReturnType<typeof vi.fn<(code: number, reason: string) => void>>
  beforeEach(() => {
    vi.useFakeTimers(); state.sockets = []; state.stop.mockReset()
    sink = { sendFrame: vi.fn(() => true), sendBinary: vi.fn(() => true) }; closed = vi.fn()
    discover = vi.fn(async () => [{ machineId: 'machine', shares: [share] }])
    relay = new HarnessShareRelay({ accessToken: async () => 'signed-in-token' } as AuthSessionManager,
      'ws://localhost:1234/', 'prod', discover)
  })
  afterEach(() => { relay.close(); vi.useRealTimers() })
  async function begin() {
    const pending = relay.acquire('machine', 'share', sink as never, closed)
    await Promise.resolve(); await Promise.resolve()
    const ws = state.sockets.at(-1)
    ws.emit('open')
    return { pending, ws }
  }
  function frame(ws: any, type: string, payload: unknown = {}) { ws.emit('message', Buffer.from(JSON.stringify({ type, payload }))) }
  async function ready() {
    const { pending, ws } = await begin()
    frame(ws, 'observer_connected')
    const hello = JSON.parse(ws.send.mock.calls[0][0])
    const owner = ownerHandshake(identity, 'machine', 'share', hello.payload.ephemeral)
    frame(ws, 'observer_welcome', owner.welcome)
    return { session: await pending, ws, owner }
  }
  it('uses the account token and exact grant, authenticates the owner, and decrypts terminal/viewer output', async () => {
    const { session, ws, owner } = await ready()
    expect(ws.args).toEqual(['ws://localhost:1234/api/observer-ws?share=share&autonomousEnv=prod', ['signed-in-token'], expect.any(Object)])
    expect(sink.sendFrame).toHaveBeenCalledWith({ type: 'connected', payload: { machineId: 'machine', e2ee: false, readOnly: true } })
    await session.send({ type: 'terminal_open', payload: { agentId: 'agent' } })
    const packet = JSON.parse(ws.send.mock.calls.at(-1)[0])
    expect(packet.type).toBe('observer_frame')
    expect(owner.cipher.open(packet.payload)).toEqual({ type: 'terminal_open', payload: { agentId: 'agent' } })
    frame(ws, 'observer_frame', owner.cipher.seal({ type: 'observer_binary', payload: { bytes: Buffer.from('output').toString('base64') } }))
    expect(sink.sendBinary).toHaveBeenCalledWith(Buffer.from('output'))
    frame(ws, 'observer_frame', owner.cipher.seal({ type: 'observer_viewer', payload: { state: 'live', data: 'pixels' } }))
    expect(sink.sendFrame).toHaveBeenCalledWith({ type: 'observer_viewer', payload: { state: 'live', data: 'pixels' } })
    frame(ws, 'unrelated_broadcast')
    ws.emit('error', new Error('socket closing'))
    frame(ws, 'observer_frame', owner.cipher.seal({ type: 'observer_binary', payload: { bytes: 5 } }))
    expect(sink.sendBinary).toHaveBeenCalledTimes(1)
    await session.sendBinary({} as never)
    session.detach()
    expect(state.stop).toHaveBeenCalled(); expect(closed).not.toHaveBeenCalled()
    const count = ws.send.mock.calls.length
    await session.send({ type: 'terminal_alive' })
    expect(ws.send).toHaveBeenCalledTimes(count)
  })
  it('refuses unpublished or wrong-machine grants before opening a socket', async () => {
    discover.mockResolvedValue([])
    await expect(relay.acquire('machine', 'share', sink as never, closed)).rejects.toBeInstanceOf(SharingEndedError)
    discover.mockResolvedValue([{ machineId: 'machine', shares: [] }])
    await expect(relay.acquire('machine', 'share', sink as never, closed)).rejects.toThrow('expired')
    expect(state.sockets).toHaveLength(0)
  })
  it('rejects input, resizing, generic RPCs and grant-management commands on the recipient side', async () => {
    const { session, ws } = await ready()
    const count = ws.send.mock.calls.length
    for (const type of ['terminal_input', 'terminal_resize', 'terminal_paste', 'agent_delete', ...SHARE_REQUEST_TYPES]) {
      await session.send({ type, payload: { requestId: type } })
      expect(sink.sendFrame).toHaveBeenLastCalledWith({ type: `${type}_result`, payload: { requestId: type, error: 'VIEW_ONLY' } })
    }
    await session.send({ type: 'unknown' })
    expect(ws.send).toHaveBeenCalledTimes(count)
    expect(SHARE_RESULT_TYPES).toEqual(new Set([...SHARE_REQUEST_TYPES].map(type => `${type}_result`)))
  })
  it('distinguishes revocation from owner disconnects and ignores sends after a transport closes', async () => {
    const first = await ready()
    first.ws.emit('close', 4403, Buffer.from('Access removed'))
    expect(closed).toHaveBeenCalledWith(4403, 'Access removed')
    first.ws.readyState = 3
    await first.session.send({ type: 'terminal_alive' })
    const second = await ready()
    second.ws.emit('close', 1006, Buffer.alloc(0))
    expect(closed).toHaveBeenLastCalledWith(1012, 'Owner disconnected')
    const third = await ready()
    frame(third.ws, 'observer_closed', { reason: 'Owner disconnected', retry: true })
    expect(closed).toHaveBeenLastCalledWith(1012, 'Owner disconnected')
    const fourth = await ready()
    frame(fourth.ws, 'observer_closed')
    expect(closed).toHaveBeenLastCalledWith(4403, 'Sharing ended')
  })
  it('fails closed on forged identity, malformed frames, and replayed ciphertext', async () => {
    const first = await begin()
    const rejected = expect(first.pending).rejects.toThrow('identity')
    frame(first.ws, 'observer_welcome', { ephemeral: 'forged', signature: 'forged' }); await rejected
    const second = await ready()
    frame(second.ws, 'observer_frame', { __e2e: {} })
    expect(closed).toHaveBeenLastCalledWith(1011, 'Shared harness verification failed')
    const third = await ready()
    third.ws.emit('message', Buffer.from('not JSON'))
    expect(closed).toHaveBeenLastCalledWith(1011, 'The shared harness identity could not be verified.')
    const fourth = await ready()
    const packet = fourth.owner.cipher.seal({ type: 'terminal_output', payload: {} })
    frame(fourth.ws, 'observer_frame', packet); frame(fourth.ws, 'observer_frame', packet)
    expect(closed).toHaveBeenLastCalledWith(1011, 'Shared harness verification failed')
  })
  it('bounds handshake time and releases failures before admission', async () => {
    const first = await begin()
    const timed = expect(first.pending).rejects.toThrow('not responding')
    await vi.advanceTimersByTimeAsync(15_000); await timed
    const second = await begin(); const error = expect(second.pending).rejects.toThrow('Could not connect')
    second.ws.emit('error', new Error('offline')); await error
    const third = await begin(); const revoked = expect(third.pending).rejects.toThrow('Sharing ended')
    frame(third.ws, 'observer_closed'); await revoked
    const fourth = await begin(); const offline = expect(fourth.pending).rejects.toThrow('offline')
    fourth.ws.emit('close', 1006, Buffer.alloc(0)); await offline
  })
})
