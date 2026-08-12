/**
 * E2EE shared crypto core — web ↔ adapter end-to-end encryption.
 *
 * ⚠ EVERY COPY OF THIS FILE MUST BE BYTE-IDENTICAL (CLI, browser client). A drift-guard test asserts
 * the two are equal (see core.test.ts). Edit BOTH together, or the interop guarantee is lost. It uses
 * only environment-portable APIs (works in Node ≥20 and the browser): noble curves/hashes/ciphers,
 * plus a portable base64 that prefers Buffer and falls back to atob/btoa.
 *
 * Scheme:
 *  - identity keypair  (Ed25519)   — signs ephemerals + pairing proof-of-possession; pinned once.
 *  - CPace-style PAKE  (ristretto255) — the 6-char pairing code bootstraps a shared secret over the
 *      untrusted relay; one online guess only, no offline attack. NOTE: not wire-compatible with the
 *      IETF CPace draft (uses noble hashToRistretto255 for the generator) — interop is guaranteed by
 *      the identical twin + committed self-vectors, not by draft vectors.
 *  - per-connection    (X25519)    — ephemeral DH → HKDF → pairwise session keys (c2s/s2c).
 *  - group key         (random 32B, per adapter process, epoch id) — encrypts 1→many `up` events once.
 *  - AEAD              (ChaCha20-Poly1305) — per-frame, counter nonce, AAD binds frame type/session.
 */
import { ed25519, x25519, RistrettoPoint, hashToRistretto255 } from '@noble/curves/ed25519'
import { bytesToNumberLE, concatBytes } from '@noble/curves/abstract/utils'
import { mod } from '@noble/curves/abstract/modular'
import { sha512, sha256 } from '@noble/hashes/sha2'
import { hkdf } from '@noble/hashes/hkdf'
import { hmac } from '@noble/hashes/hmac'
import { randomBytes } from '@noble/hashes/utils'
import { chacha20poly1305 } from '@noble/ciphers/chacha'

// ── portable helpers ──────────────────────────────────────────────────────────────────────────────

const HAS_BUFFER = typeof Buffer !== 'undefined'

export function b64e(u: Uint8Array): string {
  if (HAS_BUFFER) return Buffer.from(u).toString('base64')
  let s = ''
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i])
  return btoa(s)
}
export function b64d(s: string): Uint8Array {
  if (HAS_BUFFER) return new Uint8Array(Buffer.from(s, 'base64'))
  const bin = atob(s)
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u
}
function b64urlEncode(s: string): string {
  const b64 = b64e(utf8(s))
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}
function b64urlDecode(s: string): string | null {
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
    return fromUtf8(b64d(b64))
  } catch { return null }
}
export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}
function fromUtf8(u: Uint8Array): string {
  return new TextDecoder().decode(u)
}
/** Length-prefixed concat (4-byte BE length per field) — unambiguous transcript encoding. */
export function lvCat(...parts: Array<Uint8Array | string>): Uint8Array {
  const chunks: Uint8Array[] = []
  for (const p of parts) {
    const b = typeof p === 'string' ? utf8(p) : p
    const len = new Uint8Array(4)
    new DataView(len.buffer).setUint32(0, b.length, false)
    chunks.push(len, b)
  }
  return concatBytes(...chunks)
}
function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}

export type Rng = (n: number) => Uint8Array
const defaultRng: Rng = (n) => randomBytes(n)

const CURVE_L = ed25519.CURVE.n

/** Uniform scalar in [1, L). */
function randScalar(rng: Rng): bigint {
  for (let i = 0; i < 8; i++) {
    const s = mod(bytesToNumberLE(rng(64)), CURVE_L)
    if (s !== 0n) return s
  }
  throw new Error('randScalar: exhausted')
}

// ── identity (Ed25519) ──────────────────────────────────────────────────────────────────────────────

export interface Identity { priv: Uint8Array; pub: Uint8Array }

