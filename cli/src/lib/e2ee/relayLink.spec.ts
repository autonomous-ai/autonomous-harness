import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocketServer } from 'ws'
import type { AddressInfo } from 'net'

// The one module here imported statically rather than in beforeAll: a test timeout is needed when
// `it()` is DEFINED, long before beforeAll runs. Safe because passwordPake.js is pure crypto —
// noble plus core.js — and reaches config/env.js by no path, which is the only thing the deferral
// above exists to keep out until ADAPTER_DATA_DIR is set.
import { PW_SCRYPT_TEST_TIMEOUT_MS } from './passwordPake.js'

// Same reason as manager.test.ts: ADAPTER_DATA_DIR must be set before any transitive import of
// config/env.js, so every module under test is dynamically imported after the temp dir is set.
type Frame = Record<string, unknown>
let C: typeof import('./core.js')
let E2eeManagerCtor: typeof import('./manager.js')['E2eeManager']
let RelaySessionCrypto: typeof import('./relayClient.js')['RelaySessionCrypto']
let connectWithPassword: typeof import('./relayClient.js')['connectWithPassword']
let MachinePeerStore: typeof import('./machinePeers.js')['MachinePeerStore']
let RemoteRelayPool: typeof import('../remoteRelay.js')['RemoteRelayPool']

const MACHINE_ID = 'f2e0383771b734e4fc00f0bc8ccf060f'
const REMOTE_PASSWORD = 'correct horse battery staple'

