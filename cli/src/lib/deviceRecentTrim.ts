export const DEVICE_RECENT_ENCRYPTED_FRAME_CAP_BYTES = 16 * 1024
export const DEVICE_RECENT_SAFE_RATIO = 0.9
export const DEVICE_RECENT_SAFE_FRAME_BYTES = Math.floor(DEVICE_RECENT_ENCRYPTED_FRAME_CAP_BYTES * DEVICE_RECENT_SAFE_RATIO)

type Payload = Record<string, unknown>
type MeasureFn = (payload: Payload) => number | null

export interface RecentTrimResult {
  payload: Payload
  trimmed: boolean
  originalBytes: number | null
  finalBytes: number | null
  textBytes: number
  recapBytes: number
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

export function truncateUtf8(input: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (byteLen(input) <= maxBytes) return input
  let out = ''
  let used = 0
  for (const ch of input) {
    const n = byteLen(ch)
    if (used + n > maxBytes) break
    out += ch
    used += n
  }
  return out
}

function normalizeString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function oneEventPayload(base: Payload, kind: string, text: string, recap: string): Payload {
  return {
    ...base,
    events: [{
      kind,
      text,
      ...(recap ? { recap } : {}),
    }],
  }
}

function maxFittingBytes(input: string, makePayload: (value: string) => Payload, measure: MeasureFn, targetBytes: number): string {
  let lo = 0
  let hi = byteLen(input)
  let best = ''
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const candidate = truncateUtf8(input, mid)
    const bytes = measure(makePayload(candidate))
    if (bytes !== null && bytes < targetBytes) {
      best = candidate
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

export function fitRecentReplyPayloadForDevice(
  payload: Payload,
  measure: MeasureFn,
  targetBytes = DEVICE_RECENT_SAFE_FRAME_BYTES,
): RecentTrimResult {
  const originalBytes = measure(payload)
  if (originalBytes !== null && originalBytes < targetBytes) {
    const events = Array.isArray(payload.events) ? payload.events : []
    const e = (events[0] ?? {}) as Record<string, unknown>
    const text = normalizeString(e.text)
    const recap = normalizeString(e.recap)
    return { payload, trimmed: false, originalBytes, finalBytes: originalBytes, textBytes: byteLen(text), recapBytes: byteLen(recap) }
  }

  const events = Array.isArray(payload.events) ? payload.events : []
  const raw = (events[0] ?? {}) as Record<string, unknown>
  const kind = normalizeString(raw.kind) || 'summary'
  const originalText = normalizeString(raw.text)
  const originalRecap = normalizeString(raw.recap)

  let fitted = oneEventPayload(payload, kind, originalText, originalRecap)
  let finalBytes = measure(fitted)
  if (finalBytes !== null && finalBytes < targetBytes) {
    return { payload: fitted, trimmed: true, originalBytes, finalBytes, textBytes: byteLen(originalText), recapBytes: byteLen(originalRecap) }
  }

  const fitTextForRecap = (recap: string) => maxFittingBytes(
    originalText,
    (text) => oneEventPayload(payload, kind, text || recap || kind, recap),
    measure,
    targetBytes,
  )

  const fittedText = fitTextForRecap(originalRecap)
  fitted = oneEventPayload(payload, kind, fittedText || originalRecap || kind, originalRecap)
  finalBytes = measure(fitted)
  if (finalBytes !== null && finalBytes < targetBytes) {
    return { payload: fitted, trimmed: true, originalBytes, finalBytes, textBytes: byteLen(fittedText), recapBytes: byteLen(originalRecap) }
  }

  let lo = 0
  let hi = byteLen(originalRecap)
  let fittedRecap = ''
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const recap = truncateUtf8(originalRecap, mid)
    const bytes = measure(oneEventPayload(payload, kind, originalText || recap || kind, recap))
    if (bytes !== null && bytes < targetBytes) {
      fittedRecap = recap
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  let finalText = originalText
  if (!fittedRecap && originalRecap) {
    lo = 0
    hi = byteLen(originalRecap)
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2)
      const recap = truncateUtf8(originalRecap, mid)
      const text = fitTextForRecap(recap)
      const candidateText = text || recap || kind
      const bytes = measure(oneEventPayload(payload, kind, candidateText, recap))
      const hasRequiredText = !originalText || text.length > 0
      if (hasRequiredText && bytes !== null && bytes < targetBytes) {
        fittedRecap = recap
        finalText = text || candidateText
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
  }
  if (fittedRecap) finalText = fitTextForRecap(fittedRecap) || finalText || fittedRecap || kind
  fitted = oneEventPayload(payload, kind, finalText, fittedRecap)
  finalBytes = measure(fitted)
  return { payload: fitted, trimmed: true, originalBytes, finalBytes, textBytes: byteLen(finalText), recapBytes: byteLen(fittedRecap) }
}
