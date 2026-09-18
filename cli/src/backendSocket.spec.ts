import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { BackendSocket, compactRuntimePickerModels, deviceAgentListItem, deviceAgentRow, grokHistoryPage } from './backendSocket.js'
import { AuthSessionError, type AuthSessionManager } from './lib/authSession.js'
import { WS_IDLE_DEADLINE_MS as IDLE_DEADLINE_MS } from './lib/wsLiveness.js'
import type { TerminalStreamManager } from './lib/terminalStreamManager.js'
import { decodeTerminalLocal, TerminalBinaryKind } from './lib/terminalBinary.js'
import { registry, type RegisteredSession } from './lib/registry.js'
import * as mediaPreview from './lib/mediaPreview.js'
import * as projectFolder from './lib/projectFolder.js'
import * as projectPreview from './lib/projectPreview.js'
import * as storeCatalog from './dsh/catalog.js'
import { randomUUID } from 'node:crypto'
import { fakeGridAnswers, installFakeGrid, type FakeGrid } from './lib/__fixtures__/fakeGrid.js'
import { clearGridMcpUrlCache } from './lib/gridMcpUrl.js'

describe('viewer forwarding authentication', () => {
  it('requires encryption and a web-role session remotely, while permitting trusted local clients', async () => {
    const socket = new BackendSocket('token')
    const internals = socket as any
    const handle = vi.spyOn(socket.viewerForwarder, 'handle').mockImplementation(() => {})
    const role = vi.spyOn(internals.e2ee, 'sessionRole').mockReturnValue('web')
    const frame = { type: 'viewer_request', payload: { streamId: 'v', agentId: 'a' } }
    const unwrap = vi.spyOn(internals.e2ee, 'unwrapDown').mockReturnValue(frame)
    await internals.dispatchDown(frame, 'remote')
    expect(unwrap).not.toHaveBeenCalled()
    expect(handle).not.toHaveBeenCalled()
    const encrypted = { type: 'viewer_request', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'fixture' } } }
    role.mockReturnValue('device')
    await internals.dispatchDown(encrypted, 'remote')
    expect(handle).not.toHaveBeenCalled()
    role.mockReturnValue('web')
    await internals.dispatchDown(encrypted, 'remote')
    expect(handle).toHaveBeenCalledWith('remote', 'viewer_request', frame.payload)
    socket.registerLocalClient('local:viewer', { sendFrame: () => true, sendBinary: () => true })
    await internals.dispatchDown(frame, 'local:viewer')
    expect(handle).toHaveBeenCalledWith('local:viewer', 'viewer_request', frame.payload)
    handle.mockClear()
    await internals.dispatchDown({ type: 'viewer_arbitrary', payload: {} }, 'local:viewer')
    expect(handle).not.toHaveBeenCalled()
    await socket.unregisterLocalClient('local:viewer')
    await socket.stop()
  })
})

const wsMock = vi.hoisted(() => {
  const instances: MockWebSocket[] = []

  class MockWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSED = 3
    readyState = MockWebSocket.CONNECTING
    sent: string[] = []
    failNextSend: Error | null = null
    /** Peer stopped answering pings (a half-open TCP link, a laptop coming back from sleep). */
    silent = false
    pings = 0
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>()

    constructor(readonly url: string, readonly protocols: string[], readonly options?: { handshakeTimeout?: number }) {
      instances.push(this)
    }

    on(event: string, cb: (...args: unknown[]) => void): this {
      const list = this.handlers.get(event) ?? []
      list.push(cb)
      this.handlers.set(event, list)
      return this
    }

    once(event: string, cb: (...args: unknown[]) => void): this {
      const wrapped = (...args: unknown[]): void => {
        const list = this.handlers.get(event) ?? []
        this.handlers.set(event, list.filter((fn) => fn !== wrapped))
        cb(...args)
      }
      return this.on(event, wrapped)
    }

    private emit(event: string, ...args: unknown[]): void {
      for (const cb of this.handlers.get(event) ?? []) cb(...args)
    }

    open(): void {
      this.readyState = MockWebSocket.OPEN
      this.emit('open')
    }

    message(value: unknown): void {
      this.emit('message', Buffer.from(JSON.stringify(value)))
    }

    send(data: string, cb?: (err?: Error) => void): void {
      if (this.failNextSend) {
        const err = this.failNextSend
        this.failNextSend = null
        cb?.(err)
        return
      }
      this.sent.push(data)
      cb?.()
    }

    close(): void {
      this.readyState = MockWebSocket.CLOSED
      this.emit('close', 1006)
    }

    /** What `ws` does when `handshakeTimeout` elapses: abort the upgrade, then report the socket gone. */
    handshakeTimeout(): void {
      this.emit('error', new Error('Opening handshake has timed out'))
      this.close()
    }

    /** What `ws` does when the upgrade is answered with an HTTP status: 'error', then 'close'. */
    refused(status: number): void {
      this.emit('error', new Error(`Unexpected server response: ${status}`))
      this.close()
    }

    terminate(): void {
      this.close()
    }

    ping(): void {
      this.pings++
      if (!this.silent) this.emit('pong')
    }

    /** The backend's own liveness ping (every 25s from `trackSocketLiveness`). */
    peerPing(): void {
      this.emit('ping')
    }
  }

  return { instances, MockWebSocket }
})

vi.mock('ws', () => ({ WebSocket: wsMock.MockWebSocket }))

function parseSent(ws: InstanceType<typeof wsMock.MockWebSocket>): Array<Record<string, unknown>> {
  return ws.sent.map((s) => JSON.parse(s) as Record<string, unknown>)
}

