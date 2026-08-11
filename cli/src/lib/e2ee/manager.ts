/**
 * E2eeManager — the adapter side of web↔adapter E2EE .
 *
 * Responsibilities:
 *  - always-on group key (per process, epoch id) that encrypts 1→many `up` user events (wrapUp);
 *  - the CPace pairing state machine (single slot): browser sends e2e_pair_intent → user runs
 *    `harness pair <code>` → onPair() runs CPace toward that connId → pin the browser identity;
 *  - a per-connection session table (X25519 → pairwise keys) established by a signed e2e_hello,
 *    used to decrypt the down `message` frame and to encrypt targeted RPC replies + the group key.
 *
 * The relay never sees plaintext user content: only ciphertext envelopes + public PAKE messages.
 */
import * as C from './core.js'
import { E2eeStore } from './store.js'

type Frame = Record<string, unknown>

export type PairResult =
  | { ok: true; label: string; fingerprint: string }
  | { ok: false; error: 'NO_INTENT' | 'EXPIRED' | 'CODE_MISMATCH' | 'BACKEND_DOWN' | 'RATE_LIMITED' | 'BUSY' | 'TIMEOUT' | 'CANCELLED' }

interface PairSlot {
  connId: string
  pairId: Uint8Array
  pairIdB64: string
  label: string
  role: C.PairRole   // 'web' (browser) or 'device' (hardware device) — bound into the CPace channel-binding string
  expiresAt: number
  ttlTimer: ReturnType<typeof setTimeout>
  // set once `harness pair <code>` starts CPace:
  active?: {
    y: bigint
    Ya: Uint8Array
    isk?: Uint8Array
    th?: Uint8Array
    resolve: (r: PairResult) => void
    roundTimer?: ReturnType<typeof setTimeout>
  }
}

export interface PendingPairInfo {
  label: string
  expiresAt: number
  active: boolean
  role: C.PairRole
  pairId: string
}

interface Session {
  webIdentityPub: string // base64 — the pinned pin used for this session
  role: C.PairRole
  c2s: Uint8Array        // web → adapter (down message)
  s2c: Uint8Array        // adapter → web (welcome + targeted RPC replies)
  s2cCounter: number     // next send counter (0 was the welcome)
  c2sRecv: number        // highest counter seen (replay guard)
}

const PAIR_TTL_MS = 60_000
const ROUND_TIMEOUT_MS = 15_000
const RATE_WINDOW_MS = 5 * 60_000
const RATE_MAX = 3
const MAX_SESSIONS = 64

export interface E2eeManagerDeps {
  machineId: string
  /** Send a frame targeted at ONE web connection (adapter→web, sets targetConnId on the wire). */
  sendTo: (connId: string, frame: Frame) => void
  /** Send a user-level notification to every logged-in browser for this machine owner. */
  sendUser?: (frame: Frame) => void
  /** Is the backend link up right now (for onPair BACKEND_DOWN)? */
  isConnected: () => boolean
}

export class E2eeManager {
  private store = new E2eeStore()
  private groupKey: Uint8Array
  private epoch: string
  private groupCounter = 0
  private slot: PairSlot | null = null
  private sessions = new Map<string, Session>()
  private attempts: number[] = [] // timestamps of FAILED pairings — anti online-guessing rate limit
  private now: () => number
  /** Local dashboard port (loopback) — surfaced to the web in e2e_status so it can link there to
   *  approve pairing. Not sensitive (a localhost port); set by the adapter after the hook server binds. */
  dashboardPort: number | null = null

  constructor(private deps: E2eeManagerDeps, now: () => number = () => Date.now()) {
    this.store.init()
    this.groupKey = crypto32()
    this.epoch = hex8()
    this.now = now
  }

  fingerprint(): string { return this.store.fingerprint() }
  createSetupToken(machineId = this.deps.machineId): { token: string; expiresAt: number; fingerprint: string } {
    return this.store.createSetupToken(machineId)
  }
  hasSession(connId: string): boolean { return this.sessions.has(connId) }
  sessionRole(connId: string): C.PairRole | null { return this.sessions.get(connId)?.role ?? null }
  deviceConnected(): boolean { return [...this.sessions.values()].some((s) => s.role === 'device') }
  dropSessionsByRole(role: C.PairRole): void {
    for (const [connId, s] of [...this.sessions.entries()]) {
      if (s.role === role) this.sessions.delete(connId)
    }
  }

