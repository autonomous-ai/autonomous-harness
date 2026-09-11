import type { FastifyInstance } from 'fastify'

/**
 * Accept `Content-Type: application/json` with an EMPTY body.
 *
 * A DELETE with no body is ordinary HTTP, but plenty of clients — the Autonomous mobile app among
 * them — still send the JSON content-type on one. Fastify's default parser treats an empty body as an
 * error (`FST_ERR_CTP_EMPTY_JSON_BODY`), so those requests died at the parser BEFORE reaching the
 * route. That is how a device unpair could return an error while never revoking anything: the
 * handler, and therefore the revoke push down to the device, never ran.
 *
 * Empty now means "no body". Anything non-empty must still be valid JSON.
 */
export function registerJsonBodyParser(app: FastifyInstance): void {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const raw = typeof body === 'string' ? body.trim() : ''
    if (!raw) { done(null, undefined); return }
    try {
      done(null, JSON.parse(raw))
    } catch {
      const err = new Error('Body is not valid JSON') as Error & { statusCode?: number; code?: string }
      err.statusCode = 400
      err.code = 'FST_ERR_CTP_INVALID_JSON_BODY'
      done(err)
    }
  })
}
