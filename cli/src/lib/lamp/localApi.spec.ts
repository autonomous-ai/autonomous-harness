import { describe, expect, it, vi } from 'vitest'
import { lampLocalRequest, type LampManagement } from './localApi.js'

const id = Buffer.alloc(32, 255).toString('base64')
function fixture() {
  return {
    pairStart: vi.fn().mockResolvedValue({ code: 'ABC234' }),
    pairCancel: vi.fn().mockReturnValue({ cancelled: true }),
    pairStatus: vi.fn().mockReturnValue({ state: 'waiting' }),
    list: vi.fn().mockReturnValue({ lamps: [] }),
    status: vi.fn().mockReturnValue({ proto: 1 }),
    revoke: vi.fn().mockReturnValue({ revoked: 1 }),
    receipt: vi.fn().mockReturnValue({ receipt: null }),
  } satisfies LampManagement
}

describe('lamp local management validation', () => {
  it('passes explicit replacement and returns service data without an extra envelope', async () => {
    const service = fixture()
    expect(await lampLocalRequest(service, 'POST', '/api/lamp/pair/start', { replace: true }))
      .toEqual({ status: 200, body: { code: 'ABC234' } })
    expect(service.pairStart).toHaveBeenCalledWith({ replace: true })
  })

  it.each([null, [], true, { replace: 'true' }, { replace: 1 }, { replace: true, all: true }])(
    'never opens a pairing window for invalid input %j', async body => {
      const service = fixture()
      expect((await lampLocalRequest(service, 'POST', '/api/lamp/pair/start', body)).status).toBe(400)
      expect(service.pairStart).not.toHaveBeenCalled()
    },
  )

  it.each([{}, { all: false }, { all: 'true' }, { all: true, id }, { id: '' }, { id: 'unknown' }, { id, replace: true }])(
    'never revokes for ambiguous or invalid input %j', async body => {
      const service = fixture()
      expect((await lampLocalRequest(service, 'POST', '/api/lamp/revoke', body)).status).toBe(400)
      expect(service.revoke).not.toHaveBeenCalled()
    },
  )

  it('revokes exactly the named identity or the explicit all grant', async () => {
    const service = fixture()
    await lampLocalRequest(service, 'POST', '/api/lamp/revoke', { id })
    await lampLocalRequest(service, 'POST', '/api/lamp/revoke', { all: true })
    expect(service.revoke.mock.calls).toEqual([[{ id }], [{ all: true }]])
  })

  it('decodes escaped identity characters and scopes receipt lookup to both identifiers', async () => {
    const service = fixture()
    const query = new URLSearchParams({ lampId: id, idempotencyKey: 'lamp-1' })
    expect(await lampLocalRequest(service, 'GET', `/api/lamp/receipt?${query}`))
      .toEqual({ status: 200, body: { receipt: null } })
    expect(service.receipt).toHaveBeenCalledWith({ lampId: id, idempotencyKey: 'lamp-1' })
  })

  it.each([
    '', 'lampId=x&idempotencyKey=y',
    `lampId=${encodeURIComponent(id)}&idempotencyKey=x&idempotencyKey=y`,
    `lampId=${encodeURIComponent(id)}&idempotencyKey=x&all=true`,
    `lampId=${encodeURIComponent(id)}&idempotencyKey=${'x'.repeat(65)}`,
    `lampId=${encodeURIComponent(id)}&idempotencyKey=a%20b`,
  ])('refuses malformed or duplicate receipt query %s', async query => {
    const service = fixture()
    expect((await lampLocalRequest(service, 'GET', `/api/lamp/receipt?${query}`)).status).toBe(400)
    expect(service.receipt).not.toHaveBeenCalled()
  })

  it.each([
    ['GET', '/api/lamp/pair/start', undefined, 405],
    ['POST', '/api/lamp/unknown', undefined, 404],
    ['GET', '/api/lamp/status?all=true', undefined, 400],
    ['GET', '/api/lamp/status', {}, 400],
    ['POST', '/api/lamp/pair/cancel', { all: true }, 400],
    ['GET', '//other/api/lamp/status', undefined, 400],
  ])('rejects unsupported routing %s %s', async (method, path, body, status) => {
    const service = fixture()
    expect((await lampLocalRequest(service, method as string, path as string, body)).status).toBe(status)
    for (const handler of Object.values(service)) expect(handler).not.toHaveBeenCalled()
  })

  it('maps already-paired to conflict and hides unexpected internal errors', async () => {
    const service = fixture()
    service.pairStart.mockRejectedValue(Object.assign(new Error('A lamp is already paired'), { code: 'ALREADY_PAIRED' }))
    expect(await lampLocalRequest(service, 'POST', '/api/lamp/pair/start'))
      .toEqual({ status: 409, body: { error: { code: 'ALREADY_PAIRED', message: 'A lamp is already paired' } } })
    service.pairStart.mockRejectedValue(new Error('secret-file-content'))
    expect(await lampLocalRequest(service, 'POST', '/api/lamp/pair/start'))
      .toEqual({ status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Lamp management request failed' } } })
  })

  it('routes all read-only and cancel operations', async () => {
    const service = fixture()
    for (const [method, path, name] of [
      ['POST', 'pair/cancel', 'pairCancel'], ['GET', 'pair/status', 'pairStatus'],
      ['GET', 'list', 'list'], ['GET', 'status', 'status'],
    ] as const) {
      expect((await lampLocalRequest(service, method, `/api/lamp/${path}`)).status).toBe(200)
      expect(service[name]).toHaveBeenCalledOnce()
    }
  })
})
