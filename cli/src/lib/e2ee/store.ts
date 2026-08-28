/**
 * E2EE persistence for the adapter: the computer's long-term identity keypair and the set of pinned
 * (paired) browser identities. Both live under ${ADAPTER_DATA_DIR}/e2e/, written immediately with
 * mode 0600 (pairs are rare — no debounce needed). The identity key is the root of trust; losing it
 * forces every browser to re-pair.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { env } from '../../config/env.js'
import { newIdentity, newPairId, b64e, b64d, fingerprint, encodeSetupToken, verifySetupToken, type Identity, type PairRole } from './core.js'
import { stretchPassword } from './passwordPake.js'

const DIR = join(env.ADAPTER_DATA_DIR, 'e2e')
const IDENTITY_FILE = join(DIR, 'identity.json')
const PAIRED_FILE = join(DIR, 'paired.json')
const REMOTE_PASSWORD_FILE = join(DIR, 'remotePassword.json')
const SETUP_TTL_MS = 7 * 24 * 60 * 60 * 1000

// Remote-password lockout tuning (anti online-guessing for a reusable, human-memorable secret — see
// notePwFailure()/pwLockedUntil()). Distinct regime from the live pairing code's RATE_MAX=3/5min in
// manager.ts: that code is disposable and expires in 60s, so a handful of tries exhausts it quickly;
// this password is long-lived, so failures need a real, growing lockout instead.
const PW_FAIL_WINDOW_MS = 30 * 60 * 1000
const PW_FAIL_THRESHOLD = 5
const PW_LOCKOUT_BASE_MS = 5 * 60 * 1000 // 5 min
const PW_LOCKOUT_MAX_MS = 24 * 60 * 60 * 1000 // 24h, cap for the exponential backoff

interface RemotePasswordRecord {
  v: 1
  stretched: string // base64 — the 32-byte scrypt output, not the raw password
  setAt: number
  recentFailures: number[] // ms-epoch timestamps of recent failed attempts, trimmed to PW_FAIL_WINDOW_MS
  lockedUntil?: number
  lockoutCount?: number // consecutive lockouts since the password was last set — drives the backoff
}

export interface PairedClient {
  identityPub: string // base64 Ed25519 pubkey — the pin
  label: string       // UA-derived, for display
  pairedAt: number
  role: PairRole      // old records without this field are treated as web
}
function writeSecure(file: string, data: unknown): void {
  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 })
}

export class E2eeStore {
  private identity: Identity | null = null
  private paired = new Map<string, PairedClient>() // key = identityPub (base64)
  private remotePassword: RemotePasswordRecord | null = null

  /** Load or create the computer identity keypair; load the paired set + remote-password state.
   *  Idempotent. */
  init(): Identity {
    if (this.identity) return this.identity
    try {
      const raw = JSON.parse(readFileSync(IDENTITY_FILE, 'utf-8')) as { priv: string; pub: string }
      this.identity = { priv: b64d(raw.priv), pub: b64d(raw.pub) }
    } catch {
      const id = newIdentity()
      writeSecure(IDENTITY_FILE, { priv: b64e(id.priv), pub: b64e(id.pub) })
      this.identity = id
    }
    try {
      const arr = JSON.parse(readFileSync(PAIRED_FILE, 'utf-8')) as Array<PairedClient & { role?: PairRole }>
      for (const p of arr) {
        if (p?.identityPub) this.paired.set(p.identityPub, { ...p, role: p.role === 'device' ? 'device' : 'web' })
      }
    } catch { /* none yet */ }
    try {
      const raw = JSON.parse(readFileSync(REMOTE_PASSWORD_FILE, 'utf-8')) as Partial<RemotePasswordRecord>
      if (raw?.v === 1 && typeof raw.stretched === 'string' && typeof raw.setAt === 'number') {
        this.remotePassword = {
          v: 1,
          stretched: raw.stretched,
          setAt: raw.setAt,
          recentFailures: Array.isArray(raw.recentFailures) ? raw.recentFailures.filter((n) => typeof n === 'number') : [],
          lockedUntil: typeof raw.lockedUntil === 'number' ? raw.lockedUntil : undefined,
          lockoutCount: typeof raw.lockoutCount === 'number' ? raw.lockoutCount : undefined,
        }
      }
    } catch { /* none yet */ }
    return this.identity
  }

  getIdentity(): Identity {
    return this.identity ?? this.init()
  }

  /** The computer identity's human fingerprint (shown on both CLI and browser to compare). */
  fingerprint(): string {
    return fingerprint(this.getIdentity().pub)
  }

  isPaired(identityPubB64: string): boolean {
    return this.paired.has(identityPubB64)
  }

  pairedRole(identityPubB64: string): PairRole | null {
    return this.paired.get(identityPubB64)?.role ?? null
  }

  addPaired(identityPubB64: string, label: string, at: number, role: PairRole = 'web'): void {
    this.paired.set(identityPubB64, { identityPub: identityPubB64, label, pairedAt: at, role })
    writeSecure(PAIRED_FILE, [...this.paired.values()])
  }

  removePaired(identityPubB64: string): void {
    if (this.paired.delete(identityPubB64)) writeSecure(PAIRED_FILE, [...this.paired.values()])
  }

  /** Revoke ALL paired browsers. Returns the number removed. */
  clear(): number {
    const n = this.paired.size
    if (n) { this.paired.clear(); writeSecure(PAIRED_FILE, []) }
    return n
  }

  list(): PairedClient[] {
    return [...this.paired.values()]
  }
  count(): number {
    return this.paired.size
  }

  createSetupToken(machineId?: string, ttlMs = SETUP_TTL_MS): { token: string; expiresAt: number; fingerprint: string } {
    const id = this.getIdentity()
    const nonce = b64e(newPairId()).replace(/=+$/g, '')
    const expiresAt = Date.now() + ttlMs
    const payload = { v: 1 as const, typ: 'adapter-e2ee-setup' as const, pub: b64e(id.pub), nonce, exp: expiresAt, ...(machineId ? { machineId } : {}) }
    return { token: encodeSetupToken(payload, id.priv), expiresAt, fingerprint: this.fingerprint() }
  }

  /** Validate a reusable setup link. The signed token is the capability: successful claims never
   * consume server-side state, so the same unexpired link can pair multiple browser identities —
   * including a link whose nonce was consumed by an older one-time build before an upgrade. */
  validateSetupToken(token: string, expectedMachineId?: string): { ok: true; fingerprint: string } | { ok: false; error: 'BAD_TOKEN' | 'WRONG_ADAPTER' } {
    const id = this.getIdentity()
    const verified = verifySetupToken(token, Date.now(), expectedMachineId)
    if (!verified) return { ok: false, error: 'BAD_TOKEN' }
    if (b64e(id.pub) !== verified.payload.pub) return { ok: false, error: 'WRONG_ADAPTER' }
    return { ok: true, fingerprint: this.fingerprint() }
  }

  // ── persistent remote password (machine-to-machine `harness link connect`) ───────────────────────
  // A fourth, separate trust primitive from the three above: not a browser pairing (paired.json), not
  // a one-time signed token (createSetupToken), and not the live 6-char CPace code — see
  // passwordPake.ts for why this needs its own domain-separated CPace generator, and manager.ts's
  // onPwPairIntent/onPwPake for the state machine that consumes remotePasswordVerifier()/
  // notePwFailure()/notePwSuccess() below.

  /** Stretch + persist a new remote password (0600, same convention as identity.json/paired.json).
   *  Rotating the password always clears any existing lockout — a fresh secret invalidates whatever
   *  guessing history applied to the old one. */
  async setRemotePassword(machineId: string, password: string): Promise<{ fingerprint: string }> {
    const stretched = await stretchPassword(password, machineId)
    const record: RemotePasswordRecord = { v: 1, stretched: b64e(stretched), setAt: Date.now(), recentFailures: [] }
    this.remotePassword = record
    writeSecure(REMOTE_PASSWORD_FILE, record)
    return { fingerprint: fingerprint(stretched) }
  }

  /** Remove the remote password. Until a new one is set, `harness link connect` against this machine
   *  always fails with NO_REMOTE_PASSWORD (checked before any crypto runs). */
  clearRemotePassword(): void {
    this.remotePassword = null
    try { rmSync(REMOTE_PASSWORD_FILE, { force: true }) } catch { /* already gone */ }
  }

  hasRemotePassword(): boolean {
    return this.remotePassword !== null
  }

  /** The raw stretched verifier bytes, fed into passwordPake.ts's pwCpaceGenerator(); null if unset. */
  remotePasswordVerifier(): Uint8Array | null {
    return this.remotePassword ? b64d(this.remotePassword.stretched) : null
  }

  remotePasswordFingerprint(): string | null {
    return this.remotePassword ? fingerprint(b64d(this.remotePassword.stretched)) : null
  }

  remotePasswordSetAt(): number | null {
    return this.remotePassword ? this.remotePassword.setAt : null
  }

  /** Record a failed password-PAKE attempt (anti online-guessing — the password is reusable and
   *  human-memorable, unlike the disposable high-entropy live pairing code, so it needs a real,
   *  growing lockout rather than the code's fixed RATE_MAX/RATE_WINDOW). Failures older than
   *  PW_FAIL_WINDOW_MS don't count. Crossing PW_FAIL_THRESHOLD within the window locks out for an
   *  exponentially growing period (5m, 10m, 20m, ... capped at 24h), tracked by `lockoutCount` so
   *  repeated lockouts (not just repeated failures) escalate the wait. No-op if no password is set —
   *  there is nothing to guess. */
  notePwFailure(): { lockedUntil: number | null } {
    const record = this.remotePassword
    if (!record) return { lockedUntil: null }
    const now = Date.now()
    record.recentFailures = [...record.recentFailures.filter((t) => now - t < PW_FAIL_WINDOW_MS), now]
    if (record.recentFailures.length >= PW_FAIL_THRESHOLD) {
      const count = (record.lockoutCount ?? 0) + 1
      record.lockoutCount = count
      record.lockedUntil = now + Math.min(PW_LOCKOUT_BASE_MS * 2 ** (count - 1), PW_LOCKOUT_MAX_MS)
      record.recentFailures = [] // fresh window once locked — it takes another full THRESHOLD after unlock
    }
    writeSecure(REMOTE_PASSWORD_FILE, record)
    return { lockedUntil: record.lockedUntil ?? null }
  }

  /** Successful attempts don't affect the failure count — mirrors manager.ts's `attempts` convention
   *  for the live pairing code (only failed handshakes count toward its rate limit). Kept as an
   *  explicit no-op call site (rather than omitted) so the success path in manager.ts reads the same
   *  shape as the failure path, and so a future policy change has one place to land. */
  notePwSuccess(): void { /* deliberately no-op — see doc comment */ }

  /** Current lockout, or null if unset/expired. An expired `lockedUntil` is treated as not-locked
   *  without rewriting the file — the next real failure (if any) will naturally recompute it. */
  pwLockedUntil(): number | null {
    const until = this.remotePassword?.lockedUntil
    if (!until || until <= Date.now()) return null
    return until
  }
}
