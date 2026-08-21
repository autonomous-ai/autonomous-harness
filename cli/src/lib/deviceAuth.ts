/**
 * The device-authorization grant (RFC 8628-shaped), client half.
 *
 * The CLI cannot do a browser OAuth redirect — the backend pins `redirect_uri` to the WEB callback
 * page — so it never handles a credential of the user's at all. It shows a six-character code, the
 * user approves it in a browser where they are already signed in, and this polls until a MACHINE key
 * comes back. That key is the only credential a machine ever needs; nothing user-scoped is minted.
 *
 * Deliberately free of any cli.ts import: the base URL and the clock are parameters, so the polling
 * loop is unit-testable without a daemon, a filesystem or a real two-second wait.
 */

export interface DeviceAuthStart {
  /** The six characters the human retypes. Display as-is. */
  userCode: string
  /** 32-byte hex bearer secret. Never printed — it is what redeems the machine key. */
  deviceCode: string
  expiresIn: number
  interval: number
}

export type ApprovalOutcome =
  | { status: 'approved'; apiKey: string; machineId: string }
  | { status: 'denied'; error?: string }
  | { status: 'expired' }

/** The backend's `{ success, data }` envelope, unwrapped. */
async function postJson<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as {
    success?: boolean
    data?: T
    error?: { message?: string }
  }
  if (!res.ok || json.success === false) throw new Error(json.error?.message || `HTTP ${res.status}`)
  return json.data as T
}

/** Mint a pending request. Unauthenticated by design — the CLI has no credential yet, which is the point. */
export async function startDeviceAuth(
  baseUrl: string,
  computerId: string,
  label: string,
): Promise<DeviceAuthStart> {
  const out = await postJson<Partial<DeviceAuthStart>>(baseUrl, '/api/device-auth/start', {
    computerId,
    label,
  })
  if (!out?.userCode || !out?.deviceCode) throw new Error('backend did not return a pairing code')
  return {
    userCode: out.userCode,
    deviceCode: out.deviceCode,
    // Floors, not defaults: a backend that omits these must not turn into a tight spin loop.
    expiresIn: Number(out.expiresIn) > 0 ? Number(out.expiresIn) : 600,
    interval: Number(out.interval) > 0 ? Number(out.interval) : 2,
  }
}

export interface AwaitApprovalOptions {
  intervalSec: number
  expiresInSec: number
  /** Called before each sleep, for a progress heartbeat. */
  onTick?: () => void
  /** Injected in tests; real callers get the wall clock and a real timer. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** The floor the backend advertises (POLL_MIN_INTERVAL_SEC). Never poll faster, whatever it sends. */
const MIN_INTERVAL_SEC = 2

/**
 * Poll until the code is approved, denied, or its ten minutes run out.
 *
 * Network failures are swallowed and the loop continues: a laptop that sleeps or changes wifi between
 * printing the code and the user approving it must not lose the grant — the deadline is what ends this,
 * not one failed request.
 */
export async function awaitApproval(
  baseUrl: string,
  deviceCode: string,
  opts: AwaitApprovalOptions,
): Promise<ApprovalOutcome> {
  const now = opts.now ?? (() => Date.now())
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const intervalMs = Math.max(MIN_INTERVAL_SEC, opts.intervalSec) * 1000
  const deadline = now() + opts.expiresInSec * 1000

  while (now() < deadline) {
    try {
      const out = await postJson<{
        status?: string
        apiKey?: string
        machineId?: string
        error?: string
      }>(baseUrl, '/api/device-auth/poll', { deviceCode })
      if (out?.status === 'approved' && out.apiKey && out.machineId) {
        return { status: 'approved', apiKey: out.apiKey, machineId: out.machineId }
      }
      if (out?.status === 'denied') return { status: 'denied', error: out.error }
      // 'expired' is also how the backend answers an ALREADY-CONSUMED code — the poll that returns the
      // key deletes it — so it is terminal either way.
      if (out?.status === 'expired') return { status: 'expired' }
    } catch { /* transient: keep polling until the deadline */ }
    opts.onTick?.()
    await sleep(intervalMs)
  }
  return { status: 'expired' }
}