describe('BackendSocket outbound queue', () => {
  afterEach(() => {
    wsMock.instances.length = 0
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('queues web and device frames before open and flushes them in FIFO order', async () => {
    const socket = new BackendSocket('token')
    socket.connect()
    const ws = wsMock.instances[0]

    socket.send({ type: 'turn_summary_pending', dbSessionId: 's1', payload: { sessionId: 's1' } })
    socket.sendCommander({ type: 'commander_event', agentId: 's1', dbSessionId: 's1', payload: { kind: 'done', text: 'done' } })
    expect(ws.sent).toHaveLength(0)

    ws.open()
    const sent = parseSent(ws)
    expect(sent).toHaveLength(2)
    expect((sent[0].frame as { type?: string }).type).toBe('turn_summary_pending')
    expect((sent[1].frame as { type?: string }).type).toBe('commander_event')
    expect(sent[1]).toMatchObject({ webEligible: false, commanderEligible: true })

    await socket.stop()
  })

  it('bounds the opening handshake and reconnects when it times out', async () => {
    // A connect attempt whose TCP side came up but whose upgrade was never answered used to sit in
    // CONNECTING forever: no 'open', so no heartbeat to terminate it, and `this.ws` set, so every
    // later connect() returned early. The daemon then showed "cloud reconnecting…" until restarted.
    vi.useFakeTimers()
    const socket = new BackendSocket('token')
    socket.connect()
    const ws1 = wsMock.instances[0]
    expect(ws1.options?.handshakeTimeout).toBe(15_000)
    expect(ws1.readyState).toBe(wsMock.MockWebSocket.CONNECTING)

    // Still connecting: a second connect() must not open a competing socket …
    socket.connect()
    expect(wsMock.instances).toHaveLength(1)

    // … but once the handshake is abandoned, the ordinary backoff schedules a fresh attempt.
    ws1.handshakeTimeout()
    expect(socket.isConnected()).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(wsMock.instances).toHaveLength(2)
    const ws2 = wsMock.instances[1]
    expect(ws2.options?.handshakeTimeout).toBe(15_000)
    ws2.open()
    expect(socket.isConnected()).toBe(true)

    await socket.stop()
  })

  it('gives a silent peer the whole deadline, not one missed pong, before terminating', async () => {
    // The old heartbeat killed the link the first time a ping went unanswered (20–40s), which is
    // what every macOS DarkWake looked like from inside the daemon: the pre-sleep ping's pong never
    // came, so the first tick after wake terminated a link that was about to work again.
    vi.useFakeTimers()
    const socket = new BackendSocket('token')
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    ws.silent = true

    await vi.advanceTimersByTimeAsync(IDLE_DEADLINE_MS - 1_000)
    expect(socket.isConnected()).toBe(true)
    expect(ws.pings).toBeGreaterThanOrEqual(2) // it kept asking the whole time
    expect(wsMock.instances).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(20_000)
    expect(socket.isConnected()).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(wsMock.instances).toHaveLength(2) // and re-entered the ordinary backoff

    await socket.stop()
  })

  it('counts data and the backend\'s own pings as proof of life, not only pongs', async () => {
    // A backend busy streaming data can answer a control-frame ping late; the data itself is the
    // stronger proof, and the backend pings this socket every 25s on its own.
    vi.useFakeTimers()
    const socket = new BackendSocket('token')
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    ws.silent = true

    await vi.advanceTimersByTimeAsync(40_000)
    ws.message({ t: 'down', connId: 'c1', frame: { type: 'noop' } })
    await vi.advanceTimersByTimeAsync(40_000) // 80s in, 40s since the last frame
    expect(socket.isConnected()).toBe(true)
    ws.peerPing()
    await vi.advanceTimersByTimeAsync(40_000)
    expect(socket.isConnected()).toBe(true)
    await vi.advanceTimersByTimeAsync(IDLE_DEADLINE_MS)
    expect(socket.isConnected()).toBe(false)

    await socket.stop()
  })

  describe('a 401 on the upgrade', () => {
    // A stub in the shape the socket needs: the first token is what the backend refuses, and the
    // refresh answers with whatever the case under test says.
    function authStub(refresh: () => Promise<string>): { auth: AuthSessionManager; calls: Array<{ force?: boolean; failedToken?: string }> } {
      const calls: Array<{ force?: boolean; failedToken?: string }> = []
      let current = 'stale-token'
      const auth = {
        accessToken: async (opts: { force?: boolean; failedToken?: string } = {}) => {
          if (opts.force) { calls.push(opts); current = await refresh() }
          return current
        },
      } as unknown as AuthSessionManager
      return { auth, calls }
    }

    it('refreshes the token, reports the link down meanwhile, and reconnects with the new token', async () => {
      vi.useFakeTimers()
      const statuses: boolean[] = []
      const { auth, calls } = authStub(async () => 'fresh-token')
      const socket = new BackendSocket('0123456789abcdef0123456789abcdef', auth, (connected) => statuses.push(connected))
      const revoked = vi.fn()
      socket.onRevoked = revoked
      socket.connect()
      await vi.advanceTimersByTimeAsync(0)
      const ws1 = wsMock.instances[0]
      expect(ws1.protocols).toEqual(['stale-token'])
      ws1.open()

      ws1.refused(401)
      await vi.advanceTimersByTimeAsync(0)
      // The socket is gone the ordinary way: status says so, no session was wiped.
      expect(statuses).toEqual([true, false])
      expect(calls).toEqual([{ force: true, failedToken: 'stale-token' }])
      expect(revoked).not.toHaveBeenCalled()
      // And the refresh, not a backoff timer, opened the next socket — with the new token.
      expect(wsMock.instances).toHaveLength(2)
      expect(wsMock.instances[1].protocols).toEqual(['fresh-token'])
      await vi.advanceTimersByTimeAsync(60_000)
      expect(wsMock.instances).toHaveLength(2) // no second dial racing the first
      await socket.stop()
    })

    it('keeps the session and backs off when the refresh merely fails', async () => {
      vi.useFakeTimers()
      const { auth } = authStub(async () => { throw new AuthSessionError('service unavailable', 'UNAVAILABLE') })
      const socket = new BackendSocket('0123456789abcdef0123456789abcdef', auth)
      const revoked = vi.fn()
      socket.onRevoked = revoked
      socket.connect()
      await vi.advanceTimersByTimeAsync(0)
      wsMock.instances[0].open()
      wsMock.instances[0].refused(401)
      await vi.advanceTimersByTimeAsync(0)
      expect(revoked).not.toHaveBeenCalled()
      expect(wsMock.instances).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(wsMock.instances).toHaveLength(2) // the ordinary backoff, session intact
      await socket.stop()
    })

    it('signs out only when the refresh token itself is rejected', async () => {
      vi.useFakeTimers()
      const { auth } = authStub(async () => { throw new AuthSessionError('refresh token is invalid', 'INVALID_REFRESH') })
      const socket = new BackendSocket('0123456789abcdef0123456789abcdef', auth)
      const revoked = vi.fn()
      socket.onRevoked = revoked
      socket.connect()
      await vi.advanceTimersByTimeAsync(0)
      wsMock.instances[0].open()
      wsMock.instances[0].refused(401)
      await vi.advanceTimersByTimeAsync(0)
      expect(revoked).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(wsMock.instances).toHaveLength(1)
      await socket.stop()
    })
  })

  it('keeps a frame queued when ws.send reports an error and retries after reconnect', async () => {
    vi.useFakeTimers()
    const socket = new BackendSocket('token')
    socket.connect()
    const ws1 = wsMock.instances[0]
    ws1.open()
    ws1.failNextSend = new Error('boom')

    socket.sendTo('conn-1', { type: 'e2e_rekey', payload: { n: 1 } })
    expect(ws1.sent).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1_000)
    const ws2 = wsMock.instances[1]
    ws2.open()
    const sent = parseSent(ws2)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ t: 'up', targetConnId: 'conn-1' })

    await socket.stop()
  })

  it('routes e2e control frames to the handshake manager instead of the RPC fallback', async () => {
    const socket = new BackendSocket('token')
    const handle = vi.spyOn(socket.e2ee, 'handleFrame').mockReturnValue(true)
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()

    const frame = {
      type: 'e2e_setup_claim',
      payload: { requestId: 'setup-1', token: 'signed-setup-token' },
    }
    ws.message({ t: 'down', connId: 'web-1', frame })

    await vi.waitFor(() => expect(handle).toHaveBeenCalledWith('web-1', frame))
    expect(parseSent(ws).some((item) =>
      (item.frame as { type?: string } | undefined)?.type === 'e2e_setup_claim_result',
    )).toBe(false)
    await socket.stop()
  })

  it('serves the opaque runtime catalog through the existing models_list RPC', async () => {
    const socket = new BackendSocket('token')
    socket.runtimeModelsProvider = async () => [
      { id: 'runtime-v1:s1:codex:gpt-5.6-sol@high', displayName: 'GPT-5.6 Sol / High' },
    ]
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    vi.spyOn(socket.e2ee, 'unwrapDown').mockReturnValue({
      type: 'models_list', payload: { requestId: 'models-1' },
    })
    vi.spyOn(socket.e2ee, 'hasSession').mockReturnValue(true)
    const wrapReply = vi.spyOn(socket.e2ee, 'wrapRpcReply').mockReturnValue({
      type: 'models_list_result', payload: { __e2e: { v: 1, k: 's', n: 1, ct: 'ciphertext' } },
    })
    ws.message({
      t: 'down',
      connId: 'web-1',
      frame: { type: 'models_list', payload: { __e2e: { v: 1, k: 's', n: 1, ct: 'ciphertext' } } },
    })

    await vi.waitFor(() => {
      const result = parseSent(ws).find((item) => (item.frame as { type?: string })?.type === 'models_list_result')
      expect(result).toMatchObject({
        targetConnId: 'web-1',
        frame: { payload: { __e2e: { ct: 'ciphertext' } } },
      })
    })
    expect(wrapReply).toHaveBeenCalledWith('web-1', 'models_list_result', 'models-1', {
      models: [{ id: 'runtime-v1:s1:codex:gpt-5.6-sol@high', displayName: 'GPT-5.6 Sol / High' }],
    })
    await socket.stop()
  })

  it('hands theme_set to the host-theme sink and acknowledges it to the requester', async () => {
    const socket = new BackendSocket('token')
    const received: unknown[] = []
    socket.hostThemeSink = (theme) => received.push(theme)
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    const unwrap = vi.spyOn(socket.e2ee, 'unwrapDown')
    vi.spyOn(socket.e2ee, 'hasSession').mockReturnValue(true)
    const wrapReply = vi.spyOn(socket.e2ee, 'wrapRpcReply').mockReturnValue({
      type: 'theme_set_result', payload: { __e2e: { v: 1, k: 's', n: 1, ct: 'ciphertext' } },
    })
    const envelope = { __e2e: { v: 1, k: 's', n: 1, ct: 'ciphertext' } }

    unwrap.mockReturnValueOnce({
      type: 'theme_set', payload: { requestId: 't-1', background: '#171B29', foreground: '#f5f5f5' },
    })
    ws.message({ t: 'down', connId: 'web-1', frame: { type: 'theme_set', payload: envelope } })
    await vi.waitFor(() => {
      expect(wrapReply).toHaveBeenCalledWith('web-1', 'theme_set_result', 't-1', { applied: true })
    })
    // Normalised to lowercase, and a full pair — never half a style.
    expect(received).toEqual([{ background: '#171b29', foreground: '#f5f5f5' }])

    // A malformed colour is refused, not half-applied.
    unwrap.mockReturnValueOnce({ type: 'theme_set', payload: { requestId: 't-2', background: 'dark' } })
    ws.message({ t: 'down', connId: 'web-1', frame: { type: 'theme_set', payload: envelope } })
    await vi.waitFor(() => {
      expect(wrapReply).toHaveBeenCalledWith('web-1', 'theme_set_result', 't-2', { error: 'BAD_THEME' })
    })
    expect(received).toHaveLength(1)
    await socket.stop()
  })

  it('answers usage_read with this machine\'s own readings, wrapped for the requester', async () => {
    // What goes back names what the person spends and on whose account, so it must leave encrypted.
    // The reader is the socket's own field: this never touches a real home, Keychain or network.
    const socket = new BackendSocket('token')
    const readings = [
      {
        provider: 'claude' as const,
        account: 'k1',
        outcome: 'answered' as const,
        httpStatus: 200,
        body: { seven_day: { utilization: 42 } },
      },
    ]
    socket.accountUsageReader = async () => readings
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    vi.spyOn(socket.e2ee, 'unwrapDown').mockReturnValue({
      type: 'usage_read', payload: { requestId: 'usage-1' },
    })
    vi.spyOn(socket.e2ee, 'hasSession').mockReturnValue(true)
    const wrapReply = vi.spyOn(socket.e2ee, 'wrapRpcReply').mockReturnValue({
      type: 'usage_read_result', payload: { __e2e: { v: 1, k: 's', n: 1, ct: 'ciphertext' } },
    })
    ws.message({
      t: 'down',
      connId: 'web-1',
      frame: { type: 'usage_read', payload: { __e2e: { v: 1, k: 's', n: 1, ct: 'ciphertext' } } },
    })

    await vi.waitFor(() => {
      expect(wrapReply).toHaveBeenCalledWith('web-1', 'usage_read_result', 'usage-1', { providers: readings })
    })
    await socket.stop()
  })

  it('returns project previews only to the requesting encrypted connection', async () => {
    vi.spyOn(registry, 'list').mockReturnValue([{ cwd: '/remote/workspace' }] as RegisteredSession[])
    const preview = { path: '/remote/workspace', readme: 'Private project README', branch: 'main', files: ['README.md'], contributors: [] }
    const read = vi.spyOn(projectPreview, 'projectPreview').mockResolvedValue(preview)
    const socket = new BackendSocket('token')
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    vi.spyOn(socket.e2ee, 'unwrapDown').mockReturnValue({ type: 'project_preview', payload: {
      requestId: 'preview-1', path: '/remote/workspace',
    } })
    vi.spyOn(socket.e2ee, 'hasSession').mockReturnValue(true)
    const wrap = vi.spyOn(socket.e2ee, 'wrapRpcReply').mockReturnValue({
      type: 'project_preview_result', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'encrypted-preview' } },
    })
    ws.message({ t: 'down', connId: 'viewer-a', frame: {
      type: 'project_preview', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'encrypted-request' } },
    } })
    await vi.waitFor(() => expect(wrap).toHaveBeenCalledWith('viewer-a', 'project_preview_result', 'preview-1', preview))
    expect(read).toHaveBeenCalledWith('/remote/workspace', ['/remote/workspace'])
    expect(parseSent(ws)).toContainEqual(expect.objectContaining({ targetConnId: 'viewer-a', frame: {
      type: 'project_preview_result', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'encrypted-preview' } },
    } }))
    expect(JSON.stringify(parseSent(ws))).not.toContain('Private project README')
    await socket.stop()
  })

  it('serves media only to the requesting encrypted connection', async () => {
    vi.spyOn(registry, 'resolve').mockReturnValue({ cwd: '/remote/workspace' } as RegisteredSession)
    const media = { media: true as const, filename: 'preview.png', offset: 0, totalBytes: 3,
      revision: 'a'.repeat(64), contentBase64: 'AQID' }
    const read = vi.spyOn(mediaPreview, 'readMediaPreviewChunk').mockResolvedValue(media)
    const socket = new BackendSocket('token')
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    vi.spyOn(socket.e2ee, 'unwrapDown').mockReturnValue({ type: 'agent_read_file', payload: {
      requestId: 'media-1', agentId: 'agent-b', path: '/tmp/preview.png', media: true, offset: 0,
    } })
    vi.spyOn(socket.e2ee, 'hasSession').mockReturnValue(true)
    const wrap = vi.spyOn(socket.e2ee, 'wrapRpcReply').mockReturnValue({
      type: 'agent_read_file_result', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'encrypted-media' } },
    })
    ws.message({ t: 'down', connId: 'viewer-a', frame: {
      type: 'agent_read_file', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'encrypted-request' } },
    } })
    await vi.waitFor(() => expect(wrap).toHaveBeenCalledWith('viewer-a', 'agent_read_file_result', 'media-1', media))
    expect(read).toHaveBeenCalledWith('/remote/workspace', '/tmp/preview.png', 0, undefined)
    const sent = parseSent(ws)
    expect(sent).toContainEqual(expect.objectContaining({ targetConnId: 'viewer-a', frame: {
      type: 'agent_read_file_result', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'encrypted-media' } },
    } }))
    expect(JSON.stringify(sent)).not.toContain('AQID')
    await socket.stop()
  })

  it('refuses a plaintext media request before reading any file', async () => {
    const read = vi.spyOn(mediaPreview, 'readMediaPreviewChunk')
    const socket = new BackendSocket('token')
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    ws.message({ t: 'down', connId: 'unpaired-viewer', frame: {
      type: 'agent_read_file', payload: { requestId: 'media-unsafe', agentId: 'agent-b', path: '/tmp/preview.png', media: true, offset: 0 },
    } })
    await vi.waitFor(() => expect(parseSent(ws)).toContainEqual(expect.objectContaining({
      targetConnId: 'unpaired-viewer', frame: expect.objectContaining({ payload: { requestId: 'media-unsafe', error: 'E2EE_REQUIRED' } }),
    })))
    expect(read).not.toHaveBeenCalled()
    await socket.stop()
  })

  it('includes engine session correlation in the web agent list', async () => {
    const session: RegisteredSession = {
      schemaVersion: 2,
      active: true,
      agentId: 'agent-1',
      sessionId: 'session-1',
      boundAt: 1,
      engine: 'codex',
      transcriptPath: null,
      projectDir: 'workspace',
      cwd: '/tmp/workspace',
      runtimes: [],
      primaryRuntimeKey: '',
      tmuxPane: '',
      source: null,
      title: 'Agent one',
      model: null,
      cliVersion: null,
      processIdentity: null,
      registeredAt: 1,
      updatedAt: 1,
      lastHookAt: 1,
      lastTranscriptAt: 1,
    }
    vi.spyOn(registry, 'advertised').mockReturnValue([session])
    vi.spyOn(registry, 'terminalAvailable').mockReturnValue(true)
    const socket = new BackendSocket('token')
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    vi.spyOn(socket.e2ee, 'unwrapDown').mockReturnValue({
      type: 'agents_list', payload: { requestId: 'agents-1' },
    })
    vi.spyOn(socket.e2ee, 'hasSession').mockReturnValue(true)
    const wrapReply = vi.spyOn(socket.e2ee, 'wrapRpcReply').mockReturnValue({
      type: 'agents_list_result', payload: { __e2e: { v: 1, k: 's', n: 1, ct: 'ciphertext' } },
    })
    ws.message({
      t: 'down',
      connId: 'web-1',
      frame: { type: 'agents_list', payload: { __e2e: { v: 1, k: 's', n: 1, ct: 'ciphertext' } } },
    })

    await vi.waitFor(() => {
      expect(wrapReply).toHaveBeenCalledWith('web-1', 'agents_list_result', 'agents-1', {
        agents: [expect.objectContaining({
          id: 'agent-1', sessionId: 'session-1', engine: 'codex',
          terminal: expect.objectContaining({ available: true }),
        })],
      })
    })
    await socket.stop()
  })

  it('filters and compacts the runtime catalog for a device agent', async () => {
    const socket = new BackendSocket('token')
    const provider = vi.fn(async (_sessionId?: string) => [
      { id: 'runtime-v1:s1:codex:gpt-5.6-sol@high', displayName: 'GPT-5.6 Sol / High' },
      { id: 'runtime-v1:s1:codex:gpt-5.6-sol@auto', displayName: 'GPT-5.6 Sol / Auto' },
      { id: 'runtime-v1:s1:codex:o3@medium', displayName: 'o3 / Medium' },
      { id: 'runtime-v1:s1:codex:o3@auto', displayName: 'o3 / Auto' },
    ])
    socket.runtimeModelsProvider = provider
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    vi.spyOn(socket.e2ee, 'unwrapDown').mockReturnValue({
      type: 'models_list',
      payload: {
        requestId: 'models-compact',
        agentId: 's1',
        compact: true,
        pickerMode: 'model',
        selectedModel: 'runtime-v1:s1:codex:gpt-5.6-sol@high',
      },
    })
    vi.spyOn(socket.e2ee, 'hasSession').mockReturnValue(true)
    const wrapReply = vi.spyOn(socket.e2ee, 'wrapRpcReply').mockReturnValue({
      type: 'models_list_result', payload: { __e2e: { v: 1, k: 's', n: 1, ct: 'ciphertext' } },
    })
    ws.message({
      t: 'down',
      connId: 'device-1',
      frame: { type: 'models_list', payload: { __e2e: { v: 1, k: 's', n: 1, ct: 'ciphertext' } } },
    })

    await vi.waitFor(() => {
      expect(wrapReply).toHaveBeenCalledWith('device-1', 'models_list_result', 'models-compact', {
        models: [
          { id: 'runtime-v1:s1:codex:gpt-5.6-sol@high' },
          { id: 'runtime-v1:s1:codex:o3@auto' },
        ],
      })
    })
    expect(provider).toHaveBeenCalledWith('s1')
    await socket.stop()
  })

  it('fails a plaintext runtime catalog request closed before reading local data', async () => {
    const socket = new BackendSocket('token')
    const provider = vi.fn(async () => [
      { id: 'runtime-v1:s1:codex:gpt-5.6-sol@high', displayName: 'sensitive' },
    ])
    socket.runtimeModelsProvider = provider
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    ws.message({
      t: 'down', connId: 'unpaired-web',
      frame: { type: 'models_list', payload: { requestId: 'plaintext-models' } },
    })

    await vi.waitFor(() => {
      const result = parseSent(ws).find((item) => (item.frame as { type?: string })?.type === 'models_list_result')
      expect(result).toMatchObject({
        targetConnId: 'unpaired-web',
        frame: { payload: { requestId: 'plaintext-models', error: 'E2EE_REQUIRED' } },
      })
    })
    expect(provider).not.toHaveBeenCalled()
    await socket.stop()
  })

  it('serves authenticated local RPCs in cleartext without weakening cloud E2EE', async () => {
    const socket = new BackendSocket('token')
    socket.runtimeModelsProvider = async () => [
      { id: 'runtime-v1:s1:codex:gpt-5.6-sol@high', displayName: 'Sol / High' },
    ]
    const frames: Array<Record<string, unknown>> = []
    expect(socket.registerLocalClient('local:test', {
      sendFrame: (frame) => { frames.push(frame); return true },
      sendBinary: () => true,
    })).toBe(true)

    socket.handleLocalFrame('local:test', {
      type: 'models_list', payload: { requestId: 'harness-computes' },
    })
    await vi.waitFor(() => expect(frames).toContainEqual({
      type: 'models_list_result',
      payload: {
        requestId: 'harness-computes',
        models: [{ id: 'runtime-v1:s1:codex:gpt-5.6-sol@high', displayName: 'Sol / High' }],
      },
    }))

    await socket.unregisterLocalClient('local:test')
    await socket.stop()
  })

  it('dsh_remove uninstalls through the daemon and refuses a malformed id', async () => {
    const socket = new BackendSocket('token')
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:store', { sendFrame: (frame) => { frames.push(frame); return true }, sendBinary: () => true })
    const removed: string[] = []
    socket.onDshRemove = (id) => { removed.push(id); return id === 'autonomous/marp' ? { ok: true } : { ok: false, error: 'NOT_INSTALLED', detail: `${id} is not installed` } }

    socket.handleLocalFrame('local:store', { type: 'dsh_remove', payload: { requestId: 'rm-1', id: 'autonomous/marp' } })
    socket.handleLocalFrame('local:store', { type: 'dsh_remove', payload: { requestId: 'rm-2', id: 'autonomous/none' } })
    socket.handleLocalFrame('local:store', { type: 'dsh_remove', payload: { requestId: 'rm-3', id: '../../etc' } })

    await vi.waitFor(() => expect(frames.filter((f) => f.type === 'dsh_remove_result')).toHaveLength(3))
    const results = frames.filter((f) => f.type === 'dsh_remove_result').map((f) => f.payload as Record<string, unknown>)
    expect(results).toEqual([
      expect.objectContaining({ requestId: 'rm-1', ok: true, id: 'autonomous/marp' }),
      expect.objectContaining({ requestId: 'rm-2', error: 'NOT_INSTALLED' }),
      expect.objectContaining({ requestId: 'rm-3', error: 'INVALID_DSH' }),
    ])
    expect(removed).toEqual(['autonomous/marp', 'autonomous/none'])
    await socket.unregisterLocalClient('local:store')
    await socket.stop()
  })

  it('serves live catalog entries without making unrelated RPCs wait for catalog I/O', async () => {
    let finish!: (entries: Awaited<ReturnType<typeof storeCatalog.refreshDshRegistry>>) => void
    vi.spyOn(storeCatalog, 'refreshDshRegistry').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const socket = new BackendSocket('token')
    socket.runtimeModelsProvider = async () => []
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:catalog', { sendFrame: frame => { frames.push(frame); return true }, sendBinary: () => true })
    socket.handleLocalFrame('local:catalog', { type: 'dsh_list', payload: { requestId: 'catalog' } })
    socket.handleLocalFrame('local:catalog', { type: 'models_list', payload: { requestId: 'models' } })
    await vi.waitFor(() => expect(frames.some(frame => frame.type === 'models_list_result')).toBe(true))
    expect(frames.some(frame => frame.type === 'dsh_list_result')).toBe(false)
    finish([{ id: 'acme/published-today', name: 'Published today', engine: 'claude', repo: 'https://example.test/project', tier: 2, viewerUse: 'acme/viewer' }])
    await vi.waitFor(() => expect(frames).toContainEqual({
      type: 'dsh_list_result', payload: { requestId: 'catalog', dsh: [expect.objectContaining({ id: 'acme/published-today', installed: false, viewerUse: 'acme/viewer' })] },
    }))
    await socket.unregisterLocalClient('local:catalog')
    await socket.stop()
  })

  it('does not let a slow engines_probe block agent_create on the same connection', async () => {
    const socket = new BackendSocket('token')
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:create', {
      sendFrame: (frame) => { frames.push(frame); return true },
      sendBinary: () => true,
    })
    let finishProbe!: () => void
    socket.engineProbeProvider = () => new Promise((resolve) => { finishProbe = () => resolve([]) })
    const pending: RegisteredSession = {
      schemaVersion: 2, active: true, launch: { state: 'starting' },
      agentId: 'pending-1', sessionId: '', boundAt: null, engine: 'claude',
      transcriptPath: null, projectDir: 'work', cwd: '/tmp/work',
      runtimes: [{ backend: 'tmux', paneId: '%9' }], primaryRuntimeKey: 'tmux/%9', tmuxPane: '%9',
      source: null, title: null, model: null, cliVersion: null, processIdentity: null,
      registeredAt: 1, updatedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
    }
    socket.onCreateAgent = async () => ({ ok: true, session: pending })

    socket.handleLocalFrame('local:create', {
      type: 'engines_probe', payload: { requestId: 'probe-1', engines: ['claude'] },
    })
    socket.handleLocalFrame('local:create', {
      type: 'agent_create', payload: { requestId: 'create-1', engine: 'claude', cwd: '/tmp/work' },
    })

    await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({
      type: 'agent_create_result', payload: expect.objectContaining({ requestId: 'create-1' }),
    })))
    expect(frames.some((frame) => frame.type === 'engines_probe_result')).toBe(false)
    finishProbe()
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'engines_probe_result')).toBe(true))
    await socket.unregisterLocalClient('local:create')
    await socket.stop()
  })

  it('creates with approvals bypassed unless the client turns that off', async () => {
    const socket = new BackendSocket('token')
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:bypass', {
      sendFrame: (frame) => { frames.push(frame); return true }, sendBinary: () => true,
    })
    const pending = (agentId: string): RegisteredSession => ({
      schemaVersion: 2, active: true, launch: { state: 'starting' },
      agentId, sessionId: '', boundAt: null, engine: 'claude',
      transcriptPath: null, projectDir: 'work', cwd: '/tmp/work',
      runtimes: [{ backend: 'tmux', paneId: '%9' }], primaryRuntimeKey: 'tmux/%9', tmuxPane: '%9',
      source: null, title: null, model: null, cliVersion: null, processIdentity: null,
      registeredAt: 1, updatedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
    })
    const create = vi.fn(async (input: { bypassPermission: boolean; permissionMode: string | null }) => ({ ok: true as const, session: pending(`b-${create.mock.calls.length}`) }))
    socket.onCreateAgent = create
    const ask = (requestId: string, extra: Record<string, unknown>) => socket.handleLocalFrame('local:bypass', {
      type: 'agent_create', payload: { requestId, engine: 'claude', cwd: '/tmp/work', ...extra },
    })
    try {
      ask('unsaid', {})
      ask('on', { bypassPermission: true })
      ask('off', { bypassPermission: false })
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(3))
      expect(create.mock.calls.map(([input]) => input.bypassPermission)).toEqual([true, true, false])

      // A mode decides, whatever bypassPermission says; one the engine lacks is refused.
      ask('plan', { permissionMode: 'plan', bypassPermission: true })
      ask('full', { permissionMode: 'full', bypassPermission: false })
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(5))
      expect(create.mock.calls.slice(3).map(([input]) => [input.permissionMode, input.bypassPermission]))
        .toEqual([['plan', false], ['full', true]])
      ask('bogus', { permissionMode: 'readOnly' })
      ask('shape', { permissionMode: 7 })
      await vi.waitFor(() => expect(frames.filter((frame) => (frame.payload as { error?: string } | undefined)?.error === 'INVALID_PERMISSION_MODE')).toHaveLength(2))
      expect(create).toHaveBeenCalledTimes(5)
    } finally {
      await socket.unregisterLocalClient('local:bypass')
      await socket.stop()
    }
  })

  it('creates a terminal with no folder at home, and refuses it a grid or a project to prepare', async () => {
    const socket = new BackendSocket('token')
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:terminal', {
      sendFrame: (frame) => { frames.push(frame); return true }, sendBinary: () => true,
    })
    const pending: RegisteredSession = {
      schemaVersion: 2, active: true, launch: { state: 'ready' }, terminalHost: true,
      agentId: 'term-1', sessionId: '', boundAt: null, engine: 'terminal',
      transcriptPath: null, projectDir: 'nqhieu84', cwd: homedir(),
      runtimes: [{ backend: 'tmux', paneId: '%9' }], primaryRuntimeKey: 'tmux/%9', tmuxPane: '%9',
      source: null, title: null, model: null, cliVersion: null, processIdentity: null,
      registeredAt: 1, updatedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
    }
    const create = vi.fn(async (_input: { engine: string; cwd: string }) => ({ ok: true as const, session: pending }))
    socket.onCreateAgent = create
    const ask = (requestId: string, payload: Record<string, unknown>) => socket.handleLocalFrame('local:terminal', {
      type: 'agent_create', payload: { requestId, engine: 'terminal', ...payload },
    })
    const errorOf = (requestId: string) => (frames.find((frame) => frame.type === 'agent_create_result'
      && (frame.payload as { requestId?: string }).requestId === requestId)?.payload as { error?: string } | undefined)?.error
    try {
      ask('home', {})
      ask('folder', { cwd: '/tmp/work' })
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2))
      expect(create.mock.calls.map(([input]) => [input.engine, input.cwd])).toEqual([['terminal', homedir()], ['terminal', '/tmp/work']])
      ask('relative', { cwd: 'work' })
      ask('grid', { grid: { networkId: 'n', networkName: 'net', baseUrl: 'https://grid.example', apiKey: 'k' } })
      ask('prompt', { prompt: 'hello' })
      await vi.waitFor(() => expect(['relative', 'grid', 'prompt'].map(errorOf)).toEqual(['INVALID_CWD', 'INVALID_GRID', 'PROMPT_UNSUPPORTED']))
      expect(create).toHaveBeenCalledTimes(2)
    } finally {
      await socket.unregisterLocalClient('local:terminal')
      await socket.stop()
    }
  })

  it('recovers a delayed creation on the same connection without starting another agent', async () => {
    const socket = new BackendSocket('token')
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:receipt', {
      sendFrame: (frame) => { frames.push(frame); return true }, sendBinary: () => true,
    })
    const pending: RegisteredSession = {
      schemaVersion: 2, active: true, launch: { state: 'starting' },
      agentId: 'receipt-agent', sessionId: '', boundAt: null, engine: 'claude',
      transcriptPath: null, projectDir: 'work', cwd: '/tmp/work',
      runtimes: [{ backend: 'tmux', paneId: '%receipt' }], primaryRuntimeKey: 'tmux/%receipt', tmuxPane: '%receipt',
      source: null, title: null, model: null, cliVersion: null, processIdentity: null,
      registeredAt: 1, updatedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
    }
    const lookup = vi.spyOn(registry, 'byAgent').mockReturnValue(pending)
    let finish!: () => void
    const create = vi.fn(() => new Promise<{ ok: true; session: RegisteredSession }>((resolve) => {
      finish = () => resolve({ ok: true, session: pending })
    }))
    socket.onCreateAgent = create
    const creationId = randomUUID()
    const ask = (type: string, requestId: string, choices = {}) => socket.handleLocalFrame('local:receipt', {
      type, payload: { requestId, creationId, ...choices },
    })
    try {
      ask('agent_create', 'first', { engine: 'claude', cwd: '/tmp/work' })
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
      ask('agent_create_status', 'while-pending')
      await vi.waitFor(() => expect(frames).toContainEqual({
        type: 'agent_create_status_result', payload: { requestId: 'while-pending', creationId, state: 'pending' },
      }))
      // New transport request id, same deliberate creation intent.
      ask('agent_create', 'retry', { engine: 'claude', cwd: '/tmp/work' })
      finish()
      for (const requestId of ['first', 'retry']) {
        await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({
          type: 'agent_create_result', payload: expect.objectContaining({ requestId, creationId, state: 'created', agent: expect.objectContaining({ id: pending.agentId }) }),
        })))
      }
      expect(create).toHaveBeenCalledTimes(1)
      ask('agent_create_status', 'recovered')
      await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({
        type: 'agent_create_status_result', payload: expect.objectContaining({ requestId: 'recovered', creationId, state: 'created', agent: expect.objectContaining({ id: pending.agentId }) }),
      })))
      ask('agent_create', 'changed', { engine: 'codex', cwd: '/tmp/work' })
      await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({
        type: 'agent_create_result', payload: expect.objectContaining({ requestId: 'changed', error: 'CREATION_CONFLICT' }),
      })))
      lookup.mockReturnValue(undefined)
      ask('agent_create', 'deleted', { engine: 'claude', cwd: '/tmp/work' })
      await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({
        type: 'agent_create_result', payload: expect.objectContaining({ requestId: 'deleted', creationId, state: 'unavailable' }),
      })))
      expect(create).toHaveBeenCalledTimes(1)
    } finally {
      finish?.()
      await socket.unregisterLocalClient('local:receipt')
      await socket.stop()
    }
  })

  it('prepares a remote project once under its creation receipt and retains its folder after a refused launch', async () => {
    const socket = new BackendSocket('token')
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:project', { sendFrame: frame => { frames.push(frame); return true }, sendBinary: () => true })
    let finish!: (folder: string) => void
    const prepare = vi.spyOn(projectFolder, 'prepareProjectFolder').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const create = vi.fn(async () => ({ ok: false as const, error: 'TMUX_UNAVAILABLE' }))
    socket.onCreateAgent = create
    const creationId = randomUUID()
    const payload = { creationId, engine: 'claude', projectSource: 'remote', repositoryUrl: 'owner/repo' }
    const ask = (type: string, requestId: string, choices = payload) => socket.handleLocalFrame('local:project', { type, payload: { requestId, ...choices } })
    try {
      ask('agent_create', 'first')
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1))
      ask('agent_create', 'retry')
      ask('agent_create_status', 'pending')
      await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ requestId: 'pending', state: 'pending' }) })))
      expect(create).not.toHaveBeenCalled()
      finish('/remote/Harness Projects/repo')
      for (const requestId of ['first', 'retry']) {
        await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ requestId, state: 'failed', preparedFolder: '/remote/Harness Projects/repo', failure: { code: 'TMUX_UNAVAILABLE' } }) })))
      }
      expect(create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd: '/remote/Harness Projects/repo' }))
      expect(prepare).toHaveBeenCalledTimes(1)
      ask('agent_create', 'changed', { ...payload, repositoryUrl: 'owner/different' })
      await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ requestId: 'changed', error: 'CREATION_CONFLICT' }) })))
      expect(prepare).toHaveBeenCalledTimes(1)
      ask('agent_create_status', 'saved')
      await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ requestId: 'saved', preparedFolder: '/remote/Harness Projects/repo' }) })))
    } finally {
      finish?.('/remote/Harness Projects/repo')
      await socket.unregisterLocalClient('local:project')
      await socket.stop()
    }
  })

  it('checks an unknown creation without spawning and rejects malformed creation ids before launch', async () => {
    const socket = new BackendSocket('token')
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:missing-receipt', {
      sendFrame: (frame) => { frames.push(frame); return true }, sendBinary: () => true,
    })
    const create = vi.fn(async () => ({ ok: false as const, error: 'CWD_NOT_FOUND' }))
    socket.onCreateAgent = create
    const creationId = randomUUID()
    try {
      socket.handleLocalFrame('local:missing-receipt', {
        type: 'agent_create_status', payload: { requestId: 'missing', creationId },
      })
      await vi.waitFor(() => expect(frames).toContainEqual({
        type: 'agent_create_status_result', payload: { requestId: 'missing', creationId, state: 'missing' },
      }))
      socket.handleLocalFrame('local:missing-receipt', {
        type: 'agent_create', payload: { requestId: 'invalid', creationId: '../bad', engine: 'claude', cwd: '/tmp/work' },
      })
      await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({
        type: 'agent_create_result', payload: expect.objectContaining({ requestId: 'invalid', error: 'INVALID_CREATION_ID' }),
      })))
      expect(create).not.toHaveBeenCalled()
    } finally {
      await socket.unregisterLocalClient('local:missing-receipt')
      await socket.stop()
    }
  })

  it.each([
    ['CWD_NOT_FOUND', 'failed'],
    ['SPAWN_FAILED', 'unconfirmed'],
    ['REGISTRATION_FAILED', 'unconfirmed'],
  ])('does not relaunch a recorded %s outcome', async (error, state) => {
    const socket = new BackendSocket('token')
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:refusal', {
      sendFrame: (frame) => { frames.push(frame); return true }, sendBinary: () => true,
    })
    const create = vi.fn(async () => ({ ok: false as const, error }))
    socket.onCreateAgent = create
    const creationId = randomUUID()
    try {
      for (const requestId of ['initial', 'retry']) {
        socket.handleLocalFrame('local:refusal', {
          type: 'agent_create', payload: { requestId, creationId, engine: 'claude', cwd: '/tmp/work' },
        })
        await vi.waitFor(() => expect(frames).toContainEqual({
          type: 'agent_create_result',
          payload: { requestId, creationId, state, ...(state === 'failed' ? { failure: { code: error } } : {}) },
        }))
      }
      expect(create).toHaveBeenCalledTimes(1)
    } finally {
      await socket.unregisterLocalClient('local:refusal')
      await socket.stop()
    }
  })

  it('sends a device focus request to one desktop window only', async () => {
    const socket = new BackendSocket('token')
    const first = vi.fn(() => true), second = vi.fn(() => true)
    const frame = { type: 'device_focus', payload: { agentId: 'first' } }
    expect(socket.sendFirstLocal(frame)).toBe(false)
    socket.registerLocalClient('local:first', { sendFrame: first, sendBinary: () => true })
    socket.registerLocalClient('local:second', { sendFrame: second, sendBinary: () => true })
    first.mockClear(); second.mockClear()
    expect(socket.sendFirstLocal(frame)).toBe(true)
    expect(first).toHaveBeenCalledExactlyOnceWith(frame)
    expect(second).not.toHaveBeenCalled()
    await socket.unregisterLocalClient('local:first')
    await socket.unregisterLocalClient('local:second')
    await socket.stop()
  })

  it('hands a blocked agent to the window without putting the question on the cloud leg', async () => {
    const socket = new BackendSocket('token')
    expect(socket.hasLocalClient()).toBe(false)
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:window', {
      sendFrame: (frame) => { frames.push(frame); return true },
      sendBinary: () => true,
    })
    // The watcher's whole gate: polling a pane for a dialog is waste with nobody rendering it, and
    // "nobody" used to mean "no device" — which is what kept the window in the dark.
    expect(socket.hasLocalClient()).toBe(true)

    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    const asked = {
      type: 'commander_question',
      agentId: 'a1',
      dbSessionId: 's1',
      payload: { requestId: 'q_1', questions: [{ key: 'Which theme?', q: 'Which theme?', options: ['Blue', 'Red'], multi: false }] },
    }
    socket.sendLocal(asked)

    // The window reads it in the clear, which is what loopback is for...
    expect(frames).toContainEqual(asked)
    // ...and it never reaches the relay. `commander_question` is deliberately NOT in ENCRYPTED_UP_TYPES,
    // so `send()` here would have travelled the cloud leg as plaintext question text and option labels.
    expect(parseSent(ws).some((item) => (item.frame as { type?: string })?.type === 'commander_question')).toBe(false)

    await socket.unregisterLocalClient('local:window')
    expect(socket.hasLocalClient()).toBe(false)
    await socket.stop()
  })

  it('routes local terminal binary directly and preserves local streams when cloud disconnects', async () => {
    vi.useFakeTimers()
    const socket = new BackendSocket('token')
    const handleBinary = vi.fn(async () => undefined)
    const closeConnection = vi.fn(async () => undefined)
    const closeConnectionsWhere = vi.fn(async (
      _predicate: (connId: string) => boolean,
      _reason: string,
      _notify?: boolean,
    ) => undefined)
    const stop = vi.fn(async () => undefined)
    socket.setTerminalStreamManager({
      handleBinary,
      closeConnection,
      closeConnectionsWhere,
      stop,
    } as unknown as TerminalStreamManager)
    const binary: Uint8Array[] = []
    socket.registerLocalClient('local:terminal', {
      sendFrame: () => true,
      sendBinary: (frame) => { binary.push(frame); return true },
    })
    const clear = {
      kind: TerminalBinaryKind.input,
      streamId: '00112233-4455-6677-8899-aabbccddeeff',
      seq: 1,
      bytes: Uint8Array.of(1, 2),
      compressed: false,
    }
    await socket.handleLocalBinary('local:terminal', clear)
    expect(handleBinary).toHaveBeenCalledWith('local:terminal', clear)
    expect(socket.sendTerminalBinaryTo('local:terminal', clear)).toBe(true)
    expect(decodeTerminalLocal(binary[0])).toEqual(clear)

    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    ws.close()
    expect(closeConnectionsWhere).toHaveBeenCalledOnce()
    const predicate = closeConnectionsWhere.mock.calls[0][0] as (connId: string) => boolean
    expect(predicate('web-1')).toBe(true)
    expect(predicate('local:terminal')).toBe(false)

    await socket.unregisterLocalClient('local:terminal')
    expect(closeConnection).toHaveBeenCalledWith('local:terminal', 'local client disconnected', false)
    await socket.stop()
  })

  it('reports the window itself: open when it attaches, ping once a minute while it stays, nothing while offline', async () => {
    vi.useFakeTimers()
    const socket = new BackendSocket('token')
    const sink = { sendFrame: () => true, sendBinary: () => true }
    const kinds = (ws: InstanceType<typeof wsMock.MockWebSocket>) => parseSent(ws)
      .filter((m) => (m.frame as { type?: string } | undefined)?.type === 'app_presence')
      .map((m) => (m.frame as { payload: { kind: string } }).payload.kind)

    // A window attaching to a not-yet-dialed daemon (the cold start): nothing can be sent yet, and
    // nothing is queued behind real frames — but the session is owed to the link that comes up.
    expect(socket.registerLocalClient('local:1', sink)).toBe(true)
    socket.connect()
    const ws = wsMock.instances[0]
    expect(kinds(ws)).toEqual([])
    ws.open()
    expect(kinds(ws)).toEqual(['open'])

    // While the window stays: once a minute on the app-ping tick, not once a tick.
    vi.advanceTimersByTime(45_000)
    expect(kinds(ws)).toEqual(['open'])
    vi.advanceTimersByTime(15_000)
    expect(kinds(ws)).toEqual(['open', 'ping'])

    // A second window is a session in its own right — up at once, floor or not.
    expect(socket.registerLocalClient('local:2', sink)).toBe(true)
    expect(kinds(ws)).toEqual(['open', 'ping', 'open'])
    // Registering the same window twice is refused, and says nothing.
    expect(socket.registerLocalClient('local:2', sink)).toBe(false)
    expect(kinds(ws)).toHaveLength(3)

    // Every window gone: the tick falls silent.
    await socket.unregisterLocalClient('local:1')
    await socket.unregisterLocalClient('local:2')
    vi.advanceTimersByTime(120_000)
    expect(kinds(ws)).toHaveLength(3)

    // A window that came and went while the link was down was never a session the backend can hear
    // about — the next link is told nothing. Both remaining windows gone first, so the count is clean.
    ws.close()
    expect(socket.registerLocalClient('local:3', sink)).toBe(true)
    await socket.unregisterLocalClient('local:3')
    vi.advanceTimersByTime(60_000)
    const ws2 = wsMock.instances[1]
    ws2.open()
    vi.advanceTimersByTime(15_000)
    expect(kinds(ws2)).toEqual([])

    // Bookkeeping about the person, for the backend alone: never fanned out to a client.
    expect(parseSent(ws).find((m) => (m.frame as { type?: string } | undefined)?.type === 'app_presence'))
      .toMatchObject({ t: 'up', webEligible: false, commanderEligible: false })

    await socket.stop()
  })

  it('reports commander presence only when it crosses zero', async () => {
    const socket = new BackendSocket('token')
    const changes: boolean[] = []
    socket.onCommanderPresenceChanged = (connected) => changes.push(connected)
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()

    const clients = (commander: number) => ws.message({
      t: 'down', connId: '', frame: { type: '__clients', payload: { commander } },
    })
    clients(1)
    clients(2)
    clients(0)
    clients(0)
    clients(1)
    await vi.waitFor(() => expect(changes).toEqual([true, false, true]))

    await socket.stop()
    expect(changes).toEqual([true, false, true, false])
  })

  // "The device is gone" reaches us two ways: the backend says so (`__clients` → 0), or our own link to
  // the backend dies and we can no longer know. Both have to release the device's E2EE session — the
  // dashboard's device dot reads `deviceE2eeConnected()`, so a session left behind reports a device that
  // may have been gone for hours.
  it('drops the device E2EE session when the count reaches zero', async () => {
    const socket = new BackendSocket('token')
    const drop = vi.spyOn(socket.e2ee, 'dropSessionsByRole')
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()

    ws.message({ t: 'down', connId: '', frame: { type: '__clients', payload: { commander: 1 } } })
    expect(drop).not.toHaveBeenCalled()

    ws.message({ t: 'down', connId: '', frame: { type: '__clients', payload: { commander: 0 } } })
    await vi.waitFor(() => expect(drop).toHaveBeenCalledWith('device'))

    await socket.stop()
  })

  it('drops the device E2EE session when OUR backend link dies, not just when the backend says so', async () => {
    vi.useFakeTimers()
    const socket = new BackendSocket('token')
    const drop = vi.spyOn(socket.e2ee, 'dropSessionsByRole')
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()

    ws.message({ t: 'down', connId: '', frame: { type: '__clients', payload: { commander: 1 } } })
    drop.mockClear()

    ws.close() // transport gone — no `__clients` frame will ever tell us the device left
    expect(socket.hasCommander()).toBe(false)
    expect(drop).toHaveBeenCalledWith('device')

    await socket.stop()
  })

  it('releases E2EE and terminal state for the exact disconnected web connId', async () => {
    const socket = new BackendSocket('token')
    const closeConnection = vi.fn(async () => undefined)
    const stop = vi.fn(async () => undefined)
    socket.setTerminalStreamManager({
      closeConnection,
      stop,
    } as unknown as TerminalStreamManager)
    const dropSession = vi.spyOn(socket.e2ee, 'dropSession')
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()

    ws.message({
      t: 'down',
      connId: 'web-terminal-1',
      frame: { type: '__client_disconnected', payload: {} },
    })

    await vi.waitFor(() => {
      expect(dropSession).toHaveBeenCalledWith('web-terminal-1')
      expect(closeConnection).toHaveBeenCalledWith(
        'web-terminal-1',
        'client connection closed',
        false,
      )
    })
    await socket.stop()
    expect(stop).toHaveBeenCalledOnce()
  })
})

