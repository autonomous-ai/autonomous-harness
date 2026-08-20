import { randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { ENGINES } from '../engines/types.js'
import type { RegisteredSession } from './registry.js'
import type { TerminalBackendCoordinator } from './terminalBackendCoordinator.js'
import { terminalPlacementKey, terminalRouteKey } from './terminalRuntime.js'
import type { TerminalStreamHandle, TerminalStreamSize } from './terminalTypes.js'

type FramePayload = Record<string, unknown>

const PROTOCOL_VERSION = 1
const HEARTBEAT_TIMEOUT_MS = 30_000
const OUTPUT_FLUSH_MS = 8
const OUTPUT_CHUNK_BYTES = 32 * 1024
const INPUT_MAX_BYTES = 64 * 1024
const MAX_UNACKED_FRAMES = 256
const MAX_UNACKED_BYTES = 1024 * 1024
// Terminal data is base64 inside the clear payload, then the entire E2EE
// ciphertext is base64 again. Keep enough headroom below Backend's 512 KiB
// outer-envelope limit for both JSON layers, AEAD tag and routing fields.
const KEYFRAME_MAX_BYTES = 240 * 1024
const KEYFRAME_HISTORY_ATTEMPTS = [1_000, 500, 250, 100, 0] as const
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
  nextSeq: number
  lastInputSeq: number
  lastResizeSeq: number
  pending: PendingOutput[]
  pendingBytes: number
  output: Buffer[]
  outputBytes: number
  flushTimer: ReturnType<typeof setTimeout> | null
  snapshotting: boolean
  resyncing: boolean
  closing: boolean
}

export interface TerminalStreamManagerDeps {
  terminals: TerminalBackendCoordinator
  resolveAgent: (agentId: string) => RegisteredSession | undefined
  sendTarget: (connId: string, type: string, payload: FramePayload) => boolean
  streamingAvailable: boolean
  now?: () => number
}

function sizeFrom(payload: FramePayload): TerminalStreamSize | null {
  const cols = Number(payload.cols)
  const rows = Number(payload.rows)
  if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < 40 || cols > 300 || rows < 12 || rows > 120) return null
  return { cols, rows }
}

function strictBase64(raw: unknown): Buffer | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) return null
  const bytes = Buffer.from(raw, 'base64')
  return bytes.toString('base64') === raw ? bytes : null
}

