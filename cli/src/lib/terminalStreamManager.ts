import { randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { ENGINES } from '../engines/types.js'
import type { RegisteredSession } from './registry.js'
import type { TerminalBackendCoordinator } from './terminalBackendCoordinator.js'
import { terminalPlacementKey, terminalRouteKey } from './terminalRuntime.js'
import type { TerminalStreamHandle, TerminalStreamSize } from './terminalTypes.js'
import { TerminalBinaryKind, type TerminalBinaryClear } from './terminalBinary.js'

type FramePayload = Record<string, unknown>

const PROTOCOL_VERSION = 3
const HEARTBEAT_TIMEOUT_MS = 30_000
const SYNC_INTERVAL_MS = 5_000
const OUTPUT_FLUSH_MS = 8
const OUTPUT_CHUNK_BYTES = 32 * 1024
const INPUT_MAX_BYTES = 64 * 1024
const PAUSE_HIGH_WATERMARK_BYTES = 384 * 1024
const RESUME_LOW_WATERMARK_BYTES = 128 * 1024
const RENDER_STALL_TIMEOUT_MS = 10_000
const MAX_TOTAL_BUFFERED_BYTES = 2 * 1024 * 1024
const KEYFRAME_MAX_BYTES = 480 * 1024
const TERMINAL_ENGINES: ReadonlySet<string> = new Set(ENGINES)

interface PendingOutput {
  seq: number
  bytes: number
}

interface ActiveStream {
  connId: string
  streamId: string
  agentId: string
  engineId: string
  placementKey: string
  handle: TerminalStreamHandle
  compression: 'none' | 'zlib'
  expiresAt: number
  lastSyncAt: number
  nextSeq: number
  lastInputSeq: number
  lastResizeSeq: number
  pending: PendingOutput[]
  pendingBytes: number
  output: Buffer[]
  outputBytes: number
  flushTimer: ReturnType<typeof setTimeout> | null
  lastFlushAt: number
  snapshotting: boolean
  resyncing: boolean
  closing: boolean
  outputPaused: boolean
  stallTimer: ReturnType<typeof setTimeout> | null
  openedAt: number
  outputFrames: number
  outputPlainBytes: number
  keyframes: number
  syncFrames: number
  resyncs: number
  peakBufferedBytes: number
  pausedAt: number | null
  pausedMs: number
}

export interface TerminalStreamManagerDeps {
  terminals: TerminalBackendCoordinator
  resolveAgent: (agentId: string) => RegisteredSession | undefined
  sendTarget: (connId: string, type: string, payload: FramePayload) => boolean
  sendBinaryTarget: (connId: string, frame: TerminalBinaryClear) => boolean
  streamingAvailable: boolean
  now?: () => number
  diagnostic?: (event: string, fields: Record<string, unknown>) => void
}

function sizeFrom(payload: FramePayload): TerminalStreamSize | null {
  const cols = Number(payload.cols)
  const rows = Number(payload.rows)
  if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < 40 || cols > 300 || rows < 12 || rows > 120) return null
  return { cols, rows }
}

function encoded(bytes: Uint8Array, compression: 'none' | 'zlib'): { compressed: boolean; bytes: Uint8Array; plainBytes: number } {
  const raw = Buffer.from(bytes)
  if (compression === 'zlib' && raw.length > 1024) {
    const compressed = deflateSync(raw, { level: 1 })
    if (compressed.length < raw.length) return { compressed: true, bytes: compressed, plainBytes: raw.length }
  }
  return { compressed: false, bytes: raw, plainBytes: raw.length }
}

export function terminalEngineCapabilities(
  streamingAvailable: boolean,
  engines: readonly string[] = ENGINES,
): Array<{ id: string; terminalStreaming: boolean; unavailableReason?: string }> {
  return engines.map((id) => ({
    id,
    terminalStreaming: streamingAvailable,
    ...(!streamingAvailable ? { unavailableReason: 'tmux streaming backend unavailable' } : {}),
  }))
}