describe('agent_fork RPC', () => {
  afterEach(() => {
    wsMock.instances.length = 0
    vi.restoreAllMocks()
  })

  const FORK: RegisteredSession = {
    schemaVersion: 2, active: true, agentId: 'agent-2', sessionId: '', boundAt: null, engine: 'claude',
    forkedFrom: { agentId: 'agent-1', name: 'Agent one' },
    transcriptPath: null, projectDir: 'workspace', cwd: '/tmp/workspace', runtimes: [], primaryRuntimeKey: '',
    tmuxPane: '%2', source: null, title: null, model: null, cliVersion: null, processIdentity: null,
    registeredAt: 2, updatedAt: 2, lastHookAt: 2, lastTranscriptAt: 2,
  }

  function localSocket(): { socket: BackendSocket; frames: Array<Record<string, unknown>> } {
    const socket = new BackendSocket('token')
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:fork', { sendFrame: (frame) => { frames.push(frame); return true }, sendBinary: () => true })
    return { socket, frames }
  }

  it('validates the frame before touching the daemon', async () => {
    const { socket, frames } = localSocket()
    socket.handleLocalFrame('local:fork', { type: 'agent_fork', payload: { requestId: 'r1' } })
    await vi.waitFor(() => expect(frames).toContainEqual({ type: 'agent_fork_result', payload: { requestId: 'r1', error: 'MISSING_AGENT_ID' } }))
    socket.handleLocalFrame('local:fork', { type: 'agent_fork', payload: { requestId: 'r2', agentId: 'agent-1' } })
    await vi.waitFor(() => expect(frames).toContainEqual({ type: 'agent_fork_result', payload: { requestId: 'r2', error: 'UNSUPPORTED_ON_REMOTE' } }))
    socket.onForkAgent = async () => ({ ok: true, session: FORK, level: 'native' })
    socket.handleLocalFrame('local:fork', { type: 'agent_fork', payload: { requestId: 'r3', agentId: 'agent-1', prompt: 'x'.repeat(2001) } })
    await vi.waitFor(() => expect(frames).toContainEqual({ type: 'agent_fork_result', payload: { requestId: 'r3', error: 'PROMPT_TOO_LONG' } }))
    await socket.unregisterLocalClient('local:fork')
    await socket.stop()
  })

  it('hands name and prompt to the daemon and answers with the fork, its level, and who it came from', async () => {
    const { socket, frames } = localSocket()
    const seen: unknown[] = []
    socket.onForkAgent = async (input) => { seen.push(input); return { ok: true, session: FORK, level: 'native' } }
    socket.handleLocalFrame('local:fork', { type: 'agent_fork', payload: { requestId: 'r1', agentId: 'agent-1', name: '  Agent one - fork ', prompt: 'ship it' } })
    await vi.waitFor(() => {
      const result = frames.find((f) => f.type === 'agent_fork_result')
      expect(result).toMatchObject({
        payload: { requestId: 'r1', level: 'native', agent: expect.objectContaining({ id: 'agent-2', forkedFrom: { agentId: 'agent-1', name: 'Agent one' } }) },
      })
    })
    expect(seen).toEqual([{ agentId: 'agent-1', name: 'Agent one - fork', prompt: 'ship it' }])
    await socket.unregisterLocalClient('local:fork')
    await socket.stop()
  })

  it('relays the daemon\'s refusal with its reason', async () => {
    const { socket, frames } = localSocket()
    socket.onForkAgent = async () => ({ ok: false, error: 'AGENT_BUSY', detail: 'Wait for it to finish, then fork.' })
    socket.handleLocalFrame('local:fork', { type: 'agent_fork', payload: { requestId: 'r1', agentId: 'agent-1' } })
    await vi.waitFor(() => expect(frames).toContainEqual({
      type: 'agent_fork_result', payload: { requestId: 'r1', error: 'AGENT_BUSY', detail: 'Wait for it to finish, then fork.' },
    }))
    await socket.unregisterLocalClient('local:fork')
    await socket.stop()
  })
})

