import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const AGENT = 'f2e0383771b734e4fc00f0bc8ccf060f'

let dataDir = ''

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'e2ee-setup-'))
  process.env.ADAPTER_DATA_DIR = dataDir
  vi.resetModules()
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
  delete process.env.ADAPTER_DATA_DIR
})

async function loadE2ee() {
  const C = await import('./core.js')
  const { E2eeStore } = await import('./store.js')
  const { E2eeManager } = await import('./manager.js')
  return { C, E2eeStore, E2eeManager }
}

describe('E2EE setup links', () => {
  it('keeps signed setup tokens reusable without persisted nonce state', async () => {
    const { C, E2eeStore } = await loadE2ee()
    const store = new E2eeStore()
    store.init()
    const setup = store.createSetupToken(AGENT)

    expect(C.verifySetupToken(setup.token, Date.now(), AGENT)?.payload.machineId).toBe(AGENT)
    expect(store.validateSetupToken(setup.token, AGENT)).toMatchObject({ ok: true, fingerprint: setup.fingerprint })
    expect(store.validateSetupToken(setup.token, AGENT)).toMatchObject({ ok: true, fingerprint: setup.fingerprint })

    // Simulate a pre-upgrade build that already consumed this token and persisted an empty nonce list.
    // A fresh post-upgrade store must still accept the signed, unexpired link.
    writeFileSync(join(dataDir, 'e2e', 'setup-nonces.json'), '[]')
    const afterUpgrade = new E2eeStore()
    afterUpgrade.init()
    expect(afterUpgrade.validateSetupToken(setup.token, AGENT)).toMatchObject({ ok: true, fingerprint: setup.fingerprint })
  })

  it('keeps every generated link valid until its signed expiry', async () => {
    const { C, E2eeStore } = await loadE2ee()
    const store = new E2eeStore()
    store.init()
    const first = store.createSetupToken(AGENT)
    const second = store.createSetupToken(AGENT)
    const expired = store.createSetupToken(AGENT, -1)
    const foreign = C.newIdentity()
    const foreignToken = C.encodeSetupToken({
      v: 1,
      typ: 'adapter-e2ee-setup',
      pub: C.b64e(foreign.pub),
      nonce: 'foreign-adapter',
      exp: Date.now() + 60_000,
      machineId: AGENT,
    }, foreign.priv)
    const tampered = `${first.token.slice(0, -1)}${first.token.endsWith('A') ? 'B' : 'A'}`

    expect(store.validateSetupToken(first.token, AGENT).ok).toBe(true)
    expect(store.validateSetupToken(second.token, AGENT).ok).toBe(true)
    expect(store.validateSetupToken(expired.token, AGENT)).toEqual({ ok: false, error: 'BAD_TOKEN' })
    expect(store.validateSetupToken(first.token, '00000000000000000000000000000000')).toEqual({ ok: false, error: 'BAD_TOKEN' })
    expect(store.validateSetupToken(foreignToken, AGENT)).toEqual({ ok: false, error: 'WRONG_ADAPTER' })
    expect(store.validateSetupToken(tampered, AGENT)).toEqual({ ok: false, error: 'BAD_TOKEN' })
  })

  it('auto-pairs multiple browser identities from the same setup link', async () => {
    const { C, E2eeManager } = await loadE2ee()
    const sent: Array<{ connId: string; frame: Record<string, unknown> }> = []
    const mgr = new E2eeManager({
      machineId: AGENT,
      sendTo: (connId, frame) => sent.push({ connId, frame }),
      isConnected: () => true,
    })
    const web1 = C.newIdentity()
    const web2 = C.newIdentity()
    const setup = mgr.createSetupToken()

    mgr.handleFrame('a', {
      type: 'e2e_setup_claim',
      payload: {
        requestId: 'r1',
        token: setup.token,
        identityPub: C.b64e(web1.pub),
        label: 'Chrome',
        sig: C.b64e(C.setupClaimSig(web1.priv, AGENT, setup.token, web1.pub)),
      },
    })
    expect(sent.at(-1)?.frame.payload).toMatchObject({ requestId: 'r1', ok: true, fingerprint: setup.fingerprint })
    expect(mgr.listPaired()).toHaveLength(1)
    expect(mgr.listPaired()[0].fingerprint).toBe(C.fingerprint(web1.pub))

    mgr.handleFrame('b', {
      type: 'e2e_setup_claim',
      payload: {
        requestId: 'r2',
        token: setup.token,
        identityPub: C.b64e(web2.pub),
        label: 'Firefox',
        sig: C.b64e(C.setupClaimSig(web2.priv, AGENT, setup.token, web2.pub)),
      },
    })
    expect(sent.at(-1)?.frame.payload).toMatchObject({ requestId: 'r2', ok: true, fingerprint: setup.fingerprint })
    expect(mgr.listPaired()).toHaveLength(2)
    expect(mgr.listPaired().map((p) => p.fingerprint)).toEqual(expect.arrayContaining([
      C.fingerprint(web1.pub),
      C.fingerprint(web2.pub),
    ]))
  })
})