export function newIdentity(rng: Rng = defaultRng): Identity {
  const priv = rng(32)
  return { priv, pub: ed25519.getPublicKey(priv) }
}
export function sign(priv: Uint8Array, msg: Uint8Array): Uint8Array {
  return ed25519.sign(msg, priv)
}
export function verify(pub: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
  try { return ed25519.verify(sig, msg, pub) } catch { return false }
}
/** Human-comparable fingerprint of a public key: 4 groups of 4 hex, dot-separated. */
export function fingerprint(pub: Uint8Array): string {
  const h = sha256(pub)
  const hex = b64eHex(h.slice(0, 8)).toUpperCase()
  return `${hex.slice(0, 4)}·${hex.slice(4, 8)}·${hex.slice(8, 12)}·${hex.slice(12, 16)}`
}
function b64eHex(u: Uint8Array): string {
  let s = ''
  for (let i = 0; i < u.length; i++) s += u[i].toString(16).padStart(2, '0')
  return s
}

// ── CPace-style PAKE over ristretto255 ──────────────────────────────────────────────────────────────

const CPACE_DSI = 'e2e-cpace-ristretto255-v1'

/** Channel-binding string: pins the pairing to this agent + roles (adapter=a initiator; b = the client
 *  being paired). `role` is the responder class — 'web' (browser, default → back-compat with pinned
 *  vectors) or 'device' (the device firmware). A device and a browser therefore derive different
 *  transcripts/ISK/MACs even on the same agent, so their pairings can never be spliced. */
export type PairRole = 'web' | 'device'
export function pairContext(machineId: string, role: PairRole = 'web'): string {
  return `autonomous-e2e-pair|agent:${machineId}|a:adapter|b:${role}`
}

/** Generator g = hashToGroup(DSI, PRS, sid, CI). PRS = the code; sid = pairId; CI = pairContext. */
export function cpaceGenerator(code: string, sid: Uint8Array, ci: string): InstanceType<typeof RistrettoPoint> {
  const genStr = lvCat(CPACE_DSI, normalizeCode(code), sid, ci)
  return hashToRistretto255(genStr, { DST: CPACE_DSI })
}

export interface CpaceStart { y: bigint; Y: Uint8Array }
export function cpaceStart(g: InstanceType<typeof RistrettoPoint>, rng: Rng = defaultRng): CpaceStart {
  const y = randScalar(rng)
  return { y, Y: g.multiply(y).toRawBytes() }
}
/** Shared secret K = peerY^y (encoded). Rejects the identity point (invalid/attack input). */
export function cpaceShared(peerY: Uint8Array, y: bigint): Uint8Array {
  const P = RistrettoPoint.fromHex(peerY) // throws on invalid encoding
  const K = P.multiply(y)
  if (K.equals(RistrettoPoint.ZERO)) throw new Error('cpace: identity shared point')
  return K.toRawBytes()
}
/** Intermediate session key. Ya/Yb carry role tags 'a'/'b' so the two directions can't be confused. */
export function cpaceISK(sid: Uint8Array, K: Uint8Array, Ya: Uint8Array, Yb: Uint8Array): Uint8Array {
  return sha512(lvCat(`${CPACE_DSI}_ISK`, sid, K, lvCat(Ya, 'a'), lvCat(Yb, 'b')))
}
/** Transcript hash bound into confirmation MACs + identity signatures. */
export function transcriptHash(sid: Uint8Array, ci: string, Ya: Uint8Array, Yb: Uint8Array): Uint8Array {
  return sha512(lvCat(sid, ci, lvCat(Ya, 'a'), lvCat(Yb, 'b')))
}
/** Confirmation MAC keys (adapter half, web half) derived from ISK. */
export function kcKeys(isk: Uint8Array, ci: string): { adapter: Uint8Array; web: Uint8Array } {
  const kc = hkdf(sha256, isk, utf8(ci), utf8('e2e-kc-v1'), 64)
  return { adapter: kc.slice(0, 32), web: kc.slice(32, 64) }
}
export function macTag(key: Uint8Array, th: Uint8Array): Uint8Array {
  return hmac(sha256, key, th)
}
export function macVerify(key: Uint8Array, th: Uint8Array, tag: Uint8Array): boolean {
  return ctEqual(macTag(key, th), tag)
}
/** Key that wraps the identity-exchange messages inside the PAKE. */
export function pairKey(isk: Uint8Array, ci: string): Uint8Array {
  return hkdf(sha256, isk, utf8(ci), utf8('e2e-id-v1'), 32)
}
/** Ed25519 signature proving possession of the identity key, bound to this pairing transcript. */
export function pairBindSig(priv: Uint8Array, th: Uint8Array): Uint8Array {
  return sign(priv, concatBytes(utf8('e2e-pair-bind'), th))
}
export function pairBindVerify(pub: Uint8Array, th: Uint8Array, sig: Uint8Array): boolean {
  return verify(pub, concatBytes(utf8('e2e-pair-bind'), th), sig)
}

