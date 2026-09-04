/**
 * The "client" (formerly-browser) role of the E2EE session protocol, run by THIS daemon on behalf of a
 * local app relaying through it to a REMOTE machine it has `harness link connect`-ed to via that
 * machine's persistent remote password (see machinePeers.ts). Establishes a session via
 * e2e_hello/e2e_welcome, then encrypts outgoing frames / decrypts incoming ones for the lifetime of
 * the relay connection.
 *
 * This is bookkeeping only — every actual crypto primitive comes from core.ts (identical to the one
 * that used to run this same role inside the Flutter desktop app and still runs it in the web app), so
 * there is no new cryptography here, only a new caller of it.
 */
import { WebSocket } from 'ws'
import * as C from './core.js'
import { deriveTerminalBinaryKey, openTerminalBinary, sealTerminalBinary, type TerminalBinaryClear } from '../terminalBinary.js'
import { pwCpaceGenerator, pwContext, stretchPassword } from './passwordPake.js'
import { ReplayWindow } from './replayWindow.js'

type Frame = Record<string, unknown>

export interface RelayCryptoDeps {
  machineId: string
  selfIdentity: C.Identity
  peerPub: Uint8Array
}

export class RelaySessionCrypto {
  private readonly eph = C.newEphemeral()
  private c2s: Uint8Array | null = null
  private s2c: Uint8Array | null = null
  private terminalC2s: Uint8Array | null = null
  private terminalS2c: Uint8Array | null = null
  private c2sCounter = 0
  private readonly s2cRecv = new ReplayWindow()
  private terminalC2sCounter = 0
  private readonly terminalS2cRecv = new ReplayWindow()
  private groupKey: Uint8Array | null = null
  private epoch = ''
  private p2pVersion = 0
  private groupRecv = new Map<string, number>() // epoch -> highest counter seen

  constructor(private readonly deps: RelayCryptoDeps) {}

  get ready(): boolean { return this.c2s !== null && this.s2c !== null }
  get terminalP2pVersion(): number { return this.p2pVersion }

  helloFrame(): Frame {
    return {
      type: 'e2e_hello',
      payload: {
        identityPub: C.b64e(this.deps.selfIdentity.pub),
        ephPub: C.b64e(this.eph.pub),
        sig: C.b64e(C.helloSig(this.deps.selfIdentity.priv, this.deps.machineId, this.eph.pub)),
      },
    }
  }

  /** Process an `e2e_welcome` reply to our hello. Returns true once the session is usable. */
  handleWelcome(payload: Record<string, unknown>): boolean {
    const adapterEphPubB64 = typeof payload.ephPub === 'string' ? payload.ephPub : ''
    const sigB64 = typeof payload.sig === 'string' ? payload.sig : ''
    const encB64 = typeof payload.enc === 'string' ? payload.enc : ''
    if (!adapterEphPubB64 || !sigB64 || !encB64) return false
    let adapterEphPub: Uint8Array
    let keys: { c2s: Uint8Array; s2c: Uint8Array }
    try {
      adapterEphPub = C.b64d(adapterEphPubB64)
      if (!C.welcomeVerify(this.deps.peerPub, this.deps.machineId, this.eph.pub, adapterEphPub, C.b64d(sigB64))) return false
      keys = C.sessionKeys(this.eph.priv, adapterEphPub, this.deps.machineId, this.eph.pub, adapterEphPub)
    } catch { return false }
    const opened = C.aeadOpen(keys.s2c, 0, C.utf8('e2e-welcome'), C.b64d(encB64))
    if (!opened) return false
    let initial: { groupKey?: string; epoch?: string; features?: { terminalP2p?: unknown } }
    try { initial = JSON.parse(new TextDecoder().decode(opened)) as typeof initial } catch { return false }
    if (!initial.groupKey || !initial.epoch) return false
    this.c2s = keys.c2s
    this.s2c = keys.s2c
    this.terminalC2s = deriveTerminalBinaryKey(keys.c2s)
    this.terminalS2c = deriveTerminalBinaryKey(keys.s2c)
    this.groupKey = C.b64d(initial.groupKey)
    this.epoch = initial.epoch
    this.p2pVersion = Number.isSafeInteger(initial.features?.terminalP2p)
      ? Number(initial.features?.terminalP2p)
      : 0
    return true
  }

  /** Process an `e2e_rekey` (group key rotation) frame. */
  handleRekey(payload: Record<string, unknown>): boolean {
    if (!this.s2c) return false
    const n = typeof payload.n === 'number' ? payload.n : NaN
    const encB64 = typeof payload.enc === 'string' ? payload.enc : ''
    if (!Number.isFinite(n) || !encB64) return false
    const opened = C.aeadOpen(this.s2c, n, C.utf8('e2e-rekey'), C.b64d(encB64))
    if (!opened) return false
    let next: { groupKey?: string; epoch?: string }
    try { next = JSON.parse(new TextDecoder().decode(opened)) as { groupKey?: string; epoch?: string } } catch { return false }
    if (!next.groupKey || !next.epoch) return false
    this.groupKey = C.b64d(next.groupKey)
    this.epoch = next.epoch
    return true
  }

