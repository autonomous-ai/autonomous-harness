import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ENGINES } from '../engines/types.js'
import type { RegisteredSession } from './registry.js'
import { TerminalStreamManager, terminalEngineCapabilities } from './terminalStreamManager.js'
import { TERMINAL_ACTION_SUCCEEDED, type TerminalStreamHandle, type TerminalStreamSink } from './terminalTypes.js'
import type { TerminalBackendCoordinator } from './terminalBackendCoordinator.js'

class FakeStream implements TerminalStreamHandle {
  readonly runtime = { backend: 'tmux' as const, paneId: '%1' }
  writes: Uint8Array[] = []
  sizes: Array<{ cols: number; rows: number }> = []
  closed = false
  snapshots = 0
  snapshotHistory: number[] = []
  snapshotBytes = Buffer.from('\u001bcfixture')

  async snapshot(historyLines: number): Promise<{ state: 'succeeded'; value: { bytes: Uint8Array; cols: number; rows: number } }> {
    this.snapshots++
    this.snapshotHistory.push(historyLines)
    return { state: 'succeeded', value: { bytes: this.snapshotBytes, cols: 120, rows: 40 } }
  }
  async writeRaw(bytes: Uint8Array) { this.writes.push(bytes); return TERMINAL_ACTION_SUCCEEDED }
  async resize(size: { cols: number; rows: number }) { this.sizes.push(size); return TERMINAL_ACTION_SUCCEEDED }
  async close(): Promise<void> { this.closed = true }
}

function session(engine: string = 'codex', agentId = 'agent-1'): RegisteredSession {
  return {
    agentId, sessionId: `session-${agentId}`, engine, active: true,
    registeredAt: Date.now(), updatedAt: Date.now(), runtimes: [{ backend: 'tmux', paneId: '%1' }],
    primaryRuntimeKey: 'tmux:default:%1',
  } as unknown as RegisteredSession
}