// ── setup-link token (adapter CLI → web) ───────────────────────────────────────────────────────────

export interface SetupTokenPayload {
  v: 1
  typ: 'adapter-e2ee-setup'
  pub: string
  nonce: string
  exp: number
  machineId?: string
}

export interface VerifiedSetupToken {
  payload: SetupTokenPayload
  adapterPub: Uint8Array
}

function canonicalSetupPayload(p: SetupTokenPayload): string {
  const ordered: SetupTokenPayload = { v: 1, typ: 'adapter-e2ee-setup', pub: p.pub, nonce: p.nonce, exp: p.exp }
  if (p.machineId) ordered.machineId = p.machineId
  return JSON.stringify(ordered)
}

export function encodeSetupToken(payload: SetupTokenPayload, adapterPriv: Uint8Array): string {
  const p = canonicalSetupPayload(payload)
  const sig = b64e(sign(adapterPriv, utf8(p)))
  return b64urlEncode(JSON.stringify({ p: payload, sig }))
}

export function verifySetupToken(token: string, now = Date.now(), expectedMachineId?: string): VerifiedSetupToken | null {
  const raw = b64urlDecode(token)
  if (!raw) return null
  let parsed: { p?: Partial<SetupTokenPayload>; sig?: unknown }
  try { parsed = JSON.parse(raw) as { p?: Partial<SetupTokenPayload>; sig?: unknown } } catch { return null }
  const p = parsed.p
  if (!p || p.v !== 1 || p.typ !== 'adapter-e2ee-setup' || typeof p.pub !== 'string' || typeof p.nonce !== 'string' || typeof p.exp !== 'number') return null
  if (typeof p.machineId !== 'undefined' && typeof p.machineId !== 'string') return null
  if (expectedMachineId && p.machineId && p.machineId !== expectedMachineId) return null
  if (p.exp < now) return null
  if (typeof parsed.sig !== 'string') return null
  const payload: SetupTokenPayload = { v: 1, typ: 'adapter-e2ee-setup', pub: p.pub, nonce: p.nonce, exp: p.exp }
  if (p.machineId) payload.machineId = p.machineId
  const adapterPub = b64d(payload.pub)
  if (!verify(adapterPub, utf8(canonicalSetupPayload(payload)), b64d(parsed.sig))) return null
  return { payload, adapterPub }
}

export function setupClaimSig(priv: Uint8Array, machineId: string, token: string, identityPub: Uint8Array): Uint8Array {
  return sign(priv, lvCat('e2e-setup-claim-v1', machineId, token, identityPub))
}
export function setupClaimVerify(pub: Uint8Array, machineId: string, token: string, sig: Uint8Array): boolean {
  return verify(pub, lvCat('e2e-setup-claim-v1', machineId, token, pub), sig)
}

// ── per-connection session (X25519 ephemeral → HKDF) ─────────────────────────────────────────────────

