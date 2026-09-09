import { describe, expect, it, vi } from 'vitest'
import { AutonomousDeviceRelay } from './relay.js'
import { AutonomousDeviceService } from './service.js'
import { randomUUID } from 'node:crypto'
function fixture() {
  let role = 'device', identity: string | null = 'trusted-device'
  const submit = vi.fn(), cancel = vi.fn(() => true), send = vi.fn()
  const crypto = { sessionRole: () => role as 'device' | 'web', sessionIdentity: () => identity,
    unwrapDown: (_c: string, frame: Record<string, unknown>) => ({ ...frame, payload: (frame.payload as { __e2e: unknown }).__e2e }),
    wrapTarget: (_c: string, type: string, payload: Record<string, unknown>) => ({ type, payload: { __e2e: payload } }) }
  const service = new AutonomousDeviceService({ machineId: 'machine', agents: () => [{ agentId: 'agent', name: 'Agent', engine: 'codex', state: 'idle' }], submit, cancelDelivery: cancel, stop: async () => true, answer: async () => true, recent: () => [] })
  const remoteRevoke = vi.fn()
  const relay = new AutonomousDeviceRelay(crypto, send, service, 'machine', undefined, remoteRevoke)
  const request = (payload: Record<string, unknown>) => relay.handle('conn', { type: 'autonomous_device_request', payload: { __e2e: payload } })
  return { relay, request, send, submit, service, cancel, remoteRevoke, setRole: (r: string) => { role = r }, revoke: () => { identity = null } }
}
describe('Autonomous device existing E2EE relay seam', () => {
  it('requires existing device-role trust and encrypted payload before calling the service', async () => {
    const f = fixture(); f.setRole('web')
    await f.request({ type: 'hello', proto: 1, requestId: randomUUID() })
    expect(f.send).not.toHaveBeenCalled()
    f.setRole('device'); await f.relay.handle('conn', { type: 'autonomous_device_request', payload: { type: 'hello' } })
    expect(f.send).not.toHaveBeenCalled()
    await f.request({ type: 'hello', proto: 1, requestId: randomUUID() })
    expect(f.send.mock.calls[0][1]).toMatchObject({ type: 'autonomous_device_result', payload: { __e2e: { type: 'hello_result', proto: 1 } } })
  })
  it('uses pinned identity for dedupe and drops revoked queued work', async () => {
    const f = fixture(); await f.request({ type: 'hello', proto: 1, requestId: randomUUID() })
    const req = { type: 'turn.send', requestId: randomUUID(), machineId: 'machine', agentId: 'agent', idempotencyKey: 'one', text: 'hello' }
    await f.request(req); await f.request({ ...req, requestId: randomUUID() })
    expect(f.submit).toHaveBeenCalledTimes(1)
    expect(f.service.receipt('trusted-device', 'one')?.state).toBe('queued')
    f.relay.revoke('trusted-device'); f.revoke()
    expect(f.cancel).toHaveBeenCalledOnce()
    expect(f.service.receipt('trusted-device', 'one')).toBeNull()
    await f.request(req); expect(f.submit).toHaveBeenCalledTimes(1)
  })
  it('removes a device pairing only after its authenticated revoke request', async () => {
    const f = fixture(); await f.request({ type: 'hello', proto: 1, requestId: randomUUID() })
    await f.request({ type: 'pair.revoke', requestId: randomUUID() })
    expect(f.send.mock.calls.at(-1)?.[1]).toMatchObject({
      type: 'autonomous_device_result', payload: { __e2e: { type: 'pair.revoke_result', revoked: true } },
    })
    expect(f.remoteRevoke).toHaveBeenCalledWith('trusted-device')
  })
  it('does not revoke when the request is malformed', async () => {
    const f = fixture(); await f.request({ type: 'hello', proto: 1, requestId: randomUUID() })
    await f.request({ type: 'pair.revoke', requestId: randomUUID(), extra: true })
    expect(f.remoteRevoke).not.toHaveBeenCalled()
  })
})