  /** A browser currently waiting to pair (for the local dashboard), or null. `active` = CPace running. */
  pendingPair(): PendingPairInfo | null {
    if (!this.slot) return null
    return {
      label: this.slot.label,
      expiresAt: this.slot.expiresAt,
      active: !!this.slot.active,
      role: this.slot.role,
      pairId: this.slot.pairIdB64,
    }
  }

  // ── pair management (list / revoke) ──────────────────────────────────────────────────────────────

  /** Paired clients, most recent first, with a comparable fingerprint. */
  listPaired(currentConnId?: string): Array<{ fingerprint: string; label: string; pairedAt: number; online: boolean; role: C.PairRole; current: boolean }> {
    const onlinePubs = new Set([...this.sessions.values()].map((s) => s.webIdentityPub))
    const currentPub = currentConnId ? this.sessions.get(currentConnId)?.webIdentityPub : undefined
    return this.store.list()
      .map((p) => ({ fingerprint: C.fingerprint(C.b64d(p.identityPub)), label: p.label, pairedAt: p.pairedAt, online: onlinePubs.has(p.identityPub), role: p.role, current: p.identityPub === currentPub }))
      .sort((a, b) => b.pairedAt - a.pairedAt)
  }

  private findPaired(selector: string): { ok: true; identityPub: string; label: string; fingerprint: string } | { ok: false; error: 'NOT_FOUND' | 'AMBIGUOUS' } {
    const paired = this.store.list()
    const norm = (s: string): string => s.toUpperCase().replace(/[·\s-]/g, '')
    const sel = norm(selector)
    const idx = /^\d+$/.test(selector) ? Number(selector) - 1 : -1
    const byIndex = idx >= 0 ? this.listPaired()[idx] : undefined
    let target = byIndex ? paired.find((p) => C.fingerprint(C.b64d(p.identityPub)) === byIndex.fingerprint) : undefined
    if (!target) {
      const matches = paired.filter((p) => norm(C.fingerprint(C.b64d(p.identityPub))).startsWith(sel))
      if (matches.length > 1) return { ok: false, error: 'AMBIGUOUS' }
      target = matches[0]
    }
    if (!target) return { ok: false, error: 'NOT_FOUND' }
    return { ok: true, identityPub: target.identityPub, label: target.label, fingerprint: C.fingerprint(C.b64d(target.identityPub)) }
  }

  private revokeIdentity(identityPub: string): void {
    this.store.removePaired(identityPub)
    this.denyAndDropSessionsFor(identityPub)
    this.rotateGroupKey()
  }

  /** Revoke ONE paired browser, selected by fingerprint (full or unique prefix, case/·-insensitive) or
   *  by 1-based index into listPaired(). Signals any online session to re-pair + rotates the group key. */
  revoke(selector: string): { ok: true; label: string; fingerprint: string } | { ok: false; error: 'NOT_FOUND' | 'AMBIGUOUS' } {
    const found = this.findPaired(selector)
    if (!found.ok) return found
    this.revokeIdentity(found.identityPub)
    return { ok: true, label: found.label, fingerprint: found.fingerprint }
  }

  revokeFromTrustedWeb(connId: string, p: Record<string, unknown>): void {
    const requestId = p.requestId
    const selector = typeof p.selector === 'string' ? p.selector : ''
    const payload = selector ? this.findPaired(selector) : { ok: false as const, error: 'MISSING_SELECTOR' }
    if (payload.ok) {
      const reply = this.wrapRpcReply(connId, 'e2ee_pairing_unpair_result', requestId, { ok: true, label: payload.label, fingerprint: payload.fingerprint })
      if (reply) this.deps.sendTo(connId, reply)
      this.revokeIdentity(payload.identityPub)
      return
    }
    const reply = this.wrapRpcReply(connId, 'e2ee_pairing_unpair_result', requestId, { error: payload.error })
    if (reply) this.deps.sendTo(connId, reply)
  }

  /** Revoke every paired browser. Signals all online sessions to re-pair + rotates the group key. */
  revokeAll(): { count: number } {
    const count = this.store.count()
    for (const s of [...this.sessions.entries()]) { this.deny(s[0]); this.sessions.delete(s[0]) }
    this.store.clear()
    this.rotateGroupKey()
    return { count }
  }

