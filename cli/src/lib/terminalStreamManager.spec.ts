import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ENGINES } from '../engines/types.js'
import type { RegisteredSession } from './registry.js'
import { TerminalStreamManager, terminalEngineCapabilities } from './terminalStreamManager.js'
import { TERMINAL_ACTION_SUCCEEDED, type TerminalStreamHandle, type TerminalStreamSink } from './terminalTypes.js'
import type { TerminalBackendCoordinator } from './terminalBackendCoordinator.js'
import { TerminalBinaryKind, type TerminalBinaryClear } from './terminalBinary.js'

class FakeStream implements TerminalStreamHandle {
  readonly runtime = { backend: 'tmux' as const, paneId: '%1' }
  writes: Uint8Array[] = []
  sizes: Array<{ cols: number; rows: number }> = []
  scrolls: Array<{ direction: 'up' | 'down'; lines: number }> = []
  closed = false
  snapshots = 0
  snapshotBytes = Buffer.from('\u001bcfixture')
  onSnapshot: ((count: number) => void) | null = null
  pauses = 0
  resumes = 0
  snapshotBegins = 0
  snapshotEnds = 0
  onEndSnapshot: (() => void) | null = null

  beginSnapshot() { this.snapshotBegins++ }
  async snapshot(): Promise<{ state: 'succeeded'; value: { bytes: Uint8Array; cols: number; rows: number } }> {
    this.snapshots++
    this.onSnapshot?.(this.snapshots)
    return { state: 'succeeded', value: { bytes: this.snapshotBytes, cols: 120, rows: 40 } }
  }
  endSnapshot() { this.snapshotEnds++; this.onEndSnapshot?.() }
  async writeRaw(bytes: Uint8Array) { this.writes.push(bytes); return TERMINAL_ACTION_SUCCEEDED }
  async resize(size: { cols: number; rows: number }) { this.sizes.push(size); return TERMINAL_ACTION_SUCCEEDED }
  async scroll(direction: 'up' | 'down', lines: number) { this.scrolls.push({ direction, lines }); return TERMINAL_ACTION_SUCCEEDED }
  async pauseOutput() { this.pauses++; return TERMINAL_ACTION_SUCCEEDED }
  async resumeOutput() { this.resumes++; return TERMINAL_ACTION_SUCCEEDED }
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
  let binarySent: Array<{ connId: string; frame: TerminalBinaryClear }>
  let manager: TerminalStreamManager
  let agents: Map<string, RegisteredSession>
  let outputBeforeOpen: Uint8Array | null

