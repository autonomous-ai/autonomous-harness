import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocketServer } from 'ws'
import type { AddressInfo } from 'net'

// Same reason as manager.test.ts: ADAPTER_DATA_DIR must be set before any transitive import of
// config/env.js, so every module under test is dynamically imported after the temp dir is set.
type Frame = Record<string, unknown>
let C: typeof import('./core.js')
let E2eeManagerCtor: typeof import('./manager.js')['E2eeManager']
let RelaySessionCrypto: typeof import('./relayClient.js')['RelaySessionCrypto']
let claimSetupToken: typeof import('./relayClient.js')['claimSetupToken']
let MachinePeerStore: typeof import('./machinePeers.js')['MachinePeerStore']
let RemoteRelayPool: typeof import('../remoteRelay.js')['RemoteRelayPool']

const MACHINE_ID = 'f2e0383771b734e4fc00f0bc8ccf060f'

beforeAll(async () => {
  process.env.ADAPTER_DATA_DIR = mkdtempSync(join(tmpdir(), 'e2ee-link-'))
  C = await import('./core.js')
  E2eeManagerCtor = (await import('./manager.js')).E2eeManager
  const relayClient = await import('./relayClient.js')
  RelaySessionCrypto = relayClient.RelaySessionCrypto
  claimSetupToken = relayClient.claimSetupToken
  MachinePeerStore = (await import('./machinePeers.js')).MachinePeerStore
  RemoteRelayPool = (await import('../remoteRelay.js')).RemoteRelayPool
})

beforeEach(() => {
  try { rmSync(join(process.env.ADAPTER_DATA_DIR as string, 'e2e'), { recursive: true, force: true }) } catch { /* none */ }
})

describe('MachinePeerStore', () => {
  it('pins, lists, and unlinks — surviving a fresh instance (no in-memory cache)', () => {
    const a = new MachinePeerStore()
    const identity = C.newIdentity()
    a.pin(MACHINE_ID, C.b64e(identity.pub), 'test peer')
    // A second instance must see the write immediately — RemoteRelayPool and `harness link import`
    // run as separate processes/instances and must never rely on a stale in-memory cache.
    const b = new MachinePeerStore()
    expect(b.get(MACHINE_ID)?.pub).toBe(C.b64e(identity.pub))
    expect(b.list()).toHaveLength(1)
    expect(b.list()[0].fingerprint).toBe(C.fingerprint(identity.pub))
    expect(b.unlink(MACHINE_ID)).toBe(true)
    expect(b.get(MACHINE_ID)).toBeNull()
    expect(b.unlink(MACHINE_ID)).toBe(false)
  })
})

