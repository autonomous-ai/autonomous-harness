import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// The manager transitively imports config/env (validated at load) + writes the paired store to disk,
// so point ADAPTER_DATA_DIR at a temp dir BEFORE importing it (dynamic import in beforeAll).
type Frame = Record<string, unknown>
let C: typeof import('./core.js')
let makeManager: typeof import('./manager.js')['E2eeManager']

const AGENT = 'f2e0383771b734e4fc00f0bc8ccf060f'

beforeAll(async () => {
  process.env.ADAPTER_DATA_DIR = mkdtempSync(join(tmpdir(), 'e2ee-mgr-'))
  C = await import('./core.js')
  makeManager = (await import('./manager.js')).E2eeManager
})

// Fresh persisted store (identity + paired.json) per test — the store is disk-backed and shared by
// every manager instance, so without this pairs accumulate across tests.
beforeEach(() => {
  try { rmSync(join(process.env.ADAPTER_DATA_DIR as string, 'e2e'), { recursive: true, force: true }) } catch { /* none */ }
})

/** A minimal web peer that runs the CPace responder + session handshake against the manager. */
class WebPeer {
  identity = C.newIdentity()
  session?: { c2s: Uint8Array; s2c: Uint8Array; groupKey: Uint8Array; epoch: string; myEph: import('./core.js').Ephemeral }
  adapterPub?: Uint8Array
  private pr?: { code: string; pairId: Uint8Array; pairIdB64: string; y?: bigint; Ya?: Uint8Array; Yb?: Uint8Array; isk?: Uint8Array; th?: Uint8Array }

  intent(pairId: Uint8Array): Frame {
    this.pr = { code: '', pairId, pairIdB64: C.b64e(pairId) }
    return { type: 'e2e_pair_intent', payload: { requestId: 'r1', pairId: this.pr.pairIdB64, label: 'Chrome · macOS' } }
  }
  setCode(code: string): void { if (this.pr) this.pr.code = code }

  /** Handle an adapter→web pake frame; return the reply frame to feed back (or null). */
  onPake(frame: Frame): Frame | null {
    const p = frame.payload as Record<string, unknown>
    const pr = this.pr!
    const ci = C.pairContext(AGENT)
    const round = Number(p.round)
    if (round === 1) {
      const g = C.cpaceGenerator(pr.code, pr.pairId, ci)
      const { y, Y } = C.cpaceStart(g)
      const Ya = C.b64d(String(p.ya))
      const K = C.cpaceShared(Ya, y)
      pr.y = y; pr.Ya = Ya; pr.Yb = Y
      pr.isk = C.cpaceISK(pr.pairId, K, Ya, Y)
      pr.th = C.transcriptHash(pr.pairId, ci, Ya, Y)
      const kc = C.kcKeys(pr.isk, ci)
      return { type: 'e2e_pake', payload: { pairId: pr.pairIdB64, round: 2, yb: C.b64e(Y), mac: C.b64e(C.macTag(kc.web, pr.th)) } }
    }
    if (round === 3) {
      const kc = C.kcKeys(pr.isk!, ci)
      if (!C.macVerify(kc.adapter, pr.th!, C.b64d(String(p.mac)))) throw new Error('adapter MAC failed')
      const opened = C.aeadOpen(C.pairKey(pr.isk!, ci), 3, C.utf8('e2e-id'), C.b64d(String(p.enc)))!
      const adId = JSON.parse(new TextDecoder().decode(opened)) as { id: string; sig: string }
      if (!C.pairBindVerify(C.b64d(adId.id), pr.th!, C.b64d(adId.sig))) throw new Error('adapter bind sig failed')
      this.adapterPub = C.b64d(adId.id) // pin

      const sealed = C.aeadSeal(C.pairKey(pr.isk!, ci), 4, C.utf8('e2e-id'), C.utf8(JSON.stringify({ id: C.b64e(this.identity.pub), sig: C.b64e(C.pairBindSig(this.identity.priv, pr.th!)) })))
      return { type: 'e2e_pake', payload: { pairId: pr.pairIdB64, round: 4, enc: C.b64e(sealed) } }
    }
    return null // round 5 (ok/error) — nothing to send
  }