  revokeAllFromTrustedWeb(connId: string, requestId: unknown): void {
    const count = this.store.count()
    const reply = this.wrapRpcReply(connId, 'e2ee_pairings_unpair_all_result', requestId, { count })
    if (reply) this.deps.sendTo(connId, reply)
    this.revokeAll()
  }

  private deny(connId: string): void {
    this.deps.sendTo(connId, { type: 'e2e_denied', payload: { reason: 'revoked' } })
  }
  private denyAndDropSessionsFor(identityPubB64: string): void {
    for (const [connId, s] of [...this.sessions.entries()]) {
      if (s.webIdentityPub === identityPubB64) { this.deny(connId); this.sessions.delete(connId) }
    }
  }
  /** New group key + epoch; re-deliver to the REMAINING (still-paired) sessions so a revoked browser
   *  (which still holds the old key) can no longer decrypt subsequent events. */
  private rotateGroupKey(): void {
    this.groupKey = crypto32()
    this.epoch = hex8()
    this.groupCounter = 0
    for (const [connId, s] of this.sessions.entries()) {
      const enc = C.aeadSeal(s.s2c, s.s2cCounter++, C.utf8('e2e-rekey'), C.utf8(JSON.stringify({ groupKey: C.b64e(this.groupKey), epoch: this.epoch })))
      this.deps.sendTo(connId, { type: 'e2e_rekey', payload: { enc: C.b64e(enc), n: s.s2cCounter - 1 } })
    }
  }

  // ── outbound wrapping ──────────────────────────────────────────────────────────────────────────

  /** Encrypt a broadcast `up` event under the group key if it carries user content; else pass through. */
  wrapUp(frame: Frame): Frame {
    const type = frame.type as string | undefined
    if (!type || !C.isEncryptedUpType(type)) return frame
    const wrapped = C.wrapPayload(this.groupKey, 'g', this.groupCounter++, type, frame.dbSessionId as string | undefined, frame.payload, this.epoch)
    return { ...frame, payload: wrapped }
  }

  /** Encrypt DEVICE-audience user/data frames under the group key. Same group key/epoch/counter space as
   *  wrapUp: one monotonic counter → unique nonces. A paired device holds the group key (delivered in
   *  e2e_welcome); an UNPAIRED device can't decrypt → mandatory pairing. */
  wrapCommander(frame: Frame): Frame {
    const type = frame.type as string | undefined
    // `commander_question` carries the question + its option labels — user content, same as a recap, so it
    // rides ciphertext too. The device's decrypt is envelope-driven (any `payload.__e2e`), so existing
    // firmware handles it with no change.
    if (!type || (type !== 'commander_event' && type !== 'commander_question' && !C.isEncryptedUpType(type))) return frame
    const wrapped = C.wrapPayload(this.groupKey, 'g', this.groupCounter++, type, frame.dbSessionId as string | undefined, frame.payload, this.epoch)
    return { ...frame, payload: wrapped }
  }

  /** Build an encrypted, connection-targeted RPC reply, or null if this conn has no session. */
  wrapRpcReply(connId: string, resultType: string, requestId: unknown, payload: Record<string, unknown>): Frame | null {
    const s = this.sessions.get(connId)
    if (!s) return null
    const full = { requestId, ...payload }
    const wrapped = C.wrapPayload(s.s2c, 'p', s.s2cCounter++, resultType, undefined, full)
    return { type: resultType, payload: wrapped }
  }

  /** Measure the exact encrypted targeted RPC frame without consuming the send counter. */
  rpcReplyFrameBytes(connId: string, resultType: string, requestId: unknown, payload: Record<string, unknown>): number | null {
    const s = this.sessions.get(connId)
    if (!s) return null
    const full = { requestId, ...payload }
    const wrapped = C.wrapPayload(s.s2c, 'p', s.s2cCounter, resultType, undefined, full)
    return Buffer.byteLength(JSON.stringify({ type: resultType, payload: wrapped }), 'utf8')
  }

  private wrapTarget(connId: string, type: string, payload: Record<string, unknown>): Frame | null {
    const s = this.sessions.get(connId)
    if (!s) return null
    const wrapped = C.wrapPayload(s.s2c, 'p', s.s2cCounter++, type, undefined, payload)
    return { type, payload: wrapped }
  }

  // ── inbound down `message` decryption ────────────────────────────────────────────────────────────