describe('agent_restart RPC', () => {
  afterEach(() => {
    wsMock.instances.length = 0
    vi.restoreAllMocks()
  })

  const BASE_SESSION: RegisteredSession = {
    schemaVersion: 2,
    active: true,
    agentId: 'agent-1',
    sessionId: 'session-1',
    boundAt: 1,
    engine: 'claude',
    transcriptPath: null,
    projectDir: 'workspace',
    cwd: '/tmp/workspace',
    runtimes: [],
    primaryRuntimeKey: '',
    tmuxPane: '%1',
    source: null,
    title: 'Agent one',
    model: null,
    cliVersion: null,
    processIdentity: null,
    registeredAt: 1,
    updatedAt: 1,
    lastHookAt: 1,
    lastTranscriptAt: 1,
  }

  function localSocket(): { socket: BackendSocket; frames: Array<Record<string, unknown>> } {
    const socket = new BackendSocket('token')
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:restart', {
      sendFrame: (frame) => { frames.push(frame); return true },
      sendBinary: () => true,
    })
    return { socket, frames }
  }

  it('replies MISSING_AGENT_ID when no agentId is given', async () => {
    const { socket, frames } = localSocket()
    socket.handleLocalFrame('local:restart', { type: 'agent_restart', payload: { requestId: 'r1' } })
    await vi.waitFor(() => expect(frames).toContainEqual({
      type: 'agent_restart_result', payload: { requestId: 'r1', error: 'MISSING_AGENT_ID' },
    }))
    await socket.unregisterLocalClient('local:restart')
    await socket.stop()
  })

  it('replies UNSUPPORTED_ON_REMOTE when no handler is wired', async () => {
    const { socket, frames } = localSocket()
    socket.handleLocalFrame('local:restart', { type: 'agent_restart', payload: { requestId: 'r1', agentId: 'agent-1' } })
    await vi.waitFor(() => expect(frames).toContainEqual({
      type: 'agent_restart_result', payload: { requestId: 'r1', error: 'UNSUPPORTED_ON_REMOTE' },
    }))
    await socket.unregisterLocalClient('local:restart')
    await socket.stop()
  })

  it('delegates to onRestartAgent and replies with the agent projection and the resumed flag on success', async () => {
    const { socket, frames } = localSocket()
    let seenAgentId: string | undefined
    socket.onRestartAgent = async (agentId) => {
      seenAgentId = agentId
      return { ok: true, session: BASE_SESSION, resumed: true }
    }
    socket.handleLocalFrame('local:restart', { type: 'agent_restart', payload: { requestId: 'r1', agentId: 'agent-1' } })
    await vi.waitFor(() => {
      const result = frames.find((f) => f.type === 'agent_restart_result')
      expect(result).toMatchObject({
        type: 'agent_restart_result',
        payload: {
          requestId: 'r1',
          resumed: true,
          agent: expect.objectContaining({ id: 'agent-1', sessionId: 'session-1', engine: 'claude' }),
        },
      })
    })
    expect(seenAgentId).toBe('agent-1')
    await socket.unregisterLocalClient('local:restart')
    await socket.stop()
  })

  it('reports a fresh (non-resumed) relaunch through the same resumed flag', async () => {
    const { socket, frames } = localSocket()
    socket.onRestartAgent = async () => ({ ok: true, session: BASE_SESSION, resumed: false })
    socket.handleLocalFrame('local:restart', { type: 'agent_restart', payload: { requestId: 'r1', agentId: 'agent-1' } })
    await vi.waitFor(() => {
      const result = frames.find((f) => f.type === 'agent_restart_result')
      expect(result).toMatchObject({ payload: { requestId: 'r1', resumed: false } })
    })
    await socket.unregisterLocalClient('local:restart')
    await socket.stop()
  })

  it('replies with error+detail on failure, matching agent_create/agent_delete\'s reply shape', async () => {
    const { socket, frames } = localSocket()
    socket.onRestartAgent = async () => (
      { ok: false, error: 'RESTART_FAILED', detail: 'claude did not come back up after restart' }
    )
    socket.handleLocalFrame('local:restart', { type: 'agent_restart', payload: { requestId: 'r1', agentId: 'agent-1' } })
    await vi.waitFor(() => expect(frames).toContainEqual({
      type: 'agent_restart_result',
      payload: { requestId: 'r1', error: 'RESTART_FAILED', detail: 'claude did not come back up after restart' },
    }))
    await socket.unregisterLocalClient('local:restart')
    await socket.stop()
  })

  it('omits detail on failure when the handler did not supply one', async () => {
    const { socket, frames } = localSocket()
    socket.onRestartAgent = async () => ({ ok: false, error: 'AGENT_NOT_FOUND' })
    socket.handleLocalFrame('local:restart', { type: 'agent_restart', payload: { requestId: 'r1', agentId: 'agent-1' } })
    await vi.waitFor(() => expect(frames).toContainEqual({
      type: 'agent_restart_result', payload: { requestId: 'r1', error: 'AGENT_NOT_FOUND' },
    }))
    await socket.unregisterLocalClient('local:restart')
    await socket.stop()
  })
})

