import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { BackendSocket, compactRuntimePickerModels, deviceAgentListItem, grokHistoryPage } from './backendSocket.js'
import type { TerminalStreamManager } from './lib/terminalStreamManager.js'
import { decodeTerminalLocal, TerminalBinaryKind } from './lib/terminalBinary.js'
import { registry, type RegisteredSession } from './lib/registry.js'

const wsMock = vi.hoisted(() => {
  const instances: MockWebSocket[] = []

  class MockWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSED = 3
    readyState = MockWebSocket.CONNECTING
    sent: string[] = []
    failNextSend: Error | null = null
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>()

    constructor(readonly url: string, readonly protocols: string[]) {
      instances.push(this)
    }

    on(event: string, cb: (...args: unknown[]) => void): this {
      const list = this.handlers.get(event) ?? []
      list.push(cb)
      this.handlers.set(event, list)
      return this
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

    terminate(): void {
      this.close()
    }

    ping(): void {
      this.emit('pong')
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
      type: 'models_list', payload: { requestId: 'local-models' },
    })
    await vi.waitFor(() => expect(frames).toContainEqual({
      type: 'models_list_result',
      payload: {
        requestId: 'local-models',
        models: [{ id: 'runtime-v1:s1:codex:gpt-5.6-sol@high', displayName: 'Sol / High' }],
      },
    }))

    await socket.unregisterLocalClient('local:test')
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