  /** Decrypt an encrypted down `message`; plaintext passes through; undecryptable → null (drop). */
  unwrapDown(connId: string, frame: Frame): Frame | null {
    const payload = frame.payload as Record<string, unknown> | undefined
    if (!payload || !C.isWrapped(payload)) return frame // plaintext (device/transition path)
    const s = this.sessions.get(connId)
    if (!s) return null
    const env = (payload as C.WrappedPayload).__e2e
    // The relay is NOT trusted, and a client can be buggy/hostile: a structurally malformed envelope
    // (__e2e null, missing/non-string ct, non-number n) would make the deref / b64d below throw and
    // crash the daemon. Anything that isn't the expected shape is dropped like an undecryptable frame.
    if (!env || typeof env !== 'object' || typeof env.n !== 'number' || typeof env.ct !== 'string') return null
    if (s.c2sRecv !== -1 && env.n <= s.c2sRecv) return null // replay / reorder — drop
    const plain = C.unwrapPayload(s.c2s, env, frame.type as string, frame.dbSessionId as string | undefined)
    if (plain === null) return null
    s.c2sRecv = env.n
    return { ...frame, payload: plain }
  }

  // ── e2e_* frame handling (returns true if consumed) ──────────────────────────────────────────────

  handleFrame(connId: string, frame: Frame): boolean {
    const type = frame.type as string
    const payload = (frame.payload ?? {}) as Record<string, unknown>
    switch (type) {
      case 'e2e_status': return this.onStatus(connId, payload)
      case 'e2e_setup_claim': return this.onSetupClaim(connId, payload)
      case 'e2e_pair_intent': return this.onPairIntent(connId, payload)
      case 'e2e_pair_cancel': return this.onPairCancel(connId, payload)
      case 'e2e_pake': return this.onPake(connId, payload)
      case 'e2e_hello': return this.onHello(connId, payload)
      default: return type.startsWith('e2e_') // consume unknown e2e_* silently
    }
  }

  private onStatus(connId: string, p: Record<string, unknown>): boolean {
    const identityPub = typeof p.identityPub === 'string' ? p.identityPub : ''
    this.deps.sendTo(connId, {
      type: 'e2e_status_result',
      payload: {
        requestId: p.requestId,
        supported: true,
        enabled: true, // mandatory: user events are always group-encrypted
        paired: identityPub ? this.store.isPaired(identityPub) : false,
        fingerprint: this.fingerprint(),
        dashboardPort: this.dashboardPort, // so the web can link to the local dashboard to approve
      },
    })
    return true
  }

  private onPairIntent(connId: string, p: Record<string, unknown>): boolean {
    if (this.slot?.active) {
      this.deps.sendTo(connId, { type: 'e2e_pair_intent_result', payload: { requestId: p.requestId, error: 'PAIRING_BUSY' } })
      return true
    }
    if (this.slot) clearTimeout(this.slot.ttlTimer)
    const pairIdB64 = typeof p.pairId === 'string' ? p.pairId : ''
    const label = typeof p.label === 'string' ? p.label.slice(0, 60) : 'browser'
    const role: C.PairRole = p.role === 'device' ? 'device' : 'web'  // the client declares its class
    if (!pairIdB64) { this.deps.sendTo(connId, { type: 'e2e_pair_intent_result', payload: { requestId: p.requestId, error: 'BAD_INTENT' } }); return true }
    const ttlTimer = setTimeout(() => { if (this.slot && !this.slot.active) this.slot = null }, PAIR_TTL_MS)
    this.slot = { connId, pairId: C.b64d(pairIdB64), pairIdB64, label, role, expiresAt: this.now() + PAIR_TTL_MS, ttlTimer }
    this.deps.sendTo(connId, { type: 'e2e_pair_intent_result', payload: { requestId: p.requestId, accepted: true, ttl: PAIR_TTL_MS / 1000 } })
    if (role === 'device') this.notifyTrustedWebDevicePair(this.slot)
    return true
  }

  private notifyTrustedWebDevicePair(slot: PairSlot): void {
    const payload = {
      machineId: this.deps.machineId,
      label: slot.label,
      pairId: slot.pairIdB64,
      expiresAt: slot.expiresAt,
      computerFingerprint: this.fingerprint(),
    }
    this.deps.sendUser?.({ type: 'device_e2ee_pair_pending', payload })
    for (const [connId, session] of this.sessions.entries()) {
      if (session.role !== 'web') continue
      const wrapped = this.wrapTarget(connId, 'device_e2ee_pair_pending', payload)
      if (wrapped) this.deps.sendTo(connId, wrapped)
    }
  }