describe('link create/import + relay session crypto (interop with the real E2eeManager)', () => {
  it('claimSetupToken pins the correct adapter pubkey, then hello/welcome + frame/terminal round-trip succeed', async () => {
    const inbox: Frame[] = []
    // Fakes just enough of backend's `/api/web-ws` (machine_select -> connected, then generic e2e_*
    // frame relay) to drive a REAL E2eeManager on the "adapter" side against real client-role code —
    // no backend involved, but the exact same frame shapes cross the exact same transport primitive
    // (a WebSocket) that production uses.
    const wss = new WebSocketServer({ port: 0 })
    const manager = new E2eeManagerCtor({
      machineId: MACHINE_ID,
      sendTo: (_connId, frame) => {
        inbox.push(frame)
        for (const client of wss.clients) client.send(JSON.stringify(frame))
      },
      isConnected: () => true,
    })
    wss.on('connection', (ws) => {
      let selected = false
      ws.on('message', (raw) => {
        let frame: Frame
        try { frame = JSON.parse(raw.toString()) as Frame } catch { return }
        if (!selected) {
          if (frame.type === 'machine_select') {
            selected = true
            ws.send(JSON.stringify({ type: 'connected', payload: { machineId: MACHINE_ID } }))
          }
          return
        }
        const type = frame.type as string
        if (type.startsWith('e2e_')) manager.handleFrame('fake-conn', frame)
      })
    })

    try {
      const port = (wss.address() as AddressInfo).port
      const wsBase = `ws://127.0.0.1:${port}`
      const clientIdentity = C.newIdentity()
      const token = manager.createSetupToken(MACHINE_ID).token

      const result = await claimSetupToken({
        token,
        targetMachineId: MACHINE_ID,
        selfIdentity: clientIdentity,
        accessToken: 'unused-in-this-fake',
        backendWsBase: wsBase,
        autonomousEnv: 'prod',
        timeoutMs: 2_000,
      })

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.fingerprint).toBe(manager.fingerprint())

      const peers = new MachinePeerStore()
      peers.pin(MACHINE_ID, C.b64e(result.peerPub), 'test')

      // Session establishment (hello/welcome) + frame/terminal crypto round-trip, driven in-process
      // against the same manager instance the claim above already pinned into.
      const crypto = new RelaySessionCrypto({ machineId: MACHINE_ID, selfIdentity: clientIdentity, peerPub: result.peerPub })
      const hello = crypto.helloFrame()
      expect(manager.handleFrame('session-conn', hello)).toBe(true)
      const welcome = inbox[inbox.length - 1]
      expect(welcome.type).toBe('e2e_welcome')
      expect(crypto.handleWelcome(welcome.payload as Record<string, unknown>)).toBe(true)
      expect(crypto.ready).toBe(true)

      // Outgoing: client encrypts a down-type frame; manager decrypts it via unwrapDown.
      const outgoing = crypto.wrapOutgoing({ type: 'terminal_input', payload: { requestId: 'r1', foo: 'bar' } })
      expect((outgoing.payload as Record<string, unknown>).__e2e).toBeDefined()
      const decrypted = manager.unwrapDown('session-conn', outgoing)
      expect(decrypted).not.toBeNull()
      expect((decrypted!.payload as Record<string, unknown>).foo).toBe('bar')

      // Incoming: manager broadcasts a group-encrypted up event; client decrypts it.
      const wrappedUp = manager.wrapUp({ type: 'user_message', payload: { text: 'hi' } })
      const plainUp = crypto.unwrapIncoming(wrappedUp)
      expect(plainUp).not.toBeNull()
      expect((plainUp!.payload as Record<string, unknown>).text).toBe('hi')

      // Terminal binary round-trip, both directions.
      const clear = { kind: 1 as const, streamId: '00112233-4455-6677-8899-aabbccddeeff', seq: 1, bytes: new Uint8Array([1, 2, 3]), compressed: false }
      const sealedOut = crypto.encryptTerminal(clear)
      expect(sealedOut).not.toBeNull()
      const openedByAdapter = manager.unwrapTerminalBinary('session-conn', sealedOut!)
      expect(openedByAdapter?.bytes).toEqual(clear.bytes)

      const sealedIn = manager.wrapTerminalBinary('session-conn', { ...clear, kind: 2 })
      expect(sealedIn).not.toBeNull()
      const openedByClient = crypto.decryptTerminal(sealedIn!)
      expect(openedByClient?.bytes).toEqual(clear.bytes)
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    }
  })

  it('rejects a token signed for a different machine id', async () => {
    const manager = new E2eeManagerCtor({ machineId: MACHINE_ID, sendTo: () => {}, isConnected: () => true })
    const token = manager.createSetupToken(MACHINE_ID).token
    const result = await claimSetupToken({
      token,
      targetMachineId: 'a-completely-different-machine-id',
      selfIdentity: C.newIdentity(),
      accessToken: 'unused',
      backendWsBase: 'ws://127.0.0.1:1', // never reached — rejected before any connection is opened
      autonomousEnv: 'prod',
    })
    expect(result).toEqual({ ok: false, error: 'BAD_TOKEN' })
  })
})

