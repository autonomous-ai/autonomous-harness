import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'
import { ENGINES } from '../engines/types.js'
import type { RegisteredSession } from './registry.js'
import { writeImageToOsClipboard } from './osClipboard.js'
import { writePasteDropFile, writePasteImageFile } from './pasteDropFiles.js'
import type { TerminalBackendCoordinator } from './terminalBackendCoordinator.js'
import { terminalPlacementKey, terminalRouteKey } from './terminalRuntime.js'
import type { TerminalStreamHandle, TerminalStreamSize } from './terminalTypes.js'
import {
  TerminalBinaryKind,
  TERMINAL_LOCAL_IMAGE_PASTE_MAX_PAYLOAD_BYTES,
  TERMINAL_LOCAL_PASTE_FILE_MAX_PAYLOAD_BYTES,
  type TerminalBinaryClear,
} from './terminalBinary.js'

/** Ctrl+V as a literal byte (ASCII SUB, 0x16) — the same nudge a real Ctrl+V keystroke sends down
 *  the ordinary keystroke pipe. Written after the OS clipboard write below succeeds, so the engine
 *  attached to the pane reads its OWN OS clipboard exactly as it already does for a locally-driven
 *  session — see `pasteImage()`. */
const CTRL_V_BYTE = Uint8Array.of(0x16)

/** Per-chunk size for a chunked image/file upload — comfortably under the 512 KiB per-binary-message
 *  ceiling shared by the backend relay and the P2P data channel (with AEAD/framing overhead room to
 *  spare), and large enough that a 4 MB image is ~16 chunks / a 10 MB file ~40. Deliberately NOT a
 *  credit/window scheme like the firmware pusher's (cli/src/cable/fwPush.ts) — that exists because
 *  USB Serial/JTAG has no real backpressure; a WebSocket already backpressures at the socket layer,
 *  so the client just sends chunks back-to-back. Mirrors the Dart client's own chunk size — keep
 *  the two in step. */
export const UPLOAD_CHUNK_BYTES = 256 * 1024