  private notifyTrustedWebDevicePairCleared(slot: PairSlot, result: 'paired' | 'failed' | 'cancelled'): void {
    if (slot.role !== 'device') return
    const payload = {
      machineId: this.deps.machineId,
      pairId: slot.pairIdB64,
      result,
      computerFingerprint: this.fingerprint(),
    }
    this.deps.sendUser?.({ type: 'device_e2ee_pair_cleared', payload })
    for (const [connId, session] of this.sessions.entries()) {
      if (session.role !== 'web') continue
      const wrapped = this.wrapTarget(connId, 'device_e2ee_pair_cleared', payload)
      if (wrapped) this.deps.sendTo(connId, wrapped)
    }
  }

  private onPairCancel(connId: string, p: Record<string, unknown>): boolean {
    const pairId = typeof p.pairId === 'string' ? p.pairId : ''
    const slot = this.slot
    if (!slot || slot.role !== 'device' || slot.connId !== connId || slot.pairIdB64 !== pairId) return true
    this.notifyTrustedWebDevicePairCleared(slot, 'cancelled')
    const resolve = slot.active?.resolve
    this.clearSlot()
    resolve?.({ ok: false, error: 'CANCELLED' })
    return true
  }

  async pairDeviceFromTrustedWeb(connId: string, p: Record<string, unknown>): Promise<void> {
    const requestId = p.requestId
    const session = this.sessions.get(connId)
    if (!session || session.role !== 'web') {
      this.deps.sendTo(connId, { type: 'device_e2ee_pair_result', payload: { requestId, error: 'UNTRUSTED_WEB' } })
      return
    }
    const slot = this.slot
    const pairId = typeof p.pairId === 'string' ? p.pairId : ''
    if (!slot || slot.role !== 'device') {
      const reply = this.wrapRpcReply(connId, 'device_e2ee_pair_result', requestId, { error: 'NO_DEVICE_INTENT' })
      if (reply) this.deps.sendTo(connId, reply)
      return
    }
    if (!pairId || pairId !== slot.pairIdB64) {
      const reply = this.wrapRpcReply(connId, 'device_e2ee_pair_result', requestId, { error: 'STALE_PAIR' })
      if (reply) this.deps.sendTo(connId, reply)
      return
    }
    const code = C.normalizeCode(String(p.code ?? ''))
    if (!code) {
      const reply = this.wrapRpcReply(connId, 'device_e2ee_pair_result', requestId, { error: 'BAD_CODE' })
      if (reply) this.deps.sendTo(connId, reply)
      return
    }
    const result = await this.onPair(code)
    const payload = result.ok
      ? { ok: true, label: result.label, fingerprint: result.fingerprint }
      : { error: result.error }
    const reply = this.wrapRpcReply(connId, 'device_e2ee_pair_result', requestId, payload)
    if (reply) this.deps.sendTo(connId, reply)
  }

  private onSetupClaim(connId: string, p: Record<string, unknown>): boolean {
    const requestId = p.requestId
    const token = typeof p.token === 'string' ? p.token : ''
    const identityPub = typeof p.identityPub === 'string' ? p.identityPub : ''
    const sig = typeof p.sig === 'string' ? p.sig : ''
    const label = typeof p.label === 'string' ? p.label.slice(0, 60) : 'browser'
    const fail = (error: string): void => {
      this.deps.sendTo(connId, { type: 'e2e_setup_claim_result', payload: { requestId, error } })
    }
    if (!token || !identityPub || !sig) { fail('BAD_CLAIM'); return true }
    const validated = this.store.validateSetupToken(token, this.deps.machineId)
    if (!validated.ok) { fail(validated.error); return true }
    const pub = C.b64d(identityPub)
    if (!C.setupClaimVerify(pub, this.deps.machineId, token, C.b64d(sig))) { fail('BAD_SIG'); return true }
    this.store.addPaired(identityPub, label, this.now(), 'web')
    this.deps.sendTo(connId, { type: 'e2e_setup_claim_result', payload: { requestId, ok: true, fingerprint: validated.fingerprint } })
    return true
  }