describe('RemoteRelayPool drops a peer the responder no longer trusts', () => {
  // A fake AuthSessionManager — RemoteRelayPool only ever calls .accessToken({force}).
  const fakeAuth = { accessToken: async () => 'unused-in-this-fake' } as unknown as import('../authSession.js').AuthSessionManager

  it('e2e_denied during the handshake unlinks the peer and surfaces NO_PEER_LINK', async () => {
    const wss = new WebSocketServer({ port: 0 })
    wss.on('connection', (ws) => {
      let selected = false
      ws.on('message', (raw) => {
        let frame: Frame
        try { frame = JSON.parse(raw.toString()) as Frame } catch { return }
        if (!selected && frame.type === 'machine_select') {
          selected = true
          ws.send(JSON.stringify({ type: 'connected', payload: { machineId: MACHINE_ID } }))
          return
        }
        if (frame.type === 'e2e_hello') {
          // Simulate a responder that has since `harness unpair`ed this identity.
          ws.send(JSON.stringify({ type: 'e2e_denied', payload: { reason: 'revoked' } }))
        }
      })
    })

    try {
      const port = (wss.address() as AddressInfo).port
      const peers = new MachinePeerStore()
      peers.pin(MACHINE_ID, C.b64e(C.newIdentity().pub), 'harness link')
      const pool = new RemoteRelayPool(fakeAuth, `ws://127.0.0.1:${port}`, C.newIdentity(), peers)

      const sink = { sendFrame: () => true, sendBinary: () => true }
      await expect(
        pool.acquire(MACHINE_ID, 'prod', { type: 'machine_select', payload: { machineId: MACHINE_ID } }, sink, () => {}),
      ).rejects.toThrow('NO_PEER_LINK')
      expect(peers.get(MACHINE_ID)).toBeNull()
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    }
  })

  it('a mid-session e2e_denied unlinks the peer and closes the local session with 4404', async () => {
    const inbox: Frame[] = []
    const wss = new WebSocketServer({ port: 0 })
    const manager = new E2eeManagerCtor({
      machineId: MACHINE_ID,
      sendTo: (_connId, frame) => {
        inbox.push(frame)
        for (const client of wss.clients) client.send(JSON.stringify(frame))
      },
      isConnected: () => true,
    })
    let serverWs: import('ws').WebSocket | null = null
    wss.on('connection', (ws) => {
      serverWs = ws
      let selected = false
      ws.on('message', (raw) => {
        let frame: Frame
        try { frame = JSON.parse(raw.toString()) as Frame } catch { return }
        if (!selected) {
          if (frame.type === 'machine_select') {
            selected = true
            ws.send(JSON.stringify({ type: 'connected', payload: { machineId: MACHINE_ID } }))
          }
          return
        }
        const type = frame.type as string
        if (type.startsWith('e2e_')) manager.handleFrame('fake-conn', frame)
      })
    })

    try {
      const port = (wss.address() as AddressInfo).port
      const clientIdentity = C.newIdentity()
      const token = manager.createSetupToken(MACHINE_ID).token
      const claim = await claimSetupToken({
        token,
        targetMachineId: MACHINE_ID,
        selfIdentity: clientIdentity,
        accessToken: 'unused-in-this-fake',
        backendWsBase: `ws://127.0.0.1:${port}`,
        autonomousEnv: 'prod',
        timeoutMs: 2_000,
      })
      expect(claim.ok).toBe(true)
      if (!claim.ok) return

      const peers = new MachinePeerStore()
      peers.pin(MACHINE_ID, C.b64e(claim.peerPub), 'harness link')
      const pool = new RemoteRelayPool(fakeAuth, `ws://127.0.0.1:${port}`, clientIdentity, peers)

      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        const sink = { sendFrame: () => true, sendBinary: () => true }
        void pool
          .acquire(MACHINE_ID, 'prod', { type: 'machine_select', payload: { machineId: MACHINE_ID } }, sink, (code, reason) => resolve({ code, reason }))
          .then(() => {
            // Session is live — now simulate the responder revoking mid-session, exactly as
            // E2eeManager.denyAndDropSessionsFor does on `harness unpair`: send e2e_denied without
            // closing the socket itself.
            serverWs?.send(JSON.stringify({ type: 'e2e_denied', payload: { reason: 'revoked' } }))
          })
      })

      const result = await closed
      expect(result.code).toBe(4404)
      expect(peers.get(MACHINE_ID)).toBeNull()
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    }
  })
})
