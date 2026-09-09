/** Thin local facade for the existing relay pairing manager. */
export interface AutonomousDeviceManagement {
  discover(): unknown | Promise<unknown>
  pairStart(options: { code: string; device: string }): unknown | Promise<unknown>
  pairStatus(): unknown | Promise<unknown>
  list(): unknown | Promise<unknown>
  status(): unknown | Promise<unknown>
  revoke(target: { id: string }): unknown | Promise<unknown>
  receipt(target: { deviceId: string; idempotencyKey: string }): unknown | Promise<unknown>
}

export interface AutonomousDeviceLocalResponse { status: number; body: unknown }

const routes: Record<string, string> = {
  '/api/autonomous-device/discover': 'GET',
  '/api/autonomous-device/pair/start': 'POST',
  '/api/autonomous-device/pair/status': 'GET',
  '/api/autonomous-device/list': 'GET',
  '/api/autonomous-device/status': 'GET',
  '/api/autonomous-device/revoke': 'POST',
  '/api/autonomous-device/receipt': 'GET',
}

const errorStatus: Record<string, number> = {
  BAD_REQUEST: 400, UNKNOWN_DEVICE: 404, ALREADY_PAIRED: 409, BUSY: 409,
  DEVICE_NOT_FOUND: 404, BAD_CODE: 400, NO_INTENT: 409, STALE_PAIR: 409, CODE_MISMATCH: 403, BACKEND_DOWN: 503, TIMEOUT: 504, RATE_LIMITED: 429, EXPIRED: 410, CANCELLED: 409,
}

function failure(status: number, code: string, message: string): AutonomousDeviceLocalResponse {
  return { status, body: { error: { code, message } } }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function deviceId(value: unknown): value is string {
  // Autonomous device identities are canonical base64 Ed25519 public keys (32 bytes).
  return typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value)
    && Buffer.from(value, 'base64').toString('base64') === value
}

/** The caller must enforce loopback, Origin refusal, and the hook credential first. */
export async function autonomousDeviceLocalRequest(
  service: AutonomousDeviceManagement, method: string, requestTarget: string, body?: unknown,
): Promise<AutonomousDeviceLocalResponse> {
  const bad = () => failure(400, 'BAD_REQUEST', 'Invalid device management request')
  let url: URL
  try {
    if (!requestTarget.startsWith('/') || requestTarget.startsWith('//')) return bad()
    url = new URL(requestTarget, 'http://localhost')
  } catch { return bad() }
  if (url.hash) return bad()
  const expected = routes[url.pathname]
  if (!expected) return failure(404, 'NOT_FOUND', 'Unknown device management endpoint')
  if (method !== expected) return failure(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  if (method === 'GET' && body !== undefined) return bad()
  if (url.pathname !== '/api/autonomous-device/receipt' && url.search) return bad()
  const input = body === undefined ? {} : body
  if (!object(input)) return bad()
  const keys = Object.keys(input)
  let call: () => unknown | Promise<unknown>
  switch (url.pathname) {
    case '/api/autonomous-device/pair/start':
      if (keys.some(key => !['code', 'device'].includes(key)) || typeof input.code !== 'string' || input.code.length > 32 || typeof input.device !== 'string' || !input.device || input.device.length > 255) return bad()
      call = () => service.pairStart({ code: input.code as string, device: input.device as string })
      break
    case '/api/autonomous-device/revoke':
      if (keys.length !== 1 || keys[0] !== 'id' || typeof input.id !== 'string' || !/^[A-F0-9]{4}(?:·[A-F0-9]{4}){3}$/.test(input.id)) return bad()
      const id = input.id
      call = () => service.revoke({ id })
      break
    case '/api/autonomous-device/receipt': {
      const query = url.searchParams
      if ([...query.keys()].some(key => key !== 'deviceId' && key !== 'idempotencyKey')
        || query.getAll('deviceId').length !== 1 || query.getAll('idempotencyKey').length !== 1) return bad()
      const id = query.get('deviceId')
      const key = query.get('idempotencyKey')
      if (!deviceId(id) || !key || !/^[A-Za-z0-9_-]{1,64}$/.test(key)) return bad()
      call = () => service.receipt({ deviceId: id, idempotencyKey: key })
      break
    }
    default:
      if (keys.length) return bad()
      switch (url.pathname) {
        case '/api/autonomous-device/discover': call = () => service.discover(); break
        case '/api/autonomous-device/pair/status': call = () => service.pairStatus(); break
        case '/api/autonomous-device/list': call = () => service.list(); break
        default: call = () => service.status()
      }
  }
  try {
    return { status: 200, body: await call() }
  } catch (error) {
    if (object(error) && typeof error.code === 'string' && Object.hasOwn(errorStatus, error.code)) {
      return failure(errorStatus[error.code], error.code,
        typeof error.message === 'string' ? error.message : 'Autonomous device management request failed')
    }
    return failure(500, 'INTERNAL_ERROR', 'Autonomous device management request failed')
  }
}