  /** Called by the hook server when the user runs `harness pair <code>`. Resolves when done/failed. */
  onPair(code: string): Promise<PairResult> {
    return new Promise<PairResult>((resolve) => {
      // rate limit
      // Rate-limit only recent FAILED attempts (anti online-guessing) — successful pairings don't
      // count, so a user can legitimately pair several browsers in a row.
      const t = this.now()
      this.attempts = this.attempts.filter((a) => t - a < RATE_WINDOW_MS)
      if (this.attempts.length >= RATE_MAX) { resolve({ ok: false, error: 'RATE_LIMITED' }); return }
      const slot = this.slot
      if (!slot) { resolve({ ok: false, error: 'NO_INTENT' }); return }
      if (slot.active) { resolve({ ok: false, error: 'BUSY' }); return }
      if (this.now() > slot.expiresAt) { this.slot = null; resolve({ ok: false, error: 'EXPIRED' }); return }
      if (!this.deps.isConnected()) { resolve({ ok: false, error: 'BACKEND_DOWN' }); return }
      clearTimeout(slot.ttlTimer)

      const ci = C.pairContext(this.deps.machineId, slot.role)
      const g = C.cpaceGenerator(code, slot.pairId, ci)
      const { y, Y } = C.cpaceStart(g)
      const roundTimer = setTimeout(() => this.failPair('TIMEOUT'), ROUND_TIMEOUT_MS)
      slot.active = { y, Ya: Y, resolve, roundTimer }
      // round 1 → web (targeted)
      this.deps.sendTo(slot.connId, { type: 'e2e_pake', payload: { pairId: slot.pairIdB64, round: 1, ya: C.b64e(Y) } })
    })
  }

  private onPake(connId: string, p: Record<string, unknown>): boolean {
    const slot = this.slot
    if (!slot?.active) return true
    if (typeof p.pairId !== 'string' || p.pairId !== slot.pairIdB64) return true // not our session
    const round = Number(p.round)
    const ci = C.pairContext(this.deps.machineId, slot.role)
    try {
      if (round === 2) {
        const Yb = C.b64d(String(p.yb))
        const K = C.cpaceShared(Yb, slot.active.y)
        const isk = C.cpaceISK(slot.pairId, K, slot.active.Ya, Yb)
        const th = C.transcriptHash(slot.pairId, ci, slot.active.Ya, Yb)
        const kc = C.kcKeys(isk, ci)
        if (!C.macVerify(kc.web, th, C.b64d(String(p.mac)))) { this.failPair('CODE_MISMATCH'); return true }
        slot.active.isk = isk
        slot.active.th = th
        // round 3 → adapter MAC + sealed identity (proof of possession)
        const id = this.store.getIdentity()
        const sealed = C.aeadSeal(C.pairKey(isk, ci), 3, C.utf8('e2e-id'), C.utf8(JSON.stringify({ id: C.b64e(id.pub), sig: C.b64e(C.pairBindSig(id.priv, th)) })))
        this.resetRoundTimer(slot)
        this.deps.sendTo(connId, { type: 'e2e_pake', payload: { pairId: slot.pairIdB64, round: 3, mac: C.b64e(C.macTag(kc.adapter, th)), enc: C.b64e(sealed) } })
        return true
      }
      if (round === 4) {
        if (!slot.active.isk || !slot.active.th) { this.failPair('TIMEOUT'); return true }
        const opened = C.aeadOpen(C.pairKey(slot.active.isk, ci), 4, C.utf8('e2e-id'), C.b64d(String(p.enc)))
        if (!opened) { this.failPair('CODE_MISMATCH'); return true }
        const webId = JSON.parse(new TextDecoder().decode(opened)) as { id: string; sig: string }
        if (!C.pairBindVerify(C.b64d(webId.id), slot.active.th, C.b64d(webId.sig))) { this.failPair('CODE_MISMATCH'); return true }
        // pin the paired client identity
        this.store.addPaired(webId.id, slot.label, this.now(), slot.role)
        const fp = this.fingerprint()
        this.deps.sendTo(connId, { type: 'e2e_pake', payload: { pairId: slot.pairIdB64, round: 5, ok: true, fingerprint: fp } })
        const resolve = slot.active.resolve
        this.notifyTrustedWebDevicePairCleared(slot, 'paired')
        this.clearSlot()
        resolve({ ok: true, label: slot.label, fingerprint: fp })
        return true
      }
    } catch {
      this.failPair('CODE_MISMATCH')
    }
    return true
  }

