// A bodyless DELETE that still carries `Content-Type: application/json`.
//
// This is not a hypothetical: the mobile app sends it on device unpair, and Fastify's default parser
// rejected it with FST_ERR_CTP_EMPTY_JSON_BODY *before the route ran*. The visible symptom was an
// error in the log; the invisible one was that `revokeDeviceForUser` never executed, so the device
// kept its socket and was never told it had been revoked. Hence a real Fastify instance here rather
// than a unit test of the callback — the registration itself is the thing that has to be right.
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerJsonBodyParser } from './jsonBodyParser.js'

async function buildApp() {
  const app = Fastify()
  registerJsonBodyParser(app)
  app.delete('/thing/:id', async (req) => ({ ran: true, id: (req.params as { id: string }).id, body: req.body ?? null }))
  app.post('/thing', async (req) => ({ body: req.body }))
  await app.ready()
  return app
}

describe('application/json body parser', () => {
  it('runs the route when the body is empty — the unpair case', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'DELETE',
      url: '/thing/6a730145e13f6277cdf98c1a',
      headers: { 'content-type': 'application/json' },
      payload: '',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ran: true, id: '6a730145e13f6277cdf98c1a', body: null })
    await app.close()
  })

  it('treats whitespace as empty too', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'DELETE', url: '/thing/x', headers: { 'content-type': 'application/json' }, payload: '   \n ',
    })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('still parses a real body', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST', url: '/thing', headers: { 'content-type': 'application/json' }, payload: '{"name":"Kitchen"}',
    })
    expect(res.json()).toEqual({ body: { name: 'Kitchen' } })
    await app.close()
  })

  it('still rejects malformed JSON with a 400 — tolerance must not become "accept anything"', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST', url: '/thing', headers: { 'content-type': 'application/json' }, payload: '{"name":',
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })
})