  /** Encrypt an outgoing (local app → remote machine) frame if its type requires it. */
  wrapOutgoing(frame: Frame): Frame {
    const type = frame.type as string | undefined
    if (!type || !this.c2s || !C.isEncryptedDownType(type)) return frame
    const payload = C.wrapPayload(this.c2s, 'p', this.c2sCounter++, type, undefined, frame.payload)
    return { ...frame, payload }
  }

  /** Decrypt an incoming (remote machine → local app) frame. Null = authenticated-stale or
   *  undecryptable and must be dropped, never forwarded. A never-wrapped (plaintext control) frame
   *  passes through unchanged. */
  unwrapIncoming(frame: Frame): Frame | null {
    const payload = frame.payload as Record<string, unknown> | undefined
    if (!payload || !C.isWrapped(payload)) return frame
    const env = (payload as C.WrappedPayload).__e2e
    if (!env || typeof env.n !== 'number' || typeof env.ct !== 'string') return null
    const type = frame.type as string
    if (env.k === 'g') {
      if (!this.groupKey || env.epoch !== this.epoch) return null
      const seen = this.groupRecv.get(env.epoch) ?? -1
      if (env.n <= seen) return null
      const plain = C.unwrapPayload(this.groupKey, env, type, frame.dbSessionId as string | undefined)
      if (plain === null) return null
      this.groupRecv.set(env.epoch, env.n)
      return { ...frame, payload: plain }
    }
    if (!this.s2c) return null
    if (!this.s2cRecv.allows(env.n)) return null
    const plain = C.unwrapPayload(this.s2c, env, type, frame.dbSessionId as string | undefined)
    if (plain === null) return null
    this.s2cRecv.commit(env.n)
    return { ...frame, payload: plain }
  }

  /** Encrypt an outgoing binary terminal frame (already decoded from the local plaintext wire format). */
  encryptTerminal(clear: TerminalBinaryClear): Uint8Array | null {
    if (!this.terminalC2s) return null
    const sealed = sealTerminalBinary(this.terminalC2s, this.terminalC2sCounter, clear)
    if (sealed) this.terminalC2sCounter++
    return sealed
  }

  /** Decrypt an incoming HTRM binary terminal frame into its clear form (to be re-encoded as the local
   *  plaintext wire format before reaching the app). Null = drop (stale/undecryptable). */
  decryptTerminal(raw: Uint8Array): TerminalBinaryClear | null {
    if (!this.terminalS2c) return null
    const opened = openTerminalBinary(this.terminalS2c, raw)
    if (!opened || !this.terminalS2cRecv.allows(opened.counter)) return null
    this.terminalS2cRecv.commit(opened.counter)
    return opened.frame
  }
}

export type PwConnectResult =
  | { ok: true; peerPub: Uint8Array; fingerprint: string }
  | { ok: false; error: string; retryAt?: number }

export type PwConnectProgress = 'connecting' | 'deriving_key' | 'exchanging' | 'verifying'

/** `harness link connect <machineId>`: open a short-lived authenticated `/api/web-ws` connection to
 *  the target machine (same endpoint RemoteRelayPool dials for the real relay), and run the
 *  password-PAKE against it as the joiner ('b') role — proving knowledge of the target machine's
 *  persistent `harness remote-password set` secret, entirely automatically (no approval step on the
 *  target beyond having set the password). Mirrors manager.ts's onPwPairIntent/onPwPake state machine
 *  from the other side. On success the caller pins the returned peerPub via MachinePeerStore; no
 *  session/relay state is established here, just the one-time trust pin — same contract the old
 *  claimSetupToken() had. */
