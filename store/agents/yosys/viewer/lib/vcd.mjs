// A VCD reader for the waveform viewer: the whole dump, every signal, every change.
//
// `toolchain/vcd2json.py` writes out/waves.json for the verdict, and caps it (64 signals, 20 000
// changes each) — fine for a count, wrong for a waveform viewer, where the clock has to be there at
// the end of the run too. So the pane reads out/sim.vcd itself, once per write, and hands the page
// the hierarchy up front and each signal's changes on demand.
//
//   parseVcd(text) -> { timescale, tickFs, end, scopes, vars, signals: Map(id -> Signal) }
//
// Scopes merge by path (Icarus writes a scope twice when the testbench calls $dumpvars twice). Every
// $var is kept, parameters included — the page shows those as constants rather than lanes. A signal
// is keyed by its VCD id code, so aliases (the same net seen from the testbench and from inside the
// DUT) share one change list. Values: '0' '1' 'x' 'z' for a scalar, a full-width binary string for a
// vector (re-extended by the VCD rule: pad with the leading digit, except a leading 1 pads with 0),
// the text for a real.

export const UNITS_FS = { s: 1e15, ms: 1e12, us: 1e9, ns: 1e6, ps: 1e3, fs: 1 }

/** '10 ns' -> 1e7 femtoseconds per tick. Anything unreadable is Icarus's default, 1 ps. */
export function tickFs(timescale) {
  const m = /^\s*(\d+)\s*([munpf]?s)\s*$/.exec(timescale ?? '')
  return m && UNITS_FS[m[2]] ? Number(m[1]) * UNITS_FS[m[2]] : 1e3
}

export function extendBits(bits, width) {
  if (bits.length >= width) return bits.length === width ? bits : bits.slice(-width)
  const lead = bits[0] ?? '0'
  const pad = lead === '1' ? '0' : lead
  return pad.repeat(width - bits.length) + bits
}

const MAX_CHANGES = 40_000_000 // across all signals; past this the dump is truncated, and says so

/**
 * @param {string} text the VCD
 * @returns {{timescale:string, tickFs:number, end:number, truncated:boolean, scopes:object[], vars:object[], signals:Map<string,object>}}
 */