function encoded(bytes: Uint8Array, compression: 'none' | 'zlib'): { encoding: 'none' | 'zlib'; data: string; plainBytes: number } {
  const raw = Buffer.from(bytes)
  if (compression === 'zlib' && raw.length > 1024) {
    const compressed = deflateSync(raw, { level: 1 })
    if (compressed.length < raw.length) return { encoding: 'zlib', data: compressed.toString('base64'), plainBytes: raw.length }
  }
  return { encoding: 'none', data: raw.toString('base64'), plainBytes: raw.length }
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
  private readonly now: () => number
  private readonly expiryTimer: ReturnType<typeof setInterval>

  constructor(private readonly deps: TerminalStreamManagerDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.expiryTimer = setInterval(() => this.expireLeases(), 5_000)
    this.expiryTimer.unref?.()
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
        await this.input(connId, payload)
        return true
      case 'terminal_resize':
        await this.resize(connId, payload)
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
    const controller = this.controllerByAgent.get(session.agentId)
    if (controller && controller !== connId) {
      this.sendError(connId, 'CONTROL_LEASE_HELD', { requestId })
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
    const placementController = this.controllerByPlacement.get(reservedPlacement)
    if (placementController && placementController !== connId) {
      this.sendError(connId, 'CONTROL_LEASE_HELD', { requestId })
      return
    }

    await this.closeConnection(connId, 'replaced', false)
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
      nextSeq: 0,
      lastInputSeq: -1,
      lastResizeSeq: -1,
      pending: [],
      pendingBytes: 0,
      output: buffered,
      outputBytes: buffered.reduce((sum, chunk) => sum + chunk.length, 0),
      flushTimer: null,
      snapshotting: false,
      resyncing: false,
      closing: false,
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
    await this.sendKeyframe(state)
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
    while (state.pending.length && state.pending[0].seq <= lastSeq) {
      state.pendingBytes -= state.pending.shift()!.bytes
    }
  }

  private async input(connId: string, payload: FramePayload): Promise<void> {
    const state = this.streamFor(connId, payload)
    if (!state) return
    const inputSeq = Number(payload.inputSeq)
    const bytes = strictBase64(payload.data)
    if (!Number.isSafeInteger(inputSeq) || inputSeq !== state.lastInputSeq + 1 || !bytes || bytes.length > INPUT_MAX_BYTES) {
      this.sendError(connId, 'TERMINAL_INPUT_INVALID', { streamId: state.streamId })
      return
    }
    state.lastInputSeq = inputSeq
    state.expiresAt = this.now() + HEARTBEAT_TIMEOUT_MS
    const result = await state.handle.writeRaw(bytes)
    if (result.state !== 'succeeded') {
      this.sendError(connId, 'TERMINAL_INPUT_FAILED', { streamId: state.streamId, message: result.reason })
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

  private async resyncRequested(connId: string, payload: FramePayload): Promise<void> {
    const state = this.streamFor(connId, payload)
    if (state) await this.sendKeyframe(state)
  }

  private async closeRequested(connId: string, payload: FramePayload): Promise<void> {
    const state = this.streamFor(connId, payload)
    if (state) await this.closeStream(state, 'client closed', true)
  }

  private onOutput(state: ActiveStream, bytes: Uint8Array): void {
    if (state.closing || bytes.length === 0) return
    state.output.push(Buffer.from(bytes))
    state.outputBytes += bytes.length
    if (state.snapshotting) return
    if (state.outputBytes >= OUTPUT_CHUNK_BYTES) {
      this.flushOutput(state)
      return
    }
    state.flushTimer ??= setTimeout(() => this.flushOutput(state), OUTPUT_FLUSH_MS)
  }

  private flushOutput(state: ActiveStream): void {
    if (state.flushTimer) { clearTimeout(state.flushTimer); state.flushTimer = null }
    if (state.closing || state.snapshotting || state.outputBytes === 0) return
    const all = Buffer.concat(state.output, state.outputBytes)
    state.output = []
    state.outputBytes = 0
    for (let offset = 0; offset < all.length; offset += OUTPUT_CHUNK_BYTES) {
      const chunk = all.subarray(offset, offset + OUTPUT_CHUNK_BYTES)
      const seq = state.nextSeq++
      const body = encoded(chunk, state.compression)
      if (!this.deps.sendTarget(state.connId, 'terminal_output', {
        protocolVersion: PROTOCOL_VERSION,
        streamId: state.streamId,
        seq,
        encoding: body.encoding,
        data: body.data,
      })) {
        void this.closeStream(state, 'backend disconnected', false)
        return
      }
      state.pending.push({ seq, bytes: body.plainBytes })
      state.pendingBytes += body.plainBytes
    }
    if ((state.pending.length > MAX_UNACKED_FRAMES || state.pendingBytes > MAX_UNACKED_BYTES) && !state.resyncing) {
      void this.sendKeyframe(state)
    }
  }

  private async sendKeyframe(state: ActiveStream): Promise<void> {
    if (state.closing || state.resyncing) return
    state.resyncing = true
    state.snapshotting = true
    if (state.flushTimer) { clearTimeout(state.flushTimer); state.flushTimer = null }
    let snapshot: Awaited<ReturnType<TerminalStreamHandle['snapshot']>> = {
      state: 'failed',
      reason: 'tmux snapshot did not run',
    }
    for (const historyLines of KEYFRAME_HISTORY_ATTEMPTS) {
      snapshot = await state.handle.snapshot(historyLines)
      if (snapshot.state !== 'succeeded' || snapshot.value.bytes.length <= KEYFRAME_MAX_BYTES) break
    }
    if (snapshot.state !== 'succeeded') {
      state.snapshotting = false
      state.resyncing = false
      this.sendError(state.connId, 'TERMINAL_SNAPSHOT_FAILED', { streamId: state.streamId, message: snapshot.reason })
      await this.closeStream(state, snapshot.reason, false)
      return
    }
    if (snapshot.value.bytes.length > KEYFRAME_MAX_BYTES) {
      state.snapshotting = false
      state.resyncing = false
      this.sendError(state.connId, 'TERMINAL_SNAPSHOT_TOO_LARGE', { streamId: state.streamId })
      await this.closeStream(state, 'terminal snapshot exceeds safe envelope size', false)
      return
    }
    const bytes = Buffer.from(snapshot.value.bytes)
    state.pending = []
    state.pendingBytes = 0
    const seq = state.nextSeq++
    const body = encoded(bytes, state.compression)
    const sent = this.deps.sendTarget(state.connId, 'terminal_keyframe', {
      protocolVersion: PROTOCOL_VERSION,
      streamId: state.streamId,
      seq,
      cols: snapshot.value.cols,
      rows: snapshot.value.rows,
      encoding: body.encoding,
      data: body.data,
    })
    if (!sent) {
      state.snapshotting = false
      state.resyncing = false
      await this.closeStream(state, 'backend disconnected', false)
      return
    }
    state.pending.push({ seq, bytes: body.plainBytes })
    state.pendingBytes = body.plainBytes
    state.snapshotting = false
    state.resyncing = false
    this.flushOutput(state)
  }

  private expireLeases(): void {
    const now = this.now()
    for (const state of [...this.streams.values()]) {
      if (!state.closing && state.expiresAt <= now) void this.closeStream(state, 'heartbeat timeout', true)
    }
  }

  private async closeStream(state: ActiveStream, reason: string, notify: boolean): Promise<void> {
    if (state.closing) return
    state.closing = true
    if (state.flushTimer) clearTimeout(state.flushTimer)
    state.flushTimer = null
    this.streams.delete(state.streamId)
    if (this.controllerByAgent.get(state.agentId) === state.connId) this.controllerByAgent.delete(state.agentId)
    if (this.controllerByPlacement.get(state.placementKey) === state.connId) this.controllerByPlacement.delete(state.placementKey)
    await state.handle.close().catch(() => { /* best effort */ })
    if (notify) this.deps.sendTarget(state.connId, 'terminal_closed', {
      protocolVersion: PROTOCOL_VERSION,
      streamId: state.streamId,
      reason,
    })
  }

  async closeConnection(connId: string, reason = 'connection closed', notify = false): Promise<void> {
    const states = [...this.streams.values()].filter((state) => state.connId === connId)
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