export async function connectWithPassword(opts: {
  targetMachineId: string
  password: string
  selfIdentity: C.Identity
  accessToken: string
  backendWsBase: string
  autonomousEnv: string
  onProgress?: (stage: PwConnectProgress) => void
  timeoutMs?: number
}): Promise<PwConnectResult> {
  const url = `${opts.backendWsBase}/api/web-ws?autonomousEnv=${encodeURIComponent(opts.autonomousEnv)}`
  const ws = new WebSocket(url, [opts.accessToken])
  const sid = C.newPairId()
  const sidB64 = C.b64e(sid)
  const requestId = C.b64e(C.newPairId())
  const ci = pwContext(opts.targetMachineId)
  return new Promise<PwConnectResult>((resolve) => {
    let settled = false
    let stretched: Uint8Array | null = null
    let isk: Uint8Array | null = null
    let th: Uint8Array | null = null
    let peerPub: Uint8Array | null = null
    const finish = (result: PwConnectResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      try { ws.close() } catch { /* ignore */ }
      resolve(result)
    }
    const timeout = setTimeout(() => finish({ ok: false, error: 'TIMEOUT' }), opts.timeoutMs ?? 15_000)
    opts.onProgress?.('connecting')
    let selected = false
    ws.once('open', () => {
      try { ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId: opts.targetMachineId } })) }
      catch { finish({ ok: false, error: 'SEND_FAILED' }) }
    })
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return
      let frame: Record<string, unknown>
      try { frame = JSON.parse(raw.toString()) as Record<string, unknown> } catch { return }
      const payload = (frame.payload ?? {}) as Record<string, unknown>
      if (!selected) {
        if (frame.type === 'connected' && payload.machineId === opts.targetMachineId) {
          selected = true
          void (async () => {
            try {
              opts.onProgress?.('deriving_key')
              // scryptAsync completes strictly before this send — the round-1 reply can only arrive
              // after a network round trip, so `stretched` is always set before it's read below.
              stretched = await stretchPassword(opts.password, opts.targetMachineId)
              opts.onProgress?.('exchanging')
              ws.send(JSON.stringify({ type: 'e2e_pw_pair_intent', payload: { requestId, sid: sidB64 } }))
            } catch {
              finish({ ok: false, error: 'DERIVE_FAILED' })
            }
          })()
        } else if (frame.type === 'machine_select_error' && payload.machineId === opts.targetMachineId) {
          finish({ ok: false, error: typeof payload.error === 'string' ? payload.error : 'SELECT_FAILED' })
        }
        return
      }
      if (frame.type === 'e2e_pw_pair_result' && payload.requestId === requestId) {
        if (payload.ok !== true) {
          const retryAt = typeof payload.retryAt === 'number' ? payload.retryAt : undefined
          finish({ ok: false, error: typeof payload.error === 'string' ? payload.error : 'PAIR_FAILED', retryAt })
        }
        return
      }
      if (frame.type !== 'e2e_pw_pake' || payload.sid !== sidB64) return
      const round = Number(payload.round)
      try {
        if (round === 1) {
          if (payload.error) { finish({ ok: false, error: String(payload.error) }); return }
          if (!stretched) return // shouldn't happen — see the note above
          const g = pwCpaceGenerator(stretched, sid, ci)
          const { y, Y } = C.cpaceStart(g)
          const receivedYa = C.b64d(String(payload.ya))
          const K = C.cpaceShared(receivedYa, y)
          isk = C.cpaceISK(sid, K, receivedYa, Y)
          th = C.transcriptHash(sid, ci, receivedYa, Y)
          const kc = C.kcKeys(isk, ci)
          opts.onProgress?.('verifying')
          ws.send(JSON.stringify({ type: 'e2e_pw_pake', payload: { sid: sidB64, round: 2, yb: C.b64e(Y), mac: C.b64e(C.macTag(kc.web, th)) } }))
          return
        }
        if (round === 3) {
          if (payload.error) { finish({ ok: false, error: String(payload.error) }); return }
          if (!isk || !th) { finish({ ok: false, error: 'PROTOCOL_ERROR' }); return }
          const kc = C.kcKeys(isk, ci)
          if (!C.macVerify(kc.adapter, th, C.b64d(String(payload.mac)))) { finish({ ok: false, error: 'WRONG_PASSWORD' }); return }
          const opened = C.aeadOpen(C.pairKey(isk, ci), 3, C.utf8('e2e-id'), C.b64d(String(payload.enc)))
          if (!opened) { finish({ ok: false, error: 'WRONG_PASSWORD' }); return }
          const targetId = JSON.parse(new TextDecoder().decode(opened)) as { id: string; sig: string }
          const targetPub = C.b64d(targetId.id)
          if (!C.pairBindVerify(targetPub, th, C.b64d(targetId.sig))) { finish({ ok: false, error: 'WRONG_PASSWORD' }); return }
          peerPub = targetPub
          const sealed = C.aeadSeal(C.pairKey(isk, ci), 4, C.utf8('e2e-id'), C.utf8(JSON.stringify({ id: C.b64e(opts.selfIdentity.pub), sig: C.b64e(C.pairBindSig(opts.selfIdentity.priv, th)) })))
          ws.send(JSON.stringify({ type: 'e2e_pw_pake', payload: { sid: sidB64, round: 4, enc: C.b64e(sealed) } }))
          return
        }
        if (round === 5) {
          if (payload.ok === true && peerPub) {
            finish({ ok: true, peerPub, fingerprint: typeof payload.fingerprint === 'string' ? payload.fingerprint : C.fingerprint(peerPub) })
          } else {
            finish({ ok: false, error: typeof payload.error === 'string' ? payload.error : 'PAIR_FAILED' })
          }
        }
      } catch {
        finish({ ok: false, error: 'PROTOCOL_ERROR' })
      }
    })
    ws.once('close', (code) => finish({ ok: false, error: `CONNECTION_CLOSED:${code}` }))
    ws.once('error', () => finish({ ok: false, error: 'CONNECTION_ERROR' }))
  })
}