export interface Ephemeral { priv: Uint8Array; pub: Uint8Array }
export function newEphemeral(rng: Rng = defaultRng): Ephemeral {
  const priv = rng(32)
  return { priv, pub: x25519.getPublicKey(priv) }
}
/** Derive directional session keys. Both sides pass the SAME (webEphPub, adapterEphPub) ordering. */
export function sessionKeys(
  ephPriv: Uint8Array,
  peerEphPub: Uint8Array,
  machineId: string,
  webEphPub: Uint8Array,
  adapterEphPub: Uint8Array,
): { c2s: Uint8Array; s2c: Uint8Array } {
  const shared = x25519.getSharedSecret(ephPriv, peerEphPub)
  const sess = hkdf(sha256, shared, lvCat(machineId, webEphPub, adapterEphPub), utf8('e2e-sess-v1'), 64)
  return { c2s: sess.slice(0, 32), s2c: sess.slice(32, 64) }
}
export function helloSig(priv: Uint8Array, machineId: string, ephPub: Uint8Array): Uint8Array {
  return sign(priv, lvCat('e2e-hello-v1', machineId, ephPub))
}
export function helloVerify(pub: Uint8Array, machineId: string, ephPub: Uint8Array, sig: Uint8Array): boolean {
  return verify(pub, lvCat('e2e-hello-v1', machineId, ephPub), sig)
}
export function welcomeSig(priv: Uint8Array, machineId: string, webEphPub: Uint8Array, adapterEphPub: Uint8Array): Uint8Array {
  return sign(priv, lvCat('e2e-welcome-v1', machineId, webEphPub, adapterEphPub))
}
export function welcomeVerify(pub: Uint8Array, machineId: string, webEphPub: Uint8Array, adapterEphPub: Uint8Array, sig: Uint8Array): boolean {
  return verify(pub, lvCat('e2e-welcome-v1', machineId, webEphPub, adapterEphPub), sig)
}

// ── AEAD (ChaCha20-Poly1305, counter nonce) ──────────────────────────────────────────────────────────

/** 12-byte nonce = 8-byte BE counter || 4 zero bytes. Counter uniqueness is the caller's contract. */
export function counterNonce(counter: number): Uint8Array {
  const n = new Uint8Array(12)
  const dv = new DataView(n.buffer)
  // JS numbers are safe to 2^53; split high/low 32 bits for the BE counter.
  dv.setUint32(0, Math.floor(counter / 0x100000000), false)
  dv.setUint32(4, counter >>> 0, false)
  return n
}
export function aeadSeal(key: Uint8Array, counter: number, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const n = counterNonce(counter)
  return chacha20poly1305(key, n, aad).encrypt(plaintext)
}
export function aeadOpen(key: Uint8Array, counter: number, aad: Uint8Array, ct: Uint8Array): Uint8Array | null {
  try { return chacha20poly1305(key, counterNonce(counter), aad).decrypt(ct) } catch { return null }
}

// ── frame-payload envelope ────────────────────────────────────────────────────────────────────────

export const E2E_VERSION = 1
export type KeyKind = 'g' | 'p' // g = group key (up broadcast), p = pairwise session

export interface E2eEnvelope {
  v: number
  k: KeyKind
  epoch?: string
  n: number // counter
  ct: string // base64
}
export interface WrappedPayload { __e2e: E2eEnvelope }

function aadFor(v: number, frameType: string, dbSessionId: string, k: KeyKind, epoch: string): Uint8Array {
  return utf8(`${v}|${frameType}|${dbSessionId}|${k}|${epoch}`)
}

/** Encrypt a frame payload → { __e2e }. `payload` is the frame's plaintext payload object. */
export function wrapPayload(
  key: Uint8Array,
  k: KeyKind,
  counter: number,
  frameType: string,
  dbSessionId: string | undefined,
  payload: unknown,
  epoch?: string,
): WrappedPayload {
  const aad = aadFor(E2E_VERSION, frameType, dbSessionId ?? '', k, epoch ?? '')
  const pt = utf8(JSON.stringify(payload ?? null))
  const ct = aeadSeal(key, counter, aad, pt)
  const env: E2eEnvelope = { v: E2E_VERSION, k, n: counter, ct: b64e(ct) }
  if (epoch !== undefined) env.epoch = epoch
  return { __e2e: env }
}
/** Decrypt an { __e2e } payload back to the plaintext payload object, or null if it can't be opened. */
export function unwrapPayload(
  key: Uint8Array,
  env: E2eEnvelope,
  frameType: string,
  dbSessionId: string | undefined,
): unknown | null {
  const aad = aadFor(env.v, frameType, dbSessionId ?? '', env.k, env.epoch ?? '')
  const pt = aeadOpen(key, env.n, aad, b64d(env.ct))
  if (!pt) return null
  try { return JSON.parse(fromUtf8(pt)) } catch { return null }
}
export function isWrapped(payload: unknown): payload is WrappedPayload {
  return !!payload && typeof payload === 'object' && '__e2e' in (payload as Record<string, unknown>)
}