  hello(): Frame {
    const eph = C.newEphemeral()
    this.session = { c2s: new Uint8Array(), s2c: new Uint8Array(), groupKey: new Uint8Array(), epoch: '', myEph: eph }
    return { type: 'e2e_hello', payload: { identityPub: C.b64e(this.identity.pub), ephPub: C.b64e(eph.pub), sig: C.b64e(C.helloSig(this.identity.priv, AGENT, eph.pub)) } }
  }
  onWelcome(frame: Frame, adapterPub: Uint8Array): void {
    const p = frame.payload as Record<string, unknown>
    const adapterEphPub = C.b64d(String(p.ephPub))
    const myEphPub = this.session!.myEph.pub
    expect(C.welcomeVerify(adapterPub, AGENT, myEphPub, adapterEphPub, C.b64d(String(p.sig)))).toBe(true)
    const keys = C.sessionKeys(this.session!.myEph.priv, adapterEphPub, AGENT, myEphPub, adapterEphPub)
    const opened = C.aeadOpen(keys.s2c, 0, C.utf8('e2e-welcome'), C.b64d(String(p.enc)))!
    const { groupKey, epoch } = JSON.parse(new TextDecoder().decode(opened)) as { groupKey: string; epoch: string }
    this.session!.c2s = keys.c2s; this.session!.s2c = keys.s2c
    this.session!.groupKey = C.b64d(groupKey); this.session!.epoch = epoch
  }
  onRekey(frame: Frame): void {
    const p = frame.payload as Record<string, unknown>
    const opened = C.aeadOpen(this.session!.s2c, Number(p.n), C.utf8('e2e-rekey'), C.b64d(String(p.enc)))!
    const { groupKey, epoch } = JSON.parse(new TextDecoder().decode(opened)) as { groupKey: string; epoch: string }
    this.session!.groupKey = C.b64d(groupKey); this.session!.epoch = epoch
  }
}

function machine() {
  const sent: Array<{ connId: string; frame: Frame }> = []
  const mgr = new makeManager({ machineId: AGENT, sendTo: (connId, frame) => sent.push({ connId, frame }), isConnected: () => true })
  const takeLast = (type: string): Frame => {
    for (let i = sent.length - 1; i >= 0; i--) if (sent[i].frame.type === type) return sent[i].frame
    throw new Error(`no ${type} sent`)
  }
  const lastFor = (connId: string, type: string): Frame | undefined => {
    for (let i = sent.length - 1; i >= 0; i--) if (sent[i].connId === connId && sent[i].frame.type === type) return sent[i].frame
    return undefined
  }
  return { mgr, sent, takeLast, lastFor }
}

/** Drive a full pairing + session for one connection; returns the established web peer. */
async function fullPair(h: ReturnType<typeof machine>, conn: string): Promise<WebPeer> {
  const web = new WebPeer()
  h.mgr.handleFrame(conn, web.intent(C.newPairId()))
  const code = C.newPairCode(); web.setCode(code)
  const pairP = h.mgr.onPair(code)
  h.mgr.handleFrame(conn, web.onPake(h.lastFor(conn, 'e2e_pake')!)!) // r2 → r3
  h.mgr.handleFrame(conn, web.onPake(h.lastFor(conn, 'e2e_pake')!)!) // r4 → r5
  await pairP
  h.mgr.handleFrame(conn, web.hello())
  web.onWelcome(h.lastFor(conn, 'e2e_welcome')!, web.adapterPub!)
  return web
}