describe('compact runtime picker catalog', () => {
  const models = [
    { id: 'runtime-v1:s1:codex:gpt-5.6-sol@auto', displayName: 'Sol / Auto' },
    { id: 'runtime-v1:s1:codex:gpt-5.6-sol@medium', displayName: 'Sol / Medium' },
    { id: 'runtime-v1:s1:codex:gpt-5.6-sol@high', displayName: 'Sol / High' },
    { id: 'runtime-v1:s1:codex:o3@high', displayName: 'o3 / High' },
    { id: 'runtime-v1:s2:claude:sonnet@high', displayName: 'Sonnet / High' },
  ]

  it('returns only explicit efforts for the selected session model', () => {
    expect(compactRuntimePickerModels(
      models,
      's1',
      'effort',
      'runtime-v1:s1:codex:gpt-5.6-sol@medium',
    )).toEqual([
      { id: 'runtime-v1:s1:codex:gpt-5.6-sol@medium' },
      { id: 'runtime-v1:s1:codex:gpt-5.6-sol@high' },
    ])
  })

  it('caps the device model list and keeps the running model in it', () => {
    // Devin publishes 72 models; a 49-row wheel already tripped the device's task watchdog once.
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `runtime-v1:s1:devin:model-${i}@auto`,
      displayName: `Model ${i}`,
    }))
    const capped = compactRuntimePickerModels(many, 's1', 'model', 'runtime-v1:s1:devin:model-39@auto')

    expect(capped).toHaveLength(24)
    // The model the agent is running would have fallen off the end of the catalog order.
    expect(capped[0]).toEqual({ id: 'runtime-v1:s1:devin:model-39@auto' })
    // The web asks without a picker mode and still gets the whole catalog.
    expect(compactRuntimePickerModels(many, 's1', undefined, null)).toHaveLength(40)
  })
})