  beforeEach(() => {
    vi.useFakeTimers()
    sink = null
    stream = new FakeStream()
    sent = []
    binarySent = []
    outputBeforeOpen = null
    agents = new Map([['agent-1', session()]])
    const terminals = {
      openStream: async (_session: RegisteredSession, _size: unknown, nextSink: TerminalStreamSink) => {
        sink = nextSink
        if (outputBeforeOpen) nextSink.onData(outputBeforeOpen)
        return { state: 'succeeded' as const, value: stream }
      },
    } as unknown as TerminalBackendCoordinator
    manager = new TerminalStreamManager({
      terminals,
      resolveAgent: (id) => agents.get(id),
      sendTarget: (connId, type, payload) => { sent.push({ connId, type, payload }); return true },
      sendBinaryTarget: (connId, frame) => { binarySent.push({ connId, frame }); return true },
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
        requestId: `open-${index}`, protocolVersion: 3, agentId, cols: 100, rows: 30,
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
      requestId: 'unsupported', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    expect(sent.at(-1)?.payload.code).toBe('TERMINAL_ENGINE_UNSUPPORTED')
  })

  it('rejects an unknown agent without opening a stream', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'missing', protocolVersion: 3, agentId: 'does-not-exist', cols: 100, rows: 30,
    })
    expect(sent.at(-1)?.payload.code).toBe('TERMINAL_AGENT_NOT_FOUND')
  })

  it('opens with a keyframe, streams coalesced output, and writes ordered raw input', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 120, rows: 40, compression: ['zlib'],
    })
    expect(sent.map((frame) => frame.type)).toEqual(['terminal_ready'])
    expect(binarySent.map(({ frame }) => frame.kind)).toEqual([TerminalBinaryKind.keyframe])
    const streamId = sent[0].payload.streamId as string

    sink!.onData(Buffer.from('hello'))
    await vi.advanceTimersByTimeAsync(8)
    expect(binarySent.at(-1)?.frame.kind).toBe(TerminalBinaryKind.output)
    expect(binarySent.at(-1)?.frame.seq).toBe(1)

    await manager.handleBinary('web-1', {
      kind: TerminalBinaryKind.input, streamId, seq: 0, compressed: false, bytes: Buffer.from('abc'),
    })
    expect(Buffer.from(stream.writes[0]).toString()).toBe('abc')
    await manager.handleBinary('web-1', {
      kind: TerminalBinaryKind.input, streamId, seq: 2, compressed: false, bytes: Buffer.from('out-of-order'),
    })
    expect(stream.writes).toHaveLength(1)
    expect(sent.at(-1)?.payload.code).toBe('TERMINAL_INPUT_INVALID')

    const mouse = Buffer.from('\u001b[<0;12;8M')
    await manager.handleBinary('web-1', {
      kind: TerminalBinaryKind.input, streamId, seq: 1, compressed: false, bytes: mouse,
    })
    expect(Buffer.from(stream.writes.at(-1)!).equals(mouse)).toBe(true)

    await manager.handleFrame('web-1', 'terminal_resize', {
      streamId, resizeSeq: 0, cols: 140, rows: 50,
    })
    expect(stream.sizes.at(-1)).toEqual({ cols: 140, rows: 50 })
  })

  it('routes terminal_scroll to the stream handle, and rejects a malformed one', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-scroll', protocolVersion: 3, agentId: 'agent-1', cols: 120, rows: 40,
    })
    const streamId = sent[0].payload.streamId as string

    await manager.handleFrame('web-1', 'terminal_scroll', { streamId, direction: 'up', lines: 3 })
    expect(stream.scrolls.at(-1)).toEqual({ direction: 'up', lines: 3 })

    await manager.handleFrame('web-1', 'terminal_scroll', { streamId, direction: 'sideways', lines: 3 })
    expect(stream.scrolls).toHaveLength(1)
    expect(sent.at(-1)?.payload.code).toBe('TERMINAL_SCROLL_INVALID')

    await manager.handleFrame('web-1', 'terminal_scroll', { streamId, direction: 'down', lines: 0 })
    expect(stream.scrolls).toHaveLength(1)
    expect(sent.at(-1)?.payload.code).toBe('TERMINAL_SCROLL_INVALID')
  })

  it('does not replay pre-snapshot repaint bytes after the authoritative keyframe', async () => {
    outputBeforeOpen = Buffer.from('\u001b[2Jstale repaint')
    stream.snapshotBytes = Buffer.from('\u001bcnew prompt text')

    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-snapshot', protocolVersion: 3, agentId: 'agent-1', cols: 120, rows: 40,
    })
    await vi.advanceTimersByTimeAsync(20)

    expect(sent.map((frame) => frame.type)).toEqual(['terminal_ready'])
    expect(binarySent.map(({ frame }) => frame.kind)).toEqual([TerminalBinaryKind.keyframe])
    expect(binarySent[0].frame.seq).toBe(0)
  })

  it('takes one ordered snapshot and releases its output gate after the keyframe', async () => {
    stream.snapshotBytes = Buffer.from('\u001bcnew prompt text')

    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-racing-snapshot', protocolVersion: 3, agentId: 'agent-1', cols: 120, rows: 40,
    })
    await vi.advanceTimersByTimeAsync(20)

    expect(stream.snapshots).toBe(1)
    expect(stream.snapshotBegins).toBe(1)
    expect(stream.snapshotEnds).toBe(1)
    expect(sent.map((frame) => frame.type)).toEqual(['terminal_ready'])
    expect(binarySent.map(({ frame }) => frame.kind)).toEqual([TerminalBinaryKind.keyframe])
    expect(binarySent[0].frame.seq).toBe(0)
  })

  it('takes over the first controller and expires the replacement lease after heartbeat timeout', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    const firstStream = stream
    const firstStreamId = sent.findLast((frame) => frame.type === 'terminal_ready')?.payload.streamId as string
    await manager.handleFrame('web-2', 'terminal_open', {
      requestId: 'open-2', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    expect(firstStream.closed).toBe(true)
    expect(sent.some((frame) => frame.connId === 'web-1'
      && frame.type === 'terminal_closed'
      && frame.payload.code === 'TERMINAL_TAKEN_OVER')).toBe(true)
    expect(sent.findLast((frame) => frame.type === 'terminal_ready')?.connId).toBe('web-2')
    await manager.handleBinary('web-1', {
      kind: TerminalBinaryKind.input,
      streamId: firstStreamId,
      seq: 0,
      compressed: false,
      bytes: Buffer.from('stale input'),
    })
    expect(stream.writes).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(stream.closed).toBe(true)
    expect(sent.some((frame) => frame.connId === 'web-2'
      && frame.type === 'terminal_closed'
      && frame.payload.reason === 'heartbeat timeout')).toBe(true)
  })

  it('takes over a second agent alias that resolves to the same tmux pane', async () => {
    agents.set('agent-alias', session('claude', 'agent-alias'))
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    await manager.handleFrame('web-2', 'terminal_open', {
      requestId: 'open-2', protocolVersion: 3, agentId: 'agent-alias', cols: 100, rows: 30,
    })
    expect(sent.some((frame) => frame.connId === 'web-1'
      && frame.type === 'terminal_closed'
      && frame.payload.code === 'TERMINAL_TAKEN_OVER')).toBe(true)
    expect(sent.findLast((frame) => frame.type === 'terminal_ready')?.connId).toBe('web-2')
  })

  it('keeps a client\'s other terminals alive when it opens another one', async () => {
    // The desktop app's pane grid: one connection, several agents, each its own tmux window.
    agents.set('agent-2', {
      ...session('claude', 'agent-2'),
      runtimes: [{ backend: 'tmux', paneId: '%2' }],
      primaryRuntimeKey: 'tmux:default:%2',
    } as unknown as RegisteredSession)

    await manager.handleFrame('app-1', 'terminal_open', {
      requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    const first = sent.find((frame) => frame.type === 'terminal_ready')?.payload.streamId as string

    await manager.handleFrame('app-1', 'terminal_open', {
      requestId: 'open-2', protocolVersion: 3, agentId: 'agent-2', cols: 100, rows: 30,
    })

    // Observed through a resize rather than a close frame: replacing a stream is deliberately
    // silent, so the only way to tell a live stream from a dead one is whether it still acts.
    const before = stream.sizes.length
    await manager.handleFrame('app-1', 'terminal_resize', {
      streamId: first, resizeSeq: 1, cols: 90, rows: 25,
    })
    expect(stream.sizes.length).toBe(before + 1)
  })

  it('still replaces its own stream when the same terminal is reopened', async () => {
    await manager.handleFrame('app-1', 'terminal_open', {
      requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    const first = sent.find((frame) => frame.type === 'terminal_ready')?.payload.streamId as string

    await manager.handleFrame('app-1', 'terminal_open', {
      requestId: 'open-2', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })

    // Two tmux clients on one window is the thing this must never allow.
    const before = stream.sizes.length
    await manager.handleFrame('app-1', 'terminal_resize', {
      streamId: first, resizeSeq: 1, cols: 90, rows: 25,
    })
    expect(stream.sizes.length).toBe(before)
  })

  it('uses frequent ACKs rather than the five-second heartbeat for output backpressure', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    const streamId = sent[0].payload.streamId as string
    await manager.handleFrame('web-1', 'terminal_ack', { streamId, lastSeq: binarySent[0].frame.seq })
    for (let i = 0; i < 40; i++) {
      sink!.onData(Buffer.alloc(32 * 1024, i))
      const output = binarySent.at(-1)!.frame
      expect(output.kind).toBe(TerminalBinaryKind.output)
      await manager.handleFrame('web-1', 'terminal_ack', { streamId, lastSeq: output.seq })
    }
    expect(binarySent.filter(({ frame }) => frame.kind === TerminalBinaryKind.keyframe)).toHaveLength(1)
    expect(stream.pauses).toBe(0)
  })

  it('emits an ordered sync frame every five seconds while idle', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-sync', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(binarySent.map(({ frame }) => frame.kind)).toEqual([
      TerminalBinaryKind.keyframe,
      TerminalBinaryKind.sync,
    ])
    expect(binarySent[1].frame.seq).toBe(1)
    expect(binarySent[1].frame.bytes).toHaveLength(0)
    expect(binarySent[1].frame.compressed).toBe(false)
  })

  it('fails closed when pending plus queued output exceeds two MiB', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-overflow', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    sink!.onData(Buffer.alloc(2 * 1024 * 1024))
    await vi.advanceTimersByTimeAsync(1)
    expect(sent.findLast((frame) => frame.type === 'terminal_error')?.payload.code)
      .toBe('TERMINAL_OUTPUT_OVERFLOW')
    expect(stream.closed).toBe(true)
  })

  it('forwards only output released after the ordered snapshot cut', async () => {
    stream.onEndSnapshot = () => sink!.onData(Buffer.from('post-cut'))
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-cut', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    await vi.advanceTimersByTimeAsync(8)
    expect(binarySent.map(({ frame }) => frame.kind)).toEqual([
      TerminalBinaryKind.keyframe,
      TerminalBinaryKind.output,
    ])
    expect(Buffer.from(binarySent[1].frame.bytes).toString()).toBe('post-cut')
  })

  it('pauses PTY output above the high watermark and resumes below the low watermark', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    const streamId = sent[0].payload.streamId as string
    await manager.handleFrame('web-1', 'terminal_ack', { streamId, lastSeq: binarySent[0].frame.seq })
    for (let i = 0; i < 13; i++) sink!.onData(Buffer.alloc(32 * 1024, i))
    await vi.advanceTimersByTimeAsync(1)
    expect(stream.pauses).toBe(1)
    expect(stream.resumes).toBe(0)
    sink!.onData(Buffer.from('buffered-while-renderer-paused'))
    const outputs = binarySent.filter(({ frame }) => frame.kind === TerminalBinaryKind.output)
    await manager.handleFrame('web-1', 'terminal_ack', { streamId, lastSeq: outputs[9].frame.seq })
    await vi.advanceTimersByTimeAsync(8)
    expect(stream.resumes).toBe(1)
    expect(Buffer.from(binarySent.at(-1)!.frame.bytes).toString()).toBe('buffered-while-renderer-paused')
    expect(binarySent.filter(({ frame }) => frame.kind === TerminalBinaryKind.keyframe)).toHaveLength(1)
  })

  it('closes a stream whose renderer stays stalled after tmux is paused', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-stall', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    const streamId = sent[0].payload.streamId as string
    await manager.handleFrame('web-1', 'terminal_ack', { streamId, lastSeq: binarySent[0].frame.seq })
    for (let i = 0; i < 13; i++) sink!.onData(Buffer.alloc(32 * 1024, i))
    expect(stream.pauses).toBe(1)

    await vi.advanceTimersByTimeAsync(10_000)

    expect(sent.findLast((frame) => frame.type === 'terminal_error')?.payload.code)
      .toBe('TERMINAL_RENDER_STALLED')
    expect(stream.closed).toBe(true)
  })

  it('fails closed instead of emitting an oversized binary keyframe', async () => {
    stream.snapshotBytes = Buffer.alloc(481 * 1024, 0x61)
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'oversized', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    expect(stream.snapshots).toBe(1)
    expect(binarySent.some(({ frame }) => frame.kind === TerminalBinaryKind.keyframe)).toBe(false)
    expect(sent.findLast((frame) => frame.type === 'terminal_error')?.payload.code)
      .toBe('TERMINAL_SNAPSHOT_TOO_LARGE')
    expect(stream.closed).toBe(true)
  })

  it('disconnect cleanup closes the stream and releases the controller', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-1', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    await manager.closeConnection('web-1')
    expect(stream.closed).toBe(true)
    const replacement = new FakeStream()
    stream = replacement
    await manager.handleFrame('web-2', 'terminal_open', {
      requestId: 'open-2', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    expect(sent.at(-1)?.type).toBe('terminal_ready')
    expect(binarySent.at(-1)?.frame.kind).toBe(TerminalBinaryKind.keyframe)
  })
  it('sends the first output after a quiet gap without waiting for the coalescing window', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-echo', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    const before = binarySent.length

    // A keystroke echo: no timers advanced at all.
    sink!.onData(Buffer.from('a'))
    expect(binarySent.length).toBe(before + 1)
    expect(binarySent.at(-1)?.frame.kind).toBe(TerminalBinaryKind.output)
    expect(Buffer.from(binarySent.at(-1)!.frame.bytes).toString()).toBe('a')
  })

  it('still coalesces a burst onto the trailing window', async () => {
    await manager.handleFrame('web-1', 'terminal_open', {
      requestId: 'open-burst', protocolVersion: 3, agentId: 'agent-1', cols: 100, rows: 30,
    })
    sink!.onData(Buffer.from('lead'))
    const afterLeadingEdge = binarySent.length

    // Everything arriving inside the window rides one frame, not one frame each.
    sink!.onData(Buffer.from('one'))
    sink!.onData(Buffer.from('two'))
    sink!.onData(Buffer.from('three'))
    expect(binarySent.length).toBe(afterLeadingEdge)

    await vi.advanceTimersByTimeAsync(8)
    expect(binarySent.length).toBe(afterLeadingEdge + 1)
    expect(Buffer.from(binarySent.at(-1)!.frame.bytes).toString()).toBe('onetwothree')
  })
})