describe('trusted web device pairing', () => {
  it('notifies every trusted web session when a device pairing intent appears', async () => {
    const { C, E2eeManager } = await loadE2ee()
    const sent: Array<{ connId: string; frame: Record<string, unknown> }> = []
    const userSent: Array<Record<string, unknown>> = []
    const mgr = new E2eeManager({
      machineId: AGENT,
      sendTo: (connId, frame) => sent.push({ connId, frame }),
      sendUser: (frame) => userSent.push(frame),
      isConnected: () => true,
    })
    const key = new Uint8Array(32).fill(7)
    ;(mgr as unknown as { sessions: Map<string, unknown> }).sessions.set('web1', { webIdentityPub: 'w1', role: 'web', c2s: key, s2c: key, s2cCounter: 1, c2sRecv: -1 })
    ;(mgr as unknown as { sessions: Map<string, unknown> }).sessions.set('web2', { webIdentityPub: 'w2', role: 'web', c2s: key, s2c: key, s2cCounter: 1, c2sRecv: -1 })
    ;(mgr as unknown as { sessions: Map<string, unknown> }).sessions.set('device1', { webIdentityPub: 'd1', role: 'device', c2s: key, s2c: key, s2cCounter: 1, c2sRecv: -1 })

    mgr.handleFrame('device-conn', {
      type: 'e2e_pair_intent',
      payload: { requestId: 'intent', pairId: C.b64e(C.newPairId()), label: 'Device', role: 'device' },
    })

    const pending = sent.filter((s) => s.frame.type === 'device_e2ee_pair_pending')
    expect(pending.map((s) => s.connId).sort()).toEqual(['web1', 'web2'])
    expect(pending.every((s) => C.isWrapped(s.frame.payload))).toBe(true)
    expect(sent.some((s) => s.connId === 'device1' && s.frame.type === 'device_e2ee_pair_pending')).toBe(false)
    expect(userSent).toHaveLength(1)
    expect(userSent[0]).toMatchObject({
      type: 'device_e2ee_pair_pending',
      payload: { machineId: AGENT, label: 'Device' },
    })
  })

  it('rejects stale trusted-web device pair requests without starting CPace', async () => {
    const { C, E2eeManager } = await loadE2ee()
    const sent: Array<{ connId: string; frame: Record<string, unknown> }> = []
    const mgr = new E2eeManager({
      machineId: AGENT,
      sendTo: (connId, frame) => sent.push({ connId, frame }),
      isConnected: () => true,
    })
    const key = new Uint8Array(32).fill(9)
    ;(mgr as unknown as { sessions: Map<string, unknown> }).sessions.set('web1', { webIdentityPub: 'w1', role: 'web', c2s: key, s2c: key, s2cCounter: 1, c2sRecv: -1 })
    mgr.handleFrame('device-conn', {
      type: 'e2e_pair_intent',
      payload: { requestId: 'intent', pairId: C.b64e(C.newPairId()), label: 'Device', role: 'device' },
    })

    await mgr.pairDeviceFromTrustedWeb('web1', { requestId: 'pair', pairId: 'old-pair', code: 'ABC123' })

    const result = sent.find((s) => s.connId === 'web1' && s.frame.type === 'device_e2ee_pair_result')
    expect(result?.frame.payload).toBeTruthy()
    expect(C.isWrapped(result?.frame.payload)).toBe(true)
    const opened = C.unwrapPayload(key, (result!.frame.payload as { __e2e: never }).__e2e, 'device_e2ee_pair_result', undefined) as { requestId?: string; error?: string } | null
    expect(opened).toMatchObject({ requestId: 'pair', error: 'STALE_PAIR' })
  })

  it('clears trusted web popups when the device cancels pairing', async () => {
    const { C, E2eeManager } = await loadE2ee()
    const sent: Array<{ connId: string; frame: Record<string, unknown> }> = []
    const userSent: Array<Record<string, unknown>> = []
    const mgr = new E2eeManager({
      machineId: AGENT,
      sendTo: (connId, frame) => sent.push({ connId, frame }),
      sendUser: (frame) => userSent.push(frame),
      isConnected: () => true,
    })
    const key = new Uint8Array(32).fill(11)
    ;(mgr as unknown as { sessions: Map<string, unknown> }).sessions.set('web1', { webIdentityPub: 'w1', role: 'web', c2s: key, s2c: key, s2cCounter: 1, c2sRecv: -1 })
    const pairId = C.b64e(C.newPairId())
    mgr.handleFrame('device-conn', {
      type: 'e2e_pair_intent',
      payload: { requestId: 'intent', pairId, label: 'Device', role: 'device' },
    })

    mgr.handleFrame('device-conn', { type: 'e2e_pair_cancel', payload: { pairId } })

    expect(mgr.pendingPair()).toBeNull()
    const cleared = sent.find((s) => s.connId === 'web1' && s.frame.type === 'device_e2ee_pair_cleared')
    expect(C.isWrapped(cleared?.frame.payload)).toBe(true)
    const opened = C.unwrapPayload(key, (cleared!.frame.payload as { __e2e: never }).__e2e, 'device_e2ee_pair_cleared', undefined) as { pairId?: string; result?: string } | null
    expect(opened).toMatchObject({ pairId, result: 'cancelled' })
    expect(userSent.at(-1)).toMatchObject({
      type: 'device_e2ee_pair_cleared',
      payload: { machineId: AGENT, pairId, result: 'cancelled' },
    })
  })
})