describe('E2eeManager pairing', () => {
  it('setup-link claim auto-pairs the browser, then hello establishes a session', () => {
    const h = machine()
    const web = new WebPeer()
    const conn = 'setup1'
    const setup = h.mgr.createSetupToken()
    const claim = {
      type: 'e2e_setup_claim',
      payload: {
        requestId: 'setup-r1',
        token: setup.token,
        identityPub: C.b64e(web.identity.pub),
        label: 'Chrome · macOS',
        sig: C.b64e(C.setupClaimSig(web.identity.priv, AGENT, setup.token, web.identity.pub)),
      },
    }

    h.mgr.handleFrame(conn, claim)
    const result = h.lastFor(conn, 'e2e_setup_claim_result')!.payload as Record<string, unknown>
    expect(result).toMatchObject({ ok: true, requestId: 'setup-r1', fingerprint: h.mgr.fingerprint() })
    expect(h.mgr.listPaired()[0].fingerprint).toBe(C.fingerprint(web.identity.pub))

    h.mgr.handleFrame(conn, web.hello())
    web.adapterPub = C.b64d(C.verifySetupToken(setup.token)!.payload.pub)
    web.onWelcome(h.lastFor(conn, 'e2e_welcome')!, web.adapterPub)
    expect(h.mgr.hasSession(conn)).toBe(true)
  })

  it('one setup link pairs multiple browsers and establishes an E2EE session for each', () => {
    const h = machine()
    const web1 = new WebPeer()
    const web2 = new WebPeer()
    const setup = h.mgr.createSetupToken()
    h.mgr.handleFrame('setup-a', {
      type: 'e2e_setup_claim',
      payload: {
        requestId: 'a',
        token: setup.token,
        identityPub: C.b64e(web1.identity.pub),
        label: 'Chrome',
        sig: C.b64e(C.setupClaimSig(web1.identity.priv, AGENT, setup.token, web1.identity.pub)),
      },
    })
    h.mgr.handleFrame('setup-b', {
      type: 'e2e_setup_claim',
      payload: {
        requestId: 'b',
        token: setup.token,
        identityPub: C.b64e(web2.identity.pub),
        label: 'Firefox',
        sig: C.b64e(C.setupClaimSig(web2.identity.priv, AGENT, setup.token, web2.identity.pub)),
      },
    })
    expect(h.lastFor('setup-a', 'e2e_setup_claim_result')!.payload).toMatchObject({ ok: true })
    expect(h.lastFor('setup-b', 'e2e_setup_claim_result')!.payload).toMatchObject({ ok: true })
    expect(h.mgr.listPaired().length).toBe(2)

    const adapterPub = C.b64d(C.verifySetupToken(setup.token)!.payload.pub)
    h.mgr.handleFrame('setup-a', web1.hello())
    web1.onWelcome(h.lastFor('setup-a', 'e2e_welcome')!, adapterPub)
    h.mgr.handleFrame('setup-b', web2.hello())
    web2.onWelcome(h.lastFor('setup-b', 'e2e_welcome')!, adapterPub)
    expect(h.mgr.hasSession('setup-a')).toBe(true)
    expect(h.mgr.hasSession('setup-b')).toBe(true)
  })

  it('completes a full pairing, pins the browser, and establishes a session + group key', async () => {
    const { mgr, takeLast } = machine()
    const web = new WebPeer()
    const conn = 'conn1'
    const pairId = C.newPairId()

    mgr.handleFrame(conn, web.intent(pairId))
    expect((takeLast('e2e_pair_intent_result').payload as Record<string, unknown>).accepted).toBe(true)

    const code = C.newPairCode()
    web.setCode(code)
    const pairP = mgr.onPair(code)                          // sends round 1
    const r2 = web.onPake(takeLast('e2e_pake'))!            // → round 2
    mgr.handleFrame(conn, r2)                               // → round 3
    const r4 = web.onPake(takeLast('e2e_pake'))!            // → round 4
    mgr.handleFrame(conn, r4)                               // → round 5 + resolves
    const result = await pairP
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.fingerprint).toBe(mgr.fingerprint())

    // session: hello → welcome
    mgr.handleFrame(conn, web.hello())
    const welcome = takeLast('e2e_welcome')
    expect(mgr.hasSession(conn)).toBe(true)
    web.onWelcome(welcome, web.adapterPub!) // adapter pub was pinned by the web during round 3

    const up = mgr.wrapUp({ type: 'text_delta', dbSessionId: 'sX', payload: { content: 'hello user' } })
    const env = (up.payload as import('./core.js').WrappedPayload).__e2e
    expect(env.k).toBe('g')
    const dec = C.unwrapPayload(web.session!.groupKey, env, 'text_delta', 'sX')
    expect(dec).toEqual({ content: 'hello user' })

    // down message: web encrypts under c2s → manager decrypts
    const wrapped = C.wrapPayload(web.session!.c2s, 'p', 0, 'message', undefined, { content: 'fix the bug' })
    const down = mgr.unwrapDown(conn, { type: 'message', payload: wrapped })
    expect((down!.payload as Record<string, unknown>).content).toBe('fix the bug')
  })

  it('rejects a wrong code at the confirmation MAC (round 2)', async () => {
    const { mgr, takeLast } = machine()
    const web = new WebPeer()
    const conn = 'c2'
    mgr.handleFrame(conn, web.intent(C.newPairId()))
    const realCode = C.newPairCode()
    web.setCode('BADCOD')                 // web believes a different code
    const pairP = mgr.onPair(realCode)    // adapter uses the real code
    const r2 = web.onPake(takeLast('e2e_pake'))!
    mgr.handleFrame(conn, r2)
    const result = await pairP
    expect(result).toEqual({ ok: false, error: 'CODE_MISMATCH' })
    const last = takeLast('e2e_pake').payload as Record<string, unknown>
    expect(last.error).toBe('CODE_MISMATCH')
  })

  it('e2e_status reports supported + enabled + not-paired for an unknown browser', () => {
    const { mgr, takeLast } = machine()
    const id = C.newIdentity()
    mgr.handleFrame('c3', { type: 'e2e_status', payload: { requestId: 'q', identityPub: C.b64e(id.pub) } })
    const r = takeLast('e2e_status_result').payload as Record<string, unknown>
    expect(r).toMatchObject({ supported: true, enabled: true, paired: false })
    expect(typeof r.fingerprint).toBe('string')
  })

  it('rejects a hello from an unpaired identity with e2e_denied', () => {
    const { mgr, takeLast } = machine()
    const web = new WebPeer()
    mgr.handleFrame('c4', web.hello())
    expect((takeLast('e2e_denied').payload as Record<string, unknown>).reason).toBe('unpaired')
    expect(mgr.hasSession('c4')).toBe(false)
  })

  it('a second concurrent pair_intent is rejected as PAIRING_BUSY while active', async () => {
    const { mgr, takeLast } = machine()
    const web = new WebPeer()
    mgr.handleFrame('c5', web.intent(C.newPairId()))
    mgr.onPair(C.newPairCode()) // becomes active (round 1 out)
    mgr.handleFrame('c6', { type: 'e2e_pair_intent', payload: { requestId: 'r2', pairId: C.b64e(C.newPairId()), label: 'x' } })
    expect((takeLast('e2e_pair_intent_result').payload as Record<string, unknown>).error).toBe('PAIRING_BUSY')
  })
})

