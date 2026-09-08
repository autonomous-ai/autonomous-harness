import { describe, expect, it, vi } from 'vitest'
import { autonomousDeviceLocalRequest, type AutonomousDeviceManagement } from './localApi.js'

const id = Buffer.alloc(32, 255).toString('base64')
function fixture() {
  return {
    discover: vi.fn().mockReturnValue({ devices: [] }),
    pairStart: vi.fn().mockResolvedValue({ state: 'running' }),
    pairStatus: vi.fn().mockReturnValue({ state: 'waiting' }),
    list: vi.fn().mockReturnValue({ devices: [] }),
    status: vi.fn().mockReturnValue({ proto: 1 }),
    revoke: vi.fn().mockReturnValue({ revoked: 1 }),
    receipt: vi.fn().mockReturnValue({ receipt: null }),
  } satisfies AutonomousDeviceManagement
}

describe('device local management validation', () => {
  it('passes the human-entered device code and returns service data without an extra envelope', async () => {
    const service = fixture()
    expect(await autonomousDeviceLocalRequest(service, 'POST', '/api/autonomous-device/pair/start', { code: 'ABC234', device: 'os._autonomous._tcp.local' }))
      .toEqual({ status: 200, body: { state: 'running' } })
    expect(service.pairStart).toHaveBeenCalledWith({ code: 'ABC234', device: 'os._autonomous._tcp.local' })
  })

  it.each([null, [], true, { replace: 'true' }, { replace: 1 }, { replace: true, all: true }])(
    'never opens a pairing window for invalid input %j', async body => {
      const service = fixture()
      expect((await autonomousDeviceLocalRequest(service, 'POST', '/api/autonomous-device/pair/start', body)).status).toBe(400)
      expect(service.pairStart).not.toHaveBeenCalled()
    },
  )

  it.each([{}, { all: false }, { all: 'true' }, { all: true, id }, { id: '' }, { id: 'unknown' }, { id, replace: true }])(
    'never revokes for ambiguous or invalid input %j', async body => {
      const service = fixture()
      expect((await autonomousDeviceLocalRequest(service, 'POST', '/api/autonomous-device/revoke', body)).status).toBe(400)
      expect(service.revoke).not.toHaveBeenCalled()
    },
  )

  it('revokes only a full existing-manager fingerprint and refuses blanket all', async () => {
    const service = fixture(), fingerprint = 'ABCD·1234·5678·90EF'
    expect((await autonomousDeviceLocalRequest(service, 'POST', '/api/autonomous-device/revoke', { id: fingerprint })).status).toBe(200)
    expect(service.revoke).toHaveBeenCalledWith({ id: fingerprint })
    expect((await autonomousDeviceLocalRequest(service, 'POST', '/api/autonomous-device/revoke', { all: true })).status).toBe(400)
  })

  it('decodes escaped identity characters and scopes receipt lookup to both identifiers', async () => {
    const service = fixture()
    const query = new URLSearchParams({ deviceId: id, idempotencyKey: 'device-1' })
    expect(await autonomousDeviceLocalRequest(service, 'GET', `/api/autonomous-device/receipt?${query}`))
      .toEqual({ status: 200, body: { receipt: null } })
    expect(service.receipt).toHaveBeenCalledWith({ deviceId: id, idempotencyKey: 'device-1' })
  })

  it.each([
    '', 'deviceId=x&idempotencyKey=y',
    `deviceId=${encodeURIComponent(id)}&idempotencyKey=x&idempotencyKey=y`,
    `deviceId=${encodeURIComponent(id)}&idempotencyKey=x&all=true`,
    `deviceId=${encodeURIComponent(id)}&idempotencyKey=${'x'.repeat(65)}`,
    `deviceId=${encodeURIComponent(id)}&idempotencyKey=a%20b`,
  ])('refuses malformed or duplicate receipt query %s', async query => {
    const service = fixture()
    expect((await autonomousDeviceLocalRequest(service, 'GET', `/api/autonomous-device/receipt?${query}`)).status).toBe(400)
    expect(service.receipt).not.toHaveBeenCalled()
  })

  it.each([
    ['GET', '/api/autonomous-device/pair/start', undefined, 405],
    ['POST', '/api/autonomous-device/unknown', undefined, 404],
    ['GET', '/api/autonomous-device/status?all=true', undefined, 400],
    ['GET', '/api/autonomous-device/status', {}, 400],
    ['POST', '/api/autonomous-device/pair/cancel', { all: true }, 404],
    ['GET', '//other/api/autonomous-device/status', undefined, 400],
  ])('rejects unsupported routing %s %s', async (method, path, body, status) => {
    const service = fixture()
    expect((await autonomousDeviceLocalRequest(service, method as string, path as string, body)).status).toBe(status)
    for (const handler of Object.values(service)) expect(handler).not.toHaveBeenCalled()
  })

  it('maps already-paired to conflict and hides unexpected internal errors', async () => {
    const service = fixture()
    service.pairStart.mockRejectedValue(Object.assign(new Error('A device is already paired'), { code: 'ALREADY_PAIRED' }))
    expect(await autonomousDeviceLocalRequest(service, 'POST', '/api/autonomous-device/pair/start', { code: 'ABC234', device: 'os._autonomous._tcp.local' }))
      .toEqual({ status: 409, body: { error: { code: 'ALREADY_PAIRED', message: 'A device is already paired' } } })
    service.pairStart.mockRejectedValue(new Error('secret-file-content'))
    expect(await autonomousDeviceLocalRequest(service, 'POST', '/api/autonomous-device/pair/start', { code: 'ABC234', device: 'os._autonomous._tcp.local' }))
      .toEqual({ status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Autonomous device management request failed' } } })
  })

  it('routes all read-only and cancel operations', async () => {
    const service = fixture()
    for (const [method, path, name] of [
      ['GET', 'pair/status', 'pairStatus'],
      ['GET', 'list', 'list'], ['GET', 'status', 'status'],
    ] as const) {
      expect((await autonomousDeviceLocalRequest(service, method, `/api/autonomous-device/${path}`)).status).toBe(200)
      expect(service[name]).toHaveBeenCalledOnce()
    }
  })
})