  private onHello(connId: string, p: Record<string, unknown>): boolean {
    const identityPub = String(p.identityPub ?? '')
    const ephPubB64 = String(p.ephPub ?? '')
    const sigB64 = String(p.sig ?? '')
    if (!identityPub || !ephPubB64 || !sigB64) return true
    const webEphPub = C.b64d(ephPubB64)
    const role = this.store.pairedRole(identityPub)
    if (!role) {
      this.deps.sendTo(connId, { type: 'e2e_denied', payload: { webEphPub: ephPubB64, reason: 'unpaired' } })
      return true
    }
    if (!C.helloVerify(C.b64d(identityPub), this.deps.machineId, webEphPub, C.b64d(sigB64))) {
      this.deps.sendTo(connId, { type: 'e2e_denied', payload: { webEphPub: ephPubB64, reason: 'bad_sig' } })
      return true
    }
    const eph = C.newEphemeral()
    // webEphPub is attacker-controlled: a wrong-length or low-order / invalid curve point makes
    // x25519.getSharedSecret throw. Refuse such a hello instead of letting the throw crash the daemon.
    let keys: { c2s: Uint8Array; s2c: Uint8Array }
    try {
      keys = C.sessionKeys(eph.priv, webEphPub, this.deps.machineId, webEphPub, eph.pub)
    } catch {
      this.deps.sendTo(connId, { type: 'e2e_denied', payload: { webEphPub: ephPubB64, reason: 'bad_key' } })
      return true
    }
    this.evictIfFull()
    this.sessions.set(connId, { webIdentityPub: identityPub, role, c2s: keys.c2s, s2c: keys.s2c, s2cCounter: 1, c2sRecv: -1 })
    const id = this.store.getIdentity()
    const enc = C.aeadSeal(keys.s2c, 0, C.utf8('e2e-welcome'), C.utf8(JSON.stringify({ groupKey: C.b64e(this.groupKey), epoch: this.epoch })))
    this.deps.sendTo(connId, {
      type: 'e2e_welcome',
      payload: {
        webEphPub: ephPubB64, // echo (self-addressing)
        ephPub: C.b64e(eph.pub),
        sig: C.b64e(C.welcomeSig(id.priv, this.deps.machineId, webEphPub, eph.pub)),
        enc: C.b64e(enc),
      },
    })
    return true
  }

  /** Drop a session when its web connection closes (called from backendSocket on down close is n/a —
   *  connections are relayed; sessions are pruned by LRU + overwrite-on-new-hello). */
  dropSession(connId: string): void { this.sessions.delete(connId) }

  // ── helpers ──────────────────────────────────────────────────────────────────────────────────

  private resetRoundTimer(slot: PairSlot): void {
    if (slot.active?.roundTimer) clearTimeout(slot.active.roundTimer)
    if (slot.active) slot.active.roundTimer = setTimeout(() => this.failPair('TIMEOUT'), ROUND_TIMEOUT_MS)
  }
  private failPair(error: Extract<PairResult, { ok: false }>['error']): void {
    const slot = this.slot
    if (!slot?.active) return
    this.attempts.push(this.now()) // a failed handshake counts toward the anti-guessing rate limit
    const resolve = slot.active.resolve
    if (error === 'CODE_MISMATCH') {
      this.deps.sendTo(slot.connId, { type: 'e2e_pake', payload: { pairId: slot.pairIdB64, round: 5, error } })
    }
    this.notifyTrustedWebDevicePairCleared(slot, 'failed')
    this.clearSlot()
    resolve({ ok: false, error })
  }
  private clearSlot(): void {
    if (this.slot?.active?.roundTimer) clearTimeout(this.slot.active.roundTimer)
    if (this.slot) clearTimeout(this.slot.ttlTimer)
    this.slot = null
  }
  private evictIfFull(): void {
    if (this.sessions.size < MAX_SESSIONS) return
    const oldest = this.sessions.keys().next().value
    if (oldest) this.sessions.delete(oldest)
  }
}

// Portable 32-byte random + 8-hex epoch (avoid importing extra symbols; reuse core's rng surface).
function crypto32(): Uint8Array {
  const a = C.newPairId(), b = C.newPairId()
  const out = new Uint8Array(32)
  out.set(a, 0); out.set(b, 16)
  return out
}
function hex8(): string {
  const b = C.newPairId().slice(0, 4)
  let s = ''
  for (let i = 0; i < 4; i++) s += b[i].toString(16).padStart(2, '0')
  return s
}
