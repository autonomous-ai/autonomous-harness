/**
 * E2EE persistence for the adapter: the computer's long-term identity keypair and the set of pinned
 * (paired) browser identities. Both live under ${ADAPTER_DATA_DIR}/e2e/, written immediately with
 * mode 0600 (pairs are rare — no debounce needed). The identity key is the root of trust; losing it
 * forces every browser to re-pair.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { env } from '../../config/env.js'
import { newIdentity, newPairId, b64e, b64d, fingerprint, encodeSetupToken, verifySetupToken, type Identity, type PairRole } from './core.js'

const DIR = join(env.ADAPTER_DATA_DIR, 'e2e')
const IDENTITY_FILE = join(DIR, 'identity.json')
const PAIRED_FILE = join(DIR, 'paired.json')
const SETUP_TTL_MS = 7 * 24 * 60 * 60 * 1000

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

  /** Load or create the computer identity keypair; load the paired set. Idempotent. */
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
}