describe('device agent list contract', () => {
  it('keeps the engine discriminator while trimming web-only fields', () => {
    expect(deviceAgentListItem({ id: 's1', name: 'Codex agent', engine: 'codex', userId: 'secret' })).toEqual({
      id: 's1', name: 'Codex agent', engine: 'codex',
    })
  })

  it('surfaces the runtime-v1 model/effort profile so the device can render + change it', () => {
    const profile = 'runtime-v1:s1:codex:gpt-5.6-sol@high'
    expect(deviceAgentListItem({ id: 's1', name: 'A', engine: 'codex', selectedModel: profile })).toEqual({
      id: 's1', name: 'A', engine: 'codex', selectedModel: profile,
    })
    expect(deviceAgentListItem({ id: 's1', name: 'A', engine: 'claude', selectedModel: null })).toEqual({
      id: 's1', name: 'A', engine: 'claude', selectedModel: null,
    })
  })

  it('preserves Grok on the device agent contract', () => {
    expect(deviceAgentListItem({ id: 'g1', name: 'Grok agent', engine: 'grok' })).toEqual({
      id: 'g1', name: 'Grok agent', engine: 'grok',
    })
  })

  it('keeps a terminal off the device: not a row for it, and never an engine it would understand', () => {
    expect(deviceAgentRow({ id: 't1', name: 'Terminal 1', engine: 'terminal' })).toBe(false)
    expect(deviceAgentRow({ id: 'c1', name: 'Claude 1', engine: 'claude' })).toBe(true)
    expect(deviceAgentListItem({ id: 't1', name: 'Terminal 1', engine: 'terminal' })).toEqual({ id: 't1', name: 'Terminal 1' })
  })
})

describe('Grok session_get history', () => {
  const fixture = readFileSync(
    fileURLToPath(new URL('./lib/__fixtures__/grok-session.jsonl', import.meta.url)),
    'utf8',
  ).split('\n').filter(Boolean)

  it('replays the real transcript for both legacy and web-paginated requests', () => {
    const full = grokHistoryPage(fixture, false)
    const paginated = grokHistoryPage(fixture, true)

    expect(full.events).toEqual(paginated.events)
    expect(full.events[0]).toMatchObject({ type: 'user_message' })
    expect(full.events.at(-1)).toEqual({ type: 'done', payload: { result: 'success' } })
    expect(full).not.toHaveProperty('hasMore')
    expect(paginated).toMatchObject({ hasMore: false, oldestCursor: null })
  })
})