describe('E2eeManager revoke', () => {
  it('lists paired browsers with fingerprint + online flag', async () => {
    const h = machine()
    const web = await fullPair(h, 'cx')
    const list = h.mgr.listPaired()
    expect(list.length).toBe(1)
    expect(list[0].online).toBe(true)
    expect(list[0].fingerprint).toBe(C.fingerprint(web.identity.pub))
  })

  it('revoke: signals the online browser (e2e_denied), rotates the group key, drops the pin', async () => {
    const h = machine()
    const conn = 'cy'
    const web = await fullPair(h, conn)
    const oldGroupKey = web.session!.groupKey
    const before = h.mgr.wrapUp({ type: 'text_delta', dbSessionId: 's', payload: { content: 'pre' } })
    const oldEpoch = (before.payload as import('./core.js').WrappedPayload).__e2e.epoch

    const r = h.mgr.revoke('1')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.fingerprint).toBe(C.fingerprint(web.identity.pub))
    // the online session got a revoke signal
    expect(h.lastFor(conn, 'e2e_denied')).toBeTruthy()
    expect((h.lastFor(conn, 'e2e_denied')!.payload as Record<string, unknown>).reason).toBe('revoked')
    // store emptied, session dropped
    expect(h.mgr.listPaired().length).toBe(0)
    expect(h.mgr.hasSession(conn)).toBe(false)
    // group key rotated → new epoch, and the revoked browser's OLD key can't decrypt new events
    const after = h.mgr.wrapUp({ type: 'text_delta', dbSessionId: 's', payload: { content: 'post' } })
    const newEnv = (after.payload as import('./core.js').WrappedPayload).__e2e
    expect(newEnv.epoch).not.toBe(oldEpoch)
    expect(C.unwrapPayload(oldGroupKey, newEnv, 'text_delta', 's')).toBeNull()
  })

  it('revoke re-keys the REMAINING browsers so they keep decrypting', async () => {
    const h = machine()
    const web1 = await fullPair(h, 'a1')
    const web2 = await fullPair(h, 'a2')
    // revoke web1 (list is sorted by pairedAt desc; select by fingerprint to be exact)
    const r = h.mgr.revoke(C.fingerprint(web1.identity.pub))
    expect(r.ok).toBe(true)
    expect((h.lastFor('a1', 'e2e_denied')!.payload as Record<string, unknown>).reason).toBe('revoked')
    // web2 received a rekey → apply it → can still decrypt the next event
    web2.onRekey(h.lastFor('a2', 'e2e_rekey')!)
    const after = h.mgr.wrapUp({ type: 'text_delta', dbSessionId: 's', payload: { content: 'still ok' } })
    const env = (after.payload as import('./core.js').WrappedPayload).__e2e
    expect(C.unwrapPayload(web2.session!.groupKey, env, 'text_delta', 's')).toEqual({ content: 'still ok' })
    expect(h.mgr.listPaired().length).toBe(1)
  })

  it('revoke-all clears every pair and denies every session', async () => {
    const h = machine()
    await fullPair(h, 'z1')
    await fullPair(h, 'z2')
    const r = h.mgr.revokeAll()
    expect(r.count).toBe(2)
    expect(h.mgr.listPaired().length).toBe(0)
    expect(h.lastFor('z1', 'e2e_denied')).toBeTruthy()
    expect(h.lastFor('z2', 'e2e_denied')).toBeTruthy()
    expect(h.mgr.hasSession('z1')).toBe(false)
    expect(h.mgr.hasSession('z2')).toBe(false)
  })

  it('revoke NOT_FOUND for an unknown selector', async () => {
    const h = machine()
    await fullPair(h, 'q1')
    expect(h.mgr.revoke('ZZZZ')).toEqual({ ok: false, error: 'NOT_FOUND' })
  })
})
