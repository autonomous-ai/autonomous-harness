/** Management stays on the authenticated hook server, never the LAN listener. */
export interface LampManagement {
  pairStart(options: { replace?: boolean }): unknown | Promise<unknown>
  pairCancel(): unknown | Promise<unknown>
  pairStatus(): unknown | Promise<unknown>
  list(): unknown | Promise<unknown>
  status(): unknown | Promise<unknown>
  revoke(target: { id: string } | { all: true }): unknown | Promise<unknown>
  receipt(target: { lampId: string; idempotencyKey: string }): unknown | Promise<unknown>
}

export interface LampLocalResponse { status: number; body: unknown }

const routes: Record<string, string> = {
  '/api/lamp/pair/start': 'POST',
  '/api/lamp/pair/cancel': 'POST',
  '/api/lamp/pair/status': 'GET',
  '/api/lamp/list': 'GET',
  '/api/lamp/status': 'GET',
  '/api/lamp/revoke': 'POST',
  '/api/lamp/receipt': 'GET',
}

const errorStatus: Record<string, number> = {
  BAD_REQUEST: 400, UNKNOWN_LAMP: 404, ALREADY_PAIRED: 409, BUSY: 409,
  RATE_LIMITED: 429, EXPIRED: 410, CANCELLED: 409,
}

function failure(status: number, code: string, message: string): LampLocalResponse {
  return { status, body: { error: { code, message } } }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function lampId(value: unknown): value is string {
  // Lamp identities are canonical base64 Ed25519 public keys (32 bytes).
  return typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value)
    && Buffer.from(value, 'base64').toString('base64') === value
}

/** The caller must enforce loopback, Origin refusal, and the hook credential first. */
export async function lampLocalRequest(
  service: LampManagement, method: string, requestTarget: string, body?: unknown,
): Promise<LampLocalResponse> {
  const bad = () => failure(400, 'BAD_REQUEST', 'Invalid lamp management request')
  let url: URL
  try {
    if (!requestTarget.startsWith('/') || requestTarget.startsWith('//')) return bad()
    url = new URL(requestTarget, 'http://localhost')
  } catch { return bad() }
  if (url.hash) return bad()
  const expected = routes[url.pathname]
  if (!expected) return failure(404, 'NOT_FOUND', 'Unknown lamp management endpoint')
  if (method !== expected) return failure(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  if (method === 'GET' && body !== undefined) return bad()
  if (url.pathname !== '/api/lamp/receipt' && url.search) return bad()
  const input = body === undefined ? {} : body
  if (!object(input)) return bad()
  const keys = Object.keys(input)
  let call: () => unknown | Promise<unknown>
  switch (url.pathname) {
    case '/api/lamp/pair/start':
      if (keys.some(key => key !== 'replace') || ('replace' in input && typeof input.replace !== 'boolean')) return bad()
      call = () => service.pairStart('replace' in input ? { replace: input.replace as boolean } : {})
      break
    case '/api/lamp/revoke':
      if (keys.length !== 1) return bad()
      if (keys[0] === 'all' && input.all === true) call = () => service.revoke({ all: true })
      else if (keys[0] === 'id' && lampId(input.id)) {
        const id = input.id
        call = () => service.revoke({ id })
      } else return bad()
      break
    case '/api/lamp/receipt': {
      const query = url.searchParams
      if ([...query.keys()].some(key => key !== 'lampId' && key !== 'idempotencyKey')
        || query.getAll('lampId').length !== 1 || query.getAll('idempotencyKey').length !== 1) return bad()
      const id = query.get('lampId')
      const key = query.get('idempotencyKey')
      if (!lampId(id) || !key || !/^[A-Za-z0-9_-]{1,64}$/.test(key)) return bad()
      call = () => service.receipt({ lampId: id, idempotencyKey: key })
      break
    }
    default:
      if (keys.length) return bad()
      switch (url.pathname) {
        case '/api/lamp/pair/cancel': call = () => service.pairCancel(); break
        case '/api/lamp/pair/status': call = () => service.pairStatus(); break
        case '/api/lamp/list': call = () => service.list(); break
        default: call = () => service.status()
      }
  }
  try {
    return { status: 200, body: await call() }
  } catch (error) {
    if (object(error) && typeof error.code === 'string' && Object.hasOwn(errorStatus, error.code)) {
      return failure(errorStatus[error.code], error.code,
        typeof error.message === 'string' ? error.message : 'Lamp management request failed')
    }
    return failure(500, 'INTERNAL_ERROR', 'Lamp management request failed')
  }
}