describe('adapter-ws dial url', () => {
  const dialUrl = (socket: BackendSocket): string => (socket as unknown as { url: string }).url

  it('carries the machine id this daemon still holds, so a revoked one gets 403 not a new machine', () => {
    const machineId = 'b'.repeat(32)

    expect(dialUrl(new BackendSocket(machineId, undefined, () => {}, 'computer-1')))
      .toContain(`&machine=${machineId}`)
  })

  it('omits the claim when the first argument is a test token rather than a machine id', () => {
    // Constructed without an AuthSessionManager, the first argument is a token — sending it as a
    // machine id would be a lie the backend then has to reject.
    expect(dialUrl(new BackendSocket('token', undefined, () => {}, 'computer-1'))).not.toContain('&machine=')
  })
})

describe('agent_retarget clearGrid', () => {
  afterEach(() => {
    wsMock.instances.length = 0
    vi.restoreAllMocks()
  })

  const WIRE_GRID = {
    networkId: 'grid-abc',
    networkName: 'autonomous.ai',
    baseUrl: 'https://grid.autonomous.ai/grid-abc/relay/v1',
    apiKey: 'gridkey-abc123',
  }

  async function retarget(payload: Record<string, unknown>) {
    const seen: Array<{ agentId: string; grid: unknown }> = []
    const socket = new BackendSocket('token')
    socket.onRetargetAgent = async (input) => { seen.push(input); return { ok: true } }
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    ws.message({ t: 'down', connId: 'web-1', frame: { type: 'agent_retarget', payload } })
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0))
    const reply = parseSent(ws)
      .map((item) => item.frame as { type?: string; payload?: Record<string, unknown> } | undefined)
      .find((frame) => frame?.type === 'agent_retarget_result')
    await socket.stop()
    return { seen, reply }
  }

  it('passes a null grid when clearGrid is true', async () => {
    const { seen } = await retarget({ requestId: 'r', agentId: 'a1', clearGrid: true })
    expect(seen).toEqual([{ agentId: 'a1', grid: null }])
  })

  // Both is a contradiction, and answering it would mean guessing which one the client meant.
  it('refuses grid and clearGrid together', async () => {
    const { seen, reply } = await retarget({ requestId: 'r', agentId: 'a1', clearGrid: true, grid: WIRE_GRID })
    expect(reply?.payload?.error).toBe('INVALID_GRID')
    expect(seen).toHaveLength(0)
  })

  // Unchanged: a client that simply forgot the field is still an error, which is the whole reason
  // clearGrid is a separate field rather than `grid: null`.
  it('still refuses a frame with neither', async () => {
    const { seen, reply } = await retarget({ requestId: 'r', agentId: 'a1' })
    expect(reply?.payload?.error).toBe('INVALID_GRID')
    expect(seen).toHaveLength(0)
  })
})

/**
 * The desktop's retarget names a Local model and nothing else; the daemon resolves everything from
 * its own signed-in `grid`. This is that resolution through the real frame handler, against the
 * plan-driven fake `grid` — the seam `gridEnsure.spec.ts` established.
 */
describe('agent_retarget onto a Local model resolves web tools', () => {
  const { gridName: GRID_NAME, networkId, baseUrl: BASE_URL, mcpUrl: MCP_URL, token: TOKEN, plan } = fakeGridAnswers()

  let fake: FakeGrid | null = null
  afterEach(async () => {
    fake?.dispose()
    fake = null
    clearGridMcpUrlCache()
    wsMock.instances.length = 0
    vi.restoreAllMocks()
  })

  async function retargetOntoLocalModel(model: string) {
    const seen: Array<{ agentId: string; grid: unknown }> = []
    const socket = new BackendSocket('token')
    socket.onRetargetAgent = async (input) => { seen.push(input); return { ok: true } }
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    // The grid name is the backend's, pushed on connect; the daemon holds it in memory only.
    ws.message({ t: 'down', connId: 'web-1', frame: { type: 'machine_meta', payload: { name: 'mac', gridName: GRID_NAME } } })
    ws.message({ t: 'down', connId: 'web-1', frame: { type: 'agent_retarget', payload: { requestId: 'r', agentId: 'a1', gridModel: model } } })
    await vi.waitFor(() => expect(parseSent(ws).some((item) => (item.frame as { type?: string } | undefined)?.type === 'agent_retarget_result')).toBe(true), { timeout: 10_000 })
    const reply = parseSent(ws)
      .map((item) => item.frame as { type?: string; payload?: Record<string, unknown> } | undefined)
      .find((frame) => frame?.type === 'agent_retarget_result')
    await socket.stop()
    return { seen, reply }
  }

  it('yields a launch override whose MCP URL is exactly the printed url, asking `mcp config` before `info --env`', async () => {
    fake = installFakeGrid(plan)
    const { seen, reply } = await retargetOntoLocalModel('GLM-4.7-Flash')
    expect(reply?.payload).toMatchObject({ retargeted: true })
    expect(seen).toEqual([{
      agentId: 'a1',
      grid: {
        networkId,
        networkName: GRID_NAME,
        baseUrl: BASE_URL,
        apiKey: TOKEN,
        model: 'GLM-4.7-Flash',
        mcpUrl: MCP_URL,
      },
    }])
    expect(fake.verbs()).toEqual(['mcp', 'info', 'ls'])
    expect(fake.calls()[0]).toEqual(['--remote', 'mcp', 'config', GRID_NAME, '--json'])
  })

  it('still retargets, with no MCP URL, when the binary is too old for `mcp config`', async () => {
    const warned: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((...parts: unknown[]) => { warned.push(parts.map(String).join(' ')) })
    fake = installFakeGrid({ ...plan, mcp: { exit: 2, stderr: "grid: error: invalid choice: 'mcp'\n" } })
    const { seen, reply } = await retargetOntoLocalModel('GLM-4.7-Flash')
    expect(reply?.payload).toMatchObject({ retargeted: true })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.grid).toMatchObject({ baseUrl: BASE_URL, apiKey: TOKEN, model: 'GLM-4.7-Flash' })
    expect(seen[0]!.grid).not.toHaveProperty('mcpUrl')
    // The reason reaches the daemon log, and nothing else — the retarget error path is untouched.
    expect(warned.join('\n')).toMatch(/web tools unavailable .* older than/)
    expect(reply?.payload).not.toHaveProperty('error')
  })
})

/**
 * `agent_create` carrying a first prompt, a name and a named agent — the fields the run-a-harness-compute
 * entry can send (it sends `name` and `agent`). All are validated at the wire, before any pane
 * exists; what reaches `onCreateAgent` is exactly what cli.ts hands to the launch and the registry.
 */
describe('agent_create with a prompt, a name and a named agent', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const pending: RegisteredSession = {
    schemaVersion: 2, active: true, launch: { state: 'starting' },
    agentId: 'named-1', sessionId: '', boundAt: null, engine: 'opencode',
    transcriptPath: null, projectDir: 'home', cwd: '/home/someone', defaultName: 'Local model',
    runtimes: [{ backend: 'tmux', paneId: '%11' }], primaryRuntimeKey: 'tmux/%11', tmuxPane: '%11',
    source: null, title: null, model: null, cliVersion: null, processIdentity: null,
    registeredAt: 1, updatedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
  }

  async function create(choices: Record<string, unknown>) {
    const socket = new BackendSocket('token')
    const frames: Array<Record<string, unknown>> = []
    socket.registerLocalClient('local:named', { sendFrame: (frame) => { frames.push(frame); return true }, sendBinary: () => true })
    const seen: unknown[] = []
    socket.onCreateAgent = async (input) => { seen.push(input); return { ok: true, session: pending } }
    try {
      socket.handleLocalFrame('local:named', { type: 'agent_create', payload: { requestId: 'r', engine: 'opencode', cwd: '/home/someone', ...choices } })
      await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'agent_create_result')).toBe(true))
    } finally {
      await socket.unregisterLocalClient('local:named')
      await socket.stop()
    }
    const reply = frames.find((frame) => frame.type === 'agent_create_result')?.payload as Record<string, unknown>
    return { seen, reply }
  }

  it('passes both through, trimmed, and the name becomes the row\'s defaultName', async () => {
    const { seen, reply } = await create({ prompt: '  Start a local model on this machine ', name: ' Local model ' })
    expect(seen).toEqual([expect.objectContaining({ engine: 'opencode', prompt: 'Start a local model on this machine', name: 'Local model' })])
    expect(reply).toMatchObject({ agent: expect.objectContaining({ id: 'named-1', name: 'Local model' }) })
  })

  it('sends null for both when neither was given, or when they are blank', async () => {
    expect((await create({})).seen).toEqual([expect.objectContaining({ prompt: null, name: null })])
    expect((await create({ prompt: '   ', name: '' })).seen).toEqual([expect.objectContaining({ prompt: null, name: null })])
  })

  it('refuses an over-long prompt before any pane exists', async () => {
    const { seen, reply } = await create({ prompt: 'x'.repeat(2001) })
    expect(reply).toMatchObject({ error: 'PROMPT_TOO_LONG' })
    expect(seen).toHaveLength(0)
    expect((await create({ prompt: 'x'.repeat(2000) })).seen).toHaveLength(1)
  })

  it('refuses a prompt for an engine with no documented mechanism, naming the engine', async () => {
    const { seen, reply } = await create({ engine: 'cursor', prompt: 'Start a local model on this machine' })
    expect(reply).toMatchObject({ error: 'PROMPT_UNSUPPORTED', detail: expect.stringContaining('cursor') })
    expect(seen).toHaveLength(0)
  })

  it('refuses a prompt that is not text', async () => {
    const { seen, reply } = await create({ prompt: ['Start a local model'] })
    expect(reply).toMatchObject({ error: 'INVALID_PROMPT' })
    expect(seen).toHaveLength(0)
  })

  it('passes the named agent through for opencode, and null when none was given', async () => {
    const { seen, reply } = await create({ agent: 'harness-compute', name: 'Local model' })
    expect(seen).toEqual([expect.objectContaining({ engine: 'opencode', agent: 'harness-compute', name: 'Local model', prompt: null })])
    expect(reply).toMatchObject({ agent: expect.objectContaining({ id: 'named-1' }) })
    expect((await create({})).seen).toEqual([expect.objectContaining({ agent: null })])
    expect((await create({ agent: null })).seen).toEqual([expect.objectContaining({ agent: null })])
  })

  it('refuses a named agent for an engine with no documented mechanism, naming the engine, before any pane exists', async () => {
    for (const engine of ['claude', 'codex', 'cursor']) {
      const { seen, reply } = await create({ engine, agent: 'harness-compute' })
      expect(reply).toMatchObject({ error: 'AGENT_UNSUPPORTED', detail: expect.stringContaining(engine) })
      expect(seen).toHaveLength(0)
    }
  })

  it('refuses a named agent that is not an identifier — a path, prose, blank, over-long, or not text', async () => {
    for (const agent of ['', '  ', 'local model', '../etc/passwd', 'a/b', 'x'.repeat(65), ['harness-compute'], 7]) {
      const { seen, reply } = await create({ agent })
      expect(reply).toMatchObject({ error: 'INVALID_AGENT' })
      expect(seen).toHaveLength(0)
    }
  })
})

/**
 * The picker and the Local model dialog gate on `gridName` — whether the ACCOUNT has a grid — and
 * had nothing to tell them whether the MACHINE has a `grid` to run at all. A user with no CLI got a
 * dialog that started an agent, which died at the skill's second step. The answer travels beside
 * the list, as `localModelEngines` does, and says which grid it is: the managed runtime, one found
 * on PATH, or none.
 */
