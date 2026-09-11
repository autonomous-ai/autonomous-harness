/**
 * Cloudflare Realtime TURN credentials, minted once and served from memory.
 *
 * READ THIS BEFORE MAKING ANY OF IT ASYNC. The snapshot getter is synchronous on purpose, because the
 * only consumer — `terminalP2pPolicy()` — is called from three places that each reject an await for a
 * different reason:
 *   - `webWs.ts` `ack()`: awaiting IS safe there (frames are serialised through `frameChain`), but it
 *     would put a Cloudflare round trip in the middle of every `machine_select` and would need a fresh
 *     `selectGen` staleness re-check afterwards. Latency for no benefit.
 *   - `webWs.ts` per-frame signaling gate: an await there sits IN FRONT of the rate limiter and the
 *     size check, so a flood of `p2p_ice_candidate` frames would each hold the chain open uncounted.
 *   - `adapterWs.ts` gate: `onMessage` is a synchronous `void` arrow, adapterWs has no frame
 *     serialisation at all, and it replays a buffered queue in order at attach. Cannot await, period.
 *
 * So: a background refresh keeps a snapshot warm and every read is a property lookup. The credential
 * is account-wide rather than per-user (Cloudflare does not scope it to our users), so one snapshot
 * shared by every worker is correct — unlike bus.ts, which needs Redis because ITS values are
 * per-machine and the worker that wrote one is rarely the worker that reads it. Four cluster workers
 * minting four credentials every couple of hours is far cheaper than putting Redis in the path of
 * something that must degrade quietly.
 *
 * Every failure degrades to `null`, which the policy renders as STUN-only — the exact behaviour we
 * shipped before TURN existed. Nothing here ever throws.
 */
import { env } from '../config/env.js'
import { logger } from '../utils/logger.js'

export interface TurnCredentials {
  urls: string[]
  username: string
  credential: string
}

interface Snapshot {
  credentials: TurnCredentials
  /** Epoch ms after which the credential must not be handed out any more. */
  expiresAt: number
}

export interface TurnCredentialDeps {
  now?: () => number
  fetchImpl?: typeof fetch
}

/** Refresh once the credential is more than three quarters through its lifetime. */
const REFRESH_AT_REMAINING = 0.25
/** After a failure, do not hammer Cloudflare on every tick. */
const RETRY_AFTER_MS = 60_000
const CLOUDFLARE_TURN_API = 'https://rtc.live.cloudflare.com/v1/turn/keys'

let snapshot: Snapshot | null = null
let inflight: Promise<Snapshot | null> | null = null
let nextAttemptAt = 0
let timer: ReturnType<typeof setInterval> | null = null

function configured(): boolean {
  return !!env.TERMINAL_P2P_TURN_KEY_ID && !!env.TERMINAL_P2P_TURN_API_TOKEN
}

function parseIceServers(body: unknown): TurnCredentials | null {
  if (!body || typeof body !== 'object') return null
  const servers = (body as { iceServers?: unknown }).iceServers
  if (!Array.isArray(servers)) return null
  for (const entry of servers) {
    if (!entry || typeof entry !== 'object') continue
    const { urls, username, credential } = entry as Record<string, unknown>
    if (typeof username !== 'string' || !username) continue
    if (typeof credential !== 'string' || !credential) continue
    const list = (Array.isArray(urls) ? urls : [urls])
      .filter((url): url is string => typeof url === 'string' && /^turns?:/i.test(url))
    if (list.length > 0) return { urls: list, username, credential }
  }
  return null
}

async function mint(deps: Required<TurnCredentialDeps>): Promise<Snapshot | null> {
  const ttl = env.TERMINAL_P2P_TURN_TTL_SECONDS
  let response: Response
  try {
    response = await deps.fetchImpl(
      `${CLOUDFLARE_TURN_API}/${env.TERMINAL_P2P_TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.TERMINAL_P2P_TURN_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl }),
        signal: AbortSignal.timeout(env.TERMINAL_P2P_TURN_TIMEOUT_MS),
      },
    )
  } catch (err) {
    logger.warn('turn credential request failed', { error: String(err) })
    return null
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    logger.warn('turn credential rejected', { status: response.status, detail: detail.slice(0, 200) })
    return null
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    logger.warn('turn credential response was not json')
    return null
  }
  const credentials = parseIceServers(body)
  if (!credentials) {
    logger.warn('turn credential response carried no usable turn entry')
    return null
  }
  return { credentials, expiresAt: deps.now() + ttl * 1000 }
}

async function refresh(deps: Required<TurnCredentialDeps>): Promise<Snapshot | null> {
  if (inflight) return inflight
  const run = mint(deps)
    .then((next) => {
      if (next) {
        snapshot = next
        nextAttemptAt = 0
        return next
      }
      // Keep whatever is still valid; a Cloudflare blip must not disable TURN mid-flight.
      nextAttemptAt = deps.now() + RETRY_AFTER_MS
      return snapshot
    })
    .catch(() => snapshot) // mint() already swallows everything; this is belt and braces
    .finally(() => { inflight = null })
  inflight = run
  return run
}

function resolveDeps(deps: TurnCredentialDeps = {}): Required<TurnCredentialDeps> {
  return {
    now: deps.now ?? ((): number => Date.now()),
    fetchImpl: deps.fetchImpl ?? fetch,
  }
}

/** Synchronous snapshot. `null` means "ship a STUN-only policy" — never an error. */
export function turnCredentials(deps: TurnCredentialDeps = {}): TurnCredentials | null {
  if (!configured()) return null
  const { now } = resolveDeps(deps)
  const current = snapshot
  if (!current) {
    // First read before the boot fetch landed (or after a total failure): kick one off and answer
    // STUN-only for now. The next machine_select gets the credential.
    if (now() >= nextAttemptAt) void refresh(resolveDeps(deps))
    return null
  }
  const ttlMs = env.TERMINAL_P2P_TURN_TTL_SECONDS * 1000
  const remaining = current.expiresAt - now()
  if (remaining <= 0) {
    if (now() >= nextAttemptAt) void refresh(resolveDeps(deps))
    return null
  }
  if (remaining < ttlMs * REFRESH_AT_REMAINING && now() >= nextAttemptAt) {
    void refresh(resolveDeps(deps)) // still serving the current one below; this is a background top-up
  }
  return current.credentials
}

/** Boot hook: mint immediately so the first machine_select already has TURN, then top up on a timer. */
export function startTurnCredentialRefresh(deps: TurnCredentialDeps = {}): void {
  if (!configured()) {
    logger.info('terminal p2p TURN disabled (no TERMINAL_P2P_TURN_KEY_ID)')
    return
  }
  const resolved = resolveDeps(deps)
  void refresh(resolved)
  if (timer) clearInterval(timer)
  // A quarter of the ttl: guarantees at least one attempt inside the refresh window even if one fails.
  const period = Math.max(60_000, (env.TERMINAL_P2P_TURN_TTL_SECONDS * 1000) / 4)
  timer = setInterval(() => { void turnCredentials(deps) }, period)
  timer.unref?.()
}

/** Test seam: forget the snapshot, the in-flight mint and the retry backoff. */
export function resetTurnCredentialsForTest(): void {
  snapshot = null
  inflight = null
  nextAttemptAt = 0
  if (timer) clearInterval(timer)
  timer = null
}
