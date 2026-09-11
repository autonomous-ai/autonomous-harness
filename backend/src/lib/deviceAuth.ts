import { randomBytes, createHash } from 'crypto'
import { pub } from './bus.js'
import { logger } from '../utils/logger.js'

/**
 * Device-authorization grant (RFC 8628-shaped) for the `harness` CLI and the desktop app.
 *
 * Neither can do a browser OAuth redirect: `/api/auth/authorize` pins `redirect_uri` to the WEB
 * callback page, and registering a native/loopback redirect with the SSO client is not something this
 * repo controls. So instead of inventing a second auth path, the client never sees a credential of the
 * user's at all — it shows a short code, the user approves it in a browser where they are ALREADY
 * signed in, and the client polls until a machine key comes back.
 *
 * What the client receives is a machine apiKey, not an SSO token: it is a machine, and that is the only
 * credential a machine ever needs. Nothing user-scoped is minted for it.
 *
 * Redis, not Mongo: every record here is dead within ten minutes and a crashed worker losing one costs
 * the user a retry, not data.
 */

const TTL_SEC = 600            // 10 minutes to walk to a browser and type six characters
const POLL_MIN_INTERVAL_SEC = 2

// Crockford base32 minus I/L/O/U — same alphabet the device pairing code uses, for the same reason:
// these get read off one screen and typed into another.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export type DeviceAuthState = 'pending' | 'approved' | 'denied'

export interface DeviceAuthRecord {
  state: DeviceAuthState
  computerId: string
  label: string
  /** Set once approved: the machine the user chose for this computer. */
  machineId?: string
  apiKey?: string
  userId?: string
  error?: string
}

const codeKey = (userCode: string): string => `devauth:code:${userCode}`
const deviceKey = (deviceHash: string): string => `devauth:dev:${deviceHash}`
const claimKey = (deviceHash: string): string => `devauth:claim:${deviceHash}`

/** The device code is a bearer secret, so only its hash is stored — a Redis dump must not be a key store. */
const hash = (s: string): string => createHash('sha256').update(s).digest('hex')

function newUserCode(): string {
  const b = randomBytes(6)
  return Array.from(b, (x) => ALPHABET[x % ALPHABET.length]).join('')
}

export interface StartResult {
  deviceCode: string
  userCode: string
  expiresInSec: number
  intervalSec: number
}

export async function startDeviceAuth(computerId: string, label: string): Promise<StartResult> {
  const deviceCode = randomBytes(32).toString('hex')
  // One retry on collision; the space is 32^6 and records live ten minutes, so a second clash is noise.
  let userCode = newUserCode()
  if (await pub.exists(codeKey(userCode))) userCode = newUserCode()

  const record: DeviceAuthRecord = { state: 'pending', computerId, label }
  const payload = JSON.stringify(record)
  await pub.set(deviceKey(hash(deviceCode)), payload, 'EX', TTL_SEC)
  // The user-facing code maps to the device record, so approving by code can find it.
  await pub.set(codeKey(userCode), hash(deviceCode), 'EX', TTL_SEC)
  return { deviceCode, userCode, expiresInSec: TTL_SEC, intervalSec: POLL_MIN_INTERVAL_SEC }
}

/** Look up a pending request by the code the human typed. */
export async function findByUserCode(userCode: string): Promise<{ deviceHash: string; record: DeviceAuthRecord } | null> {
  const normalized = normalizeUserCode(userCode)
  const deviceHash = await pub.get(codeKey(normalized))
  if (!deviceHash) return null
  const raw = await pub.get(deviceKey(deviceHash))
  if (!raw) return null
  try { return { deviceHash, record: JSON.parse(raw) as DeviceAuthRecord } } catch { return null }
}

export async function resolveDeviceAuth(
  deviceHash: string,
  update: Partial<DeviceAuthRecord>,
): Promise<void> {
  const raw = await pub.get(deviceKey(deviceHash))
  if (!raw) return
  let record: DeviceAuthRecord
  try { record = JSON.parse(raw) as DeviceAuthRecord } catch { return }
  const next = { ...record, ...update }
  // Keep the remaining TTL rather than extending it: approval does not entitle the app to another
  // ten minutes of polling.
  const ttl = await pub.ttl(deviceKey(deviceHash))
  await pub.set(deviceKey(deviceHash), JSON.stringify(next), 'EX', ttl > 0 ? ttl : 60)
}

/**
 * Take exclusive ownership of a pending request before acting on it.
 *
 * `findByUserCode` + "is it still pending?" is check-then-act, and approving is NOT idempotent: it can
 * create a machine. Two approvals racing the same code therefore both saw `pending`, both found no
 * machine bound to the computer, and both created one — two machines, one computer, a millisecond
 * apart. React's StrictMode double-invoking an effect is enough to trigger it, and so is a double-click.
 *
 * `SET NX` is the whole lock: the first caller gets it, everyone else is told the code is spent. It
 * inherits the request's remaining TTL, so a crashed approval cannot wedge a code for longer than the
 * code itself lives.
 */
export async function claimDeviceAuth(deviceHash: string): Promise<boolean> {
  const ttl = await pub.ttl(deviceKey(deviceHash))
  const res = await pub.set(claimKey(deviceHash), '1', 'EX', ttl > 0 ? ttl : 60, 'NX')
  return res === 'OK'
}

/** Hand the claim back when an approval fails, so the user can fix the problem and retry the code. */
export async function releaseDeviceAuthClaim(deviceHash: string): Promise<void> {
  try { await pub.del(claimKey(deviceHash)) } catch (err) { logger.error('[devauth] claim release failed', err) }
}

/**
 * Poll. A successful read is DESTRUCTIVE — the apiKey is handed over exactly once, so a leaked device
 * code cannot be replayed later to fetch the same machine key again.
 */
export async function pollDeviceAuth(deviceCode: string): Promise<DeviceAuthRecord | null> {
  const dh = hash(deviceCode)
  const raw = await pub.get(deviceKey(dh))
  if (!raw) return null
  let record: DeviceAuthRecord
  try { record = JSON.parse(raw) as DeviceAuthRecord } catch { return null }
  if (record.state === 'approved' || record.state === 'denied') {
    try { await pub.del(deviceKey(dh), claimKey(dh)) } catch (err) { logger.error('[devauth] cleanup failed', err) }
  }
  return record
}

/**
 * One wire form for a computer id, whoever sent it: the CLI persists a dashed uuid
 * (`~/.harness/computer-id`) while the Mac app already hashes to 32 hex. Lowercased and de-dashed so
 * the SAME computer is the same string in Mongo regardless of which client asked — the reuse lookup
 * in machineService.resolveOrCreateForComputer is an equality match and would otherwise miss.
 * Returns null when it is not a plausible id (the caller answers 400).
 */
export function normalizeComputerId(raw: string): string | null {
  const v = raw.trim().toLowerCase().replace(/-/g, '')
  return /^[a-f0-9]{16,64}$/.test(v) ? v : null
}

/** Uppercase, strip separators, fold look-alikes — the user is copying this off a screen. */
export function normalizeUserCode(code: string): string {
  return code.toUpperCase().replace(/[\s\-_·]/g, '')
    .replace(/I/g, '1').replace(/L/g, '1').replace(/O/g, '0').replace(/U/g, 'V')
}