describe('grid_models_list says whether this machine has a grid CLI', () => {
  const { gridName: GRID_NAME, plan } = fakeGridAnswers()

  let fake: FakeGrid | null = null
  afterEach(async () => {
    fake?.dispose()
    fake = null
    wsMock.instances.length = 0
  })

  async function listModels(): Promise<Record<string, unknown> | undefined> {
    const socket = new BackendSocket('token')
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    ws.message({ t: 'down', connId: 'web-1', frame: { type: 'machine_meta', payload: { name: 'mac', gridName: GRID_NAME } } })
    ws.message({ t: 'down', connId: 'web-1', frame: { type: 'grid_models_list', payload: { requestId: 'r' } } })
    await vi.waitFor(() => expect(parseSent(ws).some((item) => (item.frame as { type?: string } | undefined)?.type === 'grid_models_list_result')).toBe(true), { timeout: 10_000 })
    const reply = parseSent(ws)
      .map((item) => item.frame as { type?: string; payload?: Record<string, unknown> } | undefined)
      .find((frame) => frame?.type === 'grid_models_list_result')
    await socket.stop()
    return reply?.payload
  }

  it('names the grid it would run — the fixture is a developer override, so `path`', async () => {
    fake = installFakeGrid(plan)

    expect(await listModels()).toMatchObject({ gridName: GRID_NAME, gridCli: 'path' })
  })

  it('waits for an in-flight grid reconcile before answering, so the first open after an update is not empty', async () => {
    fake = installFakeGrid(plan)
    const socket = new BackendSocket('token')
    // No local fallback and no machine_meta: the name can only come from the reconcile below, so a
    // non-empty answer proves the RPC waited for it rather than answering "no grid" straight away.
    socket.deriveGridName = async () => null
    let settle: () => void = () => {}
    const reconcile = new Promise<void>((resolve) => {
      settle = () => { socket.setHarnessGridName(GRID_NAME); resolve() }
    })
    socket.gridReadyProbe = () => reconcile
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()
    ws.message({ t: 'down', connId: 'web-1', frame: { type: 'grid_models_list', payload: { requestId: 'r' } } })
    // The reconcile lands a moment later, within the RPC's wait window.
    setTimeout(() => settle(), 20)
    await vi.waitFor(() => expect(parseSent(ws).some((item) => (item.frame as { type?: string } | undefined)?.type === 'grid_models_list_result')).toBe(true), { timeout: 10_000 })
    const reply = parseSent(ws)
      .map((item) => item.frame as { type?: string; payload?: Record<string, unknown> } | undefined)
      .find((frame) => frame?.type === 'grid_models_list_result')
    await socket.stop()
    expect(reply?.payload).toMatchObject({ gridName: GRID_NAME })
  })
})

describe('machine_meta carries the grid name without clobbering it on rename', () => {
  afterEach(() => { wsMock.instances.length = 0 })

  it('keeps the grid name when a later rename frame omits gridName, and clears it only on an explicit null', async () => {
    const socket = new BackendSocket('token')
    // Frames are processed through a queue, so `onMachineMeta` is how a test knows one has landed.
    const namesSeen: Array<string | null> = []
    socket.onMachineMeta = (n) => { namesSeen.push(n) }
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()

    // Connect frame: name and grid together.
    ws.message({ t: 'down', connId: 'web-1', frame: { type: 'machine_meta', payload: { name: 'mac', gridName: 'someone-7f3a91c4' } } })
    await vi.waitFor(() => expect(socket.gridName()).toBe('someone-7f3a91c4'))

    // A rename pushes `{ name }` alone — it must NOT wipe the grid name (the bug that left the picker
    // empty the moment a machine was renamed). Wait until the rename is observably processed, then
    // confirm the grid name survived it.
    ws.message({ t: 'down', connId: 'web-1', frame: { type: 'machine_meta', payload: { name: 'renamed' } } })
    await vi.waitFor(() => expect(namesSeen).toContain('renamed'))
    expect(socket.gridName()).toBe('someone-7f3a91c4')

    // An explicit null is the account genuinely having no grid, and does clear it.
    ws.message({ t: 'down', connId: 'web-1', frame: { type: 'machine_meta', payload: { name: 'renamed', gridName: null } } })
    await vi.waitFor(() => expect(socket.gridName()).toBeNull())

    await socket.stop()
  })

  it('refuses a machine_meta that arrived over the LOCAL socket — only the backend may name the grid', async () => {
    const socket = new BackendSocket('token')
    const namesSeen: Array<string | null> = []
    socket.onMachineMeta = (n) => { namesSeen.push(n) }
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()

    // The backend's own frame sets it, as always.
    ws.message({ t: 'down', connId: 'web-1', frame: { type: 'machine_meta', payload: { name: 'mac', gridName: 'someone-7f3a91c4' } } })
    await vi.waitFor(() => expect(socket.gridName()).toBe('someone-7f3a91c4'))

    // Now the same frame from a process on this machine, through the local socket — the shape of the
    // leftover script that once redirected this account's agents onto a grid of its choosing.
    const local = 'local:1'
    socket.registerLocalClient(local, { sendFrame: () => true, sendBinary: () => true })
    socket.handleLocalFrame(local, { type: 'machine_meta', payload: { name: 'hijacked', gridName: 'attacker-deadbeef' } })

    // Give the queue a turn: the frame must be dropped whole, so neither half of it lands.
    await new Promise((r) => setTimeout(r, 50))
    expect(socket.gridName()).toBe('someone-7f3a91c4')
    expect(namesSeen).not.toContain('hijacked')

    await socket.stop()
  })

  it('refuses a machine_revoked over the LOCAL socket — one frame would otherwise sign this computer out', async () => {
    const socket = new BackendSocket('token')
    let revoked = 0
    socket.onRevoked = () => { revoked += 1 }
    socket.connect()
    const ws = wsMock.instances[0]
    ws.open()

    // `onRevoked` clears the stored SSO session and exits the daemon, so accepting this from a local
    // process is a one-frame forced sign-out and denial of service.
    const local = 'local:1'
    socket.registerLocalClient(local, { sendFrame: () => true, sendBinary: () => true })
    socket.handleLocalFrame(local, { type: 'machine_revoked', payload: {} })
    await new Promise((r) => setTimeout(r, 50))
    expect(revoked).toBe(0)

    // The backend's own frame still works — the gate is about the sender, not the frame.
    ws.message({ t: 'down', connId: '', frame: { type: 'machine_revoked', payload: {} } })
    await vi.waitFor(() => expect(revoked).toBe(1))

    await socket.stop()
  })
})

/** The read-only hardware line for the run-a-harness-compute dialog, answered next to `grid_models_list`. */

describe('Autonomous direct isolation from existing relay/browser behavior', () => {
  it('permits offline PAKE only for the exact live direct pending connection', async () => {
    const backend = new BackendSocket('direct-offline-test')
    const send = vi.fn()
    backend.attachDirectDevice('autonomous-direct:test', send)
    const pairId = Buffer.alloc(16, 1).toString('base64')
    backend.e2ee.handleFrame('browser', { type: 'e2e_pair_intent', payload: { pairId, role: 'web', label: 'Browser' } })
    expect(await backend.pair('K7P4X9')).toEqual({ ok: false, error: 'BACKEND_DOWN' })
    await backend.receiveDirectDevice('autonomous-direct:test', { type: 'e2e_pair_intent', payload: { pairId, role: 'device', label: 'Autonomous device' } }, true)
    const paired = backend.pair('K7P4X9')
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'e2e_pake' }))
    await backend.receiveDirectDevice('autonomous-direct:test', { type: 'e2e_pair_cancel', payload: { pairId } }, true)
    expect(await paired).toEqual({ ok: false, error: 'CANCELLED' })
    backend.detachDirectDevice('autonomous-direct:test')
  })
  it('never dispatches setup/password/admin/terminal frames from a discovered endpoint', async () => {
    const backend = new BackendSocket('direct-whitelist-test')
    backend.attachDirectDevice('autonomous-direct:test', vi.fn())
    const handle = vi.spyOn(backend.e2ee, 'handleFrame').mockReturnValue(true)
    for (const type of ['e2e_setup_claim', 'e2e_pw_pair_intent', 'e2e_pw_pake', 'terminal_open', 'machine_revoked', '__clients']) {
      await backend.receiveDirectDevice('autonomous-direct:test', { type, payload: {} }, true)
    }
    expect(handle).not.toHaveBeenCalled()
    await backend.receiveDirectDevice('autonomous-direct:test', { type: 'e2e_pair_intent', payload: {} }, false)
    expect(handle).not.toHaveBeenCalled()
    await backend.receiveDirectDevice('autonomous-direct:test', { type: 'e2e_hello', payload: {} }, false)
    expect(handle).toHaveBeenCalledOnce()
    backend.detachDirectDevice('autonomous-direct:test')
  })
})

describe('agent_recent replies', () => {
  // Three long answers — well past the dial's ~15KB frame — as a working agent's recaps are.
  const answer = (turn: number) => `Turn ${turn}: ${'the llama.cpp build is b4521 and '.repeat(250)}`
  const events = [1, 2, 3].map((turn) => ({ kind: 'summary', text: `body ${turn}`, recap: `recap ${turn}`, fullText: answer(turn) }))

  async function recentReplyFor(role: 'web' | 'device') {
    const socket = new BackendSocket('token')
    socket.recentProvider = () => events
    socket.recentAsksProvider = () => ['which llama.cpp build is this?']
    socket.connect()
    const ws = wsMock.instances.at(-1)!
    ws.open()
    vi.spyOn(socket.e2ee, 'unwrapDown').mockReturnValue({ type: 'agent_recent', payload: { requestId: 'recent-1', agentId: 'a1', n: 3 } })
    vi.spyOn(socket.e2ee, 'hasSession').mockReturnValue(true)
    vi.spyOn(socket.e2ee, 'sessionRole').mockReturnValue(role)
    vi.spyOn(socket.e2ee, 'rpcReplyFrameBytes').mockImplementation((_c, _t, _r, payload) => Buffer.byteLength(JSON.stringify(payload)))
    const wrapReply = vi.spyOn(socket.e2ee, 'wrapRpcReply').mockReturnValue({
      type: 'agent_recent_result', payload: { __e2e: { v: 1, k: 's', n: 1, ct: 'ciphertext' } },
    })
    ws.message({ t: 'down', connId: 'conn-1', frame: { type: 'agent_recent', payload: { __e2e: { v: 1, k: 's', n: 1, ct: 'ciphertext' } } } })
    await vi.waitFor(() => expect(wrapReply).toHaveBeenCalled())
    await socket.stop()
    return wrapReply.mock.calls[0][3] as { events: Array<Record<string, unknown>>; asks: string[] }
  }

  it('reaches the phone and a remote desktop whole, full answers included', async () => {
    const reply = await recentReplyFor('web')
    expect(reply.events).toHaveLength(3)
    expect(reply.events[0].fullText).toBe(answer(1))
    expect(reply.asks).toEqual(['which llama.cpp build is this?'])
  })

  it('is still fitted to the dial’s frame for a device', async () => {
    const reply = await recentReplyFor('device')
    expect(reply.events).toHaveLength(1)
    expect(reply.events[0]).not.toHaveProperty('fullText')
  })
})