describe('TerminalStreamManager', () => {
  let sink: TerminalStreamSink | null
  let stream: FakeStream
  let sent: Array<{ connId: string; type: string; payload: Record<string, unknown> }>
  let manager: TerminalStreamManager
  let agents: Map<string, RegisteredSession>

  beforeEach(() => {
    vi.useFakeTimers()
    sink = null
    stream = new FakeStream()
    sent = []
    agents = new Map([['agent-1', session()]])
    const terminals = {
      openStream: async (_session: RegisteredSession, _size: unknown, nextSink: TerminalStreamSink) => {
        sink = nextSink
        return { state: 'succeeded' as const, value: stream }
      },
    } as unknown as TerminalBackendCoordinator
    manager = new TerminalStreamManager({
      terminals,
      resolveAgent: (id) => agents.get(id),
      sendTarget: (connId, type, payload) => { sent.push({ connId, type, payload }); return true },
      streamingAvailable: true,
      now: () => Date.now(),
    })
  })

  afterEach(async () => {
    await manager.stop()
    vi.useRealTimers()
  })

  it('publishes the complete engine catalog without a client whitelist', async () => {
    await manager.handleFrame('web-1', 'terminal_capabilities', { requestId: 'r1' })
    const result = sent.at(-1)!
    expect(result.type).toBe('terminal_capabilities_result')
    expect((result.payload.engines as Array<{ id: string }>).map((row) => row.id)).toEqual([...ENGINES])
  })

  it('uses the same generic path for every current engine', async () => {
    for (const [index, engine] of ENGINES.entries()) {
      const agentId = `agent-generic-${index}`
      agents.set(agentId, session(engine, agentId))
      await manager.handleFrame('web-1', 'terminal_open', {
        requestId: `open-${index}`, protocolVersion: 1, agentId, cols: 100, rows: 30,
      })
      const ready = sent.findLast((frame) => frame.type === 'terminal_ready')
      expect(ready?.payload.agentId).toBe(agentId)
      expect(ready?.payload.engineId).toBe(engine)
    }
  })

  it('automatically publishes a future engine once the source catalog contains it', () => {
    const futureCatalog = [...ENGINES, 'future-engine-added-later']
    expect(terminalEngineCapabilities(true, futureCatalog).map((row) => row.id)).toEqual(futureCatalog)
  })

  it('fails closed for an engine that is not in the current source catalog', async () => {
    const unsafe = session('claude') as unknown as { engine: string }
    unsafe.engine = 'hostile-unregistered-engine'
    agents.set('agent-1', unsafe as unknown as RegisteredSession)
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'unsupported', protocolVersion: 1, agentId: 'agent-1', cols: 100, rows: 30,
    })
    expect(sent.at(-1)?.payload.code).toBe('TERMINAL_ENGINE_UNSUPPORTED')
  })

  it('rejects an unknown agent without opening a stream', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'missing', protocolVersion: 1, agentId: 'does-not-exist', cols: 100, rows: 30,
    })
    expect(sent.at(-1)?.payload.code).toBe('TERMINAL_AGENT_NOT_FOUND')
  })

  it('opens with a keyframe, streams coalesced output, and writes ordered raw input', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-1', protocolVersion: 1, agentId: 'agent-1', cols: 120, rows: 40, compression: ['zlib'],
    })
    expect(sent.map((frame) => frame.type)).toEqual(['terminal_ready', 'terminal_keyframe'])
    const streamId = sent[0].payload.streamId as string

    sink!.onData(Buffer.from('hello'))
    await vi.advanceTimersByTimeAsync(8)
    expect(sent.at(-1)?.type).toBe('terminal_output')
    expect(sent.at(-1)?.payload.seq).toBe(1)

    await manager.handleFrame('web-1', 'terminal_input', {
      streamId, inputSeq: 0, data: Buffer.from('abc').toString('base64'),
    })
    expect(Buffer.from(stream.writes[0]).toString()).toBe('abc')
    await manager.handleFrame('web-1', 'terminal_input', {
      streamId, inputSeq: 2, data: Buffer.from('out-of-order').toString('base64'),
    })
    expect(stream.writes).toHaveLength(1)
    expect(sent.at(-1)?.payload.code).toBe('TERMINAL_INPUT_INVALID')

    const mouse = Buffer.from('\u001b[<0;12;8M')
    await manager.handleFrame('web-1', 'terminal_input', {
      streamId, inputSeq: 1, data: mouse.toString('base64'),
    })
    expect(Buffer.from(stream.writes.at(-1)!).equals(mouse)).toBe(true)

    await manager.handleFrame('web-1', 'terminal_resize', {
      streamId, resizeSeq: 0, cols: 140, rows: 50,
    })
    expect(stream.sizes.at(-1)).toEqual({ cols: 140, rows: 50 })
  })

  it('rejects a second controller and expires the first lease after heartbeat timeout', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-1', protocolVersion: 1, agentId: 'agent-1', cols: 100, rows: 30,
    })
    await manager.handleFrame('web-2', 'terminal_open', {
      requestId: 'open-2', protocolVersion: 1, agentId: 'agent-1', cols: 100, rows: 30,
    })
    expect(sent.at(-1)?.payload.code).toBe('CONTROL_LEASE_HELD')

    await vi.advanceTimersByTimeAsync(30_000)
    expect(stream.closed).toBe(true)
    expect(sent.some((frame) => frame.type === 'terminal_closed' && frame.payload.reason === 'heartbeat timeout')).toBe(true)
  })

  it('rejects a second agent alias that resolves to the same tmux pane', async () => {
    agents.set('agent-alias', session('claude', 'agent-alias'))
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-1', protocolVersion: 1, agentId: 'agent-1', cols: 100, rows: 30,
    })
    await manager.handleFrame('web-2', 'terminal_open', {
      requestId: 'open-2', protocolVersion: 1, agentId: 'agent-alias', cols: 100, rows: 30,
    })
    expect(sent.at(-1)?.payload.code).toBe('CONTROL_LEASE_HELD')
  })

  it('uses frequent ACKs rather than the five-second heartbeat for output backpressure', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-1', protocolVersion: 1, agentId: 'agent-1', cols: 100, rows: 30,
    })
    const streamId = sent[0].payload.streamId as string
    for (let i = 0; i < 40; i++) {
      sink!.onData(Buffer.alloc(32 * 1024, i))
      const output = sent.at(-1)!
      expect(output.type).toBe('terminal_output')
      await manager.handleFrame('web-1', 'terminal_ack', { streamId, lastSeq: output.payload.seq })
    }
    expect(sent.filter((frame) => frame.type === 'terminal_keyframe')).toHaveLength(1)
  })

  it('bounds unacked output by replacing the backlog with a keyframe', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-1', protocolVersion: 1, agentId: 'agent-1', cols: 100, rows: 30,
    })
    for (let i = 0; i < 33; i++) sink!.onData(Buffer.alloc(32 * 1024, i))
    await vi.advanceTimersByTimeAsync(1)
    expect(stream.snapshots).toBeGreaterThanOrEqual(2)
    expect(sent.filter((frame) => frame.type === 'terminal_keyframe').length).toBeGreaterThanOrEqual(2)
  })

  it('fails closed instead of emitting an oversized doubly-base64 keyframe', async () => {
    stream.snapshotBytes = Buffer.alloc(241 * 1024, 0x61)
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'oversized', protocolVersion: 1, agentId: 'agent-1', cols: 100, rows: 30,
    })
    expect(stream.snapshotHistory).toEqual([1_000, 500, 250, 100, 0])
    expect(sent.some((frame) => frame.type === 'terminal_keyframe')).toBe(false)
    expect(sent.findLast((frame) => frame.type === 'terminal_error')?.payload.code)
      .toBe('TERMINAL_SNAPSHOT_TOO_LARGE')
    expect(stream.closed).toBe(true)
  })

  it('disconnect cleanup closes the stream and releases the controller', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-1', protocolVersion: 1, agentId: 'agent-1', cols: 100, rows: 30,
    })
    await manager.closeConnection('web-1')
    expect(stream.closed).toBe(true)
    const replacement = new FakeStream()
    stream = replacement
    await manager.handleFrame('web-2', 'terminal_open', {
      requestId: 'open-2', protocolVersion: 1, agentId: 'agent-1', cols: 100, rows: 30,
    })
    expect(sent.at(-2)?.type).toBe('terminal_ready')
  })
})