beforeAll(async () => {
  process.env.ADAPTER_DATA_DIR = mkdtempSync(join(tmpdir(), 'e2ee-link-'))
  C = await import('./core.js')
  E2eeManagerCtor = (await import('./manager.js')).E2eeManager
  const relayClient = await import('./relayClient.js')
  RelaySessionCrypto = relayClient.RelaySessionCrypto
  connectWithPassword = relayClient.connectWithPassword
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
    // A second instance must see the write immediately — RemoteRelayPool and `harness link connect`
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

describe('remote-password link + relay session crypto (interop with the real E2eeManager)', () => {
  it('connectWithPassword pins the correct adapter pubkey, then hello/welcome + frame/terminal round-trip succeed', async () => {
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
      await manager.setRemotePassword(REMOTE_PASSWORD)

      const result = await connectWithPassword({
        targetMachineId: MACHINE_ID,
        password: REMOTE_PASSWORD,
        selfIdentity: clientIdentity,
        accessToken: 'unused-in-this-fake',
        backendWsBase: wsBase,
        autonomousEnv: 'prod',
        timeoutMs: 5_000,
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
      expect(crypto.terminalP2pVersion).toBe(1)

      // Outgoing: client encrypts a down-type frame; manager decrypts it via unwrapDown.
      const outgoing = crypto.wrapOutgoing({ type: 'terminal_input', payload: { requestId: 'r1', foo: 'bar' } })
      expect((outgoing.payload as Record<string, unknown>).__e2e).toBeDefined()
      const decrypted = manager.unwrapDown('session-conn', outgoing)
      expect(decrypted).not.toBeNull()
      expect((decrypted!.payload as Record<string, unknown>).foo).toBe('bar')

      const gridRequest = { requestId: 'grid-1', args: ['chat', 'private prompt'] }
      const sealedGrid = crypto.wrapOutgoing({ type: 'grid_fleet_run', payload: gridRequest })
      expect(sealedGrid.payload).not.toHaveProperty('args')
      expect(manager.unwrapDown('session-conn', sealedGrid)?.payload).toEqual(gridRequest)
      const gridResult = { requestId: 'grid-1', stdout: 'private answer', code: 0 }
      const sealedResult = manager.wrapTarget('session-conn', 'grid_fleet_run_result', gridResult)!
      expect(sealedResult.payload).not.toHaveProperty('stdout')
      expect(crypto.unwrapIncoming(sealedResult)?.payload).toEqual(gridResult)

      // Creation recovery must take the same encrypted route as creation; its result contains
      // the agent's name and working folder. The relay sees neither the receipt nor those fields.
      const checking = { requestId: 'check-1', creationId: 'creation-fixture-001' }
      const statusRequest = crypto.wrapOutgoing({ type: 'agent_create_status', payload: checking })
      expect(statusRequest.payload).not.toHaveProperty('creationId')
      expect(manager.unwrapDown('session-conn', statusRequest)?.payload).toEqual(checking)
      const status = { ...checking, state: 'created', agent: { id: 'agent-1', cwd: '/private/work' } }
      const statusReply = manager.wrapTarget('session-conn', 'agent_create_status_result', status)!
      expect(statusReply.payload).not.toHaveProperty('agent')
      expect(crypto.unwrapIncoming(statusReply)?.payload).toEqual(status)

      const lowerDown = crypto.wrapOutgoing({ type: 'terminal_resize', payload: { streamId: 's', cols: 80 } })
      const higherDown = crypto.wrapOutgoing({ type: 'terminal_resize', payload: { streamId: 's', cols: 120 } })
      expect((manager.unwrapDown('session-conn', higherDown)?.payload as Record<string, unknown>).cols).toBe(120)
      expect((manager.unwrapDown('session-conn', lowerDown)?.payload as Record<string, unknown>).cols).toBe(80)
      expect(manager.unwrapDown('session-conn', lowerDown)).toBeNull()

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

      const lowerInput = crypto.encryptTerminal({ ...clear, seq: 2 })!
      const higherInput = crypto.encryptTerminal({ ...clear, seq: 3 })!
      expect(manager.unwrapTerminalBinary('session-conn', higherInput)?.seq).toBe(3)
      expect(manager.unwrapTerminalBinary('session-conn', lowerInput)?.seq).toBe(2)
      expect(manager.unwrapTerminalBinary('session-conn', lowerInput)).toBeNull()

      const sealedIn = manager.wrapTerminalBinary('session-conn', { ...clear, kind: 2 })
      expect(sealedIn).not.toBeNull()
      const openedByClient = crypto.decryptTerminal(sealedIn!)
      expect(openedByClient?.bytes).toEqual(clear.bytes)

      // WebSocket RPC/control and WebRTC terminal frames share counters but can cross in flight.
      // Authentic out-of-order frames inside the replay window must both survive; duplicates must not.
      const lower = manager.wrapTarget('session-conn', 'terminal_ready', { streamId: 'lower' })!
      const higher = manager.wrapTarget('session-conn', 'terminal_ready', { streamId: 'higher' })!
      expect((crypto.unwrapIncoming(higher)?.payload as Record<string, unknown>).streamId).toBe('higher')
      expect((crypto.unwrapIncoming(lower)?.payload as Record<string, unknown>).streamId).toBe('lower')
      expect(crypto.unwrapIncoming(lower)).toBeNull()

      const lowerBinary = manager.wrapTerminalBinary('session-conn', { ...clear, kind: 2, seq: 2 })!
      const higherBinary = manager.wrapTerminalBinary('session-conn', { ...clear, kind: 2, seq: 3 })!
      expect(crypto.decryptTerminal(higherBinary)?.seq).toBe(3)
      expect(crypto.decryptTerminal(lowerBinary)?.seq).toBe(2)
      expect(crypto.decryptTerminal(lowerBinary)).toBeNull()
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    }
  })

  /** Spin up the same fake `/api/web-ws` (machine_select -> connected, then e2e_* frame relay) used
   *  above, wired to a fresh real E2eeManager, and return both plus a cleanup function. */
  function fakeMachine(): { manager: InstanceType<typeof E2eeManagerCtor>; wsBase: Promise<string>; close: () => Promise<void> } {
    const wss = new WebSocketServer({ port: 0 })
    const manager = new E2eeManagerCtor({
      machineId: MACHINE_ID,
      sendTo: (_connId, frame) => { for (const client of wss.clients) client.send(JSON.stringify(frame)) },
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
    const wsBase = new Promise<string>((resolve) => {
      wss.once('listening', () => resolve(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`))
    })
    return { manager, wsBase, close: () => new Promise<void>((resolve) => wss.close(() => resolve())) }
  }

  it('NO_REMOTE_PASSWORD when the target machine never set one', async () => {
    const { manager, wsBase, close } = fakeMachine()
    try {
      const result = await connectWithPassword({
        targetMachineId: MACHINE_ID,
        password: REMOTE_PASSWORD,
        selfIdentity: C.newIdentity(),
        accessToken: 'unused',
        backendWsBase: await wsBase,
        autonomousEnv: 'prod',
        timeoutMs: 5_000,
      })
      expect(result).toEqual({ ok: false, error: 'NO_REMOTE_PASSWORD' })
      expect(manager.remotePasswordStatus().hasPassword).toBe(false)
    } finally {
      await close()
    }
  })

  it('a wrong password fails the MAC check and never pins a peer', async () => {
    const { manager, wsBase, close } = fakeMachine()
    try {
      await manager.setRemotePassword(REMOTE_PASSWORD)
      const result = await connectWithPassword({
        targetMachineId: MACHINE_ID,
        password: 'definitely the wrong password',
        selfIdentity: C.newIdentity(),
        accessToken: 'unused',
        backendWsBase: await wsBase,
        autonomousEnv: 'prod',
        timeoutMs: 5_000,
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toBe('WRONG_PASSWORD')
    } finally {
      await close()
    }
  })

  it('locks out after repeated wrong passwords, rejecting further attempts before running any crypto', async () => {
    const { manager, wsBase, close } = fakeMachine()
    try {
      await manager.setRemotePassword(REMOTE_PASSWORD)
      const base = await wsBase
      // Five wrong attempts cross store.ts's PW_FAIL_THRESHOLD (5) and lock the machine out.
      for (let i = 0; i < 5; i++) {
        const attempt = await connectWithPassword({
          targetMachineId: MACHINE_ID,
          password: `wrong-${i}`,
          selfIdentity: C.newIdentity(),
          accessToken: 'unused',
          backendWsBase: base,
          autonomousEnv: 'prod',
          timeoutMs: 5_000,
        })
        expect(attempt.ok).toBe(false)
      }
      // The 6th attempt — even with the CORRECT password — must be rejected as RATE_LIMITED, proving
      // the lockout is checked before any CPace round runs (not just before the final verdict).
      const locked = await connectWithPassword({
        targetMachineId: MACHINE_ID,
        password: REMOTE_PASSWORD,
        selfIdentity: C.newIdentity(),
        accessToken: 'unused',
        backendWsBase: base,
        autonomousEnv: 'prod',
        timeoutMs: 5_000,
      })
      expect(locked.ok).toBe(false)
      expect((locked as { error: string }).error).toBe('RATE_LIMITED')
      expect((locked as { retryAt?: number }).retryAt).toEqual(expect.any(Number))
    } finally {
      await close()
    }
    // One scrypt per wrong-password attempt — see PW_SCRYPT_TEST_TIMEOUT_MS.
  }, PW_SCRYPT_TEST_TIMEOUT_MS)

  it('setting a new password clears an existing lockout', async () => {
    const { manager, wsBase, close } = fakeMachine()
    try {
      await manager.setRemotePassword(REMOTE_PASSWORD)
      const base = await wsBase
      for (let i = 0; i < 5; i++) {
        await connectWithPassword({
          targetMachineId: MACHINE_ID,
          password: `wrong-${i}`,
          selfIdentity: C.newIdentity(),
          accessToken: 'unused',
          backendWsBase: base,
          autonomousEnv: 'prod',
          timeoutMs: 5_000,
        })
      }
      const stillLocked = await connectWithPassword({
        targetMachineId: MACHINE_ID, password: REMOTE_PASSWORD, selfIdentity: C.newIdentity(),
        accessToken: 'unused', backendWsBase: base, autonomousEnv: 'prod', timeoutMs: 5_000,
      })
      expect(stillLocked.ok).toBe(false)
      expect((stillLocked as { error: string }).error).toBe('RATE_LIMITED')

      const NEW_PASSWORD = 'a brand new remote password'
      await manager.setRemotePassword(NEW_PASSWORD)
      const result = await connectWithPassword({
        targetMachineId: MACHINE_ID, password: NEW_PASSWORD, selfIdentity: C.newIdentity(),
        accessToken: 'unused', backendWsBase: base, autonomousEnv: 'prod', timeoutMs: 5_000,
      })
      expect(result.ok).toBe(true)
    } finally {
      await close()
    }
    // One scrypt per wrong-password attempt — see PW_SCRYPT_TEST_TIMEOUT_MS.
  }, PW_SCRYPT_TEST_TIMEOUT_MS)
})

describe('RemoteRelayPool drops a peer the responder no longer trusts', () => {
  // A fake AuthSessionManager — RemoteRelayPool only ever calls .accessToken({force}).
  const fakeAuth = { accessToken: async () => 'unused-in-this-fake' } as unknown as import('../authSession.js').AuthSessionManager

  it('isolates concurrent fleet clients from each other and the desktop connection', async () => {
    const wss = new WebSocketServer({ port: 0 })
    const sockets = new Map<string, import('ws').WebSocket>()
    const manager = new E2eeManagerCtor({
      machineId: MACHINE_ID, isConnected: () => true,
      sendTo: (id, frame) => sockets.get(id)?.send(JSON.stringify(frame)),
    })
    let next = 0
    wss.on('connection', ws => {
      const id = `client-${++next}`; sockets.set(id, ws)
      ws.on('close', () => { sockets.delete(id); manager.dropSession(id) })
      ws.on('message', raw => {
        const frame = JSON.parse(raw.toString())
        if (frame.type === 'machine_select') ws.send(JSON.stringify({ type: 'connected', payload: { machineId: MACHINE_ID } }))
        else if (frame.type.startsWith('e2e_')) manager.handleFrame(id, frame)
        else if (frame.type === 'grid_fleet_run') {
          expect(frame.payload).not.toHaveProperty('args')
          const clear = manager.unwrapDown(id, frame)
          ws.send(JSON.stringify(manager.wrapTarget(id, 'grid_fleet_run_result', clear!.payload as Record<string, unknown>)))
        }
      })
    })
    const base = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`
    const identity = C.newIdentity()
    await manager.setRemotePassword(REMOTE_PASSWORD)
    const claim = await connectWithPassword({ targetMachineId: MACHINE_ID, password: REMOTE_PASSWORD, selfIdentity: identity, accessToken: 'unused', backendWsBase: base, autonomousEnv: 'prod', timeoutMs: 5000 })
    expect(claim.ok).toBe(true)
    if (!claim.ok) throw new Error('pairing failed')
    const peers = new MachinePeerStore(); peers.pin(MACHINE_ID, C.b64e(claim.peerPub), 'test')
    const pool = new RemoteRelayPool(fakeAuth, base, identity, peers)
    const inboxes: Frame[][] = [[], [], []]
    const select = { type: 'machine_select', payload: { machineId: MACHINE_ID } }
    const sink = (i: number) => ({ sendFrame: (f: Frame) => { inboxes[i].push(f); return true }, sendBinary: () => true })
    const desktop = await pool.acquire(MACHINE_ID, 'prod', select, sink(0), () => {})
    const a = await pool.acquireIsolated(MACHINE_ID, 'prod', select, sink(1), () => {})
    const b = await pool.acquireIsolated(MACHINE_ID, 'prod', select, sink(2), () => {})
    try {
      await Promise.all([desktop, a, b].map((s, i) => s.send({ type: 'grid_fleet_run', payload: { requestId: `r-${i}`, args: [`model-${i}`] } })))
      await new Promise(resolve => setTimeout(resolve, 100))
      inboxes.forEach((inbox, i) => expect(inbox.filter(f => f.type === 'grid_fleet_run_result').map(f => f.payload)).toEqual([{ requestId: `r-${i}`, args: [`model-${i}`] }]))
      a.detach()
      await desktop.send({ type: 'grid_fleet_run', payload: { requestId: 'still-connected', args: ['version'] } })
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(inboxes[0].at(-1)?.payload).toMatchObject({ requestId: 'still-connected' })
    } finally {
      a.detach(); b.detach(); pool.invalidate(MACHINE_ID)
      for (const ws of wss.clients) ws.terminate()
      await new Promise<void>(resolve => wss.close(() => resolve()))
    }
  }, PW_SCRYPT_TEST_TIMEOUT_MS)

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
      await manager.setRemotePassword(REMOTE_PASSWORD)
      const claim = await connectWithPassword({
        targetMachineId: MACHINE_ID,
        password: REMOTE_PASSWORD,
        selfIdentity: clientIdentity,
        accessToken: 'unused-in-this-fake',
        backendWsBase: `ws://127.0.0.1:${port}`,
        autonomousEnv: 'prod',
        timeoutMs: 5_000,
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

  it('invalidate() drops a pooled entry so the next acquire() dials fresh, without firing its old onClosed', async () => {
    let selects = 0
    const wss = new WebSocketServer({ port: 0 })
    const manager = new E2eeManagerCtor({
      machineId: MACHINE_ID,
      sendTo: (_connId, frame) => {
        // Unlike the other fixtures in this file, this test leaves a terminated (invalidated) client
        // behind mid-test — only broadcast to sockets still actually open.
        for (const client of wss.clients) {
          if (client.readyState === client.OPEN) client.send(JSON.stringify(frame))
        }
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
            selects++
            ws.send(JSON.stringify({ type: 'connected', payload: { machineId: MACHINE_ID } }))
          }
          return
        }
        const type = frame.type as string
        if (type.startsWith('e2e_')) manager.handleFrame(`fake-conn-${selects}`, frame)
      })
    })

    try {
      const port = (wss.address() as AddressInfo).port
      const clientIdentity = C.newIdentity()
      await manager.setRemotePassword(REMOTE_PASSWORD)
      const claim = await connectWithPassword({
        targetMachineId: MACHINE_ID,
        password: REMOTE_PASSWORD,
        selfIdentity: clientIdentity,
        accessToken: 'unused-in-this-fake',
        backendWsBase: `ws://127.0.0.1:${port}`,
        autonomousEnv: 'prod',
        timeoutMs: 5_000,
      })
      expect(claim.ok).toBe(true)
      if (!claim.ok) return

      const peers = new MachinePeerStore()
      peers.pin(MACHINE_ID, C.b64e(claim.peerPub), 'harness link')
      const pool = new RemoteRelayPool(fakeAuth, `ws://127.0.0.1:${port}`, clientIdentity, peers)

      const staleSink = { sendFrame: () => true, sendBinary: () => true }
      let staleOnClosedFired = false
      await pool.acquire(
        MACHINE_ID,
        'prod',
        { type: 'machine_select', payload: { machineId: MACHINE_ID } },
        staleSink,
        () => { staleOnClosedFired = true },
      )
      expect(selects).toBe(2) // 1 for connectWithPassword's own connection, 1 for the acquire() dial

      pool.invalidate(MACHINE_ID)
      // onClosed is a stand-in for the LOCAL app socket's own close() — invalidate() must never call
      // it, since a real caller invalidates right before reusing that same local connection for a
      // fresh acquire(); firing it here would self-destruct the very connection driving the retry.
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(staleOnClosedFired).toBe(false)

      const freshSink = { sendFrame: () => true, sendBinary: () => true }
      await pool.acquire(
        MACHINE_ID,
        'prod',
        { type: 'machine_select', payload: { machineId: MACHINE_ID } },
        freshSink,
        () => {},
      )
      expect(selects).toBe(3) // invalidate() forced a brand new dial instead of reusing the old entry
      pool.invalidate(MACHINE_ID) // drop the still-open final entry so wss.close() below can settle
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    }
  })
})

describe('RemoteRelayPool closes the upstream socket when the handshake fails', () => {
  // Regression for the leak measured on prod 2026-09-15: a handshake that rejected without closing
  // its socket left an OPEN, unreachable `/api/web-ws` connection behind on every retry — one user
  // reached 175 concurrent sockets on a single backend pod — and each one counted as a "connection"
  // in user_daily_presence. Any rejection path must take the socket down with it.
  const fakeAuth = { accessToken: async () => 'unused-in-this-fake' } as unknown as import('../authSession.js').AuthSessionManager

  /** Dials once against a fake backend and reports how it ended: the acquire() rejection and the close
   *  code the SERVER saw on the socket (-1 = never closed within 2s, i.e. leaked). */
  async function dialAgainst(serverBehaviour: (ws: import('ws').WebSocket) => void): Promise<{ rejection: unknown; closeCode: number }> {
    const wss = new WebSocketServer({ port: 0 })
    let resolveClose!: (code: number) => void
    const serverSawClose = new Promise<number>((resolve) => { resolveClose = resolve })
    wss.on('connection', (ws) => {
      ws.on('close', (code) => resolveClose(code))
      serverBehaviour(ws)
    })
    try {
      const port = (wss.address() as AddressInfo).port
      const peers = new MachinePeerStore()
      peers.pin(MACHINE_ID, C.b64e(C.newIdentity().pub), 'harness link')
      const pool = new RemoteRelayPool(fakeAuth, `ws://127.0.0.1:${port}`, C.newIdentity(), peers)
      const sink = { sendFrame: () => true, sendBinary: () => true }
      let rejection: unknown = null
      try {
        await pool.acquire(MACHINE_ID, 'prod', { type: 'machine_select', payload: { machineId: MACHINE_ID } }, sink, () => {})
      } catch (err) { rejection = err }
      // Bounded wait: if the socket is leaked this never resolves, and the test must fail, not hang.
      const closeCode = await Promise.race([
        serverSawClose,
        new Promise<number>((resolve) => setTimeout(() => resolve(-1), 2_000)),
      ])
      return { rejection, closeCode }
    } finally {
      // A leaked client would otherwise keep wss.close() waiting until the test timeout — kill it so a
      // regression fails on the closeCode assertion instead.
      for (const client of wss.clients) client.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    }
  }

  it('machine_select_error rejects AND closes the socket', async () => {
    const { rejection, closeCode } = await dialAgainst((ws) => {
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString()) as Frame
        if (frame.type === 'machine_select') {
          ws.send(JSON.stringify({ type: 'machine_select_error', payload: { machineId: MACHINE_ID, error: 'NOT_YOUR_MACHINE' } }))
        }
      })
    })
    expect(rejection).toBeInstanceOf(Error)
    expect((rejection as Error).message).toBe('NOT_YOUR_MACHINE')
    expect(closeCode).toBe(1000)
  })

  it('an invalid e2e_welcome rejects AND closes the socket', async () => {
    // Stands in for the timeout path (peer never answers e2e_hello): same catch block, but without
    // waiting out CONNECT_TIMEOUT_MS. The select is acked so this socket is already bound to the
    // machine on the backend side — exactly the shape of the leaked sockets seen in prod.
    const { rejection, closeCode } = await dialAgainst((ws) => {
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString()) as Frame
        if (frame.type === 'machine_select') {
          ws.send(JSON.stringify({ type: 'connected', payload: { machineId: MACHINE_ID } }))
        } else if (frame.type === 'e2e_hello') {
          ws.send(JSON.stringify({ type: 'e2e_welcome', payload: { garbage: true } }))
        }
      })
    })
    expect((rejection as Error).message).toBe('E2EE_WELCOME_INVALID')
    expect(closeCode).toBe(1000)
  })
})