describe('trusted web pairing management', () => {
  it('marks the requesting browser and sends encrypted unpair result before revoking it', async () => {
    const { C, E2eeManager } = await loadE2ee()
    const sent: Array<{ connId: string; frame: Record<string, unknown> }> = []
    const mgr = new E2eeManager({
      machineId: AGENT,
      sendTo: (connId, frame) => sent.push({ connId, frame }),
      isConnected: () => true,
    })
    const web = C.newIdentity()
    const setup = mgr.createSetupToken()
    mgr.handleFrame('setup', {
      type: 'e2e_setup_claim',
      payload: {
        requestId: 'setup',
        token: setup.token,
        identityPub: C.b64e(web.pub),
        label: 'Chrome',
        sig: C.b64e(C.setupClaimSig(web.priv, AGENT, setup.token, web.pub)),
      },
    })

    const key = new Uint8Array(32).fill(13)
    ;(mgr as unknown as { sessions: Map<string, unknown> }).sessions.set('web1', { webIdentityPub: C.b64e(web.pub), role: 'web', c2s: key, s2c: key, s2cCounter: 1, c2sRecv: -1 })
    const current = mgr.listPaired('web1')[0]
    expect(current.current).toBe(true)

    mgr.revokeFromTrustedWeb('web1', { requestId: 'revoke', selector: current.fingerprint })

    const result = sent.find((s) => s.connId === 'web1' && s.frame.type === 'e2ee_pairing_unpair_result')
    expect(C.isWrapped(result?.frame.payload)).toBe(true)
    const opened = C.unwrapPayload(key, (result!.frame.payload as { __e2e: never }).__e2e, 'e2ee_pairing_unpair_result', undefined) as { requestId?: string; ok?: boolean; fingerprint?: string } | null
    expect(opened).toMatchObject({ requestId: 'revoke', ok: true, fingerprint: current.fingerprint })
    expect(sent.some((s) => s.connId === 'web1' && s.frame.type === 'e2e_denied')).toBe(true)
    expect(mgr.listPaired()).toHaveLength(0)
  })
})