export class TerminalStreamManager {
  private readonly streams = new Map<string, ActiveStream>()
  private readonly controllerByAgent = new Map<string, string>()
  private readonly controllerByPlacement = new Map<string, string>()
  // Terminal opens from different backend connections can arrive concurrently. Serialize opens for
  // the same tmux placement so takeover is deterministic and never leaves two live controllers.
  private readonly leaseLocks = new Map<string, Promise<void>>()
  private readonly now: () => number
  private readonly expiryTimer: ReturnType<typeof setInterval>

  constructor(private readonly deps: TerminalStreamManagerDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.expiryTimer = setInterval(() => this.expireLeases(), 5_000)
    this.expiryTimer.unref?.()
  }

  private async withLeaseLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.leaseLocks.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    this.leaseLocks.set(key, current)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.leaseLocks.get(key) === current) this.leaseLocks.delete(key)
    }
  }

  async handleFrame(connId: string, type: string, payload: FramePayload): Promise<boolean> {
    switch (type) {
      case 'terminal_capabilities':
        this.capabilities(connId, payload.requestId)
        return true
      case 'terminal_open':
        await this.open(connId, payload)
        return true
      case 'terminal_alive':
        this.alive(connId, payload)
        return true
      case 'terminal_ack':
        this.ack(connId, payload)
        return true
      case 'terminal_input':
        this.sendError(connId, 'TERMINAL_BINARY_REQUIRED', { streamId: typeof payload.streamId === 'string' ? payload.streamId : undefined })
        return true
      case 'terminal_resize':
        await this.resize(connId, payload)
        return true
      case 'terminal_scroll':
        await this.scroll(connId, payload)
        return true
      case 'terminal_resync':
        await this.resyncRequested(connId, payload)
        return true
      case 'terminal_close':
        await this.closeRequested(connId, payload)
        return true
      default:
        return false
    }
  }

  async handleBinary(connId: string, frame: TerminalBinaryClear): Promise<void> {
    if (frame.kind !== TerminalBinaryKind.input) return
    const state = this.streams.get(frame.streamId)
    if (!state || state.connId !== connId || state.closing) return
    await this.input(state, frame.seq, frame.bytes)
  }

  private capabilities(connId: string, requestId: unknown): void {
    this.deps.sendTarget(connId, 'terminal_capabilities_result', {
      requestId,
      protocolVersion: PROTOCOL_VERSION,
      backend: 'tmux',
      available: this.deps.streamingAvailable,
      features: {
        rawInput: true,
        resize: true,
        mouse: true,
        keyframe: true,
        sync: true,
        compression: ['none', 'zlib'],
      },
      engines: terminalEngineCapabilities(this.deps.streamingAvailable),
    })
  }

  private sendError(connId: string, code: string, options: { streamId?: string; requestId?: unknown; message?: string } = {}): void {
    this.deps.sendTarget(connId, 'terminal_error', {
      protocolVersion: PROTOCOL_VERSION,
      code,
      ...options,
    })
  }

  private async open(connId: string, payload: FramePayload): Promise<void> {
    const requestId = payload.requestId
    if (payload.protocolVersion !== PROTOCOL_VERSION) {
      this.sendError(connId, 'TERMINAL_PROTOCOL_UNSUPPORTED', { requestId })
      return
    }
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
    const size = sizeFrom(payload)
    if (!agentId || !size) {
      this.sendError(connId, 'TERMINAL_OPEN_INVALID', { requestId })
      return
    }
    if (!this.deps.streamingAvailable) {
      this.sendError(connId, 'TERMINAL_RUNTIME_UNAVAILABLE', { requestId })
      return
    }
    const session = this.deps.resolveAgent(agentId)
    if (!session) {
      this.sendError(connId, 'TERMINAL_AGENT_NOT_FOUND', { requestId })
      return
    }
    if (!TERMINAL_ENGINES.has(session.engine)) {
      this.sendError(connId, 'TERMINAL_ENGINE_UNSUPPORTED', { requestId })
      return
    }
    const streamRuntime = session.runtimes.find((runtime) => runtime.backend === 'tmux'
      && terminalRouteKey(runtime) === session.primaryRuntimeKey)
      ?? session.runtimes.find((runtime) => runtime.backend === 'tmux')
    if (!streamRuntime) {
      this.sendError(connId, 'TERMINAL_RUNTIME_UNAVAILABLE', { requestId })
      return
    }
    const reservedPlacement = terminalPlacementKey(streamRuntime)
    await this.withLeaseLock(reservedPlacement, async () => {
      // A terminal is single-controller. A later client explicitly wins the lease and the incumbent
      // receives a targeted close notification; it must not be broadcast to other clients.
      await this.closeStreamsForTakeover(session.agentId, reservedPlacement, connId)
      // Only THIS connection's stream for THIS terminal, not every stream it holds.
      //
      // It used to be closeConnection(connId), i.e. "opening a terminal ends every other terminal
      // this client had". That was invisible while a client could only ever show one terminal at a
      // time. A client showing several — the desktop app's pane grid — opens a second agent on the
      // same connection, and the blanket close killed the FIRST agent's stream a few milliseconds
      // after handing it its opening keyframe. The pane kept rendering that stale keyframe and
      // looked alive, but its session never reached `controlling`, so every keystroke into it was
      // dropped in silence.
      await this.closeOwnStreamsFor(connId, session.agentId, reservedPlacement)
      this.controllerByAgent.set(session.agentId, connId)
      this.controllerByPlacement.set(reservedPlacement, connId)
      const streamId = randomUUID()
      const buffered: Buffer[] = []
      let state: ActiveStream | null = null
      let opened: Awaited<ReturnType<TerminalBackendCoordinator['openStream']>>
      try {
        opened = await this.deps.terminals.openStream(session, size, {
          onData: (bytes) => {
            if (state) this.onOutput(state, bytes)
            else buffered.push(Buffer.from(bytes))
          },
          onClose: (reason) => {
            if (state) void this.closeStream(state, reason, true)
          },
        })
      } catch {
        if (this.controllerByAgent.get(session.agentId) === connId) this.controllerByAgent.delete(session.agentId)
        if (this.controllerByPlacement.get(reservedPlacement) === connId) this.controllerByPlacement.delete(reservedPlacement)
        this.sendError(connId, 'TERMINAL_OPEN_FAILED', { requestId })
        return
      }
      if (opened.state !== 'succeeded') {
        if (this.controllerByAgent.get(session.agentId) === connId) this.controllerByAgent.delete(session.agentId)
        if (this.controllerByPlacement.get(reservedPlacement) === connId) this.controllerByPlacement.delete(reservedPlacement)
        this.sendError(connId, opened.reason, { requestId })
        return
      }

      const placementKey = terminalPlacementKey(opened.value.runtime)
      const actualController = this.controllerByPlacement.get(placementKey)
      if (actualController && actualController !== connId) {
        if (this.controllerByAgent.get(session.agentId) === connId) this.controllerByAgent.delete(session.agentId)
        if (this.controllerByPlacement.get(reservedPlacement) === connId) this.controllerByPlacement.delete(reservedPlacement)
        await opened.value.close().catch(() => { /* best effort */ })
        this.sendError(connId, 'CONTROL_LEASE_HELD', { requestId })
        return
      }
      if (reservedPlacement !== placementKey && this.controllerByPlacement.get(reservedPlacement) === connId) {
        this.controllerByPlacement.delete(reservedPlacement)
      }
      this.controllerByPlacement.set(placementKey, connId)

      const requestedCompression = Array.isArray(payload.compression) ? payload.compression : []
      state = {
        connId,
        streamId,
        agentId: session.agentId,
        engineId: session.engine,
        placementKey,
        handle: opened.value,
        compression: requestedCompression.includes('zlib') ? 'zlib' : 'none',
        expiresAt: this.now() + HEARTBEAT_TIMEOUT_MS,
        lastSyncAt: this.now(),
        nextSeq: 0,
        lastInputSeq: -1,
        lastResizeSeq: -1,
        pending: [],
        pendingBytes: 0,
        output: buffered,
        outputBytes: buffered.reduce((sum, chunk) => sum + chunk.length, 0),
        flushTimer: null,
        lastFlushAt: 0,
        snapshotting: false,
        resyncing: false,
        closing: false,
        outputPaused: false,
        stallTimer: null,
        openedAt: this.now(),
        outputFrames: 0,
        outputPlainBytes: 0,
        keyframes: 0,
        syncFrames: 0,
        resyncs: 0,
        peakBufferedBytes: 0,
        pausedAt: null,
        pausedMs: 0,
      }
      this.streams.set(streamId, state)
      if (!this.deps.sendTarget(connId, 'terminal_ready', {
        requestId,
        protocolVersion: PROTOCOL_VERSION,
        streamId,
        agentId: session.agentId,
        engineId: session.engine,
        backend: 'tmux',
      })) {
        await this.closeStream(state, 'backend disconnected', false)
        return
      }
      this.diagnostic(state, 'opened', { cols: size.cols, rows: size.rows, compression: state.compression })
      await this.sendKeyframe(state)
    })
  }

  private streamFor(connId: string, payload: FramePayload): ActiveStream | null {
    const streamId = typeof payload.streamId === 'string' ? payload.streamId : ''
    const state = this.streams.get(streamId)
    return state?.connId === connId && !state.closing ? state : null
  }

  private alive(connId: string, payload: FramePayload): void {
    const state = this.streamFor(connId, payload)
    if (!state) return
    state.expiresAt = this.now() + HEARTBEAT_TIMEOUT_MS
  }

  private ack(connId: string, payload: FramePayload): void {
    const state = this.streamFor(connId, payload)
    if (!state) return
    const lastSeq = Number(payload.lastSeq)
    if (!Number.isSafeInteger(lastSeq) || lastSeq < -1 || lastSeq >= state.nextSeq) return
    let progressed = false
    while (state.pending.length && state.pending[0].seq <= lastSeq) {
      state.pendingBytes -= state.pending.shift()!.bytes
      progressed = true
    }
    if (!progressed) return
    if (state.outputPaused && state.pendingBytes < RESUME_LOW_WATERMARK_BYTES) void this.resumeOutput(state)
    else if (state.outputPaused) this.armStallTimer(state)
  }

  private async input(state: ActiveStream, inputSeq: number, bytes: Uint8Array): Promise<void> {
    if (!Number.isSafeInteger(inputSeq) || inputSeq !== state.lastInputSeq + 1 || bytes.length === 0 || bytes.length > INPUT_MAX_BYTES) {
      this.sendError(state.connId, 'TERMINAL_INPUT_INVALID', { streamId: state.streamId })
      return
    }
    state.lastInputSeq = inputSeq
    state.expiresAt = this.now() + HEARTBEAT_TIMEOUT_MS
    // Ctrl+C (0x03) is never forwarded to the pane: the engine there has no
    // local job-control fallback, so an uncaught SIGINT kills it outright
    // and drops tmux back to a bare shell instead of just interrupting the
    // current turn. Enforced here too (not just client-side) so it holds
    // regardless of which client is attached.
    const filtered = bytes.includes(0x03) ? bytes.filter((b) => b !== 0x03) : bytes
    if (filtered.length === 0) return
    const result = await state.handle.writeRaw(filtered)
    if (result.state !== 'succeeded') {
      this.sendError(state.connId, 'TERMINAL_INPUT_FAILED', { streamId: state.streamId, message: result.reason })
      if (result.dispatch === 'possibly_executed') await this.sendKeyframe(state)
    }
  }

  private async resize(connId: string, payload: FramePayload): Promise<void> {
    const state = this.streamFor(connId, payload)
    if (!state) return
    const resizeSeq = Number(payload.resizeSeq)
    const size = sizeFrom(payload)
    if (!Number.isSafeInteger(resizeSeq) || resizeSeq <= state.lastResizeSeq || !size) return
    state.lastResizeSeq = resizeSeq
    state.expiresAt = this.now() + HEARTBEAT_TIMEOUT_MS
    const result = await state.handle.resize(size)
    if (result.state !== 'succeeded') {
      this.sendError(connId, 'TERMINAL_RESIZE_FAILED', { streamId: state.streamId, message: result.reason })
      return
    }
    await this.sendKeyframe(state)
  }

  /** Scroll gestures arrive stream-scoped, same as resize — no ordering/seq guard needed since,
   *  unlike input, an out-of-order or dropped scroll frame just means one gesture scrolled a little
   *  more or less than intended, never a corrupted stream. The pane's live output stream (already
   *  flowing via `sink.onData`) naturally carries the scrolled copy-mode view back to the client, so
   *  no explicit keyframe push is needed here the way resize needs one. */
  private async scroll(connId: string, payload: FramePayload): Promise<void> {
    const state = this.streamFor(connId, payload)
    if (!state) return
    const direction = payload.direction
    const lines = Number(payload.lines)
    if ((direction !== 'up' && direction !== 'down') || !Number.isSafeInteger(lines) || lines <= 0) {
      this.sendError(connId, 'TERMINAL_SCROLL_INVALID', { streamId: state.streamId })
      return
    }
    state.expiresAt = this.now() + HEARTBEAT_TIMEOUT_MS
    const result = await state.handle.scroll(direction, lines)
    if (result.state !== 'succeeded') {
      this.sendError(connId, 'TERMINAL_SCROLL_FAILED', { streamId: state.streamId, message: result.reason })
    }
  }

  private async resyncRequested(connId: string, payload: FramePayload): Promise<void> {
    const state = this.streamFor(connId, payload)
    if (state) {
      state.resyncs++
      this.diagnostic(state, 'resync_requested', { attempt: payload.attempt })
      await this.sendKeyframe(state)
    }
  }

  private async closeRequested(connId: string, payload: FramePayload): Promise<void> {
    const state = this.streamFor(connId, payload)
    if (state) await this.closeStream(state, 'client closed', true)
  }

  private onOutput(state: ActiveStream, bytes: Uint8Array): void {
    if (state.closing || bytes.length === 0) return
    const nextBuffered = state.pendingBytes + state.outputBytes + bytes.length
    state.peakBufferedBytes = Math.max(state.peakBufferedBytes, nextBuffered)
    if (nextBuffered > MAX_TOTAL_BUFFERED_BYTES) {
      this.sendError(state.connId, 'TERMINAL_OUTPUT_OVERFLOW', { streamId: state.streamId })
      this.diagnostic(state, 'output_overflow', { bufferedBytes: nextBuffered })
      void this.closeStream(state, 'terminal output exceeded safe buffer limit', true)
      return
    }
    state.output.push(Buffer.from(bytes))
    state.outputBytes += bytes.length
    if (state.snapshotting || state.outputPaused) return
    if (state.outputBytes >= OUTPUT_CHUNK_BYTES) {
      this.flushOutput(state)
      return
    }
    // Leading edge: the first output after a quiet gap goes out immediately, which is what a
    // keystroke echo is. Waiting the full window for it cost every echo 8ms for no benefit —
    // there was nothing else to coalesce it with. A burst still lands on the trailing timer
    // below, so the frame rate ceiling is unchanged.
    if (!state.flushTimer && this.now() - state.lastFlushAt >= OUTPUT_FLUSH_MS) {
      this.flushOutput(state)
      return
    }
    state.flushTimer ??= setTimeout(() => this.flushOutput(state), OUTPUT_FLUSH_MS)
  }

  private flushOutput(state: ActiveStream): void {
    if (state.flushTimer) { clearTimeout(state.flushTimer); state.flushTimer = null }
    if (state.closing || state.snapshotting || state.outputBytes === 0) return
    state.lastFlushAt = this.now()
    const all = Buffer.concat(state.output, state.outputBytes)
    state.output = []
    state.outputBytes = 0
    for (let offset = 0; offset < all.length; offset += OUTPUT_CHUNK_BYTES) {
      const chunk = all.subarray(offset, offset + OUTPUT_CHUNK_BYTES)
      const seq = state.nextSeq++
      const body = encoded(chunk, state.compression)
      if (!this.deps.sendBinaryTarget(state.connId, {
        kind: TerminalBinaryKind.output,
        streamId: state.streamId,
        seq,
        compressed: body.compressed,
        bytes: body.bytes,
      })) {
        void this.closeStream(state, 'backend disconnected', false)
        return
      }
      state.pending.push({ seq, bytes: body.plainBytes })
      state.pendingBytes += body.plainBytes
      state.outputFrames++
      state.outputPlainBytes += body.plainBytes
    }
    if (state.pendingBytes > PAUSE_HIGH_WATERMARK_BYTES && !state.outputPaused) void this.pauseOutput(state)
  }

  private armStallTimer(state: ActiveStream): void {
    if (state.stallTimer) clearTimeout(state.stallTimer)
    state.stallTimer = setTimeout(() => {
      state.stallTimer = null
      if (!state.closing && state.outputPaused) {
        this.sendError(state.connId, 'TERMINAL_RENDER_STALLED', { streamId: state.streamId })
        void this.closeStream(state, 'renderer did not acknowledge terminal output', true)
      }
    }, RENDER_STALL_TIMEOUT_MS)
  }

  private async pauseOutput(state: ActiveStream): Promise<void> {
    if (state.closing || state.outputPaused) return
    state.outputPaused = true
    state.pausedAt = this.now()
    const result = await state.handle.pauseOutput()
    if (result.state !== 'succeeded') {
      this.sendError(state.connId, 'TERMINAL_BACKPRESSURE_FAILED', { streamId: state.streamId, message: result.reason })
      await this.closeStream(state, result.reason, true)
      return
    }
    this.diagnostic(state, 'output_paused', { pendingBytes: state.pendingBytes })
    this.armStallTimer(state)
  }

  private async resumeOutput(state: ActiveStream): Promise<void> {
    if (state.closing || !state.outputPaused) return
    state.outputPaused = false
    if (state.pausedAt != null) state.pausedMs += Math.max(0, this.now() - state.pausedAt)
    state.pausedAt = null
    if (state.stallTimer) clearTimeout(state.stallTimer)
    state.stallTimer = null
    const result = await state.handle.resumeOutput()
    if (result.state !== 'succeeded') {
      this.sendError(state.connId, 'TERMINAL_BACKPRESSURE_FAILED', { streamId: state.streamId, message: result.reason })
      await this.closeStream(state, result.reason, true)
      return
    }
    this.diagnostic(state, 'output_resumed', { pendingBytes: state.pendingBytes })
    this.flushOutput(state)
  }

  private async sendKeyframe(state: ActiveStream): Promise<void> {
    if (state.closing || state.resyncing) return
    const startedAt = this.now()
    state.resyncing = true
    state.snapshotting = true
    state.handle.beginSnapshot()
    state.output = []
    state.outputBytes = 0
    if (state.outputPaused) {
      state.outputPaused = false
      if (state.pausedAt != null) state.pausedMs += Math.max(0, this.now() - state.pausedAt)
      state.pausedAt = null
      if (state.stallTimer) clearTimeout(state.stallTimer)
      state.stallTimer = null
      const resumed = await state.handle.resumeOutput().catch(() => ({
        state: 'failed' as const,
        dispatch: 'not_started' as const,
        reason: 'resume failed',
      }))
      if (resumed.state !== 'succeeded') {
        state.handle.endSnapshot()
        state.snapshotting = false
        state.resyncing = false
        this.sendError(state.connId, 'TERMINAL_BACKPRESSURE_FAILED', {
          streamId: state.streamId,
          message: resumed.reason,
        })
        await this.closeStream(state, resumed.reason, true)
        return
      }
    }
    if (state.flushTimer) { clearTimeout(state.flushTimer); state.flushTimer = null }
    let snapshot: Awaited<ReturnType<TerminalStreamHandle['snapshot']>> = {
      state: 'failed',
      reason: 'tmux snapshot did not run',
    }
    try {
      snapshot = await state.handle.snapshot()
    } catch (error) {
      snapshot = { state: 'failed', reason: error instanceof Error ? error.message : 'tmux snapshot failed' }
    }
    if (snapshot.state !== 'succeeded') {
      state.handle.endSnapshot()
      state.snapshotting = false
      state.resyncing = false
      this.diagnostic(state, 'snapshot_failed', { reason: snapshot.reason })
      this.sendError(state.connId, 'TERMINAL_SNAPSHOT_FAILED', { streamId: state.streamId, message: snapshot.reason })
      await this.closeStream(state, snapshot.reason, false)
      return
    }
    if (snapshot.value.bytes.length > KEYFRAME_MAX_BYTES) {
      state.handle.endSnapshot()
      state.snapshotting = false
      state.resyncing = false
      this.diagnostic(state, 'snapshot_too_large', { plainBytes: snapshot.value.bytes.length })
      this.sendError(state.connId, 'TERMINAL_SNAPSHOT_TOO_LARGE', { streamId: state.streamId })
      await this.closeStream(state, 'terminal snapshot exceeds safe envelope size', false)
      return
    }
    const bytes = Buffer.from(snapshot.value.bytes)
    state.pending = []
    state.pendingBytes = 0
    const seq = state.nextSeq++
    const body = encoded(bytes, state.compression)
    const sent = this.deps.sendBinaryTarget(state.connId, {
      kind: TerminalBinaryKind.keyframe,
      streamId: state.streamId,
      seq,
      cols: snapshot.value.cols,
      rows: snapshot.value.rows,
      compressed: body.compressed,
      bytes: body.bytes,
    })
    if (!sent) {
      state.handle.endSnapshot()
      state.snapshotting = false
      state.resyncing = false
      await this.closeStream(state, 'backend disconnected', false)
      return
    }
    state.pending.push({ seq, bytes: body.plainBytes })
    state.pendingBytes = body.plainBytes
    state.keyframes++
    state.lastSyncAt = this.now()
    state.peakBufferedBytes = Math.max(state.peakBufferedBytes, state.pendingBytes)
    this.diagnostic(state, 'keyframe_sent', {
      seq,
      plainBytes: body.plainBytes,
      compressedBytes: body.bytes.length,
      snapshotMs: Math.max(0, this.now() - startedAt),
    })
    state.handle.endSnapshot()
    state.snapshotting = false
    state.resyncing = false
    this.flushOutput(state)
    if (state.pendingBytes > PAUSE_HIGH_WATERMARK_BYTES && !state.outputPaused) void this.pauseOutput(state)
  }

  private sendSync(state: ActiveStream, now: number): void {
    if (state.closing || state.snapshotting || state.resyncing || state.outputPaused) return
    this.flushOutput(state)
    if (state.closing || state.outputPaused) return
    const seq = state.nextSeq++
    if (!this.deps.sendBinaryTarget(state.connId, {
      kind: TerminalBinaryKind.sync,
      streamId: state.streamId,
      seq,
      compressed: false,
      bytes: new Uint8Array(),
    })) {
      void this.closeStream(state, 'backend disconnected', false)
      return
    }
    state.pending.push({ seq, bytes: 0 })
    state.syncFrames++
    state.lastSyncAt = now
  }

  private expireLeases(): void {
    const now = this.now()
    for (const state of [...this.streams.values()]) {
      if (!state.closing && state.expiresAt <= now) void this.closeStream(state, 'heartbeat timeout', true)
      else if (!state.closing && now - state.lastSyncAt >= SYNC_INTERVAL_MS) this.sendSync(state, now)
    }
  }

  private diagnostic(state: ActiveStream, event: string, fields: Record<string, unknown> = {}): void {
    this.deps.diagnostic?.(event, {
      streamId: state.streamId.slice(0, 8),
      agentId: state.agentId.slice(0, 8),
      engineId: state.engineId,
      ...fields,
    })
  }

  /// Replace this connection's own stream for the same terminal.
  ///
  /// Reopening is routine — a resync, a relay that came back — and the old stream has to go or the
  /// agent would have two tmux clients on one window. Matched on agent AND placement so a client
  /// holding several different terminals keeps the ones it did not ask about. No notification: the
  /// client that asked for this is the one being replaced, and it already knows.
  private async closeOwnStreamsFor(connId: string, agentId: string, placementKey: string): Promise<void> {
    const own = [...this.streams.values()].filter((state) =>
      !state.closing && state.connId === connId
        && (state.agentId === agentId || state.placementKey === placementKey))
    await Promise.all(own.map((state) => this.closeStream(state, 'replaced', false)))
  }

  private async closeStreamsForTakeover(agentId: string, placementKey: string, nextConnId: string): Promise<void> {
    const incumbents = [...this.streams.values()].filter((state) =>
      !state.closing && state.connId !== nextConnId
        && (state.agentId === agentId || state.placementKey === placementKey))
    await Promise.all(incumbents.map((state) => this.closeStream(
      state,
      'another client connected',
      true,
      'TERMINAL_TAKEN_OVER',
    )))
  }

  private async closeStream(
    state: ActiveStream,
    reason: string,
    notify: boolean,
    code?: string,
  ): Promise<void> {
    if (state.closing) return
    state.closing = true
    if (state.pausedAt != null) state.pausedMs += Math.max(0, this.now() - state.pausedAt)
    this.diagnostic(state, 'closed', {
      reason,
      lifetimeMs: Math.max(0, this.now() - state.openedAt),
      outputFrames: state.outputFrames,
      outputPlainBytes: state.outputPlainBytes,
      keyframes: state.keyframes,
      syncFrames: state.syncFrames,
      resyncs: state.resyncs,
      peakBufferedBytes: state.peakBufferedBytes,
      pausedMs: state.pausedMs,
    })
    if (state.flushTimer) clearTimeout(state.flushTimer)
    if (state.stallTimer) clearTimeout(state.stallTimer)
    state.flushTimer = null
    state.stallTimer = null
    this.streams.delete(state.streamId)
    if (this.controllerByAgent.get(state.agentId) === state.connId) this.controllerByAgent.delete(state.agentId)
    if (this.controllerByPlacement.get(state.placementKey) === state.connId) this.controllerByPlacement.delete(state.placementKey)
    if (state.outputPaused) await state.handle.resumeOutput().catch(() => { /* best effort */ })
    await state.handle.close().catch(() => { /* best effort */ })
    if (notify) this.deps.sendTarget(state.connId, 'terminal_closed', {
      protocolVersion: PROTOCOL_VERSION,
      streamId: state.streamId,
      reason,
      ...(code ? { code } : {}),
    })
  }

  async closeConnection(connId: string, reason = 'connection closed', notify = false): Promise<void> {
    const states = [...this.streams.values()].filter((state) => state.connId === connId)
    await Promise.all(states.map((state) => this.closeStream(state, reason, notify)))
  }

  /** Close one transport class without disturbing streams owned by another transport. */
  async closeConnectionsWhere(
    predicate: (connId: string) => boolean,
    reason: string,
    notify = false,
  ): Promise<void> {
    const states = [...this.streams.values()].filter((state) => predicate(state.connId))
    await Promise.all(states.map((state) => this.closeStream(state, reason, notify)))
  }

  async closeAll(reason = 'backend disconnected'): Promise<void> {
    await Promise.all([...this.streams.values()].map((state) => this.closeStream(state, reason, false)))
  }

  async stop(): Promise<void> {
    clearInterval(this.expiryTimer)
    await this.closeAll('terminal manager stopped')
  }
}