// ── frame classification ────────────────────────────────────────────────────────────────────────────

/** `up` events (adapter→web, group key) whose payload carries user content. */
export const ENCRYPTED_UP_TYPES = new Set<string>([
  'user_message', 'text_delta', 'thinking_delta', 'thinking_title', 'tool_start', 'tool_end',
  'turn_started', 'turn_ended', 'done', 'context_compact', 'turn_summary', 'turn_summary_pending',
  'agent_created', 'agent_synced', 'agent_renamed', 'agent_deleted',
])
/** RPC replies (`<x>_result`) whose payload is encrypted ONLY when the requester has a session. */
export const ENCRYPTED_RPC_RESULT_TYPES = new Set<string>([
  'session_get_result', 'sessions_list_result', 'agents_list_result', 'models_list_result',
  'agent_files_result', 'agent_read_file_result', 'agent_update_result', 'agent_delete_result',
  'e2ee_pairings_list_result', 'e2ee_pairing_unpair_result',
  'e2ee_pairings_unpair_all_result', 'e2ee_browser_link_create_result',
  // Device RPC replies that carry adapter content (recap headline/body, new agent name). Must be
  // ciphertext so the backend relay can't read them — device↔adapter E2EE parity with web.
  'agent_recent_result', 'agent_create_result',
])
/** Client→adapter frames that carry or can trigger adapter-local user data. */
export const ENCRYPTED_DOWN_TYPES = new Set<string>([
  'message',
  // An AskUserQuestion answer is user content, so the firmware wraps it (e2ee_manager.c). Leaving it out
  // of this set did NOT fail loudly: unwrapDown was simply never called, the payload stayed the raw
  // {__e2e} envelope, and requestId/sessionId/answers all read back undefined — so the answer was dropped
  // as "no session/answers", the pane dialog was never keyed, and the CLI waited on question 1 forever.
  'question_response',
  'agents_list', 'sessions_list', 'session_get', 'models_list',
  'agent_create', 'agent_delete', 'agent_recent', 'agent_update', 'agent_files', 'agent_read_file',
  'device_e2ee_pair', 'e2ee_pairings_list', 'e2ee_pairing_unpair',
  'e2ee_pairings_unpair_all', 'e2ee_browser_link_create',
])
export function isEncryptedUpType(t: string): boolean { return ENCRYPTED_UP_TYPES.has(t) }
export function isEncryptedRpcResultType(t: string): boolean { return ENCRYPTED_RPC_RESULT_TYPES.has(t) }
export function isEncryptedDownType(t: string): boolean { return ENCRYPTED_DOWN_TYPES.has(t) }

// ── pairing code ──────────────────────────────────────────────────────────────────────────────────

// Crockford base32 minus ambiguous chars (I,L,O,U) → ~30 bits over 6 chars.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export function newPairCode(rng: Rng = defaultRng): string {
  const bytes = rng(6)
  let out = ''
  for (let i = 0; i < 6; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  return out
}
/** Normalize user-typed codes: uppercase, strip separators, map look-alikes to the alphabet. */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[\s\-·_]/g, '')
    .replace(/I/g, '1').replace(/L/g, '1').replace(/O/g, '0').replace(/U/g, 'V')
}
export function newPairId(rng: Rng = defaultRng): Uint8Array {
  return rng(16)
}