interface PendingUpload {
  kind: TerminalBinaryKind.imagePaste | TerminalBinaryKind.pasteFile
  /** Only meaningful (and required) for a `pasteFile` upload. */
  filename?: string
  totalBytes: number
  expectedChunks: number
  /** Indexed by chunk seq; sparse until every chunk has arrived. */
  chunks: (Buffer | undefined)[]
  bytesReceived: number
}

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
  pendingUpload: PendingUpload | null
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
      case 'terminal_paste':
      case 'terminal_paste_image':
      case 'terminal_paste_file':
        // Same reason as terminal_input: a paste is a binary frame (TerminalBinaryKind.paste /
        // .imagePaste / .pasteFile) so it rides the same AEAD channel every other terminal byte
        // does, which is what makes it safe to deliver over a relayed (E2EE) connection. Nothing
        // sends this as JSON.
        this.sendError(connId, 'TERMINAL_BINARY_REQUIRED', { streamId: typeof payload.streamId === 'string' ? payload.streamId : undefined })
        return true
      case 'terminal_chunked_upload_begin':
        this.beginChunkedUpload(connId, payload)
        return true
      case 'terminal_chunked_upload_cancel':
        this.cancelChunkedUpload(connId, payload)
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
    if (frame.kind !== TerminalBinaryKind.input && frame.kind !== TerminalBinaryKind.paste
      && frame.kind !== TerminalBinaryKind.imagePaste && frame.kind !== TerminalBinaryKind.pasteFile) return
    const state = this.streams.get(frame.streamId)
    if (!state || state.connId !== connId || state.closing) return
    if (frame.kind === TerminalBinaryKind.imagePaste || frame.kind === TerminalBinaryKind.pasteFile) {
      await this.receiveUploadChunk(state, frame.kind, frame.seq, frame.bytes)
      return
    }
    if (frame.kind === TerminalBinaryKind.paste) {
      await this.paste(state, frame.bytes)
      return
    }
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
        // A client old enough to predate `terminal_paste` must keep sending a direct terminal paste
        // through `terminal_input` — checked here rather than assumed, so it degrades instead of
        // silently going nowhere against a CLI that doesn't recognize the newer frame type.
        pasteRaw: true,
        // A client old enough to predate `TerminalBinaryKind.imagePaste` must keep forwarding a bare
        // Ctrl+V and hoping the engine's own clipboard read finds something local — see
        // `pasteImage()` for the frame this unlocks.
        imagePaste: true,
        // A client old enough to predate `TerminalBinaryKind.pasteFile` has no way to hand a
        // dropped non-image file to a REMOTE pane at all (a local pane needs no capability — it
        // pastes the file's own path directly, never touching the wire) — see `pasteFile()`.
        pasteFile: true,
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
        pendingUpload: null,
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

  /** Existence/ownership check for connId+streamId — used by BackendSocket to validate a p2p-arrived
   *  terminal_resync (a live-migration promotion signal, not an actual resync request) actually names a
   *  live stream owned by this connection before trusting it, instead of leaking a routing entry for a
   *  stale/bogus streamId (e.g. the pane closed in the same instant the migration barrier was in flight). */
  hasStream(connId: string, streamId: string): boolean {
    const state = this.streams.get(streamId)
    return !!state && state.connId === connId && !state.closing
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
    const result = await state.handle.writeRaw(bytes)
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

  /**
   * A clipboard paste made directly into the terminal (not the composer), delivered whole as a
   * `TerminalBinaryKind.paste` frame via `TerminalStreamHandle.pasteRaw` instead of the chunked
   * `writeRaw`/`send-keys -H` keystroke path — see `pasteRawIntoTmux` for why the two cannot share a
   * pipe. Binary, not JSON: this is what lets a paste travel over a relayed (E2EE) connection safely
   * — it rides the same AEAD-wrapped channel `input`/`output` already do, with no allowlist of its
   * own to keep in step with the pairwise-crypto "interop keystone" (e2ee/core.ts) three other
   * codebases also implement.
   *
   * No seq/ordering guard, unlike `input()`: a paste is one self-contained unit, not part of an
   * ordered keystroke stream. Size is already bounded by the wire format itself
   * (TERMINAL_*_PASTE_MAX_*_BYTES in terminalBinary.ts) — anything over that never decodes into a
   * frame at all, so there is nothing left to check here.
   */
  private async paste(state: ActiveStream, bytes: Uint8Array): Promise<void> {
    if (bytes.length === 0) return
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      this.sendError(state.connId, 'TERMINAL_PASTE_INVALID', { streamId: state.streamId, message: 'paste was not valid UTF-8' })
      return
    }
    state.expiresAt = this.now() + HEARTBEAT_TIMEOUT_MS
    const result = await state.handle.pasteRaw(text)
    if (result.state !== 'succeeded') {
      this.sendError(state.connId, 'TERMINAL_PASTE_FAILED', { streamId: state.streamId, message: result.reason })
      if (result.dispatch === 'possibly_executed') await this.sendKeyframe(state)
    }
  }

  /**
   * A clipboard IMAGE paste (raw PNG bytes, already fully assembled from a chunked upload — see
   * `receiveUploadChunk`) — writes the bytes into THIS machine's own OS clipboard (see
   * osClipboard.ts), then replays a literal Ctrl+V so whichever engine is attached to the pane
   * reads that clipboard exactly as it already does for a locally-driven session. Nothing here is
   * engine-specific: this only bridges the clipboard and the keystroke, the same way `paste()`
   * only bridges a clipboard string into the pty.
   *
   * When no native clipboard is reachable right now (the clipboard tool isn't installed, or this
   * is a genuinely headless Linux box with no X11/Wayland session at all), this does not fail —
   * it falls back to pasting the image's file PATH as plain text through the exact same
   * `pasteRaw` call `paste()` uses, so the user/engine can still get at the image, just not via
   * the OS clipboard. The client is told which happened (`terminal_paste_image_result`) so it can
   * show the right feedback instead of a silent difference in behavior.
   */
  private async pasteImage(state: ActiveStream, bytes: Uint8Array): Promise<void> {
    if (bytes.length === 0) return
    state.expiresAt = this.now() + HEARTBEAT_TIMEOUT_MS
    let path: string
    try {
      path = await writePasteImageFile(bytes)
    } catch (error) {
      this.sendError(state.connId, 'TERMINAL_PASTE_IMAGE_FAILED', {
        streamId: state.streamId,
        message: error instanceof Error ? error.message : 'could not save the pasted image',
      })
      return
    }
    const clipboard = await writeImageToOsClipboard(path, bytes)
    if (clipboard.state === 'written') {
      // The OS clipboard now owns the bytes — the file was only a hand-off.
      void unlink(path).catch(() => { /* best effort */ })
      const result = await state.handle.writeRaw(CTRL_V_BYTE)
      if (result.state !== 'succeeded') {
        this.sendError(state.connId, 'TERMINAL_PASTE_IMAGE_FAILED', { streamId: state.streamId, message: result.reason })
        if (result.dispatch === 'possibly_executed') await this.sendKeyframe(state)
        return
      }
      this.deps.sendTarget(state.connId, 'terminal_paste_image_result', {
        streamId: state.streamId,
        outcome: 'clipboard',
      })
      return
    }
    // 'failed' and 'unavailable' get the same treatment: whether the clipboard tool is missing
    // entirely or was found but couldn't actually reach a display (the exact case a Docker test rig
    // with a stale $DISPLAY and no X server hits — xclip is on PATH, so this lands in 'failed', not
    // 'unavailable', even though the outcome — no OS clipboard to write to — is identical), the user
    // still needs the image. Hard-failing here used to freeze the whole session over what is, from
    // the engine's perspective, just a degraded paste. Fall back to the file's path as ordinary
    // text, and keep the file: it has to keep resolving after this call returns.
    const result = await state.handle.pasteRaw(path)
    if (result.state !== 'succeeded') {
      this.sendError(state.connId, 'TERMINAL_PASTE_IMAGE_FAILED', { streamId: state.streamId, message: result.reason })
      if (result.dispatch === 'possibly_executed') await this.sendKeyframe(state)
      return
    }
    this.deps.sendTarget(state.connId, 'terminal_paste_image_result', {
      streamId: state.streamId,
      outcome: 'fallback_path',
      reason: clipboard.reason,
    })
  }

  /**
   * A dropped (non-image) FILE (bytes already fully assembled from a chunked upload — see
   * `receiveUploadChunk`) — writes it to disk on THIS machine (under its original name, see
   * `writePasteDropFile`) and pastes that path as plain text, the same `pasteRaw` call `paste()`
   * uses. Unlike `pasteImage()`, there is no OS-clipboard attempt and no Ctrl+V replay: the goal
   * here is only "the pane gets a valid path", not "the engine auto-attaches this" — a client only
   * sends this at all for a genuinely REMOTE pane (a local one pastes its own already-valid path
   * without ever reaching the wire), so there is no local/remote branch to make here either.
   */
  private async pasteFile(state: ActiveStream, filename: string, bytes: Uint8Array): Promise<void> {
    state.expiresAt = this.now() + HEARTBEAT_TIMEOUT_MS
    let path: string
    try {
      path = await writePasteDropFile(filename, bytes)
    } catch (error) {
      this.sendError(state.connId, 'TERMINAL_PASTE_FILE_FAILED', {
        streamId: state.streamId,
        message: error instanceof Error ? error.message : 'could not save the dropped file',
      })
      return
    }
    const result = await state.handle.pasteRaw(path)
    if (result.state !== 'succeeded') {
      this.sendError(state.connId, 'TERMINAL_PASTE_FILE_FAILED', { streamId: state.streamId, message: result.reason })
      if (result.dispatch === 'possibly_executed') await this.sendKeyframe(state)
      return
    }
    this.deps.sendTarget(state.connId, 'terminal_paste_file_result', { streamId: state.streamId, path })
  }

  /**
   * Announces a new chunked image/file upload for this stream — see UPLOAD_CHUNK_BYTES's doc for
   * why this is chunked at all (a per-binary-message ceiling shared by the backend relay and the
   * P2P data channel) rather than the single atomic frame `imagePaste`/`pasteFile` used to be.
   * Validated and either accepted or rejected up front, before any chunk is sent, so a client on a
   * slow link finds out immediately rather than after transferring several MB for nothing.
   */
  private beginChunkedUpload(connId: string, payload: FramePayload): void {
    // Unlike resize/scroll/ack (silently no-op on a bad lookup is harmless — the next real event
    // self-corrects), a paste that vanishes here leaves the client's progress overlay waiting on a
    // reply that will never come, with nothing to explain why: it looks exactly like a hang. Reply
    // even when this connection doesn't currently own a live stream for the streamId it named,
    // echoing that streamId back (not a `state`'s, which we don't have) so the client can still
    // match it against what it's waiting on.
    const claimedStreamId = typeof payload.streamId === 'string' ? payload.streamId : undefined
    const state = this.streamFor(connId, payload)
    if (!state) {
      this.deps.sendTarget(connId, 'terminal_chunked_upload_begin_result', {
        streamId: claimedStreamId,
        accepted: false,
        reason: 'no live terminal stream for this pane (reopen it and try again)',
      })
      return
    }
    const streamId = state.streamId
    const reject = (reason: string): void => {
      this.diagnostic(state, 'chunked_upload_rejected', { reason })
      this.deps.sendTarget(connId, 'terminal_chunked_upload_begin_result', { streamId, accepted: false, reason })
    }
    const uploadKind = payload.uploadKind === 'image' ? TerminalBinaryKind.imagePaste
      : payload.uploadKind === 'file' ? TerminalBinaryKind.pasteFile
      : null
    const totalBytes = Number(payload.totalBytes)
    const filename = typeof payload.filename === 'string' ? payload.filename : undefined
    if (!uploadKind || !Number.isSafeInteger(totalBytes) || totalBytes <= 0
      || (uploadKind === TerminalBinaryKind.pasteFile && !filename)) {
      reject('malformed upload request')
      return
    }
    if (state.pendingUpload) {
      reject('an upload is already in progress on this pane')
      return
    }
    const ceiling = uploadKind === TerminalBinaryKind.imagePaste
      ? TERMINAL_LOCAL_IMAGE_PASTE_MAX_PAYLOAD_BYTES
      : TERMINAL_LOCAL_PASTE_FILE_MAX_PAYLOAD_BYTES
    if (totalBytes > ceiling) {
      reject(`exceeds the ${Math.floor(ceiling / (1024 * 1024))} MB limit`)
      return
    }
    state.expiresAt = this.now() + HEARTBEAT_TIMEOUT_MS
    state.pendingUpload = {
      kind: uploadKind,
      filename,
      totalBytes,
      expectedChunks: Math.ceil(totalBytes / UPLOAD_CHUNK_BYTES),
      chunks: [],
      bytesReceived: 0,
    }
    this.diagnostic(state, 'chunked_upload_begin', { uploadKind: payload.uploadKind, totalBytes, filename })
    this.deps.sendTarget(connId, 'terminal_chunked_upload_begin_result', { streamId, accepted: true })
  }

  /** The user's own Cancel — stop and discard whatever has arrived so far. Nothing has been
   *  written to disk yet at this point (chunks are only assembled and handed off once every one
   *  has arrived), so there is no partial file to clean up — just drop the in-memory buffer. */
  private cancelChunkedUpload(connId: string, payload: FramePayload): void {
    const state = this.streamFor(connId, payload)
    if (!state) return
    if (state.pendingUpload) this.diagnostic(state, 'chunked_upload_cancelled', {})
    state.pendingUpload = null
  }

  /**
   * One chunk of an in-flight upload announced by `beginChunkedUpload`. `seq` is the chunk index
   * (not an ordered keystroke sequence the way `input()`'s is) — stored by index rather than
   * assumed in-order, since nothing guarantees frame ordering survives a relay hop-by-hop, though
   * in practice it should. A stray chunk with no matching (or a kind-mismatched) `pendingUpload` is
   * ignored rather than errored: it most likely means a cancel or a previous upload's tail-end
   * arrived late.
   *
   * Progress is acked once per chunk, after it is durably held here — matching the firmware
   * pusher's philosophy (`fwPush.ts`'s `fw.progress`) of reporting confirmed receipt, not merely
   * "sent", which is what makes the client's percentage honest on a slow link. Once every expected
   * byte has arrived, this hands the assembled bytes to the SAME finishing logic `pasteImage`/
   * `pasteFile` already had before this feature existed — only how the bytes arrived changed.
   */
  private async receiveUploadChunk(
    state: ActiveStream,
    kind: TerminalBinaryKind.imagePaste | TerminalBinaryKind.pasteFile,
    seq: number,
    bytes: Uint8Array,
  ): Promise<void> {
    const pending = state.pendingUpload
    if (!pending) {
      this.diagnostic(state, 'chunked_upload_stray_chunk', { seq, kind })
      return
    }
    if (pending.kind !== kind) return
    if (!Number.isSafeInteger(seq) || seq < 0 || seq >= pending.expectedChunks
      || bytes.length === 0 || bytes.length > UPLOAD_CHUNK_BYTES) {
      this.diagnostic(state, 'chunked_upload_invalid_chunk', { seq, byteLength: bytes.length, expectedChunks: pending.expectedChunks })
      this.sendError(state.connId, 'TERMINAL_CHUNKED_UPLOAD_INVALID', { streamId: state.streamId, message: 'malformed upload chunk' })
      state.pendingUpload = null
      return
    }
    state.expiresAt = this.now() + HEARTBEAT_TIMEOUT_MS
    if (pending.chunks[seq] === undefined) {
      pending.chunks[seq] = Buffer.from(bytes)
      pending.bytesReceived += bytes.length
    }
    this.deps.sendTarget(state.connId, 'terminal_chunked_upload_progress', {
      streamId: state.streamId,
      bytesWritten: pending.bytesReceived,
      totalBytes: pending.totalBytes,
    })
    if (pending.bytesReceived < pending.totalBytes) return
    state.pendingUpload = null
    this.diagnostic(state, 'chunked_upload_assembled', { totalBytes: pending.totalBytes })
    // A plain Uint8Array, not a Buffer — pasteImage/pasteFile hand this to code (osClipboard,
    // pasteDropFiles) written against the same Uint8Array shape the old atomic frame's `bytes`
    // always was, and callers/tests comparing against a Uint8Array must not have to know this
    // path happens to assemble through Buffer internally.
    const assembled = new Uint8Array(Buffer.concat(pending.chunks.filter((chunk): chunk is Buffer => chunk !== undefined)))
    if (kind === TerminalBinaryKind.imagePaste) {
      await this.pasteImage(state, assembled)
    } else {
      await this.pasteFile(state, pending.filename!, assembled)
    }
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
