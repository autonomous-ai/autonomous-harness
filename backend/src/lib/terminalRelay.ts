import type { Frame } from './tunnel.js'

export const TERMINAL_ENVELOPE_MAX_BYTES = 512 * 1024
export const TERMINAL_DOWN_TYPES = new Set([
  'terminal_capabilities', 'terminal_open', 'terminal_alive', 'terminal_ack',
  'terminal_input', 'terminal_resize', 'terminal_resync', 'terminal_close', 'terminal_scroll',
  'terminal_chunked_upload_begin', 'terminal_chunked_upload_cancel',
])

export const TERMINAL_UP_TYPES = new Set([
  'terminal_capabilities_result', 'terminal_ready', 'terminal_keyframe',
  'terminal_output', 'terminal_closed', 'terminal_error', 'terminal_paste_image_result',
  'terminal_paste_file_result', 'terminal_chunked_upload_begin_result',
  'terminal_chunked_upload_progress',
])

export function terminalFrameBytes(frame: Frame): number {
  return Buffer.byteLength(JSON.stringify(frame), 'utf8')
}

export function terminalFrameNeedsWake(type: string): boolean {
  return type === 'terminal_open'
}

/** Backend may inspect only enough envelope structure to fail closed; ciphertext remains opaque. */
export function isEncryptedTerminalFrame(frame: Frame): boolean {
  const payload = frame.payload
  if (!payload || typeof payload !== 'object') return false
  const envelope = (payload as { __e2e?: unknown }).__e2e
  if (!envelope || typeof envelope !== 'object') return false
  const value = envelope as { v?: unknown; n?: unknown; k?: unknown; ct?: unknown }
  return value.v === 1
    && Number.isSafeInteger(value.n)
    && (value.k === 'p' || value.k === 'g')
    && typeof value.ct === 'string'
}

interface Bucket {
  startedAt: number
  frames: number
  bytes: number
}

function limits(type: string): { frames: number; bytes: number } {
  if (type === 'terminal_input') return { frames: 15_000, bytes: 64 * 1024 * 1024 }
  if (type === 'terminal_output') return { frames: 20_000, bytes: 128 * 1024 * 1024 }
  if (type === 'terminal_sync') return { frames: 1_200, bytes: 8 * 1024 * 1024 }
  // Acks are renderer flow control, not user actions. The client emits one per 16ms render window
  // (plus one per 64 KiB rendered), so roughly 3,750/min while output is flowing. Sharing the
  // human-paced 1,200 below meant a pane streaming a build log exhausted the window in about 19
  // seconds, and a rejected ack is not dropped quietly — it answers TERMINAL_FRAME_REJECTED, which
  // the client reads as transport loss and freezes the pane mid-output. Sized ~2.7x the client's
  // own ceiling; the byte cap still bounds actual volume.
  if (type === 'terminal_ack') return { frames: 10_000, bytes: 8 * 1024 * 1024 }
  if (type === 'terminal_alive' || type === 'terminal_resize' || type === 'terminal_scroll') {
    return { frames: 1_200, bytes: 8 * 1024 * 1024 }
  }
  if (type === 'terminal_open' || type === 'terminal_capabilities') return { frames: 60, bytes: 4 * 1024 * 1024 }
  return { frames: 600, bytes: 64 * 1024 * 1024 }
}

/** Socket-local one-minute guard. It never stores terminal payloads and has no cross-request persistence. */
export class TerminalRateGuard {
  private readonly buckets = new Map<string, Bucket>()
  constructor(private readonly now: () => number = () => Date.now()) {}

  allow(type: string, bytes: number): boolean {
    const timestamp = this.now()
    let bucket = this.buckets.get(type)
    if (!bucket || timestamp - bucket.startedAt >= 60_000) {
      bucket = { startedAt: timestamp, frames: 0, bytes: 0 }
      this.buckets.set(type, bucket)
    }
    const limit = limits(type)
    if (bucket.frames + 1 > limit.frames || bucket.bytes + bytes > limit.bytes) return false
    bucket.frames++
    bucket.bytes += bytes
    return true
  }
}
