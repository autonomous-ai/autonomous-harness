// The waveform viewer's pure half: values, radixes, and the UART decoder. No DOM, so the tests run
// it under node.

export const BAUDS = [300, 600, 1200, 2400, 4800, 9600, 14400, 19200, 28800, 38400, 57600, 76800, 115200, 230400, 250000, 460800, 500000, 921600, 1000000, 1500000, 2000000, 3000000]

// ------------------------------------------------------------------------------------ values

export function upperBound(arr, t, n = arr.length) {
  let lo = 0, hi = n
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= t) lo = mid + 1; else hi = mid }
  return lo // first index with arr[i] > t
}

export function valueIndex(d, t) { return upperBound(d.t, t) - 1 }
export function valueAt(d, t) {
  const i = valueIndex(d, t)
  return i < 0 ? null : d.v[i]
}

export function formatValue(bits, radix, width) {
  if (bits == null) return ''
  if (typeof bits !== 'string') bits = String(bits)
  if (width === 1) return bits
  if (!/^[01xz]+$/.test(bits)) return bits // a real, or a string
  const hasX = bits.includes('x'), hasZ = bits.includes('z')
  const group = (n) => {
    const pad = (n - (bits.length % n)) % n
    const s = '0'.repeat(pad) + bits
    let out = ''
    for (let k = 0; k < s.length; k += n) {
      const g = s.slice(k, k + n)
      if (g.includes('x')) out += 'x'
      else if (g.includes('z')) out += 'z'
      else out += parseInt(g, 2).toString(1 << n)
    }
    return out
  }
  switch (radix) {
    case 'bin': return bits
    case 'oct': return group(3)
    case 'dec':
    case 'sdec': {
      if (hasX) return 'x'
      if (hasZ) return 'z'
      if (bits.length <= 52) {
        let v = parseInt(bits, 2)
        if (radix === 'sdec' && bits[0] === '1') v -= 2 ** bits.length
        return String(v)
      }
      let v = BigInt(`0b${bits}`)
      if (radix === 'sdec' && bits[0] === '1') v -= 1n << BigInt(bits.length)
      return v.toString()
    }
    case 'ascii': {
      if (hasX || hasZ) return group(4)
      const pad = (8 - (bits.length % 8)) % 8
      const s = '0'.repeat(pad) + bits
      let out = ''
      for (let k = 0; k < s.length; k += 8) {
        const c = parseInt(s.slice(k, k + 8), 2)
        if (c === 0 && !out && k + 8 < s.length) continue // leading NULs of a wide string
        out += charOf(c)
      }
      return bits.length <= 8 ? `'${out}'` : `"${out}"`
    }
    default: return group(4)
  }
}

export function charOf(c) {
  if (c >= 32 && c < 127) return String.fromCharCode(c)
  return { 0: '\\0', 9: '\\t', 10: '\\n', 13: '\\r', 27: '\\e' }[c] ?? `\\x${c.toString(16).padStart(2, '0')}`
}

export function numeric(bits, signed) {
  if (bits == null || /[xz]/.test(bits)) return null
  if (!/^[01]+$/.test(bits)) { const f = parseFloat(bits); return Number.isFinite(f) ? f : null }
  let v = bits.length <= 52 ? parseInt(bits, 2) : Number(BigInt(`0b${bits}`))
  if (signed && bits[0] === '1') v -= 2 ** bits.length
  return v
}

/** Bit period of a serial line: the shortest run that recurs, refined over all runs near a multiple. */
export function uartTiming(d, tickFs) {
  const n = d.t.length
  if (n < 6) return null
  const runs = []
  for (let k = 1; k < n - 1; k++) {
    if (d.v[k] === 'x' || d.v[k] === 'z') continue
    runs.push(d.t[k + 1] - d.t[k])
  }
  if (runs.length < 4) return null
  const sorted = [...runs].sort((a, b) => a - b)
  let bit = null
  for (const r of sorted) {
    if (r <= 0) continue
    const close = sorted.filter((x) => Math.abs(x - r) <= r * 0.06).length
    if (close >= 2) { bit = r; break }
  }
  if (!bit) return null
  let sum = 0, cnt = 0
  for (const r of runs) {
    const k = Math.round(r / bit)
    if (k >= 1 && k <= 10 && Math.abs(r - k * bit) <= bit * 0.08) { sum += r / k; cnt++ }
  }
  if (cnt) bit = sum / cnt
  const measured = 1e15 / (bit * tickFs)
  const nominal = BAUDS.find((b) => Math.abs(b - measured) / b < 0.025) ?? null
  return { bit, measured, baud: nominal ?? Math.round(measured) }
}

/** 8N1 frames on an idle-high line: [{ t0, t1, byte, err }]. */
export function uartDecode(d, bit) {
  const frames = []
  const n = d.t.length
  let from = 0
  let k = 1
  while (k < n && frames.length < 200000) {
    if (d.t[k] < from || !(d.v[k] === '0' && d.v[k - 1] === '1')) { k++; continue }
    const start = d.t[k]
    const at = (x) => valueAt(d, start + x * bit)
    let byte = 0
    let err = at(0.5) !== '0'
    for (let b = 0; b < 8; b++) {
      const v = at(1.5 + b)
      if (v === '1') byte |= 1 << b
      else if (v !== '0') err = true
    }
    if (at(9.5) !== '1') err = true
    frames.push({ t0: start, t1: start + 10 * bit, byte, err })
    from = start + 9.5 * bit
    k = upperBound(d.t, from)
    if (k < 1) k = 1
  }
  return frames
}

export function frameAt(frames, t) {
  let lo = 0, hi = frames.length - 1, best = -1
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (frames[mid].t0 <= t) { best = mid; lo = mid + 1 } else hi = mid - 1 }
  return best >= 0 && t < frames[best].t1 ? frames[best] : null
}