export function parseVcd(text) {
  const n = text.length
  let i = 0

  // A token is a run of non-whitespace. Written out by hand: this loop runs once per change in a
  // dump that can be hundreds of megabytes.
  const next = () => {
    while (i < n) {
      const c = text.charCodeAt(i)
      if (c !== 32 && c !== 10 && c !== 13 && c !== 9) break
      i++
    }
    if (i >= n) return null
    const s = i
    while (i < n) {
      const c = text.charCodeAt(i)
      if (c === 32 || c === 10 || c === 13 || c === 9) break
      i++
    }
    return text.slice(s, i)
  }
  const skipToEnd = () => {
    const at = text.indexOf('$end', i)
    i = at < 0 ? n : at + 4
  }
  const untilEnd = () => {
    const parts = []
    for (let t = next(); t !== null && t !== '$end'; t = next()) parts.push(t)
    return parts
  }

  let timescale = '1ps'
  const root = { name: '', path: '', kind: 'root', children: [], vars: [] }
  const byPath = new Map([['', root]])
  const stack = [root]
  const vars = []
  const signals = new Map()

  // ------------------------------------------------------------------------------------ header
  for (let t = next(); t !== null; t = next()) {
    if (t === '$enddefinitions') { skipToEnd(); break }
    if (t === '$timescale') { timescale = untilEnd().join(' '); continue }
    if (t === '$scope') {
      const [kind = 'module', name = '?'] = untilEnd()
      const parent = stack[stack.length - 1]
      const path = parent.path ? `${parent.path}.${name}` : name
      let scope = byPath.get(path)
      if (!scope) {
        scope = { name, path, kind, children: [], vars: [] }
        byPath.set(path, scope)
        parent.children.push(scope)
      }
      stack.push(scope)
      continue
    }
    if (t === '$upscope') { untilEnd(); if (stack.length > 1) stack.pop(); continue }
    if (t === '$var') {
      const parts = untilEnd()
      if (parts.length < 4) continue
      const [type, widthText, id, name] = parts
      const range = parts.slice(4).join('')
      const width = Math.max(1, parseInt(widthText, 10) || 1)
      const scope = stack[stack.length - 1]
      const path = scope.path ? `${scope.path}.${name}` : name
      if (scope.vars.some((v) => v.name === name)) continue // the same var, from a repeated scope
      let msb = width - 1, lsb = 0
      const m = /^\[(-?\d+)(?::(-?\d+))?\]$/.exec(range)
      if (m) { msb = Number(m[1]); lsb = m[2] === undefined ? msb : Number(m[2]) }
      const v = { name, path, scope: scope.path, id, type, width, msb, lsb }
      scope.vars.push(v)
      vars.push(v)
      if (!signals.has(id)) {
        signals.set(id, { id, width, real: type === 'real' || type === 'realtime', times: [], values: [] })
      }
      continue
    }
    if (t.startsWith('$')) { skipToEnd(); continue } // $date $version $comment and the like
  }

  // --------------------------------------------------------------------------- value changes
  let time = 0
  let end = 0
  let total = 0
  let truncated = false
  const record = (sig, value) => {
    const { times, values } = sig
    const last = values.length - 1
    if (last >= 0) {
      if (values[last] === value) return // a repeat carries no edge
      if (times[last] === time) {
        // Same tick, a later write wins — unless that makes it equal to the value before it.
        if (last > 0 && values[last - 1] === value) { times.pop(); values.pop(); total-- }
        else values[last] = value
        return
      }
    }
    if (total >= MAX_CHANGES) { truncated = true; return }
    times.push(time)
    values.push(value)
    total++
  }

  for (let t = next(); t !== null; t = next()) {
    const c = t.charCodeAt(0)
    if (c === 35 /* # */) {
      const v = Number(t.slice(1))
      if (Number.isFinite(v)) { time = v; if (v > end) end = v }
      continue
    }
    if (c === 36 /* $ */) {
      if (t === '$comment') skipToEnd()
      continue // $dumpvars $dumpall $dumpon $dumpoff $end: their contents are ordinary changes
    }
    if (c === 98 || c === 66 /* b B */) {
      const id = next()
      const sig = signals.get(id)
      if (sig) record(sig, sig.real ? t.slice(1) : extendBits(t.slice(1).toLowerCase(), sig.width))
      continue
    }
    if (c === 114 || c === 82 /* r R */) {
      const id = next()
      const sig = signals.get(id)
      if (sig) record(sig, t.slice(1))
      continue
    }
    if (c === 115 || c === 83 /* s S — a string, GTKWave's extension */) {
      const id = next()
      const sig = signals.get(id)
      if (sig) record(sig, t.slice(1))
      continue
    }
    // A scalar: one of 0 1 x z (any case, plus the rare u/w/l/h/-), then the id with no space.
    const sig = signals.get(t.slice(1))
    if (!sig) continue
    let v = t[0].toLowerCase()
    if (v === 'l') v = '0'; else if (v === 'h') v = '1'; else if (v !== '0' && v !== '1' && v !== 'z') v = 'x'
    record(sig, sig.width > 1 ? v.repeat(sig.width) : v)
  }

  // Parameters are dumped once, at the start; give them their value on the var itself.
  for (const v of vars) {
    if (v.type === 'parameter') {
      const s = signals.get(v.id)
      if (s && s.values.length) v.value = s.values[s.values.length - 1]
    }
  }

  return { timescale, tickFs: tickFs(timescale), end, truncated, scopes: root.children, vars, signals }
}

/** The hierarchy for the page: scopes and vars, no changes. */
export function vcdMeta(parsed) {
  const strip = (s) => ({
    name: s.name, path: s.path, kind: s.kind,
    vars: s.vars.map(({ name, id, type, width, msb, lsb, value }) =>
      value === undefined ? { name, id, type, width, msb, lsb } : { name, id, type, width, msb, lsb, value }),
    children: s.children.map(strip),
  })
  const changes = {}
  for (const [id, s] of parsed.signals) changes[id] = s.times.length
  return {
    timescale: parsed.timescale, tickFs: parsed.tickFs, end: parsed.end, truncated: parsed.truncated,
    scopes: parsed.scopes.map(strip), changes,
  }
}

/**
 * One signal's changes, compactly: times delta-encoded, a scalar's values as one string (one
 * character per change), a vector's as an array of binary strings.
 */
export function vcdSignal(parsed, id) {
  const s = parsed.signals.get(id)
  if (!s) return null
  const dt = new Array(s.times.length)
  let prev = 0
  for (let k = 0; k < s.times.length; k++) { dt[k] = s.times[k] - prev; prev = s.times[k] }
  return { id, width: s.width, real: s.real, t: dt, v: s.width === 1 && !s.real ? s.values.join('') : s.values }
}
