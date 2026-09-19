import { Duplex } from 'node:stream'

/** Pairwise encrypted JSON frames; no payload may be logged or broadcast. */
export const VIEWER_DOWN_TYPES = new Set(['viewer_request', 'viewer_data', 'viewer_ack', 'viewer_end', 'viewer_close'])
export const VIEWER_UP_TYPES = new Set(['viewer_response', 'viewer_data', 'viewer_ack', 'viewer_end', 'viewer_close'])
export const VIEWER_CHUNK_BYTES = 32 * 1024
export const VIEWER_WINDOW_BYTES = 128 * 1024
export const VIEWER_MAX_STREAMS = 64
export const VIEWER_TIMEOUT_MS = 30_000
export type ViewerSend = (type: string, payload: Record<string, unknown>) => boolean

/** Only the daemon's managed HTTP loopback viewers can be forwarded. Never resolve a hostname. */
export function viewerTarget(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length > 8192 || /[\s\x00-\x1f\x7f]/.test(raw)) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && Number(url.port) > 0 ? url : null
  } catch { return null }
}

export function viewerStreamId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(value)
}

/**
 * A half-closeable, bounded byte stream over ordered frames. Credit is returned only while the
 * consumer is draining. This keeps a video or a stalled WebSocket from buffering an entire file
 * in either daemon, and leaves room on the shared relay for terminal input.
 */
export class ViewerWire extends Duplex {
  private credit = VIEWER_WINDOW_BYTES
  private receiveCredit = VIEWER_WINDOW_BYTES
  private heldAck = 0
  private incomingEnded = false
  private responseReady = false
  private peerClosed = false
  private pending: { bytes: Buffer; offset: number; done: (error?: Error | null) => void } | null = null
  private deadline: NodeJS.Timeout

  constructor(readonly id: string, private readonly send: ViewerSend) {
    super({ allowHalfOpen: true, highWaterMark: VIEWER_CHUNK_BYTES })
    // Owners attach their own error handlers too. A late cancellation must never crash the daemon.
    this.on('error', () => {})
    this.deadline = setTimeout(() => this.destroy(new Error('Viewer connection timed out')), VIEWER_TIMEOUT_MS)
    this.deadline.unref()
  }

  /** The HTTP headers arrived. An idle SSE/WebSocket is valid; stalled writes still have a deadline. */
  ready(): void {
    this.responseReady = true
    if (this.credit === VIEWER_WINDOW_BYTES) clearTimeout(this.deadline)
  }

  private armDeadline(): void {
    clearTimeout(this.deadline)
    this.deadline = setTimeout(() => this.destroy(new Error('Viewer transfer stalled')), VIEWER_TIMEOUT_MS)
    this.deadline.unref()
  }

  private emitWire(type: string, payload: Record<string, unknown> = {}): boolean {
    if (this.destroyed) return false
    if (this.send(type, { streamId: this.id, ...payload })) return true
    this.destroy(new Error('Viewer connection closed'))
    return false
  }

  override _read(): void {
    if (!this.heldAck) return
    const bytes = this.heldAck
    this.heldAck = 0
    this.receiveCredit += bytes
    this.emitWire('viewer_ack', { bytes })
  }

  override _write(bytes: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.pending = { bytes, offset: 0, done }
    this.flushPending()
  }

  private flushPending(): void {
    const pending = this.pending
    if (!pending || this.destroyed) return
    while (pending.offset < pending.bytes.length && this.credit > 0) {
      const length = Math.min(VIEWER_CHUNK_BYTES, this.credit, pending.bytes.length - pending.offset)
      const data = pending.bytes.subarray(pending.offset, pending.offset + length).toString('base64')
      this.credit -= length
      pending.offset += length
      this.armDeadline()
      if (!this.emitWire('viewer_data', { data })) return
    }
    if (pending.offset === pending.bytes.length) {
      this.pending = null
      pending.done()
    }
  }

  override _final(done: (error?: Error | null) => void): void {
    this.emitWire('viewer_end')
    done()
  }

  handle(type: string, payload: Record<string, unknown>): void {
    if (this.destroyed) return
    if (type === 'viewer_close') {
      this.peerClosed = true
      this.destroy(new Error(typeof payload.error === 'string' ? payload.error.slice(0, 160) : 'Viewer connection closed'))
    } else if (type === 'viewer_end') {
      if (this.incomingEnded) return
      this.incomingEnded = true
      this.push(null)
    } else if (type === 'viewer_ack') {
      const bytes = payload.bytes
      if (!Number.isSafeInteger(bytes) || Number(bytes) <= 0 || Number(bytes) > VIEWER_WINDOW_BYTES - this.credit) {
        this.destroy(new Error('Invalid viewer credit'))
        return
      }
      this.credit += Number(bytes)
      if (this.credit === VIEWER_WINDOW_BYTES && this.responseReady) clearTimeout(this.deadline)
      else this.armDeadline()
      this.flushPending()
    } else if (type === 'viewer_data') {
      const data = payload.data
      if (this.incomingEnded || typeof data !== 'string' || data.length > Math.ceil(VIEWER_CHUNK_BYTES / 3) * 4) {
        this.destroy(new Error('Invalid viewer data'))
        return
      }
      const bytes = Buffer.from(data, 'base64')
      if (!bytes.length || bytes.length > this.receiveCredit || bytes.toString('base64') !== data) {
        this.destroy(new Error('Invalid viewer data'))
        return
      }
      this.receiveCredit -= bytes.length
      if (this.push(bytes)) {
        this.receiveCredit += bytes.length
        this.emitWire('viewer_ack', { bytes: bytes.length })
      } else {
        this.heldAck += bytes.length
      }
    }
  }

  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    clearTimeout(this.deadline)
    if (!this.peerClosed && (error || !this.readableEnded || !this.writableFinished)) {
      this.send('viewer_close', { streamId: this.id, error: 'Viewer connection closed' })
    }
    const pending = this.pending
    this.pending = null
    pending?.done(error ?? new Error('Viewer connection closed'))
    done(error)
  }
}

/** Hop-by-hop headers belong to each HTTP connection, not the encrypted hop between them. */
export function viewerHeaders(raw: unknown, upgrade = false): Record<string, string | string[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid viewer headers')
  const headers: Record<string, string | string[]> = Object.create(null)
  let size = 0
  for (const [key, value] of Object.entries(raw)) {
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(key)) throw new Error('Invalid viewer header')
    const values = Array.isArray(value) ? value : [value]
    if (!values.every((v) => typeof v === 'string' && !/[\r\n\x00]/.test(v))) throw new Error('Invalid viewer header')
    size += key.length + values.join('').length
    if (size > 32 * 1024) throw new Error('Viewer headers too large')
    headers[key] = value as string | string[]
  }
  const connection = String(headers.connection ?? '').toLowerCase().split(',').map((s) => s.trim())
  for (const name of [...connection, 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']) delete headers[name]
  if (upgrade) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket' }
  return headers
}
