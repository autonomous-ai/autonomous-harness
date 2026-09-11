import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  subscribeDown: vi.fn(),
  setAgentPresence: vi.fn(async () => undefined),
  clearAgentPresence: vi.fn(async () => undefined),
  publishUp: vi.fn(async () => 1),
  recomputeAndSendClients: vi.fn(async () => undefined),
  agentsByManager: new Map<string, Set<string>>(),
  controlSockets: new Map<string, unknown>(),
}))

vi.mock('./prisma.js', () => ({ prisma: { manager: { findUnique: vi.fn() } } }))
vi.mock('./bus.js', () => ({
  publishUp: state.publishUp,
  subscribeDown: state.subscribeDown,
  setAgentPresence: state.setAgentPresence,
  clearAgentPresence: state.clearAgentPresence,
  subscribeMgr: vi.fn(async () => vi.fn()),
  publishReply: vi.fn(async () => 1),
  subscribeAppDown: vi.fn(async () => vi.fn()),
  publishAppUp: vi.fn(async () => 1),
  setAppInstance: vi.fn(async () => undefined),
  clearAppInstance: vi.fn(async () => undefined),
}))
vi.mock('../config/env.js', () => ({ env: { MESH_ENABLED: false } }))
vi.mock('./instance.js', () => ({ INSTANCE_ID: 'backend-test' }))
vi.mock('./registry.js', () => ({
  PROCESS_ID: 'backend-test',
  addManager: (key: string) => { state.agentsByManager.set(key, new Set()) },
  removeManager: (key: string) => {
    const agents = [...(state.agentsByManager.get(key) ?? [])]
    state.agentsByManager.delete(key)
    return agents
  },
  bindAgentManager: (machineId: string, key: string) => { state.agentsByManager.get(key)?.add(machineId) },
  unbindAgent: (machineId: string, key: string) => { state.agentsByManager.get(key)?.delete(machineId) },
  agentsForManager: (key: string) => [...(state.agentsByManager.get(key) ?? [])],
  bindControlSocket: (machineId: string, ws: unknown) => { state.controlSockets.set(machineId, ws) },
  unbindControlSocket: (machineId: string, ws: unknown) => {
    if (state.controlSockets.get(machineId) === ws) state.controlSockets.delete(machineId)
  },
  controlSocketFor: (machineId: string) => state.controlSockets.get(machineId),
  bindAppSocket: vi.fn(),
  unbindAppSocket: vi.fn(),
}))
vi.mock('./appTunnel.js', () => ({ deliverAppUpLocal: vi.fn(() => false) }))
vi.mock('./hub.js', () => ({
  CLIENTS_DIRTY: '__clients_dirty',
  deliverUpLocal: vi.fn(),
  recomputeAndSendClients: state.recomputeAndSendClients,
}))
vi.mock('./agentTracker.js', () => ({ recordCreatedAgent: vi.fn(), recordDeletedAgent: vi.fn() }))
vi.mock('./machineLifecycle.js', () => ({
  getMachineLifecycleState: vi.fn(async () => ({ status: 'stopped', stopReason: 'idle_timeout' })),
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { attachManager } from './managerWs.js'

class FakeManagerSocket extends EventEmitter {
  readyState = 1
  send = vi.fn()
  terminate = vi.fn()
}

describe('manager node readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.agentsByManager.clear()
    state.controlSockets.clear()
  })

  it('does not advertise presence until the cross-instance down route is subscribed', async () => {
    let finishSubscribe: ((unsub: () => void) => void) | undefined
    let deliverDown: ((msg: { connId: string; frame: unknown }) => void) | undefined
    state.subscribeDown.mockImplementation((_machineId, callback) => {
      deliverDown = callback
      return new Promise<() => void>((resolve) => { finishSubscribe = resolve })
    })
    const ws = new FakeManagerSocket()
    attachManager(ws as never, 'manager-1', 'control')

    ws.emit('message', Buffer.from(JSON.stringify({ t: 'register', machineId: 'machine-1' })))
    ws.emit('message', Buffer.from(JSON.stringify({ t: 'ping' })))
    await Promise.resolve()

    expect(state.subscribeDown).toHaveBeenCalledWith('machine-1', expect.any(Function))
    expect(state.setAgentPresence).not.toHaveBeenCalled()
    expect(state.publishUp).not.toHaveBeenCalledWith('machine-1', expect.objectContaining({
      frame: { type: 'node_status', payload: { online: true, status: 'running' } },
    }))

    finishSubscribe?.(vi.fn())
    await vi.waitFor(() => expect(state.setAgentPresence).toHaveBeenCalledWith('machine-1', 'manager-1', 30))
    await vi.waitFor(() => expect(state.publishUp).toHaveBeenCalledWith('machine-1', expect.objectContaining({
      frame: { type: 'node_status', payload: { online: true, status: 'running' } },
    })))
    deliverDown?.({ connId: 'device-1', frame: { type: 'message', payload: { content: 'voice transcript' } } })
    expect(ws.send).toHaveBeenCalledTimes(1)
    expect(JSON.parse(ws.send.mock.calls[0][0])).toEqual({
      t: 'down',
      machineId: 'machine-1',
      connId: 'device-1',
      frame: { type: 'message', payload: { content: 'voice transcript' } },
    })

    ws.emit('close')
  })
})
